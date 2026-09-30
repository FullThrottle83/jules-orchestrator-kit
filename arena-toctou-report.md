# VFS Mutex & Lock TOCTOU Race Audit — `src/state.mjs`

**Scope:** stress-test of the lock/mutex machinery in `src/state.mjs` under high parallelism.
**Method:** black-box stress harness (`arena-toctou-test.mjs`) that imports the module under test directly and races it from 50 child processes, 20 ledger writers and 220 worker threads. No existing code was modified.
**Environment:** Node.js v22.22.3 (engines `>=20`), Linux x64, 2 CPUs / 4 GB RAM, ext4/overlayfs temp dir.
**Reference run:** `node arena-toctou-test.mjs`, 2026-09-30, runtime 103.7 s, exit 0, zero unhandled rejections. Race rates vary between runs (inherent to race probing); ranges across three full runs are noted where relevant.
**Verification:** `npm test` → 1650/1650 pass, unchanged.

---

## 1. Executive summary

The lock primitives in `src/state.mjs` are **not safe under contention**. The audit found **two high-severity TOCTOU races that break mutual exclusion outright** (up to **26 of 50 concurrent workers simultaneously received `{ok: true}`** for the same task lock), plus deterministic correctness and availability defects in `withVfsMutex`. The SHA-256 ledger hash chain held up under 20-way concurrent appends **only because** the `.budget.mutex` serialized writers — but that mutex itself has defects (F3–F6) that can wedge or bypass it.

### Detected race counts (reference run)

| Category | Count | Detail |
|---|---|---|
| Rounds with **double lock grants** (`{ok:true}` to >1 process) | **19 / 40 race rounds** | Test A: 3/24 rounds (max 3 winners); Test B: 10/10 rounds (max **26** winners); Test C: 6/6 rounds (cross-task) |
| **Excess `{ok:true}` grants** (grants beyond one legitimate winner per round) | **252** | Test A: 5, Test B: 241, Test C: 6 |
| **Corrupted hash chains** from concurrent `appendLedger()` | **0** | 240 concurrent appends, chain verified intact (`torn=0, broken=0, forks=0`) |
| **Deterministic chain-corruption defects** | **1** | F10: caller-supplied `entry.hash` invalidates its own entry (`CORRUPTED_ENTRY_HASH`) |
| **Mutual-exclusion violations inside `withVfsMutex`** (healthy path) | **0** | 1320 serialized critical-section entries across 4×220-thread waves |
| **Mutual-exclusion violations after mutex recovery** | **2 overlaps** | F5: unconditional release lets 3 actors into the critical section |
| Deterministic re-executions of a critical section (`fn` runs > 1×) | **1 defect** | F3: `fn` ran 5× in one `withVfsMutex` call |
| `MutexTimeoutError` under heavy contention (220 contenders) | **28 / 880** | F6: 0 (2 ms hold), 1 (25 ms hold), 27 (100 ms hold), 0 (generous budget) |

---

## 2. Findings

Severity scale: `informational / low / medium / high / critical`.

### F1 — `acquireLock()` publishes the lock record non-atomically; racers unlink the in-flight record and both win — **HIGH** (reproduced)

**Code path:** `src/state.mjs` → `acquireLock()` (lines 632–743):

```js
639:  if (existsSync(lockFile)) {
641:      const existing = JSON.parse(readFileSync(lockFile, "utf-8"));
643:      ...
651:      try { unlinkSync(lockFile); } catch (_) {}          // stale-record reap
652:    } catch (_) {
653:      try { unlinkSync(lockFile); } catch (_) {}          // ← unlinks IN-FLIGHT records
654:    }
...
721:    fd = openSync(lockFile, "wx");                        // creates empty file
722:    writeSync(fd, JSON.stringify(payload, null, 2), "utf-8");  // fills it (non-atomic)
723:    fsyncSync(fd);
724:    return { ok: true, lockFile };
```

