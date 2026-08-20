# Changelog

All notable changes to this project will be documented in this file.


## [0.32.7] - 2026-08-20
### Fix stale version banners & subcommand flag handling

#### Fixed
- **Stale `v0.29.1` version strings in `doctor`, `status`, `dashboard` banners and `index.mjs` JSDoc**: All now read dynamically from the `VERSION` constant or `package.json` instead of hardcoded strings.
- **`--version` output**: Now uses the `VERSION` constant instead of a hardcoded string.
- **Subcommand `--help` / `-h` fatal error**: `agentctl <subcommand> --help` previously threw `[FATAL ERROR] Unknown option '--help'` because `node:util` `parseArgs` runs in strict mode. Added global interception of `--help`/`-h` in subcommand args before the switch statement.
- **Subcommand `--dry-run` / `-d` fatal error**: Added `--dry-run` as a recognized option to all 10 `parseArgs` call sites that were missing it (gate, bootstrap, init, task create, task template, task optimize, test-gen, mcp init, harvest, evidence). `-d` short alias omitted for `task optimize` where it conflicts with `--dir`.

## [0.32.6] - 2026-08-20
### Cross-Platform Scope Hardening, Doc-Sync Release Gate & Adversarial Self-Audit

#### Security
- **Cross-platform path canonicalisation (`canonicalizePath()` in `src/config.mjs`, `checkScope()`/`matchesGlob()`/`isForbiddenPath()` in `src/security.mjs`)**: Deny and protect matching previously ran against the raw path string, so `./x`, `a/../x` and `a//x` each presented the same file under a spelling the patterns did not literally match. More seriously, matching was case-sensitive: the same repository is checked out on macOS (APFS) and Windows (NTFS) where `.GitHub/` and `.github/` are the **same directory**, and git records whichever case was committed — a deny rule of `.github/**` was therefore walkable past on two of the three target platforms. Deny and protect now canonicalise and fold case; **allow deliberately does not fold case**, so a case mismatch there yields "not allowed" (a violation), which is the fail-closed direction. Paths escaping the repository root are rejected outright instead of being pattern-matched.
- **Secret scanner evasion hardening (`scanDiff()` in `src/security.mjs`)**: Patterns are now matched against three variants of the added-line text — as-written, with invisible characters stripped (zero-width, soft hyphen, bidi controls, BOM), and with source-level string concatenation collapsed. The concatenation case is not purely adversarial: formatters wrap long string literals exactly that way, so a credential could previously slip through the gate **by accident**.
- **Router Windows-path parity (`collectReferencedPaths()` in `src/router.mjs`)**: `extractPathTokens()` recognises only `/`, so a sensitive path written `src\auth\session.mjs` by a Windows author was invisible to the force-complex guard and the task could be routed to the cheap tier. Separators are now normalised before extraction, matching the behaviour `targetFiles` already had.
- **New export**: `canonicalizePath` is exported from `index.mjs` alongside `normalizePath`.

#### Added
- **Documentation Sync Gate (`scripts/doc-sync-check.mjs`, `npm run jules:doc-sync`)**: Implements the previously-advertised-but-unbuilt `doc-sync-sentinel` preset. Asserts that `package.json`, `bin/agentctl.mjs` (`VERSION` const + every `agentctl vX.Y.Z` banner string), `ROADMAP_V1.md` (`(Current Stable)` marker, `Shipped Milestones` range, no released version left marked `(Unreleased)`), `CHANGELOG.md` (`## [version]` entry), `README.md` (advertised passing-test counts, no stale `Unreleased (main)` roadmap rows) and the agent rule-file character budgets all agree with each other and with what the test suite actually reports. Wired in as blocking step `1b` of `scripts/release.mjs`, which now captures the suite output so the gate reuses those counts rather than re-running the tests.
- **Adversarial red-team suite (`test/adversarial-claims.test.mjs`)**: Additive, `src/`-read-only probes that attempt to falsify README's safety claims, including a dedicated cross-platform block. Confirmed-but-unfixed gaps are recorded as `node:test` `todo` probes so they stay visible without failing CI. Seven of the eight original probes are now closed and promoted to regression tests.
- **Agent rule budget enforcement**: `scripts/rules-lint.mjs` existed but nothing invoked it, so `AGENTS.md` had silently drifted to 10,124 chars past its 10,000 budget — where a model host truncates directives off the end with no error surfaced. Now a blocking check inside the doc-sync gate.

#### Fixed
- **`JULES_RULES_TEMPLATE.md` shipped a broken command**: the multi-agent lock example still invoked `node scripts/lock-manager.mjs … --unattended`, a shim deleted in v0.24.0 — and this file ships to npm consumers via `package.json` `files`. Replaced with the real `agentctl lock acquire <agent> <task_id> <file_path...>` signature (positional, no `--unattended`).
- **`AGENTS.md` canonical command reference**: added an authoritative operator-command section that explicitly supersedes stale `scripts/*.mjs` paths retained in agent memories, and consolidated the two mutually contradictory exit-code tables (§6 claimed a 50 KB diff cap, §7 claimed 75 KB; the real limit is `limits.diffKb` = 75 KB).

#### Documentation
### Architecture Documentation Rewritten Against Actual Code
- **`docs/architecture.md` rewritten (`docs/` only — no `src/` changes)**: The previous sequence diagram described a single linear pipeline that provisioned a git worktree, applied the agent's patch to it, then committed, pushed and opened a PR. Verified against the code, none of that happens. The document now describes the two decoupled pipelines that exist: `dispatch()` (routing, role resolution, SPORE hydration, envelope, budget) and `gate()` (scope → payload → diff scan → staged verify → evidence, with the OODA loop owned by `--fix`).
- **Sequence diagram now branches on provider type**: The old diagram labelled every execution path "Google Jules API" while showing the agent writing to a local worktree. Those are two different machines — `type: "http"` (`jules`) POSTs to `/v1alpha/sessions` and the agent works in Google's Cloud VM against the connected GitHub repo, whereas `type: "exec"` (`claude-code`, `codex`, `gemini-flash`) runs `spawnSync(..., { cwd: config._root })` and mutates the local checkout. Split into two diagrams plus a provider execution-model table.
- **PR authorship clarified**: with `automationMode: "AUTO_CREATE_PR"`, **Jules** opens the pull request server-side; the orchestrator never commits, pushes, or creates a PR. `automationMode` is written into the HTTP body only and is inert for exec providers.
- **Entropy thresholds corrected**: the doc attributed `entropy > 3.6` to the Tier 3 secret gate. `scanDiff()` is purely pattern-based and uses no entropy at all; `3.6` lives in `redactSecrets()` and governs which environment-variable values are masked in output. The `4.3` / `4.5` thresholds belong to pre-dispatch prompt scanning in `planTaskCreate()`. All three are now documented against their real components.
- **"Secret Scanner" phase renamed to "Diff Scan"**: `scanDiff()` also emits `EDGE_RUNTIME_VIOLATION` and `CROSS_PACKAGE_BOUNDARY_VIOLATION`, both mapping to exit `6`. Added exit code `8` (flaky quarantine), which the old table omitted, and documented that test-file tampering exits `3`.
- **README warm-resumption claim corrected**: it advertised streaming "OODA repair prompts" into live sessions. `provider.resume()` is reached only from `agentctl resume` (asynchronous HITL) and the failover wrapper's delegation — `repair()` calls `provider.dispatch()` with a fresh `{ id: "repair-N" }` every attempt, so each OODA turn is a cold session. `synthesizePrDescription()` reads `session._warmResumed` / `_warmAttempts`, which nothing currently sets. The bullet now describes the HITL path it actually implements and links to the architecture note.

- **Documentation Sync Gate (`scripts/doc-sync-check.mjs`, `npm run jules:doc-sync`)**: Implements the previously-advertised-but-unbuilt `doc-sync-sentinel` preset. Asserts that `package.json`, `bin/agentctl.mjs` (`VERSION` const + every `agentctl vX.Y.Z` banner string), `ROADMAP_V1.md` (`(Current Stable)` marker, `Shipped Milestones` range, no released version left marked `(Unreleased)`), `CHANGELOG.md` (`## [version]` entry) and `README.md` (advertised passing-test counts, no stale `Unreleased (main)` roadmap rows) all agree with each other and with what the test suite actually reports.
- **Blocking Release Step (`scripts/release.mjs`)**: Wired the gate in as step `1b`, aborting the release before tagging if docs have drifted. Step 1 now captures the suite output instead of inheriting it, so the gate reuses those counts rather than running the suite a second time.
- **Adversarial Red-Team Suite (`test/adversarial-claims.test.mjs`)**: Additive, `src/`-read-only suite that attempts to falsify README's safety claims — Deny-before-Allow precedence, path canonicalisation, the 75 KB payload governor (inclusive bound + byte-accurate measurement), the secret scanner, router force-routing of sensitive paths, and the v0.32.5 provider token guard. Confirmed-but-unfixed gaps are recorded as `node:test` `todo` probes so they stay visible without failing CI.
- **Verified Sound**: Deny-before-Allow precedence holds against overlapping and wildcard allow lists; the payload governor is an inclusive `<=` against `diffKb * 1024` and measures UTF-8 bytes (not UTF-16 units); the token guard admits *exactly* the URL templates that `interpolateString()` would not substitute, so guard and interpolator agree with no gap between them.
- **Agent Rule Budget Enforcement (`scripts/rules-lint.mjs` wired into the gate)**: `rules-lint` existed but nothing invoked it, so `AGENTS.md` had silently drifted to 10,124 chars — past its 10,000 budget — where a model host truncates directives off the end with no error surfaced. Now a blocking check inside the doc-sync gate.
- **AGENTS.md Canonical Command Reference**: Added an authoritative operator-command section that explicitly supersedes stale `scripts/*.mjs` paths retained in agent memories, and consolidated the two mutually contradictory exit-code tables (§6 claimed a 50 KB diff cap, §7 claimed 75 KB; the real limit is `limits.diffKb` = 75 KB) into a single registry. Net effect: 9,859 chars, back within budget.
- **Shipped Template Fix (`JULES_RULES_TEMPLATE.md`)**: The multi-agent lock example still invoked `node scripts/lock-manager.mjs … --unattended`, a shim deleted back in v0.24.0 — and this file ships to npm consumers via `package.json` `files`. Replaced with the real `agentctl lock acquire <agent> <task_id> <file_path...>` signature (positional, no `--unattended`), plus `lock status` / `lock release`.
- **Known Gaps Recorded (8 `todo` probes)**: `normalizePath()` performs separator swapping only — it does not strip `./`, resolve `..`, or case-fold, so deny matching runs on the raw string; this is reachable with non-git-derived input via `validateEnvelope()`'s agent-authored `allowed_paths`. The secret scanner joins added lines with `\n` and applies no unicode/base64 normalisation, so split, zero-width-injected, and base64-wrapped credentials evade it. `extractPathTokens()` recognises only `/` as a separator, so a backslash-written sensitive path in a *prompt* (unlike `targetFiles`, which is normalised) does not force the primary provider.

