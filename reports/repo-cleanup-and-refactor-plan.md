# Repository Cleanup & Refactoring Blueprint

**Repository:** `FullThrottle83/jules-orchestrator-kit` @ `v0.42.0` (commit `6792115`)
**Date:** 2026-08-24
**Status:** PLAN ONLY — no code has been edited or deleted.

**Scope:** dead-weight / scratch / shim / unused-export audit of repository root and `src/`,
plus modularization of the three largest monoliths:

| File | Lines | Target |
|---|---|---|
| `bin/agentctl.mjs` | 1,979 | thin entry + `src/cli/commands/*.mjs` |
| `src/engine.mjs` | 1,248 | facade + `src/engine/*.mjs` (each < 300 lines) |
| `src/provider.mjs` | 1,103 | facade + `src/providers/*.mjs` (each < 350 lines) |

**Hard invariants (verified against the codebase, not assumed):**

1. **Zero external runtime dependencies.** `package.json` has no `dependencies`; only
   `devDependencies` (`eslint`, `globals`). Every module in the target tree imports
   `node:` builtins and relative paths only. The target design adds no new imports.
2. **Frozen SDK surface.** `test/api-surface.test.mjs` asserts that `index.mjs` exports
   **exactly 208 symbols** (list locked, count locked). No export may be added, removed,
   or renamed. This blueprint keeps `index.mjs` **byte-identical in behavior** (in fact,
   its import specifiers can stay identical — see §3.1 facade pattern).
3. **Frozen CLI surface.** All 31 `agentctl` commands, their flags, aliases
   (`create`→`dispatch`, `gate`/`audit`→`check`, …), and the exit-code contract 0–8
   (also locked by `test/api-surface.test.mjs`) are unchanged.
4. **Frozen package surface.** All 5 `bin` entries, all 20 `scripts` entries, the
   `main`/`exports`/`files` fields, and `engines` are unchanged.
5. **Doc-sync gate pins.** `scripts/doc-sync-check.mjs` (blocking in CI and
   `scripts/release.mjs`) requires:
   - `bin/agentctl.mjs` to exist and contain `export const VERSION = KIT_VERSION`;
   - `src/version.mjs` to read `package.json`;
   - `FOREIGN_VERSIONS` paths to remain valid: `src/ops/doctor-registry.mjs`,
     `src/ops/ide-scaffold.mjs`, `src/version.mjs`.
   → Those four files **keep their current paths** in the target tree.
6. **No import cycles.** The current graph (all 108 `.mjs`/`.js` files, static +
   dynamic imports) was exhaustively checked and contains **zero cycles**. The target
   graph preserves that property (§3.3 documents the one new cycle risk and its fix).
7. **CI matrix.** 9-way OS/Node matrix (`ubuntu`/`macos`/`windows` × Node 20/22/24)
   runs `npm run lint`, `npm test`, and (ubuntu/22) `node scripts/jules-self-audit.mjs`.
   Every migration step below must keep all of these green.

---

## 1. Dead Files & Shims Deletion List

### 1.1 Files to delete entirely

| # | File | Size | Rationale |
|---|---|---|---|
| D1 | `deep-think-results.md` | 658 lines / ~50 KB | Unreferenced scratch document. Written in second person ("As a Principal Systems Architect, I know exactly…"), it is a brainstorm of 10 *future* milestone ideas (POSIX process-group kill, shadow indexes, FD IPC, CoW VFS, …) that were never implemented and never shipped. Verified: **zero references** from any file in the repo (not in `README.md`, `ROADMAP_V1.md`, `docs/`, `.github/`, `package.json`, `AGENTS.md`, or the npm `files` list). It is not part of the published tarball. Pure working scratch that should have lived in a branch or an issue. |

**What was audited and deliberately KEPT** (to prevent over-pruning):

| File | Why it stays |
|---|---|
| `bin/init.js` (284 lines) | Second published bin (`jules-init`, `npm run init`). Real scaffolder, not a shim — it imports `scripts/command-resolver.mjs` and writes AGENTS.md/`.agent/jules.yml`. `agentctl init` and `jules-init` are two entry points to the same kit; README/AGENTS.md document both. Consolidation is a *feature* decision, out of scope. |
| `bin/mcp-server.mjs` (5 lines) | 5-line *bin stub* (`#!/usr/bin/env node` + `startMcpServer()`), not a redundant shim — it is a required `package.json` `bin` target (`jules-mcp`, `agentctl-mcp`) and cannot be a one-liner because it needs the shebang + executable bit. |
| `.agent/jules.yml` | This repo's own kit configuration (gate input). |
| `.agent/prompts/*.md`, `.agent/rules/*`, `.agent/workflows/*` | Shipped product content (`package.json.files` includes them). |
| `.agent/knowledge/learnings.json`, `.agent/SYSTEM_LEARNINGS.md` | Live SPORE-memory state of *this checkout* (read by `src/memory.mjs` via `agentctl hydrate` / dispatch). Runtime data, not scratch — but it **is** repo state committed to git; if the maintainer wants a clean slate, that is a separate, conscious decision (the file self-documents "NEVER edit manually"). |
| `.agent/jules-queue/README.md` | Queue-format documentation; `isTaskFile()` explicitly special-cases `README.md` so it is never dispatched. |
| `ROADMAP_V1.md`, `PRIOR_ART.md`, `JULES_RULES_TEMPLATE.md`, `EXAMPLES.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CONTRIBUTING.md` | Product/documentation content; `JULES_RULES_TEMPLATE.md` is in the npm `files` list and scanned by `src/rules-budget.mjs`. |
| `scripts/*.mjs` (22 files) | All are referenced by `package.json` scripts, by CI, by `index.mjs` legacy re-exports, or by `test/kit.test.mjs`. None are dead. |
| `docs/assets/*.svg` (9 files) | Referenced from `docs/architecture.md` / `README.md` diagrams. |

### 1.2 Redundant one-line shims to delete (duplicate-filename pairs)

Three files are single-line `export *` re-exports of their hyphenated twins. They exist
because two naming conventions (`snake_case` vs `kebab-case`) coexist, and importers
split between both spellings. Both spellings currently resolve, so both tarball entries
ship — one of each pair is dead weight.

| # | Shim (delete) | Canonical (keep) | Shim's current importers (repoint to canonical) |
|---|---|---|---|
| S1 | `src/rules_budget.mjs` — `export * from "./rules-budget.mjs";` | `src/rules-budget.mjs` (179 lines: `checkRulesBudget`, `compileRules`, `verifyRulesSentinel`) | `bin/agentctl.mjs:1896` (dynamic `await import` in `rules` command), `scripts/rules-lint.mjs:3`, `test/rules_budget.test.mjs:3` |
| S2 | `src/asset_integrity.mjs` — `export * from "./asset-integrity.mjs";` | `src/asset-integrity.mjs` (76 lines: `checkAssetIntegrity`) | `scripts/asset-integrity-check.mjs:3`, `test/asset-integrity.test.mjs:3` |
| S3 | `src/execution_envelope.mjs` — `export * from "./execution-envelope.mjs";` | `src/execution-envelope.mjs` (127 lines: `create/verify/freeze/hashExecutionEnvelope`) | `test/execution_envelope.test.mjs:9`, `test/remediation.test.mjs:6` |

**Direction of consolidation: keep the hyphenated (kebab-case) files.** Rationale:
`index.mjs` (the frozen public facade) already imports the hyphenated spellings, and
kebab-case is the convention used by every other module in the repo
(`rules-budget`, `asset-integrity`, `execution-envelope`, `flaky-ledger`, …).
Only the 5 importers above need a specifier change — all internal, none external
(`index.mjs` — the only public surface — never references the shims, so npm consumers
are unaffected; the shims are reachable only via `src/` deep imports, which are not part
of the frozen API).

**Migration (per shim, in this order):**
1. Repoint each importer's specifier from `src/x_y.mjs` to `src/x-y.mjs`.
2. Run `npm test` (proves the shim had no independent behavior — a re-export cannot).
3. Delete the shim.
4. *(Optional, cosmetic)* rename the two underscore-named **test files**
   `test/rules_budget.test.mjs` → `test/rules-budget.test.mjs` and
   `test/execution_envelope.test.mjs` → `test/execution-envelope.test.mjs`
   to match the module. Safe: `scripts/run-tests.mjs` globs `test/*.test.mjs` by
   extension, and no file references the test paths.

### 1.3 Truly dead exports — delete the export (definition already unused)

The following symbols are exported but **never referenced anywhere** — not by other
modules, not by tests, not even inside their own file (identifier count in defining
file = 1, i.e. only the `export` declaration itself). Deleting the `export` keyword
(Phase A, this refactor) or the whole definition (where 100% dead) is provably safe:

| File | Symbol | Action |
|---|---|---|
| `src/security.mjs` | `isForbiddenPath` | Remove `export` — but see note: `checkScope` does **not** call it; no caller exists. Delete function + export (dead code). |
| `src/security.mjs` | `FORBIDDEN_EDGE_MODULES` | `checkEdgeRuntimeImports` uses its own local list; this export is never read. Delete const + export. |
| `src/ux/widgets.mjs` | `renderListLines` | Never called. Delete function + export. |
| `scripts/jules-merge-swarm.mjs` | `attemptCodeMergeFile` | Never called (`deepMerge3Way` is the live path, exercised by `test/kit.test.mjs`). Delete function + export. |
| `scripts/jules-self-audit.mjs` | `logAuditMetrics` | Never called. Delete function + export. |
| `scripts/utils.mjs` | `calculateShannonEntropy` | Never called (`shannonEntropy` lives in `src/security.mjs` and is the frozen public one). Delete function + export. |
| `scripts/utils.mjs` | `isForbiddenPath` | Never called. Delete function + export. |
| `scripts/utils.mjs` | `logToHistory` | Never called. Delete function + export. |
| `scripts/utils.mjs` | `acquireBudgetLock` | Never called (budget locking moved to `src/state.mjs` `withVfsMutex`). Delete function + export. |
| `scripts/utils.mjs` | `releaseBudgetLock` | Never called. Delete function + export. |
| `scripts/utils.mjs` | `HIGH_CONFIDENCE_PATTERNS`, `LOW_CONFIDENCE_PATTERNS` | Local copies of `src/security.mjs`'s live lists; nothing in `utils.mjs` reads them (the live secret scanners come from `src/security.mjs`). Delete both consts + exports. |

> Verification method: for every symbol, counted whole-word occurrences in the defining
> file and whole-repo import occurrences (static `import {}` **and** `const {} =
> await import()`), including all 71 test files. Items above score 1/0.

**Wave B (next minor, with CHANGELOG entry) — demote to module-private.** These are
exported, used only inside their own file, and are **not** part of the frozen 208
public API. Phase 1 moves them without changing their export status (behavior-neutral);
after one release cycle the `export` keyword is dropped:

