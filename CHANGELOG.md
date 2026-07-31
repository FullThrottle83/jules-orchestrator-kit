# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.1] - 2026-07-31
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
- Respected the `Retry-After` header when HTTP 429 limits are hit.
- Restrict `redactSecrets` matching to entropy limits of length >= 20.
- Ensure `.agent/protected-paths.json` is immutable via `origin/main` loading and self-protection.
- Handled missing node_modules when testing in the preflight sandbox using `npm ci --ignore-scripts`.
- Wrapped `loadEnv()` in an `isMainModule` check to prevent unintended mutations when importing via SDK.

## [0.5.0] - 2026-07-31
### Added
- Aligned project with Google Jules advanced protocol and guardrails.

## [0.3.0]
### Added
- Epistemic Bridge support: Cryptographic Handshake Token generation for Web UI synchronization.