**TOCTOU timeline (same `taskId`):**

1. Process A wins `openSync(lockFile, "wx")` at line 721 — the file now exists but is **0 bytes / partially written** until line 722 completes.
2. Process B enters at line 639, `readFileSync` sees the empty/partial record, `JSON.parse` throws, and the outer catch at line 653 **unlinks A's record while A is still writing it**.
3. B proceeds to its own `openSync(lockFile, "wx")` at line 721 — which now succeeds (the path is free). Both A and B return `{ok: true}`. B's later `unlinkSync` in the error path (line 736) or further racers can cascade the effect.

The window equals the duration of `writeSync` of the record. It is microscopic for small records and **milliseconds for large `files` arrays** (the payload embeds `files` verbatim at line 707), which the harness exploits without touching production code.

**Evidence (reference run):**

| Scenario | Double-grant rounds | Excess grants | Max simultaneous `{ok:true}` |
|---|---|---|---|
| Test A — 50 children, 24 rounds, ~250-byte records | 0–3 / 24 per run (reference run: 3) | 0–5 | up to 3 (reference run: rounds 10, 14, 18) |
| Test B — 50 children, 10 rounds, ~3 MB records | **10 / 10 in every run** | 241 | **26–27** (reference run per-round winners: 25, 25, 26, 26, 25, 24, 26, 25, 25, 24) |

Test A's rate is timing-sensitive (nanosecond-scale window for small writes: 0/24, 1/24, 3/24 double-grant rounds across four full runs, always with ≥ 2 winners when it hits); Test B is deterministic in practice — every round of every run produced double grants.

Direct observation of the window (publish-window probe, one writer + polling reader): **2757 polls saw the record at 0 bytes**, 1 poll saw partially-written invalid JSON, 306 polls saw the completed 3 MB record. The window is real and observable even with a single writer.

**Impact:** the core exclusivity guarantee is broken. Two (or twenty-six) agents are simultaneously told they have exclusive access to a task and its files → concurrent edits, corrupted work products, double dispatch. Any caller of `acquireLock()` (engine, swarm, `agentctl lock acquire`) is affected.

**Remediation:** publish the record atomically — write the payload to a temp file, then `linkSync(tmp, lockFile)` (fails `EEXIST` atomically) or write-then-`renameSync` with a post-check; alternatively `openSync(lockFile, "wx" | O_TMPFILE)` + single `writeSync` of a buffer already fully built, and **never unlink a record merely because it fails to parse** — distinguish "0-byte/partial, retry read" from "corrupt and stale" (e.g. retry parse for a bounded time; only reap when liveness is disprovable).

---

### F2 — Cross-task file exclusivity is check-then-act; overlapping file sets are granted concurrently — **HIGH** (reproduced)

**Code path:** `src/state.mjs` → `acquireLock()` lines 667–691 (the file-overlap scan) versus line 721 (the create):

```js
667:  if (requested.size > 0) {
668:    for (const held of lockStatus(root)) {     // ← check (read-only scan)
669:      if (!held || held.taskId === taskId) continue;
671:      const overlap = ... requested.has(f);
674:      if (overlap.length > 0) {
675:        if (!isLockLive(held)) { ...unlink...; continue; }
681:        return { ok: false, ... conflictingFiles: overlap };
...
721:    fd = openSync(lockFile, "wx");             // ← act, much later
```

The comment at lines 657–661 documents that the `files` argument is now *checked* — but the check and the create are not atomic with respect to each other, and nothing serializes the scan. Two `acquireLock()` calls with **different `taskId`s** and overlapping `files` that arrive together both scan an empty lock dir, both pass the overlap check, and both create their own (differently named) lock file at line 721 — both get `{ok: true}`.

