# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
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
