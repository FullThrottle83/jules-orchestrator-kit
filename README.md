<div align="center">

# jules-orchestrator-kit

### Task orchestration and automated verification harness for coding agents

[![Jules PR Audit](https://github.com/FullThrottle83/jules-orchestrator-kit/actions/workflows/jules-audit.yml/badge.svg)](https://github.com/FullThrottle83/jules-orchestrator-kit/actions/workflows/jules-audit.yml)
[![npm version](https://img.shields.io/npm/v/jules-orchestrator-kit.svg)](https://www.npmjs.com/package/jules-orchestrator-kit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20native-blue.svg)](https://nodejs.org)
[![Platform: Linux | macOS | Windows](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-blueviolet.svg)](https://nodejs.org)

**Zero-dependency safety gatekeeper, scoped sandboxing, and automated verification for coding agents.**
Runs deterministic test verification, secret scrubbing, and automated repair loops across any stack or monorepo before opening Pull Requests.

[Quickstart](#quickstart) • [Key Workflows](#key-workflows) • [Architecture](#architecture) • [Verification Profiles](#verification-profiles) • [CLI](#cli) • [Docs](docs/README.md)

<img src="docs/assets/hero-flow.svg" alt="Autonomous Orchestration Pipeline" width="100%" />

</div>

---

<a id="overview"></a>
## Overview

> **`jules-orchestrator-kit` serves as a safety gate and automated test runner for AI coding agents.**
> It drafts falsifiable task envelopes, executes verification commands in an isolated sandbox, automatically retries on test failures using captured diagnostics, and approves PRs only when 100% of tests pass cleanly.

* **Multi-Provider Dispatch:** Google Jules (hosted REST), Claude Code CLI, OpenAI Codex CLI, and Gemini CLI; `agentctl providers` reports what this machine can dispatch to. Vendor-neutral `AGENT_*`/`JULES_*` environment variables.
* **Dynamic Verification Profiles:** `verify.profile: minimal | standard | max` schedules linting, tests, builds, AST mutation testing, and stability probing per toolchain. Stack-native CI via `agentctl ci init`.
* **Autonomous OODA Repair Loop:** Captures test stdout/stderr traces, fingerprints failure patterns, and runs automated repair cycles (up to 3 turns) before requesting human intervention.
* **Fail-Closed Security:** Deny-before-Allow scope rules, high-entropy and base64 secret scrubbing, semantic test-tamper detection (weakened/removed/vacuous assertions, dead-guard conditions), binary & symlink payload inspection, and a strict 75 KB diff governor.
* **Zero Runtime Dependencies:** Native Node.js 20+ standard modules only. Cross-platform parity verified on Linux, macOS, and Windows (Node 20, 22, 24).
* **Mechanically Verified:** Comprehensive test suite of **1530 unit tests across 204 suites**, with 59 activation-coverage canaries and 100% pass rate.

Any-repository configuration (monorepo scoping, 26+ ecosystem stack detection, provider selection, CI generation) is derived from your manifests — see the [Configuration Reference](docs/configuration.md).

---

<a id="quickstart"></a>
## Quickstart

Configure any repository in three steps. `init` inspects project manifests, detects the stack, probes the test runner, and scaffolds repository guardrails:

```bash
# 1. Scaffold configuration, AGENTS.md, role prompts, and guardrails
#    Auto-detects Python, Rust, Go, Bun, Deno, Node, PHP, .NET, etc.
#    Omit --yes to select provider, plan tier, and verification profile interactively.
npx jules-orchestrator-kit init --yes
```

```bash
# 2. Commit the scaffolded configuration
#    .agent/config.yml is protected by scope guards; committing establishes the trusted base policy.
git add .agent AGENTS.md SPEC.md CONSTRAINTS.md .gitignore && git commit -m "chore: add agent config"
```

```bash
# 3. Author a scoped, verified task envelope
#    Interactive by default. Pass --prompt and --verify to define requirements directly:
npx jules-orchestrator-kit task create -p "Refactor invoice calculation" --verify "npm test"
```

```bash
# Which agents can this machine dispatch to, and what is missing for the rest?
npx jules-orchestrator-kit providers

# How hard should the gate verify agent work? (minimal | standard | max)
npx jules-orchestrator-kit profile --set max
```

> [!TIP]
> Running `agentctl` without arguments inspects the local repository state (git status, active API keys, queued tasks) and prints the immediate next action. Install globally (`npm install -g jules-orchestrator-kit`) for direct `agentctl` access.

---

<a id="key-workflows"></a>
## Key Workflows

| Persona / Team | Primary Value | Everyday Commands |
| :--- | :--- | :--- |
| **Solo Developers** | Safely experiment with autonomous coding without risking broken branches, leaked API keys, or ruined git history. | `agentctl init`<br/>`agentctl task create` |
| **Repo Maintainers** | Automate bug fixes, dependency bumps, and PR reviews with self-healing test loops. | `agentctl gate`<br/>`agentctl queue` |
| **Monorepo Teams** | Isolate subproject verification (`backend/`, `frontend/`, `cli/`) so agent edits never thrash global test suites. | `agentctl swarm`<br/>`agentctl lock` |
| **Platform & Security** | Enforce fail-closed security policies, pre-commit secret scrubbing (including base64), and strict 75 KB diff limits. | `agentctl doctor`<br/>`agentctl dashboard` |

### Triage: When to Dispatch Tasks

**Ideal tasks (high merge rate):** scoped bug fixes and code changes verifiable by unit tests (`pytest`, `npm test`, `cargo test`, `dotnet test`, `go test`) · type & linter migrations · dependency bumps and CVE patches · backend refactoring · headless E2E/Playwright-verified UI changes.

**Out of scope (keep human-in-the-loop):** unverifiable visual UI tweaks without automated regression tests · closed proprietary platforms without a CLI or git integration · unmocked live cloud systems · protected infrastructure files (`.github/workflows/`, deployment keys, agent gate rules — blocked fail-closed by the Agent Scope Guard).

Task envelope recipes: [EXAMPLES.md](EXAMPLES.md).

---

<a id="architecture"></a>
## Architecture

Two decoupled pipelines — **Dispatch** (`task create` → `queue`/`dispatch`, routed and hydrated per provider) and **Verification** (`agentctl gate [--fix]`, four audit phases plus the OODA repair loop) — communicate through the repository and the telemetry ledger.

<p align="center">
  <img src="docs/assets/architecture-layers.svg" alt="Control Plane Architecture Layers" width="100%" />
</p>

Full sequence diagrams (verification & repair loop, monorepo boundary resolver, swarm topology, silence governor, flaky-healing swarm): [docs/architecture.md](docs/architecture.md).

---

<a id="verification-profiles"></a>
## Verification Profiles

| Profile | Stages | Recommended Use |
| :--- | :--- | :--- |
| `minimal` | Setup → Tests | Large/slow test suites or initial project onboarding. |
| `standard` | Setup → Lint → Tests → Build → Diff Anti-Tamper | Default gate for routine pull requests. |
| `max` | All stages above → AST Mutation Scoring → V8 Diff Coverage *(Node)* → 3-Pass Flakiness Probe | High-risk refactors or critical infrastructure changes. |

Profiles evaluate gates dynamically per runtime: unsupported platform checks (such as V8 coverage on Cargo or Go projects) are bypassed with explicit diagnostic logs rather than failing the gate.

All security, integrity, and test gates run locally without network access or API keys (`agentctl check`, `gate`, `mutate`, `coverage`, `probe`, `evidence`, `doctor`). Agent providers are required only for dispatching autonomous tasks.

---

<a id="cli"></a>
## CLI

`agentctl` is the unified CLI, available via `npx jules-orchestrator-kit <command>` or `agentctl <command>`. Core commands:

| Command | Description |
| :--- | :--- |
| `init` | Onboarding wizard & stack detector; scaffolds `.agent/config.yml`, `AGENTS.md`, role prompts, and guardrails. |
| `task create` / `task template` | Author falsifiable task envelopes, or synthesize pre-calibrated ones (Web, Hardening, Universal, Deep Think). |
| `dispatch` / `queue` / `swarm` | Send tasks to the active provider, run queued envelopes with DAG resolution, or run parallel worker slots. |
| `check` / `gate` | Security, secret, scope, payload, and tiered verification gates with `--fix` OODA repair. |
| `mutate` / `coverage` / `probe` / `perf` | Diff mutation scoring, V8 diff coverage, flakiness probing, event-loop lag. |
| `providers` / `provider set` / `profile` / `ci init` | Provider readiness, switching, verification depth, stack-native CI generation. |
| `doctor` / `evidence` / `flaky` / `rollback` | Diagnostics, SHA-256 evidence manifests, flaky quarantine management, checkpoint restore. |
| `dashboard` | `agentctl dashboard [port] [--port <n>]` — zero-dependency local telemetry & audit visualizer (default port 4100; valid range 1024–65535). |
| `mcp` / `mcp init` | stdio Model Context Protocol server for Claude, Cursor, and Antigravity, plus 1-click client config. |

The exhaustive per-command flag reference is generated from the same registry that powers `--help`: [docs/COMMAND_REFERENCE.md](docs/COMMAND_REFERENCE.md). Exit codes `0`–`8` are standardized — see the registry in [AGENTS.md](AGENTS.md#6-exit-code-registry--remediation-matrix).

---

## 🧹 Complete Uninstall / Removing the Kit (Undo Init)

Note that `agentctl clean` performs operational maintenance (clearing ephemeral locks, temporary worktrees, and evidence caches), not an uninstaller. To completely undo `init`:

```bash
# Remove tracked orchestrator assets (skips any files that were not scaffolded)
git rm -rf --ignore-unmatch \
  .agent \
  AGENTS.md \
  SPEC.md \
  CONSTRAINTS.md \
  DESIGN.md \
  .github/workflows/agent-gate.yml \
  .gitlab-ci.agent-gate.yml \
  .cursor/rules/jules.mdc

# Remove untracked runtime directories and temporary caches
rm -rf .agent .agentctl

# Revert the appended runtime-state block in .gitignore, then optionally:
npm uninstall -g jules-orchestrator-kit
```

Full inventory of generated assets and runtime state: [docs/uninstall.md](docs/uninstall.md).

---

## 📖 Documentation

Start at the **[docs sitemap](docs/README.md)** — it maps "I want to …" workflows to the right page: [Configuration Reference](docs/configuration.md) · [CLI Command Reference](docs/COMMAND_REFERENCE.md) · [Architecture & Pipeline Flow](docs/architecture.md) · [SDK & MCP Integrations](docs/sdk.md) · [Examples & Task Envelopes](EXAMPLES.md) · [Changelog](CHANGELOG.md) · [Roadmap](ROADMAP_V1.md) · [Security Policy](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Contributors & Provenance](CONTRIBUTORS.md) · [Google Jules Official Documentation](https://jules.google).

---

## 🤝 Contributions & Provenance

`jules-orchestrator-kit` is a **human-led, agent-assisted** open-source project. It is maintained by **Jonas Pudas** ([`FullThrottle83`](https://github.com/FullThrottle83)) and developed with supervised autonomous coding agents — **`jules-agent`** (Google Jules) and **Arena Agent** — which author code inside the task-envelope and verification framework defined in `AGENTS.md`. In the `git log` (2026-07-26 → 2026-09-09, 448 commits) the majority of commits (~80%) are authored by autonomous agents and ~18% by the human maintainers. Every commit is CI-verified and merged under maintainer oversight, and agent authorship is preserved transparently in git `Author`/`Co-authored-by` metadata — it is never hidden or rewritten. See [`CONTRIBUTORS.md`](CONTRIBUTORS.md) for the full provenance ledger and [`CONTRIBUTING.md`](CONTRIBUTING.md) for contribution rules.

---

## ⚖️ Disclaimer

`jules-orchestrator-kit` is an independent, community-driven open-source project and is not affiliated with, endorsed by, or sponsored by Google, Google LLC, or Alphabet Inc. "Google", "Google Jules", and related marks are trademarks of Google LLC.

**Prompt sanitization is not a security boundary.** `sanitizePromptVocabulary()` (`src/prompt-guard.mjs`) rewrites high-trigger operational terms in prompt prose (e.g. `kill -9` → `terminate with SIGTERM`) to reduce false-positive provider content-filter refusals; fenced code blocks and inline code spans are preserved verbatim. These substitutions can change technical meaning (SIGTERM is not equivalent to SIGKILL), do not guarantee provider acceptance, and do not replace scope checks, execution envelopes, secret redaction, or verification. Review transformed prompt text when exact operational semantics matter.

---

<div align="center">
  <p><b>jules-orchestrator-kit</b> • Zero runtime dependencies • MIT License • Universal safety and verification for autonomous coding agents.</p>
</div>