**Evidence (Test C, 50 children, distinct taskIds, identical 2-file set):** **6/6 rounds violated** file exclusivity — 2 simultaneous holders every round (winners e.g. rounds: {16,48}, {1,39}, {10,29}, {35,42}, {12,17}, {3,23}). The window closes after the first records become visible, which is why the count saturates at 2 per round; the point stands: **overlapping file sets were granted concurrently in 100% of rounds.**

**Impact:** two agents editing the same files while both hold "exclusive" locks — the exact failure the overlap check at 657–691 was added to prevent.

**Remediation:** make the exclusivity decision and the record creation one atomic step — e.g. serialize all `acquireLock()` calls through the same `.budget.mutex` (or per-file lock files created with `O_EXCL`), or re-validate the scan after create and roll back on conflict.

---

### F3 — `withVfsMutex` re-executes `fn` when `fn` throws `err.code === "EEXIST"` — **MEDIUM** (deterministic)

**Code path:** `src/state.mjs` → `withVfsMutex()` (lines 232–256):

```js
236:  for (let i = 0; i < maxRetries; i++) {
237:    try {
238:      mkdirSync(mutexDir);
239:      try {
240:        return fn();
241:      } finally {
243:          rmdirSync(mutexDir);
244:        } catch (_) {}
245:      }
246:    } catch (err) {
247:      if (err.code === "EEXIST") {           // ← cannot tell mkdir's EEXIST from fn's
248:        const deadline = Date.now() + retryDelayMs;
249:        while (Date.now() < deadline) {}
250:        continue;                           // ← re-runs fn
```

The `try` at 237 wraps **both** `mkdirSync` and `fn()`. An `EEXIST` thrown *inside* `fn` (e.g. a nested `mkdirSync` on an existing path, an `openSync(…, "wx")` collision) is indistinguishable from mutex contention: the retry loop calls `fn()` again — up to `maxRetries` times.

**Evidence (Test F1, deterministic):** `fn` that appends one line and throws `err.code = "EEXIST"` was executed **5× in a single `withVfsMutex` call** (`maxRetries: 5`), then `MutexTimeoutError` was raised. Non-idempotent critical sections (double appends, double dispatches, double file writes) run repeatedly.

**Impact:** duplicate side effects from the critical section; combined with F1/F2 it magnifies duplicate work. Any `fn` that touches real filesystem paths can plausibly throw `EEXIST`.

**Remediation:** catch `EEXIST` **only around `mkdirSync`** (narrow the try), and treat any error from `fn` as fatal — release and rethrow.

---

### F4 — Stale mutex dir wedges forever: no liveness/reaper, failed releases are swallowed — **MEDIUM** (deterministic)

**Code path:** `src/state.mjs` lines 238–244 (acquire/release pair), 244 (`rmdirSync` error swallowed), 255 (timeout throw).

Two ways to a permanent wedge, both reproduced (Test F2):

1. **Crashed holder:** a process killed between `mkdirSync` (238) and `rmdirSync` (243) leaves `.budget.mutex` behind. Observed: every subsequent `withVfsMutex` spins the full default budget and throws `MutexTimeoutError` after **2000 ms** (200 × 10 ms); a second call also failed. Nothing ever removes the directory.
2. **Swallowed release failure:** if `rmdirSync` fails (e.g. `ENOTEMPTY` because anything landed inside the mutex dir), line 244 swallows the error and the release silently does not happen. Observed: `fn` ran once, release vanished, the dir persisted, and the next `withVfsMutex` call threw `MutexTimeoutError`.

**Impact:** availability. All budget reservations and ledger appends (`appendLedger` line 264 uses this mutex) fail closed with `MutexTimeoutError` until a human deletes the directory. On a crash in production this wedges the day's auditing/dispatch silently.

**Remediation:** track holder identity (pid + nonce) in the mutex dir; on `EEXIST`, reap dirs owned by dead pids or past a TTL (same pattern as `isLockLive`/`reapStaleLocks` already use for lock records); do not swallow release errors blindly — at least log/throw on `ENOTEMPTY`.

