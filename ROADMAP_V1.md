# 🗺️ Jules Orchestrator Kit — Roadmap to v1.0 & Beyond

The **jules-orchestrator-kit** is the zero-dependency safety gatekeeper and self-healing engineering kernel for autonomous coding agents running on **Google Jules**.

> [!IMPORTANT]
> **Zero Runtime Dependencies is a strict core invariant.**  
> Every feature on this roadmap is built strictly with native Node.js 20+ built-in modules (`node:fs`, `node:child_process`, `node:crypto`, `node:http`, `node:readline`, `node:test`).

---

## 📌 Release Milestones Overview

```
 v0.52.4 (Current Stable) ──► v0.60.0 (Distributed Swarms & Leases) ──► v1.0.0 (Production Hardened Kernel)
 (Session Ops & MCP Suite)   (Multi-Agent DAG & Resource Locks)        (Enterprise Telemetry & SLA)
```

---

## ✅ Shipped Milestones (v0.20.0 – v0.52.4)

### v0.52.4: Arena Adversarial Audit Remediation & Integrity Hardening
- [x] **Base64 Line-Wrapped Secret Smuggling (`src/security.mjs`)** — Collapses whitespace and newlines between adjacent base64 characters (RFC 4648 PEM keys, template literals, and quoted chunks) before base64 candidate decoding.
- [x] **Vacuous Assertion Tamper Guard (`src/security.mjs`)** — Adds `VACUOUS_ASSERTIONS` detection in `checkTestTampering` to reject assertion weakening (`assert.ok(true)`, `expect(true).toBe(true)`, `assert.equal(1, 1)`).
- [x] **Offline Network Guard Exit Code 188 Classification (`src/engine.mjs`, `bin/agentctl.mjs`, `AGENTS.md`)** — Differentiates sandbox network kills (Exit 188) from test regressions, bypasses OODA loop, and guides local dependency installation.
- [x] **Git `--base HEAD` Local Reference Resolution (`src/git.mjs`)** — Prevents prepending `origin/` to `HEAD` and relative commit pointers.
- [x] **Config Limits Shadow-Blocking & `jules.yml` v2 Preservation (`src/wizard-init.mjs`)** — Omits redundant `limits:` blocks in `.agent/config.yml` and preserves `forbidden_paths` in `.agent/jules.yml` v2.

### v0.52.3: Jules Session Patch Ingestion, Edge Webhooks & Subprocess Hardening
- [x] **Jules API Activity Patch Ingestion (`src/session-ops.mjs`, `src/provider.mjs`)** — Fixes `listActivities` sessionId TypeError and adds support for Jules API `changeSet.gitPatch.unidiffPatch` artifacts in `extractSessionPatch`.
- [x] **Subprocess Hardening via `runCmd` (`src/coverage.mjs`, `src/mutation.mjs`, `src/perf.mjs`)** — Replaces raw `execSync` with safety-hardened `runCmd` with `{ ignoreError: true }` across coverage, mutation, and perf monitors.
- [x] **Edge Runtime Webhook Support (`src/webhook.mjs`)** — Refactors `verifySignature` and `parseWebhookPayload` to use `Uint8Array`, `TextEncoder`, and `TextDecoder`.
- [x] **Whack-a-Mole Prompt Injection Defense (`src/remediation.mjs`)** — Encloses oscillating test names in `<UNTRUSTED>` fencing tags.

### v0.52.2: Zero-Test Oracle Bootstrapping & Git Remote Origin Auto-Detection
- [x] **Zero-Test Oracle Bootstrapping on Empty Test Oracle (`src/stack-detector.mjs`)** — Allows `agentctl bootstrap` to proceed without `--force` when `verify.test` is empty, updating config in-place while preserving tier, daily tasks, and presets.
- [x] **Git Remote Origin Auto-Detection for Provider Dispatch (`src/git.mjs`, `src/provider.mjs`)** — Parses `owner/repo` from `remote.origin.url` across SSH and HTTPS formats, allowing zero-config live and dry-run dispatches.

### v0.52.1: Onboarding Usability Hardening, Lockfile Detection & Subcommand Help
- [x] **Queue Task Ghost False Positive Elimination (`src/ops/next-step.mjs`)** — Filters queue tasks using `isTaskFile(f, queueDir)` to prevent `.agent/jules-queue/README.md` from being reported as a queued task.
- [x] **Contract Files Post-Init Commit Hint (`bin/agentctl.mjs`)** — Dynamically builds `git add` line including `SPEC.md`, `CONSTRAINTS.md`, and UI contracts alongside `.agent` and `AGENTS.md`.
- [x] **Subcommand-Specific `--help` Formatting (`bin/agentctl.mjs`, `src/ops/command-registry.mjs`)** — Routes subcommand help to `formatCommandHelp` using registry descriptors; added descriptors for `mutate`, `coverage`, `gate`, `probe`, `perf`, `dispatch`, and `bootstrap`.
- [x] **Non-Interactive CI Initialization (`bin/agentctl.mjs`, `src/wizard-task.mjs`)** — Added `--non-interactive`, `--no-interactive`, and `-y`/`--yes` CLI options.
- [x] **TODO Scanner Field Parity (`scripts/jules-scan-todos.mjs`, `bin/agentctl.mjs`)** — Emits both `type` and `tag` on scanned items to fix `[undefined]` rendering.
- [x] **Stack Detector Zero-Test Fallback (`src/stack-detector.mjs`)** — Fixed `scripts.test ? "npm test" : ""` ternary bug to return empty testCmd when no test script is declared.
- [x] **Polyglot Lockfile & Linter Availability Checks (`src/stack-detector.mjs`, `src/wizard-oracle.mjs`)** — Added `pnpm-lock.yaml`, `yarn.lock`, `bun.lock` detection and `hasBinary` guards before setting linter commands.

