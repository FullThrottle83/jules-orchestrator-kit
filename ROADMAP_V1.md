# 🗺️ Jules Orchestrator Kit — Roadmap to v1.0 & Beyond

The **jules-orchestrator-kit** is the zero-dependency safety gatekeeper and self-healing engineering kernel for autonomous coding agents running on **Google Jules**.

> [!IMPORTANT]
> **Zero Runtime Dependencies is a strict core invariant.**  
> Every feature on this roadmap is built strictly with native Node.js 20+ built-in modules (`node:fs`, `node:child_process`, `node:crypto`, `node:http`, `node:readline`, `node:test`).

---

## 📌 Release Milestones Overview

```
 v0.32.4 (Current Stable) ──► v0.33.0 ──► v1.0.0 (Production Kernel)
 (Web, UX & Bridge)        (Monorepos) (Enterprise Hardened)
```

---

## ✅ Shipped Milestones (v0.20.0 – v0.32.4)

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

### v0.32.5 (Unreleased): DAG Task Execution, Specialist Roles & Evidence Ledger
- [x] **DAG-Ordered Queue Execution** (`src/dag-engine.mjs`, `agentctl queue --dag`) — Kahn's-algorithm dependency resolution with cycle detection and per-task timeout, replacing strict FIFO queue order for tasks declared with `--depends-on`.
- [x] **Specialist Agent Roles** (`agentctl dispatch --role`, `agentctl task create --role`) — Binds a task to a pre-defined specialist prompt persona (`overseer`, `bolt`, `sentinel`, `janitor`) resolved from `.agent/prompts/`.
- [x] **Cryptographic Evidence Manifest** (`src/evidence.mjs`, `agentctl evidence generate|verify|show`) — SHA-256 manifest of changed files and test-file hashes with tamper detection; a foundational building block toward the v1.0.0 SOC2 audit exporter below.
- [x] **Tiered Verification Stages & Offline Execution Policy** (`src/config.mjs` `verify.stages`/`verify.policy`) — Optional lint/unit/fuzz/invariant/e2e stage pipeline and network-access policy (used to enforce `--offline` for Web3/Solidity stacks).
- [x] **Web3 / Solidity Stack Detection** (`src/stack-detector.mjs`) — Foundry (`forge test/build/fmt --offline`) and Hardhat auto-detection.

### v0.32.6 (Unreleased): Dynamic Complexity & Cost Router
- [x] **Provider-Agnostic Cost Router** (`src/router.mjs`, `router:` block in `.agent/config.yml`, opt-in/disabled by default) — Zero-dependency heuristic classifier routing trivial tasks to a fast/cheap provider and complex or safety-sensitive tasks to the primary provider. See the v0.33.0 milestone entry above for full details.
- [x] **Gemini CLI Fast-Tier Preset** (`src/provider.mjs` `gemini-flash`) — Headless Gemini CLI exec preset (`gemini-3.6-flash`, `--approval-mode=yolo`) usable as `router.fast`, or swapped for any other provider.
- [x] **`--tier fast|complex` Override** (`agentctl dispatch`, `agentctl task create`, MCP `dispatch_jules_task`) — Explicit routing override that bypasses the heuristic classifier.

---

## 🎯 Target Milestone v0.33.0: Monorepo Swarms, Dynamic Routing & Code Intelligence
*Focus: Multi-agent coordination, cost optimization, and monorepo architectural integrity.*

- [x] **Monorepo Architecture & Cross-Package Import Guard**:
  - Extend `resolveWorkspaceBoundary` to detect illegal cross-package imports and circular dependencies in TypeScript, Go, and Rust monorepos before running CI.
- [ ] **Type III Silence Governor & Interruption Budgeting**:
  - Configurable digest mode for escalation webhooks (`src/webhook.mjs`), suppressing non-critical notifications to protect developer focus until context shifts or critical manual intervention thresholds.
- [x] **Dynamic Complexity & Cost Router** (`src/router.mjs`, `router:` in `.agent/config.yml`, opt-in):
  - Zero-dependency heuristic classifier (`classifyTaskComplexity`) that routes trivial tasks (typos, linter fixes, lockfile bumps, single-file changes) to a fast/cheap provider while reserving the primary provider for complex multi-file refactors — provider-agnostic and user-configurable, not tied to any single vendor.
  - Ships with a `gemini-flash` exec preset (`src/provider.mjs`, Gemini CLI headless mode) as a batteries-included fast tier; any exec/HTTP provider spec works as `router.fast`/`router.complex`.
  - Safety-first: tasks touching `scope.deny` or sensitive paths (`auth/**`, `migrations/**`, secrets, `.github/**`), or using the `sentinel` role, always force-route to the primary provider regardless of score. FAST-tier dispatch cascades to the primary provider on rate-limit/5xx via `createFailoverProvider`.
  - `--tier fast|complex` CLI/MCP override on `dispatch`, `task create`, and `dispatch_jules_task` for explicit control.
- [ ] **Automated Flaky Test Healing Swarm**:
  - Background worker that consumes Wilson-quarantined tests (Exit Code 8) and dispatches specialized anti-flakiness prompt templates to repair timing and race conditions.

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

---

## 🔮 Post-1.0 Long-Term Horizon (v1.x+)

- **Proactive Telemetry Ingestion (Type III Situational Awareness)**: Ingest dev-server crash logs, APM traces, and Playwright test artifacts into auto-synthesized task envelopes for background diagnosis.
- **Cross-Repository Swarm Orchestration**: Orchestrate breaking API contract changes across multiple distinct git repositories with atomic synchronization.
- **Multimodal Visual Verification Loop**: Direct integration with headless browser video/screenshot streams for autonomous visual regression repairs.
- **Wasm-Powered Structural AST Invariant Engine**: In-memory WebAssembly tree-sitter bindings (zero npm dependencies) for deep multi-language semantic AST verification.
