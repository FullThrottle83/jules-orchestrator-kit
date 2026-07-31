# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