`src/engine.mjs`→`src/engine/repair.mjs` `pollSessionState` · `src/config.mjs` `dedupe`,
`BUILTIN_DENY`, `BUILTIN_PROTECT`, `ConfigError` (note: `resolveVerify` in the same file
**is** frozen-public, keep exported) · `src/dag-engine.mjs` `GLOBAL_CONTRACT_PATTERNS` ·
`src/dashboard.mjs` `getDashboardHtml` · `src/evidence.mjs` `findFilesRecursively`,
`getGitProvenance`, `EVIDENCE_RETENTION` · `src/git.mjs` `ensureBaseFetched` ·
`src/mcp.mjs` `MAX_MCP_FRAME_SIZE`, `McpFrameDecoder` ·
`src/mcp-progress.mjs` `MAX_PROGRESS_MESSAGE_LENGTH`, `DEFAULT_PROGRESS_COALESCE_MS` ·
`src/prompt-guard.mjs` `STERILE_VOCABULARY_MAP` ·
`src/review-repair.mjs` `sanitizeAuthor`, `sanitizeReviewPath`, `buildReviewPrompt` ·
`src/risk.mjs` `BUILTIN_CONSEQUENTIAL`, `DEFAULT_R2_DIFF_LINES` ·
`src/router.mjs` `DECLARATIVE_ASSET_EXTS`, `MAX_FLASH_BYTES`, `MAX_FLASH_FILES`,
`MECHANICAL_PREFIXES` · `src/rules-budget.mjs` `SENTINEL_BEGIN`, `SENTINEL_END` ·
`src/security.mjs` `HIGH_CONFIDENCE_PATTERNS`, `LOW_CONFIDENCE_PATTERNS`,
`safeRenameSync` · `src/stack-detector.mjs` `generateSmokeTestScript` ·
`src/telemetry.mjs` `MAX_TELEMETRY_SEGMENT_BYTES`, `TELEMETRY_RETENTION_DAYS` ·
`src/ux/renderer.mjs` `encodeAnsiStyle`, `renderLineToAnsi` ·
`src/web-templates.mjs` `WEB_TEMPLATES` ·
`src/webhook.mjs` `getDigestFilePath`, `getInterruptionLedgerPath`,
`saveEscalationDigest`, `loadInterruptionLedger` ·
`src/assertions.mjs` `normalizePosix` · `src/ops/checkpoint.mjs` `getCheckpointDir` ·
`src/provider.mjs`→`src/providers/presets.mjs` `GEMINI_PRESET` (JULES/CLAUDE/CODEX
presets are frozen-public; GEMINI is not).

**Kept-exported despite internal-only usage, because they are in the frozen 208**
(exported via `index.mjs`): `readLedger`, `wilsonScoreInterval`, `computeOscillation`,
`getLearningsPath`, `getSystemLearningsMdPath`, `getHandoverDir`, `tierOptions`,
`BUILTIN_PRESETS`, `GUARDRAIL_FOOTER`, `CheckpointError`, `pruneCheckpoints`,
`TddError`, `IdeScaffoldError`, `resolveAmbientIdentity`, `resolveVerify`,
`VENDOR_TIERS`, `FALLBACK_TIER`, `checkEdgeRuntimeImports`.

### 1.4 Architectural debt to fix *without* deletion

| # | Smell | Fix (in this refactor) |
|---|---|---|
| A1 | `bin/agentctl.mjs` (CLI) imports the **public facade** `../index.mjs` inside the `assert` command (`const { runAssertion, parseYaml } = await import("../index.mjs")`). The CLI reaching *up* through the SDK facade to get two symbols is an inverted boundary and drags the whole 208-export surface into a fast CLI path. | `src/cli/commands/assert.mjs` imports `runAssertion` from `src/assertions.mjs` and `parseYaml` from `src/config.mjs` directly. No behavior change (same functions, same module origins). |
| A2 | `index.mjs` (public SDK) imports from `scripts/` — 6 "Legacy SDK shims" blocks (`command-resolver`, `jules-self-audit`, `jules-scan-todos`, `jules-dispatch`, `jules-queue-runner`, `utils`). The public library depends on the tooling directory. | **Kept as-is for compatibility** (frozen 208). Documented here as Phase-3 territory: migrate the 6 underlying functions into `src/` in a future major, keep `index.mjs` re-exporting from the new home, then retire the script-only copies. Not executed in this refactor because it would touch 6 script files that `package.json` scripts and `test/kit.test.mjs` also use. |
| A3 | `src/engine.mjs` carries a 21-name **legacy re-export block** (flaky-ledger, prompt-guard, dag-engine, remediation, memory, role-resolver, state, evidence, assertions symbols) — it is functioning as a catch-all convenience facade. | The new `src/engine.mjs` facade keeps the block verbatim (it is part of what `index.mjs` and 21 test files rely on) but each re-export gains a `// re-export for legacy consumers (frozen via index.mjs)` marker so future pruning is explicit. |

---

## 2. Proposed Target Directory & File Structure

### 2.1 Strategy: facade + module split (zero importer churn)

The three monoliths are imported by **30+ files** (bin, scripts, index.mjs, 71 tests,
mcp server). Moving them to new paths would force a mass edit of importers for zero
behavior gain. Instead:

- **`bin/agentctl.mjs`** stays at its pinned path but shrinks 1,979 → ~95 lines; all
  command handlers move to `src/cli/commands/*.mjs`.
- **`src/engine.mjs`** stays at its path but becomes a ~65-line **facade** re-exporting
  from `src/engine/*.mjs`.
- **`src/provider.mjs`** stays at its path but becomes a ~35-line **facade** re-exporting
  from `src/providers/*.mjs`.

Every existing import specifier (`../src/engine.mjs`, `./provider.mjs`,
`../src/rules-budget.mjs`, …) keeps resolving with identical behavior. `index.mjs`,
all `scripts/*.mjs`, all 71 test files, `bin/init.js`, and `bin/mcp-server.mjs` require
**no changes** in Phase 1.

### 2.2 Target tree (Phase 1 — this refactor)

Line counts: `→` = estimated after split. Files marked ★ are new; others are unchanged
or shrunk in place.

```
jules-orchestrator-kit/
├── bin/
│   ├── agentctl.mjs            1979 → ~95     thin entry: shebang, VERSION pin, help/version/bare, registry dispatch, exit-code tail
│   ├── init.js                 284            (unchanged)
│   └── mcp-server.mjs           5            (unchanged)
│
├── src/
│   ├── cli/                    ★ new — CLI layer (was: inline switch in bin/agentctl.mjs)
│   │   ├── context.mjs          ~55          createContext(): root, config, journal reaping, version (was: main() preamble)
│   │   ├── help.mjs             ~80          printHelp() template (was: lines 36–111)
│   │   ├── output.mjs          ~115          formatBudgetLine, resolvePromptInput, reportRunOutcome, printVerifyFailure (was: lines 26–34, 113–188)
│   │   ├── registry.mjs        ~130          COMMANDS table (31 commands + aliases) → lazy `import()` per command
│   │   └── commands/           ★ one module per command, each < 160 lines
│   │       ├── home.mjs         ~40          (bare `agentctl` → next-step; was: lines 199–212)
│   │       ├── dispatch.mjs    ~115          dispatch | create (was: lines 236–346)
│   │       ├── gate.mjs        ~105          check | gate | audit + exit-code hint ladder (was: lines 348–438)
│   │       ├── assert.mjs       ~90          assert (A1 fix: direct src imports) (was: lines 440–525)
│   │       ├── queue.mjs        ~40          queue (was: lines 527–560)
│   │       ├── swarm.mjs        ~35          swarm (was: lines 562–578)
│   │       ├── clean.mjs        ~15          clean (was: lines 580–586)
│   │       ├── budget.mjs       ~100         budget + budget reset (was: lines 588–682)
│   │       ├── lock.mjs         ~40          lock acquire|release|status (was: lines 684–712)
│   │       ├── doctor.mjs       ~60          doctor (was: lines 714–757)
│   │       ├── bootstrap.mjs    ~35          bootstrap (was: lines 759–780)
│   │       ├── review-repair.mjs ~30         review-repair (was: lines 782–798)
│   │       ├── dashboard.mjs    ~15          dashboard (was: lines 800–805)
│   │       ├── init.mjs         ~70          init (wizard + scaffoldRepoAssets + next step) (was: lines 807–866)
│   │       ├── task.mjs        ~170          task create | template | optimize (was: lines 868–1029)
│   │       ├── status.mjs       ~30          status (was: lines 1031–1044)
│   │       ├── scan.mjs         ~25          scan (was: lines 1046–1058)
│   │       ├── rollback.mjs     ~65          rollback (+ handover side-effect) (was: lines 1060–1115)
│   │       ├── handover.mjs    ~115          handover list|show|create|prune (was: lines 1117–1231)
│   │       ├── session.mjs     ~120          resume | plan approve | approve | session get (shared provider-call pattern; was: lines 1233–1385)
│   │       ├── pr.mjs           ~50          pr harvest (was: lines 1387–1429)
│   │       ├── escalate.mjs    ~125          escalate + --flush/--status/--clear (was: lines 1431–1557)
│   │       ├── flaky.mjs       ~130          flaky status|heal|reset (was: lines 1559–1673)
│   │       ├── test-gen.mjs     ~60          test-gen (was: lines 1675–1719)
│   │       ├── mcp.mjs          ~45          mcp init + startMcpServer (was: lines 1721–1758)
│   │       ├── memory.mjs       ~75          hydrate | harvest | learning add (was: lines 1760–1820)
│   │       ├── evidence.mjs     ~60          evidence generate|verify|show (was: lines 1822–1892)
│   │       └── rules.mjs        ~75          rules check|compile (imports src/rules-budget.mjs directly) (was: lines 1894–1962)
│   │
│   ├── engine/                 ★ new — engine core (was: src/engine.mjs monolith)
│   │   ├── gate.mjs            ~260          gate(): scope/payload/secrets phases, trusted-config from origin, test-integrity lock, evidence persist, --fix→repair (gateFn injection)
│   │   ├── verify-pipeline.mjs ~250          buildVerifyStages() + runVerifyStages(): stage loop, assertion stages, redaction, executionRecords, flaky quarantine, teardown
│   │   ├── repair.mjs          ~285          OODACircuitBreaker, repair() (opts.gateFn), buildRepairPrompt(), pollSessionState() [private]
│   │   ├── dispatch.mjs        ~180          dispatch(), checkTaskPremise()
│   │   ├── queue-run.mjs       ~160          run(), isTaskFile(), isSafeQueueFileName() [private]
│   │   ├── fingerprint.mjs      ~45          fingerprintFailureState()
│   │   ├── pr-description.mjs   ~90          synthesizePrDescription()
│   │   └── server-probe.mjs    ~140          probeDevServer() + SSR hydration-panic detection
│   ├── engine.mjs               1248 → ~65   ★ compatibility facade: re-exports the full historical surface (own + legacy block, A3)
│   │
│   ├── providers/              ★ new — provider adapters (was: src/provider.mjs monolith)
│   │   ├── presets.mjs          ~70          JULES_PRESET, CLAUDE_PRESET, CODEX_PRESET, GEMINI_PRESET, NAMED_PRESETS
│   │   ├── errors.mjs           ~55          MissingApiKeyError, ProviderRateLimitError, ProviderUnavailableError, ProviderSchemaError, parseRetryAfter()
│   │   ├── token-pool.mjs       ~90          TokenPool (round-robin, 429 cooldown, usage inventory)
│   │   ├── interpolate.mjs      ~25          interpolateString(), interpolateDeep()
│   │   ├── transport.mjs       ~150          buildHeaders() (CRLF-injection check), fetchWithTimeout(), redactErrorText(), classifyHttpError() (429/5xx/other), parseJsonObject()
│   │   ├── jules.mjs           ~260          httpDispatch() (token rotation + optimistic schema degradation) + httpResume() (warm fallback to cold dispatch)
│   │   ├── jules-session.mjs   ~230          httpGetSession() + httpApprovePlan() (shared exponential-backoff retry loop from transport.mjs)
│   │   ├── exec.mjs             ~95          execDispatch() (spawnSync, promptViaStdin) + execResume() (delegates to dispatch)
│   │   ├── failover.mjs        ~145          createFailoverProvider() (recoverable-error taxonomy shared by dispatch/resume/getSession/approvePlan)
│   │   ├── syntax-verify.mjs   ~130          listChangedSourceFiles(), findSyntaxError() (`node --check`), createSyntaxVerifiedProvider()
│   │   └── index.mjs            ~95          createProvider(): spec validation, {token}-in-URL guard, type→adapter wiring (http→jules/jules-session, exec→exec), validate()
│   ├── provider.mjs               1103 → ~35 ★ compatibility facade (presets, errors, parseRetryAfter, TokenPool, createProvider, createFailoverProvider, createSyntaxVerifiedProvider)
│   │
│   ├── (all other src/ modules: paths & exports unchanged in Phase 1)
│   ├── config.mjs                571          (Phase 2 split, §2.3)
│   ├── security.mjs              735          (Phase 2 split; Wave A dead-export removal)
│   ├── state.mjs                 664          (Phase 2 split)
│   ├── webhook.mjs               650          (Phase 2 split)
│   ├── dag-engine.mjs            585          (Phase 2 split)
│   ├── assertions.mjs            579          (Phase 2 split; Wave A: normalizePosix demotion)
│   ├── mcp.mjs                   572          (Phase 2 split)
│   ├── evidence.mjs              544          (Phase 2 split)
│   ├── stack-detector.mjs        682          (Phase 2 split)
│   ├── web-templates.mjs         792          (Phase 2 split)
│   ├── tui.mjs                   488          (Phase 2 split)
│   ├── ops/doctor-registry.mjs   524          PATH PINNED by doc-sync FOREIGN_VERSIONS — keep path; split *check implementations* into src/ops/doctor/*.mjs (Phase 2)
│   ├── ops/ide-scaffold.mjs      139          PATH PINNED by doc-sync — keep
│   ├── version.mjs                 27         PATH PINNED by doc-sync — keep
│   ├── rules-budget.mjs          179          (canonical; shim S1 deleted)
│   ├── asset-integrity.mjs        76          (canonical; shim S2 deleted)
│   └── execution-envelope.mjs   127          (canonical; shim S3 deleted)
│
├── scripts/                     (unchanged in Phase 1; Wave A dead-export removal in utils/merge-swarm/self-audit)
├── test/                        (71 .test.mjs files; only the 4 shim-importer specifiers change in §1.2)
├── index.mjs                    (UNCHANGED — import specifiers still resolve to the facades)
├── package.json                 (UNCHANGED — bin/main/exports/files/scripts)
└── deep-think-results.md        DELETED (D1)
```

