# 🗺️ Jules Orchestrator Kit — Roadmap to v1.0 & Beyond

The **jules-orchestrator-kit** is the zero-dependency safety gatekeeper and self-healing engineering kernel for autonomous coding agents running on **Google Jules**.

> [!IMPORTANT]
> **Zero Runtime Dependencies is a strict core invariant.**  
> Every feature on this roadmap is built strictly with native Node.js 20+ built-in modules (`node:fs`, `node:child_process`, `node:crypto`, `node:http`, `node:readline`, `node:test`).

---

## 📌 Release Milestones Overview

```
 v0.52.8 (Current Stable) ──► v0.60.0 (Distributed Swarms & Leases) ──► v1.0.0 (Production Hardened Kernel)
 (Session Ops & MCP Suite)   (Multi-Agent DAG & Resource Locks)        (Enterprise Telemetry & SLA)
```

---

## ✅ Shipped Milestones (v0.20.0 – v0.52.8)


### v0.52.x: Entropy Hardening, Egress Auditing & CI Defense
- [x] **Binary Asset Classification Guard (`src/security.mjs`)** — Restricts binary asset skipping to tokens $\ge 256$ chars, preventing length $\pmod 4 = 0$ keys from bypassing entropy checks.
- [x] **CI Runtime & Egress Security (`.github/workflows/*.yml`)** — Linux eBPF runtime monitoring and network egress auditing via StepSecurity.
- [x] **GitHub Actions Supply Chain Hardening (`.github/`)** — Action SHA pinning, least-privilege `contents: read`, and automated Zizmor CI gate.
- [x] **Assertion Removal & Anti-Tamper Guard (`src/security.mjs`)** — Detects test deletion bypass (`ASSERTION_REMOVAL`) and vacuous assertion weakening.
- [x] **Shannon Entropy Diff Scanner (`src/security.mjs`)** — High-entropy token detection (>4.5 entropy, $\ge 24$ chars) on added diff lines.
- [x] **Jules API Patch Ingestion & Edge Webhooks (`src/session-ops.mjs`, `src/webhook.mjs`)** — API changeset extraction and Webhook `Uint8Array` Edge runtime parity.
- [x] **Zero-Test Oracle Bootstrapping & Git Remote Origin Auto-Detection (`src/stack-detector.mjs`, `src/git.mjs`)** — Auto-configuration for virgin repositories.

### v0.51.0: Mechanical Falsification, AST Mutation & V8 Coverage
- [x] **Diff-Hunk Mutation Testing Engine (`src/mutation.mjs`, `agentctl mutate`)** — Transactional operator inversion with automatic shadow disk rollback.
- [x] **Native V8 Diff Coverage Enforcer (`src/coverage.mjs`, `agentctl coverage`)** — Zero-dependency V8 coverage mapping against added `+` hunks.
- [x] **Test-Oscillation Cycle Detector (`src/remediation.mjs`, `src/engine.mjs`)** — Halts multi-test oscillation cycles in OODA repair loops.
- [x] **Flakiness Stability Prober & Event Loop Delay Guard (`src/stability.mjs`, `src/perf.mjs`)** — Multi-pass repetition probing and Big-O event loop delay monitor.

### v0.40.0 – v0.50.0: Architecture Governance & Universal Envelopes
- [x] **Universal Stack-Agnostic Task Templates (`src/web-templates.mjs`)** — Pre-calibrated templates for Cargo, Go, Python, PHP, .NET, Java, and Node.
- [x] **Specialist Agent Roles (`.agent/prompts/`)** — Eight stack-neutral specialist personas with dynamic command hydration.
- [x] **All-In-One CI Verification Gate (`agentctl check`)** — Unified security, scope, payload, and stack test gatekeeper.
- [x] **Stack-Tailored Contract Scaffolding (`src/scaffold.mjs`)** — Automatic `SPEC.md`, `CONSTRAINTS.md`, and `DESIGN.md` generation on init.

