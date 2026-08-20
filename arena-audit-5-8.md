Found the repo cloned — now starting the deep structural and concurrency audit.

Initial file reads show several concurrency issues. Digging deeper into the cross-module interactions and edge cases to complete the audit.

```
# AUDIT_ARCHITECTURE

## Structural Issues
- **God export surface `index.mjs`**: 41 export statements expanding to ~130+ symbols (security primitives, TUI widgets, provider adapters, evidence, DAG, budget, gate/dispatch). No layered API; any internal becomes public contract. Breaks cohesion, prevents semver reasoning. Also exports from `./scripts/*` (CLI runners) mixing library + binary.
- **High fan-out `src/engine.mjs`**: imports 15+ domains (config, security, git, provider, router, state, budget, prompt-guard, flaky-ledger, dag-engine, telemetry, remediation, memory, wizard-task, evidence). Single file owns scope guard, payload check, secret scan, verification pipeline, OODA repair, dispatch routing, queue runner, and PR description synthesis. Single-responsibility failure; change in any domain forces engine to change.
- **God dependencies**: Fan-in highest: `config.mjs` (imported by state, budget, telemetry, security, mcp, wizard-oracle, wizard-task, task-optimizer, router, stack-detector re-export), `state.mjs` (budget, journal, telemetry, flaky-ledger, remediation, dashboard, mcp, wizard-task), `security.mjs` (engine, envelope, evidence consumers). `config` change → cascade.
- **Circular imports**:
  - `engine.mjs` → `wizard-task.mjs` (`resolveRolePrompt`) AND `wizard-task.mjs` → `engine.mjs` (`gate`). ESM live binding may leave one undefined during module eval.
  - Indirect: `engine.mjs` → `dag-engine.mjs` → `telemetry.mjs` → `state.mjs` → `config.mjs` is DAG, but `config.mjs` dynamically aggregates `stack-detector.mjs` which is tested via `node:test` side-import in same file, coupling test harness to production import graph.
- **Duplicate consensus logic**: `state.mjs` contains both budget ledger logic AND PID lock logic AND VFS mutex. `budget.mjs` repeats atomic write (`writeAtomic`) distinct from `security.mjs:safeAtomicWrite` and `evidence.mjs:writeFileAtomically` – 3 atomic-write impls, different fsync semantics.
- **Config verification fallback using `||`**: `loadConfig` resolves verify commands with `setupCmd = parsed.setup_cmd || parsed.verify?.setup || ""` then `resolveVerify` fallback. Explicit empty-string (intending "disable this stage") loses to auto-detected command via `||`. Similarly `parsed.verify?.unit || testCmd || autoVerify.unit`. Lower-priority (tier auto-detect) silently wins over explicit file intent. Correct would be `??` with empty-string allowed.

## Concurrency Risks
- **Mutex is `mkdir .agent/state/.budget.mutex`, not PID file, but reaper deletes empty mutex dirs based on mtime**:
  ```js
  withVfsMutex: mkdirSync(mutexDir); fn(); rmdirSync
  reapStaleMutexDirs: if empty && mtime age >= ttlMs → rename→rmdir
  ```
  `mkdir` is atomic POSIX, so two simultaneous acquisitions within same filesystem timestamp resolution do NOT both succeed – second gets `EEXIST` and spin-waits. Timestamp collision question is moot for acquisition. The real bug is **reaper vs holder**: holder directory is empty for whole critical section. If holder is paused > `ttlMs` (default 30s, but `withVfsMutex` retries only 200*10ms=2s before `MutexTimeoutError`), reaper deletes it and second process enters concurrently. Then ledger chain is forked. `.budget.mutex` and `.telemetry.mutex` must be excluded from generic stale-dir reap or reaper must be PID-aware (read lockfile with pid+starttime).

- **Budget ledger hash-chain corruption under concurrent appends**:
  - Protected by `.budget.mutex`, so under correct mutex no corruption.
  - Corruption path 1: reaper-induced double entry – both processes read same `prevHash`, both append lines with same `prevHash`, second line's `prevHash != first's hash` → `verifyLedgerIntegrity` → `BROKEN_PREV_HASH`. Also `append` uses `openSync(..., "a")` + `writeSync` + `fsync`; atomic only if < `PIPE_BUF` (4096). Large envelope could tear, but typical entry ~500B, so likely atomic.
  - Corruption path 2: **readers without lock** – `scanBudgetWindow`, `checkDailyBudget`, `readLedger` read without `withVfsMutex`. They can see partial write in middle of `writeSync` (especially if process crashed between `writeSync` and `fsync`, leaving torn JSON). Parser skips unparseable line (`continue`), undercounting used budget → allows over-dispatch past quota.
  - `reserveBudgetAtomic` uses `Math.random()` for `reservationId`: `res-${now}-${Math.random()...}` – collision possible if two processes same ms, making release ambiguous (anonymous fallback via `releasedTimestamp` then needed).

- **Ceiling file race**: `recordObservedCeiling` does `writeAtomic` (temp+rename, atomic) but does NOT take `.budget.mutex`. Concurrent quota rejections → last writer wins, earlier observation lost. Ledger entry `budget_ceiling_observed` is mutex-protected, so audit trail keeps both, but cheap index file loses.

- **Journal orphan detection window where valid intent gets reaped**:
  - `journalIntent` appends + fsync, no mutex. `reapOrphanedIntents` reads whole file without lock – can miss tail entry written concurrently, thinking intent is done when it isn't, or vice versa.
  - `isPidAlive(pid, expectedStartTime)` does `process.kill(pid,0)`; if fails to read `/proc/pid/stat` (transient, permission, procfs unmounted) it returns `false` → live intent reaped. On Darwin uses `ps` which can fail.
  - Lock cleanup inside reap: `if lockContent.pid === intent.pid || files.includes(targetPath)` – if `intent.targetPath` matches a file used by a **different alive** task, condition 2 deletes alive lock. `isPidAlive` check for lock is done via `continue` before, but logic: `if lockPid && isAlive(lockPid) continue;` skips alive locks. However file-match deletion happens after that skip, so alive lock could still be deleted via file-path match if first condition short-circuits incorrectly? Code checks alive first then separate file match, so actually skips alive locks, safe for case 1. But case 2 still possible if lock has no pid or stale startTime.
  - Forked worker pattern: parent writes intent and dies quickly, child continues worktree mutation. Parent PID dead → reaper deletes worktree while child still writing.

- **PID lock `acquireLock` TOCTOU**: `existsSync` + read + `unlinkSync` stale → `openSync(wx)` atomic prevents two simultaneous acquires, but between stale check and `wx`, another process could create lock and be removed as stale by first process if first's stale check raced. Low probability but present.

## Coupling & Cohesion
- **Dispatch / Gate decoupling claimed but false**:
  - No module-level mutable singleton in `engine.mjs` itself (verified: no top-level `Map/Set`), but they share **global mutable filesystem**: `.agent/state/*`, git working tree, `~/.agent`/env.
  - More directly, `gate({fix:true})` → `repair()` → `withBudget(() => provider.dispatch(...))` → mutates working tree, then calls `gate()` again. So `gate` is not read-only; it dispatches. Dependency: `gate` → `repair` → `dispatch` (circular at call-graph level).
  - `probeDevServer` inside gate spawns detached process group in `root` cwd; parallel gate invocations compete for same port (3000) – second probe fails spuriously.

- **Repair loop interference with parallel gate()**:
  - Two CLI invocations both in OODA loop: both call `provider.dispatch` which edits same files. No file-level lock; patches interleave, causing lost updates, and `fingerprintFailureState` (stderr normalized + diff stats) diverges.
  - `OODACircuitBreaker` instance local to `repair`, but across processes no shared circuit breaker, so thrash detection doesn't prevent cross-process thrash. Each process may alternate strategy (`DIRECT_REPAIR` → `DIAGNOSTIC_ANALYSIS` → `MINIMAL_SIMPLIFICATION`) on same files, causing non-convergence.
  - Telemetry/event logs interleave via same mutex (`.telemetry.mutex`) – okay, but budget reservation across repairs: both reserve, one may hit `BudgetError`, other continues – inconsistent final state.

- **DAG Engine correctness**:
  - Kahn's implementation correct for diamond (inDegree accounting), isolated nodes (inDegree 0 → queue), self-loops (inDegree 1, never queued → `processed != total` → `DagCycleError` with path `[id,id]` found via DFS stackSet).
  - Bug: task depending on task not in current queue → `executeQueueDag` does `validDeps = dependsOn.filter(dep => taskMap.has(dep))`. Missing dep silently treated as satisfied, bypassing `validateDag` missing-dep throw. So typo or dependency on already-completed task results in out-of-order execution with no error/warning. Should be explicit policy: error, warn, or treat completed dir as satisfied.
  - Also `executeQueueDag` does `renameSync(src, dst)` after success without `withVfsMutex` – concurrent DAG runners could both attempt rename, second throws `EEXIST` → unhandled? Code checks `if (!existsSync(dstPath)) rename` so second silently leaves file in queue, leading to duplicate execution.

- **Config merge priority (env → file → tier) silent wins**:
  - `JULES_DAILY_BUDGET` / `JULES_MAX_DIFF_KB`: `Number(env)` then `!isNaN` check. Invalid env like `"abc"` → `NaN` → ignored, file value wins without warning. `Number(" ") == 0` → treated as legitimate 0 → dispatch nothing, unexpected.
  - `JULES_TIER`: `String(env || parsed.tier || "ultra").toLowerCase()` then `TIER_PRESETS[activeTier] || ultra` – unknown tier silently collapses to `ultra` (highest quota), which is permissive fail-open.
  - `limits` merging: `{...DEFAULTS, ...tierLimits, ...normalizedLimits, ...envOverrides}` correct order, but `provenance` for `concurrency` only tracks file vs tier, not env tier override, losing auditability.
  - Lower-priority auto-detection wins: `autoVerify` vs user empty-string as above.

## Recommendations (max 5, prioritized)
1. **Fix VFS mutex lifetime and exclude from mtime reaper**: Replace empty-dir lock with lockfile containing `{pid, starttime, nonce, heartbeat}` created `wx`; reaper deletes only if `isPidAlive` false OR heartbeat stale AND dir empty. Make `withVfsMutex` generic helper that writes heartbeat and uses `fsync`. Exclude `.budget.mutex` and `.telemetry.mutex` from `reapStaleMutexDirs` or make reaper PID-aware. Add tests for kill -STOP holding lock >30s.
2. **Make ledger/journal read-write mutex-consistent**: All scans (`scanBudgetWindow`, `readLedger`, journal tail read) should take same mutex or use `openSync` with shared lock / atomic rename pattern. Verify chain on read, not just skip corrupt lines; on `BROKEN_PREV_HASH` after fork, trigger recovery (truncate to last good). Use `crypto.randomUUID` for reservationId.
3. **Break `engine ↔ wizard-task` cycle and split gate/repair**: Extract `resolveRolePrompt` to `src/role-resolver.mjs` with no engine import. Split `gate` (pure verification, no dispatch, no state mutation) into `gate.mjs` and `repair` (dispatch+retry) into `repair-loop.mjs`. Make `gate` take explicit dependencies via opts, not import provider. Prevents circular, reduces fan-out.
4. **Shrink public API in `index.mjs`**: Replace flat re-exports with namespaced barrels (`export * as core`, `export * as state`, `export * as security`) or two entry points: `jules-orchestrator-kit/core` (programmatic) and `jules-orchestrator-kit/cli`. Add `eslint` rule banning `export { ... } from "./scripts/*"` in library entry. Document 10-symbol stable surface.
5. **Strict DAG dependency validation and config validation**: In `executeQueueDag`, if `dependsOn` contains id not in `taskMap` and not in `completed/`, throw `DagMissingDependencyError` instead of filter; add `--allow-external-deps` flag. In `loadConfig`, validate `JULES_TIER` against `VENDOR_TIERS+["enterprise"]`, warn on invalid; validate env numbers with `Number.isFinite` and throw on NaN when env var present but unparseable; change verify `||` to `??` so explicit `""` disables stage.
```

---

# AUDIT_DEAD_CODE

## Safe to Delete (zero impact)
Each: file or export, reason, estimated lines saved

**Constraint:** `test/api-surface.test.mjs` freezes **189** SDK exports. Removing any `index.mjs` export fails tests. Items below are *not* on that freeze list, not imported by production CLI/src, and not required by tests.

| Target | Reason | Est. lines |
|---|---|---|
| `PRIOR_ART.md` | Internal differentiation notes; **not** in `package.json` `"files"` (does not ship on npm); no code/import references. Stale claims (`src/mcp-server.mjs` does not exist; MCP is `src/mcp.mjs`). | 49 |
| `.agent/protected-paths.json` | Not copied by `bin/init.js`; not in npm `"files"`; no runtime reader. | 12 |
| `.agent/jules.yml` (kit copy) | Init **writes a generated** `.agent/jules.yml`; kit file is never copied. Not in npm `"files"`. | 13 |
| `.agent/SYSTEM_LEARNINGS.md` + `.agent/knowledge/learnings.json` | Runtime paths created by `src/memory.mjs` in the *consumer* repo. Kit copies are not init-scaffolded and not in npm `"files"`. | 17 |
| `.agent/jules-queue/README.md` | Init creates queue dirs but does not copy this README. Not in npm `"files"`. | 30 |
| `.agent/rules/jules-protocol.md` | Shipped via `"files": [".agent/rules/"]` but **init never copies it** (only `dynamic-guardrails.json`). Dead as scaffolding. | 36 |
| `scripts/jules-self-audit.mjs` `logAuditMetrics()` | Empty no-op; unused outside its file. | 1 |
| `bin/mcp-server.mjs` as a *duplicate entry* | 5-line wrapper of `startMcpServer()`; `agentctl mcp` already does the same. Keep one bin name, drop the extra file **only if** `package.json` `bin.jules-mcp` / `agentctl-mcp` are retargeted to `agentctl` (that *is* a packaging change). | 5 |

**Not safe despite looking dead:** SDK exports unused by CLI/tests-other-than-api-surface (`BUILTIN_PRESETS`, `CLAUDE_PRESET`, `CODEX_PRESET`, `JULES_PRESET`, `CheckpointError`, `TddError`, `IdeScaffoldError`, `GUARDRAIL_FOOTER`, `isolateMcpStdout`, `writeMcpFrame`, `freezeExecutionEnvelope`, `getLearningsPath`, `getSystemLearningsMdPath`, `readLedger`, `tierOptions`, `resolveVerify`, `withBudget`, `FALLBACK_TIER`, `VENDOR_TIERS`, `resolveRolePrompt`). Removing them **breaks** `api-surface` + public API.

---

## Consolidation Candidates (merge these)

**Dead / duplicate scripts** (npm scripts + `bin/init.js` copies *all* of `scripts/` except `release.mjs`; tests import several shims — cannot delete without test edits):

| File | Lines | Notes |
|---|---|---|
| `scripts/jules-create.mjs` | 28 | Shim; CLI is `agentctl task create` / `dispatch`. |
| `scripts/jules-nightly.mjs` | 13 | Shim → `worktreePrune`; `agentctl clean`. |
| `scripts/jules-patch.mjs` | 23 | Stub `fetchSessionPatch` always `{hasPatch:false}`; **tested** in `kit.test.mjs`. |
| `scripts/jules-queue-runner.mjs` | 24 | Shim → `engine.run`; `classifyQueueFailure` is an SDK export. |
| `scripts/jules-status.mjs` | 51 | Shim; `categorizeTaskStatus` **tested**; CLI `agentctl status` is the real impl. |
| `scripts/jules-scan-todos.mjs` | 48 | CLI `scan` still imports this — **inline into** `src/` or `agentctl`. |
| `scripts/asset-integrity-check.mjs` | 35 | Thin CLI over `checkAssetIntegrity`. |
| `scripts/stale-base-check.mjs` | 26 | Thin git wrapper. |
| `scripts/risk-tier.mjs` | 29 | Thin `classifyRiskTier` wrapper. |
| `scripts/rules-lint.mjs` | 20 | Thin `checkRulesBudget` wrapper. |
| `scripts/validate-envelope.mjs` | 44 | Thin `validateEnvelope` wrapper. |
| `scripts/run-tests.mjs` | 19 | `node --test test/*.test.mjs` — keep as npm `test` or inline in package.json. |
| `scripts/jules-dispatch.mjs` | 135 | Deprecated shim **plus** SDK (`getDynamicGuardrails`, `dispatchTask`) and kit tests. |
| `scripts/jules-self-audit.mjs` | 168 | `runPreflightSandbox` always `{ok:true}`; `runSelfAudit` ≈ `gate()`. |
| `scripts/command-resolver.mjs` | 106 | Used by `bin/init.js` + SDK `resolveProjectCommands` — overlap with `src/config.mjs` / `stack-detector.mjs`. |

**Merge modules (single production caller, or always used as a pair):**

| Merge | Into | Why | Est. |
|---|---|---|---|
| `src/merge-verify.mjs` (63) | `src/merge-blocks.mjs` | Only used together in merge tests; **zero** CLI/engine import. | ~5 net after merge |
| `src/mcp-progress.mjs` (158) | `src/mcp.mjs` | Sole importer is `mcp.mjs`. | ~10 |
| `src/ops/receipts.mjs` (171) | `src/ops/transaction.mjs` | Sole importer. | ~10 |
| `src/ops/evidence-actions.mjs` (74) | `src/evidence.mjs` or agentctl evidence case | Thin plan wrappers around evidence API. | ~40 |
| `src/router.mjs` (205) | `src/engine.mjs` | Sole production importer is engine. | ~20 |
| `src/review-repair.mjs` (53) | `bin/agentctl.mjs` review-repair case | Dynamic-imported only from CLI. | ~10 |
| `bin/init.js` (359) vs `src/wizard-init.mjs` (318) | One onboarding path | Two init implementations (`jules-init` vs `agentctl init`). | **~250** if one is deleted |
| `src/tui.mjs` vs `src/ux/*` | One TUI layer | Wizards use `tui.mjs`; `ux/{palette,widgets,diff-viewer,log-viewer,queue-model,swarm-model}` are **test-only** (never mounted by CLI). | see Over-Engineering |

**Files > 500 lines (split by responsibility, not delete):**

| File | Lines | Split suggestion |
|---|---|---|
| `bin/agentctl.mjs` | 1288 | Command modules already exist under `src/ops/`; CLI is a giant switch. |
| `src/engine.mjs` | 1081 | `gate` / `dispatch` / `run` / `probeDevServer` / `synthesizePrDescription`. |
| `src/stack-detector.mjs` | 682 | Polyglot vs workspace-boundary vs circular-deps. |
| `src/webhook.mjs` | 650 | HMAC server vs silence-governor digest. |
| `src/state.mjs` | 647 | Ledger vs mutex vs queue paths. |
| `src/mcp.mjs` | 572 | Protocol loop vs tool handlers. |
| `src/security.mjs` | 553 | Entropy/redact vs scope/diff vs edge/cross-package. |
| `src/provider.mjs` | 532 | Presets vs HTTP vs failover. |
| `src/dag-engine.mjs` | 526 | Graph vs `executeQueueDag`. |
| `src/ops/doctor-registry.mjs` | 524 | Fine as-is; **planner is unused by CLI**. |

---

## Over-Engineering (simplify these)

1. **Action-plan / transaction TUI that CLI never runs**  
   `doctor-planner`, `task-actions`, `swarm-actions`, `transaction`+`receipts`, `ux/{palette,widgets,diff-viewer,log-viewer,queue-model,swarm-model,renderer,layout,capabilities}` — only tests (`ops.test.mjs`, `ux.test.mjs`, `queue-swarm.test.mjs`, `palette.test.mjs`). `agentctl doctor` calls `runDoctorChecks` and **never** `planDiagnosticFixes`.  
   ~**2,800** lines of unmounted product surface (cannot remove without dropping those tests).

2. **v0.9 shims as public SDK** (`index.mjs` “Legacy SDK shims”): `resolveProjectCommands`, `runSelfAudit`, `runPreflightSandbox`, `scanCodebaseForTodos`, `runScanner`, `getDynamicGuardrails`, `dispatchTask`, `classifyQueueFailure`, `extractPrUrls`, `auditSessions`, `buildSyncManifest`, `pushReservationManifest`. Historical npm compatibility; duplicates `engine`/`git`/`security`.

3. **No-op “strategies”:**  
   - `runPreflightSandbox()` → `{ ok: true }`  
   - `runPreflightStaticCheck()` → `"PASSED"`  
   - `fetchSessionPatch()` → fake COMPLETED empty diff  
   - `logAuditMetrics()` empty  

4. **Factory always wrapping the same thing:** `createFailoverProvider` is real (router + tests), but default `providers = ["jules"]` is a 1-element “failover”. Provider presets `JULES_PRESET` / `CLAUDE_PRESET` / `CODEX_PRESET` are SDK-only.

5. **`execution_envelope.mjs`:** `createExecutionEnvelope` always `freezeExecutionEnvelope`s; `freezeExecutionEnvelope` is a public export with no other caller. Envelope is **not** used by `engine.dispatch` (tests + SECURITY.md only).

6. **Config nobody changes:** `router.enabled` (docs: opt-in/default off); digest constants `DEFAULT_CRITICAL_REASONS`, `DIGEST_BATCH_LIMIT`; `CEILING_FILE`; `ROLLING_WINDOW_MS` — exported for SDK freeze more than operators.

7. **`src/dashboard.mjs` binds `127.0.0.1`** — fine locally; dead weight if dashboard is unused in CI.

8. **Init copies entire `scripts/` into consumer repos** — ships shims into every `jules-init` user (~1.7k lines of scripts). Init `package.json` inject already points at `agentctl *`.

---

## Total estimated lines removable: ___

| Bucket | Lines | Breaks tests/API? |
|---|---|---|
| True zero-impact (PRIOR_ART + unused kit `.agent` artifacts + empty `logAuditMetrics`) | **~160** | No |
| Inline thin `scripts/*` wrappers (keep behavior via agentctl/npm) | **~280** | No if package.json scripts retargeted; init copy list must change |
| Drop duplicate init path (`bin/init.js` **or** wizard-init) | **~250** | Possibly `jules-init` bin contract |
| Unmount unused UX/action-plan layer | **~2,800** | **Yes** (ux/ops/queue-swarm/palette tests) |
| Trim legacy SDK shims from `index.mjs` | **~400** (script bodies still needed until tests drop) | **Yes** (`api-surface` 189 lock) |

**Removable without breaking public API or tests: ~160–440 lines (~1–2% of ~20k JS).**  
**20% (~4k lines) is only reachable by deleting the unmounted TUI/action-plan stack *and* shrinking `api-surface` — which violates the freeze.** Prefer: stop init from copying shims; stop exporting no-ops; do not grow `ux/` until CLI mounts it.

---

# AUDIT_TESTS

## False Confidence (tests that pass but prove nothing)

- **`test/telemetry-mcp-stream.test.mjs:131` — `ProgressBus handles stream backpressure safety and awaits drain`**
  - **What's wrong:** Ends with `assert.ok(drainFired || true)`, which is unconditionally true. The test passes even if backpressure and `drain` handling are completely broken.
  - **Assert instead:** `assert.strictEqual(drainFired, true)` and verify that the queued MCP frame is emitted only after the writable stream drains.

- **`test/telemetry-mcp-stream.test.mjs:85` — `ProgressBus coalesces rapid progress calls within 150ms window (latest-wins)`**
  - **What's wrong:** Checks `progressFrames.length >= 2`, the first message, and the last message. It still passes if all three messages—including the supposedly coalesced `"Step 2"`—are emitted.
  - **Assert instead:** Exactly two frames with messages `["Step 1", "Step 3"]`, and explicitly assert that no frame contains `"Step 2"`.

- **`test/engine.test.mjs:10` — `gate passes clean repository verification`**
  - **What's wrong:** Only verifies that `res.ok` is a boolean and `res.phases` is an array. A failed gate (`ok: false`) satisfies both assertions.
  - **Assert instead:** Use an isolated clean Git fixture and assert `res.ok === true`, `res.code === 0`, exact successful phases, and successful verification output.

- **`test/api-surface.test.mjs:257` — `verifies CLI exit code contract covers 0 through 8 continuously`**
  - **What's wrong:** `EXIT_CODE_CONTRACT` is declared inside the test file. The test proves that its own fixture contains keys 0–8; it is not connected to CLI error handling or a production exit-code registry.
  - **Assert instead:** Import a production exit-code registry, or exercise each CLI failure path and assert the actual process exit code.

- **`test/kit.test.mjs:329` — `rejects malicious BASE_BRANCH values`**
  - **What's wrong:** Defines `SAFE_BRANCH` locally and tests that local regex. No production branch-validation function is called.
  - **Assert instead:** Call the validator or CLI argument parser used by dispatch/merge code and assert rejection, error type/code, and that no shell command executes.

- **`test/kit.test.mjs:339` — `rejects malicious package names in workspace filter`**
  - **What's wrong:** Defines and tests a local `SAFE_PKG_NAME` regex rather than production workspace-filter validation.
  - **Assert instead:** Pass malicious names through the real command-building path and assert rejection before process execution.

- **`test/kit.test.mjs:209` — `verifies ledger SHA-256 hash chain integrity`**
  - **What's wrong:** The fixture contains ordinary JSON objects with no `prevHash` or `hash`. It calls `scripts/utils.mjs::verifyLedgerIntegrity`, which only parses JSON and returns the literal `"sha256-verified"`; valid-JSON tampering would pass.
  - **Assert instead:** Seed correctly chained entries, mutate a payload while retaining valid JSON, and assert a specific integrity error such as `CORRUPTED_ENTRY_HASH` or `BROKEN_PREV_HASH`.

- **`test/kit.test.mjs:258` — `reserves daily budget and respects maximum session limits`**
  - **What's wrong:** Makes one reservation against a limit of 300 and only checks `used >= 1`. It never approaches or exceeds the maximum.
  - **Assert instead:** Assert the first reservation yields `used === 1`, fill a small limit exactly, then assert the next reservation throws `BudgetError` with code 7 and leaves the ledger unchanged.

- **`test/kit.test.mjs:264` — `counts only budget_reserved events, avoiding double-counting with session_dispatched`**
  - **What's wrong:** Never appends a `session_dispatched` event. It merely makes another reservation and checks that usage increased by at least one.
  - **Assert instead:** Append one reservation plus one `session_dispatched` event and assert usage increases by exactly one.

- **`test/kit.test.mjs:271` — `an isolated root never touches the repository ledger`**
  - **What's wrong:** Only confirms that a ledger exists under the temporary root. It never snapshots or inspects the repository’s real `.agent/state` directory. It also depends on an earlier test having created that temporary ledger.
  - **Assert instead:** Run independently, snapshot the real state directory before and after, and assert it is byte-for-byte unchanged while the isolated root receives the expected ledger.

- **`test/kernel-hardening.test.mjs:97` — `20 concurrent reservation calls ... exactly 3 successes and 17 rejections`**
  - **What's wrong:** Twenty `setImmediate` callbacks invoke a synchronous function on one JavaScript thread. The calls do not overlap at the filesystem level, so this does not exercise the cross-process mutex or atomic-create race the test claims to cover.
  - **Assert instead:** Start synchronized worker processes or worker threads against one temporary root, release them with a barrier, and assert exactly three reservations, an intact hash chain, no torn writes, and no orphaned mutex.

- **`test/v1-readiness.test.mjs:33` — `Queue runner actually dispatches task before completing`**
  - **What's wrong:** Calls `run({ dryRun: true })`; no provider dispatch occurs. A synthetic dry-run session can pass while live dispatch is broken.
  - **Assert instead:** Inject a provider spy, run with `dryRun: false`, assert the spy was called exactly once with the expected task, then assert the task was moved only after the provider succeeded.

- **`test/evidence.test.mjs:85` — `writeEvidenceManifest and loadEvidenceManifest serialize and verify cryptographic signature`**
  - **What's wrong:** Only writes, reloads, and compares the stored hash string. It never invokes verification or recomputes the signature.
  - **Assert instead:** Call `verifyEvidenceManifest`, tamper with otherwise valid JSON, and assert verification fails for the expected cryptographic reason.

- **`test/adversarial-claims.test.mjs:160` — `75 KB diff payload governor`**
  - **What's wrong:** Uses a 2 KB file with a custom 1 KB limit, not a diff over the production 75 KB boundary. It asserts `payload.ok === payload.bytes <= payload.limitBytes`, so mutually wrong `bytes` and `ok` values can agree and pass.
  - **Assert instead:** Test 75 KB minus one byte, exactly 75 KB, and greater than 75 KB using UTF-8 byte counts; assert exact gate outcomes and exit code 5.

- **`test/telemetry-mcp-stream.test.mjs:31` — `1000 ... calls execute with O(1) steady-state`**
  - **What's wrong:** One elapsed-time threshold cannot establish O(1) complexity and is machine-load dependent.
  - **Assert instead:** Instrument file reads/scans or compare work at N and 2N with a bounded ratio, while testing integrity separately from performance.

- **`test/git.test.mjs:197` — `worktreeRemove and worktreePrune helpers`**
  - **What's wrong:** After calling both helpers, it only asserts that `worktreePrune` returned a string. A no-op `worktreeRemove` would pass.
  - **Assert instead:** Assert the worktree directory is gone, `git worktree list --porcelain` no longer contains it, and stale metadata is absent after pruning.

- **`test/kit.test.mjs:835` — `runPreflightStaticCheck handles clean and missing scripts gracefully`**
  - **What's wrong:** Calls the function once against the real repository and only checks `typeof result === "string"`. There is no missing-script fixture and no semantic assertion.
  - **Assert instead:** Use separate clean and missing-script temporary projects and assert exact diagnostics/status for both.

- **`test/risk.test.mjs:28` — `classifies security, auth, migration, or workflow paths as R3 Restricted`**
  - **What's wrong:** Tests only an auth path and a workflow path. It never supplies a security or migration path; later in the file `src/security.mjs` is explicitly expected to be R2.
  - **Assert instead:** Split the cases and assert representative security, auth, migration, and workflow paths individually, resolving the contradictory `src/security.mjs` expectation.

- **`test/mcp.test.mjs:77` — `executes record_system_learning tool call`**
  - **What's wrong:** Only asserts `{ok: true}`. It does not verify `recorded`, deduplication, persisted JSON/Markdown content, sanitization, or the target root.
  - **Assert instead:** Supply a temporary root, assert exact persisted records and Markdown, call twice to verify deduplication, and verify the repository `.agent` directory is untouched.

- **`test/mcp.test.mjs:103` — `runs startMcpServer stdio stream loop`**
  - **What's wrong:** Sleeps for 50 ms and regex-matches a substring. It does not parse an exact frame, verify there is only one frame, or test malformed/split/oversized frames.
  - **Assert instead:** Await stream output deterministically, split and parse every frame, and deep-compare the exact JSON-RPC response.

- **Weak truthiness assertions**
  - **`test/config.test.mjs:87` — `handles null or undefined root parameter in loadConfig()`** uses `assert.ok(cfg.version)`; assert `version === 1` and the complete default contract.
  - **`test/web-templates.test.mjs:134` — `planTaskCreate incorporates web template...`** uses `assert.ok(plan.ok)`; assert `plan.ok === true` plus exact template ID and verification command.
  - **`test/v027-features.test.mjs:55` — dashboard endpoint test** uses `assert.ok(statusJson.version)`; assert equality with `KIT_VERSION`.
  - **`test/checkpoint.test.mjs:32` — checkpoint metadata** only checks truthy `headSha`; assert a 40-character SHA, exact clean-file list, and persisted checkpoint contents.
  - **`test/kit.test.mjs:613` — `ensureDir throws an Error...`** accepts any `Error`, so an unrelated failure passes; assert the expected error type/code/message for the invalid path.

## Missing Coverage (untested modules/functions)

### Module-to-test inventory

- There are **60 modules under `src/`**. Every module is referenced somewhere in `test/`, so there is no wholly unreferenced module.
- Only **30/60** have a basename-aligned `test/<module>.test.mjs`. The following 30 are hidden in combined or unrelated test files, weakening ownership and coverage traceability:
  - `src/asset_integrity.mjs`
  - `src/dashboard.mjs`
  - `src/journal.mjs`
  - `src/mcp-progress.mjs`
  - `src/memory.mjs`
  - `src/merge-verify.mjs`
  - `src/preload-net-guard.mjs`
  - `src/provider.mjs`
  - `src/review-repair.mjs`
  - `src/state.mjs`
  - `src/telemetry.mjs`
  - `src/version.mjs`
  - `src/ops/command-registry.mjs`
  - `src/ops/doctor-planner.mjs`
  - `src/ops/doctor-registry.mjs`
  - `src/ops/evidence-actions.mjs`
  - `src/ops/receipts.mjs`
  - `src/ops/swarm-actions.mjs`
  - `src/ops/task-actions.mjs`
  - `src/ops/transaction.mjs`
  - `src/ux/capabilities.mjs`
  - `src/ux/diff-viewer.mjs`
  - `src/ux/key-decoder.mjs`
  - `src/ux/layout.mjs`
  - `src/ux/log-viewer.mjs`
  - `src/ux/queue-model.mjs`
  - `src/ux/renderer.mjs`
  - `src/ux/swarm-model.mjs`
  - `src/ux/terminal-session.mjs`
  - `src/ux/widgets.mjs`

### Exported APIs with no direct behavioral test

These names are either absent from tests or appear only as strings in the API-surface snapshot. Some execute transitively, but their own error and boundary contracts are unasserted.

- **`src/config.mjs`:** `ConfigError`, `dedupe`, `resolveVerify`.
- **`src/dashboard.mjs`:** `getDashboardHtml`, `startDashboardServer`.
- **`src/engine.mjs`:** `pollSessionState`; no direct dispatch test for `isConcurrencyGroupLocked`.
- **`src/envelope.mjs`:** `parseEnvelopeHeader`.
- **`src/evidence.mjs`:** `findFilesRecursively`, `getGitProvenance`.
- **`src/execution_envelope.mjs`:** `freezeExecutionEnvelope` is only indirectly exercised.
- **`src/git.mjs`:** `ensureBaseFetched`, including missing remote, fetch failure, and malicious ref handling.
- **`src/mcp.mjs`:** `McpFrameDecoder`, `isolateMcpStdout`, and `writeMcpFrame` have no direct boundary tests. Content-Length framing, chunk-split headers, malformed JSON, multiple frames per chunk, and the 4 MB ceiling are untested.
- **`src/memory.mjs`:** `getLearningsPath`, `getSystemLearningsMdPath`.
- **`src/provider.mjs`:** shipped Jules/Claude/Codex/Gemini preset contracts are not behaviorally verified; only some names are snapshot strings.
- **`src/security.mjs`:** `safeAtomicWrite`, `isForbiddenPath`.
- **`src/stack-detector.mjs`:** `generateSmokeTestScript` and `detectEdgeRuntime` are only exercised transitively.
- **`src/state.mjs`:** `readLedger`, `withBudget`, `lockStatus`, `isConcurrencyGroupLocked`.
- **`src/telemetry.mjs`:** `readTelemetry` is only reached through MCP; segment rollover at `MAX_TELEMETRY_SEGMENT_BYTES` is untested.
- **`src/webhook.mjs`:** `getDigestFilePath`, `getInterruptionLedgerPath`, `saveEscalationDigest`, `loadInterruptionLedger`.
- **`src/ops/checkpoint.mjs`:** `getCheckpointDir`.
- **`src/ux/layout.mjs`:** `stripAnsi`.
- **`src/ux/renderer.mjs`:** `encodeAnsiStyle`, `renderLineToAnsi`.
- **`src/ux/widgets.mjs`:** `renderListLines`.

### Critical edge-case gaps

- **Empty/null/undefined inputs**
  - No systematic coverage for null tasks/options in `dispatch`, `run`, `gate`, `classifyTaskComplexity`, or `resolveRoutedProvider`.
  - No empty-provider-list or null-provider coverage for `createFailoverProvider`.
  - No null/malformed request coverage for `handleMcpRequest` or direct `McpFrameDecoder` use.
  - `verifySignature` checks invalid headers but not null payload or null/empty secret.
  - `routeWebhookEvent` lacks null payload/handlers and throwing primary-handler cases.
  - `parseEnvelopeHeader` lacks empty, malformed, duplicate, and oversized envelope headers.
  - Lock and journal functions lack empty task IDs, empty file lists, null roots, invalid lock JSON, and ownership mismatch tests.
  - Evidence loading lacks corrupt JSON, traversal IDs, missing manifests, symlinks, and unreadable files.

- **Unicode**
  - Existing Unicode tests cover terminal widths, hidden controls, one emoji diff, and a malformed HMAC header.
  - There is no Unicode filesystem coverage for config, Git, scope, evidence, checkpoint, queue, task, or workspace paths.
  - There is no normal Unicode-preservation test for prompts/config values such as accented text, CJK, RTL text, combining characters, or emoji.
  - MCP Content-Length framing is not tested with multibyte UTF-8 payloads split across chunks.

- **Long payloads**
  - No prompt larger than 50 KB is sent through dispatch, task planning, optimization, or MCP.
  - No default-limit diff larger than 75 KB is sent through the gate.
  - No exact-boundary tests exist for either prompt or diff limits.
  - MCP’s 4 MB frame limit and telemetry segment-size rollover are not tested.

- **Concurrency and locking**
  - No cross-process acquisition race for `withVfsMutex`, `reserveBudgetAtomic`, or `acquireLock`.
  - No simultaneous acquire/release, stale-lock reaping during acquisition, owner/nonce mismatch, crash while holding a mutex, or torn-write recovery.
  - No concurrent `writeMcpFrame` test despite module-global `isAuthorizedMcpWrite`.
  - No queue concurrency-group test proving that two tasks in the same group cannot dispatch together while unrelated groups can.

- **Provider and server failure paths**
  - Dashboard startup failure, bind failure, shutdown behavior, and malformed REST requests are untested.
  - Failover coverage does not exhaust all providers or verify behavior for non-rate-limit primary failures.
  - `probeDevServer` lacks a reliable test that the configured child command itself starts the server successfully.

## Fragile Tests (environment-dependent)

### Shared and repository-local mutable state

- **Tests writing under the real checkout’s `.agent/` instead of OS temp directories**
  - `test/execution_envelope.test.mjs`: `.agent/test-state-*`, `.agent/test-budget-*`.
  - `test/kernel-hardening.test.mjs`: `.agent/test-mutex-timeout-*`, `.agent/test-stale-lock-*`, `.agent/test-concurrent-budget-*`.
  - `test/ooda_thrash.test.mjs`: `.agent/test-ooda-*`.
  - `test/remediation.test.mjs`: module-scoped `.agent/test-remediation-*`.
  - These directories are normally removed, but cleanup errors are swallowed; interrupted or crashed runs leave repository state behind.

- **`test/kit.test.mjs:765` — `checkSafetyGate detects active worker lock files`**
  - Writes the fixed path `.agent/state/locks/test-lock.json` in the real repository, then deletes it.
  - A real file with that name would be overwritten and destroyed; concurrent workers can also observe the fake lock.

- **`test/mcp.test.mjs:77` — `record_system_learning`**
  - Calls `handleMcpRequest` without an isolated root, causing `recordLearning` to rewrite real `.agent/knowledge/learnings.json` and `.agent/SYSTEM_LEARNINGS.md`, even for duplicates.

- **`test/mcp.test.mjs` and `test/prompt-guard.test.mjs` — `startMcpServer`**
  - Called without `opts.root`, so startup reapers inspect and may mutate the checkout’s real `.agent/state`.
  - `startMcpServer` also permanently replaces `process.stdout.write` with a non-configurable wrapper for the remainder of that test process. There is no restoration hook.

- **Environment leakage**
  - `test/p0-remediation.test.mjs` tests `defaults startingBranch...` and `omits sourceContext...` set `JULES_API_KEY` without restoring it.
  - `throws error when repository source is missing...` restores `JULES_API_KEY` only when the previous value was truthy; an originally absent value becomes `"test-key"`.
  - `test/kit.test.mjs`’s `TEST_SECRET_KEY` test does not preserve a pre-existing value and has no `finally`.
  - `loadEnv` tests delete potentially pre-existing `TEST_JULES_KIT_VAR` and `ANOTHER_VAR` rather than restoring them.

### Order-dependent tests

- **`test/asset-integrity.test.mjs`**
  - Both subtests share one directory and clean it only after the parent completes.
  - If `detects corrupted asset...` runs before `passes clean binary asset headers`, the fake corrupt font remains and makes the clean test fail.

- **`test/kit.test.mjs` — `Atomic Budget Reservation & Ledger Check`**
  - Three tests share one `budgetRoot`.
  - `an isolated root never touches the repository ledger` expects a ledger created by preceding tests and fails if shuffled to the front.

### Real repository structure dependencies

- `test/config.test.mjs` expects `process.cwd()` to be this npm repository and its test command to be exactly `npm test`.
- `test/engine.test.mjs` runs `gate` against the checkout and hardcodes base branch `main`.
- `test/edge-fixes.test.mjs` resolves the checkout’s real `HEAD`; execution-envelope tests similarly rely on the real Git repository.
- `test/task-optimizer.test.mjs` depends on the actual presence of `src/security.mjs` to suggest it for `src/security.js`.
- `test/web-templates.test.mjs` reads `src/web-templates.mjs` source text directly.
- `test/egress-allowlist.test.mjs` scans the current `src/`, `bin/`, `scripts/`, `index.mjs`, and `package.json` layout.
- `test/kit.test.mjs` reads real `package.json`, `.agent/rules/dynamic-guardrails.json`, `.agent/prompts/*`, and executes real repository scripts.
- MCP status/template tests use `process.cwd()` and therefore see real queue, lock, budget, and config state.

These may be intentional contract tests, but they should be separated from unit tests and run from a controlled copied fixture.

### Real child processes and shell/Git dependencies

The following tests spawn actual Node, shell, or Git processes rather than injecting an executor:

- `test/adversarial-claims.test.mjs`
- `test/checkpoint.test.mjs`
- `test/edge-fixes.test.mjs`
- `test/engine.test.mjs`
- `test/flaky-ledger.test.mjs`
- `test/git.test.mjs`
- `test/integration.test.mjs`
- `test/kit.test.mjs`
- `test/mcp.test.mjs`
- `test/net-guard.test.mjs`
- `test/next-step.test.mjs`
- `test/p0-remediation.test.mjs`
- `test/server-probe.test.mjs`
- `test/tdd-generator.test.mjs`
- `test/tiered-verification.test.mjs`
- `test/v1-readiness.test.mjs`
- `test/wizard-oracle.test.mjs`
- `test/wizard-task.test.mjs`

Consequences include dependence on Git availability/version, shell quoting, executable lookup for `"node"` rather than `process.execPath`, process-kill semantics, and CI sandbox policy. The true integration tests should be labeled and isolated; unit tests should inject process/network adapters.

### Timing, ports, and platform assumptions

- `test/server-probe.test.mjs` uses hardcoded port `59999` as “unused”; another process can own it.
- Its healthy/panic tests start a parent HTTP server and give `probeDevServer` a child command that tries to bind the same port. Whether the child reports `EADDRINUSE` before the existing server is fetched is a race.
- TUI tests depend on 10 ms timers; wizard-init uses fixed 400–1200 ms keystroke timers; MCP tests sleep 50 ms; progress coalescing sleeps 100 ms.
- Provider timeout tests require completion under 3 seconds, telemetry under 6 seconds, and secret scanning under 5 seconds. Loaded CI can fail despite correct behavior.
- Several tests derive filenames with `new Date().toISOString().split("T")[0]` after an operation. A UTC-midnight transition can make them inspect the wrong ledger/head file.
- `test/kernel-hardening.test.mjs`’s stale PID test wraps all meaningful assertions in Linux/macOS conditionals. On Windows the test can pass with no behavioral assertion.
- `test/journal-reaper.test.mjs` assumes PID `999999` is dead.
- `test/kit.test.mjs` hardcodes `/tmp/custom-jules-cache`.
- Tests use Unix-flavored commands and quoting such as `true`, `/bin/sh` behavior, chained `&&`, and single-quoted `node -e` snippets.
- Several HTTP servers call `server.close()` without awaiting completion. `test/v027-features.test.mjs` does not place server shutdown in `finally`, so an assertion failure can leave the server open.

## Naming & Structure Issues

- **Vague names**
  - `test/web-templates.test.mjs` — `synthesizeWebEnvelope works for ...`: “works” does not identify each template’s required behavior; five template contracts are bundled into one test.
  - `test/ux.test.mjs` — `handles chunk boundary split sequences`: should name the split escape sequence and expected `page-up` event.
  - `test/provider-hardening.test.mjs` — `HTTP date Retry-After parsing helper test`: describes a helper/test rather than behavior; use a name such as “converts a future HTTP-date Retry-After value to milliseconds.”
  - `test/git.test.mjs` — `worktreeRemove and worktreePrune helpers`: names implementation functions without stating observable removal/pruning behavior.
  - Repeated “correctly”/“gracefully” names in `kit.test.mjs`, `edge-fixes.test.mjs`, `ooda_thrash.test.mjs`, and `mcp.test.mjs` obscure the concrete outcome and error contract.

- **Implementation- and release-oriented names**
  - Parent names such as `src/git.mjs Unit Tests`, `src/ux/*.mjs`, `P0-01`, `P0-04`, `v0.27 features`, `v1.0.0 readiness`, and `Kernel Integration Fixes` organize tests by file or release history rather than stable behavior.
  - `adversarial-claims.test.mjs` prefixes cases with `HOLDS`/`SOUND`; these labels state a conclusion instead of describing the input and expected result.

- **Oversized mixed-purpose files**
  - `test/kit.test.mjs` is about 849 lines with roughly 85 test calls spanning command resolution, security, budgets, CLI initialization, cache handling, swarm merge behavior, prompts, and status categorization.
  - `test/budget.test.mjs` mixes `src/budget.mjs`, `src/state.mjs`, engine dispatch, and script utilities.
  - `test/ux.test.mjs` combines ten UX modules.
  - `test/p0-remediation.test.mjs` combines provider, prompt, Git, gate, queue, shell, and config behavior.
  - These files make module coverage difficult to trace and encourage shared fixtures/order dependencies.

- **Test-file naming mismatch**
  - Exactly half of `src/` lacks a basename-aligned test file. Although combined files provide incidental coverage, failures cannot be mapped reliably from module to test owner.
  - `asset_integrity.mjs` versus `asset-integrity.test.mjs` also introduces avoidable underscore/hyphen inconsistency.

- **Assertions and names disagree**
  - “passes clean repository verification” allows failure.
  - “actually dispatches” uses dry-run.
  - “verifies cryptographic signature” only reloads stored data.
  - “respects maximum session limits” never reaches the limit.
  - “never touches the repository ledger” never inspects it.
  - “handles clean and missing scripts” supplies only the real, non-missing repository.
  - “security, auth, migration, or workflow” tests only auth and workflow.
  
  ---
  
  # AUDIT_DOCS

## Factually Wrong (docs contradict code)

### README.md

- **README.md, Core Capabilities (~L134)** — Says **“555 unit tests across 81 suites passing in < 10.0s”**.  
  **Actual:** `test/` has **61** `*.test.mjs` files. Nested `test(` counts are on the order of ~180–400 assertions/cases, not 555/81. Same claim is repeated in **CHANGELOG.md [0.38.0]** (~L10).  
  **Proof:** `ls test/*.test.mjs` → 61 files; `package.json` `"test": "node scripts/run-tests.mjs"`.

- **README.md, CLI table (~L149)** — `agentctl doctor [--interactive] [--fix safe]`.  
  **Actual:** `doctor` only parses `--json` / `-j`. No `--interactive`, no `--fix`. Failures exit `1` if `report.summary.fail > 0`.  
  **Proof:** `bin/agentctl.mjs` ~L455–509.

- **README.md, CLI table (~L150–151)** — `queue [--interactive] [--dag] [--concurrency <n>]` and `swarm [--interactive] [--json]`.  
  **Actual:** `queue` supports `--dag`, `--concurrency`, `--dry-run`, `--json` only. `swarm` takes **no flags**; concurrency is `config.limits.concurrency || 3`.  
  **Proof:** `bin/agentctl.mjs` ~L331–376.

- **README.md, config example (~L208)** — `limits.concurrency: 15` with comment **“Worker slots (pro: 15, ultra: 60)”**.  
  **Actual:** those numbers are **ceilings** (`maxConcurrency`), not defaults. `TIER_PRESETS`: free `concurrency: 3 / max 3`, pro `8 / 15`, ultra `15 / 60`. Schema default in `DEFAULTS.limits.concurrency` is **1**.  
  **Proof:** `src/config.mjs` L16–27, L347–381.

- **README.md, SDK (~L288–296)** — `import { resolveRoutedProvider, loadConfig } from "jules-orchestrator-kit"`.  
  **Actual:** `index.mjs` exports `createFailoverProvider` but **does not export `resolveRoutedProvider`** (it lives in `src/router.mjs` and is used internally by `dispatch()`).  
  **Proof:** `index.mjs` L19–32 vs `src/router.mjs` L188; `src/engine.mjs` L701.

- **README.md, ecosystems (~L232–250)** — Lists **Python / FastAPI / Django** as if FastAPI is a detected stack; lists **Dockerfile** as a first-class detector.  
  **Actual:** stacks are `django` (`manage.py`) and generic `python` (`pyproject.toml` / `requirements.txt` / `setup.py`). **No FastAPI detector.** Devcontainers/compose are **container overlays**, not a `stack` value; **no `Dockerfile` trigger**.  
  **Proof:** `src/stack-detector.mjs` L66–255, L183–189.

- **README.md, Overview (~L100–101)** — Implies the kit **executes verification and auto-retries then approves PRs**.  
  **Actual:** `dispatch()` does **not** run the gate or open PRs. Jules HTTP provider sets `automationMode: "AUTO_CREATE_PR"` **only if** `task.autoPr` / `ctx.autoPr` (`--auto-pr`). OODA is `gate({ fix: true })`.  
  **Proof:** `src/engine.mjs` L693+; `src/provider.mjs` L251–257; `docs/architecture.md` L7–9, L264–270.

### EXAMPLES.md

- **EXAMPLES.md, Pattern 3 (~L82, L104–107)** — “isolated git worktrees”; `JULES_SWARM_CONCURRENCY=2 agentctl swarm`; `agentctl merge-swarm`.  
  **Actual:**
  - Nothing runs `git worktree add` (`docs/architecture.md` L267; `src/git.mjs` only prune/remove).
  - `JULES_SWARM_CONCURRENCY` is **never read** in source (only appears in this doc). Swarm uses `config.limits.concurrency`.
  - **No `merge-swarm` command** in `bin/agentctl.mjs`. Merge lives at `scripts/jules-merge-swarm.mjs` / `npm run jules:merge-swarm`.  
  **Proof:** `bin/agentctl.mjs` L355–376 (swarm), switch `default` L1277; `package.json` scripts.

- **EXAMPLES.md, Pattern 2 (~L74)** — `npx jules-orchestrator-kit gate --base ${{ github.event.pull_request.base.ref || 'main' }}`.  
  **Mostly true** (`--base` exists). Workflow **filename** `.github/workflows/jules-pr-gate.yml` is an example only; shipped workflow is `.github/workflows/jules-audit.yml` (not itself a contradiction of the CLI).

### AGENTS.md

- **AGENTS.md, Dynamic Command Resolution (~L35–41)** — `pyproject.toml` → `buildCmd: ""`.  
  **Actual:** `detectPolyglotStack` returns `buildCmd: "python3 -m compileall -q ."` for python. `command-resolver.mjs` re-exports that.  
  **Proof:** `src/stack-detector.mjs` L187–189; `scripts/command-resolver.mjs` L50–66.

- **AGENTS.md, Dynamic Command Resolution (~L37)** — `package.json` → `testCmd: "npm test"` **or** `"npm run lint && npm test"`.  
  **Actual:** always `"npm test"` if `package.json` exists; never concatenates lint.  
  **Proof:** `src/stack-detector.mjs` L221–235.

- **AGENTS.md, Exit Code 7 (~L119)** — “Wait for the **next UTC day**”.  
  **Actual:** rolling **24h** window (`ROLLING_WINDOW_MS` in `src/state.mjs` / `src/budget.mjs`); `loadConfig` comments and README config comment already say rolling 24h.  
  **Proof:** `src/config.mjs` L401–402, L347–351; `src/state.mjs` ~L56–63.

- **AGENTS.md, Release Protocol (~L127–128)** — “Update version strings in `package.json` **and `bin/agentctl.mjs`**”.  
  **Actual:** CLI version is `KIT_VERSION` from `src/version.mjs` reading `package.json`. No version literal in `bin/agentctl.mjs`.  
  **Proof:** `src/version.mjs` L27; `bin/agentctl.mjs` L11–16.

- **AGENTS.md, Exit 3 remediation (~L113)** — `allowProtected: true` as an operator flag.  
  **Actual:** CLI flag is `--allow-protected`; env `JULES_ALLOW_COMMAND_FILE_CHANGES=true`.  
  **Proof:** `bin/agentctl.mjs` L298; `src/engine.mjs` L202.

### docs/architecture.md

- **Pipeline A mermaid (~L59–66)** — HTTP path always `POST /v1alpha/sessions + automationMode` then “agent edits repo & opens PR server-side”.  
  **Actual:** `automationMode` is set **only** when `--auto-pr` / `autoPr` is true (`src/provider.mjs` L251–257). Default dispatch does not auto-open PRs.

### PRIOR_ART.md

- **PRIOR_ART.md (~L14)** — MCP server at **`src/mcp-server.mjs`**.  
  **Actual:** `src/mcp.mjs` + `bin/mcp-server.mjs`.  
  **Proof:** `package.json` bin `jules-mcp`; `bin/agentctl.mjs` `case "mcp"`.

- **PRIOR_ART.md (~L20)** — Nonced `<UNTRUSTED_TASK_CONTEXT_${nonce}>` **in `jules-dispatch.mjs`**.  
  **Actual:** fencing is `<<<UNTRUSTED-DATA-BEGIN>>>` in `src/prompt-guard.mjs`. `scripts/jules-dispatch.mjs` is a deprecated shim; `runPreflightStaticCheck()` **always returns `"PASSED"`** (stub).  
  **Proof:** `src/prompt-guard.mjs` L63; `scripts/jules-dispatch.mjs` L87–88.

- **PRIOR_ART.md (~L49)** — Ledger at `.agent/state/sessions/YYYY-MM-DD.jsonl`.  
  **Actual:** `.agent/state/ledger-<date>.jsonl` (`getLedgerPath` in `src/state.mjs` ~L56).

- **PRIOR_ART.md (~L14)** — “We **plan to build**” stdio MCP.  
  **Actual:** MCP already ships (`agentctl mcp`, `src/mcp.mjs`). Competitive claim is stale/wrong tense.

---

## Stale (references removed features or old paths)

- **README.md CLI table** omits many live commands but also documents flags that were never wired (`doctor --fix`, `queue/swarm --interactive`).
- **EXAMPLES.md Pattern 3** worktree/swarm topology matches `docs/assets/swarm-topology.svg` labels (“Slot A: git worktree”) even though the kit does not create worktrees (`docs/architecture.md` L267).
- **EXAMPLES.md / .env.example** env vars **never referenced in runtime code:** `JULES_SWARM_CONCURRENCY`, `JULES_USE_WORKTREES`, `JULES_PACE_MS`, `JULES_SLOT_INDEX`, `JULES_SLOT_TOTAL`, `JULES_API_URL`, `JULES_REPOLESS`, `JULES_ALLOW_AGENT_RULE_CHANGES`, `GITHUB_HEAD_REF`.  
  Used instead: `JULES_API_KEY`, `JULES_REPO`, `JULES_TIER`, `JULES_DAILY_BUDGET`, `JULES_MAX_DIFF_KB`, `JULES_DRY_RUN`, `JULES_PROJECT_ROOT`, `JULES_PROJECT_ID`, `JULES_ALLOW_COMMAND_FILE_CHANGES`, `BASE_BRANCH`, `ALLOW_AUTO_REPAIR` (self-audit), `JULES_SWARM_REMOTE_PUSH` (utils), `NO_COLOR`, `CI`.
- **AGENTS.md L45** — “Standalone helper scripts were removed as shims.” Many `scripts/*.mjs` still exist (`jules-dispatch`, `jules-merge-swarm`, `jules-status`, `command-resolver`, etc.), some deprecated but not removed.
- **AGENTS.md lock line** is accurate for acquire/status/release; **help text** in `bin/agentctl.mjs` L49 still lists `lock cleanup` which is **not implemented** (unknown action falls through to `lockStatus`).
- **CHANGELOG.md [0.38.0]** repeats the 555/81 test-count claim.
- **CHANGELOG.md older entries** correctly *describe* deleted shims (`scripts/lock-manager.mjs`, `jules-swarm.mjs`) as history; those paths must not be used as current operator docs (AGENTS already warns).
- **PRIOR_ART.md** still describes MCP as future work and UNTRUSTED fencing as living in `jules-dispatch.mjs`.
- **command-resolver.mjs header** still says “Backward compatibility shim … v0.9.0”.

---

## Missing (features in code but not documented)

Documented in `agentctl` help (`bin/agentctl.mjs` L38–71) but **absent or incomplete in README CLI table / EXAMPLES / AGENTS canonical list:**

| Command | Where it actually lives |
| :--- | :--- |
| `dispatch` / `create` (`--title`, `--prompt`, `--prompt-file`, `--role`, `--tier`, `--auto-pr`, `--repoless`, `--dry-run`) | `bin/agentctl.mjs` L136–277 — EXAMPLES uses it; README table does not |
| `task optimize` (`--fix`, `--web`, `--json`) | L811+; EXAMPLES Pattern 7 only |
| `clean` | L378 (`worktreePrune`) |
| `lock acquire\|release\|status` | L434+; AGENTS only |
| `bootstrap` | L511 |
| `review-repair <file.json>` | L534; README roadmap mentions it, CLI table does not |
| `status` | L888 |
| `budget` / `budget reset --yes [--all]` | L384 |
| `scan` | L904; EXAMPLES nightly uses `npx … scan` (works) but README table omits it |
| `hydrate [prompt]` | L1148; AGENTS only |
| `harvest` | L1156 |
| `learning add` | L1183; AGENTS only |
| `escalate` / `--flush` / `--status` / `--clear` | L946; AGENTS only |
| `version` | L116 |
| Bare `agentctl` (next-step / `src/ops/next-step.mjs`) | L96–114 |
| `mcp init --target` | README has this; good |

**Config schema present in `loadConfig` but missing from README YAML example:**

- `tier` (`free|pro|ultra|enterprise`), `isolation`, `runner`
- `verify.setup|lint|unit|fuzz|invariant|e2e|teardown|stages|server|timeoutMs|policy`
- `scope.allow`, `scope.protect` (example only shows `deny`)
- `limits.staggerMs`, snake_case aliases (`diff_kb`, `daily_tasks`, …)
- `evidence.enabled`, `evidence.strictTestLock`
- `notifications.*` (silence governor)
- `provenance` (computed)

**Stack detector extras not in README ecosystem list:** `dart` (non-Flutter pubspec), Prisma/Drizzle `setupCmd`, edge overlay (`wrangler.toml`, `netlify.toml`, Vercel edge pkgs), `global.json` is **not** a .NET trigger (only `*.sln`/`*.csproj`/`*.fsproj`).

**SDK:** `resolveRoutedProvider` not exported; many other exports (`DagExecutor`, flaky ledger, evidence, budget, wizards) are undocumented in README.

**Exit codes:** engine `gate()` uses 0,1,3,4,5,6,8 as documented in architecture; CLI also uses **130** (wizard cancel) and **2** (`budget reset` unknown flags) — not in AGENTS registry. Doctor healthy/unhealthy is **0/1**, not a dedicated “healthy” code in the registry.