### v0.52.0: Jules Power-User Session Operations, Patch Application & Full MCP Tools Suite
- [x] **Power-User Session Operations Engine (`src/session-ops.mjs`, `agentctl patch`, `agentctl retry`, `agentctl prune`)** — Zero-dependency session patch extractor, `git apply --check` safety harness, failure-activity OODA retry injector, and batch session pruner with human duration filters.
- [x] **Provider Remote Lifecycle Endpoints (`src/provider.mjs`)** — Native `listSessions`, `listActivities`, `archiveSession`, `deleteSession`, and `listSources` with transparent failover and syntax-verification provider delegations.
- [x] **Comprehensive Model Context Protocol (MCP) Tools Suite (`src/mcp.mjs`, 17 tools total)** — Full lifecycle remote management tools for Jules agents and orchestrators.
- [x] **API Surface & Frozen SDK Snapshot Expansion (`index.mjs`, `test/api-surface.test.mjs`)** — Locked at 236 exported symbols.

### v0.51.0: Asymmetric Mechanical Falsification, AST Mutation Testing & V8 Diff Coverage
- [x] **Diff-Hunk Mutation Testing Engine (`src/mutation.mjs`, `agentctl mutate`, `assert:mutation`)** — Transactional operator inversion (`===`/`!==`, `>=`/$<$, `&&`/`||`, `true`/`false`, `+`/`-`) with multiline string/template literal shielding (`getFileStringLiteralLineMap`) and automatic shadow disk rollback.
- [x] **Native Zero-Dep V8 Diff Coverage Enforcer (`src/coverage.mjs`, `agentctl coverage`, `assert:diff-coverage`)** — Zero-dependency coverage extraction using Node native `NODE_V8_COVERAGE`, translating byte offset ranges to 1-indexed line hit counts against added `+` diff hunks.
- [x] **Whack-a-Mole Test-Oscillation Cycle Detector (`src/remediation.mjs`, `src/engine.mjs`)** — Tracks test failure sets and rolling SHA-256 state tuples across repair attempts, switching to `WHACK_A_MOLE_PIVOT` strategy upon detecting 2-cycle or 3-cycle oscillation.
- [x] **Flakiness Stability Prober (`src/stability.mjs`, `agentctl probe`, `assert:test-stability`)** — Executes target suites across $N$ isolated passes with mathematical oscillation tracking to reject intermittent timing races before merge.
- [x] **Node.js Event Loop Delay & Big-O Guard (`src/perf.mjs`, `agentctl perf`, `assert:event-loop-lag`)** — Samples $p99$, mean, and max event loop delay via `node:perf_hooks` to protect against main-thread starvation and catastrophic regex backtracking.
- [x] **Unix Stdin Stream Pipeline (`agentctl fix`)** — Direct terminal piping (`npm test 2>&1 | agentctl fix`) with secret scrubbing and automated OODA repair dispatch.

### v0.43.0: Documented Specialist Roles Ship As Prompts, & Universal Stack-Agnostic Envelopes
- [x] **Four Missing Specialist Roles Shipped (`.agent/prompts/`)** — The rules template advertised A11y, Scribe, Spectator and Alchemist as specialist personas, but no prompt file existed for any of them, so `agentctl dispatch --role a11y` resolved to `null` on every install. Added stack-neutral prompts for all four (WCAG/focus/measured contrast, metadata/JSON-LD/canonical parity with honest claims, headless E2E with no sleep-based waits, and schema/reversibility/data-loss review for migrations). They hydrate `{{VERIFY_TEST}}`/`{{VERIFY_LINT}}`/`{{DIFF_KB}}`/`{{BASE_BRANCH}}` from the target repo's config, like the original four.
- [x] **Four Universal, Stack-Agnostic Task Templates (`src/web-templates.mjs`)** — `agent-dep-audit`, `agent-doc-drift`, `agent-config-audit` and `agent-api-contract` work in any stack the detector recognises (Cargo, Go, Python, PHP, .NET, Java, Ruby, Elixir, Node) because their prompts name no package manager or language and the verification command is hydrated from `config.verify.test`. Each carries a real, locally-falsifiable oracle rather than a "best practice" claim.
- [x] **Coverage & Documentation Parity (`test/role-prompts.test.mjs`, `test/web-templates.test.mjs`, `AGENTS.md`, `JULES_RULES_TEMPLATE.md`, `EXAMPLES.md`, `README.md`)** — A new test asserts every documented role has a prompt file; the template tests assert the universal block contains no npm/npx/node tooling and synthesizes through `planTaskCreate` with a non-Node verify command. Both rule files stay inside the 10,000-char budget.

### v0.42.0: Universal Rules Governance, All-In-One Check Gate & Stack Contracts
- [x] **First-Class Rules CLI Subcommands (`bin/agentctl.mjs`, `src/rules-budget.mjs`)** — Added `agentctl rules check` (token and line budget linter preventing silent LLM context truncation) and `agentctl rules compile` (SHA-256 and byte-length anti-truncation sentinels).
- [x] **All-In-One CI Verification Gate (`agentctl check`, `bin/agentctl.mjs`)** — Added `check` command to run secret scanning, scope guard, diff payload limits (<75 KB), rules budget, and auto-detected stack verification suites in one unified command.
- [x] **Stack-Tailored Contract Template Scaffolding (`src/scaffold.mjs`)** — Automatically generates `SPEC.md`, stack-tailored `CONSTRAINTS.md` (Cloudflare/workerd, Rust, Go, Python, Node/TS), and `DESIGN.md` for UI projects on `agentctl init`.
- [x] **Rules CLI Test Suite (`test/rules-cli.test.mjs`)** — Added 11 unit/integration tests covering rules budget checking, sentinel generation, and stack contract tailoring.

