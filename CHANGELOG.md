# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.53.0] - 2026-09-03
### Added
- **Provider Readiness Probe (`src/provider-readiness.mjs`, `agentctl providers`, `index.mjs`)**: Introduced per-provider capability descriptors so readiness is evaluated against the *selected* provider — a credential for the hosted `jules` adapter, a `PATH` binary for the `claude-code`, `codex` and `gemini-flash` exec adapters — plus `whichBinary()` (cross-platform, PATHEXT-aware, no subprocess), `probeProvider()`, `detectAvailableProviders()` and `suggestProvider()`.
- **Vendor-Neutral Environment Spellings (`src/env-aliases.mjs`, `bin/agentctl.mjs`, `.env.example`)**: Every `JULES_*` variable now also answers to an `AGENT_*` alias (`AGENT_API_KEY`, `AGENT_REPO`, `AGENT_SWARM_CONCURRENCY`, …), normalised once at CLI entry. An existing `JULES_*` value always wins, so an alias can never alter a working setup.
- **Verification Profiles (`src/profiles.mjs`, `src/profiles-io.mjs`, `src/config.mjs`, `agentctl profile`)**: `verify.profile: minimal | standard | max` expands at load time into a stack-aware stage pipeline — `max` adds mutation scoring, a 3-pass stability probe and, only on V8-coverage-capable runtimes, diff coverage. Unsupported gates are skipped with a stated reason instead of failing the diff. `agentctl profile --set` rewrites the key in place without disturbing comments.
- **Generated Stack-Aware CI (`src/ci-templates.mjs`, `agentctl ci init`)**: Emits a GitHub Actions or GitLab job carrying the detected stack's toolchain (`setup-python`, `setup-go`, `setup-java`, `setup-dotnet`, Bun/Deno) alongside Node for the CLI, targeting the repository's own base branch. Refuses to overwrite an existing workflow without `--force`.
- **`agentctl init --provider / --profile`**: Both selectable at onboarding; the wizard detects a provider the machine can actually reach when none is given.
### Fixed
- **Consumer Repository Pollution (`bin/init.js`)**: `init` no longer copies the kit's own twenty orchestration scripts into the target repository's `scripts/` directory, nor its nine-way Node CI matrix (`jules-audit.yml`) into repositories of any other stack. Both are replaced by the `agentctl` CLI and a generated workflow.
- **Divergent Init Entry Points (`bin/init.js`, `src/wizard-init.mjs`)**: `jules-init` wrote a thinner `.agent/jules.yml` while `agentctl init` wrote the `.agent/config.yml` the runtime reads, so which scaffolder was run decided whether a repository had a provider, tier or profile at all. Both now go through `planInit`.
- **Kit-Private Paths In Scaffolded Deny Lists (`src/wizard-init.mjs`)**: The scaffolded `forbidden_paths` named `**/lock-manager/**` and `scripts/jules-self-audit.mjs` — paths that exist only in this repository — and omitted `**/.env*` and `**/*.key`.
- **Committed Environment Templates Denied (`src/security.mjs`)**: The builtin `**/.env` and `**/.env.*` deny rules blocked `.env.example`, `.env.sample`, `.env.template`, `.env.dist` and their `.env.<env>.<suffix>` forms — the file nearly every repository commits to document its variables — so no agent in any project could be asked to document a new one. Exempted narrowly: only when a builtin pattern matched, never for a repository's own broader dot-env rule, and the diff secret scanner still fails a real credential pasted into a template on exit 6.
- **Provider-Blind Guidance (`src/ops/next-step.mjs`, `src/ops/doctor-registry.mjs`)**: The next-step advisor and `doctor` demanded `JULES_API_KEY` regardless of the configured provider, permanently reporting a correctly configured `claude-code` or `codex` repository as misconfigured. Both now probe the selected provider, and `doctor` additionally reports which other providers are ready on the machine.
### Changed
- **Default Pipeline Deduplicated (`src/engine.mjs`, `src/profiles.mjs`)**: `gate()`'s built-in stage sequence moved to `buildDefaultStages()` so `agentctl profile` describes exactly what the gate runs rather than a second implementation of it.
- **Vendor-Neutral npm Scripts (`bin/init.js`)**: Injected helpers are now `agent:gate`, `agent:dispatch`, `agent:queue`, `agent:create`, `agent:status`, `agent:doctor`, `agent:swarm`, `agent:clean`. Pre-existing `jules:*` entries are left untouched.

## [0.52.8] - 2026-09-03
### Fixed
- **Binary Asset Classification Guard (`src/security.mjs`, `test/hardening-vulnerabilities.test.mjs`)**: Bound the binary asset skipping condition (`printableRatio < 0.9`) strictly to payloads with `token.length >= 256`.