**Result:** largest file after Phase 1 = `src/security.mjs` at 735 (Phase 2 target).
All Phase 1 new files are < 300 lines; `src/cli/commands/*` are all < 160.

### 2.3 Phase 2 — remaining >350-line files (follow-up, same facade pattern)

| Current file (lines) | Split into | Notes |
|---|---|---|
| `src/web-templates.mjs` (792) | `web-templates/index.mjs` (~120: `listWebTemplates`/`getWebTemplate`/`synthesizeWebEnvelope`) + `web-templates/templates/*.mjs` (~15–40 each, one per template: `web-ai-access`, …) | `WEB_TEMPLATES` is internal-only (Wave B). `index.mjs` facade preserves the 3 public functions. |
| `src/security.mjs` (735) | `security/secret-scanner.mjs` (~200: patterns, entropy, base64 decode, `scanDiff`), `security/scope-guard.mjs` (~150: `matchesGlob`, `checkScope`), `security/redaction.mjs` (~90: `redactSecrets`, `anonymizePii`), `security/fs-utils.mjs` (~60: `safeRenameSync`, `safeAtomicWrite`), `security/edge-checks.mjs` (~200: `checkEdgeRuntimeImports`, `checkCrossPackageImports`), `security.mjs` facade (~25) | Also absorbs Wave A deletions (`isForbiddenPath`, `FORBIDDEN_EDGE_MODULES`). |
| `src/stack-detector.mjs` (682) | `stack-detector/polyglot.mjs` (~200), `stack-detector/boundaries.mjs` (~220: workspace/subproject/cross-package), `stack-detector/circular.mjs` (~120: `detectCircularDependencies`), `stack-detector/bootstrap.mjs` (~100: `bootstrapZeroTestRepo`), facade | `detectEdgeRuntime` (imported by `src/scaffold.mjs`) stays reachable via facade. |
| `src/state.mjs` (664) | `state/paths.mjs` (~45: dirs, `ROLLING_WINDOW_MS`), `state/ledger.mjs` (~230), `state/budget-ops.mjs` (~180: reserve/commit/rollback/`withBudget`/`checkDailyBudget`), `state/locks.mjs` (~200: `withVfsMutex`, acquire/release/status, concurrency groups), `state/pid.mjs` (~50: procstat parsing), facade | Largest frozen-API surface (21 symbols) — facade must carry all. |
| `src/webhook.mjs` (650) | `webhook/digest.mjs` (~120), `webhook/interruptions.mjs` (~80), `webhook/signing.mjs` (~100: `verifySignature`, `parseWebhookPayload`), `webhook/server.mjs` (~150: `createWebhookServer`, `routeWebhookEvent`), `webhook/escalation.mjs` (~150: `dispatchEscalation`, flush/status/clear), facade | 14 frozen symbols via facade. |
| `src/dag-engine.mjs` (585) | `dag-engine/kahn.mjs` (~180: `DagExecutor`, `DagCycleError`), `dag-engine/queue.mjs` (~220: `executeQueueDag`), `dag-engine/affected.mjs` (~120: `resolveAffectedTests`), facade | `GLOBAL_CONTRACT_PATTERNS` Wave B. |
| `src/assertions.mjs` (579) | `assertions/primitives.mjs` (~250: the 4 assert* functions), `assertions/runner.mjs` (~150: `runAssertion`, stage-config parsing), `assertions/bytes.mjs` (~80: `formatBytes`, `resolveBytesLimit`, gzip), facade | |
| `src/mcp.mjs` (572) | `mcp/frames.mjs` (~120: `McpFrameDecoder`, `writeMcpFrame`, `isolateMcpStdout`), `mcp/tools.mjs` (~110: `MCP_TOOLS` table), `mcp/handler.mjs` (~200: `handleMcpRequest`), `mcp/server.mjs` (~60: `startMcpServer`, `MCP_SERVER_INFO`), facade | |
| `src/config.mjs` (571) | `config/yaml.mjs` (~100: `parseYaml`), `config/stack.mjs` (~120: `detectStack`, `detectPackageManager`, `resolveVerify`), `config/presets.mjs` (~60: `TIER_PRESETS`, `VENDOR_TIERS`, `FALLBACK_TIER`), `config/loader.mjs` (~180: `loadConfig`, `normalizeScope`, `BUILTIN_DENY/PROTECT`, path utils), facade | |
| `src/evidence.mjs` (544) | `evidence/hash.mjs` (~90), `evidence/manifest.mjs` (~230: generate/write/load/verify), `evidence/report.mjs` (~150: markdown, JSON export, provenance), facade | `sha256` re-export used by engine stays via facade. |
| `src/ops/doctor-registry.mjs` (524) | `src/ops/doctor/checks/*.mjs` (one per check, ~40–80 each) imported by the pinned `src/ops/doctor-registry.mjs`, which keeps its path + `runDoctorChecks` export | **doc-sync `FOREIGN_VERSIONS` pin: file must keep containing the "20.0.0" literal in context** — keep the Node-version check (or its explanatory comment) in the pinned file. |
| `src/merge-blocks.mjs` (469) | `merge-blocks/parser.mjs` (~200), `merge-blocks/apply.mjs` (~180), facade | |
| `src/tui.mjs` (488) | `tui/ansi.mjs` (~40), `tui/prompts.mjs` (~280), `tui/spinner.mjs` (~80: `spinner`, `WizardCancelledError`), facade | `WizardCancelledError` is caught by name in the bin tail — keep exported via facade. |
| `src/ops/handover.mjs` (411) | `ops/handover-io.mjs` (~250: create/load/list/prune), `ops/handover-format.mjs` (~110: markdown, prompt context), `handover.mjs` facade | 7 frozen symbols via facade. |
| `src/ops/command-registry.mjs` (408) | leave monolithic (data-table file; low churn) | optional |
| `src/task-optimizer.mjs` (411), `src/telemetry.mjs` (409), `src/budget.mjs` (409), `src/flaky-ledger.mjs` (377) | minor 2-way splits (scoring vs. prompt-building; append vs. read/verify; limits vs. reservations; ledger vs. verdict) | optional |

Phase 2 follows the identical rules: facade at the original path, `npm test` green per
step, `index.mjs` untouched, zero new dependencies.

---

## 3. Step-by-Step Dependency & Export Graph

### 3.1 Layer model (target, bottom → top)

```
L0  primitives — no intra-repo deps
    version.mjs · tui.mjs · security.mjs · git.mjs (→preload-net-guard.mjs)
    config.mjs · stack-detector.mjs · risk.mjs · envelope.mjs · rules-budget.mjs
    asset-integrity.mjs · execution-envelope.mjs · providers/* (→L0 only: security)
L1  state & knowledge
    state.mjs · budget.mjs · telemetry.mjs · journal.mjs · memory.mjs · remediation.mjs
    evidence.mjs · assertions.mjs · flaky-ledger.mjs · dag-engine.mjs · prompt-guard.mjs
    role-resolver.mjs · web-templates.mjs · task-optimizer.mjs · mcp-progress.mjs
    webhook.mjs · scaffold.mjs · review-repair.mjs · wizard-oracle.mjs · mcp.mjs*
L2  engine
    engine/* (gate, verify-pipeline, repair, dispatch, queue-run, fingerprint,
    pr-description, server-probe) · router.mjs → provider (via providers/ facade)
L3  applications
    index.mjs (frozen facade) · bin/* (agentctl→cli/, init.js, mcp-server.mjs)
    scripts/* (→ src/ + scripts/utils.mjs) · src/ops/* · src/ux/* · wizards
```
(`*` `mcp.mjs` sits between L1 and L2: it imports `engine.mjs` one-way.)

**Directed edges for the new modules (all one-way, verified acyclic):**

```
cli/registry.mjs ──lazy import──▶ cli/commands/*.mjs ──▶ engine/*, providers/*,
                                              src/* (L0/L1), scripts/jules-scan-todos.mjs
cli/context.mjs ──▶ config.mjs, journal.mjs, version.mjs
cli/output.mjs  ──▶ (none, pure)
cli/help.mjs    ──▶ version.mjs
engine/gate.mjs ──▶ verify-pipeline.mjs, server-probe.mjs, repair.mjs (gateFn: its own fn),
                    config, security, git, state, budget, evidence, assertions,
                    flaky-ledger, remediation, memory, telemetry
engine/verify-pipeline.mjs ──▶ git (runCmd), security (redactSecrets), flaky-ledger,
                               assertions, evidence (sha256), config
engine/repair.mjs ──▶ providers (facade), state (withBudget, rollback), budget,
                      remediation, memory, git, telemetry, fingerprint.mjs
                      └─ lazy ─▶ engine/gate.mjs  (DEFAULT verify only, at call time)
engine/dispatch.mjs ──▶ router.mjs, providers, state, budget, security, prompt-guard,
                        memory, remediation, role-resolver, config, telemetry,
                        wizard-oracle (dynamic), fingerprint.mjs
engine/queue-run.mjs ──▶ dispatch.mjs, state, config, git
providers/index.mjs ──▶ providers/{presets, errors, token-pool, interpolate,
                               transport, jules, jules-session, exec}
providers/jules.mjs, jules-session.mjs ──▶ transport, token-pool, errors, interpolate
providers/exec.mjs ──▶ errors, interpolate, security
providers/failover.mjs ──▶ errors (taxonomy only — no adapter import)
providers/syntax-verify.mjs ──▶ security (redactSecrets)
```