## [0.32.5] - 2026-08-20
### Provider Security Hardening, Git Test Oracle & Dynamic Complexity Router
- **Provider URL Token Leakage Guard (`src/provider.mjs`, `test/provider-hardening.test.mjs`)**: Added strict validation in `createProvider()` rejecting custom HTTP provider specifications whose `url` or `sendMessageUrl` templates contain `{token}`. Isolated raw API credentials exclusively to HTTP request headers (`headerData`), preventing tokens from interpolating into URL paths/query strings where they could leak into access logs and HTTP referrers.
- **Additive Git Core Test Suite (`test/git.test.mjs`)**: Created comprehensive native `node:test` suite for `src/git.mjs` verifying command execution (`runCmd`, non-zero exit codes, buffer limits `ENOBUFS`, timeouts `ETIMEDOUT`), shell escaping, git operations, worktree lifecycle management (`worktreeRemove`, `worktreePrune`), and base commit resolution.
- **Dynamic Complexity & Cost Router (`src/router.mjs`, `router:` in `.agent/config.yml`)**: New zero-dependency, rule-based `classifyTaskComplexity()` heuristic and `resolveRoutedProvider()` resolver. Opt-in via `router.enabled` (default `false`, zero behavior change for existing users). Routes trivial/mechanical tasks to a fast/cheap provider and complex, multi-file, or safety-sensitive tasks to the primary provider.
- **Safety-First Routing**: Tasks touching `config.scope.deny` or built-in sensitive path patterns (`auth/**`, `migrations/**`, `pricing/**`, `secrets/**`, `*.pem`, `*.key`, `.github/**`) always force the primary provider, as does the `sentinel` role — these overrides cannot be downgraded by prompt wording. `janitor`/`bolt` roles nudge toward the fast tier; explicit `task.tier`/`--tier` always wins outright.
- **Gemini CLI Fast-Tier Preset (`src/provider.mjs` `GEMINI_PRESET` / `gemini-flash`)**: Headless Gemini CLI exec preset (`gemini-3.6-flash`, `--approval-mode=yolo`, prompt via stdin), refactored `createProvider()`'s preset lookup into a `NAMED_PRESETS` map to accommodate it cleanly. Any provider spec (built-in or custom) works as `router.fast`/`router.complex` — not tied to Gemini or any single vendor.
- **Cascade-on-Failure**: FAST-tier dispatch wraps `[fast, complex]` in the existing `createFailoverProvider`, so a rate-limited or unavailable fast provider automatically falls through to the primary provider — no new failover logic needed.
- **`--tier fast|complex` Override**: Added to `agentctl dispatch`, `agentctl task create` (persisted in the task envelope and threaded through `agentctl queue --dag`), and the `dispatch_jules_task` MCP tool.
- **Unit Test Coverage (`test/router.test.mjs`, `test/git.test.mjs`, `test/provider-hardening.test.mjs`)**: Total passing unit tests increased to 429 across 59 test suites with 0 lint errors.

### DAG Task Execution, Specialist Agent Roles & Cryptographic Evidence Ledger
- **DAG-Ordered Queue Execution (`src/dag-engine.mjs`, `agentctl queue --dag`)**: Added `DagExecutor` with Kahn's-algorithm dependency resolution, cycle detection (`DagCycleError`), per-task timeout wrapping, and `--concurrency <n>` worker slot control, driven by `--depends-on` on `agentctl task create`.
- **Specialist Agent Roles (`agentctl dispatch --role`, `agentctl task create --role`)**: Tasks can now bind to a pre-defined specialist prompt persona (`overseer` | `bolt` | `sentinel` | `janitor`) resolved from `.agent/prompts/` and attached to the task envelope; exposed via the `role` MCP parameter.
- **Cryptographic Evidence Manifest (`src/evidence.mjs`, `src/ops/evidence-actions.mjs`, `agentctl evidence generate|verify|show`)**: New SHA-256 manifest generator hashing changed files and test files, with tamper detection and Markdown summary export — a foundational building block toward the roadmap's SOC2 audit exporter.
- **Tiered Verification Stages & Offline Execution Policy (`src/config.mjs`)**: `verify.stages` (lint/unit/fuzz/invariant/e2e) and `verify.policy.{networkAccess,offline}` config fields, enabling stack-specific offline enforcement.
- **Web3 / Solidity Stack Detection (`src/stack-detector.mjs`)**: Foundry (`foundry.toml`/`remappings.txt`, `forge test/build/fmt --offline`) and Hardhat (`hardhat.config.js`/`.ts`) auto-detection, bringing supported ecosystems to 26+.
- **Documentation**: Synchronized `README.md` (CLI table, ecosystem list, feature roadmap) and `ROADMAP_V1.md` with the above; corrected stale test-suite count (368/52 → 407/56).

## [0.32.4] - 2026-08-18
### Architecture Directives, Type III Situational Awareness & Roadmap Alignment
- **Type III Situational Awareness & Silence Governor Alignment (`ROADMAP_V1.md`, `PRIOR_ART.md`)**: Documented architectural roadmap for Google Labs `/code` Type III agentic paradigm ("Silence is an explicit, strategic decision") including Interruption Budgeting, quiet-by-default digest mode in `src/webhook.mjs`, and proactive local telemetry ingestion.
- **Documentation & Version Synchronization (`README.md`, `bin/agentctl.mjs`, `package.json`)**: Synchronized semantic version to `v0.32.4` across CLI binaries, help menus, and documentation descriptors.

## [0.32.3] - 2026-08-15
### Queue Hygiene, Swarm Gate Hardening & Documentation Synchronization
- **Queue Runtime Hygiene & Git Sterilisation (`.gitignore`)**: Untracked historical local task execution files and tightened `.gitignore` rules to guarantee an empty, clean `.agent/jules-queue/` on fresh clones.
- **Swarm Merge Safety Gate Hardening (`scripts/jules-merge-swarm.mjs`)**: Scoped risk tier evaluation in `checkSafetyGate` specifically to the target swarm PR branch diff rather than uncommitted local workspace working tree state.
- **Documentation Alignment (`README.md`, `ROADMAP_V1.md`)**: Synchronized CLI tables, version output descriptors, and release milestone roadmaps to current stable `v0.32.3`.

## [0.32.2] - 2026-08-15
### Web Development Task Templates, Google Labs Exploration Budgets & Critic Agent Steering
- **Web Development Task Templates (`src/web-templates.mjs`, `agentctl task template`)**: Added zero-dependency template synthesis engine supporting `web-cwv` (Core Web Vitals & Lighthouse Budget Guard), `web-wcag` (WCAG 2.2 AA/AAA semantic accessibility & modal focus traps), `web-seo` (Schema.org JSON-LD, OpenGraph, Twitter Cards, canonical links), `web-playwright` (E2E visual regression & responsive viewports), and `web-flaky-heal` (anti-flakiness & network mocking).
- **Google Labs Exploration Budget Protocol (`src/task-optimizer.mjs`)**: Implemented 3-phase discovery envelope injection (Phase 1: Discovery & Symbol Tracing, Phase 2: Oracle Formulation, Phase 3: Surgical Implementation & Verification), proven by Google Labs research to increase diagnostic accuracy (Hit@5) from 33% to 57%.
- **Internal Critic Agent Steering (`src/task-optimizer.mjs`, `src/web-templates.mjs`)**: Added adversarial pre-review directives targeting Jules' internal Critic Agent to catch $O(n^2)$ bottlenecks, dropped arguments, Cumulative Layout Shifts (CLS), and accessibility defects before PR creation.
- **CLI & MCP Tool Extensions (`bin/agentctl.mjs`, `src/mcp.mjs`)**: Added `agentctl task template [id]`, `agentctl task create --template <id>`, `agentctl task optimize --web`, and the `get_web_task_template` MCP stdio tool.
- **Unit Test Coverage (`test/web-templates.test.mjs`, `test/task-optimizer.test.mjs`, `test/mcp.test.mjs`)**: Added comprehensive test coverage bringing total passing unit tests to 387 across 54 test suites.

## [0.32.1] - 2026-08-12
### Universal Edge-Runtime Import Guard & Environment Protection
- **Universal Edge-Runtime Detection (`src/stack-detector.mjs`)**: Added `detectEdgeRuntime()` helper detecting Cloudflare Workers (`wrangler.toml`/`wrangler.json`), Vercel Edge (`@vercel/edge`), Netlify Edge Functions (`@netlify/edge-functions`), and Deno runtimes across polyglot project roots.
- **Edge Import Security Gatekeeper (`src/security.mjs`, `checkEdgeRuntimeImports`)**: Added static verification gate flagging unsupported native Node.js built-in module imports (`node:fs`, `node:child_process`, `node:net`, `node:tls`, `node:vm`, etc.) in Edge diff contexts or files declaring `export const runtime = 'edge'`.
- **Documentation & Unit Tests (`AGENTS.md`, `README.md`, `test/security.test.mjs`, `test/stack-detector.test.mjs`)**: Updated system directives, security gatekeeper documentation, and test assertions covering Edge stack detection and import violations.

## [0.32.0] - 2026-08-12
### CI Unshallow Gate & SPORE Memory Engine Integration
- **CI Unshallow Gate Fix (`src/git.mjs`, `scripts/stale-base-check.mjs`)**: Added `ensureBaseFetched()` helper with `--depth=100` / `--unshallow` fallback for shallow clones in CI, and enforced hard `exit 1` on base branch resolution failure in `stale-base-check.mjs`.
- **SPORE Memory Engine & System Learnings (`src/memory.mjs`, `bin/agentctl.mjs`)**: Added zero-dependency memory module providing `recordLearning()`, `hydratePrompt()`, and `harvestFailure()`. Automatically generates `.agent/SYSTEM_LEARNINGS.md` table and adds CLI subcommands `agentctl hydrate`, `agentctl harvest`, and `agentctl learning add`.
- **Unit Test Coverage (`test/spore-memory.test.mjs`)**: Added test suite for learning recording, prompt hydration, and failure harvesting, bringing total passing unit tests to 378 across 54 test suites.

