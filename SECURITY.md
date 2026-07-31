# Security Policy

## Supported Versions

Currently, only the latest release of the Jules Orchestrator Kit is actively supported with security updates.

## Reporting a Vulnerability

Security is a top priority for this orchestration kit, as it manages AI agents with sandbox access to source code.

If you discover a security vulnerability within this project, please DO NOT open a public issue.

Instead, please send an email to the maintainers or use the GitHub Security Advisory feature to report it privately.

We will endeavor to respond to your report within 48 hours and work with you to resolve the issue as quickly as possible.

## Core Security Assumptions

- **The Git Sandbox**: The agent's generated code should be considered untrusted until it passes the verification suite.
- **Base Branch Authority**: All security rules (like `forbidden_paths`) MUST be sourced from `origin/main` (or the configured `BASE_BRANCH`), NEVER from the PR's working tree, as PR contents are under the agent's control.
- **No Path Traversal**: Reading files via user prompts or configuration should always be bounded to the current workspace root.
- **Zero External Dependencies**: By relying exclusively on Node.js built-ins, we eliminate the supply-chain attack vector for downstream orchestrators.