### v0.41.1: The Gate Knew More Than It Said
- [x] **First-Install Blockers Closed (`src/security.mjs`, `src/scaffold.mjs`)** — A diff with 65+ integrity hashes failed closed as a CRITICAL secret leak, because a sha256 digest is 64 base64-alphabet characters and consumed a decode slot despite being discarded; and `agentctl init` left the kit's own ledgers and evidence manifests untracked in the tree the gate audits, so they came back as scope violations and then as a secret verdict. A new user hit both before dispatching anything.
- [x] **One Scaffolding Path (`src/scaffold.mjs`, `bin/init.js`)** — `jules-init` wrote `AGENTS.md`, the role prompts and the guardrails; `agentctl init`, which the quickstart points at, wrote none of them. Both entry points now call one `scaffoldRepoAssets()`, preserving existing files unless `--force`.
- [x] **Diagnostics That Reach the Operator (`src/security.mjs`, `src/engine.mjs`, `bin/agentctl.mjs`)** — Secret findings name the file and line; a failed VERIFY stage reports its command, exit code and output instead of a bare `❌ FAIL`; `queue` and `swarm` name each failed task and exit `1` instead of reporting success for a queue that dispatched nothing; remediation hints key on the failing phase rather than the ambiguous exit code.
- [x] **CLI Surface Consistency (`bin/agentctl.mjs`, `src/engine.mjs`, `src/task-optimizer.mjs`)** — `dispatch --dry-run` no longer prints the same banner as a real dispatch; `rollback --latest` is a declared flag; `dispatch --role` fails closed on an unresolvable role like `task create` always did; every prompt-taking command accepts positional, `--prompt` and `--prompt-file` alike.

### v0.41.0: Structural Flash-Router Governors, Schema Degradation & Multi-User Budget Attribution
- [x] **Deep Think Task Templates & Reasoning Sandwich (`src/web-templates.mjs`, `src/wizard-task.mjs`)** — Pre-calibrated 4-phase exploration budget templates (`deep-debug`, `deep-feature`, `deep-optimize`, `deep-harden`) enforcing silent discovery, deterministic reproduction oracles, positive perimeters, and mutation falsification.
- [x] **Structural Flash-Router & Anti-Truncation Governors (`src/router.mjs`, `src/provider.mjs`)** — Declarative Asset Override (non-executable formats bypass complex thresholds), Context Saturation Guard (forces Ultra on payloads >24 KB to prevent Flash truncation), Mechanical Intent Fast-Tracking (`chore:`, `docs:`, `ci:`), and V8 AST Syntax Verification (`createSyntaxVerifiedProvider`).
- [x] **Optimistic Schema Degradation & Adaptive Quota Adapter (`src/provider.mjs`)** — Auto-detects and sanitizes deprecated generative parameters (`temperature`, `thinking_budget` -> `thinking_level: "high"`) on HTTP 400 responses, with AIMD elastic backoff and Gemini 3.7 Flash support.
- [x] **Zero-Dependency Multi-User Budget Attribution (`src/budget.mjs`, `src/state.mjs`, `bin/agentctl.mjs`)** — Ambient developer identity resolution (`--author`, `GITHUB_ACTOR`, sanitized git email) with PII stripping, SHA-256 ledger binding, and `agentctl budget --by-user` quota dashboard.

### v0.40.0: Interactive Wizard Repair, a Scope Guard That Blocks, & Universal Defaults
- [x] **Interactive Wizard Option Merge** (`src/wizard-task.mjs`, `src/wizard-init.mjs`, `bin/agentctl.mjs`) — Both wizards spread `...options` last, and `parseArgs` puts every declared flag on that object with `undefined` for the ones not passed, so each spread overwrote the answer just typed. Interactive `agentctl task create` had been unusable since v0.29.0; `agentctl init` silently discarded the tier picked from the menu. Covered by `test/wizard-smoke.test.mjs` driving both real wizards over a fake TTY with the exact options object the CLI builds.
- [x] **CI Scope Guard Rebuilt on `checkScope()`** (`scripts/ci-scope-guard.mjs`, `.github/workflows/agent-scope-guard.yml`) — The inline-bash guard aborted under `bash -e` before evaluating a single pattern and reported green on every PR. Replaced with a Node implementation calling the same matcher as the local gate, reading the manifest from the PR's base SHA, failing closed on an unreadable manifest, and implementing the `allow-protected-paths` label documented in `AGENTS.md`.
- [x] **Three Fail-Opens Closed in `pr harvest --auto`** (`src/ops/pr-harvest.mjs`) — A PR with no status checks scored `passing: true` via empty-array `every()`; `diffLines` never reached `classifyRiskTier`, making the R2 threshold unreachable; and a missing file list graded `R0_COSMETIC` off the very evidence whose absence should have blocked the decision.
- [x] **Untrusted Review Comments Fenced** (`src/review-repair.mjs`) — `createReviewRepairTask` interpolated third-party `comment.body` into a dispatch prompt without calling the `sanitizeUntrustedData()` the kit already shipped.
- [x] **Universal Risk Model & Stack-Neutral Prompts** (`src/risk.mjs`, `.agent/prompts/`, `src/role-resolver.mjs`, `src/wizard-task.mjs`) — Builtin risk patterns no longer ship one installation's domain directories to every repository, and shipped role prompts no longer instruct Rails and Django projects to run `npm test`. Domain paths move to a `risk:` block that extends the builtins; prompts hydrate `{{VERIFY_TEST}}`-style tokens from the target repo's config.
- [x] **Evidence & Telemetry Retention** (`src/evidence.mjs`, `src/telemetry.mjs`) — `.agent/evidence/` and `.agent/state/` grew without bound in every installation. Newest 200 manifests, 14 days of telemetry; `ledger-*.jsonl` deliberately excluded as the budget record.
- [x] **Conservative Tier Fallback** (`src/config.mjs`) — `FALLBACK_TIER` moves from `ultra` to `free`. **Breaking:** add `tier: pro` or `tier: ultra` to `.agent/config.yml`.