### 3.2 The one new cycle risk, and its fix

Today `gate()` and `repair()` live in one file: `gate --fix` calls `repair()`, and
`repair()` re-runs `gate()` after each attempt. Splitting them naively produces a
**static import cycle** `gate.mjs → repair.mjs → gate.mjs`. Node would tolerate it,
but it is exactly what this refactor exists to eliminate.

**Fix — dependency inversion (no behavior change):**

1. `repair(failure, opts)` accepts `opts.gateFn` (a `(gateOpts) => Promise<gateResult>`).
2. `gate()` passes itself: `await repair(failingCmd, { …, gateFn: gate })`.
3. Direct callers of `repair()` (tests, MCP, SDK) get the identical default via a
   **lazy** `await import("./gate.mjs")` — resolved at call time, so the *static*
   module graph is: `gate.mjs → repair.mjs` only. No cycle at load time; runtime
   semantics (repair re-runs the real gate with the same config) are byte-identical.

This is the **only** structural change in the entire refactor; every other move is
verbatim.

### 3.3 Migration steps (each step = one commit, `npm test` + `npm run lint` green)

**Step 0 — Baseline lock.** Run full suite; record test count (doc-sync compares
README against it — keep README in sync only via `npm run release`, never by hand).
Confirm baseline: full suite green (71 test files), 0 failures, `node scripts/doc-sync-check.mjs` green.

**Step 1 — `src/providers/` split.**
Create `providers/{presets,errors,token-pool,interpolate,transport,jules,jules-session,exec,failover,syntax-verify,index}.mjs` by **moving** the code (verbatim, with the shared-HTTP helpers extracted into `transport.mjs` — the extraction is mechanical: 4 call sites share identical timeout/redact/classify/parse logic; see §4.5 skeleton). Rewrite `src/provider.mjs` as the facade.
*Verification:* `npm test` (esp. `provider-hardening`, `v027-features`, `adversarial*`, `router`, `lifecycle-harvest`); `node -e "import('./index.mjs').then(m => console.log(Object.keys(m).length))"` → 208.

**Step 2 — `src/engine/` split.**
Create `engine/{gate,verify-pipeline,repair,dispatch,queue-run,fingerprint,pr-description,server-probe}.mjs`; apply the `gateFn` inversion (§3.2); rewrite `src/engine.mjs` as the facade including the legacy re-export block (A3).
*Verification:* `npm test` (esp. `engine`, `engine-assertions`, `ooda_thrash`, `tiered-verification`, `flaky-ledger`, `lifecycle-harvest`, `budget`, `spore-memory`, `server-probe`, `v1-readiness`, `kit`); CLI smoke: `agentctl gate --json` on a clean tree → exit 0.

**Step 3 — `src/cli/` extraction.**
Create `cli/{context,help,output,registry}.mjs` + `cli/commands/*.mjs` (31 commands, one module each, move-verbatim with `ctx.root`/`ctx.config` substitution); apply A1 (`assert.mjs` imports `src/assertions.mjs` + `src/config.mjs` directly, dropping the `../index.mjs` back-edge); rewrite `bin/agentctl.mjs` as the thin entry, **keeping `export const VERSION = KIT_VERSION`** (doc-sync) and re-exporting `formatBudgetLine`/`printHelp` for the published surface.
*Verification:* CLI smoke matrix (§6) + `npm test` + `node scripts/doc-sync-check.mjs`.

**Step 4 — Shim consolidation + scratch deletion.**
Repoint the 5 shim importers (§1.2 table), delete `src/rules_budget.mjs`,
`src/asset_integrity.mjs`, `src/execution_envelope.mjs`, and `deep-think-results.md`
(D1). Optionally rename the two underscore test files.
*Verification:* `npm test`; `git grep -n "rules_budget\|asset_integrity\|execution_envelope" -- src scripts bin` → only the hyphenated spellings remain (plus the assertion-type string literals `"asset_integrity"`/`"rules_budget"` in `src/assertions.mjs`, which are **data** — stage names in task envelopes — and must NOT be renamed).

**Step 5 — Wave A dead-export removal** (§1.3 table).
*Verification:* `npm test` + `npm run lint` (eslint `no-unused-vars` is unaffected by export removal; this confirms no hidden internal use).

**Step 6 — Phase 2 splits** (§2.3), one file per commit, facade pattern throughout.
*Verification per commit:* `npm test`, `npm run lint`, doc-sync, `npm pack --dry-run`
(tarball content check: no leftover shim files, new subdirs included via `files: ["src/"]`).

**Step 7 — Wave B demotions** (next minor release, CHANGELOG entry naming each symbol;
the frozen-208 test still passes because none of these symbols are in `index.mjs`).

**Step 8 — Phase 3 (future major, tracked separately):** migrate the 6 `scripts/`
functions behind `index.mjs`'s "Legacy SDK shims" into `src/` (A2); deprecate
underscore import paths if any remain; consider consolidating `bin/init.js` into
`agentctl init` behind a compat shim.

### 3.4 Export mapping — frozen 208 → new home

`index.mjs` is **unchanged**; every specifier still resolves. Where a specifier now
lands through a facade, the final home is shown. (Blocks 1–5, 7–9, 11–19, 21–44 are
**unchanged files** — listed for completeness of the 208.)

| index.mjs block (specifier) | Symbols | Final home after refactor |
|---|---|---|
| `./src/config.mjs` (×2) | `loadConfig, parseYaml, detectStack, resolveVerify, resolveRoot, normalizePath, canonicalizePath, TIER_PRESETS` + `VENDOR_TIERS, FALLBACK_TIER` | unchanged (Phase 2: via `config.mjs` facade) |
| `./src/security.mjs` | `shannonEntropy, redactSecrets, anonymizePii, matchesGlob, checkScope, scanDiff, hasEncodedSecret, checkEdgeRuntimeImports, checkCrossPackageImports` | unchanged (Phase 2: facade) |
| `./src/prompt-guard.mjs` | `sanitizeUntrustedData, buildAgentEnvelope` | unchanged |
| `./src/mcp.mjs` | `isolateMcpStdout, writeMcpFrame` | unchanged (Phase 2: facade) |
| `./src/git.mjs` | `git, runCmd, resolveBase, changedFiles, diffBytes, diffText` | unchanged |
| `./src/provider.mjs` | `createProvider, createFailoverProvider, createSyntaxVerifiedProvider, JULES_PRESET, CLAUDE_PRESET, CODEX_PRESET, MissingApiKeyError, ProviderRateLimitError, ProviderUnavailableError, ProviderSchemaError, parseRetryAfter` | **facades:** `createProvider`→`providers/index.mjs`, `createFailoverProvider`→`providers/failover.mjs`, `createSyntaxVerifiedProvider`→`providers/syntax-verify.mjs`, presets→`providers/presets.mjs`, errors+`parseRetryAfter`→`providers/errors.mjs` |
| `./src/router.mjs` | `resolveRoutedProvider` | unchanged (now imports provider via `provider.mjs` facade) |
| `./src/stack-detector.mjs` | `detectPolyglotStack, resolveWorkspaceBoundary, bootstrapZeroTestRepo, findSubprojectRoot, detectCrossPackageBoundaryViolations, detectCircularDependencies` | unchanged (Phase 2: facade) |
| `./src/state.mjs` | 21 symbols (`appendLedger, readLedger, verifyLedgerIntegrity, reserveBudget, reserveBudgetAtomic, commitBudgetReservation, rollbackBudgetReservation, withBudget, checkDailyBudget, scanBudgetWindow, getLedgerPathsInWindow, ROLLING_WINDOW_MS, acquireLock, releaseLock, lockStatus, getLockDir, withVfsMutex, MutexTimeoutError, BudgetError, isPidAlive, getProcessStartTime, parseProcStat`) | unchanged (Phase 2: facade) |
| `./src/engine.mjs` (×2) | `gate, dispatch, repair, run, fingerprintFailureState, isTaskFile` + `synthesizePrDescription, probeDevServer` | **facade:** `gate`→`engine/gate.mjs`, `dispatch`→`engine/dispatch.mjs`, `repair`→`engine/repair.mjs`, `run`/`isTaskFile`→`engine/queue-run.mjs`, `fingerprintFailureState`→`engine/fingerprint.mjs`, `synthesizePrDescription`→`engine/pr-description.mjs`, `probeDevServer`→`engine/server-probe.mjs` |
| `./src/envelope.mjs` | `validateEnvelope` | unchanged |
| `./src/execution-envelope.mjs` | `createExecutionEnvelope, verifyExecutionEnvelope, freezeExecutionEnvelope, hashExecutionEnvelope` | unchanged (shim S3 deleted — this *is* the canonical) |
| `./src/asset-integrity.mjs` | `checkAssetIntegrity` | unchanged (shim S2 deleted — canonical) |
| `./src/risk.mjs` | `classifyRiskTier, RISK_TIERS` | unchanged |
| `./src/remediation.mjs` | `recordRemediation, queryRemediations` | unchanged |
| `./src/dag-engine.mjs` (×2) | `DagExecutor, DagCycleError` + `executeQueueDag, resolveAffectedTests` | unchanged (Phase 2: facade) |
| `./src/journal.mjs` | `journalIntent, journalDone, reapOrphanedIntents, reapStaleMutexDirs` | unchanged |
| `./scripts/command-resolver.mjs` | `resolveProjectCommands, resolveWorkspaceExecutionBoundary` | unchanged (A2: Phase 3) |
| `./scripts/jules-self-audit.mjs` | `runSelfAudit, runPreflightSandbox` | unchanged (A2: Phase 3; Wave A removes `logAuditMetrics`) |
| `./scripts/jules-scan-todos.mjs` | `scanCodebaseForTodos, runScanner` | unchanged (A2: Phase 3) |
| `./scripts/jules-dispatch.mjs` | `getDynamicGuardrails, dispatchTask` | unchanged (A2: Phase 3; `runPreflightStaticCheck` stays exported — used by `test/kit.test.mjs`) |
| `./scripts/jules-queue-runner.mjs` | `classifyQueueFailure` | unchanged (A2: Phase 3) |
| `./scripts/utils.mjs` | `extractPrUrls, auditSessions, buildSyncManifest, pushReservationManifest` | unchanged (A2: Phase 3; Wave A removes 7 dead exports) |
| `./src/tui.mjs` | `isTTY, styleText, select, multiSelect, input, confirm, secretInput, spinner, ANSI` | unchanged (Phase 2: facade) |
| `./src/wizard-oracle.mjs` | `detectStackOracles, runVerificationProbe` | unchanged |
| `./src/wizard-init.mjs` (×2) | `planInit, loadPresets, runInitWizard, TIER_PROFILES, BUILTIN_PRESETS` + `tierOptions` | unchanged |
| `./src/wizard-task.mjs` (×2) | `planTaskCreate, runTaskCreateWizard, GUARDRAIL_FOOTER, buildGuardrailFooter` + `resolveRolePrompt` | unchanged |
| `./src/task-optimizer.mjs` | `scorePromptFalsifiability, optimizeTaskPrompt, levenshteinDistance, extractPathTokens` | unchanged |
| `./src/ops/checkpoint.mjs` | `createCheckpoint, restoreCheckpoint, listCheckpoints, pruneCheckpoints, CheckpointError` | unchanged (`getCheckpointDir` → Wave B) |
| `./src/webhook.mjs` | 14 symbols (`dispatchEscalation, verifySignature, parseWebhookPayload, routeWebhookEvent, createWebhookServer, flushEscalationDigest, getEscalationDigestStatus, clearEscalationDigest, bufferEscalationIncident, loadEscalationDigest, recordInterruption, countRecentInterruptions, DEFAULT_CRITICAL_REASONS, DIGEST_BATCH_LIMIT`) | unchanged (Phase 2: facade) |
| `./src/ops/tdd-generator.mjs` | `scaffoldTddTest, runTddCycle, TddError` | unchanged |
| `./src/memory.mjs` | `recordLearning, loadLearnings, hydratePrompt, harvestFailure, getLearningsPath, getSystemLearningsMdPath` | unchanged |
| `./src/ops/ide-scaffold.mjs` | `scaffoldIdeConfig, IdeScaffoldError` | unchanged (path pinned) |
| `./src/evidence.mjs` | 9 symbols (`computeFileHash, computeDirectoryHash, generateEvidenceManifest, writeEvidenceManifest, loadEvidenceManifest, verifyEvidenceManifest, generateEvidenceMarkdown, computeEvidenceHash, exportJsonReport`) | unchanged (Phase 2: facade) |
| `./src/assertions.mjs` | `assertDirSize, assertFileSize, assertFilePatterns, assertFileExists, runAssertion, formatBytes, resolveBytesLimit` | unchanged (Phase 2: facade) |
| `./src/budget.mjs` | `resolveDailyLimit, budgetStatus, readObservedCeiling, readActiveCeiling, recordObservedCeiling, isDailyQuotaRejection, listOpenReservations, releaseOpenReservations, resolveConcurrency, resolveAmbientIdentity, CEILING_FILE` | unchanged |
| `./src/version.mjs` | `KIT_VERSION` | unchanged (path pinned) |
| `./src/flaky-ledger.mjs` | 9 symbols (`wilsonScoreInterval, computeOscillation, recordVerifyRun, readVerifyRuns, flakyVerdict, listQuarantinedTests, clearFlakyLedger, synthesizeFlakyHealingTask, runFlakyHealingSwarm`) | unchanged |
| `./src/ops/handover.mjs` | `createHandover, loadHandover, listHandovers, pruneHandovers, formatHandoverPromptContext, getHandoverDir, HandoverError` | unchanged |

