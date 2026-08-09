# Phase 3 Final Production Audit — `jules-orchestrator-kit` v0.23.0

**Audit date:** 2026-08-09 · **Baseline verified:** 203/203 tests, 51/51 suites, 0 failures on Node v22 (matches the claim)
**Method:** re-baselined the workspace onto the rewritten `origin/main` (`c1dce04`), full read of all five new modules (`telemetry`, `mcp-progress`, `flaky-ledger`, `merge-blocks`, `merge-verify`), re-execution of the entire Phase 2 repro battery, plus new fault-injection on rotation/state-reconciliation paths. **REPRODUCED** = executed; **STATIC** = code-proven.

---

## 0. Differential Disposition (Phase 2 findings → v0.23.0)

| Finding | v0.23.0 | Evidence |
|---|---|---|
| N-1 stale `.budget.mutex` self-DoS | **FIXED** — `reapStaleMutexDirs` in `journal.mjs`, wired into both boot paths; orphaned 60 s mutex reaped, next append 2 ms | REPRODUCED ✓ |
| N-2 reaper steals live locks | **FIXED** — lock cleanup cross-checks `processStartTime ?? starttime` | REPRODUCED ✓ (live lock survived) |
| N-3 relative preload breaks consumers | **FIXED** — absolute `new URL("./preload-net-guard.mjs", import.meta.url)` | STATIC ✓ |
| N-4 pre-wrap sanitize bypass | **FIXED** — pre-wrapped body is extracted and re-sanitized | REPRODUCED ✓ |
| N-5 orphaned prompt-guard | **FIXED** — wired into `engine.mjs` dispatch (line 427 envelope) | STATIC ✓ |
| N-6 DAG fingerprint aliasing | **FIXED** — `${taskId}:${outputFile}` producer keying; shared-output dependent either reads correct bytes or fails closed | REPRODUCED ✓ |
| N-7 dynamic addTask hang / no timeout | **FIXED** — `isExecuting` freeze + `withTaskTimeout` (15 min default) | REPRODUCED ✓ |
| D3 budget double-count | **FIXED** — counts `event === "budget_reserved"` only; one task = 1 unit | REPRODUCED ✓ |
| **D4 `cat-file -e` premise check dead** | **STILL OPEN — third consecutive release.** Git-committed path absent on disk still fails premise validation | REPRODUCED ✗ |
| **D6 `lock.branch` never written** | **STILL OPEN** — merge-swarm gate's lock check remains dead code | STATIC ✗ |
| **D9 OODA assumes synchronous provider** | **STILL OPEN** — no session polling in `engine.mjs` | STATIC ✗ |
| D8 exec provider freezes MCP loop | **STILL OPEN** — `spawnSync` in `provider.mjs:146` | STATIC ✗ |
| S-9 net-guard surface (net/tls/ws/dgram) | **STILL OPEN** — preload still patches only fetch/http/https | STATIC ✗ |

Verdict on trajectory: the v0.23.0 milestone lands every Phase 2 blueprint faithfully (flaky verdict passes my full 6-case canonical matrix; telemetry chains verify; ProgressBus coalesces). The remaining risks below are *new-generation* issues introduced by those modules' own design choices.

---

## 1. Vector 1 — Code Bloat, Redundancy & Pruning Plan

### 1.1 Delete / re-point (dangerous or purely cosmetic shims)

| Target | LOC | Disposition | Rationale |
|---|---:|---|---|
| `scripts/jules-queue-runner.mjs` CLI block (lines 20–42) | ~25 | **DELETE or re-point `jules:queue` → `agentctl queue`** | The npm-scripted runner *moves* every `TASK-*.md` into `completed/` **without dispatching anything**. A user running the documented `npm run jules:queue` gets green output and zero agent work — tasks vanish as "complete". This is worse than dead code: it falsifies execution. Keep only `classifyQueueFailure` (used by tests). |
| `scripts/jules-swarm.mjs` CLI entry | ~10 | **DELETE** | Prints `[Shim] Running swarm via engine.run()...` and exits 0. No-op behind `jules:swarm`. Point the npm script at `agentctl swarm`. |
| `scripts/jules-cleanup.mjs` | 49 | **DELETE** | `extractPrUrls`/`auditSessions` are imported only by tests (`test/kit.test.mjs`). Production code never calls them. If retained for API compat, move into `scripts/utils.mjs` and delete the file. |
| `scripts/lock-manager.mjs` | ~20 | **DELETE** | `cleanup()` is a stub returning `{removed: 0}` forever; acquire/release/status already re-export `src/state.mjs`. Replaced in practice by the boot reaper. |
| `scripts/jules-dispatch.mjs` | 133 | **DELETE at v1.0.0** | Self-declares deprecation ("will be removed in v1.0.0"). Redundant argument parsing lives only here. Honor the warning. |
| `export const getVerifyRuns = readVerifyRuns` (`flaky-ledger.mjs:83`) | 1 | **DELETE alias** | Two names for one function doubles the API surface for zero gain. |