## [0.31.0] - 2026-08-10
### Developer Onboarding, TDD Red-to-Green, AST Selective Testing & Lifecycle Sandboxing
- **Warm Multi-Turn Session Resumption (`src/provider.mjs`)**: Added `resume(sessionId, prompt)` targeting `POST /v1alpha/sessions/{id}:sendMessage` with fail-soft cold dispatch fallback, saving 60–80% token consumption across OODA turns.
- **AST Blast-Radius Selective Testing (`src/dag-engine.mjs`)**: Implemented `resolveAffectedTests()` with `GLOBAL_CONTRACT_PATTERNS` guard to selectively run only affected leaf tests in large codebases while preserving full-suite verification on global changes.
- **Verification Lifecycle Sandbox (`src/config.mjs`, `src/engine.mjs`)**: Added `verify.setup` and `verify.teardown` lifecycle execution with guaranteed `try...finally` process-group cleanup for Prisma, Drizzle, Django, and SQLite migrations.
- **Prompt Falsifiability & Scope Linter (`src/task-optimizer.mjs`, `agentctl task optimize`)**: Added pre-dispatch prompt analyzer scoring testability (0–100), fuzzy typo resolution for file paths via Levenshtein distance, and automatic task envelope formatting.
- **Asynchronous HITL Escalation Bridge (`src/webhook.mjs`, `agentctl escalate`)**: Added zero-dependency Slack and Discord webhook alert dispatchers with `agentctl resume <sessionId> --response "<text>"` command resumption.
- **1-Click Atomic Git Checkpoint & Rollback (`src/ops/checkpoint.mjs`, `agentctl rollback`)**: Added automatic pre-flight working tree snapshots and instant 1-command git tree rollback.
- **Evidence-Backed PR Review Bundler (`src/engine.mjs`)**: Added `synthesizePrDescription()` generating structured PR bodies with OODA timelines, zero-trust security audit receipts, test output logs, and AST impact graphs.
- **Automated TDD Red-to-Green Harness (`src/ops/tdd-generator.mjs`, `agentctl test-gen`)**: Implemented 3-step test-driven development cycle that scaffolds unit tests, asserts initial RED failure, locks the test in `scope.deny`, and dispatches Jules for GREEN resolution.
- **Live Dev Server & SSR Hydration Smoke Probing (`verify.server`, `src/engine.mjs`)**: Added `probeDevServer()` booting the dev server in an isolated process group and verifying HTTP 200 without SSR hydration panics.
- **IDE Native MCP Config Scaffolder (`src/ops/ide-scaffold.mjs`, `agentctl mcp init`)**: Added 1-command config generation for Cursor (`.cursor/mcp.json`), VS Code (`tasks.json`), and Claude Desktop.
- **Unit Test Coverage**: Added test suites (`test/task-optimizer.test.mjs`, `test/checkpoint.test.mjs`, `test/escalation.test.mjs`, `test/tdd-generator.test.mjs`, `test/server-probe.test.mjs`, `test/ide-scaffold.test.mjs`), bringing total passing unit tests to 368 across 52 test suites.

## [0.30.0] - 2026-08-10
### Interactive UX, Guided Diagnostics & Swarm Management Subsystem
- **Terminal Engine Hardening (`src/ux/`)**: Implemented zero-dependency terminal capabilities detector (`capabilities.mjs`), incremental sequence key decoder (`key-decoder.mjs`), raw mode lifecycle manager (`terminal-session.mjs`), virtual screen renderer (`renderer.mjs`), responsive breakpoint layout engine (`layout.mjs`), interactive TUI widgets (`widgets.mjs`), unified git diff syntax highlighter (`diff-viewer.mjs`), and bounded log viewer (`log-viewer.mjs`).
- **Guided Diagnostics & Auto-Remediation (`src/ops/`)**: Added diagnostic check DAG (`doctor-registry.mjs`), pure fix proposal planner (`doctor-planner.mjs`), transactional executor (`transaction.mjs`), and operation receipts system (`receipts.mjs`).
- **Interactive Queue & Swarm Manager (`src/ux/`, `src/ops/`)**: Implemented canonical task sidecar state machine (`queue-model.mjs`), swarm slot PID liveness detector (`swarm-model.mjs`), task action planner (`task-actions.mjs`), and swarm action planner (`swarm-actions.mjs`).
- **Command Registry & Interactive Command Palette (`src/ops/`, `src/ux/`)**: Added normative command descriptor registry (`command-registry.mjs`), CLI `--help` text generator, fuzzy search filter, and interactive command palette view (`palette.mjs`).
- **Unit Test Coverage**: Added comprehensive test suites (`test/ux.test.mjs`, `test/ops.test.mjs`, `test/queue-swarm.test.mjs`, `test/palette.test.mjs`), bringing total passing unit tests to 332 across 52 test suites with 0 lint errors.

## [0.29.1] - 2026-08-10
### P0 Remediation & Queue Architecture Alignment
- **Canonical Queue Alignment (`src/wizard-task.mjs`)**: Updated `runTaskCreateWizard()` to write generated task files to canonical `getQueueDir(root)` (`.agent/jules-queue/`) rather than unread `.agent/queue/` directory.
- **Task ID Path Traversal Guard (`src/wizard-task.mjs`)**: Enforced strict task ID sanitization (`/[^a-zA-Z0-9_-]/g`) and path containment verification preventing directory traversal attacks via custom task IDs.
- **Atomic Writes & Config Preservation (`src/wizard-init.mjs`)**: Implemented atomic write operations (`tmp` file + `fsync` + `renameSync`) for `.agent/config.yml` and `.agent/jules.yml`. Merges and preserves pre-existing custom config fields upon re-initialization.
- **Non-TTY Headless Guard (`src/wizard-init.mjs`)**: Enforced explicit error when running `runInitWizard()` in non-TTY mode without explicit parameters or `allowDefaults: true`.
- **Multiline Secret Scanning & Unconditional Block (`src/wizard-task.mjs`)**: Prepend `+` to all prompt lines when calling `scanDiff()` to prevent multiline credential bypasses. Removed bypass parameter for high-confidence secrets.
- **Strict Falsifiability Verification (`src/wizard-task.mjs`)**: Rejected trivial verification commands (`true`, `echo`, `:`, `false`) to enforce non-trivial evaluable verification predicates.
- **JSON Envelope Header (`src/wizard-task.mjs`, `src/engine.mjs`)**: Appended `<!-- JULES_TASK_ENVELOPE: ... -->` header to synthesized Markdown task files and updated `isTaskFile()` to parse queue metadata.
- **TUI Exception Safety (`src/tui.mjs`)**: Replaced direct `process.exit(130)` calls with `WizardCancelledError` exception throwing to allow proper cleanup by SDK host processes.

## [0.29.0] - 2026-08-10
### Onboarding, Stack Oracle & Guided Task Authoring Subsystem
- **Native Terminal UI (TUI) Engine (`src/tui.mjs`)**: Added zero-third-party-dependency TUI primitives built on `node:readline/promises`, `node:tty` (`setRawMode(true)`), and ANSI escape sequences, including single-select menus, multi-select checkboxes, validated text inputs, secret inputs, confirmation prompts, spinners, and non-TTY headless fallbacks.
- **Stack Oracle & Verification Probes (`src/wizard-oracle.mjs`)**: Added multi-tier stack inspection (Node, Cargo, Go, Pytest, CMake, Elixir, Docker, monorepos) and `runVerificationProbe()` execution validator.
- **Interactive Onboarding Engine (`src/wizard-init.mjs`, `agentctl init --interactive`)**: Added pure planning core `planInit()`, tier matrix (`free`, `pro`, `enterprise`), declarative preset loader (`.agent/presets/*.yml`), and atomic configuration generator.
- **Guided Task Authoring Subsystem (`src/wizard-task.mjs`, `agentctl task create`)**: Added task creation planning core `planTaskCreate()`, TODO candidate harvesting from `scanCodebaseForTodos()`, Shannon entropy secret leak scrubbing, falsifiability verification enforcement, `gate --mode working-tree` preflight checks, and guardrail footer auto-synthesis.
- **SDK Exports (`index.mjs`)**: Exported TUI, Stack Oracle, Onboarding, and Task Authoring SDK functions.

## [0.28.2] - 2026-08-10
### Phase 1 P0 Closure: Jules Provider & Gate Engine Remediation
- **Jules Provider `startingBranch` & Source Validation (`src/provider.mjs`)**: Updated `startingBranch` to default to `config.baseBranch` (or `main`) rather than a target branch prefix (`agent/task`). Added validation throwing an explicit error when repository source is missing on non-repoless live dispatches.
- **Automation & Plan Approval Body Mapping (`src/provider.mjs`)**: Mapped `task.autoPr` / `ctx.autoPr` to `automationMode: "AUTO_CREATE_PR"` and `task.requirePlanApproval` to `requirePlanApproval: true` in Google Jules REST API payloads.
- **Gate Mode Engine Wiring (`src/engine.mjs`)**: Wired `opts.mode` directly into `gate()`, passing `mode` down to `changedFiles()`, `diffBytes()`, and `diffText()`. Ensures local CLI audits evaluate working-tree, staged, or committed diffs as requested.
- **P0 Test Suite & E2E Verification (`test/p0-remediation.test.mjs`)**: Added end-to-end unit tests asserting `startingBranch` defaults, missing source validation, `automationMode` / `requirePlanApproval` body mapping, and `gate({ mode: "working-tree" })` untracked file secret blocking.

## [0.28.1] - 2026-08-10
### Release Recovery, Gate Mode Wiring & Jules Starting Branch Fix
- **Node 22 Test Lifecycle Fix (`test/p0-remediation.test.mjs`)**: Made parent test callbacks `async` and awaited nested `t.test()` promises, resolving test cancellation failure on Node 22/20 CI runners.
- **Jules v1alpha Starting Branch Fix (`src/provider.mjs`)**: Updated `startingBranch` payload field to default to `config.baseBranch` (or `main`) rather than task target branch prefix (`agent/task`), conforming with Google Jules REST API spec. Throws explicit error if repository source is missing on non-repoless live calls.
- **Gate Working-Tree Mode Wiring (`src/engine.mjs`, `bin/agentctl.mjs`)**: Wired `opts.mode` into `gate()` (defaulting to `working-tree` for local runs) and added `--mode` (`working-tree`, `staged`, `committed`) options to `agentctl gate`.
- **CLI Options & Missing Commands (`bin/agentctl.mjs`)**: Added CLI options `--source`, `--branch`, `--repoless`, `--auto-pr`, `--require-plan-approval` to `agentctl dispatch`, added CLI command handlers for `create`, `status`, and `scan`, and normalized process exit code types.
- **Version Centralization & Lockfile Alignment (`package.json`, `package-lock.json`, `src/mcp.mjs`, `src/dashboard.mjs`, `bin/agentctl.mjs`)**: Centralized version string to `0.28.1` across all CLI, MCP, doctor, and dashboard components, and updated `package-lock.json` root version.
- **Dashboard HTML Schema & Loopback Binding (`src/dashboard.mjs`)**: Fixed schema field mismatches (`integrity.ok`, `verdict.verdict`) in dashboard HTML visualizer and bound default HTTP listener to `127.0.0.1`.

