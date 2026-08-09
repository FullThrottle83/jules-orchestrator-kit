<div align="center">

# 🚀 jules-orchestrator-kit

### Universal Autonomous AI Agent Orchestration Kernel for Google Jules

[![Jules PR Audit](https://github.com/FullThrottle83/jules-orchestrator-kit/actions/workflows/jules-audit.yml/badge.svg)](https://github.com/FullThrottle83/jules-orchestrator-kit/actions/workflows/jules-audit.yml)
[![npm version](https://img.shields.io/npm/v/jules-orchestrator-kit.svg)](https://www.npmjs.com/package/jules-orchestrator-kit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20native-blue.svg)](https://nodejs.org)
[![Polyglot Stacks](https://img.shields.io/badge/polyglot--stacks-24%2B-8A2BE2.svg)](#-universal-polyglot-support--stack-detection)

<p align="center">
  <b>The zero-dependency safety gatekeeper and self-healing engineering kernel for autonomous coding agent swarms.</b><br/>
  Transforms single-turn AI chat assistants into production-grade engineering swarms running 300+ daily sessions across any language or monorepo.
</p>

<p align="center">
  <a href="#-2-sentence-mental-model">💡 What is Kit?</a> •
  <a href="#-universal-30-second-quickstart-zero-to-verified-pr">⚡ 30s Quickstart</a> •
  <a href="#-feature-comparison-matrix">📊 Comparison Matrix</a> •
  <a href="#-system-architecture--visual-diagrams">🏛️ Architecture</a> •
  <a href="#-cli-command-reference-agentctl">🛠️ CLI Reference</a> •
  <a href="#-v027-next-gen-feature-roadmap">🗺️ Roadmap</a> •
  <a href="./docs/UNIVERSAL_POLYGLOT_ARCHITECTURE.md">📖 Polyglot Spec</a>
</p>

</div>

---

## 💡 2-Sentence Mental Model

> **Think of `jules-orchestrator-kit` as an automated Engineering Manager for AI coding agents.**  
> **It hands out clear tasks, runs your tests in an isolated sandbox, fixes broken code automatically, and only opens a Pull Request when 100% of your tests pass.**

---

## 🎯 Why `jules-orchestrator-kit`?

Autonomous coding agents can write software at 100× human speed—but unconstrained agents introduce silent regressions, leak API keys, hallucinate test assertions, and thrash shared monorepos.

`jules-orchestrator-kit` provides the missing **Safety, Orchestration, and Verification Kernel** for high-reliability AI agent deployments:
- **🔒 Zero Runtime Dependencies:** Built exclusively on Node.js 20+ built-ins (`node:fs`, `node:child_process`, `node:crypto`, `node:path`, `node:test`). Zero third-party npm packages mean zero supply-chain CVE risk.
- **🛡️ Fail-Closed Security Gatekeeper:** Unconditionally evaluates explicit Deny rules *before* Allow rules, redacts high-entropy secrets and PII from dry-runs and git diffs, and rejects PRs exceeding the 75 KB Diff Payload governor.
- **🔄 Autonomous OODA Self-Healing:** Captures test stderr/stdout, normalizes failure fingerprints, and feeds structured error contexts back into repair iterations (up to 3 automatic attempts) before human escalation.
- **🌐 Universal Polyglot Spine:** Natively auto-detects 24+ tech stacks (PHP/Laravel/WordPress, .NET/C#, Python, Go, Rust, C/C++, Flutter/Swift, Node/Deno/Bun) and transparently wraps verification suites in Docker Compose or Devcontainer sandboxes.
- **📂 Scoped Monorepo Boundary Resolver:** Statically maps changed files up directory ancestry to invoke isolated subshell test suites (`(cd backend && pytest) && (cd cli && cargo test)`), eliminating global test thrashing.
- **🚀 Zero-Test Bootstrapping (`agentctl bootstrap`):** Synthesizes deterministic syntax-check and smoke-test verification oracles for untested legacy repositories so agents always operate against a falsifiable feedback loop.
- **📈 Proven Scale & Reliability:** Empirically tested with **221 unit tests across 54 suites passing in < 1.2s**, supporting 300+ daily agent sessions per repository.

---

## 📊 Feature Comparison Matrix

| Dimension | Raw Agent Execution (No Orchestrator) | Standard CI/CD Pipelines | `jules-orchestrator-kit` (v0.26+) |
| :--- | :--- | :--- | :--- |
| **Self-Healing Loop** | ❌ None (Crashes on test error) | ❌ None (Fails build; notifies human) | ✅ **Autonomous OODA Loop** (Max 3 repair turns with error fingerprinting) |
| **Scope Isolation** | ❌ None (Can modify CI files or lockfiles) | 🟡 Post-commit branch rules only | ✅ **Fail-Closed Scope Guard** (Deny-first evaluation; blocks protected paths) |
| **Polyglot Stack Detection**| ❌ Manual prompt instructions | 🟡 Hardcoded YAML workflow steps | ✅ **Universal 24+ Stack Detector** (`src/stack-detector.mjs`) |
| **Flaky Test Quarantine** | ❌ Fails session randomly | ❌ Breaks CI pipeline randomly | ✅ **Wilson-Score Statistical Quarantine** (Oscillation ≥ 0.40 quarantined automatically) |
| **Monorepo Scoping** | ❌ Runs full global test suite | 🟡 Requires custom Nx/Turbo scripting | ✅ **Scoped Subshell Boundary Resolver** (`resolveWorkspaceBoundary`) |
| **Zero-Test Bootstrapping**| ❌ Halts without verification oracle | ❌ Fails build if no tests exist | ✅ **Instant Oracle Synthesis** (`php -l`, `compileall`, `dotnet build`, `tsc`, `smoke`) |
| **Secret Leak Prevention**| ❌ Prone to leaking tokens in diffs | 🟡 Post-push secret scanning alerts | ✅ **Pre-Dispatch & Pre-Commit Diff Scanner** (Blocks CVEs/keys before PR creation) |
| **Dependency Footprint** | ❌ Requires heavy SDKs & parsers | 🟡 Many external actions & plugins | ✅ **0 Native Dependencies** (100% Node.js 20+ ESM built-ins) |

---

## ⚡ Universal 30-Second Quickstart (Zero to Verified PR)

Get from zero to an autonomously verified GitHub Pull Request across any software ecosystem in 30 seconds.

### 1️⃣ Node.js / TypeScript (npm, pnpm, yarn, bun, deno)
```bash
# Dispatch a scoped task; auto-detects package.json / tsconfig.json and runs type-checked tests
npx jules-orchestrator-kit dispatch --title "Add rate limiting to API router" \
  --prompt "Implement IP-based token-bucket rate limiting in src/router.ts with unit tests."
```

### 2️⃣ Python / FastAPI / Django (pytest, pyproject.toml)
```bash
# Bootstrap zero-test or legacy Python repo, then dispatch task
npx jules-orchestrator-kit bootstrap --force
npx jules-orchestrator-kit dispatch --title "Add OAuth2 JWT validation" \
  --prompt "Add JWT bearer authentication middleware to backend/api/auth.py and verify via pytest."
```

### 3️⃣ PHP / Laravel / WordPress (Docker Compose + PHPUnit/Pest)
```bash
# Auto-detects docker-compose.yml and wraps test commands in `docker compose exec -T app ...`
npx jules-orchestrator-kit dispatch --title "Upgrade PHP 8.3 type annotations" \
  --prompt "Add strict type hints to all repository classes in app/Repositories/."
```

### 4️⃣ .NET / C# Enterprise (*.sln, *.csproj)
```bash
# Auto-detects .sln / .csproj and runs `dotnet test --no-restore --nologo`
npx jules-orchestrator-kit dispatch --title "Implement OrderService caching" \
  --prompt "Add IMemoryCache caching to OrderService.cs with xUnit coverage."
```

### 5️⃣ Polyglot Monorepo (FastAPI + React + Rust CLI)
```bash
# Run a parallel worktree swarm; changed files automatically route to scoped subproject tests
npx jules-orchestrator-kit swarm
```

---

## 🏛️ System Architecture & Visual Diagrams

### 1. The Autonomous OODA Verification Loop
Every task dispatched to `jules-orchestrator-kit` executes within an immutable, fail-closed verification loop:

```
+---------------------------------------------------------------------------------------------------+
|                           AUTONOMOUS OODA SELF-HEALING ENGINE (v0.26+)                            |
|                                                                                                   |
|  [Task Envelope] --> (1. Validate Scope & Base Freshness)                                         |
|                             |                                                                     |
|                             v                                                                     |
|                      (2. Create Isolated Git Worktree / VFS Lock)                                 |
|                             |                                                                     |
|                             v                                                                     |
|                      (3. Dispatch AI Task to Google Jules / LLM)                                  |
|                             |                                                                     |
|                             v                                                                     |
|                      (4. Execute Scoped Verification Gate)                                        |
|                          -- detectPolyglotStack().testCmd                                         |
|                          -- Docker Compose / Devcontainer wrapper                                 |
|                             |                                                                     |
|                   +---------+---------+                                                           |
|                   | PASS              | FAIL                                                      |
|                   v                   v                                                           |
|         (5. Security Audit)   (6. Fingerprint Stderr / Flaky Verdict)                             |
|           - Redact Secrets        |                                                               |
|           - Check Diff < 75KB     +---> Is test QUARANTINED? (Oscillation >= 0.40)                |
|                   |                     |                         |                               |
|                   v                    YES                        NO                              |
|         (7. Rebase & PR)                |                         |                               |
|           - git rebase main             v                         v                               |
|           - gh pr create      [Log Quarantined Flake]   [Attempt OODA Repair Turn]                |
|                               (Exit Code 8)             (Max 3 Retries; Exit 4 on Exhaust)        |
+---------------------------------------------------------------------------------------------------+
```

### 2. Polyglot Monorepo Scoped Execution Engine
In monorepos containing multiple languages, `resolveWorkspaceBoundary(changedFiles)` traverses directory ancestry to isolate verification to affected subprojects:

```
+---------------------------------------------------------------------------------------------------+
|                        MONOREPO BOUNDARY RESOLVER (resolveWorkspaceBoundary)                      |
|                                                                                                   |
|  changedFiles: ["backend/api/main.py", "cli/src/main.rs", "docs/README.md"]                      |
|         |                                                                                         |
|         +---> 1. Check Root Shared Triggers (openapi.yaml, docker-compose.yml, Makefile)          |
|         |        -> None changed. Continue subproject isolation.                                  |
|         |                                                                                         |
|         +---> 2. Map Files to Subproject Roots by Trigger File Traversal:                         |
|         |        - "backend/api/main.py" -> backend/pyproject.toml (Python Stack)                 |
|         |        - "cli/src/main.rs"     -> cli/Cargo.toml (Rust/Cargo Stack)                     |
|         |        - "docs/README.md"      -> (Documentation; R0 Cosmetic Risk)                     |
|         |                                                                                         |
|         +---> 3. Synthesize Scoped POSIX Subshell Verification Plan:                              |
|                  testCmd:  "(cd backend && pytest) && (cd cli && cargo test --workspace)"         |
|                  buildCmd: "(cd cli && cargo build)"                                              |
|                                                                                                   |
|  Result: 100% test isolation, 0 global test thrashing, 0 git index lock collisions.               |
+---------------------------------------------------------------------------------------------------+
```

---

## 🛠️ CLI Command Reference (`agentctl`)

`agentctl` is the unified command-line interface for `jules-orchestrator-kit`, available via `bin/agentctl.mjs` or `npx jules-orchestrator-kit <command>`.

| Command | Usage | Description | Exit Codes |
| :--- | :--- | :--- | :--- |
| `dispatch` | `agentctl dispatch --title <t> --prompt <p>` | Dispatches a single task to an AI agent in an isolated worktree. | `0` (Success), `1` (Arg error), `2` (429 Rate limit), `3` (Scope deny), `4` (OODA exhausted), `5` (Diff > 75KB), `6` (Secret leak) |
| `gate` / `audit`| `agentctl gate --base main --json` | Runs security, secret scanning, and verification gate against current branch. | `0` (Approved), `3` (Scope violation), `5` (Diff limit), `6` (Secret leak) |
| `bootstrap` | `agentctl bootstrap [--force] [--json]` | Inspects an untested repository and synthesizes `.agent/config.yml` with a zero-test verification oracle (`php -l`, `compileall`, `dotnet build`, `tsc`, `smoke`). | `0` (Bootstrapped / Existing) |
| `review-repair`| `agentctl review-repair <pr-comments.json>`| Parses GitHub PR review comments and synthesizes actionable OODA repair tasks. | `0` (Parsed), `1` (Missing file) |
| `queue` | `agentctl queue` | Consumes and executes pending markdown task envelopes in `.agent/queue/`. | `0` (Complete) |
| `swarm` | `agentctl swarm` | Runs parallel multi-agent swarm across queued tasks with token-bucket concurrency. | `0` (Complete) |
| `doctor` | `agentctl doctor` | Diagnostic inspect: displays detected stack, container wrapper, test command, and daily session budget. | `0` (Healthy) |
| `lock` | `agentctl lock <acquire\|release\|status>`| Manages VFS mutex locks for multi-agent non-overlapping file ownership. | `0` (Locked/Released), `1` (Conflict) |
| `clean` | `agentctl clean` | Prunes stale git worktrees, lockfiles, and temporary ledgers. | `0` (Clean) |
| `init` | `agentctl init` | Scaffolds `.agent/` directory structure and default `.agent/config.yml`. | `0` (Created) |
| `mcp` | `agentctl mcp` | Starts stdio Model Context Protocol (MCP) server for tool integration. | `0` / Stdio stream |
| `version` | `agentctl version` | Outputs orchestrator kit semantic version (`v0.26.0`). | `0` |

---

## 🌐 Universal Polyglot Support & Stack Detection

The table below illustrates the 24+ software ecosystems natively supported by `src/stack-detector.mjs`:

```
Ecosystems Supported:
├── PHP / Laravel / WordPress (composer.json, phpunit.xml, pest.php, artisan, wp-cli.yml)
├── .NET / C# / F# (*.sln, *.csproj, *.fsproj, global.json)
├── Mobile / Dart / Flutter (pubspec.yaml)
├── Mobile / Swift / Xcode (Package.swift)
├── Mobile / React Native (app.json, react-native.config.js)
├── Systems / CMake (CMakeLists.txt)
├── Systems / Rust Cargo (Cargo.toml)
├── Systems / Go (go.mod)
├── Systems / Make (Makefile)
├── Python / FastAPI / Django (pyproject.toml, requirements.txt, setup.py)
├── Elixir / Phoenix (mix.exs)
├── Ruby / Rails (Gemfile)
├── Java / Maven (pom.xml)
├── Java / Gradle (build.gradle, build.gradle.kts)
├── JS / TS Workspaces (turbo.json, pnpm-workspace.yaml, nx.json)
├── JS / TS Runtimes (bunfig.toml, deno.json, package.json)
└── Devcontainers & Docker Compose (.devcontainer/devcontainer.json, docker-compose.yml, Dockerfile)
```

---

## 🗺️ v0.27+ Next-Gen Feature Roadmap

| Feature | Module / Command | Architectural Blueprint | Target Release |
| :--- | :--- | :--- | :---: |
| **PR Review Auto-Remediation Loop** | `agentctl review-repair` (`src/review-repair.mjs`) | Ingests GitHub PR review comments (`CHANGES_REQUESTED`), extracts line/file context, and dispatches automated OODA repair turns until reviewer comments are resolved. | **v0.27.0** *(Implemented prototype)* |
| **Multi-Provider Failover Router** | `createFailoverProvider` (`src/provider.mjs`) | Ordered router (`["jules", "claude-code", "local-mcp"]`) that seamlessly falls back to secondary LLMs on HTTP 429 rate limits or 5xx service unavailability. | **v0.27.0** *(Implemented prototype)* |
| **Telemetry & Audit Web Dashboard**| `agentctl dashboard` (`src/dashboard.mjs`) | Zero-dependency local HTTP server displaying real-time DAG execution graphs, Wilson-Score flaky test ledgers, and SHA-256 telemetry chains. | **v0.27.0** |
| **Cross-Language Contract Guard** | `hashCrossLanguageInterface` (`src/merge-blocks.mjs`)| Canonical SHA-256 schema hashing for OpenAPI/Protobuf specs across polyglot task dependencies in `DagExecutor`. | **v0.26.0** *(Shipped)* |

---

## 📖 Recipes, Documentation & Prior Art

- [**Universal Polyglot Architecture & Zero-Test Specification**](./docs/UNIVERSAL_POLYGLOT_ARCHITECTURE.md) — Comprehensive technical report on boundary resolution, OODA math, and B2B workflows.
- [**Examples & Task Envelope Recipes**](./EXAMPLES.md) — Production YAML and Markdown task envelopes.
- [**Adversarial Security Audit Phase 4 Report**](./docs/AUDIT_REPORT.md) — CWE-77, CWE-1321, and CWE-183 security hardening analysis.
- [**Changelog**](./CHANGELOG.md) — Full release history and migration guides.

---

<div align="center">
  <p><b>jules-orchestrator-kit</b> • Built with zero external dependencies for Google Jules and enterprise AI agent swarms.</p>
</div>