**Total: 208/208 covered. `index.mjs` diff = 0 bytes.**

---

## 4. Drop-in Scaffolding & Code Skeletons

Conventions:
- `// MOVE: <file>:<start>–<end>` marks verbatim code moved from the monolith (line
  numbers refer to the current v0.42.0 file). No logic is rewritten.
- Every new module imports only `node:` builtins + relative paths (zero-dep invariant).
- Handler contract for `src/cli/commands/*`:
  `export async function <name>Command(ctx, argv, invokedAs) → number | undefined`,
  where `ctx = { root, config, version, argv }`, `argv = process.argv.slice(2)`,
  `invokedAs` is the argv[0] spelling the user typed (aliases: `create`, `gate`,
  `audit`, …). Returning `undefined` exits 0; the registry applies `process.exit`.
  Each handler keeps its own `parseArgs` call (options sets differ per command today).

### 4.1 `bin/agentctl.mjs` — new thin entry (~95 lines, full code)

```js
#!/usr/bin/env node
/**
 * agentctl — CLI entry point.
 *
 * Command implementations live in src/cli/commands/*.mjs, wired by
 * src/cli/registry.mjs. This file (1) pins `export const VERSION = KIT_VERSION`
 * which the doc-sync gate asserts in this exact file, (2) serves the
 * pre-dispatch paths (bare, --help, --version), (3) dispatches everything else
 * to the registry, and (4) owns the top-level exit-code/cancellation contract.
 *
 * CLI surface (31 commands, flags, exit codes 0–8) is frozen — this refactor
 * moves code, it does not change behavior.
 */

import { KIT_VERSION } from "../src/version.mjs";
import { printHelp } from "../src/cli/help.mjs";
import { dispatchCommand } from "../src/cli/registry.mjs";

export const VERSION = KIT_VERSION;

// Published surface preserved: bin/ ships in the npm tarball.
export { formatBudgetLine } from "../src/cli/output.mjs";
export { printHelp };

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  // Bare `agentctl` answers "what do I do next" (see src/ops/next-step.mjs).
  if (!command) {
    const { handler: runBareCommand } = await import("../src/cli/commands/home.mjs");
    const { createContext } = await import("../src/cli/context.mjs");
    await runBareCommand(createContext(), args, command);
    process.exit(0);
  }

  if (command === "version" || command === "--version" || command === "-v") {
    console.log(`agentctl v${VERSION}`);
    process.exit(0);
  }

  // Intercept --help / -h on any subcommand (e.g. `agentctl init --help`)
  const subArgs = args.slice(1);
  if (subArgs.includes("--help") || subArgs.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  process.exit(await dispatchCommand(command, args) ?? 0);
}

main().catch((err) => {
  if (err.name === "WizardCancelledError" || err.code === 130 || (err instanceof Error && err.message?.includes("cancelled by user"))) {
    console.log(`\n🛑 ${err.message || "Operation cancelled by user."}`);
    process.exit(130);
  }
  console.error(`[FATAL ERROR] ${err.message}`);
  const exitCode = typeof err.code === "number" ? err.code : 1;
  process.exit(exitCode);
});
```
(Implementation note: the bare-command block moves verbatim to
`src/cli/commands/home.mjs` — `bin/agentctl.mjs` stays free of `resolveRoot`/config
imports, so `agentctl` outside a repo remains as fast and side-effect-light as today.)

### 4.2 `src/cli/context.mjs` (~55 lines, full code)

```js
import { loadConfig, resolveRoot } from "../config.mjs";
import { reapOrphanedIntents, reapStaleMutexDirs } from "../journal.mjs";
import { KIT_VERSION } from "../version.mjs";

/**
 * Shared command context. MOVE of the main() preamble:
 *   bin/agentctl.mjs lines 224–227 (root resolution + journal reaping + config load).
 * Journal reaping stays eager and synchronous exactly as today.
 */
export function createContext() {
  const root = resolveRoot();
  reapOrphanedIntents(root);
  reapStaleMutexDirs(root);
  const config = loadConfig(root);
  return Object.freeze({
    root,
    config,
    version: KIT_VERSION,
    argv: process.argv.slice(2),
  });
}
```

### 4.3 `src/cli/registry.mjs` (~130 lines, full code)

```js
import { createContext } from "./context.mjs";
import { printHelp } from "./help.mjs";

/**
 * Command registry: argv[0] (+ aliases) → handler module, lazily imported.
 *
 * Lazy import preserves today's startup profile: `agentctl version` must not
 * pay for the wizard/dashboard/MCP subsystems (the original switch used
 * `await import(...)` inside most cases for the same reason).
 *
 * Handler contract:
 *   export async function <name>Command(ctx, argv, invokedAs) → number | undefined
 */
const COMMANDS = [
  ["dispatch",        { aliases: ["create"],            module: "./commands/dispatch.mjs" }],
  ["check",           { aliases: ["gate", "audit"],      module: "./commands/gate.mjs" }],
  ["assert",          { module: "./commands/assert.mjs" }],
  ["queue",           { module: "./commands/queue.mjs" }],
  ["swarm",           { module: "./commands/swarm.mjs" }],
  ["clean",           { module: "./commands/clean.mjs" }],
  ["budget",          { module: "./commands/budget.mjs" }],
  ["lock",            { module: "./commands/lock.mjs" }],
  ["doctor",          { module: "./commands/doctor.mjs" }],
  ["bootstrap",       { module: "./commands/bootstrap.mjs" }],
  ["review-repair",   { module: "./commands/review-repair.mjs" }],
  ["dashboard",       { module: "./commands/dashboard.mjs" }],
  ["init",            { module: "./commands/init.mjs" }],
  ["task",            { module: "./commands/task.mjs" }],
  ["status",          { module: "./commands/status.mjs" }],
  ["scan",            { module: "./commands/scan.mjs" }],
  ["rollback",        { module: "./commands/rollback.mjs" }],
  ["handover",        { module: "./commands/handover.mjs" }],
  ["resume",          { module: "./commands/session.mjs" }],
  ["plan",            { module: "./commands/session.mjs" }],
  ["approve",         { module: "./commands/session.mjs" }],
  ["session",         { module: "./commands/session.mjs" }],
  ["pr",              { module: "./commands/pr.mjs" }],
  ["escalate",        { module: "./commands/escalate.mjs" }],
  ["flaky",           { module: "./commands/flaky.mjs" }],
  ["test-gen",        { module: "./commands/test-gen.mjs" }],
  ["mcp",             { module: "./commands/mcp.mjs" }],
  ["hydrate",         { module: "./commands/memory.mjs" }],
  ["harvest",         { module: "./commands/memory.mjs" }],
  ["learning",        { module: "./commands/memory.mjs" }],
  ["evidence",        { module: "./commands/evidence.mjs" }],
  ["rules",           { module: "./commands/rules.mjs" }],
];

const ALIAS_TO_PRIMARY = new Map();
for (const [name, def] of COMMANDS) {
  ALIAS_TO_PRIMARY.set(name, name);
  for (const a of def.aliases || []) ALIAS_TO_PRIMARY.set(a, name);
}

export async function dispatchCommand(command, argv) {
  const primary = ALIAS_TO_PRIMARY.get(command);
  if (!primary) {
    // MOVE: bin/agentctl.mjs lines 1964–1968 (unknown command → stderr + help + exit 1)
    console.error(`Unknown command: ${command}`);
    printHelp();
    return 1;
  }
  const entry = COMMANDS.find(([n]) => n === primary)[1];
  const { handler } = await import(entry.module);
  const ctx = createContext();
  return handler(ctx, argv, command);
}
```
(Implementation note: every command module exports exactly one
`handler(ctx, argv, invokedAs)` — uniform naming keeps the registry trivially
mechanical. The alias set above exactly reproduces the current
`case "dispatch": case "create":` fall-throughs.)

### 4.4 `src/cli/output.mjs` + `src/cli/help.mjs` (move-verbatim)

```js
// src/cli/output.mjs
// MOVE (verbatim, no logic change):
//   formatBudgetLine      bin/agentctl.mjs lines 26–34   (+ its doc comment)
//   resolvePromptInput    bin/agentctl.mjs lines 113–127
//   reportRunOutcome      bin/agentctl.mjs lines 138–162
//   VERIFY_OUTPUT_TAIL_LINES + printVerifyFailure  bin/agentctl.mjs lines 171–188
export function formatBudgetLine(b) { /* MOVE */ }
export function resolvePromptInput(values, positionals = []) { /* MOVE */ }
export function reportRunOutcome(outcome) { /* MOVE */ }
export function printVerifyFailure(failure) { /* MOVE */ }
```
```js
// src/cli/help.mjs
import { KIT_VERSION } from "../version.mjs";

/**
 * MOVE (verbatim): printHelp() template, bin/agentctl.mjs lines 36–111.
 * The template literal is unchanged — it is the frozen CLI reference, and the
 * doc-sync gate greps bin/agentctl.mjs for VERSION derivation, not for help text.
 */
export function printHelp() { /* MOVE */ }
```

### 4.5 Representative command handlers