## [0.28.0] - 2026-08-09
### Core P0 Remediation & Google Jules REST v1alpha Alignment
- **Google Jules REST v1alpha Provider Alignment (`src/provider.mjs`)**: Conformed default provider endpoint to `https://jules.googleapis.com/v1alpha/sessions` using `X-Goog-Api-Key` authentication header and structured `sourceContext` (`source` and `githubRepoContext.startingBranch`). Throws explicit `MissingApiKeyError` (401) when `JULES_API_KEY` is missing on live dispatches. Added support for `--repoless` session payloads.
- **Prompt Guard Instruction Framing (`src/engine.mjs`, `src/prompt-guard.mjs`)**: Fixed `dispatch()` so primary user task instructions are passed as trusted operator instructions under `[TASK INSTRUCTIONS]` and not framed as untrusted data (`<<<UNTRUSTED-DATA>>>`). System warning is conditionally emitted only when untrusted external context is present.
- **Queue State Engine & Retry Semantics (`src/engine.mjs`)**: Updated `run()` so rate-limited (HTTP 429) or unavailable (HTTP 5xx) task dispatches leave task files in `queue/` for retry instead of moving them to `completed/`.
- **Working-Tree & Untracked File Gate Mode (`src/git.mjs`)**: Extended `changedFiles()`, `diffText()`, and `diffBytes()` with `working-tree` mode support to inspect uncommitted modifications, staged index, and untracked `.env`/secret files during pre-commit gating.
- **Shell Command Safety (`src/git.mjs`)**: Updated `runCmd()` to detect shell operators (`&&`, `||`, `|`, `>`, `<`, `$`, `"`, `'`, `;`) in string commands and execute them safely via shell (`/bin/sh -c` or `cmd.exe /c`).
- **Installer & Package Exports Alignment (`bin/init.js`, `scripts/jules-self-audit.mjs`, `index.mjs`)**: Injected `npx agentctl <cmd>` package scripts in consumer `package.json`, excluded maintainer scripts (`release.mjs`) from target copy, added dynamic module imports in `jules-self-audit.mjs`, exported missing API symbols in `index.mjs`, and suppressed SDK import deprecation warnings in `jules-dispatch.mjs`.
- **P0 Remediation Test Suite (`test/p0-remediation.test.mjs`)**: Created unit tests covering v1alpha provider alignment, prompt guard provenance, queue retry semantics, working-tree gate mode, shell command execution, and snake_case config limits.

## [0.27.1] - 2026-08-09
### Dead Code Elimination & Architecture Housekeeping
- **Dead Code Cleanup (`src/process-group.mjs`, `src/git.mjs`)**: Removed orphaned `src/process-group.mjs` module and unused `createBranch` / `worktreeAdd` exports from `src/git.mjs`.
- **Zero-Dependency Audit**: Verified 100% clean test execution and ESLint passing without introducing third-party analysis dependencies.

## [0.27.0] - 2026-08-09
### PR Review Auto-Remediation, Multi-Provider Failover & Zero-Dependency Dashboard
- **PR Review Auto-Remediation (`src/review-repair.mjs`)**: Implemented `parseReviewComments()` to parse GitHub PR review comments (`CHANGES_REQUESTED`), filter out conversational praise (`lgtm`, `looks good`, `thanks`), map file/line coordinates, and synthesize OODA repair task envelopes. Added `agentctl review-repair <pr-comments.json>` CLI command.
- **Multi-Provider Failover Router (`src/provider.mjs`)**: Implemented `createFailoverProvider()` allowing sequential failover across ordered provider lists (`["jules", "claude-code", "local-mcp"]`) on HTTP 429 rate limits or 5xx service unavailability.
- **Zero-Dependency Local Dashboard (`src/dashboard.mjs`)**: Implemented `createDashboardServer()` using `node:http` to serve a real-time dark-mode HTML visualizer and REST APIs (`/api/status`, `/api/telemetry`, `/api/flaky`, `/api/locks`). Added `agentctl dashboard [port]` CLI command.
- **Unit Test Suite (`test/v027-features.test.mjs`)**: Created test suite asserting PR review comment parsing, conversational noise filtering, multi-provider failover routing, and HTTP dashboard REST endpoints.

## [0.26.2] - 2026-08-09
### Triage Guidelines & Playwright Quickstart Addition
- **Triage Guidelines (`README.md`)**: Added explicit "When to Use vs. When NOT to Use" section detailing ideal tasks (unit-tested fixes, type migrations, CVE bumps, refactoring) and out-of-scope tasks (unverifiable visual UI tweaks, closed proprietary platforms, unmocked live cloud APIs).
- **Playwright Frontend Quickstart (`README.md`)**: Added Playwright E2E testing quickstart recipe demonstrating how visual/UI tasks can be made falsifiable via headless browser snapshot tests.

## [0.26.1] - 2026-08-09
### CI Linter Repair & Executive README Polish
- **ESLint Fix (`src/merge-blocks.mjs`)**: Renamed unused `schemaType` parameter to `_schemaType` in `hashCrossLanguageInterface` signature, resolving ESLint `no-unused-vars` failure in CI.
- **Executive README Polish (`README.md`)**: Updated README with intuitive 2-sentence mental model, universal quickstarts across 5 stack archetypes, feature comparison matrix, architecture diagrams, and v0.27+ roadmap in an authoritative enterprise tone.