### v0.30.0 – v0.39.0: Budget Provenance, Terminal UX & Autonomous Resilience
- [x] **Rolling 24h Budget Ledger & Limit Provenance (`src/budget.mjs`, `agentctl budget`)** — Multi-user attribution, rolling window accounting, and graceful estimate warnings.
- [x] **Terminal UI Engine (`src/tui.mjs`, `src/key-decoder.mjs`)** — Zero-dependency interactive selection, multi-select, secret masking, and raw keyboard decoding.
- [x] **Multi-OS CI Matrix Parity** — 100% green suite across Linux, macOS Darwin, and Windows CMD/PowerShell on Node 20, 22, and 24.
- [x] **Atomic Git Checkpoint & Rollback (`src/ops/checkpoint.mjs`, `agentctl rollback`)** — Pre-flight working tree snapshots and 1-command git restore.
- [x] **Documentation Sync Gate (`scripts/doc-sync-check.mjs`, `npm run jules:doc-sync`)** — Mechanical enforcement preventing documentation drift across manifests, roadmaps, and tests.

---

## 🎯 Target Milestones (v0.60.0 & v1.0.0)

### v0.60.0: Distributed File Leases & Preemptive DAG Scheduling
- [ ] **Atomic Filesystem Lease & Heartbeat Protocol (`src/engine.mjs`, `src/flaky-ledger.mjs`)** — Directory-mutex file leasing with heartbeat timestamps, stale-lock detection via PID liveness inspection, and tombstone rotation without third-party daemons or Redis.
- [ ] **Preemptive Task Cancellation & Interface Fingerprints (`src/dag-engine.mjs`)** — Automatically aborts and yields downstream swarm tasks when upstream exported symbol interfaces diverge from their cryptographic SHA-256 fingerprints.
- [ ] **POSIX/Win32 Process Group Guillotine (`src/engine.mjs`)** — Tree teardown via `process.kill(-pid, 'SIGKILL')` on POSIX and `taskkill /T /F /PID` on Windows to eliminate orphaned dev-servers and background watchers.
- [ ] **Unicode Trojan Source & Homoglyph Fencing (`src/security.mjs`)** — Deterministic token scanner using V8 Unicode Property Escapes (`\p{Script=...}`) and NFKC normalization to block invisible Bidi overrides (CVE-2021-42574) and mixed-script homoglyphs.

---

## 🏁 Target Milestone v1.0.0: The Production-Grade Autonomous Engineering Kernel
*Focus: Long-term API stability, cryptographic compliance, and enterprise deployment guarantees.*

- [ ] **Cryptographic Compliance & SOC2 Audit Exporter (`agentctl audit export`)**:
  - Export tamper-evident, signed JSON-LD / SPDX receipts of all agent activities linked to the SHA-256 telemetry ledger.
  - *Foundation shipped:* `agentctl evidence generate|verify|show` (`src/evidence.mjs`) already produces SHA-256 evidence manifests with test-tamper locking.
- [ ] **Zero-Dependency Core Freezing & Stability Guarantee**:
  - 100% API stability for `index.mjs` SDK exports, CLI exit codes (0–8), and configuration schema (`.agent/config.yml`).
- [ ] **High-Concurrency Swarm Benchmarking (500+ Daily Sessions)**:
  - Stress testing with 50+ concurrent worker slots across 100k+ file repositories with zero lock contention or memory leaks.
- [ ] **Comprehensive Multi-Language Enterprise Test Matrix**:
  - Automated CI test fixtures for polyglot environments (Node, Python, Go, Rust, .NET, PHP, Java, Flutter).
- [ ] **OODA Attempt Diff Retention & Inspection (`.agent/state/ooda/*.patch`, `agentctl patch --attempt <n>`)**:
  - Retains intermediate working tree diffs and failure traces across OODA repair turns so developers can inspect failed hypotheses when an agent exhausts its retry budget.

---

## 🔮 Post-1.0 Long-Term Horizon (v1.x+)

- **Proactive Telemetry Ingestion (Type III Situational Awareness)**: Ingest dev-server crash logs, APM traces, and Playwright test artifacts into auto-synthesized task envelopes for background diagnosis.
- **Cross-Repository Swarm Orchestration**: Orchestrate breaking API contract changes across multiple distinct git repositories with atomic synchronization.
- **Multimodal Visual Verification Loop**: Direct integration with headless browser video/screenshot streams for autonomous visual regression repairs.
- **Wasm-Powered Structural AST Invariant Engine**: In-memory WebAssembly tree-sitter bindings (zero npm dependencies) for deep multi-language semantic AST verification.