### v0.39.0: Jules Session API, Automated PR Harvester & Pre-Flight Idempotency Gate
- [x] **Jules Provider Session API & Plan Approval** (`src/provider.mjs`, `bin/agentctl.mjs`) — Implemented native `getSession(sessionId)` and `approvePlan(sessionId)` on `createProvider("jules")` and `createFailoverProvider` with 404/503 exponential backoff retry. Added CLI commands `agentctl plan approve <id>` and `agentctl session get <id>`.
- [x] **Automated PR Harvester & Triage Engine** (`src/ops/pr-harvest.mjs`, `bin/agentctl.mjs`) — Added `agentctl pr harvest [--tier r0,r1] [--limit <n>] [--auto]` to discover open agent PRs, evaluate CI check rollups, map Risk Tiers (`R0_COSMETIC`, `R1_ROUTINE`), verify safety gate mutex locks (`checkSafetyGate`), and auto-squash merge green changes.
- [x] **Pre-Flight Idempotency & Premise Verification Gate** (`src/engine.mjs`, `bin/agentctl.mjs`) — Added `--check-premise` / `--idempotent` to `agentctl dispatch` / `create`. If a task's verification oracle or goal already passes on the base branch, dispatch is skipped with status `ALREADY_SATISFIED`, saving daily API budget.
- [x] **Automatic Swarm Conflict Serialization** (`src/dag-engine.mjs`) — `executeQueueDag` now inspects `targetFiles` / `referenced_paths`. When concurrent tasks target the same shared file, dependencies are automatically injected into the DAG to sequence them safely and prevent git merge conflicts.
- [x] **Audit-First Dead Code Template & Headless VM Invariants** (`src/web-templates.mjs`, `src/task-optimizer.mjs`) — Added template `agent-dead-code-audit` enforcing report generation (`.agent/reports/dead-code-audit.md`) before destructive file deletions, updated `agent-error-paths` with standalone schema validation testing invariants, and added `--headless` Playwright heuristics.

### v0.20.0 – v0.30.0: Core Safety, Polyglot Stack & TUI Engine
- [x] **Zero-Dependency Stdio MCP Server** (`src/mcp.mjs`, `bin/mcp-server.mjs`) — Standard MCP tool integration.
- [x] **L9 Kernel Hardening** (`src/state.mjs`, `src/journal.mjs`) — VFS directory mutex, PID recycling protection, atomic budget ledger.
- [x] **Universal Polyglot Stack Detector** (`src/stack-detector.mjs`) — 26+ ecosystems auto-detected (.NET, Rust, Go, Python, PHP, Java, JS/TS, Flutter, Solidity/Foundry/Hardhat).
- [x] **Scoped Monorepo Boundary Resolver** (`resolveWorkspaceBoundary`) — Isolated subshell test execution.
- [x] **Zero-Test Bootstrapping** (`agentctl bootstrap`) — Instant verification oracle synthesis (`php -l`, `compileall`, `dotnet build`).
- [x] **Statistical Flaky Test Quarantine** (`src/flaky-ledger.mjs`) — Wilson-score oscillation tracking (Exit Code 8).
- [x] **Task DAG Engine** (`src/dag-engine.mjs`) — Kahn's topological sort, interface SHA-256 fingerprinting, cycle detection.
- [x] **Fail-Closed Security Gatekeeper** (`src/security.mjs`, `src/prompt-guard.mjs`) — Nonced prompt fences, secret scanning, 75 KB diff governor.
- [x] **PR Review Auto-Remediation** (`src/review-repair.mjs`) — Ingests `CHANGES_REQUESTED` comments into OODA repair loops.
- [x] **Interactive TUI & Command Palette** (`src/ux/`, `src/ops/`) — Full-screen raw terminal engine, diagnostic check DAG (`agentctl doctor`), and queue/swarm managers.

### v0.31.0: Developer Onboarding & Prompt Intelligence
- [x] **Prompt Falsifiability & Scope Linter (`agentctl task optimize`)** — Heuristic analyzer scoring task prompts, fuzzy file path validation, and envelope synthesis.
- [x] **1-Click Atomic Git Checkpoint & Rollback (`agentctl rollback`)** — Epistemic pre-flight working tree snapshots and instant 1-command git tree rollback.
- [x] **Automated TDD Red-to-Green Harness (`agentctl test-gen`)** — 3-step test-driven development cycle asserting initial RED failure and locking tests in `scope.deny`.
- [x] **AST Blast-Radius Selective Testing** — Selective leaf test runner with global contract change protections.
- [x] **Verification Lifecycle Sandbox** — `verify.setup` / `verify.teardown` process-group isolation for migrations.
- [x] **IDE Native MCP Config Scaffolder (`agentctl mcp init`)** — 1-command config generation for Cursor, VS Code, and Claude Desktop.

### v0.32.0 – v0.32.4: Real-Time HITL, Web Templates & Memory Engine
- [x] **Human-in-the-Loop Escalation Bridge & Session Resumption (`agentctl escalate`, `agentctl resume`)** — Webhook dispatch and multi-turn warm session resumption via `POST /v1alpha/sessions/{id}:sendMessage`.
- [x] **SPORE Memory Engine & System Learnings (`agentctl hydrate`, `agentctl harvest`, `agentctl learning add`)** — Cross-session institutional learning ledger.
- [x] **Universal Edge-Runtime Import Guard** — Static AST security gate blocking Node.js built-ins in Edge contexts (Cloudflare Workers, Vercel Edge, Netlify).
- [x] **Web Development Task Templates (`agentctl task template`)** — Pre-calibrated envelopes for `web-cwv`, `web-wcag`, `web-seo`, `web-playwright`, and `web-flaky-heal`.
- [x] **Google Labs Exploration Budget Protocol & Critic Steering** — 3-phase discovery envelope injection and adversarial Critic Agent directives.
- [x] **Zero-Dependency Local Dashboard & Telemetry Visualizer (`agentctl dashboard`)** — Dark-mode HTML visualizer and REST telemetry APIs.