## [0.52.7] - 2026-09-03
### Added
- **Linux eBPF Runtime Security & Network Auditing (`.github/workflows/*.yml`)**: Integrated `step-security/harden-runner@e14015d583714f6e62063499dc959a02595150a1` (# v2.21.1) across all GitHub Action…

## [0.52.6] - 2026-09-03
### Fixed
- **Composite Action Template Injection (`.github/actions/setup-jules/action.yml`)**: Bound action inputs (`action`, `title`, `prompt`, `base_branch`) strictly to environment variables (`$INPUT_ACTION`, `$INPUT_TITLE`, `$INPUT_PROMPT`, `$BASE_BRANCH`) before shell invocation, eliminati…
- **Windows `cmd.exe` Redirection Operator Conflict (`test/server-probe.test.mjs`)**: Replaced arrow function `()=>{}` with `function(){}` in timeout fixture commands to prevent `cmd.exe` from misinterpreting `>` as a stream redirection operator.
### Security
- **Least-Privilege GitHub Actions Permissions (`.github/workflows/*.yml`)**: Declared explicit top-level and job-level `permissions: contents: read` across all workflow definitions (`agent-scope-guar…
- **Credential Leak Prevention via Git Persistence (`.github/workflows/*.yml`)**: Configured `persist-credentials: false` across all `actions/checkout` steps to prevent `GITHUB_TOKEN` from lingering in `.git/config`.
- **Action Pinning & Supply Chain Hardening (`.github/`)**: Pinned all workflow actions (`checkout`, `setup-node`, `cache`, `zizmor-action`) to immutable full commit SHAs.

## [0.52.5] - 2026-09-02
### Fixed
- **Test Deletion Bypass Tamper Guard (`src/security.mjs`, `test/test-tampering.test.mjs`, `test/hardening-vulnerabilities.test.mjs`)**: Tracked pre-image (`oldLineNo`) and post-image (`newLineNo`) line numbers from unified diff hunk headers in `checkTestTampering`.
- **Diff Payload Governor Base-Commit Binding (`src/engine.mjs`, `test/hardening-vulnerabilities.test.mjs`)**: Bound `limitBytes` in `gate()` strictly to `trustedConfigRaw.limits` from the base commit, preventing uncommitted disk config from inflating the diff ceiling in `--mode committed`.
- **Onboarding PR Scope Catch-22 Resolution (`src/config.mjs`, `test/hardening-vulnerabilities.test.mjs`)**: Moved `.agent/config.yml` and `.agent/jules.yml` from `BUILTIN_DENY` to `BUILTIN_PROTECT`, allowing `--allow-protected` and `allow-protected-paths` to land configs while keeping agents gated out.
### Added
- **Shannon Entropy Diff Scanner (`src/security.mjs`, `index.mjs`, `test/api-surface.test.mjs`, `test/hardening-vulnerabilities.test.mjs`)**: Implemented and exported `hasHighEntropyToken()` to detect unstructured tokens ($\ge 24$ chars, Shannon entropy $> 4.5$) on added diff lines as `HIGH_ENTROPY_TOKEN`.

## [0.52.4] - 2026-09-02
### Fixed
- **Base64 Line-Wrapped Secret Smuggling (`src/security.mjs`, `test/arena-audit-remediation.test.mjs`)**: In `secretScanVariants`, `hasEncodedSecret`, and `classifyAddedLines`, collapsed whitespace and newlines between adjacent base64 characters (RFC 4648 line-wrapped PEM certificates/keys, template liter…
- **Assertion Weakening & Vacuous Test Tampering (`src/security.mjs`, `test/arena-audit-remediation.test.mjs`)**: Added `VACUOUS_ASSERTIONS` detection to `checkTestTampering` to identify vacuous truth and identity assertions (`assert.ok(true)`, `expect(true).toBe(true)`, `assert.equal(1, 1)`, etc.) as critical te…
- **Offline Network Guard Exit Code 188 Classification (`src/engine.mjs`, `bin/agentctl.mjs`, `AGENTS.md`)**: Differentiated preload network guard egress kills (Exit 188) from ordinary test regressions (Exit 4); suppressed OODA repair loop on Exit 188 and provided remediation hints advising `npm install` and network mocking.
- **Git `--base HEAD` Local Reference Resolution (`src/git.mjs`, `test/arena-audit-remediation.test.mjs`)**: Excluded `HEAD` and relative commit references (`HEAD~*`, `HEAD^*`, `HEAD@*`) from `origin/` remote candidate prefixing in `resolveBase()`, ensuring local commit pointers are accurately resolved witho…

## [0.52.3] - 2026-09-02
### Fixed
- **Jules API Activity Patch Ingestion (`src/session-ops.mjs`, `src/provider.mjs`, `test/session-ops.test.mjs`, `test/provider-hardening.test.mjs`)**: Fixed `listActivities` in `provider.mjs` which called `getSession("", ...)` with empty string causing a `TypeError`.
- **Dynamic `execSync` Subprocess Hardening (`src/coverage.mjs`, `src/mutation.mjs`, `src/perf.mjs`)**: Replaced raw `execSync` with safety-hardened `runCmd` with `{ ignoreError: true }`, ensuring cross-platform `.cmd` shim resolution, execution timeouts, maxBuffer guards, and graceful handling of inten…
### Added
- **Edge Runtime Webhook Support (`src/webhook.mjs`, `test/webhook.test.mjs`)**: Refactored `verifySignature` and `parseWebhookPayload` to use `Uint8Array`, `TextEncoder`, and `TextDecoder`, preventing runtime crashes on Vercel Edge and Cloudflare Workers.
- **Whack-a-Mole Prompt Injection Defense (`src/remediation.mjs`, `test/whack-a-mole.test.mjs`)**: Enclosed oscillating test names inside `<UNTRUSTED>` fencing tags in the synthesized prompt directive.

## [0.52.2] - 2026-09-02
### Fixed
- **Zero-Test Oracle Bootstrapping on Empty Verify Command (`src/stack-detector.mjs`, `test/stack-detector.test.mjs`)**: `bootstrapZeroTestRepo` now inspects existing `verify.test` and only treats it as an established oracle if it is a non-empty command.
- **Git Remote Origin Repository Resolution for Dispatch (`src/git.mjs`, `src/provider.mjs`, `test/git.test.mjs`, `test/provider-hardening.test.mjs`)**: Implemented and exported `parseGitHubRepo(url)` to parse `owner/repo` across SSH (`git@github.com:owner/repo.git`, `ssh://...`), HTTPS, git-protocol, and authenticated URLs.

## [0.52.1] - 2026-09-02
### Fixed
- **Queue Task Ghost False Positive (`src/ops/next-step.mjs`, `test/next-step.test.mjs`)**: Filtered queue directory files using `isTaskFile(f, queueDir)` instead of blind extension matching, preventing `.agent/jules-queue/README.md` from being reported as a pending queued task immediately a…
- **Contract Files Post-Init Commit Hint (`bin/agentctl.mjs`, `README.md`)**: Dynamically constructed the post-init `git add` recommendation to include `SPEC.md`, `CONSTRAINTS.md`, and UI contracts alongside `.agent`, `AGENTS.md`, and `.gitignore` to avoid immediate doctor warnings.
- **Subcommand `--help` Interception (`bin/agentctl.mjs`, `src/ops/command-registry.mjs`)**: Delegated subcommand help flags (`agentctl <subcommand> --help`) to `formatCommandHelp` using registry descriptors rather than dumping global top-level help.
- **Non-Interactive Initialization Support (`bin/agentctl.mjs`, `src/wizard-task.mjs`)**: Added `--non-interactive`, `--no-interactive`, and `-y`/`--yes` CLI flags to `init` and `task create` for CI/scripted onboarding.
### Added
- **Roadmap v1.0.0 OODA Attempt Diff Retention (`ROADMAP_V1.md`)**: Registered target milestone for persisting intermediate working tree failure patches under `.agent/state/ooda/*.patch` for developer inspection via `agentctl patch --attempt <n>`.

## [0.52.0] - 2026-09-02
### Added
- **Power-User Session Operations Engine (`src/session-ops.mjs`, `agentctl patch`, `agentctl retry`, `agentctl prune`)**: `extractSessionPatch(sessionId, opts)`: Extracts raw git diff patch, pull request metadata, and affected file lists from completed Jules session outputs and activity artifacts.
- **Provider Remote Lifecycle Endpoints (`src/provider.mjs`)**: Implemented `listSessions()`, `listActivities()`, `archiveSession()`, `deleteSession()`, and `listSources()` across `createProvider`, `createFailoverProvider`, and `createSyntaxVerifiedProvider`.
- **Full Model Context Protocol (MCP) Server Tools Suite (`src/mcp.mjs`, 17 tools total)**: Added MCP tools: `jules_list_sessions`, `jules_list_activities`, `jules_get_session_output`, `jules_archive_session`, `jules_delete_session`, `jules_retry_session`, `jules_apply_patch`, `jules_list_so…
- **API Surface Extension (`index.mjs`, `test/api-surface.test.mjs`)**: Exported `extractSessionPatch`, `applySessionPatch`, `retrySession`, `pruneSessions`, and `parseAgeDuration` with locked SDK snapshot at 236 symbols.

## [0.51.0] - 2026-09-02
### Added
- **Diff-Hunk Mutation Testing Engine (`src/mutation.mjs`, `agentctl mutate`, `assert:mutation`)**: Evaluates agent-authored code against transactional operator inversion (`===`/`!==`, `>=`/$<$, `&&`/`||`, `true`/`false`, `+`/`-`) with multiline string/template/comment shielding (`getFileStringLiter…
- **Native Zero-Dep V8 Diff Coverage Enforcer (`src/coverage.mjs`, `agentctl coverage`, `assert:diff-coverage`)**: Harnesses `NODE_V8_COVERAGE` to map raw block hit counts to added `+` git diff hunks with zero external coverage tooling.
- **Whack-a-Mole Test-Oscillation Cycle Detector (`src/remediation.mjs`, `src/engine.mjs`)**: Tracks test failure bitvectors and rolling SHA-256 state tuples in OODA loops to halt infinite oscillation ($Test_A \to Test_B \to Test_A$) and inject architectural anti-local-maximum guidance.
- **Flakiness Stability Prober (`src/stability.mjs`, `agentctl probe`, `assert:test-stability`)**: Executes target suites across $N$ isolated passes to reject intermittent timing races and non-deterministic flakiness before merge.

## [0.43.0] - 2026-08-24
### Added
- **Four specialist role prompts ship in `.agent/prompts/`**: `A11y.md` (WCAG 2.2, keyboard/focus, measured contrast), `Scribe.md` (metadata, JSON-LD, canonical/OpenGraph parity, honest claims), `Spectator.md` (headless E2E, deterministic assertions, no `waitFor…
- **Four universal, stack-agnostic task envelopes (`src/web-templates.mjs`)**: `agent-dep-audit` (pinned/checksummed dependency resolution, stale-lockfile gate, install-script scrutiny, offline — no advisory API calls), `agent-doc-drift` (documented CLI flags, env vars and SDK e…
- **Test that every documented specialist role ships a prompt file** (`test/role-prompts.test.mjs`), and **tests for the four universal templates including a stack-neutrality assertion that pins no np…
### Changed
- **`scaffoldRepoAssets()` now lists all eight roles** in its created-files summary instead of only the original four (`src/scaffold.mjs`).
- **`AGENTS.md`, `JULES_RULES_TEMPLATE.md`, `README.md` and `EXAMPLES.md`** document the eight personas (with `--role` invocation) and the universal envelopes.

## [0.42.0] - 2026-08-24
### Added
- **First-Class Rules CLI Subcommands (`agentctl rules`, `bin/agentctl.mjs`)**: Added `agentctl rules check` to audit instruction files (`AGENTS.md`, `.agent/rules/*.md`, etc.) against token and line budgets (<10,000 chars, <250 lines) to prevent silent LLM context truncation.
- **All-In-One CI Verification Gate (`agentctl check`, `bin/agentctl.mjs`)**: Added `check` as a unified entrypoint for CI pipelines, running secret scanning, scope guard, diff payload budget (<75 KB), rules budget, and stack-detected test/build commands in one shot.
- **Stack-Tailored Contract Template Scaffolding (`src/scaffold.mjs`)**: Added `scaffoldContracts()` integrated into `agentctl init` / `scaffoldRepoAssets`.
- **Rules CLI Test Suite (`test/rules-cli.test.mjs`)**: Added 11 unit and integration tests verifying rules audit, compilation sentinels, and multi-stack contract generation.

## [0.41.1] - 2026-08-23
### Fixed
- **A lockfile bump failed closed as a CRITICAL secret leak (`src/security.mjs`)**: `decodeBase64Blobs` counted every token matching the base64 alphabet against a 64-payload cap and failed closed on overflow.
- **`agentctl init` left the kit's own bookkeeping in the working tree (`src/scaffold.mjs`, `bin/agentctl.mjs`, `bin/init.js`)**: the gate audits that tree, so every ledger, evidence manifest and telemetry line the kit wrote came back as a diff the agent was accused of making — first as a scope violation, then, once enough evide…
- **The two init paths scaffolded different repositories (`src/scaffold.mjs`)**: `jules-init` wrote `AGENTS.md`, the role prompts and the guardrails; `agentctl init` — the one the README's quickstart points at — wrote neither.
- **`agentctl queue` reported success for a queue that dispatched nothing (`bin/agentctl.mjs`)**: a run where every task was rejected — no API key is the common one — still printed `Processed 3 task(s).` and exited `0`.
### Changed
- **Every command that takes a prompt now takes it the same three ways (`bin/agentctl.mjs`)**: `dispatch` accepted a flag, a file or a positional; `task create` accepted only `--prompt`; `task optimize` accepted only a positional.

## [0.41.0] - 2026-08-22
### Added
- **Structural Flash-Router Governors (`src/router.mjs`)**: `classifyTaskComplexity()` gained three deterministic overrides ahead of the keyword scorer — a Declarative Asset Override (100% non-executable file extensions bypass the sensitive-path penalty), a Co…
- **`node --check` Syntax-Verification Escalation Gate (`createSyntaxVerifiedProvider`, `src/provider.mjs`)**: the FAST tier's cascade (`resolveRoutedProvider()`) now wraps the fast provider so that, after it dispatches, any `.js`/`.mjs`/`.cjs` file changed in the local working tree is parsed with `node --chec…
- **Optimistic Schema Degradation (`src/provider.mjs`)**: an HTTP 400 response mentioning deprecated fields (`temperature`, `top_p`, `thinking_budget`) is retried once with those fields stripped (`thinking_budget` mapped to `thinking_level: "high"`), and the…
- **Zero-Dependency Multi-User Budget Attribution (`src/budget.mjs`, `src/state.mjs`, `bin/agentctl.mjs`)**: `resolveAmbientIdentity()` resolves a developer identity (`--author` flag → `GITHUB_ACTOR` → sanitized `git config user.email` → OS username → `anonymous-local`), and `agentctl budget --by-user` repor…
### Fixed
- **`--author` never reached the real budget reservation (`src/engine.mjs`)**: `dispatch()`'s live path calls `withBudget(runDispatch, root, budget.limit, { enforce: budget.certain })` — no `author` was ever included, so `resolveAmbientIdentity()` was exercised only by unit test…

## [0.40.0] - 2026-08-22
### Changed
- **`FALLBACK_TIER` is now `free`, was `ultra` (`src/config.mjs`)**: a repository with no `tier:` — every repository until someone sets one — was granted a 300-task allowance and 60 concurrent workers.
- **The risk model no longer ships one project's directory names to everyone (`src/risk.mjs`, `.agent/config.yml`)**: the builtins contained `**/vat/**`, `**/pricing/**`, `**/contracts/**`, `wrangler.jsonc`, `packages/db/**`, and this kit's own `src/engine.mjs` and `src/security.mjs` — a domain model for one installa…
- **Shipped role prompts are stack-neutral (`.agent/prompts/`, `src/role-resolver.mjs`)**: `.agent/prompts/` ships inside the npm package, so every `agentctl init` in any language got this kit's own contribution rules — run `npm test`, run `npm run lint`, and "you are STRICTLY FORBIDDEN fro…
### Fixed
- **Interactive `agentctl task create` discarded every answer (`src/wizard-task.mjs`, `src/wizard-init.mjs`)**: both wizards spread `...options` **last** when handing off to their planning function.
- **`agentctl init` ignored the tier picked from the menu (`bin/agentctl.mjs`, `src/wizard-init.mjs`)**: the same defect, with a hardcoded `values.tier || "pro"` on top of it.

## [0.39.0] - 2026-08-22
### Added
- **Jules Provider Session API & Plan Approval (`src/provider.mjs`, `bin/agentctl.mjs`)**: Implemented first-class `getSession(sessionId)` and `approvePlan(sessionId)` on `createProvider("jules")` and `createFailoverProvider`.
- **Automated PR Harvester & Triage Engine (`src/ops/pr-harvest.mjs`, `bin/agentctl.mjs`)**: Added `agentctl pr harvest [--tier r0,r1] [--limit <n>] [--auto]` to discover open agent PRs, evaluate CI check rollups, map Risk Tiers (`R0_COSMETIC`, `R1_ROUTINE`), verify safety gate mutex locks (`…
- **Pre-Flight Idempotency & Premise Verification Gate (`src/engine.mjs`, `bin/agentctl.mjs`)**: Added `--check-premise` / `--idempotent` to `agentctl dispatch` / `create`.
- **Automatic Swarm Conflict Serialization (`src/dag-engine.mjs`)**: `executeQueueDag` now inspects `targetFiles` / `referenced_paths`.

## [0.38.2] - 2026-08-21
### Fixed
- **Manifests No Longer Dispatched as Tasks (`src/dag-engine.mjs`)**: `executeQueueDag` accepted every `.json` file in the queue directory as a task.
- **`--dry-run` No Longer Drains the Queue (`src/dag-engine.mjs`, `src/engine.mjs`)**: Both queue runners moved task files into `completed/` on a dry run, created `completed/` if it did not exist, and wrote a `task_completed` ledger entry — so the second preview of the same queue found …
### Added
- **Provider Injection in `run()` (`src/engine.mjs`)**: `run({ provider })` forwards to `dispatch`, mirroring the injection point `dispatch` and `gate` already expose.

## [0.38.1] - 2026-08-21
### Added
- **Documentation Sync Gate in CI (`.github/workflows/jules-audit.yml`)**: The gate `release.mjs` blocks on at step 1b now runs on every push and pull request as its own job.
- **CI Verification Gate in the Release Pipeline (`scripts/release.mjs`, step 1c)**: A release now refuses to proceed unless every CI run for `HEAD` has completed successfully.
- **Interactive Wizard Smoke Test (`test/wizard-smoke.test.mjs`)**: Drives the real `runInitWizard` — the function the CLI calls — over a fake TTY, reacting to what the wizard prints rather than to fixed delays.
### Fixed
- **Hung Tests Now Fail Instead of Stalling (`scripts/run-tests.mjs`, `.github/workflows/jules-audit.yml`)**: The `readKeypresses()` stdin regression failed by hanging rather than throwing.
- **Windows Path Assertion in the Handover Suite (`test/handover.test.mjs`)**: `createHandover` returns a native path, which the test matched against a forward-slash regex — red on `windows-latest` only, green on both other platforms.

## [0.38.0] - 2026-08-20
### Added
- **Multi-OS CI Matrix across Node 20, 22, and 24 (`.github/workflows/jules-audit.yml`)**: Fully automated test matrix executing 559 tests across 81 suites on Ubuntu Linux, macOS (Darwin), and Windows (PowerShell/CMD).
- **Deterministic Cross-Platform Test Runner (`scripts/run-tests.mjs`)**: Native zero-dependency runner that resolves all `test/*.test.mjs` test suites via `node:fs` and executes them via `node --test`, eliminating shell-globbing divergences across Windows CMD/PowerShell, m…
- **Darwin / macOS PID Inspection (`src/state.mjs`)**: Added BSD/Darwin `ps -p <pid> -o lstart=` support in `getProcessStartTime` so PID recycling checks and mutex stale-lock reapers work reliably on macOS where `/proc` is absent.
### Fixed
- **Windows Command Quoting & Shell Execution (`src/git.mjs`)**: Replaced custom arguments parsing with native `child_process.execSync` for shell-mode command execution, ensuring Windows `cmd.exe` properly preserves quoted string arguments without pathspec syntax corruption.
- **Windows Path Backslash Normalization in Test Harnesses (`test/tiered-verification.test.mjs`, `test/wizard-task.test.mjs`, `test/kit.test.mjs`)**: Ensured all generated temporary file paths and code evaluation snippets normalize Windows backslashes (`\`) to POSIX slashes (`/`), preventing JavaScript string escape corruption.

## [0.37.0] - 2026-08-20
### Added
- **The secret scanner now decodes base64 values before matching (`src/security.mjs`)**: base64 is less an evasion technique than a file format — every value under `data:` in a Kubernetes Secret manifest is base64 by specification, and whole `.env` files get encoded into a single CI variable.
- **`redactSecrets()` removes the encoded form too**: otherwise `scanDiff()` blocked the dispatch and the escalation payload reporting the block leaked the very value it blocked on.
### Fixed
- **`agentctl budget reset` released reservations that had demonstrably reached Jules (`src/budget.mjs`, `bin/agentctl.mjs`)**: `budget_committed` was written to the ledger and read by `scanBudgetWindow()`, and `releaseOpenReservations()` even counted committed versus uncommitted for its report — then released both alike.
- **`agentctl budget reset` silently ignored unrecognised flags**: a misremembered option — `--root`, `--force` — dropped straight through to a full release.
### Changed
- **`agentctl budget` reports the split**: open reservations are shown as *confirmed dispatched* versus *never closed*, so the number `reset` will act on is visible before it is run.

## [0.36.0] - 2026-08-20
### Added
- **`web-ai-access` Task Envelope Template (`src/web-templates.mjs`, `agentctl task template web-ai-access`)**: Verifies that AI crawler directives agree across every surface — `robots.txt`, per-page robots meta tags, and `X-Robots-Tag` headers — for `GPTBot`, `ClaudeBot`, `Google-Extended`, `PerplexityBot`, `C…

## [0.35.2] - 2026-08-20
### Fixed
- **The governor was inert by default (`src/webhook.mjs`, `src/config.mjs`)**: `AWAITING_USER_FEEDBACK` is both the fallback `reason` and was listed in `DEFAULT_CRITICAL_REASONS`, so every escalation that did not name a reason took the critical bypass.
- **`--dry-run` spent the interruption budget (`src/webhook.mjs`)**: `recordInterruption()` ran before the dry-run and no-webhook-configured early returns, so previewing an escalation — or raising one in a repo with no webhook — charged the operator's hourly allowance …
- **`--dry-run --flush` destroyed the digest (`src/webhook.mjs`)**: previewing a flush called `clearEscalationDigest()` and returned the payload, discarding every buffered incident without sending anything.
- **Oversized flushes dropped incidents silently (`src/webhook.mjs`)**: Slack truncated the summary block and Discord rendered only the first 10 fields, after which the entire buffer was cleared — so a digest of 50 reported 10 and lost 40.
### Changed
- **`DEFAULT_CRITICAL_REASONS` moved to `src/config.mjs`** and is re-exported from `src/webhook.mjs`.

## [0.35.1] - 2026-08-20
### Added
- **`web-i18n` Task Envelope Template (`src/web-templates.mjs`, `agentctl task template web-i18n`)**: Pre-calibrated verification envelope for multi-language locale routing, bidirectional symmetric `<link rel="alternate" hreflang="...">` tags (including `x-default`), dynamic `<html lang="...">` valida…

## [0.35.0] - 2026-08-20
### Added
- **Type III Silence Governor & Interruption Budgeting (`src/webhook.mjs`, `src/config.mjs`, `agentctl escalate`)**: Configurable notification modes (`mode: "immediate" | "digest" | "threshold" | "silent"`) via `.agent/config.yml` under `notifications:`.
- **Automated Flaky Test Healing Swarm (`src/flaky-ledger.mjs`, `agentctl flaky`)**: `listQuarantinedTests(root)` scans historical test outcomes and identifies Wilson-quarantined suites (Exit Code 8, oscillation $\ge 0.40$).
- **Repository `.gitattributes` Linguist Overrides**: De-indexes and collapses internal agent prompt templates, state directories, test suites, and generated data from GitHub language statistics and diff search.

## [0.34.0] - 2026-08-20
### Fixed
- **The daily budget reset at local midnight instead of on the provider's rolling 24-hour window.** The ledger rotates per calendar day (`ledger-<date>.jsonl`) and the count never looked past today's …
- **A learned ceiling expired at midnight too.** A refusal observed at 23:00 was discarded an hour later, unblocking an operator the provider was still refusing; one observed at 00:30 kept them blocke…
- **An anonymous `budget_released` entry could drift away from the reservation it cancelled.** Id-less reservations can only be matched by position, so once the window advanced past a released reserva…
### Changed
- **Concurrency presets raised toward what the plans actually allow.** Free 1 → 3, Pro 2 → 8, Ultra 3 → 15, against published ceilings of 3 / 15 / 60.
- **`TIER_PRESETS` now records `maxConcurrency`** — the vendor's ceiling — separately from `concurrency`, the kit's default.

## [0.33.0] - 2026-08-20
### Fixed
- **Two disagreeing tier tables (`TIER_PRESETS` in `src/config.mjs` vs `TIER_PROFILES` in `src/wizard-init.mjs`)**: the wizard scaffolded `free: daily_tasks: 30` while the runtime budgeted free accounts at `15`, and the written value won the merge — so a freshly initialised free-tier repo was cleared for **twice it…
- **`ultra` was never offered by the onboarding wizard** despite being the runtime's fallback tier, and `tier: enterprise` resolved to no preset at all.
- **Hardcoded version strings in four modules**: the CLI banner read `0.32.8` while `src/mcp.mjs`, `src/dashboard.mjs` and the config the wizard scaffolded still claimed `0.29.x`.
- **Reservations written with no `reservationId` (`reserveDailyBudget()` in `scripts/utils.mjs`)**: these counted against the daily budget but could never be named by a rollback, commit or reconcile, so they stayed charged until the ledger rotated at midnight.
### Added
- **Limit provenance (`src/budget.mjs`, `resolveDailyLimit()`)**: the kit now records whether a daily limit came from the operator (`limits.daily_tasks` or `JULES_DAILY_BUDGET`), from the provider refusing work, or from a tier preset.

## [0.32.8] - 2026-08-20
### Fixed
- **`--dry-run` consumed a real daily task slot (`dispatch()` in `src/engine.mjs`)**: `withBudget()` wrapped the provider call unconditionally, so the budget was reserved *before* the dry-run branch was reached.
- **The test suite wrote to the operator's real budget ledger**: `test/engine.test.mjs`, `test/kit.test.mjs` and the CLI dry-run probes in `test/mcp.test.mjs` all dispatched against `process.cwd()`, appending permanent `budget_reserved` entries to `.agent/state/led…
### Added
- **`opts.provider` injection for `dispatch()`**: mirrors the injection point `gate()` already exposed, so dispatch can be exercised without reaching a live provider.
- Regression coverage for both defects: a dry run must not change the reserved count, a live dispatch must consume exactly one slot, `agentctl dispatch --dry-run` must exit `0` under an exhausted budg…

## [0.32.7] - 2026-08-20
### Fixed
- **Stale `v0.29.1` version strings in `doctor`, `status`, `dashboard` banners and `index.mjs` JSDoc**: All now read dynamically from the `VERSION` constant or `package.json` instead of hardcoded strings.
- **`--version` output**: Now uses the `VERSION` constant instead of a hardcoded string.
- **Subcommand `--help` / `-h` fatal error**: `agentctl <subcommand> --help` previously threw `[FATAL ERROR] Unknown option '--help'` because `node:util` `parseArgs` runs in strict mode.
- **Subcommand `--dry-run` / `-d` fatal error**: Added `--dry-run` as a recognized option to all 10 `parseArgs` call sites that were missing it (gate, bootstrap, init, task create, task template, task optimize, test-gen, mcp init, harvest, evidence).

## [0.32.6] - 2026-08-20
### Security
- **Cross-platform path canonicalisation (`canonicalizePath()` in `src/config.mjs`, `checkScope()`/`matchesGlob()`/`isForbiddenPath()` in `src/security.mjs`)**: Deny and protect matching previously ran against the raw path string, so `./x`, `a/../x` and `a//x` each presented the same file under a spelling the patterns did not literally match.
- **Secret scanner evasion hardening (`scanDiff()` in `src/security.mjs`)**: Patterns are now matched against three variants of the added-line text — as-written, with invisible characters stripped (zero-width, soft hyphen, bidi controls, BOM), and with source-level string conc…
- **Router Windows-path parity (`collectReferencedPaths()` in `src/router.mjs`)**: `extractPathTokens()` recognises only `/`, so a sensitive path written `src\auth\session.mjs` by a Windows author was invisible to the force-complex guard and the task could be routed to the cheap tier.
- **New export**: `canonicalizePath` is exported from `index.mjs` alongside `normalizePath`.
### Added
- **Documentation Sync Gate (`scripts/doc-sync-check.mjs`, `npm run jules:doc-sync`)**: Implements the previously-advertised-but-unbuilt `doc-sync-sentinel` preset.

## [0.32.5] - 2026-08-20
### Security
- **Provider URL Token Leakage Guard (`src/provider.mjs`, `test/provider-hardening.test.mjs`)**: Added strict validation in `createProvider()` rejecting custom HTTP provider specifications whose `url` or `sendMessageUrl` templates contain `{token}`.
- **Additive Git Core Test Suite (`test/git.test.mjs`)**: Created comprehensive native `node:test` suite for `src/git.mjs` verifying command execution (`runCmd`, non-zero exit codes, buffer limits `ENOBUFS`, timeouts `ETIMEDOUT`), shell escaping, git operati…
- **Dynamic Complexity & Cost Router (`src/router.mjs`, `router:` in `.agent/config.yml`)**: New zero-dependency, rule-based `classifyTaskComplexity()` heuristic and `resolveRoutedProvider()` resolver.
- **Safety-First Routing**: Tasks touching `config.scope.deny` or built-in sensitive path patterns (`auth/**`, `migrations/**`, `pricing/**`, `secrets/**`, `*.pem`, `*.key`, `.github/**`) always force the primary provider, as do…
### Changed
- **DAG-Ordered Queue Execution (`src/dag-engine.mjs`, `agentctl queue --dag`)**: Added `DagExecutor` with Kahn's-algorithm dependency resolution, cycle detection (`DagCycleError`), per-task timeout wrapping, and `--concurrency <n>` worker slot control, driven by `--depends-on` on …

## [0.32.4] - 2026-08-18
### Changed
- **Type III Situational Awareness & Silence Governor Alignment (`ROADMAP_V1.md`, `PRIOR_ART.md`)**: Documented architectural roadmap for Google Labs `/code` Type III agentic paradigm ("Silence is an explicit, strategic decision") including Interruption Budgeting, quiet-by-default digest mode in `src…
- **Documentation & Version Synchronization (`README.md`, `bin/agentctl.mjs`, `package.json`)**: Synchronized semantic version to `v0.32.4` across CLI binaries, help menus, and documentation descriptors.

## [0.32.3] - 2026-08-15
### Changed
- **Queue Runtime Hygiene & Git Sterilisation (`.gitignore`)**: Untracked historical local task execution files and tightened `.gitignore` rules to guarantee an empty, clean `.agent/jules-queue/` on fresh clones.
- **Swarm Merge Safety Gate Hardening (`scripts/jules-merge-swarm.mjs`)**: Scoped risk tier evaluation in `checkSafetyGate` specifically to the target swarm PR branch diff rather than uncommitted local workspace working tree state.
- **Documentation Alignment (`README.md`, `ROADMAP_V1.md`)**: Synchronized CLI tables, version output descriptors, and release milestone roadmaps to current stable `v0.32.3`.

## [0.32.2] - 2026-08-15
### Changed
- **Web Development Task Templates (`src/web-templates.mjs`, `agentctl task template`)**: Added zero-dependency template synthesis engine supporting `web-cwv` (Core Web Vitals & Lighthouse Budget Guard), `web-wcag` (WCAG 2.2 AA/AAA semantic accessibility & modal focus traps), `web-seo` (Sc…
- **Google Labs Exploration Budget Protocol (`src/task-optimizer.mjs`)**: Implemented 3-phase discovery envelope injection (Phase 1: Discovery & Symbol Tracing, Phase 2: Oracle Formulation, Phase 3: Surgical Implementation & Verification), proven by Google Labs research to …
- **Internal Critic Agent Steering (`src/task-optimizer.mjs`, `src/web-templates.mjs`)**: Added adversarial pre-review directives targeting Jules' internal Critic Agent to catch $O(n^2)$ bottlenecks, dropped arguments, Cumulative Layout Shifts (CLS), and accessibility defects before PR creation.
- **CLI & MCP Tool Extensions (`bin/agentctl.mjs`, `src/mcp.mjs`)**: Added `agentctl task template [id]`, `agentctl task create --template <id>`, `agentctl task optimize --web`, and the `get_web_task_template` MCP stdio tool.

## [0.32.1] - 2026-08-12
### Changed
- **Universal Edge-Runtime Detection (`src/stack-detector.mjs`)**: Added `detectEdgeRuntime()` helper detecting Cloudflare Workers (`wrangler.toml`/`wrangler.json`), Vercel Edge (`@vercel/edge`), Netlify Edge Functions (`@netlify/edge-functions`), and Deno runtimes a…
- **Edge Import Security Gatekeeper (`src/security.mjs`, `checkEdgeRuntimeImports`)**: Added static verification gate flagging unsupported native Node.js built-in module imports (`node:fs`, `node:child_process`, `node:net`, `node:tls`, `node:vm`, etc.) in Edge diff contexts or files dec…
- **Documentation & Unit Tests (`AGENTS.md`, `README.md`, `test/security.test.mjs`, `test/stack-detector.test.mjs`)**: Updated system directives, security gatekeeper documentation, and test assertions covering Edge stack detection and import violations.

## [0.32.0] - 2026-08-12
### Changed
- **CI Unshallow Gate Fix (`src/git.mjs`, `scripts/stale-base-check.mjs`)**: Added `ensureBaseFetched()` helper with `--depth=100` / `--unshallow` fallback for shallow clones in CI, and enforced hard `exit 1` on base branch resolution failure in `stale-base-check.mjs`.
- **SPORE Memory Engine & System Learnings (`src/memory.mjs`, `bin/agentctl.mjs`)**: Added zero-dependency memory module providing `recordLearning()`, `hydratePrompt()`, and `harvestFailure()`.
- **Unit Test Coverage (`test/spore-memory.test.mjs`)**: Added test suite for learning recording, prompt hydration, and failure harvesting, bringing total passing unit tests to 378 across 54 test suites.

## [0.31.0] - 2026-08-10
### Changed
- **Warm Multi-Turn Session Resumption (`src/provider.mjs`)**: Added `resume(sessionId, prompt)` targeting `POST /v1alpha/sessions/{id}:sendMessage` with fail-soft cold dispatch fallback, saving 60–80% token consumption across OODA turns.
- **AST Blast-Radius Selective Testing (`src/dag-engine.mjs`)**: Implemented `resolveAffectedTests()` with `GLOBAL_CONTRACT_PATTERNS` guard to selectively run only affected leaf tests in large codebases while preserving full-suite verification on global changes.
- **Verification Lifecycle Sandbox (`src/config.mjs`, `src/engine.mjs`)**: Added `verify.setup` and `verify.teardown` lifecycle execution with guaranteed `try...finally` process-group cleanup for Prisma, Drizzle, Django, and SQLite migrations.
- **Prompt Falsifiability & Scope Linter (`src/task-optimizer.mjs`, `agentctl task optimize`)**: Added pre-dispatch prompt analyzer scoring testability (0–100), fuzzy typo resolution for file paths via Levenshtein distance, and automatic task envelope formatting.

## [0.30.0] - 2026-08-10
### Changed
- **Terminal Engine Hardening (`src/ux/`)**: Implemented zero-dependency terminal capabilities detector (`capabilities.mjs`), incremental sequence key decoder (`key-decoder.mjs`), raw mode lifecycle manager (`terminal-session.mjs`), virtual scre…
- **Guided Diagnostics & Auto-Remediation (`src/ops/`)**: Added diagnostic check DAG (`doctor-registry.mjs`), pure fix proposal planner (`doctor-planner.mjs`), transactional executor (`transaction.mjs`), and operation receipts system (`receipts.mjs`).
- **Interactive Queue & Swarm Manager (`src/ux/`, `src/ops/`)**: Implemented canonical task sidecar state machine (`queue-model.mjs`), swarm slot PID liveness detector (`swarm-model.mjs`), task action planner (`task-actions.mjs`), and swarm action planner (`swarm-actions.mjs`).
- **Command Registry & Interactive Command Palette (`src/ops/`, `src/ux/`)**: Added normative command descriptor registry (`command-registry.mjs`), CLI `--help` text generator, fuzzy search filter, and interactive command palette view (`palette.mjs`).

## [0.29.1] - 2026-08-10
### Changed
- **Canonical Queue Alignment (`src/wizard-task.mjs`)**: Updated `runTaskCreateWizard()` to write generated task files to canonical `getQueueDir(root)` (`.agent/jules-queue/`) rather than unread `.agent/queue/` directory.
- **Task ID Path Traversal Guard (`src/wizard-task.mjs`)**: Enforced strict task ID sanitization (`/[^a-zA-Z0-9_-]/g`) and path containment verification preventing directory traversal attacks via custom task IDs.
- **Atomic Writes & Config Preservation (`src/wizard-init.mjs`)**: Implemented atomic write operations (`tmp` file + `fsync` + `renameSync`) for `.agent/config.yml` and `.agent/jules.yml`.
- **Non-TTY Headless Guard (`src/wizard-init.mjs`)**: Enforced explicit error when running `runInitWizard()` in non-TTY mode without explicit parameters or `allowDefaults: true`.

## [0.29.0] - 2026-08-10
### Changed
- **Native Terminal UI (TUI) Engine (`src/tui.mjs`)**: Added zero-third-party-dependency TUI primitives built on `node:readline/promises`, `node:tty` (`setRawMode(true)`), and ANSI escape sequences, including single-select menus, multi-select checkboxes, …
- **Stack Oracle & Verification Probes (`src/wizard-oracle.mjs`)**: Added multi-tier stack inspection (Node, Cargo, Go, Pytest, CMake, Elixir, Docker, monorepos) and `runVerificationProbe()` execution validator.
- **Interactive Onboarding Engine (`src/wizard-init.mjs`, `agentctl init --interactive`)**: Added pure planning core `planInit()`, tier matrix (`free`, `pro`, `enterprise`), declarative preset loader (`.agent/presets/*.yml`), and atomic configuration generator.
- **Guided Task Authoring Subsystem (`src/wizard-task.mjs`, `agentctl task create`)**: Added task creation planning core `planTaskCreate()`, TODO candidate harvesting from `scanCodebaseForTodos()`, Shannon entropy secret leak scrubbing, falsifiability verification enforcement, `gate --m…

## [0.28.2] - 2026-08-10
### Changed
- **Jules Provider `startingBranch` & Source Validation (`src/provider.mjs`)**: Updated `startingBranch` to default to `config.baseBranch` (or `main`) rather than a target branch prefix (`agent/task`).
- **Automation & Plan Approval Body Mapping (`src/provider.mjs`)**: Mapped `task.autoPr` / `ctx.autoPr` to `automationMode: "AUTO_CREATE_PR"` and `task.requirePlanApproval` to `requirePlanApproval: true` in Google Jules REST API payloads.
- **Gate Mode Engine Wiring (`src/engine.mjs`)**: Wired `opts.mode` directly into `gate()`, passing `mode` down to `changedFiles()`, `diffBytes()`, and `diffText()`.
- **P0 Test Suite & E2E Verification (`test/p0-remediation.test.mjs`)**: Added end-to-end unit tests asserting `startingBranch` defaults, missing source validation, `automationMode` / `requirePlanApproval` body mapping, and `gate({ mode: "working-tree" })` untracked file secret blocking.

## [0.28.1] - 2026-08-10
### Changed
- **Node 22 Test Lifecycle Fix (`test/p0-remediation.test.mjs`)**: Made parent test callbacks `async` and awaited nested `t.test()` promises, resolving test cancellation failure on Node 22/20 CI runners.
- **Jules v1alpha Starting Branch Fix (`src/provider.mjs`)**: Updated `startingBranch` payload field to default to `config.baseBranch` (or `main`) rather than task target branch prefix (`agent/task`), conforming with Google Jules REST API spec.
- **Gate Working-Tree Mode Wiring (`src/engine.mjs`, `bin/agentctl.mjs`)**: Wired `opts.mode` into `gate()` (defaulting to `working-tree` for local runs) and added `--mode` (`working-tree`, `staged`, `committed`) options to `agentctl gate`.
- **CLI Options & Missing Commands (`bin/agentctl.mjs`)**: Added CLI options `--source`, `--branch`, `--repoless`, `--auto-pr`, `--require-plan-approval` to `agentctl dispatch`, added CLI command handlers for `create`, `status`, and `scan`, and normalized pro…

## [0.28.0] - 2026-08-09
### Changed
- **Google Jules REST v1alpha Provider Alignment (`src/provider.mjs`)**: Conformed default provider endpoint to `https://jules.googleapis.com/v1alpha/sessions` using `X-Goog-Api-Key` authentication header and structured `sourceContext` (`source` and `githubRepoContext.startingBranch`).
- **Prompt Guard Instruction Framing (`src/engine.mjs`, `src/prompt-guard.mjs`)**: Fixed `dispatch()` so primary user task instructions are passed as trusted operator instructions under `[TASK INSTRUCTIONS]` and not framed as untrusted data (`<<<UNTRUSTED-DATA>>>`).
- **Queue State Engine & Retry Semantics (`src/engine.mjs`)**: Updated `run()` so rate-limited (HTTP 429) or unavailable (HTTP 5xx) task dispatches leave task files in `queue/` for retry instead of moving them to `completed/`.
- **Working-Tree & Untracked File Gate Mode (`src/git.mjs`)**: Extended `changedFiles()`, `diffText()`, and `diffBytes()` with `working-tree` mode support to inspect uncommitted modifications, staged index, and untracked `.env`/secret files during pre-commit gating.

## [0.27.1] - 2026-08-09
### Changed
- **Dead Code Cleanup (`src/process-group.mjs`, `src/git.mjs`)**: Removed orphaned `src/process-group.mjs` module and unused `createBranch` / `worktreeAdd` exports from `src/git.mjs`.
- **Zero-Dependency Audit**: Verified 100% clean test execution and ESLint passing without introducing third-party analysis dependencies.

## [0.27.0] - 2026-08-09
### Changed
- **PR Review Auto-Remediation (`src/review-repair.mjs`)**: Implemented `parseReviewComments()` to parse GitHub PR review comments (`CHANGES_REQUESTED`), filter out conversational praise (`lgtm`, `looks good`, `thanks`), map file/line coordinates, and synthesi…
- **Multi-Provider Failover Router (`src/provider.mjs`)**: Implemented `createFailoverProvider()` allowing sequential failover across ordered provider lists (`["jules", "claude-code", "local-mcp"]`) on HTTP 429 rate limits or 5xx service unavailability.
- **Zero-Dependency Local Dashboard (`src/dashboard.mjs`)**: Implemented `createDashboardServer()` using `node:http` to serve a real-time dark-mode HTML visualizer and REST APIs (`/api/status`, `/api/telemetry`, `/api/flaky`, `/api/locks`).
- **Unit Test Suite (`test/v027-features.test.mjs`)**: Created test suite asserting PR review comment parsing, conversational noise filtering, multi-provider failover routing, and HTTP dashboard REST endpoints.

## [0.26.2] - 2026-08-09
### Changed
- **Triage Guidelines (`README.md`)**: Added explicit "When to Use vs.
- **Playwright Frontend Quickstart (`README.md`)**: Added Playwright E2E testing quickstart recipe demonstrating how visual/UI tasks can be made falsifiable via headless browser snapshot tests.

## [0.26.1] - 2026-08-09
### Changed
- **ESLint Fix (`src/merge-blocks.mjs`)**: Renamed unused `schemaType` parameter to `_schemaType` in `hashCrossLanguageInterface` signature, resolving ESLint `no-unused-vars` failure in CI.
- **Executive README Polish (`README.md`)**: Updated README with intuitive 2-sentence mental model, universal quickstarts across 5 stack archetypes, feature comparison matrix, architecture diagrams, and v0.27+ roadmap in an authoritative enterprise tone.

## [0.26.0] - 2026-08-09
### Changed
- **Universal Polyglot Stack Detector (`src/stack-detector.mjs`)**: Auto-detects 24+ tech ecosystems (PHP/Laravel/WP, .NET/C#/F#, Mobile Flutter/Swift/Dart/React-Native, Systems CMake/Cargo/Go/Make, Python, Node, Deno, Bun, Mix, Maven, Gradle, Bundler).
- **Container Execution Wrappers (`src/stack-detector.mjs`)**: Auto-detects `.devcontainer/devcontainer.json` or `docker-compose.yml` and wraps task verification commands in `docker compose exec -T app <cmd>` or `devcontainer exec`.
- **Scoped Monorepo Boundary Resolver (`resolveWorkspaceBoundary`)**: Isolates changed files up directory ancestry to nearest subproject root and synthesizes subshell test commands (`(cd backend && pytest) && (cd cli && cargo test)`), or falls back to global verificatio…
- **Zero-Test Repository Bootstrapping (`agentctl bootstrap`)**: Synthesizes non-destructive syntax check oracles (`php -l`, `python -m compileall`, `dotnet build`, `npx tsc --noEmit`) or generates `.agent/smoke.test.mjs` for untested repos.

## [0.25.1] - 2026-08-09
### Changed
- **Non-Blocking Queue Runner File I/O (`src/engine.mjs`)**: Replaced `fs.readFileSync` with `await fs.promises.readFile` inside the async batch processing map in `run()`, preventing event loop blocking during file prompt reads.
- **Command Resolver Sub-Parsers (`scripts/command-resolver.mjs`)**: Modularized `resolveProjectCommands` by extracting `parseYamlConfig` and `detectFrameworkCommands`.
- **Self-Audit Validation Passes (`scripts/jules-self-audit.mjs`)**: Modularized `runSelfAudit` into dedicated exported validation functions (`auditLedgers`, `auditWorktrees`, `auditGates`).

## [0.25.0] - 2026-08-09
### Changed
- **Provider Error Taxonomy (`src/provider.mjs`)**: Added typed error classes `ProviderRateLimitError` (HTTP 429), `ProviderUnavailableError` (5xx errors and socket timeouts), and `ProviderSchemaError` (invalid payload format).
- **Socket Timeout Support (`src/provider.mjs`)**: Configured 120s default socket timeout via `AbortSignal.timeout(timeoutMs)` for all HTTP provider dispatch requests.
- **Atomic Budget Rollback (`src/state.mjs`)**: Added `rollbackBudgetReservation()` to release reserved budget when provider calls fail to accept the session.
- **OODA Repair Bypass (`src/engine.mjs`)**: Updated `dispatch()` and `repair()` to catch provider infrastructure failures, roll back reserved budget, log backoff recommendations, and bypass OODA repair retries.

## [0.24.0] - 2026-08-09
### Changed
- **Fixed Queue Runner Dispatch (`scripts/jules-queue-runner.mjs`, `src/engine.mjs`)**: Refactored queue runner and `run()` engine to actually dispatch tasks via `dispatch()` before relocating them to `completed/`.
- **Code Pruning & Shim Cleanup**: Deleted obsolete shims (`scripts/jules-swarm.mjs`, `scripts/lock-manager.mjs`, `scripts/jules-cleanup.mjs`).
- **Premise Validation Fix (`src/envelope.mjs`)**: Fixed `git cat-file -e` premise check in `validateEnvelope` to evaluate exit code status (`status === 0`) instead of checking stdout length.
- **Lock Metadata Hardening (`src/state.mjs`)**: Included `branch` field in JSON lock payloads generated by `acquireLock`.

## [0.23.0] - 2026-08-09
### Changed
- **O(1) Telemetry Engine (`src/telemetry.mjs`)**: Implemented `appendTelemetry` with SHA-256 hash chaining, O(1) `.head` atomic cache file (`safeAtomicWrite` with `{ sync: false }`), cold scan fallback recovery, and 8 MB log segment rotation.
- **MCP Progress Streaming Bus (`src/mcp-progress.mjs`)**: Implemented `ProgressBus` with 150ms window coalescing (latest-wins intermediate state), stream backpressure safety (awaiting `"drain"`), 240-character progress message string capping, and `notificati…
- **MCP Tooling & System Integration (`src/mcp.mjs`, `src/engine.mjs`, `src/dag-engine.mjs`)**: Registered `telemetry_tail` MCP tool to query recent telemetry events.
- **Unit Test Suite (`test/telemetry-mcp-stream.test.mjs`)**: Added test suite verifying 1000 sequential O(1) appends (543ms), SHA-256 hash chain integrity, cold scan recovery, progress coalescing, message capping, backpressure safety, and tool execution.

## [0.22.9] - 2026-08-09
### Changed
- **Block Chunker & Merger (`src/merge-blocks.mjs`)**: Implemented `chunkBlocks` parsing column-0 declaration boundaries (`export`, `function`, `class`, `const`, `def`, etc.) with SHA-1 hashing, and `mergeBlocks3Way` performing 3-way block classification …
- **Syntax Verification Chain (`src/merge-verify.mjs`)**: Implemented `mergeVerifyChain` validating merged outputs via `node --check`, `tsc --noEmit` (if `tsconfig.json` exists), and `python3 -m py_compile`.
- **DAG Engine Hardening (`src/dag-engine.mjs`)**: Added registration freezing on `execute()`, `withTaskTimeout` per-task execution limits, and keyed output fingerprints (`${taskId}:${filePath}`).
- **Unit Test Suite (`test/merge-blocks.test.mjs`)**: Added tests asserting disjoint JS function additions, overlapping edit conflict generation, and post-execution `addTask()` rejection.

## [0.22.8] - 2026-08-09
### Changed
- **Flaky Test Ledger (`src/flaky-ledger.mjs`)**: Added `recordVerifyRun` appending run records to `.agent/state/flaky.jsonl` and `readVerifyRuns` / `getVerifyRuns` for reading stored run records.
- **Gate Integration (`src/engine.mjs`)**: Integrated verification run recording into `gate()`.
- **Unit Test Suite (`test/flaky-ledger.test.mjs`)**: Added test coverage verifying alternating P/F quarantine evaluation (`allowRepair = false`), 6 consecutive failures evaluation (`allowRepair = true`), ledger file IO, and gate exit code 8 return.
- **Documentation & Exit Code Registry (`AGENTS.md`)**: Documented Exit Code 8 (`FLAKY_QUARANTINE`) in exit code registry and troubleshooting matrix.

## [0.22.7] - 2026-08-09
### Changed
- **Stale Mutex Directory Reaper (`src/journal.mjs`)**: Added `reapStaleMutexDirs` scanning `.agent/state/` for `.mutex` directories older than `ttlMs` (30s) and using atomic grave paths (`.grave-<pid>`) with `rmdirSync` for CAS deletion.
- **PID Starttime Verification (`src/journal.mjs`)**: Updated `reapOrphanedIntents` lock cleanup to verify process start time via `isPidAlive(lockPid, lockStartTime)`, preventing lock deletion when process IDs are reused.
- **Absolute File URL Net-Guard Flag (`src/engine.mjs`, `src/git.mjs`)**: Updated net-guard `--import` flag to construct absolute file URLs (`new URL("./preload-net-guard.mjs", import.meta.url).href`), preventing `ERR_MODULE_NOT_FOUND` in downstream consumer repositories.
- **Prompt Guard Envelope Neutralization (`src/prompt-guard.mjs`, `src/engine.mjs`)**: Forced full re-sanitization in `buildAgentEnvelope` even if input strings contain `<<<UNTRUSTED-DATA-BEGIN` to close pre-trust bypass vectors.

## [0.22.6] - 2026-08-09
### Changed
- **Intent Journaling (`src/journal.mjs`)**: Implemented `journalIntent` and `journalDone` appending intent records to `.agent/state/journal.jsonl` with PID, `processStartTime`, operation type, target path, and timestamp.
- **Boot-Time Zombie Worktree Reaper (`src/journal.mjs`)**: Implemented `reapOrphanedIntents` to scan intent journal on startup, identify orphaned operations from dead/recycled PIDs using `isPidAlive`, prune orphaned git worktrees (`git worktree remove --force…
- **Boot Wiring (`bin/agentctl.mjs`, `src/mcp.mjs`)**: Integrated automatic reaping at CLI boot in `main()` and MCP server startup in `startMcpServer()`.
- **Git Mutation Wrapping (`src/git.mjs`)**: Wrapped `worktreeAdd` and `createBranch` with intent journaling.

## [0.22.5] - 2026-08-09
### Changed
- **Proc Stat Parsing (`src/state.mjs`)**: Refactored `getProcessStartTime` and added `parseProcStat` parsing fields strictly after `lastIndexOf(')') + 2` to prevent index shifts caused by process titles containing spaces or parentheses.
- **Queue Task Matching Filter (`src/engine.mjs`, `bin/agentctl.mjs`)**: Added `isTaskFile()` helper filtering out `README.md` and matching `TASK-*.md` or valid envelope front-matter in `.agent/jules-queue/`.
- **Process Execution Guardrails (`src/git.mjs`)**: Added default 10-minute timeout and 10 MB `maxBuffer` to process wrappers (`runCmd`, `git`).
- **Immutable Base Commit SHA Pinning (`src/git.mjs`, `src/execution_envelope.mjs`)**: Updated `resolveBase` to return exact 40-character commit SHAs output by `git rev-parse <ref>^{commit}` to pin `baseSha` immutably.

## [0.22.4] - 2026-08-09
### Changed
- **Task DAG Engine (`src/dag-engine.mjs`)**: Implemented native zero-dependency `DagExecutor` and `DagCycleError`.
- **SDK Export (`index.mjs`)**: Exported `DagExecutor` and `DagCycleError` for SDK consumption.
- **Unit Test Suite (`test/dag-engine.test.mjs`)**: Added test coverage asserting linear DAG execution order, diamond DAG concurrent dispatch, circular graph pre-execution cycle errors, interface fingerprinting gate validation, and lexicographical tie-…

## [0.22.3] - 2026-08-09
### Changed
- **Hermetic Preload Guard (`src/preload-net-guard.mjs`)**: Intercepts and blocks unmocked network egress in test sub-processes without external npm dependencies by monkey-patching `globalThis.fetch`, `node:http.request`, `node:http.get`, `node:https.request`,…
- **Engine Environment Injection (`src/engine.mjs`, `src/git.mjs`)**: Automatically injects `NODE_OPTIONS="--import ./src/preload-net-guard.mjs"` into verification/test suite executions inside `gate()` and passes custom `env` options in `runCmd()`.
- **Network Guard Unit Test Suite (`test/net-guard.test.mjs`)**: Added unit test suite asserting blocked unmocked egress (exit code `188` and `[FATAL] ERR_UNMOCKED_NET: <host>` output to stderr) and allowed loopback requests (`localhost`, `127.0.0.1`, `::1`).

## [0.22.2] - 2026-08-09
### Security
- **Input Sanitization Boundary (`src/prompt-guard.mjs`)**: Added `sanitizeUntrustedData` and `buildAgentEnvelope`.
- **MCP Stdout Stream Isolation (`src/mcp.mjs`)**: Sealed `process.stdout.write` and isolated stdout stream from generic writes (like `console.log`), redirecting unauthorized writes to `process.stderr` to prevent JSON-RPC framing stream corruption.
- **Prompt Guard Unit Test Suite (`test/prompt-guard.test.mjs`)**: Added test suite asserting injection neutralization, bidi/ANSI stripping, and stdout stream isolation during MCP execution.

## [0.22.1] - 2026-08-09
### Changed
- **Mutex Fail-Closed Enforcement (`src/state.mjs`)**: Updated `withVfsMutex` to strictly throw `MutexTimeoutError` on lock acquisition timeout instead of executing the critical section without a valid lock.
- **Robust PID Recycling Validation (`src/state.mjs`)**: Enhanced `isPidAlive()` to read field 22 (`starttime`) from `/proc/<pid>/stat` on Linux.
- **Atomic Budget Reservation (`src/state.mjs`)**: Added `reserveBudgetAtomic()` protecting budget checking, reservation writing, and `fsyncSync` under `.budget.mutex`.
- **Kernel Hardening Unit Test Suite (`test/kernel-hardening.test.mjs`)**: Added automated unit tests verifying fail-closed mutex behavior, PID recycling starttime validation, and atomic budget reservation under 20 concurrent tasks.

## [0.22.0] - 2026-08-09
### Changed
- **Node.js LTS Engine Bump (`package.json`, `README.md`, `action.yml`)**: Raised Node.js engine requirement from `>=18.0.0` to `>=20.0.0` (Active LTS baseline).

## [0.21.0] - 2026-08-09
### Changed
- **Falsy Zero-Budget Fix (`src/config.mjs`)**: Fixed `JULES_DAILY_BUDGET: 0` evaluating as falsy and bypassing zero-budget limits.
- **Rule Path Security Guard (`src/risk.mjs`)**: Added missing `.agent/rules/**` to `RESTRICTED_PATH_PATTERNS`, guaranteeing rule edits trigger R3 Restricted risk classification.
- **OODA Fingerprint Normalization (`src/engine.mjs`)**: Extended `fingerprintFailureState()` regex for ANSI escape codes (`[\u001b\x1b]\[[0-9;]*[a-zA-Z]`), URL query parameters, line numbers, and column numbers.
- **MCP Server Parameter Validation (`src/mcp.mjs`)**: Added JSON-RPC `-32602` error validation for `check_risk_tier` input parameters and `-32601` for invalid methods.

## [0.20.0] - 2026-08-08 (Community Release Candidate)
### Changed
- **Linearizable VFS Directory Mutex (`src/state.mjs`)**: Kernel-level VFS directory mutex (`withVfsMutex`) guaranteeing strict serial linearizability for SHA-256 hash-chained session ledgers under high-concurrency multi-agent swarms.
- **PID Recycling & Stale Lock Protection (`src/state.mjs`)**: Added process start-time verification (`/proc/<pid>/stat` field 22 on Linux) to `isPidAlive()`, eliminating false-positive lock reaps from recycled OS process IDs.
- **Memory-Bounded Content-Length MCP Streaming (`src/mcp.mjs`)**: Implemented `McpFrameDecoder` with a 4 MB memory safety ceiling, supporting both HTTP-style `Content-Length` header framing and line-delimited JSON-RPC 2.0 messages over stdio.
- **Process Group Isolation & Zombie Defense (`src/process-group.mjs`)**: Implemented `ProcessGroupManager` with `detached: true` process group targeting and signal hooks (`SIGINT`/`SIGTERM`/`exit`) executing `process.kill(-pgid)` to guarantee 100% leak-free process tree cleanup.

## [0.10.0] - 2026-08-08
### Security
- **Shell-less Process Execution (`src/git.mjs`, `src/engine.mjs`)**: Refactored `runCmd()` to tokenise command strings and execute directly via `execFileSync` without invoking system shell (`sh -c` / `cmd.exe /c`), preventing command injection vulnerabilities.
- **Fail-Closed Webhook Verification (`src/webhook.mjs`)**: Updated `verifySignature()` to fail closed when `JULES_WEBHOOK_SECRET` is unset.
- **Expanded Secret Scanning (`src/security.mjs`)**: Added 2026 key formats (`github_pat_`, Anthropic `sk-ant-`, OpenAI `sk-proj-`, Google OAuth `ya29.`, Slack bot tokens) to `HIGH_CONFIDENCE_PATTERNS`.
- **Execution Envelope Canonicalization (`src/execution_envelope.mjs`)**: Updated `hashExecutionEnvelope()` to include `baseRef` and `createdAt` alongside key-canonicalization in the SHA-256 digest.

## [0.9.4] - 2026-08-08
### Added
- **Zero-Dependency Stdio MCP Server (`src/mcp.mjs`, `bin/mcp-server.mjs`)**: Implemented native Model Context Protocol (MCP) server over stdio streams using Node.js `node:readline` and JSON-RPC 2.0.
- **CLI & Package Expositions**: Added `agentctl mcp` command and exposed `jules-mcp` and `agentctl-mcp` binary targets in `package.json`.
- **Exit Code 7 Alignment (`BudgetError`)**: Updated `withBudget` in `src/state.mjs` to throw `BudgetError` with explicit `code: 7` on daily session budget exhaustion (`dailyTasks: 300`).
- **Documentation & Remediation Matrix**: Documented `Exit 7` in `AGENTS.md` and added a complete Exit Code Troubleshooting & Remediation Matrix for codes `0–7`.

## [0.9.2] - 2026-08-03
### Added
- **Modular Domain Architecture (`src/`)**: Completely refactored from vendored script prototype into native ESM modules (`src/config.mjs`, `src/security.mjs`, `src/git.mjs`, `src/provider.mjs`, `src/state.mjs`, `src/engine.mjs`).
- **Unified Command-Line Interface (`agentctl`)**: Added single `bin/agentctl.mjs` CLI executable supporting `dispatch`, `gate`/`audit`, `queue`, `swarm`, `lock`, `doctor`, and `init` with `--json` output options.
- **Provider-Agnostic Engine Architecture**: Configuration-driven template adapters supporting `http` and `exec` providers (`jules`, `claude-code`, `codex`, Ollama, Bedrock) with shell-less execution (`spawnSync`, `shell: false`).
- **Zero-Dependency Guarantee**: Core engine built strictly using native Node.js ≥ 18 built-in modules (`node:fs`, `node:path`, `node:child_process`, `node:crypto`, `node:util`).

## [0.8.6] - 2026-08-03
### Added
- **Safety Gate Verification Engine**: Added `checkSafetyGate()` in `scripts/jules-merge-swarm.mjs` to inspect active worker locks (`.agent/state/locks/*.json`) before squashing PRs, preventing active session merge collisions.
- **UNTRUSTED Prompt Injection Fencing & Pre-Flight Static Checks**: Enhanced `<UNTRUSTED_TASK_CONTEXT_${nonce}>` directives in `scripts/jules-dispatch.mjs` with explicit injection defense rules and added `runPreflightStaticCheck()` to pre-run static analysis (`eslint`…
- **3-Bucket Status Categorization**: Added `categorizeTaskStatus()` in `scripts/jules-status.mjs` partitioning task outputs into *🚨 Action Required*, *⏳ In Progress*, and *✅ Completed / Terminal*.
- **Specialist Agent Prompts & Master Template**: Added `.agent/prompts/` directory featuring `Overseer.md` (codebase audit specialist), `Bolt.md` (micro-performance optimizer), `Sentinel.md` (security auditor), and `Task_Template.md` (master prompt template).

## [0.8.5] - 2026-08-03
### Added
- **Disjoint Swarm PR Auto-Merge Engine**: Added `scripts/jules-merge-swarm.mjs` (`npm run jules:merge-swarm`) to automatically verify CI checks, evaluate disjoint file cluster modifications (zero file collisions), and squash-merge passing Jul…
- **`baseBranch` REST Payload Decoupling**: Updated `startingBranch` in `jules-dispatch.mjs` to strictly use `BASE_BRANCH || "main"` (the remote base ref), preventing HTTP 400 `sessionFailed` errors from unpushed local feature branches.
- **Active Session Quota Backoff (`FAILED_PRECONDITION`)**: Added HTTP 400 `FAILED_PRECONDITION` detection (~30 concurrent max session limit) with exponential retry backoff in `jules-dispatch.mjs` and `concurrency_limit` classification in `jules-queue-runner.mjs`.
- **OODA Repair Secret Masking**: Wrapped failure logs in `redactSecrets(anonymizePii(failureLog))` inside `jules-self-audit.mjs` before dispatching auto-repair prompts.

## [0.8.4] - 2026-08-03
### Fixed
- **Dynamic Guardrails Schema Alignment**: Fixed schema drift in `jules-dispatch.mjs:getDynamicGuardrails` by supporting both `rule.directive` and `rule.guardrail` properties from `.agent/rules/dynamic-guardrails.json`.
- **PuTTY PPK Format Pattern Fix**: Updated PuTTY secret scanning pattern in `utils.mjs` to match actual PPK key headers (`PuTTY-User-Key-File-\d+:`).
- **Expanded Secret Redaction (10+ New Token Families)**: Added high-confidence & low-confidence secret regex patterns for Google OAuth client secrets (`GOCSPX-`), AWS STS tokens (`ASIA`), GitLab PATs (`glpat-`), DigitalOcean PATs (`dop_v1_`), SendGrid API k…
- **SDK & MCP Export Readiness**: Exported `dispatchTask` in `jules-dispatch.mjs` and `classifyQueueFailure` in `jules-queue-runner.mjs`, making them available from the `index.mjs` primary SDK entrypoint for programmatical and MCP server invocation.

## [0.8.3] - 2026-08-03
### Security
- **P0 Untrusted Prompt Envelope Noncing**: Replaced static `<UNTRUSTED_TASK_CONTEXT>` tags in `jules-dispatch.mjs` with crypto-random nonced tags (`<UNTRUSTED_TASK_CONTEXT_${nonce}>`) and case-insensitive closing tag stripping to prevent promp…
- **P0 Image Attachment Containment & Path Traversal Prevention**: Added `realpathSync` root containment checks in `extractImageAttachments` to block traversal attacks (`../../../etc/passwd.svg`) and eliminated the wasteful 500KB `dataUri` exfiltration vector.
- **P0 Secret Scanner Buffer Overflow & Fail-Closed Policy**: Expanded `runGitCommand` buffer in `jules-self-audit.mjs` to 25MB (`maxBuffer`) and disabled silent error swallowing on git diff execution (`ignoreError = false`), guaranteeing secret scans fail-closed on massive diffs.
- **P0 Unconditional CI Audit & Scope Guard Workflows**: Removed `jules/` head ref and actor restrictions from `.github/workflows/agent-scope-guard.yml` and `.github/workflows/jules-audit.yml`, ensuring gatekeeper checks run on all PRs regardless of actor.

## [0.8.2] - 2026-08-01
### Fixed
- **Safe CI Template Scaffold**: Updated `.github/workflows/jules-audit.yml` to use `npm run lint --if-present` and `npm test --if-present`, preventing scaffolded user repositories without a `lint` script from failing CI on first push.
- **Untrusted Prompt Fencing & Security Header**: Added `# SECURITY DIRECTIVE — UNTRUSTED CONTENT FENCE` header and untrusted specifications instruction inside `<UNTRUSTED_TASK_CONTEXT>`.
- **Queue Runner Non-Zero Exit on Permanent Failures**: Updated `jules-queue-runner.mjs` to exit with code 1 when any queue tasks fail permanently.
- **Package Payload Shrink**: Excluded `.github/social-preview.png` and scoped `files` in `package.json` to `.github/workflows/jules-audit.yml`, reducing npm tarball size by 87% (from 332.9 kB down to 44.8 kB).

## [0.8.1] - 2026-07-31
### Fixed
- **OODA Function Module-Scope Fix**: Moved `getOodaStateFile` to top-level module scope in `jules-self-audit.mjs`.
- **Queue Budget Deferral**: Daily budget exhaustion (`budget_exhausted`) is no longer treated as permanent failure.
- **Automatic 30-Day Ledger Pruning**: Added `pruneOldLedgers()` to `utils.mjs` to automatically clean up date-stamped `.jsonl` files older than 30 days.
- **Enhanced Guardrail Error Messages**: Updated `jules-self-audit.mjs` error messages to explicitly list offending files and matching override flags (`JULES_ALLOW_COMMAND_FILE_CHANGES=true` or `JULES_ALLOW_AGENT_RULE_CHANGES=true`).

## [0.8.0] - 2026-07-31
### Added
- **Daily Ledger Rotation**: Session ledgers rotate into daily date-stamped files (`.agent/state/sessions/YYYY-MM-DD.jsonl`), preventing ledger bloat and speeding up daily budget calculations.
- **Package Manager Detection**: `resolveProjectCommands` now automatically detects `pnpm` (`pnpm-lock.yaml`), `yarn` (`yarn.lock`), `bun` (`bun.lockb`), and `packageManager` fields before falling back to `npm`.
- **JSON Status Reporting**: Added `--json` output flag to `scripts/jules-status.mjs` for programmatic status and budget metric consumption.
- **Global Swarm Partitioning**: Updated `scripts/jules-swarm.mjs` to pass global task indices across the entire swarm queue rather than per-batch indices.

## [0.7.0] - 2026-07-31
### Added
- **Zero-Trust Base-Branch Rule Extraction**: `getBaseRules()` now fetches `AGENTS.md` and `JULES_RULES_TEMPLATE.md` directly from `origin/main` via `git show`, preventing untrusted PR branches from injecting malicious agent instructions.
- **Agent Rule Change Guardrail**: Added `RESTRICTED_AGENT_FILES` check (`AGENTS.md`, `JULES_RULES_TEMPLATE.md`, `.agent/rules/**`, `.agent/workflows/**`).
- **Executable Build Config Guardrail**: Expanded `COMMAND_DEFINING_FILES` with `EXECUTION_CONFIG_FILES` (`jest.config.*`, `vitest.config.*`, `playwright.config.*`, `vite.config.*`, `webpack.config.*`, `next.config.*`, `babel.config.*`, `tsc…
- **Safe Dispatch Cleanup**: Replaced `process.exit(7)` inside `executeDispatch` with a thrown error (`err.code = 7`), guaranteeing `finally { cleanupTmp(); }` executes and wipes temporary payload files.

## [0.6.3] - 2026-07-31
### Fixed
- **Removed Unverified Third-Party Setup URL**: Replaced misleading `app.jules.ai/setup` link in `bin/init.js` with official Google Jules portal `https://jules.google`.
- **Renamed Workspace Setup Code**: Clarified terminology in `bin/init.js` and `.agent/JULES_WEB_SETUP.md` from "Cryptographic Handshake" to "Encoded Workspace Manifest".
- **Added Missing Helper Scripts to Target `package.json`**: Added `"jules:cleanup"` and `"jules:scan"` script entries to injected `package.json` manifest.
- **Automatic `.gitignore` Security Scaffolding**: `bin/init.js` now automatically injects required security ignore rules (`.env`, `.agent/history/`, `.agent/state/`, `.agent/jules-queue/*.md`) into target `.gitignore` if missing.

## [0.6.2] - 2026-07-31
### Fixed
- **Dynamic Secret Test Fixtures**: Constructed secret strings dynamically in `kit.test.mjs` (`"gho_" + "1".repeat(36)`) to prevent static string literals from triggering Exit Code 6 on self-audits of test files.
- **Restored `redactSecrets` Test Coverage**: Added dedicated unit tests verifying that `redactSecrets` masks active environment variables, OAuth tokens, Bearer headers, private keys, npm tokens, and Stripe keys.
- **Lockfile-Only Diff Payload Governor**: Fixed payload size governor calculation when `changedCodeFiles` is empty (e.g., lockfile-only PRs), returning 0 bytes instead of falling back to full raw diff size.
- **CI OODA State Scope**: Documented that `.agent/state/ooda.json` tracks local retry state, whereas ephemeral CI runners rely on `git log` auto-repair commit history.

## [0.6.1] - 2026-07-31
### Fixed
- **Atomic Budget Lock Fix**: Fixed `reserveDailyBudget` lock fallback.
- **Budget Counting Fix**: `checkDailyBudget` now counts exclusively `budget_reserved` events, preventing double-counting with `session_dispatched`.
- **Added-Line Secret Scanner**: Secret scanner now evaluates enclaves of added diff lines (`+` prefix, ignoring `+++` headers) and separates High-Confidence secrets (Exit Code 6) from Low-Confidence/Test Keys (warnings).
- **Code Diff Payload Governor**: Calculated 75 KB payload governor size strictly on code files (`changedCodeFiles`), preventing lockfiles from triggering false positive Exit Code 5 errors.

## [0.6.0] - 2026-07-31
### Security
- **Command File Guardrail**: Added `COMMAND_DEFINING_FILES` check to `jules-self-audit.mjs`.
- **Immutable Forbidden Paths**: Enforced that `forbidden_paths` cannot be overridden by `allow_paths` in `.agent/jules.yml`.
- **Zero-Trust Base Branch Extraction**: Switched to safe `execFileSync` for `git archive` and `tar` without working-tree fallback on extraction error.
- **Enhanced Secret Redaction**: Added support for `gho_` GitHub OAuth tokens, word boundaries for Bearer tokens, generalized Google API key patterns, npm tokens, and Stripe keys.

## [0.5.2] - 2026-07-31
### Added
- Created standard `CONTRIBUTING.md`, `CHANGELOG.md`, and `SECURITY.md` files.
- Added a Node.js matrix check in GitHub Actions for broader compatibility testing.
- `.env.example` has been updated with all 19 supported configuration variables.
### Fixed
- Fixed an issue in `jules-self-audit.mjs` where `runCommand("git status")` would throw a ReferenceError by properly invoking `execSync`.
- Replaced `process.exit(1)` with `throw new Error()` in exported SDK functions so downstream consumers are not abruptly terminated.

## [0.5.0] - 2026-07-31
### Added
- Aligned project with Google Jules advanced protocol and guardrails.

## [0.3.0]
### Added
- Epistemic Bridge support: Cryptographic Handshake Token generation for Web UI synchronization.
