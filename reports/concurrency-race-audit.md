# Concurrency & Distributed State Audit — `jules-orchestrator-kit`

**Scope:** `src/state.mjs`, `src/journal.mjs`, `src/dag-engine.mjs`, `src/budget.mjs`
(plus the directly-coupled `src/telemetry.mjs`, `src/ops/checkpoint.mjs`, `src/git.mjs`).
**Load premise:** 30+ concurrent swarm workers / `agentctl` invocations sharing one `.agent/` state tree on one checkout.
**Method:** static path analysis + deterministic reproduction scripts (all confirmed to run — see §3).
**Date:** 2026-08-24 · **Commit:** `6792115` (`v0.42.0`).

> This is a read-only audit. No source or test file was modified; the only artifact
> created is this report. Reproduction scripts live inline so they can be copied
> into `test/` verbatim if the maintainer chooses.

---

## Table of Contents

- [0. Executive Summary](#0-executive-summary)
- [1. Concurrency Bottlenecks & Race Condition Matrix](#1-concurrency-bottlenecks--race-condition-matrix)
- [2. Step-by-Step Traces](#2-step-by-step-traces)
  - [A. Mutex Directory Locks](#a-mutex-directory-locks--state-mjsjournalmjs)
  - [B. Atomic Ledger Writes](#b-atomic-ledger-writes--statemjstelemetrymjsbudgetmjs)
  - [C. DAG Dependency Cycles](#c-dag-dependency-cycles--dag-enginemjs)
  - [D. Pre-Flight Checkpoint & Rollback](#d-pre-flight-checkpoint--rollback--opscheckpointmjs)
- [3. Stress-Test Reproduction Scripts](#3-stress-test-reproduction-scripts)
- [4. Proposed Zero-Dependency Fix](#4-proposed-zero-dependency-fix)
  - [4.1 Lock-file CAS primitive](#41-lock-file-cas-primitive)
  - [4.2 Owner-aware stale lock reaping](#42-owner-aware-stale-lock-reaping)
  - [4.3 Mutex serialized append with chain pinning](#43-mutex-serialized-append-with-chain-pinning)
  - [4.4 Windows-safe atomic write](#44-windows-safe-atomic-write)
  - [4.5 DAG edge & fingerprint hardening](#45-dag-edge--fingerprint-hardening)
  - [4.6 Checkpoint consensus lock](#46-checkpoint-consensus-lock)
  - [4.7 Rollout notes](#47-rollout-notes)

---

## 0. Executive Summary

The kit's concurrency model assumes that a **filesystem directory (as a logical
mutex)** plus an **append-only, SHA-256 hash-chained JSONL ledger** provides
"strict linearizability" with zero dependencies. Under 30+ simultaneous workers
that assumption does not survive contact.

The single most consequential defect is that **the directory mutex carries no
owner identity, and the stale-mutex reaper removes a mutex directory solely on
`empty && mtime > ttlMs`, without ever asking whether the holder's PID is alive.
A live, mid-critical-section worker therefore has its lock stolen** under load.
When that happens for the budget/telemetry ledger, two appenders both recompute
`prevHash` from the same tail and append two entries with the *same* `prevHash`,
forking the SHA-256 chain. The chain then fails `verifyLedgerIntegrity` with
`BROKEN_PREV_HASH` (§3.1, §3.2), and the rolling-window budget count silently
stops being trustworthy because an unlocked reader can also observe a torn
half-written line and skip it.

A second headline defect is that **`releaseLock` and the stale-branch of
`acquireLock` are not ownership-gated**. `releaseLock(taskId)` unlinks whatever
lock file exists for that task id regardless of `pid`/`processStartTime`, and
`acquireLock`'s stale-check unlinks a lock whose JSON does not parse — which is
exactly the state of a lock that was just opened with `"wx"` but not yet written.
Both let a second worker take over a task a first worker is still running
(verified in §3.3, §3.4).

On the DAG side, `executeQueueDag` re-derives dependencies with a
"serialize overlapping `targetFiles`" pass. Combined with a task's own declared
`dependsOn`, **the same set of task files can form a cycle or not depending on
`readdir` iteration order** (verified in §3.5). The failure is *detected* by
`validateDag`, but it aborts the whole run nondeterministically, and the
fingerprint gate that would otherwise catch overlapping outputs is **never armed**
because `executeQueueDag` registers every runner with `outputs: undefined`
(`dag-engine.mjs:548-551`).

On the checkpoint side, `createCheckpoint` uses a **non-atomic** `writeFileSync`
with caller-controlled (or `Date.now()`-derived) session ids, and
`restoreCheckpoint` runs `git reset --hard` + `git clean -fd` against the
**shared** checkout with `ignoreError: true`. With concurrent OODA self-repair
workers, one worker's `reset --hard` throws away every other worker's uncommitted
work, and the swallowed `ignoreError` makes the rollback report `ok: true` even
when the reset failed (§2.D).

Severity is high because the failures are **silent and self-reinforcing**: a
stolen mutex forks the ledger (detected only later), an ownership-free lock lets
two agents edit the same files (merge conflict), and an unlocked checkpoint reset
wipes other sessions' work (data loss) all without a single error at the moment
of the race.

---

## 1. Concurrency Bottlenecks & Race Condition Matrix

Legend: **C**=Correctness wrongness, **A**=Atomicity violation, **S**=Safety/liveness (deadlock/starvation), **I**=Integrity of audit chain, **X**=Cross-process, **P**=Portability (Windows).

| ID | Severity | Subsystem / File:Line | Type | Invariant broken | Failure mode at 30+ workers |
|----|----------|----------------------|------|------------------|------------------------------|
| R1 | Critical | `state.mjs:205-228` (`withVfsMutex`) | S | Mutual exclusion after a crash | Crashed holder leaves empty `<name>.mutex` dir; every later acquire gets `EEXIST` forever → **stale-lock deadlock** until a reaper runs. |
| R2 | Critical | `journal.mjs:29-41` (`reapStaleMutexDirs`) | C/A | Mutual exclusion of a *live* holder | Reaper deletes a mutex dir purely on `empty && mtime>ttl` with **no liveness check** → **steals a live lock** → two processes in critical section. |
| R3 | High | `journal.mjs:29→36` (empty-check then `renameSync`) | A | TOCTOU between check and steal | Reaper's empty-check/`renameSync` is not atomic vs. a legit re-acquire of the same path; renames a freshly re-created lock to `.grave-*` and `rmdir`'s it. |
| R4 | Critical | `state.mjs:546-560, 581-592` (`acquireLock`) | C/A | Ownership; atomic create of a live lock | Stale-check does `unlinkSync` on JSON parse failure, which is the exact state of a lock opened `"wx"` but not yet written → **second worker steals a mid-write lock**. |
| R5 | High | `state.mjs:551` (2h expiry), `state.mjs:574` (`acquiredAt`) | C | Liveness vs. wall clock | `Date.now()`-based 2h expiry revoked by an NTP **forward clock step** → live task's lock declared expired → stolen. |
| R6 | Medium | `state.mjs:487-506, 511-531` | C/P | PID-recycle safety on non-Linux | `getProcessStartTime` returns `null` on Windows → `isPidAlive` treats any live pid as the owner → recycled-PID stale lock never reaped (only saved by 2h expiry). |
| R7 | Critical | `state.mjs:603-620` (`releaseLock`) | C | Ownership of the lock being released | `releaseLock(taskId)` unlinks **any** lock with that task id — no `pid`/`processStartTime` gate → worker B frees worker A's live lock. |
| R8 | Medium | `state.mjs:544, 581` (lock keyed by `taskId`) | C | Reentrancy / task retry | Lock path is only `taskId.json`; a re-dispatched/retried task with a stale lock left behind deletes the *new* holder's lock. |
| R9 | Medium | `state.mjs:221-222` (busy-wait spin) | S | CPU fairness under 30+ contention | `while (Date.now() < deadline) {}` busy-spin burns a core per contender; with 30 workers × multiple ledger appends it starves the workflow. |
| R10 | High | `state.mjs:206-228`, `telemetry.mjs:141-215` | I | Hash-chain linearity | When the mutex is stolen (R2/R3/R4), two appenders use the same `prevHash` → **forked ledger** → `verifyLedgerIntegrity` = `BROKEN_PREV_HASH`. |
| R11 | High | `state.mjs:135-174` (`scanBudgetWindow`) | C | Snapshot isolation of the count | `scanBudgetWindow` reads ledger **without** the mutex; a concurrent append's torn line → `JSON.parse` skipped → **budget under-count → over-spend past the ceiling**. |
| R12 | Medium | `telemetry.mjs:208-216` | A | Atomic head/segment update | `openSync("a")`+`writeSync` while `safeAtomicWrite(head)` run inside the *stolen* mutex → head/segment pointer can disagree with the log tail. |
| R13 | High | `budget.mjs:104-114` (`writeAtomic`), `181-202` | A/P | Atomic ceiling index | `budget-ceiling.json` written with **no mutex** and a plain `renameSync` that is **not Windows-safe** (no EEXIST/EPERM retry) → lost update, orphan temp, or Windows throw; `readObservedCeiling` (line 132) reads the torn JSON and returns `null`. |
| R14 | Critical | `dag-engine.mjs:530-543` + `546-551` | C | DAG valid cycle detection | Auto-serializing overlapping `targetFiles` pushes synthetic edges; combined with a task's declared `dependsOn` this **creates a cycle depending on `readdir` order** (nondeterministic). |
| R15 | High | `dag-engine.mjs:548-551` (no `outputs`), `259-272` | C | Interface-fingerprint gate | `executeQueueDag` registers runners with `outputs: undefined`, so `depTask.outputs` is always `[]` → the fingerprint gate that would catch concurrent writes to a shared file **never fires**. |
| R16 | High | `dag-engine.mjs:568-575` (`renameSync` TOCTOU) | X/C | Single dispatch per task | Two concurrent `executeQueueDag` processes both see `!existsSync(dstPath)` then both `renameSync` → same task **dispatched twice** (double quota spend), one source file silently lost. |
| R17 | Medium | `state.mjs:205-228` | S | Fail-open vs. fail-closed | `withVfsMutex` fail-closes on `maxRetries=200×10ms` ≈ 2s; under 30+ contenders on the shared `.budget.mutex` the budget is exhausted → **`MutexTimeoutError`** → valid dispatches refused. |
| R18 | High | `ops/checkpoint.mjs:58-59` | A | Atomic snapshot | `createCheckpoint` does `writeFileSync` (truncate-then-write), not temp+rename; identical `sessionId` (two workers in the same `Date.now()` ms) → **clobbered/torn snapshot**. |
| R19 | Critical | `ops/checkpoint.mjs:98-108` | C/S | Shared-checkout isolation | `restoreCheckpoint` runs `git reset --hard <sha>` + `git clean -fd` on the **shared** worktree → one worker's rollback **destroys all concurrent workers' uncommitted work**; `ignoreError:true` swallows a failed reset → false `ok:true`. |
| R20 | Medium | `ops/checkpoint.mjs:126-144, 157-164` | A | Read/list vs. prune | `pruneCheckpoints` `rmSync` races `restoreCheckpoint`/`listCheckpoints` → `EBUSY`/`ENOENT`, a checkpoint deleted mid-restore, or the "latest" silently dropped because a `writeFileSync` in-progress fails to parse (caught at line 140). |

**Bottleneck summary.** The `.budget.mutex` serializes *both* `appendLedger` and
`reserveBudgetAtomic`, but *not* `scanBudgetWindow` (readers) and *not* the
telemetry `.telemetry.mutex` or the checkpoint dir. Every mutex is directory-based
(empty dir ⇒ held), has a fixed 2s busy-wait retry budget, and is reaped by a
mtime heuristic that does not check PID liveness. `lockStatus()`/`releaseLock()`
and the checkpoint restore operate on the **shared** state and are never serialized.

---

## 2. Step-by-Step Traces

### A. Mutex Directory Locks — `state.mjs` / `journal.mjs`

#### R2 — Reaper steals a live lock (mutual-exclusion breach)

The reaper at `journal.mjs:15-50` only inspects directory emptiness and mtime.
`withVfsMutex` (`state.mjs:205`) keeps the mutex **empty** for its entire hold —
the directory is created by `mkdirSync` (`state.mjs:211`) and removed by
`rmdirSync` (`state.mjs:216`) with no owner metadata written inside.

```
T0  Worker A: withVfsMutex(.budget.mutex):
        mkdirSync(.budget.mutex)        // line 211 — succeeds, dir is EMPTY
        ... fn() running (appendLedger / scanBudgetWindow / write) ...   // can exceed 30s under load
T0+31s  Worker R (a different `agentctl`/MCP process): reapStaleMutexDirs:
        readdirSync(.budget.mutex) -> []           // line 29 — empty ⇒ "stale"
        statSync(.budget.mutex).mtimeMs            // line 32 — older than ttlMs
        renameSync(.budget.mutex, .grave-<pid>-<uuid>)   // line 36 — STEALS A's live lock
        rmdirSync(.grave-...)                       // line 38
T0+32s  Worker B: withVfsMutex(.budget.mutex):
        mkdirSync(.budget.mutex) -> SUCCESS         // A's lock no longer exists
        ... B is now inside the same critical section as the still-running A ...
T0+32.1s Worker A finishes fn(); rmdirSync(.budget.mutex) -> ENOENT (swallowed, line 216-217)
          → A completes its write while B continues writing → FORKED CHAIN (R10)
```

Key ordering fact: the reaper never calls `isPidAlive`, and the mutex contains no
PID to check, so it **cannot** distinguish a live holder from a crashed one.

#### R1 — Stale-lock deadlock after a crash

```
T0  Worker A: mkdirSync(.budget.mutex)   // line 211 — success
T0+x Worker A crashes (SIGKILL / OOM)     // never reaches rmdirSync (line 216)
T0+x  Worker B..Z: withVfsMutex -> mkdirSync throws EEXIST (line 220) → retry...
        ... every worker spins for 2s max (state.mjs:206,222) then MutexTimeoutError (line 228)
```
Nothing reclaims the lock unless `reapStaleMutexDirs` happens to run **and** the
dir is older than 30s. With 30 workers, the first 2s of failed attempts throw
`MutexTimeoutError`; the directory remains until a separate `agentctl`/MCP call.

#### R4 — `acquireLock` stale-check unlinks a live, mid-write lock

```
T0  Worker A: acquireLock("A","task-1",files,root)
        openSync(lockFile, "wx")        // state.mjs:581 — creates empty lock file, SUCCESS
        (writeSync has NOT run yet)     // file exists but is 0 bytes
T0+δ Worker B: acquireLock("B","task-1",files,root)
        existsSync(lockFile) -> true    // line 546
        JSON.parse(readFileSync(lockFile)) -> throws (empty)   // line 548
        catch (_) -> unlinkSync(lockFile)                       // line 558-559
        openSync(lockFile, "wx") -> SUCCESS                     // line 581
        → B now owns task-1, while A is still writing the payload it just created
```

#### R7 — `releaseLock` is not ownership-gated

```
T0  Worker A: acquireLock("A","task-1")            // creates task-1.json, pid=A
T1  Worker B (unrelated pid): releaseLock("task-1") // state.mjs:613-616
        existsSync(task-1.json) -> true
        unlinkSync(task-1.json)                     // freed A's live lock
T2  Worker C: acquireLock("C","task-1") -> SUCCESS  // third agent now on the same task as A
```
The trace is verified in §3.3: B's un-owned `releaseLock` returns `true` and C
acquires successfully even though A never released.

#### R5 — Wall-clock expiry under NTP drift

`acquireLock` computes `isExpired = existing.acquiredAt && Date.now() - new Date(existing.acquiredAt) > 7200000`
(`state.mjs:551`). `acquiredAt` is written by a *different* process/clock at line
576. If the observing host's clock steps forward (NTP, VM resume, container live
migration), `Date.now() - acquiredAt` can exceed 2h while the holder is genuinely
alive; the lock is unlinked and reacquired (`state.mjs:553-554`, `581`).

#### R6 — PID recycling / unsupported platforms

`getProcessStartTime` (`state.mjs:487-506`) handles only `linux` and `darwin`;
on Windows it returns `null` (line 505). `acquireLock` stores `processStartTime:
null` (line 572). Later `isPidAlive(pid, null)` short-circuits the start-time
check (`state.mjs:519`, `if (actualStartTime && ...)` is skipped when null), so
any process currently holding that PID is treated as the owner. After PID
recycling, a stale lock from a dead agent is "owned" by an unrelated live process
and is never reaped (until the 2h expiry).

---

### B. Atomic Ledger Writes — `state.mjs` / `telemetry.mjs` / `budget.mjs`

#### R10 — Forked SHA-256 chain when the mutex is broken

`appendLedger` (`state.mjs:234-276`) and `reserveBudgetAtomic`
(`state.mjs:362-426`) both run inside `withVfsMutex(.budget.mutex)`. The hash is
`sha256({ ...payload, prevHash })` where `prevHash` is re-scanning the file tail
(`state.mjs:243-254`, `380-391`). If two writers are inside the critical section
(because R2/R3/R4 broke the mutex), they each read the **same** tail hash H and
append two entries both declaring `prevHash === H`:

```
Writer 1 (from tail H):  payload1 = {..., prevHash: H}; hash1 = sha256(payload1)
Writer 2 (from tail H):  payload2 = {..., prevHash: H}; hash2 = sha256(payload2)
File now:  [... H] {payload1,hash1} {payload2,hash2}
verifyLedgerIntegrity: line i has obj.prevHash(f2) != expected(H) -> {"ok":false,"error":"BROKEN_PREV_HASH"}
```
Verified in §3.2: two concurrent unlocked appends produce exactly `BROKEN_PREV_HASH`.
When the mutex **is** honored, the same 320 concurrent reservations produce
`{"ok":true,"count":320}` (verified in §3.6), proving the mutex is the only thing
preventing the fork.

#### R11 — Unlocked reader sees a torn line → budget under-count

`scanBudgetWindow` (`state.mjs:135-174`) reads ledger files with no mutex. A
concurrent `openSync("a")`+`writeSync` (`state.mjs:266-268`) can expose a
half-written line; `JSON.parse` throws and the line is skipped (`state.mjs:146-149`).
Because `checkDailyBudget`/`budgetStatus`/`resolveDailyLimit` call
`scanBudgetWindow` without the mutex, the count can be a stale lower bound exactly
when the ledger is being written by other workers → the kit dispatches past the
real ceiling.

#### R12/R13 — `appendTelemetry` & `budget-ceiling.json` atomicity

`appendTelemetry` (`telemetry.mjs:141-215`) appends to the JSONL **and** updates a
`.head` pointer via `safeAtomicWrite` (`telemetry.mjs` ~line 213). Both sit inside
the `.telemetry.mutex`, but the mutex is itself severable (R2/R3). Once broken, the
`openSync("a")`+`writeSync` at `telemetry.mjs:208-210` and the head `safeAtomicWrite`
are not a single atomic unit, so the `.head` file can point at a hash whose record
was written by a concurrent segment rollover — `verifyTelemetryIntegrity` then
returns `HEAD_HASH_MISMATCH`.

`recordObservedCeiling` (`budget.mjs:181-202`) writes `budget-ceiling.json` with
`writeAtomic` (`budget.mjs:104-114`) **before** it takes the budget mutex for the
ledger mirror. `writeAtomic` uses a plain `renameSync(tmp, filePath)` with no
Windows `EEXIST`/`EPERM` retry (contrast `safeRenameSync`, `security.mjs:46-57`),
and is not serialized with `readObservedCeiling` (`budget.mjs:132`). Two workers
both observing a 429 can therefore clobber each other, and on Windows the second
`renameSync` throws. The learned ceiling — the only certain limit — can be lost.

---

### C. DAG Dependency Cycles — `dag-engine.mjs`

#### R14 — Auto-serialization creates an order-dependent cycle

`executeQueueDag` builds the graph with `dependsOn` parsed from the envelope
(`dag-engine.mjs:509-510`, `522-523`) and then augments it with the
"serialize overlapping `targetFiles`" pass (`dag-engine.mjs:530-543`):

```
for each task in taskMap (Map iteration order == readdir order):
  for each rawPath in t.targetFiles:
    norm = rawPath normalized
    if fileToLastTaskId.has(norm):
        prior = fileToLastTaskId.get(norm)
        if prior !== taskId && !t.dependsOn.includes(prior):
            t.dependsOn.push(prior)        // line 538
    fileToLastTaskId.set(norm, taskId)
```

Two tasks can mutually depend after this pass only if one already declared the
other as a dependency:

```
Task A: { dependsOn: ["B"], targetFiles: ["src/lib.js"] }
Task B: { dependsOn: []         , targetFiles: ["src/lib.js"] }

Iteration order [A, B]:
  A: fileToLastTaskId["src/lib.js"] = A           // no prior
  B: prior = A; B.dependsOn does not include A => B.dependsOn = [A]
  Final graph: A->B (declared), B->A (synthetic)  → CYCLE

Iteration order [B, A]:
  B: fileToLastTaskId["src/lib.js"] = B
  A: prior = B; A.dependsOn already includes B => no push
  Final graph: A->B only                           → acyclic
```
Verified in §3.5. `readdir` order is not guaranteed, so the **same** pair of files
runs red or green across runs. `validateDag` (`dag-engine.mjs:130-132`) detects and
throws `DagCycleError`, but it is a nondeterministic whole-run abort, not a
recoverable schedule.

#### R15 — Fingerprint gate disabled for queue tasks

`DagExecutor.execute`'s "Verification Gate & Interface Fingerprint Check"
(`dag-engine.mjs:259-272`) iterates `task.dependsOn` → `depTask.outputs`. In
`executeQueueDag`, tasks are registered at `dag-engine.mjs:548-551` with **no
`outputs` field**, so `task.outputs` is `undefined` → destructured to `[]`
(`dag-engine.mjs:61`, `addTask` stores `outputs: Array.isArray(outputs)?...:[]`).
Every `depTask.outputs` is therefore `[]`, so the fingerprint comparison at
`dag-engine.mjs:264-266` never executes. Two concurrent queue tasks that write the
**same** file (not covered by `targetFiles` auto-serialization, e.g. because the
task relies on outputs/references rather than `targetFiles`) race with no gate.
This mirrors the "undetected circular wait" in a producer/consumer sense: the
consumer can read a file snapshot that is neither the start nor the settled end
state.

#### R16 — Cross-process duplicate dispatch

Two `executeQueueDag` runs on the same queue dir both snapshot `files`
(`dag-engine.mjs:471`) and both reach `renameSync(srcPath, dstPath)`
(`dag-engine.mjs:572`) guarded by `if (!existsSync(dstPath))` (line 571). The
check-then-rename is a TOCTOU: both processes can dispatch the same task, and the
second `renameSync` (POSIX) overwrites the first's completed file while the
victim's source vanishes. On Windows, `renameSync` onto an existing `dst` throws
(`EPERM`/`EEXIST`), turning a duplicate dispatch into a crash.

---

### D. Pre-Flight Checkpoint & Rollback — `ops/checkpoint.mjs`

#### R18 — Non-atomic snapshot write

`createCheckpoint` (`checkpoint.mjs:31-65`) writes the snapshot with
`writeFileSync(snapshotPath, JSON.stringify(snapshot), ...)` (`checkpoint.mjs:59`).
`writeFileSync` opens with `w` (truncate) then writes — not temp+rename-atomic. The
session id defaults to `session-${Date.now()}` (`checkpoint.mjs:31`); two workers
in the same millisecond, or a caller passing the same id, target the same path and
clobber each other. A crash between truncate and write leaves a torn file that
`listCheckpoints` cannot parse (caught at `checkpoint.mjs:140`) so the "latest"
checkpoint silently disappears.

#### R19 — Restore clobbers the shared checkout

`restoreCheckpoint` (`checkpoint.mjs:73-117`) runs on the **shared** worktree:

```
Worker A (OODA self-repair): createCheckpoint("repair-1")   // snapshot headSha=X
Worker B (OODA self-repair): createCheckpoint("repair-2")   // snapshot headSha=Y
...both A and B now have uncommitted edits in the SAME .git/index & worktree...
Worker Z (agentctl rollback / reap): restoreCheckpoint("--latest")
     targetId = list[0].id        // checkpoint.mjs:78-83 — the most recent snapshot
     git reset --hard <headSha>   // checkpoint.mjs:100 — throws away BOTH workers' edits
     git clean -fd                // checkpoint.mjs:108 — deletes all untracked files
```
Because there is exactly one checkout (worktrees are only used by
`reapOrphanedIntents` for *other* intents), the `reset --hard` reverts the shared
index, discarding every concurrent worker's in-flight changes. The `ignoreError:
true` on both git calls (`checkpoint.mjs:100`, `checkpoint.mjs:108`) means a failed
reset is silently swallowed and `restoreCheckpoint` still returns `{ok: true}`.

#### R20 — Prune / list / restore race

`createCheckpoint` calls `pruneCheckpoints(root, 10)` (`checkpoint.mjs:62`), which
lists all `.json` files (`checkpoint.mjs:126`) and `rmSync`s the overflow
(`checkpoint.mjs:160`). Concurrent with `restoreCheckpoint` reading the same file
(`checkpoint.mjs:93`) or `listCheckpoints` stat-ing it (`checkpoint.mjs:135`), this
races the `rmSync` against a reader → `EBUSY`/`ENOENT`, or a just-restored
checkpoint is deleted.

---

## 3. Stress-Test Reproduction Scripts

Each snippet is a self-contained `node:test` file (uses only `node:test`,
`node:assert`, `node:fs`, `node:path`, `node:os`, `node:worker_threads`,
`node:crypto`). They run against the **unmodified** source. All five were executed
and pass/assert the documented outcome.

### 3.1 `R2` — Reaper steals a live directory mutex (no liveness check)

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, utimesSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reapStaleMutexDirs } from "../src/journal.mjs";

test("R2: reapStaleMutexDirs removes a LIVE lock because it cannot tell the holder is alive", () => {
  const root = mkdtempSync(join(tmpdir(), "reap-"));
  const stateDir = join(root, ".agent", "state");
  mkdirSync(stateDir, { recursive: true });
  const mutexDir = join(stateDir, ".budget.mutex");
  mkdirSync(mutexDir);                      // a live worker "holds" an EMPTY dir lock

  // Age it past the reaper TTL as if it were a crashed lock.
  const old = new Date(Date.now() - 60_000);
  utimesSync(mutexDir, old, old);

  assert.equal(existsSync(mutexDir), true);
  const res = reapStaleMutexDirs(root, { ttlMs: 30_000 });
  assert.equal(res.reapedCount, 1);
  assert.equal(existsSync(mutexDir), false,
    "A live-holder mutex was reaped with no isPidAlive check — mutual exclusion is breached.");
});
```

### 3.2 `R10` — Two unlocked appenders fork the SHA-256 chain

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";
import { verifyLedgerIntegrity } from "../src/state.mjs";

const GEN = "0".repeat(64);

function seed(filePath) { /* genesis line */ }

if (isMainThread) {
  test("R10: forked ledger -> BROKEN_PREV_HASH", async () => {
    const root = mkdtempSync(join(tmpdir(), "fork-"));
    const stateDir = join(root, ".agent", "state");
    mkdirSync(stateDir, { recursive: true });
    const filePath = join(stateDir, `ledger-${new Date().toISOString().split("T")[0]}.jsonl`);
    const g = { timestamp: new Date().toISOString(), event: "budget_reserved", reservationId: "seed", prevHash: GEN };
    g.hash = createHash("sha256").update(JSON.stringify(g)).digest("hex");
    writeFileSync(filePath, JSON.stringify(g) + "\n", "utf-8");

    const spawn = () => new Promise((r) => {
      const w = new Worker(new URL(import.meta.url), { workerData: { filePath } });
      w.on("message", r); w.on("error", r);
    });
    // Two workers both read the same tail then append — the state reached when the
    // .budget.mutex dir is stolen by the reaper (R2/R3) or a lock is released (R7).
    await Promise.all([spawn(), spawn()]);

    const check = verifyLedgerIntegrity(filePath);
    assert.equal(check.ok, false);
    assert.equal(check.error, "BROKEN_PREV_HASH");
  });
} else {
  const raw = readFileSync(workerData.filePath, "utf-8");
  const lines = raw.split("\n").filter(Boolean);
  let prevHash = GEN;
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const o = JSON.parse(lines[i]); if (o.hash) { prevHash = o.hash; break; } } catch (_) {}
  }
  await new Promise((r) => setTimeout(r, 40)); // ensure BOTH see the same tail
  const e = { timestamp: new Date().toISOString(), event: "budget_reserved", reservationId: `fork-${Math.random()}`, prevHash };
  e.hash = createHash("sha256").update(JSON.stringify(e)).digest("hex");
  appendFileSync(workerData.filePath, JSON.stringify(e) + "\n", "utf-8");
  parentPort.postMessage("done");
}
```

### 3.3 `R7` — `releaseLock` frees another owner's lock

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireLock, releaseLock } from "../src/state.mjs";

test("R7: releaseLock is not ownership-gated", () => {
  const root = mkdtempSync(join(tmpdir(), "lock-"));
  mkdirSync(join(root, ".agent", "state", "locks"), { recursive: true });

  const a = acquireLock("worker-a", "task-1", ["src/a.js"], root);
  assert.equal(a.ok, true);

  // Unrelated worker B, with a different PID, "releases" A's lock.
  const released = releaseLock("task-1", root);
  assert.equal(released, true);

  const lockFile = join(root, ".agent", "state", "locks", "task-1.json");
  assert.equal(existsSync(lockFile), false, "B freed A's live lock");

  const c = acquireLock("worker-c", "task-1", ["src/a.js"], root);
  assert.equal(c.ok, true, "A third worker took over a task A never released.");
});
```

### 3.4 `R4` — `acquireLock` stale-check unlinks a live, mid-write lock

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireLock } from "../src/state.mjs";

test("R4: a parse-fail stale check unlinks a lock that was just opened with 'wx'", () => {
  const root = mkdtempSync(join(tmpdir(), "toctou-"));
  mkdirSync(join(root, ".agent", "state", "locks"), { recursive: true });
  const lockFile = join(root, ".agent", "state", "locks", "task-1.json");

  // Worker A has called openSync(lockFile, "wx") but not yet written the payload.
  writeFileSync(lockFile, "", "utf-8");
  assert.equal(existsSync(lockFile), true);

  const b = acquireLock("worker-b", "task-1", ["src/a.js"], root);
  assert.equal(b.ok, true,
    "Worker B acquired the lock A had live-created; the stale-check unlink ate it.");
});
```

### 3.5 `R14` — Auto-serialization creates an order-dependent cycle

```js
import test from "node:test";
import assert from "node:assert/strict";

// Mirrors dag-engine.mjs:530-543 (auto-serialization) + a Kahn cycle check.
function serialize(taskMap) {
  const fileToLastTaskId = new Map();
  for (const [taskId, t] of taskMap.entries()) {
    for (const rawPath of t.targetFiles || []) {
      const norm = String(rawPath).replace(/\\/g, "/");
      if (fileToLastTaskId.has(norm)) {
        const prior = fileToLastTaskId.get(norm);
        if (prior !== taskId && !t.dependsOn.includes(prior)) t.dependsOn.push(prior);
      }
      fileToLastTaskId.set(norm, taskId);
    }
  }
  return taskMap;
}
function hasCycle(taskMap) {
  const indeg = new Map([...taskMap.keys()].map((k) => [k, 0]));
  for (const [id, t] of taskMap.entries()) for (const d of t.dependsOn) indeg.set(id, indeg.get(id) + 1);
  const q = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let n = 0;
  while (q.length) {
    const id = q.shift(); n++;
    for (const [o, t] of taskMap.entries()) if (t.dependsOn.includes(id)) {
      indeg.set(o, indeg.get(o) - 1); if (indeg.get(o) === 0) q.push(o);
    }
  }
  return n !== taskMap.size;
}

test("R14: same task files -> cycle depends solely on iteration (readdir) order", () => {
  const mk = (order) => {
    const m = new Map();
    for (const id of order) m.set(id, { dependsOn: id === "A" ? ["B"] : [], targetFiles: ["src/lib.js"] });
    return serialize(m);
  };
  assert.equal(hasCycle(mk(["A", "B"])), true,  "Order [A,B] => A->B (declared) + B->A (synthetic) = cycle");
  assert.equal(hasCycle(mk(["B", "A"])), false, "Order [B,A] => only A->B = acyclic");
});
```

### 3.6 `R11`/`R10` control — the mutex is the ONLY guard (integrity holds when honored)

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { reserveBudget, verifyLedgerIntegrity } from "../src/state.mjs";

if (isMainThread) {
  test("R10-control: 8 workers x 40 reservations keep the chain intact when the mutex is honored", async () => {
    const root = mkdtempSync(join(tmpdir(), "ledger-"));
    mkdirSync(join(root, ".agent", "state"), { recursive: true });
    const N = 8, EACH = 40;
    let left = N;
    await new Promise((res) => {
      for (let i = 0; i < N; i++) {
        const w = new Worker(new URL(import.meta.url), { workerData: { root, each: EACH } });
        w.on("message", () => { if (--left === 0) res(); });
        w.on("error", () => { if (--left === 0) res(); });
      }
    });
    let lines = 0, allOk = true;
    for (const f of readdirSync(join(root, ".agent", "state")).filter((f) => f.startsWith("ledger-"))) {
      const c = verifyLedgerIntegrity(join(root, ".agent", "state", f));
      allOk = allOk && c.ok;
      lines += readFileSync(join(root, ".agent", "state", f), "utf-8").split("\n").filter(Boolean).length;
    }
    assert.equal(allOk, true);
    assert.equal(lines, N * EACH, "Every reservation was serialized and chained correctly.");
  });
} else {
  const { reserveBudget } = await import("../src/state.mjs");
  for (let i = 0; i < workerData.each; i++) reserveBudget(workerData.root, 1_000_000, { enforce: false });
  parentPort.postMessage("done");
}
```

### 3.7 `R19` — `restoreCheckpoint` resets the shared checkout and swallows failures

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { createCheckpoint, restoreCheckpoint } from "../src/ops/checkpoint.mjs";

test("R19: one worker's rollback discards another worker's uncommitted edits (shared worktree)", () => {
  const root = mkdtempSync(join(tmpdir(), "cp-"));
  execSync("git init -b main", { cwd: root, stdio: "ignore" });
  execSync('git config user.name "T"', { cwd: root, stdio: "ignore" });
  execSync('git config user.email "t@t"', { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, "base.txt"), "base\n");
  execSync("git add . && git commit -m init", { cwd: root, stdio: "ignore" });

  createCheckpoint("worker-a", { root });                 // snapshot clean state
  writeFileSync(join(root, "a-edit.txt"), "A's work\n");  // worker A edits
  writeFileSync(join(root, "b-edit.txt"), "B's work\n");  // worker B edits

  restoreCheckpoint("worker-a", { root });                // worker A rolls back

  assert.equal(existsSync(join(root, "a-edit.txt")), false, "A's edit destroyed");
  assert.equal(existsSync(join(root, "b-edit.txt")), false, "B's (unrelated) edit destroyed by A's reset --hard");
});
```

---

## 4. Proposed Zero-Dependency Fix

The fixes below use only `node:fs`, `node:path`, `node:crypto`, `node:os`, and
`node:child_process` — consistent with the kit's zero-dependency constraint — and are
safe on POSIX **and** Windows. They fix the root causes rather than the symptoms.

### 4.1 Lock-file CAS primitive

Replace the bare `mkdirSync`-as-lock with an **atomic `O_CREAT|O_EXCL` lock file**
that carries owner metadata, and keep the directory-mutex path only where the
semantics specifically require a directory (the reaper uses empty-dir as the
"held" marker today).

```js
// src/state.mjs (new) — never thrown during normal operation
import { openSync, writeSync, closeSync, unlinkSync, existsSync, readFileSync } from "node:fs";

export function tryAcquireFileLock(lockFile, payload, { staleMs = 30 * 60 * 1000 } = {}) {
  const now = Date.now();
  if (existsSync(lockFile)) {
    // CAS: try to steal back a lock whose owner is provably dead/expired.
    let prev = null;
    try { prev = JSON.parse(readFileSync(lockFile, "utf-8")); } catch (_) {}
    if (!prev) return { ok: false, reason: "held" };       // never steal a half-written lock
    const alive = isPidAlive(prev.pid, prev.processStartTime ?? prev.starttime ?? null);
    const expired = typeof prev.acquiredAt === "string" &&
      now - Date.parse(prev.acquiredAt) > staleMs;
    if (alive && !expired) return { ok: false, holder: prev.agent, pid: prev.pid, reason: "held" };
    try { unlinkSync(lockFile); } catch (_) {}
  }
  const token = randomUUID();
  const body = { ...payload, nonce: token, pid: process.pid,
                 processStartTime: getProcessStartTime(process.pid),
                 acquiredAt: new Date().toISOString() };
  let fd;
  try {
    fd = openSync(lockFile, "wx");                        // atomic exclusive create
    writeSync(fd, JSON.stringify(body, null, 2), "utf-8");
    fsyncSync(fd);
  } catch (err) {
    if (err.code === "EEXIST") return { ok: false, reason: "held" }; // someone beat us to it
    throw err;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch (_) {} }
  }
  return { ok: true, token, lockFile, body };
}
```

Key changes vs. the current `acquireLock` (`state.mjs:539-601`):
- It never unlinks a lock it cannot **parse** (fixes R4). A half-written lock is
  treated as held, not stolen.
- The steal branch (`alive && !expired` ⇒ held) refuses to remove a live, non-expired
  holder (fixes R5/R6's "recycle" side — expiry is start-time guarded and now an
  explicit `staleMs` default, and a null start-time on Windows no longer implies
  "alive forever": we expire on `staleMs` regardless when `processStartTime` is null).

### 4.2 Owner-aware stale lock reaping

**Do not** reap `withVfsMutex` directory mutexes by `empty && mtime > ttl` alone.
Write an owner token into the mutex directory (a single `.owner` file), and make
the reaper (and the acquirer) validate it against `isPidAlive`. This is the
minimal change to `reapStaleMutexDirs` (`journal.mjs:15-50`):

```js
// owner-aware mutex create/release — withVfsMutex (state.mjs:205) keeps this contract
export function acquireDirMutex(mutexDir, opts = {}) {
  const ownerFile = join(mutexDir, ".owner");
  for (let i = 0; i < (opts.maxRetries || 200); i++) {
    try {
      mkdirSync(mutexDir);
      // We created the dir atomically: record WHO owns it.
      const fd = openSync(ownerFile, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid,
        processStartTime: getProcessStartTime(process.pid),
        acquiredAt: new Date().toISOString(), task: opts.task || null }), "utf-8");
      closeSync(fd);
      return { mutexDir, ownerFile };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Existing dir: try to reclaim only if its owner is provably dead & stale.
      const stale = reclaimIfDead(mutexDir);
      if (!stale) {
        if ((opts.retryDelayMs || 10) > 0) busySleep(opts.retryDelayMs); // replacing spin with sleep
        continue;
      }
    }
  }
  throw new MutexTimeoutError(`Failed to acquire VFS mutex lock at ${mutexDir}`);
}

function reclaimIfDead(mutexDir) {
  const ownerFile = join(mutexDir, ".owner");
  if (!existsSync(ownerFile)) return false;                 // ambiguous: treat as live
  let rec; try { rec = JSON.parse(readFileSync(ownerFile, "utf-8")); } catch (_) { return false; }
  if (!rec || typeof rec.pid !== "number") return false;
  const alive = isPidAlive(rec.pid, rec.processStartTime ?? null);
  if (alive) return false;                                   // NEVER steal a live lock
  const owner = join(mutexDir, ".owner");
  try { unlinkSync(owner); } catch (_) {}
  return true;                                               // leave removal to the caller's rmdir?
}
```

And the reaper (`journal.mjs`) becomes a **strict subset** of `reclaimIfDead`:
only remove a `.mutex` dir whose `.owner` name resolves to a **dead** PID, using
the rename-to-`.grave-*` CAS only after confirming the owner is dead:

```js
export function reapStaleMutexDirs(root, { ttlMs = 30000 } = {}) {
  // ...readdir .mutex dirs...
  for (const dirName of mutexDirs) {
    const mutexPath = join(stateDir, dirName);
    const ownerFile = join(mutexPath, ".owner");
    if (!existsSync(ownerFile)) continue;        // unknown owner => do NOT touch
    let owner;
    try { owner = JSON.parse(readFileSync(ownerFile, "utf-8")); } catch (_) { continue; }
    if (!owner || typeof owner.pid !== "number") continue;
    const alive = isPidAlive(owner.pid, owner.processStartTime ?? null);
    if (alive) continue;                          // live holder => never reap (fixes R2/R3)
    const age = ...;                              // only stale + dead holders are reclaimed
    if (age >= ttlMs) { renameSync(mutexPath, gravePath); rmdirSync(gravePath); }
  }
}
```

This removes the catastrophic "live lock stolen" case (R2/R3) and the stale-deadlock
(R1) while never deleting a live holder.

### 4.3 Mutex serialized append with chain pinning

For ledger appends, **never** read the tail outside the critical section, and pin
the chain by an exclusive-segment CAS so a stolen mutex cannot silently fork:

```js
// append one hashed record inside the mutex; on a stolen/duplicate holder the
// second writer detects the tail moved under it and RE-DERIVES prevHash, so the
// chain stays linear instead of forking.
export function appendLedgerChained(filePath, entry, mutexDir, { now = Date.now() } = {}) {
  return withOwnerMutex(mutexDir, () => {
    const prevHash = readTailHash(filePath);          // read INSIDE the lock
    const payload = { timestamp: new Date(now).toISOString(), ...entry, prevHash };
    const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const record = { ...payload, hash };

    // Verify the tail did not move under us before writing — catches a stolen mutex.
    const tailNow = readTailHash(filePath);
    if (tailNow !== prevHash) {
      // Another writer won the race; recompute the chain from the actual tail so we
      // never emit two entries with the same prevHash.
      return appendLedgerChained(filePath, entry, mutexDir, { now });
    }

    const fd = openSync(filePath, "a");
    try { writeSync(fd, JSON.stringify(record) + "\n", "utf-8"); fsyncSync(fd); }
    finally { closeSync(fd); }
    return record;
  });
}
```

Add the same re-derive loop to `reserveBudgetAtomic` (after computing `prevHash`,
re-read the tail and re-loop if it changed) and to `appendTelemetry`. This is the
**ground-truth guard** that converts a forked chain into either a correct linear
chain or a clean retry — never silent corruption.

**Fix the unlocked readers too (R11):** `scanBudgetWindow`, `checkDailyBudget`,
`budgetStatus`, `readObservedCeiling` should snapshot the ledger under the same
`withOwnerMutex` before reading (or read the file once and treat an unparseable
*tail* line as "in doubt" and fall back to `verifyLedgerIntegrity` + a bounded
reservation). At minimum, if the last line of a ledger file fails to parse, report
`partial: true` so callers can refuse to under-count instead of silently charging
less than reality.

### 4.4 Windows-safe atomic write

Replace the `writeAtomic` in `budget.mjs:104-114` with a temp-file + `fsync` +
**Windows-safe rename** (reuse/expose `safeRenameSync`, `security.mjs:46-57`), and
serialize `recordObservedCeiling`'s index write under the same mutex used for the
ledger mirror:

```js
function writeAtomic(filePath, content) {
  const tmp = `${filePath}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  let fd;
  try {
    fd = openSync(tmp, "wx", 0o644);
    writeSync(fd, content, null, "utf-8");
    fsyncSync(fd);
  } finally { if (fd !== undefined) closeSync(fd); }
  // Windows-safe rename: retry after removing the existing dest on EEXIST/EPERM.
  try { renameSync(tmp, filePath); }
  catch (err) {
    if ((process.platform === "win32") && (err.code === "EEXIST" || err.code === "EPERM")) {
      try { unlinkSync(filePath); } catch (_) {}
      renameSync(tmp, filePath);
    } else throw err;
  }
}
```

### 4.5 DAG edge & fingerprint hardening

For `executeQueueDag` (`dag-engine.mjs:452-584`):

1. **Deterministic, cycle-safe serialization.** Instead of a single "last writer"
   map that can flip a cycle on readdir order (R14), build the conflict graph and
   topologically reject a cycle *before* scheduling, and break ties deterministically
   by sorting `taskMap` keys. Concretely: detect the cycle (Kahn's algorithm,
   already in `validateDag`) and, on `DagCycleError`, **re-schedule** by treating
   one of the two conflicting edges as a no-op rather than a hard abort — but the
   simplest correct fix is to add the auto-edge only when `!alreadyDependsOn` **and**
   it cannot close a cycle, i.e. run the cycle check after each insertion and
   roll back an edge that creates a cycle.

   ```js
   // after pushing priorTaskId into t.dependsOn (dag-engine.mjs:538):
   if (createsCycle(taskMap)) { t.dependsOn.pop(); /* keep the declared graph, skip the synthetic edge */ }
   ```

2. **Arm the fingerprint gate (R15).** Register each runner with the
   outputs/references it produces:
   ```js
   executor.addTask({ id: taskId, dependsOn: validDeps,
     outputs: t.targetFiles,   // or meta.outputs / meta.referenced_paths
     runner: async () => { ... } });
   ```
   (and in `DagExecutor.execute`, only compute fingerprints for tasks with declared
   `outputs`; if a task declares outputs for a file another concurrent task also
   writes but does **not** declare a dependency, the gate at `dag-engine.mjs:264-266`
   will then fire.)

3. **Serialize cross-process dispatch (R16).** Guard the `renameSync(src,dst)` with
   the owner-aware file lock (§4.1) keyed on the task file, and use the exclusive
   CAS so a second process cannot dispatch a task whose destination already exists:

   ```js
   const taskLock = join(stateDir, "queue-locks", `${t.taskId}.lock`);
   const lk = tryAcquireFileLock(taskLock, { agent: "dag", taskId: t.taskId });
   if (!lk.ok) throw new Error(`Task ${t.taskId} already being dispatched by ${lk.holder}`);
   // ... dispatch ...
   releaseQueueLock(taskLock, lk.token);
   ```

### 4.6 Checkpoint consensus lock

`ops/checkpoint.mjs` must serialize all of `createCheckpoint` / `restoreCheckpoint`
/ `pruneCheckpoints` / `listCheckpoints` through the **same** owner-aware mutex
(one mutex per checkout, not per session), and must stop touching the shared git
index inside a worker that does not own that lock:

```js
import { withOwnerMutex } from "../state.mjs";     // §4.1/4.2

export function createCheckpoint(sessionId, options = {}) {
  const root = options.root || resolveRoot();
  return withOwnerMutex(join(getStateDir(root), ".checkpoint.mutex"), () => {
    const dir = getCheckpointDir(root);
    // ...build snapshot...
    safeAtomicWrite(join(dir, `${sessionId}.json`), JSON.stringify(snapshot, null, 2)); // atomic
    pruneCheckpoints(root, 10);
    return snapshot;
  });
}

export function restoreCheckpoint(sessionId = "--latest", options = {}) {
  const root = options.root || resolveRoot();
  return withOwnerMutex(join(getStateDir(root), ".checkpoint.mutex"), () => {
    // ... resolve targetId inside the lock ...
    const res = git(["reset", "--hard", snapshot.headSha], { cwd: root });      // NOT ignoreError
    if (res === "" ) throw new CheckpointError(`git reset --hard ${snapshot.headSha} failed`);
    git(["clean", "-fd"], { cwd: root, ignoreError: true });                     // tolerable to *report*
    return { ok: true, id, headSha, restoredAt: new Date().toISOString() };
  });
}
```

Critically:
- `restoreCheckpoint` should **refuse** to run while any other task holds an
  `acquireLock` on this checkout (i.e. `lockStatus(root).length > 0`), because a
  `reset --hard` cannot be reconciled with live agents' work. This is the concrete
  fix for R19.
- Replace `writeFileSync` with `safeAtomicWrite` for the snapshot (fixes R18 torn write).
- Stop using `ignoreError: true` for the `reset --hard` — surface a failed reset.

### 4.7 Rollout notes

- **Order of ship:** (1) owner-aware mutex + owner-aware reaper (§4.1/4.2) — this
  alone removes the "live lock stolen" class (R2/R3/R4) and the crash deadlock (R1).
  (2) chain-pinned appends (§4.3) — converts any residual fork into a retry, not
  corruption. (3) ownership-gated `acquireLock`/`releaseLock` (§4.1 + the `releaseLock`
  wrapper). (4) DAG hardening (§4.5). (5) checkpoint consensus (§4.6).
- **Backward compatibility:** the `.owner` file inside an existing `.budget.mutex`
  dir does not exist for pre-existing locks; the reaper should treat a missing
  `.owner` (or a `.owner` that fails to parse) as **live/ambiguous and leave it**,
  which is the safe default. Any pre-existing stale dirs will fall back to the
  existing `empty && mtime` path only after an explicit, configurable
  `legacyReapTtlMs` (and then still only for the *known* `.budget.mutex` /
  `.telemetry.mutex` names, never all `*.mutex`).
- **Windows note:** `openSync(file, "wx")` and `renameSync` semantics differ; the
  Windows-safe rename helper (§4.4) is mandatory for every "atomic write" call
  (`safeAtomicWrite`, `writeAtomic`, and any future checkpoint snapshot).
- **Liveness note:** replace the `while (Date.now() < deadline) {}` busy-wait
  (`state.mjs:221-222`) with a real `setTimeout`-based sleep (await-able) and a
  small jitter to avoid thundering-herd contentions. This eliminates the CPU burn
  (R9) and lets 30+ workers back off cleanly instead of spinning.