---

### F5 — Mutex release is unconditional `rmdirSync` (no ownership token) — **MEDIUM** (deterministic)

**Code path:** `src/state.mjs` lines 241–245 — `finally { rmdirSync(mutexDir) }` removes *whatever directory currently occupies the path*, regardless of who created it.

**Reproduction (Test F3, deterministic):**

1. Actor A acquires the mutex and holds. Operator/recovery deletes the dir (the documented recovery for F4).
2. Actor B acquires and **enters the critical section while A is still inside** → overlap #1.
3. A exits; its unconditional `rmdirSync` removes **B's** mutex dir.
4. Actor C acquires and **enters while B is still inside** → overlap #2.

Observed enter/exit log overlaps: `A→B` and `B→C` — **2 mutual-exclusion violations** in one orchestrated sequence.

**Impact:** the failure is not just theoretical double-entry: once any cleanup/recovery touches the mutex dir (a routine op given F4), the release path itself destroys the *next* owner's lock and opens the critical section to a third party. Note the healthy-path waves in Test E showed **0 overlaps in 1320 entries**, so exclusion holds only while nobody interferes with the directory.

**Remediation:** give the mutex an ownership token (unique file inside the dir, or `mkdir` + write pid/nonce) and release only if the token matches; `rmdirSync` the dir only when it is empty *and* owned.

---

### F6 — Fixed spin budget and CPU-burning busy-wait collapse under contention — **MEDIUM** (reproduced)

**Code path:** `src/state.mjs` lines 233–234 (defaults `maxRetries: 200`, `retryDelayMs: 10` → nominal 2 s budget), 248–249 (`while (Date.now() < deadline) {}` busy-wait), 255 (throw).

The wait loop burns 100 % CPU per waiter for 10 ms per attempt. With N waiters this is N cores of spin; and because the deadline is wall-clock, CPU starvation stretches each retry cycle, making the *effective* budget unpredictable in both directions (measured: wave 3 drained 220 × 100 ms holds in 24.6 s wall while nominally each waiter only had 2 s).

**Evidence (Test E, 220 `worker_threads`, simultaneous `mkdirSync` attempts):**

| Wave | Hold | Budget | ok | `MutexTimeoutError` | Wall | CPU burned | Exclusion overlaps |
|---|---|---|---|---|---|---|---|
| E1 | 2 ms | default (200×10 ms) | 220/220 | 0 | 8.8 s | **16.2 s** | 0 |
| E2 | 25 ms | default | 219/220 | 1 | 12.7 s | 24.1 s | 0 |
| E3 | 100 ms | default | 193/220 | **27** | 24.6 s | 47.6 s | 0 |
| E4 | 100 ms | 20000×5 ms | 220/220 | 0 | 27.6 s | 53.5 s | 0 |

**Impact:** under load, `appendLedger`/`reserveBudgetAtomic` throw `MutexTimeoutError` and the audit trail entry is lost (fail-closed throw); the busy-wait is also a self-inflicted CPU denial of service (16 s of CPU for 8.8 s of 2 ms critical sections).

**Remediation:** bounded exponential backoff with `Atomics.wait`/`setTimeout`-class sleeping instead of spinning; make the budget time-based and adaptive to observed hold times; or move acquisition to an async queue.

---

### F7 — Re-entrant `withVfsMutex` on the same dir self-deadlocks — **LOW** (deterministic)

**Code path:** `src/state.mjs` 238–250. A nested `withVfsMutex(mutexDir, …)` inside `fn` hits its own `EEXIST` and spins against itself until `MutexTimeoutError`. Observed (Test F4): inner `fn` never ran; `MutexTimeoutError` after 25–28 ms (`maxRetries: 5`). With default options this is a hard 2 s self-deadlock per nesting level. `appendLedger()` (line 264) or `reserveBudgetAtomic()` (line 412) called from inside any `withVfsMutex` section on the same state dir triggers it.

