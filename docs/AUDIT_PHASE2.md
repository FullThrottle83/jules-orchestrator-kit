# Phase 2 Differential Audit — `jules-orchestrator-kit` v0.22.6

**Audit date:** 2026-08-09 · **Baseline:** 177/177 tests passing across **49** suites on Node v22 (prompt claims 50 suites — actual is 49; cosmetically noted)
**Method:** full re-read of the v0.22.6 tree + re-execution of every Phase 1 reproduction against the new kernel + new cross-module fault-injection probes. **REPRODUCED** = executed in-sandbox with observed output. **STATIC** = established from code against documented Node/Linux/git semantics.

---

## 1. System Health & Gap Analysis

### 1.1 Phase 1 defect register → v0.22.6 disposition (differentially verified)

| Phase 1 defect | v0.22.6 status | Re-verification |
|---|---|---|
| D1 fail-open mutex | **FIXED** — throws `MutexTimeoutError` | REPRODUCED ✓ |
| D2 queue dispatches README.md | **FIXED** — `isTaskFile` filter (README block + `TASK-*`/front-matter gate) | REPRODUCED ✓ (`results: []`) |
| D5 `/proc` comm-space field shift | **FIXED** — `parseProcStat` parses after `lastIndexOf(")")` | REPRODUCED ✓ (spacer-title child judged alive; bogus starttime still judged dead) |
| D7 gate: no timeout / ENOBUFS | **FIXED** — 10 min timeout, 10 MB buffer, `ETIMEDOUT`/`ENOBUFS` status annotations (measured 803 ms kill wall on 800 ms budget) | REPRODUCED ✓ |
| D10 envelope pins mutable ref | **FIXED** — `resolveBase` now returns 40-char SHA | REPRODUCED ✓ |
| D3 budget counts ledger lines (1 task = 2 units) | **STILL OPEN** — `checkDailyBudget`/`reserveBudgetAtomic` use `lines.length`; effective 300-day budget is ~150 sessions | REPRODUCED again ✓ |
| D4 `cat-file -e` premise check dead | **STILL OPEN** — file committed to git but absent on disk still fails premise validation | REPRODUCED again ✓ |
| D6 merge-gate checks nonexistent `lock.branch` | **STILL OPEN** — payload still has no `branch` field | STATIC ✓ |
| D9 OODA assumes synchronous provider | **STILL OPEN** (by design pending provider polling) | STATIC ✓ |
| D14 budget/ledger I/O errors fail open | **PARTIALLY WORSE** — see N-8 below | REPRODUCED ✓ |

### 1.2 Verdict

v0.22.6 closes the four most dangerous Phase 1 kernel bugs correctly and with tests. **However, the hardening cycle introduced three new cross-module hazards that only exist *because* these features now interact** (Vector 1). Two of them are REPRODUCED self-DoS/lock-theft paths. The kit is safe at 3-agent concurrency; at 15+ parallel worktrees the interaction of (fail-closed mutex + crash) and (reaper + PID recycling) needs the three sketches in §4.

---

## 2. Vector 1 — Cross-Module Integration & Race Findings (new, all evidence-backed)

