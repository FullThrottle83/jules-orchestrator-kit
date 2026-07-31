# Contributing to Jules Orchestrator Kit

First off, thank you for considering contributing to the Jules Orchestrator Kit! It's people like you that make this tool better for everyone.

## Core Principles

1. **Zero Runtime Dependencies**: We strive to keep this kit as lightweight and secure as possible. Use ONLY native Node.js built-in modules (`node:fs`, `node:path`, `node:child_process`, `node:crypto`, `node:util`).
2. **Verification Suite**: Ensure 100% of unit tests pass cleanly before submitting a Pull Request (`npm test`).
3. **Cross-Platform Compatibility**: Always normalize Windows backslashes (`\`) to POSIX slashes (`/`) for glob patterns and paths.
4. **Conventional Commits**: Please use standardized prefixes for your commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).

## How to Contribute

1. Fork the repository and create your feature branch (`git checkout -b feature/amazing-feature`).
2. Make your changes and ensure they adhere to the core principles above.
3. Test your changes thoroughly. If you're modifying core dispatch or audit logic, run the pre-flight sandbox check: `node scripts/jules-self-audit.mjs --preflight`.
4. Commit your changes (`git commit -m 'feat: add some amazing feature'`).
5. Push to the branch (`git push origin feature/amazing-feature`).
6. Open a Pull Request.

## Pull Request Guidelines

- Ensure your PR description clearly describes the problem and solution.
- Link any relevant issues.
- Be prepared to discuss your changes and iterate if requested by reviewers.

## Reporting Bugs

If you find a bug, please open an issue with a clear description, reproduction steps, and expected behavior.