```js
// src/cli/commands/dispatch.mjs   (~115 lines)
import { parseArgs } from "node:util";
import { dispatch } from "../../engine/dispatch.mjs"; // was: ../src/engine.mjs (facade-equivalent)
import { resolvePromptInput } from "../output.mjs";

export async function handler(ctx, argv, invokedAs) {
  const { root, config } = ctx;
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    options: {
      title: { type: "string", short: "t" },
      prompt: { type: "string", short: "p" },
      "prompt-file": { type: "string", short: "f" },
      role: { type: "string", short: "r" },
      tier: { type: "string" },
      source: { type: "string", short: "s" },
      branch: { type: "string", short: "b" },
      repoless: { type: "boolean" },
      "auto-pr": { type: "boolean" },
      "require-plan-approval": { type: "boolean" },
      "check-premise": { type: "boolean" },
      idempotent: { type: "boolean" },
      author: { type: "string" },
      "dry-run": { type: "boolean", short: "d" },
      json: { type: "boolean", short: "j" },
    },
    allowPositionals: true,
  });

  // MOVE (verbatim): bin/agentctl.mjs lines 256–345 —
  // prompt resolution + role validation + task object + dispatch() call +
  // success/dry-run/ALREADY_SATISFIED banners + JSON output + exit-code mapping.
  // Substitution only: `root`/`config` come from ctx.
}
```

```js
// src/cli/commands/gate.mjs   (~105 lines)
import { parseArgs } from "node:util";
import { gate } from "../../engine/gate.mjs";
import { printVerifyFailure } from "../output.mjs";

export async function handler(ctx, argv, invokedAs) {
  const { root, config } = ctx;
  const { values } = parseArgs({ /* MOVE options table, lines 352–363 */ });

  // MOVE: mode selection (lines 365–369) + gate() call (lines 371–379).
  // MOVE: the entire exit-code hint ladder (lines 380–436) verbatim —
  // it encodes the frozen exit codes 0/3/4/5/6/8 semantics.
}
```

```js
// src/cli/commands/assert.mjs   (~90 lines) — carries fix A1
import { parseArgs } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { runAssertion } from "../../assertions.mjs";   // A1: was: ../index.mjs
import { parseYaml } from "../../config.mjs";           // A1: was: ../index.mjs

export async function handler(ctx, argv, invokedAs) {
  const { root } = ctx;
  // MOVE (verbatim): bin/agentctl.mjs lines 442–524,
  // with the two direct imports above replacing the index.mjs back-edge.
  // NOTE: `await import("../src/evidence.mjs")` for --json-report stays as-is.
}
```

```js
// src/cli/commands/session.mjs  (~120 lines) — shared provider-call pattern
// Handles: resume | plan approve | approve | session get (argv[0] = invokedAs).
import { parseArgs } from "node:util";
import { createProvider } from "../../providers/index.mjs"; // via provider facade equivalent

export async function handler(ctx, argv, invokedAs) {
  const { root, config } = ctx;
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    options: {
      response: { type: "string", short: "r" },      // resume only
      "dry-run": { type: "boolean", short: "d" },
      json: { type: "boolean", short: "j" },
    },
    allowPositionals: true,
  });

  // MOVE (verbatim, 4 blocks sharing one shape — session ID extraction,
  // createProvider(config.provider || "jules", config), the provider call
  // (resume / approvePlan / getSession), JSON or human output, exit code):
  //   resume        bin/agentctl.mjs lines 1233–1272
  //   plan approve  bin/agentctl.mjs lines 1275–1311
  //   approve       bin/agentctl.mjs lines 1314–1345
  //   session get   bin/agentctl.mjs lines 1348–1384
}
```

```js
// src/cli/commands/rules.mjs  (~75 lines) — post-shim-consolidation
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkRulesBudget, compileRules } from "../../rules-budget.mjs"; // S1: was ../src/rules_budget.mjs

export async function handler(ctx, argv, invokedAs) {
  const { root } = ctx;
  // MOVE (verbatim): bin/agentctl.mjs lines 1895–1961
  // (rules check | rules compile, including the dynamic node:fs/node:path imports
  //  which become top-level static imports — equivalent behavior).
}
```

*Remaining 24 command modules* follow the identical pattern with the MOVE ranges
from the §2.2 tree (one `case` block each; `task.mjs` is the largest at ~170 lines
and keeps its internal `create|template|optimize` if/else chain — splitting the
three subcommands into separate files would add indirection for < 350 lines, so
the single module is the right granularity).

### 4.6 `src/engine.mjs` — compatibility facade (~65 lines, full code)

```js
/**
 * src/engine.mjs — compatibility facade for the engine split.
 *
 * The engine was decomposed into focused modules under src/engine/ (all < 300
 * lines). This file re-exports the COMPLETE historical surface so every
 * existing import specifier (bin/, scripts/, index.mjs, test/) keeps working
 * unchanged:
 *
 *   - the 10 engine-owned exports used by index.mjs and consumers, and
 *   - the legacy re-export block (frozen into the public surface via index.mjs).
 */

// Engine-owned surface
export { gate } from "./engine/gate.mjs";
export { repair, OODACircuitBreaker } from "./engine/repair.mjs";
export { dispatch, checkTaskPremise } from "./engine/dispatch.mjs";
export { run, isTaskFile } from "./engine/queue-run.mjs";
export { fingerprintFailureState } from "./engine/fingerprint.mjs";
export { synthesizePrDescription } from "./engine/pr-description.mjs";
export { probeDevServer } from "./engine/server-probe.mjs";
// pollSessionState: NOT in the frozen 208, imported by nobody (verified).
// Kept re-exported through one deprecation cycle, removed in Wave B.
export { pollSessionState } from "./engine/repair.mjs";

// Legacy SDK shims for backward compatibility (A3: block moved verbatim)
export {
  recordVerifyRun,
  readVerifyRuns,
  flakyVerdict,
} from "./flaky-ledger.mjs";
export { sanitizeUntrustedData } from "./prompt-guard.mjs";
export { resolveAffectedTests, executeQueueDag } from "./dag-engine.mjs";
export { recordRemediation, queryRemediations, harvestFailureRecord, hydrateMemory } from "./remediation.mjs";
export { hydratePrompt, harvestFailure } from "./memory.mjs";
export { resolveRolePrompt } from "./role-resolver.mjs";
export { isConcurrencyGroupLocked } from "./state.mjs";
export {
  computeDirectoryHash,
  generateEvidenceManifest,
  writeEvidenceManifest,
  verifyEvidenceManifest,
  generateEvidenceMarkdown,
  exportJsonReport,
} from "./evidence.mjs";
export { runAssertion } from "./assertions.mjs";
```

### 4.7 `src/engine/gate.mjs` (~260 lines, skeleton)

```js
// src/engine/gate.mjs
// Gatekeeper verification engine (Phase 1: Scope, 2: Payload, 3: Secrets, 4: Verify).
// FAILS CLOSED ON GIT OR CONFIG ERRORS.
import { loadConfig, parseYaml, normalizeScope } from "../config.mjs";
import { checkScope, scanDiff } from "../security.mjs";
import { changedFiles, diffBytes, diffText, showFromOrigin, runCmd } from "../git.mjs";
import { recordVerifyRun, readVerifyRuns, flakyVerdict } from "../flaky-ledger.mjs";
import { computeDirectoryHash, generateEvidenceManifest, writeEvidenceManifest, exportJsonReport, sha256 } from "../evidence.mjs";
import { withBudget } from "../state.mjs";
import { appendTelemetry } from "./telemetry-safe.mjs"; // tiny wrapper: MOVE of engine.mjs lines 57–63
import { buildVerifyStages, runVerifyStages } from "./verify-pipeline.mjs";
import { probeDevServer } from "./server-probe.mjs";
import { repair } from "./repair.mjs";

/**
 * MOVE (verbatim): src/engine.mjs lines 148–529, with the stage loop
 * (lines ~246–415) replaced by:
 *
 *   const stagesToRun = buildVerifyStages(trustedVerify);          // MOVE lines 250–280
 *   const stageOutcome = await runVerifyStages({                   // MOVE loop body 282–413
 *     root, config, trustedVerify, testEnv, verifyTimeout,
 *     stagesToRun, executionRecords,
 *   });
 *   ({ testResult, buildResult, failingCmd, flakyVerdictResult } = stageOutcome);
 *
 *   - flaky QUARANTINED early-return (code 8) stays in gate.mjs (it builds
 *     phase records + telemetry) and consumes stageOutcome.flakyVerdictResult.
 *   - teardown (finally) stays in gate.mjs: runCmd(trustedVerify.teardown, …).
 *
 * CYCLE BREAKER (§3.2): the --fix branch becomes
 *   const repairs = await repair(failingCmd, {
 *     config, root, signal: opts.signal, progressBus, progressToken,
 *     gateFn: gate,                       // ← dependency inversion
 *   });
 */
export async function gate(opts = {}) {
  // MOVE lines 149–245 (setup + git resolution + trusted config from origin +
  // scope phase + payload phase + secrets phase + preTestHash)
  // …
}
```

### 4.8 `src/engine/verify-pipeline.mjs` (~250 lines, skeleton)

```js
// src/engine/verify-pipeline.mjs
// The verify stage pipeline: setup → lint → unit → fuzz → invariant → e2e → build,
// plus assertion stages, output redaction, execution records, and flaky detection.
import { runCmd } from "../git.mjs";
import { redactSecrets } from "../security.mjs";
import { runAssertion } from "../assertions.mjs";
import { sha256 } from "../evidence.mjs";
import { recordVerifyRun, readVerifyRuns, flakyVerdict } from "../flaky-ledger.mjs";
import { fingerprintFailureState } from "./fingerprint.mjs";

/** MOVE (verbatim): stage-list construction, src/engine.mjs lines ~250–280. */
export function buildVerifyStages(trustedVerify) { /* MOVE */ }

/**
 * MOVE (verbatim): the stage for-loop, src/engine.mjs lines ~282–413.
 * Returns { testResult, buildResult, failingCmd, flakyVerdictResult, quarantined }.
 * `quarantined` carries the flaky verdict so gate.mjs can emit the phase record,
 * telemetry, and the code-8 early return — the loop itself never returns.
 */
export async function runVerifyStages({ root, config, trustedVerify, testEnv, verifyTimeout, stagesToRun, executionRecords }) {
  /* MOVE */
}
```

### 4.9 `src/engine/repair.mjs` (~285 lines, skeleton)

```js
// src/engine/repair.mjs
// OODA auto-repair loop with a sliding-window circuit breaker against thrash.
import { loadConfig } from "../config.mjs";
import { createProvider, ProviderRateLimitError, ProviderUnavailableError } from "../provider.mjs";
import { withBudget, rollbackBudgetReservation } from "../state.mjs";
import { resolveAmbientIdentity } from "../budget.mjs";
import { diffText } from "../git.mjs";
import { recordRemediation, harvestFailureRecord } from "../remediation.mjs";
import { harvestFailure } from "../memory.mjs";
import { appendTelemetry } from "./telemetry-safe.mjs";
import { fingerprintFailureState } from "./fingerprint.mjs";

/** MOVE (verbatim): src/engine.mjs lines 531–581 (OODACircuitBreaker). */
export class OODACircuitBreaker { /* MOVE */ }

/**
 * MOVE (verbatim): src/engine.mjs lines 583–715, with ONE structural change —
 * the re-verification call:
 *
 *   before:  const gateRes = await gate({ root, config, fix: false, progressBus, progressToken });
 *   after:   const verify = opts.gateFn || defaultVerify;
 *            const gateRes = await verify({ root, config, fix: false, progressBus, progressToken });
 *
 * where  // CYCLE BREAKER: lazy so the static graph stays gate → repair only
 *        const defaultVerify = (o) => import("./gate.mjs").then((m) => m.gate(o));
 */
export async function repair(failure, opts = {}) { /* MOVE + inversion */ }

/** MOVE (verbatim): src/engine.mjs lines 744–801.
 *  Not in the frozen 208, imported by nobody — demoted to module-private in
 *  Wave B; the facade keeps re-exporting it through one deprecation cycle. */
export async function pollSessionState(provider, session, opts = {}) { /* MOVE */ }

/** MOVE (verbatim): src/engine.mjs lines 803–828 (was private; stays private). */
function buildRepairPrompt(failure, attempt, _config) { /* MOVE */ }
```