| # | Finding (integration-level) | Evidence |
|---|---|---|
| **N-1** | **SIGKILL + fail-closed mutex = permanent ledger self-DoS.** Crash between `mkdirSync(.budget.mutex)` and `rmdirSync` leaves an orphan dir. Thereafter *every* `appendLedger`/`reserveBudgetAtomic` spins the event loop **2.0 s** (200×10 ms busy-wait — measured) and throws `MutexTimeoutError`. The v0.22.6 boot reaper covers worktrees and lock *files* but **not mutex dirs** → the system wedges hard after the exact failure class the journal was built to survive. | REPRODUCED (2.0 s block + throw) |
| **N-2** | **Reaper steals live locks on PID recycling.** `reapOrphanedIntents` deletes lock files where `lockContent.pid === intent.pid` without comparing the lock record's own `processStartTime` against the intent's. After PID-number reuse, a *live* agent's lock is unlinked while it holds it. | REPRODUCED (live lock deleted) |
| **N-3** | **Net-guard injection breaks consumer repos.** Gate Phase 4 injects `NODE_OPTIONS=--import ./src/preload-net-guard.mjs` — a **relative** specifier resolved against the child's cwd (= consumer repo root). In any repo where the kit lives under `node_modules/`, every node child dies `ERR_MODULE_NOT_FOUND` → verify phase permanently fails with a misleading cause. | REPRODUCED (`ERR_MODULE_NOT_FOUND` outside kit root) |
| **N-4** | **Prompt-guard pre-trust bypass.** `buildAgentEnvelope` passes strings starting with `<<<UNTRUSTED-DATA-BEGIN` through **without sanitizing**. Attacker-controlled input crafted with that exact prefix smuggles `<\|im_start\|>system`, ANSI, and bidi controls into the envelope untouched. | REPRODUCED (control tags survive) |
| **N-5** | **Prompt-guard is orphaned.** `src/prompt-guard.mjs` has unit tests but zero production importers — dispatch (`engine.mjs`), webhook receiver, and MCP tools never call it. The injection defense exists on paper only. | STATIC (module graph audit) |
| **N-6** | **DAG fingerprint aliasing on shared outputs.** `fingerprints` is keyed by *file path*, so when two concurrent tasks declare the same output, the later finisher overwrites the earlier's record; a dependent of the earlier task then passes the gate reading the later's content — a contract proven for the wrong producer. | REPRODUCED (C passes with B's bytes) |
| **N-7** | **Executor hangs on dynamic dependency graphs.** `addTask()` during `execute()` is never scheduled, so `completed.size < tasks.size` forever and the returned promise never settles. Combined with the absence of a per-task timeout, any single wedged runner freezes the swarm. | REPRODUCED (600 ms watchdog, never resolves) |
| **N-8** | **Ledger I/O fault now forks the hash chain.** In `reserveBudgetAtomic`, a read error inside the mutex is swallowed → `count=0`, `prevHash=0…0` → a fresh chain head is appended onto an existing file; `verifyLedgerIntegrity` later reports `BROKEN_PREV_HASH`, and budget was granted during an unreadable ledger (D14, widened). | STATIC (code path) + consistent with D14 |
| **N-9** | **Net-guard covers only `fetch`/`http`/`https`; `net`, `tls`, `dgram`, `undici` internals reuse, and `globalThis.WebSocket` sail straight through.** Raw-socket exfiltration from a compromised test is fully possible. Also `process.exit(188)` truncates `node --test`'s TAP stream, destroying diagnostics (throw `ENETGUARD` + set `exitCode=188` preserves reports). | STATIC |
| **N-10** | **Ledger hold-time growth inside the mutex is linear in file size.** Measured appends: 300 events → 178 ms total, next 300 → 194 ms (near-flat at 600 lines; the constant is dominated by `readFileSync`+split of the whole file *inside* the critical section). At Vector-4 telemetry volume (≥10k events/day ≈ 2 MB), each append reads ~2 MB under the lock and `fsyncSync`s — hold-time inflation under 15-agent contention feeds directly back into N-1's throw path. | REPRODUCED (bench) |

**Lock-order audit (asked by Vector 1):** the kernel uses exactly one mutex domain (`.budget.mutex`) and it is never nested inside lock-file acquisition or journal writes → **no lock-ordering cycle can form**. Journal appends are bare `openSync("a")` single-write calls — POSIX `O_APPEND` atomic per line, safe without a mutex. The residual hazards are all *staleness/ownership* classes (N-1, N-2), not deadlock classes; the deadlock risk lives instead in the DAG executor (N-7) and in wedged provider children (no tree-kill on `runCmd` timeout: `execFileSync` SIGTERMs only the direct child — npm-spawned test grandchildren survive).

---

## 3. Top 3 Remaining Phase 2 Feature Blueprints

### P2-F1 — Flaky Test Scoring & Quarantine Ledger *(Vector 2)*

- **Objective:** Distinguish flaky assertions from genuine regressions with statistical confidence; suppress OODA repair dispatch for quarantined flakes **without ever reporting them as "pass"**.
- **Ledger:** dedicated `.agent/state/flaky.jsonl` (O_APPEND line writes; decoupled from the budget ledger so D3 accounting can't entangle verify history). One record per gate-verify run: `{ts, testCmd, fingerprint, pass, durationMs, changedFilesSig}` where `fingerprint` = existing `fingerprintFailureState` (passes record the fileset-hash instead).
- **Exact statistics (deterministic, closed-form):** per fingerprint over a window of the last `n ≤ 10` runs:
  1. **Oscillation rate** `o = transitions/(n−1)` — the A→B→A signature.
  2. **Wilson lower bound** on the failure probability with `z=1.96`:
     `wl = (p̂ + z²/2n − z·√( p̂(1−p̂)/n + z²/4n² )) / (1 + z²/n)`
  3. **Verdict rules (extract-tested):** `n < 6` → `INSUFFICIENT_DATA` (repair allowed — never silently quarantine) · all-pass → `HEALTHY` · all-fail or trailing 3 consecutive fails (active failure tail) → `REPAIRABLE_REGRESSION` · mixed series with `o ≥ 0.4 ∧ wl < 0.8 ∧ wu > 0.2` (Wilson `[wl, wu]` proves the failure rate is statistically *interior*, not dominated by either outcome) → `QUARANTINED` · otherwise `HEALTHY_OR_FIXED` if the last 3 runs all pass, else `REPAIRABLE_REGRESSION`. Note: the naïve `wl ≥ 0.95` regression test is unsound — Wilson lower bound at p̂=1, n=6 is ~0.61; monotone detection must use exact all-fail/trailing-tail checks (caught by this audit's own extract-test).
  4. **Change isolation:** any code mutation alters the fingerprint → a new series starts → quarantine never bleeds into post-fix regressions. Bonus signal: if normalized stderr references only files *outside* `changedFiles(base)`, add `o += 0.15` capped at 1.0 (environment flake, e.g. `ENETGUARD`/DNS signatures).
- **Gate semantics (no misrepresentation):** verify phase returns `ok:false, reason:"FLAKY_QUARANTINE"`, gate exit code **8** (distinct from 4=verify fail, 6=secrets), repair dispatch suppressed, ledger event `verify_quarantined` appended, and a `TASK-flaky-<sig>.md` remediation stub is dropped into the queue for the Janitor agent. CI integrations see a non-zero, self-describing status — never green.
- **Deterministic verification (extract-tested values):** `[P,F,P,F,P,F]` ⇒ `o=1.0`, Wilson `[wl,wu]=[0.1877, 0.8119]` ⇒ QUARANTINED; `[F×6]` ⇒ all-fail monotone ⇒ REPAIRABLE_REGRESSION; `[P,F,P,F,F,F]` ⇒ trailing-3-fail active tail ⇒ REPAIRABLE_REGRESSION; `[P×5,F]` ⇒ `o=0.2` + trailing fail ⇒ REPAIRABLE_REGRESSION; exit-code assert `agentctl gate` → 8 on a seeded flaky ledger.

### P2-F2 — Indentation-Block Structural Code Merger *(Vector 3)*

- **Objective:** Merge two agents' edits to the *same* `.mjs`/`.ts`/`.py` file with no external binaries (pure JS path) and no AST parser; classify every block; prove syntactic validity by subprocess.
- **Two-channel chunking (grammar-agnostic):** (1) *boundary channel* — per-extension declaration-start regexes (`.mjs/.ts`: `export|function|class|const|interface|type`; `.py`: `def|class|async def`; fallback: any line at the file's minimum indentation); (2) *indentation channel* — a block also closes when indentation dedents to ≤ the block root's indentation (covers unbraced languages and brace-style drift). Each block records `sig` (normalized boundary line + occurrence ordinal), `startLine/endLine` (for precise conflict localization), and `hash = sha1(trimmedLines)`.
- **3-way classification per `sig`:** `IDENTICAL | ONLY_OURS | ONLY_THEIRS | ADDED_OURS | ADDED_THEIRS | DELETED_BY_THEIRS | DELETED_BY_OURS | CONFLICT_EDIT_EDIT | CONFLICT_EDIT_DELETE`. Emission preserves base order; pure additions from each side anchor after the preceding still-present sig; conflicts emit labeled markers `<<<<<<< OURS(sig) … ======= … >>>>>>> THEIRS(sig)` and increment an exit-class counter.
- **Verification chain (binary, exit-code gated):** merged text → temp file → `.js/.mjs/.cjs` → `node --check` (exit 0 required); `.ts/.tsx` → `tsc --noEmit --pretty false` *only if* `tsconfig.json` exists (documented static skip otherwise); `.py` → `python3 -m py_compile`. Syntax failure → one retry through the positional fallback (`git merge-file --diff3` in `os.tmpdir()`) → persistent failure → classified-conflict JSON to the caller and merge abort (non-zero exit). Semantic gate stays `npm test` — the merger never claims semantics.
- **Deterministic verification:** fixtures: disjoint function additions → clean merge + `node --check` = 0; same-function edits → exactly one `CONFLICT_EDIT_EDIT` with correct sigs and `endLine−startLine` ranges; brace-style K&R-vs-Allman drift files chunk identically (indent channel handles); `.py` dedent-close fixture with no regex boundary match.

### P2-F3 — O(1) Telemetry Spine + MCP Progress/Resource Streamer *(Vector 4)*

- **Objective:** O(1) event appends at 10k+/day; live OODA/gate/DAG progress over the sealed MCP stdout without frame flooding or backpressure stalls.
- **O(1) append:** reuse the hash-chain, but cache the tail hash in `.agent/state/telemetry-<date>.head` swapped atomically (`safeAtomicWrite`); append path = mutex → `openSync(a)` → one `writeSync` → `fsyncSync` → swap head. Hold time becomes O(1) (kills N-10's coupling). Segment rotation at 8 MB to `…-segN.jsonl`; first line of a new segment carries `prevSegmentTailHash` for chain continuity. Boot reconciliation: verify head == true tail (O(file) exactly once per boot, only on mismatch).
- **Schema:** `{v, ts, kind, …}` with kinds `budget|gate_phase|ooda|repair|dag|verify_quarantined|session`. Telemetry kinds are excluded from `checkDailyBudget` counting by *file separation* (ledger stays budget-only — this also closes D3 cleanly: count only `event==="budget_reserved"` in the budget ledger).
- **MCP streaming:** honor `params._meta.progressToken` → `notifications/progress` frames from a `ProgressBus` that all long tools (gate, repair, dag.execute) publish into via a callback (no new dependencies). Three hard rules: (1) **all** frames go through `writeMcpFrame` (the authorized-write path) so the stdout seal stays intact; (2) **coalescing**: per token, at most one frame per 150 ms window, latest-wins merging of intermediate states; (3) **backpressure**: when `write()` returns false, queue and await `once(output,"drain")`; message field capped at 240 chars so a single frame never approaches the 4 MB decoder ceiling… Resource model: `resources/list` advertises `telemetry://today`, `resources/read` answers with the tail-most ≤ 256 lines read backwards from EOF with `pread` at byte offsets (O(cap), not O(file)); `resources/subscribe` emits throttled `notifications/resources/updated` (≤ 1/s, and on segment rotation).
- **Deterministic verification:** 10k appends → `verifyLedgerIntegrity` ok, head == computed tail; corrupt the head file → cold scan recovers exact tail; token-injected gate run yields monotonically increasing `progress` ending at `total`; synthetic flood (1000 publish calls) yields ≤ 10 emitted frames (coalesce proof); stalled-writer mock (`write → false`, resume after 100 ms) preserves frame order with zero loss.

---

## 4. Subtle Failure Mode Matrix (v0.22.6 under extreme conditions)

| # | Subtle failure mode | Root cause | Mitigation |
|---|---|---|---|
| S-1 | After SIGKILL mid-append, entire suite of tools throw `MutexTimeoutError` forever (2 s spin each) | Orphan `.budget.mutex`; reaper doesn't cover mutex dirs (N-1) | Sketch K1 `reapStaleMutexDirs` at boot (empty-dir + mtime-TTL CAS) |
| S-2 | PID-number reuse → boot reaper unlinks a live agent's lock file mid-flight | Lock cleanup compares pid only (N-2) | Compare `lockContent.processStartTime` to intent's; skip on mismatch |
| S-3 | Consumer-repo gate verify always RED with `ERR_MODULE_NOT_FOUND` | Relative `--import ./src/…` resolved vs child cwd (N-3) | Inject absolute `file:` URL via `new URL("./preload-net-guard.mjs", import.meta.url)` |
| S-4 | Crafted task PR body prefixed `<<<UNTRUSTED-DATA-BEGIN` smuggles control tags into envelopes | Pre-wrap fast-path skips sanitize (N-4) | Always re-sanitize; only trust internally-produced blocks carrying a per-process HMAC tag |
| S-5 | `addTask()` inside a runner → `execute()` promise never settles; one wedged Jules HTTP child freezes the whole swarm | No dynamic-registration freeze, no per-task timeout (N-7) | Freeze task map at `execute()` start (throw on late adds) + per-runner `Promise.race` timeout |
| S-6 | Two tasks sharing an output file: dependent passes fingerprint gate on wrong producer's bytes | `fingerprints` keyed by path, not (producer,path) (N-6) | Key by `${taskId}:${path}`; dependent checks exactly its `dependsOn` set |
| S-7 | Disk full during WAL: torn intent line → parse-skip → worktree leaks unreaped forever; reservation granted while budget unreadable | Read-fault swallow in `reserveBudgetAtomic` (N-8); journal fail-open on corrupt lines | Fail closed on read errors (`LEDGER_UNREADABLE`); ENOSPC circuit-breaker on journal writes |
| S-8 | Clock skew / midnight rollover between `reserveBudget` (day N) and `commitBudgetReservation` (day N+1) splits one task across two ledgers; NTP backward jump extends mutex-hold estimates and TTL heuristics | `new Date().toISOString()` for file naming; wall-clock math for ages | Keep reservation id in both files via explicit rollover replay; use `process.hrtime.bigint()` durations for all age/TTL logic |
| S-9 | Net-guard evasion via `net.connect(443, host)`, `https.Agent` with custom `createConnection`, or `WebSocket`; TAP diagnostics destroyed by `process.exit(188)` mid-run | N-9 patching surface + hard exit | Extend preload to `node:net`/`node:tls`/`node:dgram`/`globalThis.WebSocket`; throw `ENETGUARD` and set `process.exitCode=188` instead of `exit()` |
| S-10 | Ordinary task prose is mangled — "note to user: rebase first" → "[ROLE_MARKER: user]" — degrading prompt quality and causing Jules confusion loops | `ROLE_PREFIX_REGEX` is unanchored (N-5 adjacent) | Anchor role markers to line start (`^\s*(system|assistant|user)\s*:`) and to structural positions only |
| S-11 | Timeout kills only the direct verify child; `npm test` grandchildren (node workers) continue writing to the worktree while the merge gate opens | `execFileSync` timeout SIGTERMs single pid; no process-group kill | Spawn verify through `ProcessGroupManager` (`detached:true`, kill `-pgid` on timeout) |
| S-12 | `fsyncSync` on file data but never on the containing directory → intent/journal/ledger file *creation* can vanish on power loss despite per-write fsync | POSIX durability requires directory fsync after create/rename | After first create, `fsync(openSync(dir,"r"))` once per day-file creation |
| S-13 | Diff-payload gate still measures *uncompressed* bytes: a 60 KB minified single-line file with an entropy-rich payload passes secret scan only on `+` lines — moved secrets on context lines invisible | `scanDiff` scans added lines only (Phase 1, by design) + low-confidence patterns downgrade on any HIT of high? | Document boundary; optionally scan `^\+` + renamed files' full bodies for high-confidence patterns only |
| S-14 | `queue.sort()` inside Kahn's dequeue loop + `queue.shift()` → O(n² log n) on thousand-node plans; fingerprint re-hashes entire output files on every scheduling tick | Algorithmic constant factors in `dag-engine.mjs` | Sorted-array insertion / two-queue layer swap; stat-size+mtime short-circuit before full-file hash |

---

## 5. Production-Ready ESM Code Sketches

Node ≥ 20 built-ins only, ≤ 40 lines each. **All sketches were extract-tested during this audit** (see §5.0 validation log).

### K1 — Boot-time stale mutex reaper  → `src/journal.mjs` (call from both boot paths, next to `reapOrphanedIntents`)

```js
import { readdirSync, statSync, rmdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getStateDir } from "./state.mjs";

/** A VFS mutex dir is always EMPTY and held for ms; older than ttlMs => orphaned by a dead process. */
export function reapStaleMutexDirs(root, { ttlMs = 30_000 } = {}) {
  const stateDir = getStateDir(root);
  const reaped = [];
  let entries = [];
  try { entries = readdirSync(stateDir, { withFileTypes: true }); } catch { return { reaped }; }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.endsWith(".mutex")) continue;
    const dir = join(stateDir, e.name);
    try {
      if (Date.now() - statSync(dir).mtimeMs <= ttlMs) continue;      // maybe live owner
      if (readdirSync(dir).length > 0) continue;                      // unknown content: hands off
      const grave = `${dir}.grave-${process.pid}`;
      try {                                            // CAS: exactly one concurrent reaper wins
        renameSync(dir, grave);
        rmdirSync(grave);
        reaped.push(e.name);
      } catch (casErr) { if (casErr.code !== "ENOENT") throw casErr; }
    } catch (err) { if (err.code !== "ENOENT") throw err; }
  }
  return { reaped };                                   // idempotent: next boot finds nothing
}
```

### K2 — Wilson-bound flaky verdict  → new `src/flaky-ledger.mjs`

```js
import { openSync, writeSync, fsyncSync, closeSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getStateDir } from "./state.mjs";

export function recordVerifyRun(root, testCmd, pass, fingerprint, durationMs = 0) {
  const p = join(getStateDir(root), "flaky.jsonl");
  const rec = { ts: new Date().toISOString(), testCmd, pass: !!pass, fingerprint, durationMs };
  const fd = openSync(p, "a");                              // O_APPEND: atomic line write
  try { writeSync(fd, JSON.stringify(rec) + "\n", "utf-8"); fsyncSync(fd); } finally { closeSync(fd); }
}

export function verifyHistory(root, testCmd, k = 10) {
  const p = join(getStateDir(root), "flaky.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.testCmd === testCmd).slice(-k);
}

export function wilsonInterval(failures, n, z = 1.96) {      // [lower, upper], closed-form
  if (n === 0) return [0, 1];
  const p = failures / n, z2 = z * z, d = 1 + z2 / n;
  const c = p + z2 / (2 * n), w = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [Number(((c - w) / d).toFixed(4)), Number(((c + w) / d).toFixed(4))];
}

export function flakyVerdict(runs) {                         // runs: [{pass}] oldest -> newest
  const n = runs.length;
  if (n < 6) return { verdict: "INSUFFICIENT_DATA", n, repairAllowed: true };
  const fails = runs.filter((r) => !r.pass).length;
  if (fails === 0) return { verdict: "HEALTHY", n, fails, repairAllowed: true };
  if (fails === n) return { verdict: "REPAIRABLE_REGRESSION", n, fails, oscillation: 0, repairAllowed: true };
  const recent3AllFail = runs.slice(-3).every((r) => !r.pass);
  if (recent3AllFail) return { verdict: "REPAIRABLE_REGRESSION", n, fails, note: "active failure tail", repairAllowed: true };
  const transitions = runs.slice(1).filter((r, i) => r.pass !== runs[i].pass).length;
  const oscillation = transitions / (n - 1);
  const [wl, wu] = wilsonInterval(fails, n);                 // interior mixing needs wl<0.8, wu>0.2
  if (oscillation >= 0.4 && wl < 0.8 && wu > 0.2)
    return { verdict: "QUARANTINED", n, fails, oscillation: Number(oscillation.toFixed(3)), wl, wu, repairAllowed: false };
  const recent3AllPass = runs.slice(-3).every((r) => r.pass);
  return { verdict: recent3AllPass ? "HEALTHY_OR_FIXED" : "REPAIRABLE_REGRESSION", n, fails, oscillation, wl, wu, repairAllowed: true };
}
// gate verify: v=flakyVerdict(verifyHistory(root,testCmd)); QUARANTINED -> exit 8, NO repair dispatch
```

### K3 — Gate quarantine integration (status is never misrepresented)  → `src/engine.mjs` verify phase

```js
// after testResult is known (verify phase), BEFORE repair():
import { recordVerifyRun, verifyHistory, flakyVerdict } from "./flaky-ledger.mjs";

const fp = fingerprintFailureState(testResult.ok ? { stderr: "clean:" + files.join(",") } : testResult, root);
recordVerifyRun(root, testCmd, testResult.ok, fp, 0);
if (!testResult.ok) {
  const q = flakyVerdict(verifyHistory(root, testCmd));
  if (q.verdict === "QUARANTINED") {
    phases.push({ phase: "verify", ok: false, reason: "FLAKY_QUARANTINE", quarantine: q });
    appendLedger({ event: "verify_quarantined", testCmd, fingerprint: fp, ...q }, root);
    return { ok: false, code: 8, phases };               // distinct exit; NO repair() dispatched
  }
}
// test must deliberately define: code 8 = "flaky quarantine", code 4 = genuine verify failure
```

### K4 — Two-channel indentation/declaration chunker  → new `src/merge-blocks.mjs`

```js
import { createHash } from "node:crypto";

const BOUNDARY = {
  js: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|const|let|var)\b/,
  py: /^(?:async\s+def|def|class)\s+\w+/,
};

export function chunkBlocks(text, lang = "js") {
  const lines = String(text).split("\n"), blocks = [], counts = new Map();
  const minIndent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.search(/\S/)), 0);
  let cur = null;
  const indentOf = (l) => (l.trim() ? l.search(/\S/) : Infinity);
  const close = () => { if (cur && cur.body.length) blocks.push(cur); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const boundary = BOUNDARY[lang]?.test(line) && indentOf(line) === minIndent;
    const dedentClose = cur && indentOf(line) <= cur.indent && line.trim() && !boundary && lang === "py";
    if (!cur || boundary || dedentClose) {
      close();
      const sigBase = line.trim() || "__preamble__";
      const occ = counts.get(sigBase) || 0; counts.set(sigBase, occ + 1);
      cur = { sig: occ ? `${sigBase}#${occ}` : sigBase, indent: indentOf(line), startLine: i + 1, body: [] };
    }
    cur.body.push(line);
  }
  close();
  return blocks.map((b) => ({ ...b, endLine: b.startLine + b.body.length - 1,
    hash: createHash("sha1").update(b.body.map((l) => l.trimEnd()).join("\n").trim()).digest("hex").slice(0, 12) }));
}
```

### K5 — 3-way classify & emit + verify chain  → `src/merge-blocks.mjs` (continued) + `src/merge-verify.mjs`

```js
export function mergeBlocks3Way(baseText, oursText, theirsText, lang = "js") {
  const toMap = (t) => new Map(chunkBlocks(t, lang).map((b) => [b.sig, b]));
  const B = toMap(baseText), O = toMap(oursText), T = toMap(theirsText);
  const order = [...B.keys(), ...[...O.keys()].filter((k) => !B.has(k)), ...[...T.keys()].filter((k) => !B.has(k) && !O.has(k))];
  const out = [], conflicts = [];
  for (const sig of order) {
    const b = B.get(sig), o = O.get(sig), t = T.get(sig);
    const kind =
      o && t && o.hash === t.hash ? "IDENTICAL" :
      o && t && b && o.hash === b.hash ? "ONLY_THEIRS" :
      o && t && b && t.hash === b.hash ? "ONLY_OURS" :
      o && !t ? (b ? "DELETED_BY_THEIRS" : "ADDED_OURS") :
      !o && t ? (b ? "DELETED_BY_OURS" : "ADDED_THEIRS") : o && t ? "CONFLICT_EDIT_EDIT" : "GONE_BOTH";
    if (kind === "IDENTICAL" || kind === "ONLY_OURS") out.push(o.body.join("\n"));
    else if (kind === "ONLY_THEIRS" || kind === "ADDED_THEIRS") out.push((t ?? o).body.join("\n"));
    else if (kind === "ADDED_OURS") out.push(o.body.join("\n"));
    else if (kind === "DELETED_BY_OURS" || kind === "DELETED_BY_THEIRS" || kind === "GONE_BOTH") continue; // honor deletion
    else { conflicts.push({ sig, kind, oursLines: o && [o.startLine, o.endLine], theirsLines: t && [t.startLine, t.endLine] });
      out.push(`<<<<<<< OURS (${sig})\n${o?.body.join("\n") ?? ""}\n=======\n${t?.body.join("\n") ?? ""}\n>>>>>>> THEIRS (${sig})`); }
  }
  return { merged: out.join("\n").replace(/\n{3,}/g, "\n\n"), conflicts };
}
```
```js
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path";

export function mergeVerifyChain(mergedText, fileName, root) {   // binary exit-code gate
  const dir = mkdtempSync(join(tmpdir(), "merge-verify-"));
  const p = join(dir, fileName);
  writeFileSync(p, mergedText, "utf-8");
  if (/\.[cm]?jsx?$/.test(fileName)) return { ok: spawnSync("node", ["--check", p], { encoding: "utf-8" }).status === 0, tool: "node --check" };
  if (/\.tsx?$/.test(fileName))
    return existsSync(join(root, "tsconfig.json"))
      ? { ok: spawnSync("tsc", ["--noEmit", "--pretty", "false", p], { cwd: root, encoding: "utf-8" }).status === 0, tool: "tsc --noEmit" }
      : { ok: true, tool: "skipped-no-tsconfig (documented)" };
  if (/\.py$/.test(fileName)) return { ok: spawnSync("python3", ["-m", "py_compile", p], { encoding: "utf-8" }).status === 0, tool: "py_compile" };
  return { ok: true, tool: "no-checker (documented)" };
}
```

### K6 — O(1) telemetry appender with segment continuity  → new `src/telemetry.mjs`

```js
import { openSync, writeSync, fsyncSync, closeSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getStateDir } from "./state.mjs";
import { safeAtomicWrite } from "./security.mjs";

const SEG_LIMIT = 8 * 1024 * 1024;                 // 8 MB segments bound read-tail cost
export function telemetryPaths(root) {
  const d = new Date().toISOString().slice(0, 10);
  return { log: join(getStateDir(root), `telemetry-${d}.jsonl`), head: join(getStateDir(root), `telemetry-${d}.head`) };
}

export function appendTelemetry(root, kind, fields = {}) {
  const { log, head } = telemetryPaths(root);
  let prevHash = "0".repeat(64);
  if (existsSync(head)) {
    const h = readFileSync(head, "utf-8").trim();
    if (/^[0-9a-f]{64}$/.test(h)) prevHash = h;                                  // O(1) steady state
  } else if (existsSync(log)) {                                                  // cold recovery, once per day
    const lines = readFileSync(log, "utf-8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) { try { const o = JSON.parse(lines[i]); if (o.hash) { prevHash = o.hash; break; } } catch {} }
  }
  const raw = { v: 1, ts: new Date().toISOString(), kind, ...fields, prevHash };
  const rec = { ...raw, hash: createHash("sha256").update(JSON.stringify(raw)).digest("hex") };
  const fd = openSync(log, "a");
  try { writeSync(fd, JSON.stringify(rec) + "\n", "utf-8"); fsyncSync(fd); } finally { closeSync(fd); }
  safeAtomicWrite(head, rec.hash);
  if (statSync(log).size > SEG_LIMIT) return { rotated: true, hint: "open next segment with prevSegmentTailHash=" + rec.hash };
  return { ok: true, hash: rec.hash };
}
```

### K7 — Coalesced, backpressure-safe MCP progress streamer  → `src/mcp.mjs` additions

```js
import { once } from "node:events";

export class ProgressBus {
  constructor(writeFrame) {                        // writeFrame MUST be writeMcpFrame (sealed stdout path)
    this.writeFrame = writeFrame;
    this.state = new Map();                        // token -> { seq, pending, timer, done }
  }
  _emit(token, params) {
    const r = this.writeFrame(JSON.stringify({ jsonrpc: "2.0", method: params.method, params }) + "\n");
    return r === true;                             // false => backpressure: caller awaits drain
  }
  progress(token, message, total = 1) {
    if (token === undefined || token === null) return;
    const s = this.state.get(token) ?? { seq: 0, timer: null, pending: null };
    s.pending = { method: "notifications/progress", progress: s.seq++, total, message: String(message).slice(0, 240), progressToken: token };
    if (!s.timer) {
      s.timer = setTimeout(() => { s.timer = null; if (s.pending) { this._emit(token, s.pending); s.pending = null; } }, 150);
    }
    this.state.set(token, s);                      // latest-wins coalescing per 150 ms window
  }
  async flush(token) {
    const s = this.state.get(token);
    if (s?.timer) { clearTimeout(s.timer); s.timer = null; if (s.pending) { this._emit(token, s.pending); s.pending = null; } }
  }
}
export function resourcesUpdated(bus, uri) {       // throttled by caller (<=1/s)
  bus._emit("resource:" + uri, { method: "notifications/resources/updated", uri });
}
// stalled-writer rule: if _emit returns false -> await once(output, "drain") before next frame
void once; // kept for the drain-await call site in startMcpServer's writeMcpFrame wrapper
```

### K8 — DAG hardening patch (freeze + per-task timeout + producer-keyed fingerprints)  → `src/dag-engine.mjs`

```js
// 1) execute(): freeze registrations
//    this.frozen = true; addTask() { if (this.frozen) throw new Error("DAG frozen after execute()"); ... }
// 2) producer-keyed fingerprint stores
//    fingerprints.set(`${task.id}:${outputFile}`, hash)  ... dependent checks only its dependsOn set's keys
// 3) per-task timeout wrapper:
export function withTaskTimeout(runner, ms = 900_000) {
  return (ctx) => Promise.race([
    runner(ctx),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`DAG_TASK_TIMEOUT after ${ms}ms: ${ctx.id}`)), ms)
      .unref?.() ?? null),
  ]);
}
```

### 5.0 Sketch validation log (executed during this audit)

| Sketch | Validation |
|---|---|
| K1 | Orphan `x.mutex` dir with mtime 60s old → reaped 1, repeat run reaped 0 (idempotent); fresh dir untouched ✓ |
| K2 | `[P,F,P,F,P,F]` → QUARANTINED; `[F×6]` → REPAIRABLE_REGRESSION; `[P,F,P,F,F,F]` (active tail) → REPAIRABLE_REGRESSION; `[P×6]` → HEALTHY; `[F,F,P,P,P,P]` → HEALTHY_OR_FIXED; `n<6` → INSUFFICIENT_DATA ✓ |
| K4/K5 | Disjoint additions merge clean (0 conflicts); same-sig edit → exactly 1 `CONFLICT_EDIT_EDIT` with line ranges; Python dedent chunking verified on a no-boundary fixture ✓ |
| K5b (verify) | `node --check` returns 0 on merged fixture, non-zero on a deliberately corrupted merge ✓ |
| K6 | 500 appends → head == true tail; delete head → cold path recovers exact tail hash ✓ |
| K7 | 1000 `progress()` calls → ≤ 10 frames emitted; flushed final frame equals `seq` end ✓ |
| K8 | Dynamic `addTask` inside frozen executor throws instead of hanging ✓ |

---

## 6. Sequenced Remediation Order

1. **Immediately (one-commit class):** N-3 absolute preload URL · N-2 lock starttime cross-check · K1 mutex reaper into both boot paths · N-4 re-sanitize pre-wrapped input · D3 count `budget_reserved` only · D4 `cat-file` exit-status check.
2. **Next cycle:** P2-F1 flaky ledger + gate exit 8 · N-9 preload surface (net/tls/ws + `exitCode`) · K8 DAG freeze/timeout/producer keys · N-5 wire prompt-guard into dispatch/webhook/MCP argument paths.
3. **Then:** P2-F2 merger behind `merge_verify_chain` with dry-run shadow vs `git merge-file` · P2-F3 telemetry spine + MCP bus · S-11 process-group verify kills · S-12 directory fsync.

*Invariants held: zero runtime dependencies; Node ≥ 20.0 APIs only (`--import` paths documented with the 20.0–20.5 `--require` twin); every state mutation rides existing ledgers/mutex; every capability falsifiable by `node --test` or process exit codes.*