**Remediation:** document non-reentrancy loudly, or make the mutex reentrant (owner pid+nonce check before `EEXIST` spin).

---

### F8 — `appendLedger()` symlink guard is TOCTOU — **LOW** (analytical)

**Code path:** `src/state.mjs` 289–293:

```js
289:    if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) {
290:      throw new Error(`Refusing to append to symbolic link: ${filePath}`);
291:    }
292:
293:    const fd = openSync(filePath, "a");   // no O_NOFOLLOW
```

Check and open are separate syscalls: a same-privilege attacker who can write the state dir can swap a regular file for a symlink between line 289 and line 293 (and `openSync("a")` follows symlinks). The `existsSync` short-circuit also lets a symlink planted after a negative check win. Not dynamically reproduced (window is nanoseconds, same-privilege attacker); listed for completeness of the TOCTOU surface.

**Remediation:** `openSync` with `O_NOFOLLOW | O_APPEND` (or `lstat` + `open` + `fstat` identity comparison before writing).

---

### F9 — `lockStatus()` silently drops unreadable lock records — **LOW** (reproduced)

**Code path:** `src/state.mjs` 764–784, silent `catch (_)` at line 779.

The file-overlap check (F2) consumes `lockStatus()`. A record that is mid-publish (F1) fails `JSON.parse` at line 775 and is **silently skipped** at 779 — the holder becomes invisible while still holding. Observed live: 2757 polls at 0 bytes and 1 partial-JSON poll during a single record publish. This both hides holders from the exclusivity check and is the mechanism that turns F1's window into double grants.

**Remediation:** retry briefly on unparseable records; surface `unparsed` records as "unknown, assume live" (fail closed) rather than dropping them.

---

### F10 — Caller-supplied `entry.hash` poisons the chain payload — **INFORMATIONAL** (deterministic)

**Code path:** `src/state.mjs` 285–287:

```js
285:    const rawPayload = { timestamp, ...scrubStateValue(entry), prevHash };
286:    const hash = createHash("sha256").update(JSON.stringify(rawPayload)).digest("hex");
287:    const payload = { ...rawPayload, hash };
```

If `entry` carries a `hash` field it is spread **into `rawPayload` before hashing** (line 285) but overwritten in the stored record (line 287). The stored entry can then never satisfy `verifyLedgerIntegrity` (lines 328–331 recompute over a payload that no longer contains the poisoned field). Observed (Test F5): `appendLedger({event, hash: "deadbeef"})` → `verifyLedgerIntegrity` returns `CORRUPTED_ENTRY_HASH` on the very entry just written. (`entry.timestamp` similarly overrides the generated timestamp.)

**Remediation:** reject or strip reserved keys (`hash`, `prevHash`, `timestamp`) from `entry`, or hash the stored payload exactly as verified.

---

## 3. What held up

- **Hash chain under concurrency (requirement 2c):** 20 children × 12 rounds = 240 racing `appendLedger()` writes to one daily ledger — `verifyLedgerIntegrity` OK (count 240), independent chain walk `torn=0 broken=0 missing=0 badHash=0 forks=0`. The `.budget.mutex` **did** serialize healthy writers.
- **`withVfsMutex` mutual exclusion on the healthy path (requirement 2e):** 4 waves × 220 simultaneous `mkdirSync` attempts (880 acquisitions, 1320 enter/exit log events) — **0 overlaps**. The critical section is sound; its *lifecycle* (F3–F6) is not.
- **No unhandled rejections, no repo pollution:** the harness writes only under `os.tmpdir()` and passes an explicit root to every call.

## 4. Reproduction steps

```bash
git clone https://github.com/FullThrottle83/jules-orchestrator-kit.git
cd jules-orchestrator-kit
node --version          # >= 20
node arena-toctou-test.mjs   # full audit; exit 0; ~2–3 min; needs ~1 GB RAM
npm test                    # 1650/1650 existing tests, unchanged
```