### 4.10 `src/engine/dispatch.mjs` / `queue-run.mjs` / `fingerprint.mjs` / `pr-description.mjs` / `server-probe.mjs` (skeletons)

```js
// src/engine/dispatch.mjs  (~180 lines)
// MOVE (verbatim):
//   checkTaskPremise   src/engine.mjs lines 717–742  (incl. dynamic import of wizard-oracle)
//   dispatch           src/engine.mjs lines 830–959
// Imports: config, security(redactSecrets), prompt-guard(buildAgentEnvelope,
// sanitizeUntrustedData), memory(hydratePrompt), remediation(hydrateMemory),
// role-resolver, router(resolveRoutedProvider), state(withBudget,
// rollbackBudgetReservation, checkDailyBudget), budget(resolveDailyLimit,
// recordObservedCeiling, isDailyQuotaRejection, resolveAmbientIdentity),
// provider errors, telemetry-safe.
export async function checkTaskPremise(task = {}, opts = {}) { /* MOVE */ }
export async function dispatch(task = {}, opts = {}) { /* MOVE */ }

// src/engine/queue-run.mjs  (~160 lines)
// MOVE (verbatim):
//   isTaskFile            src/engine.mjs lines 73–114
//   isSafeQueueFileName   src/engine.mjs lines 65–67   (stays private)
//   run                   src/engine.mjs lines 961–1059
// Imports: fs, path, config, state(getQueueDir, ensureDir, appendLedger,
// isConcurrencyGroupLocked), dag-engine(executeQueueDag), ./dispatch.mjs.
export function isTaskFile(fileName, queueDirOrContent = null) { /* MOVE */ }
export async function run(tasksOrOpts = {}, opts = {}) { /* MOVE */ }

// src/engine/fingerprint.mjs  (~45 lines)
// MOVE (verbatim): src/engine.mjs lines 116–146.
export function fingerprintFailureState(failure = {}, root = process.cwd()) { /* MOVE */ }

// src/engine/pr-description.mjs  (~90 lines)
// MOVE (verbatim): src/engine.mjs lines 1061–1127.
// Imports: dag-engine(resolveAffectedTests) only.
export function synthesizePrDescription(session = {}, gateResult = {}, options = {}) { /* MOVE */ }

// src/engine/server-probe.mjs  (~140 lines)
// MOVE (verbatim): src/engine.mjs lines 1129–1248 (probeDevServer + hydration
// panic list + process-group kill in finally). Imports: node:child_process only.
export async function probeDevServer(serverConfig = {}, root = process.cwd()) { /* MOVE */ }
```

### 4.11 `src/provider.mjs` — compatibility facade (~35 lines, full code)

```js
/**
 * src/provider.mjs — compatibility facade for the provider split.
 * Every historical specifier (`./provider.mjs`) resolves with the same names:
 * engine.mjs, router.mjs, bin/, index.mjs and tests are unchanged.
 */
export { createProvider } from "./providers/index.mjs";
export { createFailoverProvider } from "./providers/failover.mjs";
export { createSyntaxVerifiedProvider } from "./providers/syntax-verify.mjs";
export { JULES_PRESET, CLAUDE_PRESET, CODEX_PRESET, GEMINI_PRESET } from "./providers/presets.mjs";
export {
  MissingApiKeyError,
  ProviderRateLimitError,
  ProviderUnavailableError,
  ProviderSchemaError,
  parseRetryAfter,
} from "./providers/errors.mjs";
export { TokenPool } from "./providers/token-pool.mjs"; // internal+tests; Wave B keeps it (test/provider-hardening imports it)
```

### 4.12 `src/providers/*` skeletons

```js
// src/providers/presets.mjs  (~70 lines) — MOVE verbatim:
export const JULES_PRESET = { /* src/provider.mjs lines 58–76 */ };
export const CLAUDE_PRESET = { /* lines 78–84 */ };
export const CODEX_PRESET = { /* lines 86–93 */ };
export const GEMINI_PRESET = { /* lines 99–105 (incl. GEMINI_FLASH_MODEL env) */ };
export const NAMED_PRESETS = { /* lines 175–181 */ };
```

```js
// src/providers/errors.mjs  (~55 lines) — MOVE verbatim:
export class MissingApiKeyError extends Error { /* lines 107–113 */ }
export class ProviderRateLimitError extends Error { /* lines 115–122 */ }
export class ProviderUnavailableError extends Error { /* lines 124–131 */ }
export class ProviderSchemaError extends Error { /* lines 133–139 */ }
export function parseRetryAfter(header) { /* lines 141–152 */ }
```

```js
// src/providers/token-pool.mjs  (~90 lines) — MOVE verbatim: TokenPool class,
// lines 186–266 (fromEnv, getNextToken, markRateLimited, recordUsage, getInventory).

// src/providers/interpolate.mjs  (~25 lines) — MOVE verbatim:
export function interpolateString(template, data) { /* lines 154–157 */ }
export function interpolateDeep(node, data) { /* lines 159–171 */ }
```

```js
// src/providers/transport.mjs  (~150 lines)
// Shared HTTP machinery, extracted from the four near-identical call sites in
// createProvider's dispatch/resume/getSession/approvePlan (mechanical
// de-duplication — each helper is one of the existing code paths, verbatim):
import { ProviderRateLimitError, ProviderUnavailableError, ProviderSchemaError, parseRetryAfter } from "./errors.mjs";
import { redactSecrets } from "../security.mjs";

/** MOVE: the {token}-in-URL refusal (dispatch, lines 279–285). */
export function assertNoTokenInUrl(spec) { /* MOVE */ }

/**
 * MOVE: header interpolation + CRLF injection check, repeated 4× (lines 320–328
 * in dispatch; identical in resume/getSession/approvePlan).
 * Throws `CRITICAL: Header injection attempt detected in header "…"` on \r or \n.
 */
export function buildHeaders(spec, data, token) { /* MOVE one copy */ }

/** MOVE: fetch with AbortSignal.timeout + TimeoutError→ProviderUnavailableError(504)
 *  mapping (lines 358–371; identical shape at 3 other sites). */
export async function fetchWithTimeout(url, init, timeoutMs) { /* MOVE */ }

/** MOVE: `redactSecrets(token ? text.split(token).join("[REDACTED]") : text)`
 *  + 500-char cap (4 sites). */
export function redactErrorText(text, token) { /* MOVE */ }

/**
 * MOVE: the status-classification ladder, repeated 4×:
 *   429 → pool.markRateLimited + ProviderRateLimitError(retryAfterMs)
 *   5xx → ProviderUnavailableError
 *   404 → plain Error with .status (getSession/approvePlan)
 *   else → plain Error with .status
 */
export function classifyHttpError(status, text, res, { pool, token }) { /* MOVE */ }

/** MOVE: res.json() → ProviderSchemaError mapping (3 sites). */
export async function parseJsonObject(res, status) { /* MOVE */ }

/** MOVE: exponential-backoff retry loop used by getSession + approvePlan
 *  (lines 707–716 / 831–840: maxRetries, initialDelayMs * 2^(attempt-1)). */
export async function withBackoff(fn, { maxRetries = 3, initialDelayMs = 500 }) { /* MOVE */ }
```

```js
// src/providers/jules.mjs  (~260 lines)
// The HTTP session lifecycle (Jules API and any custom `type: "http"` spec).
import { buildHeaders, fetchWithTimeout, redactErrorText, classifyHttpError, parseJsonObject } from "./transport.mjs";
import { interpolateString, interpolateDeep } from "./interpolate.mjs";
import { MissingApiKeyError, ProviderRateLimitError, ProviderSchemaError } from "./errors.mjs";
import { redactSecrets } from "../security.mjs";

/**
 * MOVE (verbatim, assembled from the dispatch HTTP branch):
 *   - token resolution from pool / JULES_API_KEY / legacy GEMINI_API_KEY
 *   - dry-run shortcut (lines 305–325)
 *   - repoless/source/branch data assembly (lines 293–312)
 *   - token-rotation loop with schema-degradation retry (lines 327–471)
 *     — the 400-optimistic-degrade block (strip temperature/top_p/top_k,
 *       thinking_budget→thinking_level) moves verbatim, including the
 *       "re-derive error context from the retry response" comment
 *   - usage recording + JSON parse (lines 473–505)
 */
export function httpDispatch(providerSpec, config) {
  return async (task = {}, ctx = {}) => { /* MOVE */ };
}

/**
 * MOVE (verbatim): resume HTTP branch, lines 556–645 —
 * warm `:sendMessage` URL default, 400/404 cold-dispatch fallback with
 * `_warmFallback`/`_warmErrorStatus` markers, exec passthrough (lines 647–652).
 */
export function httpResume(providerSpec, config) {
  return async (sessionId, prompt = "", ctx = {}, task = null) => { /* MOVE */ };
}
```

```js
// src/providers/jules-session.mjs  (~230 lines)
// Session retrieval & plan approval over HTTP (the two GET/POST endpoints that
// share the backoff retry loop).
/**
 * MOVE (verbatim): getSession HTTP branch, lines 676–778 (url template default,
 * pool token, backoff via transport.withBackoff, 404/429/5xx classification,
 * exec shortcut `return { id, status: "completed" }` at line 780).
 */
export function httpGetSession(providerSpec, config) {
  return async (sessionId, ctx = {}) => { /* MOVE */ };
}

/**
 * MOVE (verbatim): approvePlan HTTP branch, lines 800–908
 * (`:approvePlan` URL default, POST body `JSON.stringify(ctx.body || {})`,
 * backoff, 404/429/5xx, exec shortcut at lines 910–912).
 */
export function httpApprovePlan(providerSpec, config) {
  return async (sessionId, ctx = {}) => { /* MOVE */ };
}
```

```js
// src/providers/exec.mjs  (~95 lines)
// Local CLI adapters: claude-code, codex, gemini-flash (spawnSync, no network).
import { spawnSync } from "node:child_process";
import { interpolateString } from "./interpolate.mjs";
import { redactSecrets } from "../security.mjs";

/** MOVE (verbatim): the exec dispatch branch, lines 507–543 —
 *  command split, promptViaStdin arg filtering, spawnSync with
 *  cwd=config._root, 900s timeout, 32MB buffer, redacted stderr on failure.
 *  All three vendor presets (CLAUDE/CODEX/GEMINI) share this one path;
 *  their differences are preset constants in presets.mjs, not code — which is
 *  why the split is per-transport (http/exec), not per-vendor. */
export function execDispatch(providerSpec, config) {
  return (task = {}, ctx = {}) => { /* MOVE */ };
}
export function execResume(providerSpec) {
  // MOVE: lines 647–652 — exec resume = dispatch with merged prompt.
  return (sessionId, prompt = "", ctx = {}, task = null) => { /* MOVE */ };
}
```

