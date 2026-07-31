# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
