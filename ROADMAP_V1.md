# 🗺️ Jules Orchestrator Kit — Roadmap to v1.0 & Beyond

The **jules-orchestrator-kit** is the zero-dependency safety gatekeeper and self-healing engineering kernel for autonomous coding agents running on **Google Jules**.

> [!IMPORTANT]
> **Zero Runtime Dependencies is a strict core invariant.**  
> Every feature on this roadmap is built strictly with native Node.js 20+ built-in modules (`node:fs`, `node:child_process`, `node:crypto`, `node:http`, `node:readline`, `node:test`).

---

## 📌 Release Milestones Overview

```
 v0.32.3 (Current Stable) ──► v0.33.0 ──► v1.0.0 (Production Kernel)
 (Web, UX & Bridge)        (Monorepos) (Enterprise Hardened)
```

---

## ✅ Shipped Foundation (v0.20.0 – v0.30.0)

- [x] **Zero-Dependency Stdio MCP Server** (`src/mcp.mjs`, `bin/mcp-server.mjs`) — Standard MCP tool integration.
- [x] **L9 Kernel Hardening** (`src/state.mjs`, `src/journal.mjs`) — VFS directory mutex, PID recycling protection, atomic budget ledger.
- [x] **Universal Polyglot Stack Detector** (`src/stack-detector.mjs`) — 24+ ecosystems auto-detected (.NET, Rust, Go, Python, PHP, Java, JS/TS, Flutter).
- [x] **Scoped Monorepo Boundary Resolver** (`resolveWorkspaceBoundary`) — Isolated subshell test execution.
- [x] **Zero-Test Bootstrapping** (`agentctl bootstrap`) — Instant verification oracle synthesis (`php -l`, `compileall`, `dotnet build`).
- [x] **Statistical Flaky Test Quarantine** (`src/flaky-ledger.mjs`) — Wilson-score oscillation tracking (Exit Code 8).
- [x] **Task DAG Engine** (`src/dag-engine.mjs`) — Kahn's topological sort, interface SHA-256 fingerprinting, cycle detection.
- [x] **Fail-Closed Security Gatekeeper** (`src/security.mjs`, `src/prompt-guard.mjs`) — Nonced prompt fences, secret scanning, 75 KB diff governor.
- [x] **PR Review Auto-Remediation** (`src/review-repair.mjs`) — Ingests `CHANGES_REQUESTED` comments into OODA repair loops.
- [x] **Interactive TUI & Command Palette** (`src/ux/`, `src/ops/`) — Full-screen raw terminal engine, diagnostic check DAG (`agentctl doctor`), and queue/swarm managers.

---

## 🎯 Target Milestone v0.31.0: Developer Onboarding & Prompt Intelligence
*Focus: Eliminating beginner friction, preventing hallucinations, and making task authoring foolproof.*

- [ ] **Prompt Falsifiability & Scope Linter (`agentctl task optimize`)**:
  - Pre-dispatch heuristic analyzer scoring task prompts for objective testability.
  - Automatically identifies referenced file paths and warns if target files do not exist.
  - Generates recommended verification predicates if none are supplied.
- [ ] **Zero-Token Sandbox Playground (`agentctl simulate`)**:
  - Dry-run simulator that validates scope boundaries, secret scanning, and payload governors against mock changes without calling the Google Jules API.
- [ ] **Interactive 60-Second Demo Walkthrough (`agentctl tour`)**:
  - Self-contained CLI guided tour creating an in-memory fixture, executing an OODA self-repair turn, and demonstrating gate verification.
- [ ] **1-Click Atomic Git Checkpoint & Rollback (`agentctl rollback`)**:
  - Epistemic git checkpointing before task execution, enabling instant 1-command rollback of agent modifications.

---

## 🎯 Target Milestone v0.32.0: Real-Time Human-in-the-Loop & IDE Ecosystem
*Focus: Seamless workflow integration across editors, chat platforms, and CI/CD pipelines.*