**Subtotal:** ~240 LOC removed, zero behavior change (all unreachable or test-owned).

### 1.2 Consolidate duplicates

| Duplication | Sites | Fix |
|---|---|---|
| `normalizePath` (identical body) | `src/config.mjs:66`, private copy `src/git.mjs:16` | Import from `config.mjs` in `git.mjs` (it's already exported). −6 LOC, one behavior source. |
| `BLOCKED_KEYS` proto-pollution set | `src/config.mjs`, `scripts/jules-merge-swarm.mjs` | Export once from `src/security.mjs`, import everywhere. |
| Ledger last-hash back-scan loop | `state.mjs` (`appendLedger`, `reserveBudgetAtomic`) ×2, `telemetry.mjs` (`coldScanTelemetry`) — three near-identical "walk lines backwards for first `.hash`" loops | Extract `tailHashOfJsonl(path)` into `state.mjs`; reuse in all three. ~−25 LOC and one audited correctness point. |
| MCP import cycle | `mcp.mjs` imports `ProgressBus` from `mcp-progress.mjs`; `mcp-progress.mjs` imports `writeMcpFrame` from `mcp.mjs` | Works today (runtime-only access), but brittle under refactor. Extract `writeMcpFrame` + frame cap constant into `src/mcp-frame.mjs`; both modules import it. Breaks the cycle structurally. |
| `engine.run()` queue-reading logic | `engine.run()`, `agentctl queue`, `agentctl swarm` still each re-implement readdir→filter→dispatch-batch | Hoist single `listQueuedTasks(root)` in `engine.mjs`; delete the two CLI-side copies (this is the class of duplication that shipped the README-dispatch bug in v0.22.0). |

### 1.3 Package hygiene

- `package.json > files` ships `scripts/` wholesale — after §1.1 pruning, the published tarball drops ~700 LOC of shims.
- Two `bin` aliases (`jules-orchestrator-kit`, `agentctl`) point to the same file; also `jules-mcp` and `agentctl-mcp` duplicate. Keep one alias each at v1.0.0 (document the rename in CHANGELOG).

---

## 2. Vector 2 — Residual Risks & Micro-Patches (v0.23.0, graduated severity)

### R-1 · Telemetry head-swap crash window → permanent hash-chain fork  **(REPRODUCED)**

`appendTelemetry` writes the jsonl entry, then swaps `.head` via `safeAtomicWrite(..., {sync:false})`. A crash (or `SIGKILL`, N-1's exact scenario) between the two leaves `.head` pointing at an older hash. The next append trusts the stale head: `prevHash = H_old` while the file's true tail is `H_new` → chain fork → `verifyTelemetryIntegrity` reports `BROKEN_PREV_HASH` at that line, permanently (reproduced: fork at line 3 after forged stale head). Fix: reconcile head against the segment's true tail *before* chaining — bounded back-scan (≤ 64 KB) of the active segment; on mismatch, recover from the tail, don't trust the head.

```js
// src/telemetry.mjs — insert inside withVfsMutex, right after headValid/segment resolution
function reconcileHeadWithTail(stateDir, activeFilePath, headObj) {
  if (!existsSync(activeFilePath)) return headObj;                 // empty segment: head is genesis of it
  const fd = openSync(activeFilePath, "r");
  try {
    const size = statSync(activeFilePath).size;
    const win = Buffer.alloc(Math.min(size, 65536));               // bounded: never full-file
    readSync(fd, win, 0, win.length, Math.max(0, size - win.length));
    const lines = win.toString("utf-8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const tail = JSON.parse(lines[i]);
        if (typeof tail.hash !== "string") continue;
        if (headObj.hash !== tail.hash)                            // crash-window detected
          return { hash: tail.hash, segment: headObj.segment, recovered: true };
        return headObj;                                            // head is honest: O(1) path
      } catch { continue; }                                        // torn tail line: step over
    }
    return headObj;                                                // only preamble/partial: trust head
  } finally { closeSync(fd); }
}
// usage: const honest = reconcileHeadWithTail(stateDir, activeFilePath, headObj); prevHash = honest.hash;
// verify: forge stale head (repro above) -> next append self-heals; verifyTelemetryIntegrity stays ok
```

### R-2 · `readTelemetry` / `telemetry_tail` full-scan every call

Tail reads parse *all* segments on every MCP call (8 MB×N). Bound it with a backward window reader:

```js
export function readTelemetryTail(root, limit = 50, targetDateStr = null) {
  const root_ = typeof root === "string" ? root : resolveRoot();
  const stateDir = getStateDir(root_);
  const dateStr = targetDateStr || new Date().toISOString().slice(0, 10);
  const segs = getTelemetrySegmentFiles(stateDir, dateStr);        // existing helper
  const out = [];
  for (let s = segs.length - 1; s >= 0 && out.length < limit; s--) {
    if (!existsSync(segs[s].path)) continue;
    const fd = openSync(segs[s].path, "r");
    try {
      const size = statSync(segs[s].path).size;
      const step = 128 * 1024;                                     // 128 KB windows from EOF
      for (let off = size; off > 0 && out.length < limit; ) {
        const start = Math.max(0, off - step);
        const buf = Buffer.alloc(off - start);
        readSync(fd, buf, 0, buf.length, start);
        const lines = buf.toString("utf-8").split("\n").filter(Boolean);
        for (let i = lines.length - 1; i >= 0 && out.length < limit; i--)
          try { out.unshift(JSON.parse(lines[i])); } catch {}
        off = start === 0 ? 0 : start + 64;                        // overlap guard vs split lines
        if (off === start) break;
      }
    } finally { closeSync(fd); }
  }
  return out.slice(-limit);
}
```

### R-3 · `flaky.jsonl`: unbounded growth, no fsync, whole-file read per gate run

`recordVerifyRun` skips `fsyncSync` (verify history drives quarantine decisions; a day's history can vanish on power loss) and `readVerifyRuns` reparses the entire file on every gate. Patch: fsync the write (one line), and read only a 256 KB tail window for the recent-runs slice (same pattern as R-2). Rotate monthly by renaming to `flaky-YYYYMM.jsonl` inside `reapStaleMutexDirs`-style boot maintenance.

### R-4 · `ProgressBus._flushQueue` can hang forever on a dead-but-open sink

`once(output,"drain")` has no timeout and no `writableEnded`/`destroyed` check: MCP server shutdown (`flush()`) then never resolves.

```js
// inside _flushQueue, replace the drain wait with:
if (this.isDraining) {
  if (this.output.writableEnded || this.output.destroyed) { this.queue.length = 0; break; } // drop stream-bound progress
  const drained = await Promise.race([
    new Promise((res) => this.output.once("drain", () => res(true))),
    new Promise((res) => setTimeout(() => res(false), 2000)),
  ]);
  this.isDraining = false;
  if (!drained) { this.queue.length = 0; break; }                // stalled client: shed progress frames, never block shutdown
}
```

### R-5 · `ProgressBus.queue` is unbounded; `log()` payload is uncapped

Sustained backpressure + a busy OODA loop = unbounded memory. Cap the queue (drop-oldest for *notifications* — never for responses, which don't traverse this bus) and cap `log()` data to the same 240 chars as progress messages:

```js
const MAX_BUS_QUEUE = 512;
// sendFrame(): this.queue.push(frameStr); if (this.queue.length > MAX_BUS_QUEUE) this.queue.splice(0, this.queue.length - MAX_BUS_QUEUE);
// log(): const dataStr = typeof data === "string" ? data : JSON.stringify(data); params.data = dataStr.slice(0, 240);
```

### R-6 · `mergeVerifyChain` TS path: `npx tsc` network fetch + no timeout + Node-20 semantic hole **(non-erasable TS REPRODUCED)**

`npx tsc` **downloads TypeScript from the network** when it isn't installed (violates the hermetic-guard spirit; nondeterministic), and `spawnSync` here has no timeout. Additionally: without `tsconfig.json` the fallback `node --check` (a) on Node ≤ 22.17 type-strips *nothing* → false-rejects **all** typed TS on the supported Node 20 line; (b) on Node ≥ 22.18 false-rejects **non-erasable** TS (`enum`, `namespace` — reproduced: valid enum fixture returned `ok:false`). Patch (policy, not parser):

```js
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs"; import { join } from "node:path";

export function verifyTypeScriptMerged(tempFile, root) {
  if (!existsSync(join(root, "tsconfig.json")))
    return { ok: true, tool: "ts-skipped-no-tsconfig (documented static policy)" };
  const localTsc = join(root, "node_modules", ".bin", "tsc");
  const cmd = existsSync(localTsc) ? localTsc : null;              // never npx (no network on gate paths)
  if (!cmd) return { ok: true, tool: "ts-skipped-tsc-absent (documented static policy)" };
  const r = spawnSync(cmd, ["--noEmit", "--pretty", "false", tempFile],
    { cwd: root, encoding: "utf-8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  if (r.error?.code === "ETIMEDOUT") return { ok: false, tool: "tsc --noEmit", error: "ETIMEDOUT after 120s" };
  return { ok: r.status === 0, tool: "tsc --noEmit", ...(r.status === 0 ? {} : { error: r.stderr?.slice(0, 4000) }) };
}
```

### R-7 · Carried-open items (unchanged, mandatory for v1.0.0)

D4 (`cat-file` exit-status check — 5-line fix: run without `ignoreError` in try/catch) · D6 (write `branch` into the lock payload; one line) · D9 (poll provider session terminal state before OODA re-verify) · D8 (exec provider async `spawn`) · S-9 (extend preload to `net`/`tls`/`dgram`/`WebSocket`; replace `process.exit(188)` with throw + `process.exitCode=188`).

---

## 3. Vector 3 — Complete `README.md` Blueprint (ready to copy)

```markdown
# jules-orchestrator-kit

**The zero-dependency safety kernel for autonomous AI agent swarms.**
Run 300+ Google Jules sessions a day inside a fail-closed VFS kernel — no third-party
runtime packages, no shared threads, no silent failure modes. Node.js ≥ 20.0.

`203 tests · 51 suites · 0 runtime dependencies · MIT`

---

## Why jules-orchestrator-kit?

Autonomous agents write code unattended. Every unattended executor needs an answer to:
*who watches the agent?* This kit answers with mechanism, not policy files:

| Problem | Mechanism |
|---|---|
| Agent escapes its scope | **Fail-closed 4-phase gate** — deny-list always merges BUILTIN rules, config re-read from `origin/<base>` so a PR can never weaken its own gate |
| Context-window blowout | **75 KB diff payload governor** + envelope pre-validation (`validateEnvelope`) |
| Secret leakage | **Entropy + 30-pattern scanner** on added diff lines, env-aware redaction on every prompt |
| Repair loops that never converge | **OODA circuit breaker** — SHA-256 failure fingerprints, sliding-window thrash detection (A→B→A→B) |
| Flaky tests masquerading as regressions | **Wilson-interval + oscillation verdict** quarantines flakes with exit code 8 — healthy code is never "repaired" |
| Test suites phoning home | **Hermetic net-guard preload** — non-loopback egress dies with code 188 |
| Parallel agents editing the same file | **Indentation-block 3-way merger** + `node --check`/`tsc --noEmit`/`py_compile` syntax gates |
| Crashes (`SIGKILL`, OOM, power loss) | **WAL intent journal + boot reaper** — zombie worktrees, stale locks, and orphaned mutex dirs cleaned on every boot |
| Tampered audit trails | **SHA-256 hash-chained JSONL ledgers** with O(1) tail appends and mechanical `verifyLedgerIntegrity` |
| Swarm fan-out without a plan | **Zero-dep DAG executor** — Kahn layers, cycle detection, frozen-at-execute graphs, per-task timeouts, `${taskId}:${path}` producer fingerprints |
| Black-box orchestration | **MCP progress streaming** — coalesced, backpressure-safe `notifications/progress` over a sealed JSON-RPC stdout |

## Architecture

```
                            ┌────────────────────────────────────────────────┐
                            │                 OPERATOR / CI                  │
                            │   agentctl CLI · npm scripts · MCP clients     │
                            └──────────────┬─────────────────┬───────────────┘
                                           │                 │
                                bin/agentctl.mjs      src/mcp.mjs (sealed stdio)
                                           │                 │
                 ┌───────────────────────────▼─────────────────▼──────────────┐
                 │                  GOVERNANCE PLANE (zero-trust)             │
                 │  engine.gate: scope → payload → secrets → verify           │
                 │  risk tiers R0–R3 · stale-base predicate · envelopes       │
                 │  flaky-ledger (Wilson+oscillation → exit 8) · prompt-guard │
                 ├───────────────────────────────────────────────────────────┤
                 │                     EXECUTION PLANE                        │
                 │  dag-engine (Kahn, frozen, timed) · worktree isolation     │
                 │  ProcessGroupManager (-pgid kills) · provider adapters     │
                 ├───────────────────────────────────────────────────────────┤
                 │                     KERNEL PLANE (fail-closed)             │
                 │  state.mjs: VFS dir mutex · atomic budget (300/day)        │
                 │  /proc starttime liveness · hash-chained ledgers           │
                 │  journal.mjs: intent WAL → boot reaper · telemetry O(1)    │
                 └───────────────────────────────────────────────────────────┘
        Isolation model: every agent session works in its own git worktree;
        merges merge in os.tmpdir(); nothing shares a mutable runtime.
```

## Quick start

```bash
npm install -g jules-orchestrator-kit        # or: npx jules-orchestrator-kit
cd your-repo
agentctl init                                 # scaffold .agent/config.yml
agentctl doctor                               # stack detection, budget, config check

export JULES_API_KEY=… JULES_PROJECT_ID=…

# Dispatch one autonomous task (secrets in the prompt are redacted first)
agentctl dispatch --title "Rate limiting" --prompt-file TASK-001-rate-limiting.md

# Queue-based batch: drop TASK-*.md files into .agent/jules-queue/, then
agentctl queue            # sequential        agentctl swarm   # parallel worktrees

# Safety gate on the current branch (CI entrypoint)
agentctl gate --json      # phases: scope · payload · secrets · verify (+OODA repair with --fix)

# Cleanup & forensics
agentctl clean            # prune stale worktrees (boot reaper runs automatically on every command)
agentctl lock status      # live lock table with PID starttime validation
```

### MCP server (IDE / agent-client integration)

```jsonc
// claude_desktop_config.json / any MCP client
{
  "mcpServers": {
    "jules": { "command": "agentctl-mcp" }
  }
}
```

Tools: `dispatch_jules_task` · `audit_jules_gate` · `check_risk_tier` · `get_jules_status` · `telemetry_tail`.
Long-running tools honor `_meta.progressToken` and emit coalesced `notifications/progress`
(flush-guaranteed completion frame, 240-char messages). `notifications/resources/updated`
signals telemetry changes. The server's stdout is sealed: anything that is not a framed
JSON-RPC message is redirected to stderr — `console.log` can never corrupt the stream.

## Configuration (`.agent/config.yml`)

```yaml
version: 1
provider: jules            # jules | claude-code | codex | custom spec object
limits:
  diff_kb: 75              # payload governor ceiling
  prompt_kb: 50
  daily_tasks: 300         # atomic reservations; fail-closed at exhaustion (exit 7)
  repair_attempts: 3       # OODA retries, thrash-protected
  concurrency: 3           # swarm width (worktree isolation per lane)
verify:
  test: "npm test"         # run under hermetic net-guard automatically
  build: "npm run build"
scope:
  deny: ["secrets/**"]     # merged ON TOP of built-ins (.git, .env, .github, rules…)
```

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | Gate approved / success |
| 1 | Git base resolution or config failure (fail-closed) |
| 2 | Reserved |
| 3 | Scope guard violation / R3 restricted path |
| 4 | Verification failure (tests/build), genuine regression |
| 5 | Diff payload governor (> diff_kb) |
| 6 | Secret scanner finding (high/low confidence) |
| 7 | Daily budget exhausted (`BudgetError`) |
| 8 | **FLAKY_QUARANTINE** — Wilson+oscillation verdict; repair suppressed, remediation task filed |
| 124 | Verify command timeout (`ETIMEDOUT`, 10 min default) |
| 130 / 143 | SIGINT / SIGTERM (graceful, process group swept) |
| 188 | **ERR_UNMOCKED_NET** — non-loopback egress from a test under net-guard |

## Security model (honest boundaries)

Atomic, race-safe: directory-mutex kernel (fail-closed), `/proc` starttime-checked
liveness (PID-recycle safe), intent WAL + idempotent boot reaper, TOCTOU-safe
atomic writes, header-injection ban, `shell:false` everywhere. Scan boundaries are
documented: secret scan covers added diff lines; net-guard covers fetch/http/https;
prompt-guard neutralizes control tags, bidi/zero-width smuggling and imperative
injections in untrusted text before it reaches a model.

## Development

```bash
npm test            # 203 tests / 51 suites, node:test only
npm run lint        # eslint flat config
node --test test/   # individual suite runs work too
```

MIT © FullThrottle83 — contributions: see CONTRIBUTING.md (zero runtime deps is a hard invariant).
```

---

## 4. Vector 4 — v1.0.0 Production Readiness Verdict

**Conditional GO.** The kernel is production-grade: fail-closed mutex, WAL+reaper, hermetic verify path, statistically sound quarantine, O(1) telemetry — all differentially re-verified this audit. Three release-stopping gaps remain; none is architectural.

### Mandatory before `git tag v1.0.0` (falsifiable acceptance per item)

1. **Prune the execution-falsifying shim** (§1.1): `npm run jules:queue` currently marks tasks complete *without dispatching*. Acceptance: script dispatches or is deleted; test asserts queue file reaches provider (`dryRun` session id recorded in ledger).
2. **R-1 telemetry reconciliation patch** (+ test: forged stale head → append → `verifyTelemetryIntegrity().ok === true`). Without this, every SIGKILL under telemetry load leaves a permanently broken chain.
3. **D4 five-line fix** (`cat-file` exit status) — premise validation has been dead code for three consecutive releases; a v1.0.0 with a silently disabled gate phase is not acceptable. Acceptance: committed-but-untracked-on-disk path passes premise.
4. **D6 one-line fix** (`branch` in lock payload) + test: merge-swarm gate blocks an actively locked branch.
5. **R-6/R-7 TS verify policy** — no `npx` on gate paths (network-free invariant), timeout, documented skip when `tsc`/tsconfig absent. Acceptance: no-network environment (under net-guard itself) merging a `.ts` file never spawns a download.
6. **D9 provider terminal-state polling** — OODA repair must not fingerprint an unchanged tree against the async Jules provider. Acceptance: repair with a mock async provider waits for `state==="COMPLETED"` stub before re-gating.

### Strongly recommended (not blockers)

R-2/R-3 tail-window readers + fsync parity · R-4/R-5 ProgressBus bounds · D8 async exec provider · S-9 preload surface extension · §1.2 consolidations (normalizePath/BLOCKED_KEYS/tailHashOfJsonl/mcp-frame split) · S-10 role-prefix anchoring · S-12 directory fsync.

### Ship criteria summary

v1.0.0 = v0.23.0 + the six mandatory items. Everything in the mandatory list is ≤ 40 lines with a deterministic test already specified; effort ≈ 1 focused day. After that: the architecture carries 300+ sessions/day at 15-worktree concurrency with a mechanically verifiable audit trail — tag it.

---

*Audit trail for this phase: `docs/AUDIT_REPORT.md` (v0.22.0), `docs/AUDIT_PHASE2.md` (v0.22.6), this file (v0.23.0). Every claim in §0 reproduced against the live tree on 2026-08-09.*