The harness prints per-test progress and an `=== AUDIT SUMMARY ===` JSON block containing every number in this report. Per test:

| Mission ref | Test | What it does |
|---|---|---|
| 2a | Test A | 50 `child_process` workers race `acquireLock()` on the same `taskId` with overlapping file sets, 24 synchronized rounds (barrier via shared start timestamp). Any round with ≥ 2 × `{ok:true}` is a double grant. |
| 2b | Test B | Same race with ~3 MB lock records to widen the publish window; plus a publish-window probe that polls the record while one worker writes it. |
| — | Test C | Distinct `taskId`s claiming the same files — cross-task exclusivity race (F2). |
| 2c | Test D | 20 workers race `appendLedger()` into one daily ledger, 12 rounds; then `verifyLedgerIntegrity()` + an independent chain walk (fork/torn/broken detection). |
| 2d | Detection | Implemented in A/B/C: per-round counting of `{ok:true}` responses; winners identified per round in the summary. |
| 2e | Test E | 220 `worker_threads` fire `withVfsMutex()` simultaneously (Atomics barrier) with 2/25/100 ms critical sections; enter/exit log + interval sweep detects any overlap; `process.cpuUsage()` quantifies the spin burn. |
| — | Test F | Deterministic probes: F1 (`fn` throws `EEXIST`), F2 (stale dir + `ENOTEMPTY` release), F3 (three-actor unconditional-release scenario), F4 (nested call), F10 (`entry.hash`). |

Minimal deterministic repro for the headline race (F1):

```js
// with ~3MB `files` payloads the window is milliseconds wide:
// run 50 processes of:  acquireLock("agent", "task-1", bigFiles, root, {})
// → 25 of 50 receive {ok:true} (see Test B in the summary).
```

Minimal deterministic repro for F3:

```js
withVfsMutex(dir, () => {
  appendFileSync(counter, "x\n");          // side effect
  const e = new Error("boom"); e.code = "EEXIST"; throw e;
}, { maxRetries: 5 });
// counter contains 5 lines — fn ran 5 times
```

## 5. Severity summary

| ID | Finding | Severity | Reproduced |
|---|---|---|---|
| F1 | Non-atomic lock-record publish → double grants (same `taskId`) | **high** | yes — Test B 10/10 rounds, max 26–27 concurrent holders; Test A hits on small records too |
| F2 | Cross-task file-exclusivity check-then-act race | **high** | yes — 6/6 rounds |
| F3 | `withVfsMutex` re-executes `fn` on `fn`-thrown `EEXIST` | medium | yes — deterministic (5×) |
| F4 | Stale mutex dir wedges forever (no reaper; swallowed release errors) | medium | yes — deterministic |
| F5 | Unconditional `rmdirSync` release (no ownership) breaks exclusion after cleanup | medium | yes — deterministic (2 overlaps) |
| F6 | Fixed 2 s spin budget + CPU-burning busy-wait under contention | medium | yes — 27/220 timeouts at 100 ms holds; 16–53 s CPU/wave |
| F7 | Re-entrant `withVfsMutex` self-deadlock | low | yes — deterministic |
| F8 | `appendLedger` symlink guard TOCTOU (no `O_NOFOLLOW`) | low | analytical |
| F9 | `lockStatus()` silently drops unreadable records (hides holders) | low | yes — window states observed live |
| F10 | Caller `entry.hash` invalidates its own chain entry | informational | yes — deterministic |

## 6. Deliverables & constraints

- `arena-toctou-test.mjs` — standalone audit harness (Node ESM; only `node:child_process`, `node:fs`, `node:path`, `node:crypto`, `node:os`, `node:worker_threads`; imports `./src/state.mjs` directly).
- `arena-toctou-report.md` — this report.
- No existing files modified; `npm test` passes unchanged (1650/1650).