- [ ] **Human-in-the-Loop Asynchronous Escalation Bridge (`agentctl escalate`)**:
  - Webhook dispatch to Slack, Discord, and GitHub PR comments when Jules enters `AWAITING_USER_FEEDBACK` or fails R3 gates.
  - Lightweight zero-dependency async webhook listener to resume sessions with user answers.
- [ ] **Multi-Turn Session Resumption via Google Jules v1alpha API**:
  - Leverage `sessions.sendMessage` / `sessions.resume` to feed OODA repair prompts into active sessions rather than creating disconnected session instances.
- [ ] **IDE Native Tooling Recipes (VS Code, Cursor, JetBrains)**:
  - Plug-and-play configuration recipes for editor extensions to invoke `agentctl mcp` over stdio.
  - Right-click task authoring from code selections and inline OODA failure diagnostics.
- [ ] **Zero-Dependency Web Studio Enhancements (`agentctl studio`)**:
  - Live log streaming via Server-Sent Events (SSE) in `src/dashboard.mjs`.
  - Visual DAG workflow dependency viewer and interactive side-by-side git diff inspector.

---

## 🎯 Target Milestone v0.33.0: Monorepo Swarms, Dynamic Routing & Code Intelligence
*Focus: Multi-agent coordination, cost optimization, and monorepo architectural integrity.*

- [ ] **Monorepo Architecture & Cross-Package Import Guard**:
  - Extend `resolveWorkspaceBoundary` to detect illegal cross-package imports and circular dependencies in TypeScript, Go, and Rust monorepos before running CI.
- [ ] **Dynamic Complexity & Cost Router**:
  - Heuristic classifier that routes trivial tasks (typos, linter fixes, lockfile bumps) to fast/local providers while reserving Google Jules for complex multi-file refactors.
- [ ] **Test-Driven Agent Generation Harness (`agentctl test-gen`)**:
  - Automatically synthesizes a failing unit test or Playwright snapshot from a bug description to establish a strict TDD verification gate for Jules.
- [ ] **Automated Flaky Test Healing Swarm**:
  - Background worker that consumes Wilson-quarantined tests (Exit Code 8) and dispatches specialized anti-flakiness prompt templates to repair timing and race conditions.

---

## 🏁 Target Milestone v1.0.0: The Production-Grade Autonomous Engineering Kernel
*Focus: Long-term API stability, cryptographic compliance, and enterprise deployment guarantees.*

- [ ] **Cryptographic Compliance & SOC2 Audit Exporter (`agentctl audit export`)**:
  - Export tamper-evident, signed JSON-LD / SPDX receipts of all agent activities linked to the SHA-256 telemetry ledger.
- [ ] **Zero-Dependency Core Freezing & Stability Guarantee**:
  - 100% API stability for `index.mjs` SDK exports, CLI exit codes (0–8), and configuration schema (`.agent/config.yml`).
- [ ] **High-Concurrency Swarm Benchmarking (500+ Daily Sessions)**:
  - Stress testing with 50+ concurrent worker slots across 100k+ file repositories with zero lock contention or memory leaks.
- [ ] **Comprehensive Multi-Language Enterprise Test Matrix**:
  - Automated CI test fixtures for polyglot environments (Node, Python, Go, Rust, .NET, PHP, Java, Flutter).

---

## 🔮 Post-1.0 Long-Term Horizon (v1.x+)

- **Cross-Repository Swarm Orchestration**: Orchestrate breaking API contract changes across multiple distinct git repositories with atomic synchronization.
- **Multimodal Visual Verification Loop**: Direct integration with headless browser video/screenshot streams for autonomous visual regression repairs.
- **Wasm-Powered Structural AST Invariant Engine**: In-memory WebAssembly tree-sitter bindings (zero npm dependencies) for deep multi-language semantic AST verification.