---

### v0.32.5: DAG Task Execution, Specialist Roles, Evidence Ledger & Cost Router
- [x] **DAG-Ordered Queue Execution** (`src/dag-engine.mjs`, `agentctl queue --dag`) — Kahn's-algorithm dependency resolution with cycle detection and per-task timeout, replacing strict FIFO queue order for tasks declared with `--depends-on`.
- [x] **Specialist Agent Roles** (`agentctl dispatch --role`, `agentctl task create --role`) — Binds a task to a pre-defined specialist prompt persona (`overseer`, `bolt`, `sentinel`, `janitor`) resolved from `.agent/prompts/`.
- [x] **Cryptographic Evidence Manifest** (`src/evidence.mjs`, `agentctl evidence generate|verify|show`) — SHA-256 manifest of changed files and test-file hashes with tamper detection; a foundational building block toward the v1.0.0 SOC2 audit exporter below.
- [x] **Tiered Verification Stages & Offline Execution Policy** (`src/config.mjs` `verify.stages`/`verify.policy`) — Optional lint/unit/fuzz/invariant/e2e stage pipeline and network-access policy (used to enforce `--offline` for Web3/Solidity stacks).
- [x] **Web3 / Solidity Stack Detection** (`src/stack-detector.mjs`) — Foundry (`forge test/build/fmt --offline`) and Hardhat auto-detection.

- [x] **Provider-Agnostic Cost Router** (`src/router.mjs`, `router:` block in `.agent/config.yml`, opt-in/disabled by default) — Zero-dependency heuristic classifier (`classifyTaskComplexity`) routing trivial tasks (typos, linter fixes, lockfile bumps, single-file changes) to a fast/cheap provider while reserving the primary provider for complex multi-file refactors — provider-agnostic and user-configurable, not tied to any single vendor. Safety-first: tasks touching `scope.deny` or sensitive paths (`auth/**`, `migrations/**`, secrets, `.github/**`), or using the `sentinel` role, always force-route to the primary provider regardless of score, and FAST-tier dispatch cascades to the primary provider on rate-limit/5xx via `createFailoverProvider`.
- [x] **Gemini CLI Fast-Tier Preset** (`src/provider.mjs` `gemini-flash`) — Headless Gemini CLI exec preset (`gemini-3.6-flash`, `--approval-mode=yolo`) usable as `router.fast`, or swapped for any other provider.
- [x] **`--tier fast|complex` Override** (`agentctl dispatch`, `agentctl task create`, MCP `dispatch_jules_task`) — Explicit routing override that bypasses the heuristic classifier.
- [x] **Provider URL Token Leakage Guard** (`src/provider.mjs`) — `createProvider()` rejects custom HTTP specs with `{token}` in `url`/`sendMessageUrl`; credentials are isolated to `headerData` so they cannot reach URL paths, query strings, or access logs.

### v0.32.6: Documentation Sync Gate, Adversarial Self-Audit & Cross-Platform Scope Hardening
- [x] **Documentation Sync Gate** (`scripts/doc-sync-check.mjs`, blocking step `1b` in `scripts/release.mjs`) — Implements the `doc-sync-sentinel` preset advertised in `src/wizard-init.mjs`. Blocks any release whose `package.json`, CLI version strings, README test counts, ROADMAP milestone markers or CHANGELOG entry have drifted apart.
- [x] **Adversarial Red-Team Suite** (`test/adversarial-claims.test.mjs`) — Additive, `src/`-read-only probes that attempt to falsify the safety guarantees in `README.md`. Confirmed gaps are recorded as `node:test` `todo` probes: visible in every run, non-blocking for CI.
- [x] **Agent Rule Budget Enforcement** — Wired the previously-unrun `scripts/rules-lint.mjs` into the doc-sync gate; `AGENTS.md` had silently exceeded its 10k character budget, where host truncation drops trailing directives without error.
- [x] **Canonical Command Harmonisation** (`AGENTS.md`, `JULES_RULES_TEMPLATE.md`) — Authoritative `agentctl` command reference that supersedes stale `scripts/*.mjs` paths held in agent memories; fixed the deleted `lock-manager.mjs` invocation still shipping to npm consumers.
- [x] **Cross-Platform Path Canonicalisation** (`canonicalizePath()` in `src/config.mjs`, `checkScope()`/`matchesGlob()` in `src/security.mjs`) — Deny and protect matching now runs against a lexically canonical path (`./` stripped, `..` resolved, separators normalised, duplicate slashes collapsed) and folds case. The same repository is checked out on macOS (APFS) and Windows (NTFS) where `.GitHub/` and `.github/` are the *same directory*, so a case-sensitive deny rule was bypassable on two of three target platforms. Allow matching stays case-sensitive so a case mismatch fails closed. Paths escaping the repository root are now rejected outright rather than pattern-matched.
- [x] **Secret Scanner Evasion Hardening** (`src/security.mjs`) — `scanDiff()` now matches against three variants of the added-line text: as-written, with invisible characters stripped (zero-width, soft hyphen, bidi controls), and with source-level string concatenation collapsed. The concatenation case is not purely adversarial — formatters wrap long string literals exactly that way, so a credential could evade the gate by accident.
- [x] **Router Windows-Path Parity** (`src/router.mjs`) — `collectReferencedPaths()` normalises separators before path extraction, so a sensitive path written `src\auth\session.mjs` by a Windows author still force-routes to the primary provider instead of the cheap tier.
- [x] **Base64-encoded credential detection** — deferred here pending measurement of the false-positive and performance cost; both were measured and the check shipped in v0.37.0 below.