```js
// src/providers/failover.mjs  (~145 lines)
// Ordered failover router across providers (429/5xx-recoverable taxonomy).
import { ProviderRateLimitError, ProviderUnavailableError } from "./errors.mjs";
import { createProvider } from "./index.mjs";

/**
 * MOVE (verbatim): createFailoverProvider, lines 919–1058.
 * The recoverable-error predicate appears 4× (dispatch/resume/getSession/
 * approvePlan) — keep the 4 copies verbatim in Phase 1 (they differ:
 * getSession/approvePlan additionally treat 404 as recoverable); a shared
 * helper is a Phase-2 cleanup, not a Phase-1 behavior risk.
 */
export function createFailoverProvider(providers = ["jules"], config = {}) { /* MOVE */ }
```

```js
// src/providers/syntax-verify.mjs  (~130 lines)
// FAST-tier output verification: `node --check` on changed JS + escalation.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";
import { redactSecrets } from "../security.mjs";

const SYNTAX_CHECKABLE_EXTS = /* MOVE line 11 */;
export function listChangedSourceFiles(root) { /* MOVE lines 20–43 */ }
export function findSyntaxError(root, files) { /* MOVE lines 45–55 */ }

/** MOVE (verbatim): createSyntaxVerifiedProvider, lines 1060–1104 (incl. doc
 *  comment explaining the cost-router safety contract). */
export function createSyntaxVerifiedProvider(fastProvider, complexProvider, config = {}) { /* MOVE */ }
```

```js
// src/providers/index.mjs  (~95 lines)
// createProvider factory: spec validation + type→adapter wiring.
import { JULES_PRESET, NAMED_PRESETS } from "./presets.mjs";
import { MissingApiKeyError } from "./errors.mjs";
import { TokenPool } from "./token-pool.mjs";
import { assertNoTokenInUrl } from "./transport.mjs";
import { httpDispatch, httpResume } from "./jules.mjs";
import { httpGetSession, httpApprovePlan } from "./jules-session.mjs";
import { execDispatch, execResume } from "./exec.mjs";

/**
 * MOVE (verbatim): createProvider preamble, lines 268–289
 *   - pass-through of duck-typed provider objects (`spec.dispatch` function)
 *   - string → NAMED_PRESETS lookup, JULES_PRESET default
 *   - TypeError on non-object spec
 *   - assertNoTokenInUrl(spec)  [was inline, lines 279–285]
 * and the method-shape of the returned object (lines 290–917), with each method
 * body delegated to the extracted adapter:
 *
 *   return {
 *     name: providerSpec.name || "custom-provider",
 *     dispatch:  providerSpec.type === "http" ? httpDispatch(providerSpec, config) : execDispatch(providerSpec, config),
 *     resume:    providerSpec.type === "http" ? httpResume(providerSpec, config) : execResume(providerSpec),
 *     getSession: providerSpec.type === "http" ? httpGetSession(providerSpec, config) : ((id) => ({ id, status: "completed" })),
 *     approvePlan: providerSpec.type === "http" ? httpApprovePlan(providerSpec, config) : ((id) => ({ id, status: "approved", approved: true })),
 *     validate() { /* MOVE lines 909–916 *\/ },
 *   };
 *
 * The "Unsupported provider type" throw (lines 544, 654, 786, 914) is preserved
 * by making the exec/http shortcut return undefined for unknown types and
 * throwing in the factory — or, simpler and closer to today: keep the throw at
 * the end of each adapter. (Implementer's choice; behavior identical.)
 */
export function createProvider(spec = "jules", config = {}) { /* MOVE + wiring */ }
```

---

## 5. Backward-Compatibility Matrix

| Surface | Contract | How this refactor preserves it |
|---|---|---|
| **SDK (npm)** | `index.mjs` exports exactly 208 symbols (`test/api-surface.test.mjs`) | `index.mjs` is **not edited**. Its specifiers (`./src/engine.mjs`, `./src/provider.mjs`, …) resolve to the facades, which re-export every historical name. Post-refactor check: `Object.keys(await import("./index.mjs")).length === 208`. |
| **SDK deep imports** | `src/` ships in the tarball; consumers may `import "…/src/engine.mjs"` | Facades keep the full historical surface, **including** the legacy re-export block and `pollSessionState` (one deprecation cycle). |
| **CLI binary** | 31 commands + aliases, per-command flags, positional prompt forms, exit codes 0–8, `--help` on any subcommand, bare-invocation next-step, cancellation exit 130 | Handlers move verbatim; the registry reproduces every `case` fall-through alias; the exit-code hint ladder and the `[FATAL ERROR]` tail stay word-for-word. Smoke matrix below. |
| **Published bin surface** | `bin/agentctl.mjs` also exports `VERSION`, `formatBudgetLine`, `printHelp` | Kept as re-exports in the new thin entry (§4.1). |
| **package.json** | `bin` (5), `scripts` (20), `main`, `exports`, `files`, `engines` | **Zero changes** in Phase 1–2. New subdirs are covered by existing `files: ["src/", "bin/", "scripts/"]`. |
| **MCP server** | `jules-mcp` / `agentctl mcp` stdio frames, tools, version banner | `bin/mcp-server.mjs` and `src/mcp.mjs` untouched; `agentctl mcp` handler moves verbatim. |
| **CI** | 9-way matrix: lint + tests; ubuntu/22 self-audit; doc-sync job | Each step lands with `npm test` + `npm run lint` green; `doc-sync-check.mjs` stays green because `bin/agentctl.mjs` keeps `export const VERSION = KIT_VERSION`, `src/version.mjs` keeps reading `package.json`, and the pinned `FOREIGN_VERSIONS` paths are untouched. |
| **Zero dependencies** | no `dependencies`; `node:` builtins only | All new files import `node:` builtins + relative paths (verified in skeletons); `npm ls --prod` stays empty. |
| **Doc references** | README file map lines, AGENTS.md path notes | Phase 1 keeps every referenced path (`src/router.mjs`, `src/engine.mjs`, `bin/agentctl.mjs`, `scripts/*`) valid. README/AGENTS.md need no edits. |

### 5.1 CLI smoke matrix (run after Step 3 and Step 6)

```bash
node bin/agentctl.mjs                                  # bare → next-step, exit 0
node bin/agentctl.mjs --help                           # full help, exit 0
node bin/agentctl.mjs init --help                      # subcommand help interception
node bin/agentctl.mjs version && node bin/agentctl.mjs -v
node bin/agentctl.mjs bogus                            # unknown → help + exit 1
node bin/agentctl.mjs status                           # queue summary
node bin/agentctl.mjs budget                           # budget line + slots
node bin/agentctl.mjs budget --by-user                 # attribution table
node bin/agentctl.mjs lock status
node bin/agentctl.mjs doctor --json                    # diagnostics, exit 0/1
node bin/agentctl.mjs rules check                      # (post Step 4: via canonical path)
node bin/agentctl.mjs rules compile --json
node bin/agentctl.mjs flaky status
node bin/agentctl.mjs handover list
node bin/agentctl.mjs evidence show
node bin/agentctl.mjs escalate --status
node bin/agentctl.mjs task template --list
node bin/agentctl.mjs task optimize --json "add feature X and verify with npm test"
node bin/agentctl.mjs assert --dir .agent
node bin/agentctl.mjs gate --json                       # clean tree → exit 0
node bin/agentctl.mjs check --dry-run
node bin/agentctl.mjs audit --json                      # alias of check
node bin/agentctl.mjs dispatch --dry-run --prompt "do nothing"   # dry-run banner
node bin/agentctl.mjs create --dry-run -p "x"           # alias of dispatch
node bin/agentctl.mjs queue --dry-run
node bin/agentctl.mjs swarm --dry-run
node bin/agentctl.mjs rollback --help
node bin/agentctl.mjs test-gen --title demo --dry-run
node bin/agentctl.mjs mcp init --dry-run
node bin/agentctl.mjs hydrate "hello"
node bin/mcp-server.mjs <<< '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'  # MCP handshake
node bin/init.js --help
```

---

## 6. Risks & Verification Checklist

| # | Risk | Mitigation |
|---|---|---|
| R1 | Facade drift: a name silently missing from `engine.mjs`/`provider.mjs` facades | `test/api-surface.test.mjs` (208 lock) + every existing test file (21 import `engine.mjs`, 6 import `provider.mjs`) runs unmodified per step. |
| R2 | `gate()↔repair()` cycle or changed retry semantics | Only structural change in the whole refactor; `ooda_thrash.test.mjs` exercises `OODACircuitBreaker` + `repair` directly, `engine.test.mjs` exercises `gate --fix`; the default `gateFn` lazy-import path is covered by any direct `repair()` call in tests. |
| R3 | Doc-sync gate fails after `bin/agentctl.mjs` rewrite | The thin entry **keeps** `export const VERSION = KIT_VERSION` (Step 3 verification runs `node scripts/doc-sync-check.mjs`). |
| R4 | Startup-time regression for `agentctl version` | Registry uses lazy `import()` per command, mirroring today's in-case `await import(...)`; `version`/`--help` paths never touch `createContext()`. |
| R5 | Shim deletion breaks an unknown external deep-importer of `src/rules_budget.mjs` etc. | Only possible via unpublished deep imports (shims never reached from `index.mjs`); the 5 internal importers are migrated in the same commit; CHANGELOG notes the path change. (Mitigation if paranoia is required: keep shims for one release cycle — but they are then dead weight again.) |
| R6 | Wave A deletions hit a dynamic/string-keyed consumer | Verified by whole-repo identifier grep (counts in §1.3) **plus** the full suite per step; `no-unused-vars` lint catches accidental orphaning. |
| R7 | Phase 2 doctor split breaks the `FOREIGN_VERSIONS` pin | The pinned file `src/ops/doctor-registry.mjs` keeps its path and its Node-"20.0.0" context; only check implementations move to `src/ops/doctor/checks/*.mjs`. |
| R8 | README test-count drift during the refactor | doc-sync compares README vs. measured suite; the refactor adds no tests, so counts are stable. Any intentional test-file renames (§1.2 step 4) do not change counts. |

**Per-commit checklist (every step, Steps 1–6):**
- [ ] `npm test` — all 71 test files green, same pass count as baseline
- [ ] `npm run lint` — clean
- [ ] `node scripts/doc-sync-check.mjs` — exit 0
- [ ] `git grep -n "export \*" src/` — zero remaining re-export shims (after Step 4)
- [ ] `npm pack --dry-run | grep -E "src/(rules_budget|asset_integrity|execution_envelope)|deep-think"` — zero matches (after Step 4)
- [ ] No new entries in `package.json` `dependencies` (zero-dep invariant)
- [ ] No import cycles: re-run the graph check from §3.1 (all edges one-way)

**End-state metrics (target):**

| Metric | Now | After Phase 1 | After Phase 2 |
|---|---|---|---|
| Files > 350 lines (src+bin+scripts) | 19 | 15 (only Phase-2 candidates remain) | 2 (`ops/command-registry.mjs` data table, optional) |
| Largest file | `bin/agentctl.mjs` 1,979 | `src/security.mjs` 735 | `src/security.mjs` split → < 250 |
| 1-line re-export shims | 3 | 0 | 0 |
| Dead exports (0 references) | 11 | 0 | 0 |
| Scratch files at root | 1 | 0 | 0 |
| Cycle count (static + dynamic) | 0 | 0 | 0 |
| Public API | 208 frozen exports | 208 (unchanged) | 208 (unchanged) |

---

*Prepared as a planning artifact per the task invariant: no existing code was edited or
deleted in producing this document. All line ranges verified against commit `6792115`.*