## [0.26.0] - 2026-08-09
### Universal Polyglot Coverage, Zero-Test Bootstrapping & Container Execution Wrappers
- **Universal Polyglot Stack Detector (`src/stack-detector.mjs`)**: Auto-detects 24+ tech ecosystems (PHP/Laravel/WP, .NET/C#/F#, Mobile Flutter/Swift/Dart/React-Native, Systems CMake/Cargo/Go/Make, Python, Node, Deno, Bun, Mix, Maven, Gradle, Bundler).
- **Container Execution Wrappers (`src/stack-detector.mjs`)**: Auto-detects `.devcontainer/devcontainer.json` or `docker-compose.yml` and wraps task verification commands in `docker compose exec -T app <cmd>` or `devcontainer exec`.
- **Scoped Monorepo Boundary Resolver (`resolveWorkspaceBoundary`)**: Isolates changed files up directory ancestry to nearest subproject root and synthesizes subshell test commands (`(cd backend && pytest) && (cd cli && cargo test)`), or falls back to global verification for shared contract files (`openapi.yaml`).
- **Zero-Test Repository Bootstrapping (`agentctl bootstrap`)**: Synthesizes non-destructive syntax check oracles (`php -l`, `python -m compileall`, `dotnet build`, `npx tsc --noEmit`) or generates `.agent/smoke.test.mjs` for untested repos. Added `agentctl bootstrap` CLI command.
- **Polyglot Indentation & Tag-Based 3-Way Block Merger (`src/merge-blocks.mjs`)**: Extended 3-way block merger to handle XML/`.csproj` tag blocks (`<PropertyGroup>`, `<ItemGroup>`), Python/YAML whitespace blocks, and canonical SHA-256 schema hashing (`hashCrossLanguageInterface`) for OpenAPI contract verification.
- **Unit Test Suites (`test/stack-detector.test.mjs`, `test/polyglot-merge.test.mjs`)**: Created test suites asserting stack detection, container wrapping, monorepo boundary resolution, zero-test bootstrapping, XML block merging, and OpenAPI schema contract hashing.

## [0.25.1] - 2026-08-09
### Async I/O Refactoring & Script Modularization Polish
- **Non-Blocking Queue Runner File I/O (`src/engine.mjs`)**: Replaced `fs.readFileSync` with `await fs.promises.readFile` inside the async batch processing map in `run()`, preventing event loop blocking during file prompt reads.
- **Command Resolver Sub-Parsers (`scripts/command-resolver.mjs`)**: Modularized `resolveProjectCommands` by extracting `parseYamlConfig` and `detectFrameworkCommands`.
- **Self-Audit Validation Passes (`scripts/jules-self-audit.mjs`)**: Modularized `runSelfAudit` into dedicated exported validation functions (`auditLedgers`, `auditWorktrees`, `auditGates`).

## [0.25.0] - 2026-08-09
### Provider Failure Domain Taxonomy, Socket Timeouts, and Budget Rollback
- **Provider Error Taxonomy (`src/provider.mjs`)**: Added typed error classes `ProviderRateLimitError` (HTTP 429), `ProviderUnavailableError` (5xx errors and socket timeouts), and `ProviderSchemaError` (invalid payload format). Added `parseRetryAfter()` supporting numeric seconds and HTTP-date header formats.
- **Socket Timeout Support (`src/provider.mjs`)**: Configured 120s default socket timeout via `AbortSignal.timeout(timeoutMs)` for all HTTP provider dispatch requests.
- **Atomic Budget Rollback (`src/state.mjs`)**: Added `rollbackBudgetReservation()` to release reserved budget when provider calls fail to accept the session. Updated `checkDailyBudget` and `reserveBudgetAtomic` to dynamically balance reserved and rolled-back entries.
- **OODA Repair Bypass (`src/engine.mjs`)**: Updated `dispatch()` and `repair()` to catch provider infrastructure failures, roll back reserved budget, log backoff recommendations, and bypass OODA repair retries.
- **Provider Hardening Test Suite (`test/provider-hardening.test.mjs`)**: Created unit tests covering HTTP 429 errors, `Retry-After` parsing, budget rollback, repair bypass, and socket timeouts.

## [0.24.0] - 2026-08-09
### Mandatory v1.0.0 Bugfixes, Telemetry Resilience & Code Pruning
- **Fixed Queue Runner Dispatch (`scripts/jules-queue-runner.mjs`, `src/engine.mjs`)**: Refactored queue runner and `run()` engine to actually dispatch tasks via `dispatch()` before relocating them to `completed/`. Supported dual invocation signatures `run(tasks, opts)` and `run(opts)`.
- **Code Pruning & Shim Cleanup**: Deleted obsolete shims (`scripts/jules-swarm.mjs`, `scripts/lock-manager.mjs`, `scripts/jules-cleanup.mjs`). Moved `extractPrUrls`, `auditSessions`, `buildSyncManifest`, and `pushReservationManifest` into `scripts/utils.mjs`. Re-pointed `jules:queue` and `jules:swarm` scripts to `agentctl queue` and `agentctl swarm`.
- **Premise Validation Fix (`src/envelope.mjs`)**: Fixed `git cat-file -e` premise check in `validateEnvelope` to evaluate exit code status (`status === 0`) instead of checking stdout length.
- **Lock Metadata Hardening (`src/state.mjs`)**: Included `branch` field in JSON lock payloads generated by `acquireLock`.
- **Telemetry Crash Reconciliation (`src/telemetry.mjs`)**: Implemented `readTailHash` reading up to 64 KB from EOF. Reconciled `.head` hash against active log segment tail on startup to self-heal desynced `.head` files and prevent `BROKEN_PREV_HASH` chain forks.
- **Offline-Safe TypeScript Verification (`src/merge-verify.mjs`)**: Removed `npx` calls. Checks local `node_modules/.bin/tsc` and `tsconfig.json` with 120s timeout, or skips gracefully with `{ ok: true, tool: "ts-skipped-no-tsconfig" }`.
- **Provider State Polling in OODA (`src/engine.mjs`)**: Added `pollSessionState` to poll async providers for terminal session states (`COMPLETED` / `FAILED`) before executing OODA re-verification gates.
- **v1.0.0 Readiness Test Suite (`test/v1-readiness.test.mjs`)**: Created test suite asserting queue dispatching, premise validation for committed paths absent from disk, and telemetry head desync self-healing.

## [0.23.0] - 2026-08-09
### O(1) Telemetry Spine & MCP Real-Time Event/Progress Streaming
- **O(1) Telemetry Engine (`src/telemetry.mjs`)**: Implemented `appendTelemetry` with SHA-256 hash chaining, O(1) `.head` atomic cache file (`safeAtomicWrite` with `{ sync: false }`), cold scan fallback recovery, and 8 MB log segment rotation. Added `readTelemetry` and `verifyTelemetryIntegrity`.
- **MCP Progress Streaming Bus (`src/mcp-progress.mjs`)**: Implemented `ProgressBus` with 150ms window coalescing (latest-wins intermediate state), stream backpressure safety (awaiting `"drain"`), 240-character progress message string capping, and `notifications/message` log streaming.
- **MCP Tooling & System Integration (`src/mcp.mjs`, `src/engine.mjs`, `src/dag-engine.mjs`)**: Registered `telemetry_tail` MCP tool to query recent telemetry events. Wired `appendTelemetry` and `ProgressBus` into `gate()`, `repair()`, and `DagExecutor.execute()`.
- **Unit Test Suite (`test/telemetry-mcp-stream.test.mjs`)**: Added test suite verifying 1000 sequential O(1) appends (543ms), SHA-256 hash chain integrity, cold scan recovery, progress coalescing, message capping, backpressure safety, and tool execution.

## [0.22.9] - 2026-08-09
### Non-JSON Indentation-Block Structural Merger & Verification Chain
- **Block Chunker & Merger (`src/merge-blocks.mjs`)**: Implemented `chunkBlocks` parsing column-0 declaration boundaries (`export`, `function`, `class`, `const`, `def`, etc.) with SHA-1 hashing, and `mergeBlocks3Way` performing 3-way block classification (`IDENTICAL`, `ONLY_OURS`, `ONLY_THEIRS`, `ADDED_OURS`, `ADDED_THEIRS`, `DELETED`, `CONFLICT_EDIT_EDIT`) with standard conflict markers.
- **Syntax Verification Chain (`src/merge-verify.mjs`)**: Implemented `mergeVerifyChain` validating merged outputs via `node --check`, `tsc --noEmit` (if `tsconfig.json` exists), and `python3 -m py_compile`.
- **DAG Engine Hardening (`src/dag-engine.mjs`)**: Added registration freezing on `execute()`, `withTaskTimeout` per-task execution limits, and keyed output fingerprints (`${taskId}:${filePath}`).
- **Unit Test Suite (`test/merge-blocks.test.mjs`)**: Added tests asserting disjoint JS function additions, overlapping edit conflict generation, and post-execution `addTask()` rejection.

## [0.22.8] - 2026-08-09
### Statistical Flaky Test Quarantine & Ledger (Exit Code 8)
- **Flaky Test Ledger (`src/flaky-ledger.mjs`)**: Added `recordVerifyRun` appending run records to `.agent/state/flaky.jsonl` and `readVerifyRuns` / `getVerifyRuns` for reading stored run records. Implemented `flakyVerdict` evaluating sliding window of last $n \le 10$ runs to categorize tests (`HEALTHY`, `REPAIRABLE_REGRESSION`, `INSUFFICIENT_DATA`, or `QUARANTINED`).
- **Gate Integration (`src/engine.mjs`)**: Integrated verification run recording into `gate()`. Automatically evaluates `flakyVerdict()` on test failure and returns exit code `8` (`FLAKY_QUARANTINE`) when a test is quarantined, suppressing OODA auto-repair loop.
- **Unit Test Suite (`test/flaky-ledger.test.mjs`)**: Added test coverage verifying alternating P/F quarantine evaluation (`allowRepair = false`), 6 consecutive failures evaluation (`allowRepair = true`), ledger file IO, and gate exit code 8 return.
- **Documentation & Exit Code Registry (`AGENTS.md`)**: Documented Exit Code 8 (`FLAKY_QUARANTINE`) in exit code registry and troubleshooting matrix.

## [0.22.7] - 2026-08-09
### Integration Safety & Lock/Reaper Edge-Case Hardening
- **Stale Mutex Directory Reaper (`src/journal.mjs`)**: Added `reapStaleMutexDirs` scanning `.agent/state/` for `.mutex` directories older than `ttlMs` (30s) and using atomic grave paths (`.grave-<pid>`) with `rmdirSync` for CAS deletion. Wired into CLI boot in `bin/agentctl.mjs` and MCP server startup in `src/mcp.mjs`.
- **PID Starttime Verification (`src/journal.mjs`)**: Updated `reapOrphanedIntents` lock cleanup to verify process start time via `isPidAlive(lockPid, lockStartTime)`, preventing lock deletion when process IDs are reused.
- **Absolute File URL Net-Guard Flag (`src/engine.mjs`, `src/git.mjs`)**: Updated net-guard `--import` flag to construct absolute file URLs (`new URL("./preload-net-guard.mjs", import.meta.url).href`), preventing `ERR_MODULE_NOT_FOUND` in downstream consumer repositories.
- **Prompt Guard Envelope Neutralization (`src/prompt-guard.mjs`, `src/engine.mjs`)**: Forced full re-sanitization in `buildAgentEnvelope` even if input strings contain `<<<UNTRUSTED-DATA-BEGIN` to close pre-trust bypass vectors. Wired prompt guard sanitization and envelope creation into `dispatch()`.
- **Budget Accounting Event Filter (`src/state.mjs`)**: Refactored `checkDailyBudget` and `reserveBudgetAtomic` to filter and count exclusively `budget_reserved` events rather than total ledger lines.
- **Integration Test Suite (`test/kernel-integration-fix.test.mjs`)**: Added unit tests covering mutex reaping, live PID lock protection, net-guard URL resolution, and budget event filtering (182 total passing tests).

## [0.22.6] - 2026-08-09
### Intent Journaling & Boot-Time Zombie Worktree Reaper
- **Intent Journaling (`src/journal.mjs`)**: Implemented `journalIntent` and `journalDone` appending intent records to `.agent/state/journal.jsonl` with PID, `processStartTime`, operation type, target path, and timestamp.
- **Boot-Time Zombie Worktree Reaper (`src/journal.mjs`)**: Implemented `reapOrphanedIntents` to scan intent journal on startup, identify orphaned operations from dead/recycled PIDs using `isPidAlive`, prune orphaned git worktrees (`git worktree remove --force`), clean up stale locks, and append `journal_reaped` records for 100% idempotency.
- **Boot Wiring (`bin/agentctl.mjs`, `src/mcp.mjs`)**: Integrated automatic reaping at CLI boot in `main()` and MCP server startup in `startMcpServer()`.
- **Git Mutation Wrapping (`src/git.mjs`)**: Wrapped `worktreeAdd` and `createBranch` with intent journaling.
- **Unit Test Suite (`test/journal-reaper.test.mjs`)**: Added test coverage asserting dead PID cleanup, live PID preservation, completed intent safety, and idempotency.

## [0.22.5] - 2026-08-09
### Robust /proc Parsing, Queue Task Filtering & Execution Guardrails
- **Proc Stat Parsing (`src/state.mjs`)**: Refactored `getProcessStartTime` and added `parseProcStat` parsing fields strictly after `lastIndexOf(')') + 2` to prevent index shifts caused by process titles containing spaces or parentheses.
- **Queue Task Matching Filter (`src/engine.mjs`, `bin/agentctl.mjs`)**: Added `isTaskFile()` helper filtering out `README.md` and matching `TASK-*.md` or valid envelope front-matter in `.agent/jules-queue/`.
- **Process Execution Guardrails (`src/git.mjs`)**: Added default 10-minute timeout and 10 MB `maxBuffer` to process wrappers (`runCmd`, `git`). Handled `ETIMEDOUT` and `ENOBUFS` gracefully with structured exit codes (`124`, `1`).
- **Immutable Base Commit SHA Pinning (`src/git.mjs`, `src/execution_envelope.mjs`)**: Updated `resolveBase` to return exact 40-character commit SHAs output by `git rev-parse <ref>^{commit}` to pin `baseSha` immutably.
- **Edge Fixes Unit Test Suite (`test/edge-fixes.test.mjs`)**: Added comprehensive unit test coverage for all edge-case fixes (12 new tests passing).

## [0.22.4] - 2026-08-09
### Task DAG Executor with Cycle Detection & Interface Fingerprinting
- **Task DAG Engine (`src/dag-engine.mjs`)**: Implemented native zero-dependency `DagExecutor` and `DagCycleError`. Resolves dependencies via Kahn's Topological Sort algorithm, computes SHA-256 output hashes (`node:crypto` + `node:fs`) post-task execution, enforces interface fingerprint matching on dependent task gates, and schedules ready tasks lexicographically for deterministic parallel execution.
- **SDK Export (`index.mjs`)**: Exported `DagExecutor` and `DagCycleError` for SDK consumption.
- **Unit Test Suite (`test/dag-engine.test.mjs`)**: Added test coverage asserting linear DAG execution order, diamond DAG concurrent dispatch, circular graph pre-execution cycle errors, interface fingerprinting gate validation, and lexicographical tie-breaking determinism.

## [0.22.3] - 2026-08-09
### Hermetic Network Egress Guard
- **Hermetic Preload Guard (`src/preload-net-guard.mjs`)**: Intercepts and blocks unmocked network egress in test sub-processes without external npm dependencies by monkey-patching `globalThis.fetch`, `node:http.request`, `node:http.get`, `node:https.request`, and `node:https.get`.
- **Engine Environment Injection (`src/engine.mjs`, `src/git.mjs`)**: Automatically injects `NODE_OPTIONS="--import ./src/preload-net-guard.mjs"` into verification/test suite executions inside `gate()` and passes custom `env` options in `runCmd()`.
- **Network Guard Unit Test Suite (`test/net-guard.test.mjs`)**: Added unit test suite asserting blocked unmocked egress (exit code `188` and `[FATAL] ERR_UNMOCKED_NET: <host>` output to stderr) and allowed loopback requests (`localhost`, `127.0.0.1`, `::1`).

## [0.22.2] - 2026-08-09
### Security Boundary & MCP Stdout Isolation
- **Input Sanitization Boundary (`src/prompt-guard.mjs`)**: Added `sanitizeUntrustedData` and `buildAgentEnvelope`. Strips zero-width unicode, bidi control characters, ANSI sequences, and normalizes UTF-8. Neutralizes LLM control tags (`<|im_start|>`, `[INST]`), role markers (`system:`, `assistant:`), tag breakout attempts, and prompt injection patterns (`ignore previous instructions`). Prepends strict systemic data-only warning.
- **MCP Stdout Stream Isolation (`src/mcp.mjs`)**: Sealed `process.stdout.write` and isolated stdout stream from generic writes (like `console.log`), redirecting unauthorized writes to `process.stderr` to prevent JSON-RPC framing stream corruption.
- **Prompt Guard Unit Test Suite (`test/prompt-guard.test.mjs`)**: Added test suite asserting injection neutralization, bidi/ANSI stripping, and stdout stream isolation during MCP execution.

## [0.22.1] - 2026-08-09
### Kernel Hardening & Concurrency Safety
- **Mutex Fail-Closed Enforcement (`src/state.mjs`)**: Updated `withVfsMutex` to strictly throw `MutexTimeoutError` on lock acquisition timeout instead of executing the critical section without a valid lock.
- **Robust PID Recycling Validation (`src/state.mjs`)**: Enhanced `isPidAlive()` to read field 22 (`starttime`) from `/proc/<pid>/stat` on Linux. Stored process starttime and a random UUID `nonce` in lock payloads to prevent stale lock reaps from recycled PIDs.
- **Atomic Budget Reservation (`src/state.mjs`)**: Added `reserveBudgetAtomic()` protecting budget checking, reservation writing, and `fsyncSync` under `.budget.mutex`. Refactored `reserveBudget` and `appendLedger` to serialize under the dedicated budget mutex.
- **Kernel Hardening Unit Test Suite (`test/kernel-hardening.test.mjs`)**: Added automated unit tests verifying fail-closed mutex behavior, PID recycling starttime validation, and atomic budget reservation under 20 concurrent tasks.

## [0.22.0] - 2026-08-09
### Engine Baseline & Runtime Upgrade
- **Node.js LTS Engine Bump (`package.json`, `README.md`, `action.yml`)**: Raised Node.js engine requirement from `>=18.0.0` to `>=20.0.0` (Active LTS baseline). Unlocks stabilized `node:test` APIs, optimized V8 JIT compilation, and improved native `fetch` streaming performance.

## [0.21.0] - 2026-08-09
### Autonomous Jules Benchmark Audit & Hardening
- **Falsy Zero-Budget Fix (`src/config.mjs`)**: Fixed `JULES_DAILY_BUDGET: 0` evaluating as falsy and bypassing zero-budget limits.
- **Rule Path Security Guard (`src/risk.mjs`)**: Added missing `.agent/rules/**` to `RESTRICTED_PATH_PATTERNS`, guaranteeing rule edits trigger R3 Restricted risk classification.
- **OODA Fingerprint Normalization (`src/engine.mjs`)**: Extended `fingerprintFailureState()` regex for ANSI escape codes (`[\u001b\x1b]\[[0-9;]*[a-zA-Z]`), URL query parameters, line numbers, and column numbers.
- **MCP Server Parameter Validation (`src/mcp.mjs`)**: Added JSON-RPC `-32602` error validation for `check_risk_tier` input parameters and `-32601` for invalid methods.
- **Webhook Exception Hardening (`src/webhook.mjs`)**: Added safety `try-catch` wrappers around event callbacks and fallback routing for unhandled GitHub events (`onUnhandled`/`onFallback`).
- **Expanded Secret Redaction (`src/security.mjs`)**: Added redaction for Base64 JWTs, Slack bot tokens (`xoxb-`), and multiline RSA private key blocks.
- **Test Suite Expansion**: Expanded unit test coverage from 136 to 158 passing tests (`npm test`).

## [0.20.0] - 2026-08-08 (Community Release Candidate)
### L9 Production Architecture & Field-Testing Hardening
- **Linearizable VFS Directory Mutex (`src/state.mjs`)**: Kernel-level VFS directory mutex (`withVfsMutex`) guaranteeing strict serial linearizability for SHA-256 hash-chained session ledgers under high-concurrency multi-agent swarms.
- **PID Recycling & Stale Lock Protection (`src/state.mjs`)**: Added process start-time verification (`/proc/<pid>/stat` field 22 on Linux) to `isPidAlive()`, eliminating false-positive lock reaps from recycled OS process IDs.
- **Memory-Bounded Content-Length MCP Streaming (`src/mcp.mjs`)**: Implemented `McpFrameDecoder` with a 4 MB memory safety ceiling, supporting both HTTP-style `Content-Length` header framing and line-delimited JSON-RPC 2.0 messages over stdio. Added panic/error boundaries to prevent stdout stack-trace leaks.
- **Process Group Isolation & Zombie Defense (`src/process-group.mjs`)**: Implemented `ProcessGroupManager` with `detached: true` process group targeting and signal hooks (`SIGINT`/`SIGTERM`/`exit`) executing `process.kill(-pgid)` to guarantee 100% leak-free process tree cleanup.
- **TOCTOU & Symlink Defense (`src/security.mjs`)**: Added `safeAtomicWrite()` using `O_CREAT | O_EXCL | O_WRONLY` temp files with `fsyncSync` + `renameSync` and symlink traversal checks via `lstatSync` & `realpathSync`. ReDoS-hardened secret scanner regex patterns against catastrophic backtracking.
- **Deterministic 3-Way Structural Merge (`scripts/jules-merge-swarm.mjs`)**: Added `deepMerge3Way()` algorithm for recursive AST/JSON object and array merges, executed inside isolated temporary directories under `os.tmpdir()`.
- **OODA Thrash Ring-Buffer Breaker (`src/engine.mjs`)**: Upgraded `repair()` loop with `OODACircuitBreaker` sliding-window ring buffer to catch oscillating non-convergent failure patterns ($A \rightarrow B \rightarrow A \rightarrow B$).
- **Zero Runtime Dependencies**: 100% native Node.js 18+ ESM architecture (`"node": ">=18.0.0"`).

## [0.10.0] - 2026-08-08
### Security & Architectural Hardening (P0/P1 Fixes)
- **Shell-less Process Execution (`src/git.mjs`, `src/engine.mjs`)**: Refactored `runCmd()` to tokenise command strings and execute directly via `execFileSync` without invoking system shell (`sh -c` / `cmd.exe /c`), preventing command injection vulnerabilities.
- **Fail-Closed Webhook Verification (`src/webhook.mjs`)**: Updated `verifySignature()` to fail closed when `JULES_WEBHOOK_SECRET` is unset. Added 2 MB payload cap and replay protection in `createWebhookServer()`.
- **Expanded Secret Scanning (`src/security.mjs`)**: Added 2026 key formats (`github_pat_`, Anthropic `sk-ant-`, OpenAI `sk-proj-`, Google OAuth `ya29.`, Slack bot tokens) to `HIGH_CONFIDENCE_PATTERNS`.
- **Execution Envelope Canonicalization (`src/execution_envelope.mjs`)**: Updated `hashExecutionEnvelope()` to include `baseRef` and `createdAt` alongside key-canonicalization in the SHA-256 digest.
- **Durable Ledger Persistence & Self-Healing (`src/state.mjs`)**: Updated `appendLedger()` to use `openSync(filePath, "a")`, `writeSync()`, and `fsyncSync()`. Added fallback to read the last valid line during tail torn writes in `appendLedger()` and `verifyLedgerIntegrity()`. Added `hostname()` fingerprinting and `fsyncSync()` to `acquireLock()`.
- **OODA Thrash Fingerprint Normalization (`src/engine.mjs`)**: Refined `fingerprintFailureState()` to normalize path/line noise without altering failure hashes based on volatile diff text.

## [0.9.4] - 2026-08-08
### Added & Enhanced (Native MCP Server & Exit Code Registry Alignment)
- **Zero-Dependency Stdio MCP Server (`src/mcp.mjs`, `bin/mcp-server.mjs`)**: Implemented native Model Context Protocol (MCP) server over stdio streams using Node.js `node:readline` and JSON-RPC 2.0. Exposes orchestrator tools (`dispatch_jules_task`, `audit_jules_gate`, `check_risk_tier`, `get_jules_status`) directly to AI environments like Antigravity, Claude, and Cursor.
- **CLI & Package Expositions**: Added `agentctl mcp` command and exposed `jules-mcp` and `agentctl-mcp` binary targets in `package.json`.
- **Exit Code 7 Alignment (`BudgetError`)**: Updated `withBudget` in `src/state.mjs` to throw `BudgetError` with explicit `code: 7` on daily session budget exhaustion (`dailyTasks: 300`).
- **Documentation & Remediation Matrix**: Documented `Exit 7` in `AGENTS.md` and added a complete Exit Code Troubleshooting & Remediation Matrix for codes `0–7`.
- **MCP Test Suite (`test/mcp.test.mjs`)**: Added automated unit tests verifying JSON-RPC 2.0 protocol handling, tool execution, and stdio stream parsing (120 total passing tests).

## [0.9.2] - 2026-08-03
### Added & Modularized (Universal Architecture & Security Hardening)
- **Modular Domain Architecture (`src/`)**: Completely refactored from vendored script prototype into native ESM modules (`src/config.mjs`, `src/security.mjs`, `src/git.mjs`, `src/provider.mjs`, `src/state.mjs`, `src/engine.mjs`).
- **Unified Command-Line Interface (`agentctl`)**: Added single `bin/agentctl.mjs` CLI executable supporting `dispatch`, `gate`/`audit`, `queue`, `swarm`, `lock`, `doctor`, and `init` with `--json` output options.
- **Provider-Agnostic Engine Architecture**: Configuration-driven template adapters supporting `http` and `exec` providers (`jules`, `claude-code`, `codex`, Ollama, Bedrock) with shell-less execution (`spawnSync`, `shell: false`).
- **Zero-Dependency Guarantee**: Core engine built strictly using native Node.js ≥ 18 built-in modules (`node:fs`, `node:path`, `node:child_process`, `node:crypto`, `node:util`).
- **Centralized Scope Normalizer & Trusted Origin Resolution**: `normalizeScope()` guarantees `BUILTIN_DENY` patterns (`.git/**`, `**/.env`, `**/*.pem`, `.github/**`, etc.) are merged unconditionally, and `gate()` fetches rules strictly from `origin/${base}` via `showFromOrigin()`.
- **Adversarial Test Suite (`test/adversarial.test.mjs`)**: 90/90 unit, integration, and adversarial security tests locking in shell injection defense, fail-closed git resolution, prototype pollution guards, and lock atomic creation.

## [0.8.6] - 2026-08-03
### Added & Hardened (Community Audit & Security Enhancements)
- **Safety Gate Verification Engine**: Added `checkSafetyGate()` in `scripts/jules-merge-swarm.mjs` to inspect active worker locks (`.agent/state/locks/*.json`) before squashing PRs, preventing active session merge collisions.
- **UNTRUSTED Prompt Injection Fencing & Pre-Flight Static Checks**: Enhanced `<UNTRUSTED_TASK_CONTEXT_${nonce}>` directives in `scripts/jules-dispatch.mjs` with explicit injection defense rules and added `runPreflightStaticCheck()` to pre-run static analysis (`eslint`, `tsc`, `npm run lint`) and inject error reports into `<PREFLIGHT_STATIC_ANALYZER_ERRORS>`.
- **3-Bucket Status Categorization**: Added `categorizeTaskStatus()` in `scripts/jules-status.mjs` partitioning task outputs into *🚨 Action Required*, *⏳ In Progress*, and *✅ Completed / Terminal*.
- **Specialist Agent Prompts & Master Template**: Added `.agent/prompts/` directory featuring `Overseer.md` (codebase audit specialist), `Bolt.md` (micro-performance optimizer), `Sentinel.md` (security auditor), and `Task_Template.md` (master prompt template).

## [0.8.5] - 2026-08-03
### Added & Hardened (Enterprise Governance & Swarm Core)
- **Disjoint Swarm PR Auto-Merge Engine**: Added `scripts/jules-merge-swarm.mjs` (`npm run jules:merge-swarm`) to automatically verify CI checks, evaluate disjoint file cluster modifications (zero file collisions), and squash-merge passing Jules PRs (`gh pr merge --squash --delete-branch`).
- **`baseBranch` REST Payload Decoupling**: Updated `startingBranch` in `jules-dispatch.mjs` to strictly use `BASE_BRANCH || "main"` (the remote base ref), preventing HTTP 400 `sessionFailed` errors from unpushed local feature branches.
- **Active Session Quota Backoff (`FAILED_PRECONDITION`)**: Added HTTP 400 `FAILED_PRECONDITION` detection (~30 concurrent max session limit) with exponential retry backoff in `jules-dispatch.mjs` and `concurrency_limit` classification in `jules-queue-runner.mjs`.
- **OODA Repair Secret Masking**: Wrapped failure logs in `redactSecrets(anonymizePii(failureLog))` inside `jules-self-audit.mjs` before dispatching auto-repair prompts.
- **Configurable Diff Payload Limit (`JULES_MAX_DIFF_KB`)**: Made maximum diff payload size configurable via `JULES_MAX_DIFF_KB` (default 50 KB).
- **Automatic PII Anonymization**: Added `anonymizePii(text)` to `utils.mjs` and integrated into `jules-dispatch.mjs` to automatically mask emails (`[REDACTED_EMAIL]`), IPv4 addresses (`[REDACTED_IP]`), and multi-segment phone numbers (`[REDACTED_PHONE]`) from outbound task prompts.
- **Strict Fail-Closed Config Validator**: Added `validateJulesConfig(configContent, jsonContent)` in `jules-self-audit.mjs` to validate rules and RegExp triggers in `.agent/rules/dynamic-guardrails.json` and `.agent/jules.yml`.
- **Ledger Hash-Chain Integrity Verification**: Added `verifyLedgerIntegrity(filePath)` to `utils.mjs` computing SHA-256 hash chains across JSONL ledger records.
- **Expanded SDK Exports**: Re-exported `anonymizePii`, `verifyLedgerIntegrity`, `validateJulesConfig`, and `classifyQueueFailure` from `index.mjs`.

## [0.8.4] - 2026-08-03
### Fixed & Hardened
- **Dynamic Guardrails Schema Alignment**: Fixed schema drift in `jules-dispatch.mjs:getDynamicGuardrails` by supporting both `rule.directive` and `rule.guardrail` properties from `.agent/rules/dynamic-guardrails.json`.
- **PuTTY PPK Format Pattern Fix**: Updated PuTTY secret scanning pattern in `utils.mjs` to match actual PPK key headers (`PuTTY-User-Key-File-\d+:`).
- **Expanded Secret Redaction (10+ New Token Families)**: Added high-confidence & low-confidence secret regex patterns for Google OAuth client secrets (`GOCSPX-`), AWS STS tokens (`ASIA`), GitLab PATs (`glpat-`), DigitalOcean PATs (`dop_v1_`), SendGrid API keys (`SG.`), Stripe Webhook secrets (`whsec_`), Slack App Tokens (`xapp-`), Shopify PATs (`shpat_`), Basic Auth headers, and Azure SAS signatures (`?sig=`). Expanded env-var key matching filter to include `PASSPHRASE`, `URL`, `URI`, `DSN`, `CONNECTION`, `ACCOUNT`.
- **SDK & MCP Export Readiness**: Exported `dispatchTask` in `jules-dispatch.mjs` and `classifyQueueFailure` in `jules-queue-runner.mjs`, making them available from the `index.mjs` primary SDK entrypoint for programmatical and MCP server invocation.

## [0.8.3] - 2026-08-03
### Security & Architectural Hardening
- **P0 Untrusted Prompt Envelope Noncing**: Replaced static `<UNTRUSTED_TASK_CONTEXT>` tags in `jules-dispatch.mjs` with crypto-random nonced tags (`<UNTRUSTED_TASK_CONTEXT_${nonce}>`) and case-insensitive closing tag stripping to prevent prompt injection escapes.
- **P0 Image Attachment Containment & Path Traversal Prevention**: Added `realpathSync` root containment checks in `extractImageAttachments` to block traversal attacks (`../../../etc/passwd.svg`) and eliminated the wasteful 500KB `dataUri` exfiltration vector.
- **P0 Secret Scanner Buffer Overflow & Fail-Closed Policy**: Expanded `runGitCommand` buffer in `jules-self-audit.mjs` to 25MB (`maxBuffer`) and disabled silent error swallowing on git diff execution (`ignoreError = false`), guaranteeing secret scans fail-closed on massive diffs.
- **P0 Unconditional CI Audit & Scope Guard Workflows**: Removed `jules/` head ref and actor restrictions from `.github/workflows/agent-scope-guard.yml` and `.github/workflows/jules-audit.yml`, ensuring gatekeeper checks run on all PRs regardless of actor.
- **P0 Syntax Fix for Status CLI**: Removed duplicated broken `try`-block in `scripts/jules-status.mjs`.
- **P1-8 End-to-End Integration Test Harness**: Added `test/integration.test.mjs` running end-to-end CLI tests in isolated temporary Git repos, asserting exit codes 0, 3, 5, 6, 7, 8 across 58 total test cases.
- **P1 REST API Payload & CLI Fallback**: Added `automationMode: AUTOMATION_MODE_AUTO_PR` to REST payloads and updated CLI fallback to `jules remote new`.
- **P1 Redaction Expansion (13+ Patterns)**: Expanded secret scanner in `utils.mjs` for Cloudflare tokens, Supabase service keys, HuggingFace tokens, Slack webhooks, PuTTY keys, and database connection strings.
- **P1 Concurrency & Exit Codes**: Separated budget state lock contention (Exit Code 8) from daily limit exhaustion (Exit Code 7) with automatic re-queuing without retry penalties in `jules-queue-runner.mjs`.
- **P1 Trusted Rules Isolation**: Split `BASE_BRANCH` ref from session `START_BRANCH` in `jules-dispatch.mjs` and enforced fail-closed fallback to embedded directives when running in CI.
- **P2 Dynamic Guardrails & Lock Manager**: Connected `.agent/rules/dynamic-guardrails.json` at runtime, added `JULES_ALLOW_RESTRICTED_FILES=true` override support, wired `--unattended` in `lock-manager.mjs`, and added process lifecycle tracking in `jules-swarm.mjs`.

## [0.8.2] - 2026-08-01
### Fixed & Hardened
- **Safe CI Template Scaffold**: Updated `.github/workflows/jules-audit.yml` to use `npm run lint --if-present` and `npm test --if-present`, preventing scaffolded user repositories without a `lint` script from failing CI on first push.
- **Untrusted Prompt Fencing & Security Header**: Added `# SECURITY DIRECTIVE — UNTRUSTED CONTENT FENCE` header and untrusted specifications instruction inside `<UNTRUSTED_TASK_CONTEXT>`. Omitted `<rule>VERIFICATION LOOP` tag when `testCmd` is empty.
- **Queue Runner Non-Zero Exit on Permanent Failures**: Updated `jules-queue-runner.mjs` to exit with code 1 when any queue tasks fail permanently. Added explicit `cli_error` failure classification for CLI execution errors.
- **Package Payload Shrink**: Excluded `.github/social-preview.png` and scoped `files` in `package.json` to `.github/workflows/jules-audit.yml`, reducing npm tarball size by 87% (from 332.9 kB down to 44.8 kB). Removed dead entries from `.npmignore`.
- **Detailed Restricted File Violations**: Updated `jules-self-audit.mjs` to explicitly output matching pattern / `allow_paths` rules, specify that config was loaded from `${mainRef}:.agent/jules.yml`, and state the `JULES_ALLOW_RESTRICTED_FILES=true` override flag.
- **Git Stderr Leak Fix**: Suppressed `fatal: Needed a single revision` stderr output in `runGitCommand` during fallback handling when `ignoreError` is true.
- **Local Date & Timezone Alignment**: Exported `getLocalDateString()` in `utils.mjs` using local year/month/day instead of UTC `toISOString()`, fixing 02:00 CEST budget reset drift.
- **CI OODA State Caching**: Added `actions/cache@v4` step for `.agent/state/` to `.github/workflows/jules-audit.yml` and `jules-nightly.yml`.
- **Documentation Sync**: Updated `PRIOR_ART.md` and `ROADMAP_V1.md` to reference "Zero Runtime Dependencies".

## [0.8.1] - 2026-07-31
### Fixed & Hardened
- **OODA Function Module-Scope Fix**: Moved `getOodaStateFile` to top-level module scope in `jules-self-audit.mjs`. Fixed a `ReferenceError` caused by block-scoping in strict mode that prevented OODA state files from being deleted upon passing audits.
- **Queue Budget Deferral**: Daily budget exhaustion (`budget_exhausted`) is no longer treated as permanent failure. Tasks are left/re-queued as `DEFERRED_BUDGET` without incrementing retry attempt counts.
- **Automatic 30-Day Ledger Pruning**: Added `pruneOldLedgers()` to `utils.mjs` to automatically clean up date-stamped `.jsonl` files older than 30 days.
- **Enhanced Guardrail Error Messages**: Updated `jules-self-audit.mjs` error messages to explicitly list offending files and matching override flags (`JULES_ALLOW_COMMAND_FILE_CHANGES=true` or `JULES_ALLOW_AGENT_RULE_CHANGES=true`).
- **Complete Gitignore Scaffolding**: Added `.agent/jules-queue/.state/`, `.agent/jules-queue/failed/`, and `.agent/jules-queue/.processing/` to root `.gitignore` and `bin/init.js`.

## [0.8.0] - 2026-07-31
### Added & Hardened (Fleet Intelligence & Nightly Architecture)
- **Daily Ledger Rotation**: Session ledgers rotate into daily date-stamped files (`.agent/state/sessions/YYYY-MM-DD.jsonl`), preventing ledger bloat and speeding up daily budget calculations.
- **Package Manager Detection**: `resolveProjectCommands` now automatically detects `pnpm` (`pnpm-lock.yaml`), `yarn` (`yarn.lock`), `bun` (`bun.lockb`), and `packageManager` fields before falling back to `npm`.
- **JSON Status Reporting**: Added `--json` output flag to `scripts/jules-status.mjs` for programmatic status and budget metric consumption.
- **Global Swarm Partitioning**: Updated `scripts/jules-swarm.mjs` to pass global task indices across the entire swarm queue rather than per-batch indices.

## [0.7.0] - 2026-07-31
### Added & Hardened (Autonomous Fleet Reliability Core)
- **Zero-Trust Base-Branch Rule Extraction**: `getBaseRules()` now fetches `AGENTS.md` and `JULES_RULES_TEMPLATE.md` directly from `origin/main` via `git show`, preventing untrusted PR branches from injecting malicious agent instructions.
- **Agent Rule Change Guardrail**: Added `RESTRICTED_AGENT_FILES` check (`AGENTS.md`, `JULES_RULES_TEMPLATE.md`, `.agent/rules/**`, `.agent/workflows/**`). Modifications fail closed with Exit Code 3 unless `JULES_ALLOW_AGENT_RULE_CHANGES=true`.
- **Executable Build Config Guardrail**: Expanded `COMMAND_DEFINING_FILES` with `EXECUTION_CONFIG_FILES` (`jest.config.*`, `vitest.config.*`, `playwright.config.*`, `vite.config.*`, `webpack.config.*`, `next.config.*`, `babel.config.*`, `tsconfig.json`, `.npmrc`, `pnpmfile.*`).
- **Safe Dispatch Cleanup**: Replaced `process.exit(7)` inside `executeDispatch` with a thrown error (`err.code = 7`), guaranteeing `finally { cleanupTmp(); }` executes and wipes temporary payload files.
- **Queue Failure Classification & Non-Retryable Exceptions**: Added `classifyQueueFailure()` to `jules-queue-runner.mjs`. Immediately moves security violations (`Exit Code 3`), secret leaks (`Exit Code 6`), payload bloat (`Exit Code 5`), and budget limits (`Exit Code 7`) to `.agent/jules-queue/failed/` without wasting retry attempts.
- **Queue Sidecar State Architecture**: Queue task attempt history is now stored in `.agent/jules-queue/.state/<file>.json` instead of mutating task markdown files.
- **Scoped OODA Retry State**: Scoped `.agent/state/ooda/<key>.json` by PR/branch/merge-base hash to eliminate race conditions between concurrent CI runs.

## [0.6.3] - 2026-07-31
### Fixed & Hardened
- **Removed Unverified Third-Party Setup URL**: Replaced misleading `app.jules.ai/setup` link in `bin/init.js` with official Google Jules portal `https://jules.google`.
- **Renamed Workspace Setup Code**: Clarified terminology in `bin/init.js` and `.agent/JULES_WEB_SETUP.md` from "Cryptographic Handshake" to "Encoded Workspace Manifest".
- **Added Missing Helper Scripts to Target `package.json`**: Added `"jules:cleanup"` and `"jules:scan"` script entries to injected `package.json` manifest.
- **Automatic `.gitignore` Security Scaffolding**: `bin/init.js` now automatically injects required security ignore rules (`.env`, `.agent/history/`, `.agent/state/`, `.agent/jules-queue/*.md`) into target `.gitignore` if missing.
- **Vendored Architecture Documentation**: Documented zero-dependency vendored scripts model and `npx jules-init --force` upgrade pathway in `README.md`.

## [0.6.2] - 2026-07-31
### Fixed
- **Dynamic Secret Test Fixtures**: Constructed secret strings dynamically in `kit.test.mjs` (`"gho_" + "1".repeat(36)`) to prevent static string literals from triggering Exit Code 6 on self-audits of test files.
- **Restored `redactSecrets` Test Coverage**: Added dedicated unit tests verifying that `redactSecrets` masks active environment variables, OAuth tokens, Bearer headers, private keys, npm tokens, and Stripe keys.
- **Lockfile-Only Diff Payload Governor**: Fixed payload size governor calculation when `changedCodeFiles` is empty (e.g., lockfile-only PRs), returning 0 bytes instead of falling back to full raw diff size.
- **CI OODA State Scope**: Documented that `.agent/state/ooda.json` tracks local retry state, whereas ephemeral CI runners rely on `git log` auto-repair commit history.

## [0.6.1] - 2026-07-31
### Fixed & Hardened
- **Atomic Budget Lock Fix**: Fixed `reserveDailyBudget` lock fallback. Implemented exclusive `wx` lock retries with random jitter sleep (`50-100ms`), eliminating lock override bug.
- **Budget Counting Fix**: `checkDailyBudget` now counts exclusively `budget_reserved` events, preventing double-counting with `session_dispatched`.
- **Added-Line Secret Scanner**: Secret scanner now evaluates enclaves of added diff lines (`+` prefix, ignoring `+++` headers) and separates High-Confidence secrets (Exit Code 6) from Low-Confidence/Test Keys (warnings).
- **Code Diff Payload Governor**: Calculated 75 KB payload governor size strictly on code files (`changedCodeFiles`), preventing lockfiles from triggering false positive Exit Code 5 errors.
- **Documentation**: Documented `JULES_DAILY_BUDGET` and `JULES_ALLOW_COMMAND_FILE_CHANGES` in `README.md` and `.env.example`. Added `allow_paths` deny-by-default note.

## [0.6.0] - 2026-07-31
### Security & Resilience Hardening
- **Command File Guardrail**: Added `COMMAND_DEFINING_FILES` check to `jules-self-audit.mjs`. PRs modifying `package.json`, `Cargo.toml`, `.agent/jules.yml` fail closed with Exit Code 3 unless `JULES_ALLOW_COMMAND_FILE_CHANGES=true` is set.
- **Immutable Forbidden Paths**: Enforced that `forbidden_paths` cannot be overridden by `allow_paths` in `.agent/jules.yml`.
- **Zero-Trust Base Branch Extraction**: Switched to safe `execFileSync` for `git archive` and `tar` without working-tree fallback on extraction error.
- **Enhanced Secret Redaction**: Added support for `gho_` GitHub OAuth tokens, word boundaries for Bearer tokens, generalized Google API key patterns, npm tokens, and Stripe keys.
- **Atomic Budget Reservation**: Implemented `reserveDailyBudget` with `.agent/state/budget.lock` file locking and event filtering for concurrent dispatch protection.
- **Sidecar OODA State**: Tracks OODA retries via `.agent/state/ooda.json` instead of fragile text matching in `git log`.

## [0.5.2] - 2026-07-31
### Added
- Created standard `CONTRIBUTING.md`, `CHANGELOG.md`, and `SECURITY.md` files.
- Added a Node.js matrix check in GitHub Actions for broader compatibility testing.
- `.env.example` has been updated with all 19 supported configuration variables.

### Fixed
- Fixed an issue in `jules-self-audit.mjs` where `runCommand("git status")` would throw a ReferenceError by properly invoking `execSync`.
- Replaced `process.exit(1)` with `throw new Error()` in exported SDK functions so downstream consumers are not abruptly terminated.
- Updated path-traversal vulnerability in `jules-dispatch.mjs` to properly use `path.relative` with bounds checking instead of a weak `.startsWith` match.
- Added `AbortSignal.timeout(30000)` to fetch calls to prevent hanging REST API connections.
- Handled HTTP 400 and 401 gracefully by throwing errors rather than incorrectly falling back to CLI.
- Respected the `Retry-After` header when HTTP 429 limits are hit by waiting before retry.
- Restrict `redactSecrets` matching to Shannon entropy limits > 3.6 and length >= 20.
- Ensure `.agent/protected-paths.json` is immutable via `origin/main` loading and self-protection.
- Handled missing node_modules when testing in the preflight sandbox using `npm ci --ignore-scripts`.
- Wrapped `loadEnv()` in an `isMainModule` check to prevent unintended mutations when importing via SDK.

## [0.5.0] - 2026-07-31
### Added
- Aligned project with Google Jules advanced protocol and guardrails.

## [0.3.0]
### Added
- Epistemic Bridge support: Cryptographic Handshake Token generation for Web UI synchronization.