### v0.33.0: Plan-Agnostic Budgeting, Limit Provenance & Guided First Use
- [x] **Limit Provenance** (`src/budget.mjs`, `resolveDailyLimit()`) — The kit records *where* a daily limit came from: stated by the operator (`limits.daily_tasks` / `JULES_DAILY_BUDGET`), demonstrated by the provider refusing work, or guessed from a tier preset. Only the first two may hard-block; a guess warns and lets the dispatch through, because refusing work the provider would have accepted is a worse failure than an over-count.
- [x] **Short-Lived Learned Ceiling** — A daily-quota refusal records "stop asking for now", not "this is your allowance". Deliberately not permanent: the local ledger cannot see sessions started from the Jules web UI or another machine, so the count at the moment of refusal is a lower bound on the real quota, and treating it as the quota would lock the operator below their own plan. *(Scoped to the calendar day when shipped; corrected to the rolling window in v0.34.0.)*
- [x] **Unified Tier Table** (`TIER_PRESETS` in `src/config.mjs`) — The wizard's separate table had drifted, scaffolding free-tier repos with double their real allowance. The wizard now projects the runtime table and generates its menu from it, so advertised and enforced numbers cannot disagree.
- [x] **Ledger Reconciliation** (`agentctl budget`, `agentctl budget reset`) — Corrects a local count the operator knows is wrong by *appending* `budget_released` entries. The hash-chained ledger is corrected forwards, never edited or truncated, so the audit trail survives the correction.
- [x] **CI-Enforced Egress Allowlist** (`test/egress-allowlist.test.mjs`) — Pins every host any shipped source may contact, requires webhook URLs to stay operator-supplied via environment, asserts zero runtime dependencies, and fails if a credential ever appears in a URL. In a kit that asks for an API key, this is what a reader can verify instead of a promise.
- [x] **Guided First Run** (`src/ops/next-step.mjs`, bare `agentctl`) — Walks git → init → key → queue → ready and names one command, rather than printing thirty. `agentctl doctor` now actually renders the diagnostic registry it has always contained, including a new critical finding for a git-tracked `.env`.
- [x] **Single-Source Version** (`src/version.mjs`) — Four modules hardcoded the kit version and had drifted three minor releases apart; all now read `package.json`.
- [x] **Monorepo Architecture & Cross-Package Import Guard** — `resolveWorkspaceBoundary` detects illegal cross-package imports and circular dependencies in TypeScript, Go, and Rust monorepos before running CI.

### v0.34.0: Rolling Quota Window & Real Plan Concurrency
- [x] **Rolling 24-Hour Quota Window** (`scanBudgetWindow()` in `src/state.mjs`) — Jules resets the daily allowance on a rolling window, not at midnight, and the kit was counting per calendar day. It was wrong in both directions: a batch dispatched at 23:00 stopped being counted at 00:01 while the provider still refused on it, and yesterday's last hours vanished from a count that should have included them. Counting now spans whatever ledger files the window touches and filters on entry timestamps; files stay day-scoped, because rotation is a storage concern and counting is not.
- [x] **Time-Boxed Learned Ceiling** — A provider refusal now ages out 24 hours after it happened rather than at midnight, matching the window the quota itself resets on, and reports when it expires. Pre-0.34 records carry only a day and keep the old comparison.
- [x] **Real Plan Concurrency** (`TIER_PRESETS` in `src/config.mjs`) — Defaults raised from 1/2/3 to 3/8/15 against published ceilings of 3/15/60; a Pro account had been running two workers where fifteen were available. The vendor ceiling is now recorded as `maxConcurrency`, separate from the kit's default, and `resolveConcurrency()` applies the same provenance rule the daily limit already used: an operator-stated figure is authoritative, a preset is a guess. An overrun is reported by `agentctl doctor`, never blocked — the provider enforces its own slot limit, and a pooled account legitimately exceeds any single plan's.

### v0.35.0: Swarm Autonomy, Silence Governor & Flaky Test Healing
- [x] **Type III Silence Governor & Interruption Budgeting** (`src/webhook.mjs`, `agentctl escalate`) — Configurable digest mode for escalation webhooks (`mode: immediate | digest | threshold | silent`), suppressing non-critical notifications to protect developer focus until context shifts or critical manual intervention thresholds (`R3_GATE_VIOLATION`, `SECRET_LEAK_DETECTED`, `CRITICAL_FAILURE` — narrowed in v0.35.2). Hourly interruption budget and secret redaction.
- [x] **Automated Flaky Test Healing Swarm** (`src/flaky-ledger.mjs`, `agentctl flaky heal`) — Background coordinator and CLI (`agentctl flaky heal`) that consumes Wilson-quarantined tests (Exit Code 8) and dispatches specialized anti-flakiness prompt templates and repeated verification oracles to repair timing and race conditions without test weakening.

### v0.35.1: Universal Web Internationalization (i18n) Template
- [x] **Universal `web-i18n` Task Envelope Template** (`src/web-templates.mjs`) — Standardized verification envelope for multi-language locale routing, bidirectional symmetric `<link rel="alternate" hreflang="...">` integrity (including self & `x-default`), dynamic `<html lang="...">` validation, and missing translation fallback resilience.

### v0.35.2: Silence Governor Correctness
- [x] **The governor engages on a default install** (`src/webhook.mjs`, `src/config.mjs`) — `AWAITING_USER_FEEDBACK` was both the fallback reason and a critical-bypass reason, so digest mode, silent mode and the interruption budget were unreachable without hand-written config. Critical is now limited to events where delay widens the damage.
- [x] **A preview has no side effects** (`src/webhook.mjs`) — `--dry-run` no longer spends the hourly interruption budget, and `--dry-run --flush` no longer discards the buffered digest it was asked to preview.
- [x] **A flush cannot lose incidents** (`src/webhook.mjs`) — batched at `DIGEST_BATCH_LIMIT` (10) to what Slack and Discord actually render, remainder left buffered, buffer emptied only on a delivery that succeeded.

### v0.36.0: Universal AI Crawler Policy & llms.txt Integrity Template
- [x] **Universal `web-ai-access` Task Envelope Template** (`src/web-templates.mjs`) — Cross-surface consistency for AI crawler directives (`robots.txt`, robots meta tags, `X-Robots-Tag`) and `llms.txt` integrity with locally-resolved links. Defaults to `preserve`: crawler posture is an operator policy decision, not a best practice, so the template enforces whatever the repository already states rather than opening it up. Scoped to verifiable file integrity — it claims no visibility or ranking effect, because none can be falsified.

### v0.37.0: Encoded-Secret Detection & Honest Budget Reconciliation
- [x] **The secret scanner decodes base64 before matching** (`src/security.mjs`) — every value in a Kubernetes `Secret` manifest is base64 by specification, so this was the encoding most likely to carry a live key past a line-oriented gate. Decoded bytes are matched against the structured patterns only, never the entropy heuristics, and the work is bounded at 64 candidates / 64 KB per scan. Zero false positives across all 263 commits in this repository.
- [x] **`redactSecrets()` removes the encoded form too** (`src/security.mjs`) — otherwise the gate blocked the dispatch and the escalation payload reporting the block leaked the value it blocked on.
- [x] **`budget reset` keeps reservations that reached the provider** (`src/budget.mjs`, `bin/agentctl.mjs`) — `budget_committed` was written and counted but never acted on. Releasing a committed reservation makes the local count understate real usage, which is the direction that gets the next dispatch refused. `--all` is now required for that.
- [x] **`budget reset` refuses unrecognised flags** (`bin/agentctl.mjs`) — a misremembered option silently dropped through to a full release.
- [x] **The adversarial red-team suite has no open gaps** (`test/adversarial-claims.test.mjs`) — the base64 `todo` was the last one; every documented safety claim is now backed by a passing probe.

### v0.38.2: Queue Runner Fidelity — Manifest Rejection & Honest Dry Runs
- [x] **The queue runner selects tasks by shape, not by extension** (`src/dag-engine.mjs`) — every `.json` in the queue directory was executed as a task, so a swarm manifest became a single task whose prompt was the whole file and blew the provider payload limit past ~50 KB. Reported from a live installation. The same check also stops the queue's own `README.md` from being dispatched.
- [x] **`--dry-run` leaves the queue exactly as it found it** (`src/dag-engine.mjs`, `src/engine.mjs`) — both runners moved task files into `completed/` and wrote a `task_completed` ledger entry while simulating, so a second preview of the same queue found nothing to preview. Two existing tests asserted the bug as expected behaviour.
- [x] **`run({ provider })` forwards to `dispatch`** (`src/engine.mjs`) — the non-DAG queue lifecycle had no way to be exercised without a live provider, which is why the dry-run bug was only ever covered by a test that depended on it.

### v0.38.1: Release Gate Enforcement & Interactive Wizard Smoke Test
- [x] **The documentation sync gate runs in CI** (`.github/workflows/jules-audit.yml`) — the gate `release.mjs` blocks on at step 1b was only ever run by hand, which is how a stale README test count and an unchecked shipped-milestone item both reached `main`. Its own job, not a tenth copy in the nine-way matrix, because it measures test counts by running the suite.
- [x] **Releases block on a green CI matrix** (`scripts/release.mjs`, step 1c) — step 1 only proves the suite passes on the releasing machine, and every cross-platform break shipped here was green on Linux and red on Windows. Treats a still-running matrix as a failure, since releasing on a pending run is precisely how a red Windows job gets published. `--skip-ci-check` remains for when `gh` is unavailable.
- [x] **A hung test fails instead of stalling** (`scripts/run-tests.mjs`) — the stdin regression failed by hanging, which without a per-test deadline burns a CI job to GitHub's six-hour default. Version-guarded: `--test-timeout` landed in Node 20.6 while `engines` allows `>=20.0.0`, and an unrecognised flag makes Node abort before running anything.
- [x] **The real `init` wizard is exercised end to end** (`test/wizard-smoke.test.mjs`) — the TUI unit tests all passed while `agentctl init` was unusable, because nothing drove the wizard itself. Verified against the pre-fix tree, where it stalls after prompt 1 of 5 — exactly what the first external user reported.

### v0.38.0: Multi-OS CI Matrix (Linux, macOS, Windows) & Interactive TUI Hardening
- [x] **Multi-OS CI Matrix across Node 20, 22, and 24** (`.github/workflows/jules-audit.yml`) — Automated CI matrix executing all 555 tests across 81 suites on Ubuntu Linux, macOS (Darwin), and Windows (PowerShell/CMD).
- [x] **Deterministic Cross-Platform Test Runner** (`scripts/run-tests.mjs`) — Zero-dependency file discovery via `node:fs` running `node --test` across all platforms and shell environments.
- [x] **macOS Darwin Process Inspection** (`src/state.mjs`) — Added BSD/Darwin `ps -p <pid> -o lstart=` support in `getProcessStartTime` for reliable PID recycling protection on macOS.
- [x] **Windows Command Quoting & Path Normalization** (`src/git.mjs`, `test/`) — Native `child_process.execSync` for shell execution and cross-platform backslash normalization in test harnesses.
- [x] **TUI Raw Mode & Interactive Wizard Cancellation** (`src/ux/terminal-session.mjs`, `src/tui.mjs`, `src/wizard-init.mjs`) — SS3 arrow navigation, `WizardCancelledError` (exit code 130) on Ctrl+C, and non-destructive re-init defaults preservation.

---

## 🎯 Intermediate Target Milestones (v0.42.0 – v0.60.0)

### v0.42.0: Subshell Process Containment & Trojan Fencing
- [ ] **POSIX/Win32 Process Group Guillotine (`src/engine.mjs`, `src/process.mjs`)** — Spawns subshell executions with `{ detached: true }` / new process group; implements reliable tree teardown via `process.kill(-pid, 'SIGKILL')` on POSIX and `taskkill /T /F /PID` on Windows to eliminate orphaned dev-servers, Jest/Vite watchers, and subshell zombies (preventing `EADDRINUSE` port exhaustion).
- [ ] **Native Stdio/Stderr Sliding-Window Governor (`src/prompt-guard.mjs`, `src/ux/log-viewer.mjs`)** — Enforces bounded circular buffer limits for `stdout`/`stderr` before injecting traces into prompt envelopes, preventing V8 string length exhaustion and LLM context window overflows during verbose build/test runs.
- [ ] **Graceful Rollback & Dirty Working Tree Hook (`src/ops/transaction.mjs`)** — Automated `git restore` and clean-up safety trap in transaction lifecycles, ensuring aborted or crashing agent runs leave zero syntax trash or fractured uncommitted states.
- [ ] **OODA Thrash Cycle Breaker (`src/dag-engine.mjs`, `src/review-repair.mjs`)** — Rolling SHA-256 state tracking over proposed diff hunks per file during automated repair loops; immediately trips circuit breaker (Exit Code 4) upon detecting semantic ping-pong ($A \to B \to A$) to halt token drain.
- [ ] **Unicode Trojan Source & Homoglyph Fencing (`src/security.mjs`)** — Deterministic $O(n)$ token scanner using V8 Unicode Property Escapes (`\p{Script=...}`) and NFKC normalization to block invisible Bidi overrides (CVE-2021-42574), zero-width smugglings, and mixed-script homoglyphs in agent diffs.

### v0.45.0: In-Memory Git Plumbing & Ephemeral Merges
- [ ] **In-Memory 3-Way Merge Virtualizer (`src/git.mjs`, `src/dag-engine.mjs`)** — Leverages `git merge-tree --write-tree` to compute three-way merges in-memory within the Git object database without touching disk worktrees or risking `.git/index.lock` collisions across concurrent swarm workers.
- [ ] **Ephemeral Workspace Shadow Sandboxing (`src/git.mjs`)** — Provisions isolated ephemeral Git indexes via `GIT_INDEX_FILE` for non-destructive dry-run patch verification and stage validation before touching the working branch.

### v0.50.0: Test Oracle Anti-Tampering & Diff Mutation Testing
- [ ] **Test-Assertion Tampering & Weakening Detection (`src/security.mjs`, `src/test-oracle.mjs`)** — Static diff analysis gate detecting deceptive agent passes: flags downgrades in assertion strictness (`===` to `==`, `.toStrictEqual` to `.toBeTruthy`), deleted or commented assertions, and injection of test-skip directives (`.skip`, `t.Skip()`, `@pytest.mark.skip`).
- [ ] **Diff-Hunk Mutation Testing Harness (`src/mutation.mjs`)** — Zero-dependency localized AST/operator inverter on agent-added lines (`+` hunks) to execute affected test suites and mathematically verify that test assertions fail (kill the mutant) when agent logic is inverted.

### v0.60.0: Distributed File Leases & Preemptive DAG Scheduling
- [ ] **Atomic Filesystem Lease & Heartbeat Protocol (`src/engine.mjs`, `src/flaky-ledger.mjs`)** — Directory-mutex file leasing with heartbeat timestamps, stale-lock detection via PID liveness inspection, and tombstone rotation without third-party daemons or Redis.
- [ ] **Preemptive Task Cancellation & Interface Fingerprints (`src/dag-engine.mjs`)** — Automatically aborts and yields downstream swarm tasks when upstream exported symbol interfaces diverge from their cryptographic SHA-256 fingerprints.

---

## 🏁 Target Milestone v1.0.0: The Production-Grade Autonomous Engineering Kernel
*Focus: Long-term API stability, cryptographic compliance, and enterprise deployment guarantees.*

- [ ] **Cryptographic Compliance & SOC2 Audit Exporter (`agentctl audit export`)**:
  - Export tamper-evident, signed JSON-LD / SPDX receipts of all agent activities linked to the SHA-256 telemetry ledger.
  - *Foundation shipped:* `agentctl evidence generate|verify|show` (`src/evidence.mjs`) already produces SHA-256 evidence manifests with test-tamper locking — this item extends it to signed JSON-LD/SPDX export.
- [ ] **Zero-Dependency Core Freezing & Stability Guarantee**:
  - 100% API stability for `index.mjs` SDK exports, CLI exit codes (0–8), and configuration schema (`.agent/config.yml`).
- [ ] **High-Concurrency Swarm Benchmarking (500+ Daily Sessions)**:
  - Stress testing with 50+ concurrent worker slots across 100k+ file repositories with zero lock contention or memory leaks.
- [ ] **Comprehensive Multi-Language Enterprise Test Matrix**:
  - Automated CI test fixtures for polyglot environments (Node, Python, Go, Rust, .NET, PHP, Java, Flutter).
- [ ] **OODA Attempt Diff Retention & Inspection (`.agent/state/ooda/*.patch`, `agentctl patch --attempt <n>`)**:
  - Retains intermediate working tree diffs and failure traces across OODA repair turns so developers can inspect failed hypotheses when an agent exhausts its retry budget.

---

## 🔮 Post-1.0 Long-Term Horizon (v1.x+)

- **Proactive Telemetry Ingestion (Type III Situational Awareness)**: Ingest dev-server crash logs, APM traces, and Playwright test artifacts into auto-synthesized task envelopes for background diagnosis.
- **Cross-Repository Swarm Orchestration**: Orchestrate breaking API contract changes across multiple distinct git repositories with atomic synchronization.
- **Multimodal Visual Verification Loop**: Direct integration with headless browser video/screenshot streams for autonomous visual regression repairs.
- **Wasm-Powered Structural AST Invariant Engine**: In-memory WebAssembly tree-sitter bindings (zero npm dependencies) for deep multi-language semantic AST verification.
