# 🗺️ Jules Orchestrator Kit — Roadmap to v1.0 & Beyond

The **jules-orchestrator-kit** is the zero-dependency safety gatekeeper and self-healing engineering kernel for autonomous coding agents — **Google Jules**, **Claude Code**, **Codex** and the **Gemini CLI** — in any repository and any stack.

> [!IMPORTANT]
> **Zero Runtime Dependencies is a strict core invariant.**  
> Every feature on this roadmap is built strictly with native Node.js 20+ built-in modules (`node:fs`, `node:child_process`, `node:crypto`, `node:http`, `node:readline`, `node:test`).

---

## 📌 Release Milestones Overview

```
 v0.73.0 (Current Stable) ──► v0.74.0 (Distributed Swarms & Leases) ──► v1.0.0 (Production Hardened Kernel)
 (Security Facade & CLI)     (Multi-Agent DAG & Resource Locks)       (Enterprise Telemetry & SLA)
```

---

## ✅ Shipped Milestones (v0.66.0 – v0.73.0)

### v0.73.0: Security Facade Decomposition, Command Registry & Canonical Roles
- [x] **Modular Security Architecture (`src/security.mjs`, `src/fs-atomic.mjs`, `src/scope-guard.mjs`, `src/secret-scanner.mjs`, `src/test-tamper-guard.mjs`, `src/bidi-guard.mjs`)** — split monolithic security module into 5 focused submodules while preserving all 26 public exports and 59/59 tamper canaries.
- [x] **CLI Command Registry & Single Source of Truth (`src/ops/command-registry.mjs`, `docs/COMMAND_REFERENCE.md`)** — unified 49 CLI switch-cases with auto-generated documentation and dynamic command discovery.
- [x] **12 Canonical Specialist Roles (`.agent/prompts/`, `src/role-resolver.mjs`)** — consolidated duplicated legacy roles into 12 professional engineering roles with strictly one-directional backwards-compatible aliases.
- [x] **Audit Ledger Security Hardening (`src/budget.mjs`, `src/state.mjs`)** — eliminated fail-open bypasses on missing ledger states, relocating business logic to `src/`.
- [x] **Trojan Source BiDi Override Detection (`src/bidi-guard.mjs`, `src/security.mjs`)** — detects invisible Unicode directional control characters across diffs (CVE-2021-42574).
- [x] **Cold-Start Onboarding & Provenance (`src/git.mjs`, `src/wizard-task.mjs`, `CONTRIBUTORS.md`)** — filtered untracked package artifacts on fresh checkouts and formalized maintainer and agent attribution.

### v0.72.3: ASCII Smuggling Defense, Safety Filter Mitigations & Deep Planning Envelopes
- [x] **Unicode Tag ASCII Smuggling Defense (`src/prompt-guard.mjs`, `src/security.mjs`)** — strips and detects Plane 14 Unicode Tag characters (`U+E0000`–`U+E007F`) across untrusted inputs and secret diffs.
- [x] **Vertex AI Safety Moderation Mitigations (`src/prompt-guard.mjs`)** — clinicalizes `kill -9`, `SIGKILL`, zombie reaping, and exploit terms to prevent upstream `HARM_CATEGORY_DANGEROUS_CONTENT` aborts.
- [x] **Deep Planning Mode Steering Directive (`src/task-optimizer.mjs`, `src/web-templates.mjs`)** — injects `"Use deep planning mode."` into exploration budget task envelopes.
- [x] **Runtime Environment & Ingestion Directives (`.agent/rules/jules-protocol.md`)** — documented KVM 8 GiB swap=0 OOM limits, 20-30 GiB OverlayFS quota, `/workspace` mount, non-systemd supervisor, and startup ingestion hierarchy.

### v0.72.2: Child Process Stream Fidelity & Polyglot Build Detection
- [x] **Child Process Stream Fidelity (`src/git.mjs`)** — `runCmd()` invokes native `spawnSync`, preserving both `stdout` and `stderr` streams on exit 0 so test runners emitting summaries to stderr (`bun test`) are fully recognized by `parseCollectedTests`.
- [x] **Conditional Polyglot Build Resolution (`src/stack-detector.mjs`)** — Bun and Deno projects without declared build scripts default to `buildCmd: ""`, preventing `agentctl gate` false reds during pure script verification.
- [x] **CLI Flag Parity (`bin/agentctl.mjs`)** — `--verify` supported alongside `--verify-cmd` across `agentctl task create`, `task template`, and `task optimize`.

### v0.72.1: Staged Mode Diff Fidelity & Indentation-Aware Tamper Defense
- [x] **Staged Mode Diff Fidelity (`src/git.mjs`)** — `diffText` in staged mode queries `git diff --cached <base>`, ensuring staged additions on feature branches are visible to secret and tamper scanners.
- [x] **Universal Dead Guard Detection (`src/security.mjs`)** — extended `DEAD_GUARD_CONDITION` to recognize literal falsities (`if False:`, `if (false)`, `if 0:`).
- [x] **Indentation-Aware Block Traversal (`src/security.mjs`)** — detects dead-guard assertions and failure calls in indentation-based languages (Python) without requiring `{}` braces.
- [x] **Comprehensive Guard Call Detection (`src/security.mjs`)** — `VACUOUS_ASSERTION` now covers both failure calls and test assertions.

### v0.72.0: Cold-Start Hardened Kernel & Tamper Defense
- [x] **Canonical Root Test Guard (F01)** — `test.js` at repository root is inside the tamper guard.
- [x] **Conditional Expectation Guard (F03)** — ternary and conditional assertions cannot mask broken logic.
- [x] **De-registration & Skip Detection (F04)** — removed `#[test]`, build tags, xfail decorators, and body-first early returns are caught.
- [x] **Reachable Preconditions (F05)** — impossible guard conditions (`len < 0`) cannot neutralise assertions.
- [x] **Uncommitted Scaffold Integrity (F06)** — rejects uncommitted scaffolds that disable verification or lower profiles.
- [x] **Trusted Base Policy Resolution (F07)** — authoritative verification stages resolved from base commit (`git show <base>:.agent/config.yml`), never trusting uncommitted edits under review.
- [x] **Committed Base Branch Integrity (F08)** — rejects `--base HEAD` in committed mode.
- [x] **Empty Test Collection Canaries (F09)** — empty collections (Go `[no tests to run]`, pytest `--collect-only`, no-op scripts) recognized as 0 tests.
- [x] **Snapshot Worktree Isolation (F10)** — isolates staged index and committed revisions in ephemeral worktrees with symlinked dependencies.
- [x] **Python src-layout Invariant (F11)** — automatically injects `PYTHONPATH=src` for package layouts.
- [x] **Zero-Coverage Added Module Detection (F12)** — untracked/unexecuted new files fail coverage.
- [x] **Clean Scaffold & Oracle Tuning (F13–F15)** — markdown newline hygiene, cargo clippy without `-D warnings`, and multi-target Cargo aggregation.
- [x] **Supply Chain Diagnostics & Waiver Telemetry (F16–F20)** — lockfile tamper hints, `--strict-locks` flag, waiver auditing, and dry-run evidence suppression.
- [x] **Targeted Help & Complete Uninstall (F21–F22)** — targeted subcommand help routing and documented full removal procedure.

### v0.71.0: A Blanket Is Not A Check
- [x] **Silence Is Not A Suite (`src/ops/test-collection.mjs`, `src/wizard-init.mjs`)** — a command that claims to run tests and prints nothing ran none; a static gate that prints nothing did its job.
- [x] **Python Verified Against The Working Tree (`src/stack-detector.mjs`)** — a `src/` layout resolved its imports to site-packages, and broken code passed 49 tests.
- [x] **`UNREADABLE` Requires Its Evidence (`src/security.mjs`)** — adding an import to a test file was a CRITICAL block.
- [x] **A Test Renamed Out Of Discovery Is Its Own Finding (`src/security.mjs`)** — `TEST_DEREGISTERED`, waivable like every other kind.
- [x] **The Scaffold Passes A Repository's Own YAML Linter (`src/config.mjs`)** — 40 eslint errors on files `init` had just written.
- [x] **A Loosened Run Says So (`bin/agentctl.mjs`)** — an override left no trace in the report at all.
- [x] **`task create -p` Skips The Questions (`src/wizard-task.mjs`)** — the advertised quickstart blocked forever in a real terminal.

### v0.70.0: Not Finished Is Not Passed
- [x] **An Unfinished Session Is Not COMPLETED (`src/engine.mjs`)** — terminal, blocked and timed-out are three verdicts, not one.
- [x] **The Retry Carries The Failure (`src/session-ops.mjs`)** — it was reading four fields the API does not return.
- [x] **`agentctl retry` Says When The Trace Is The Fallback (`bin/agentctl.mjs`)** — a generic sentence must not look like evidence.
- [x] **A Contract For The Poll (`test/session-poll.test.mjs`)** — 22 cases over all nine documented session states.

### v0.69.0: Read, Not Just Counted
- [x] **Expected-Value-First Assertions (`src/security.mjs`)** — JUnit and PHPUnit document the order the guard read as prose.
- [x] **A Regex Is An Expected Value (`src/security.mjs`)** — a rewritten pattern was neither a change nor a loss.
- [x] **Renaming A Test Is Not Tampering (`src/security.mjs`)** — on the one-line form, the name blanked into the expectation.
- [x] **An Environment Prefix Runs (`src/git.mjs`)** — `PYTHONPATH=src pytest` never started, and was reported as a failure.
- [x] **`node -e ""` Is A Placeholder (`src/stack-detector.mjs`)** — the same no-op, spelled to look like work.
- [x] **`init` Rejects An Oracle That Proves Nothing (`src/wizard-init.mjs`)** — silence at setup is silence at every gate after it.

### v0.68.0: Not An Approval Either
- [x] **An Unreadable Dialect Blocks (`src/security.mjs`)** — the guard said it had not checked, and approved anyway.
- [x] **A Command That Cannot Fail Is Not An Oracle (`src/engine.mjs`)** — `task create` already refused what the gate accepted.
- [x] **chai And node-tap (`src/security.mjs`)** — a dot chain where RSpec has a space, and a receiver named `ct`.
- [x] **A Reformat Is Not A Weakening (`src/security.mjs`)** — the weakening count was still line-based.
- [x] **`bootstrap` Declines (`src/stack-detector.mjs`)** — rather than writing an oracle that asserts its own impossibility.

### v0.67.0: A Move Is Not A Deletion
- [x] **In-Body Skips (`src/security.mjs`)** — a test could be silenced with `self.skipTest()`, the form unittest's own documentation uses.
- [x] **Cross-File Moves (`src/security.mjs`)** — refactoring produced CRITICAL findings for assertions that still run.
- [x] **The Published Package Explains Itself (`scripts/run-tests.mjs`)** — `npm test` crashed with a raw ENOENT in an installed copy.
- [x] **The Label Names What Failed (`bin/agentctl.mjs`)** — a deleted assertion was reported under a bare SECRETS heading.

### v0.66.0: Saying Nothing Is Not Saying Approved
- [x] **An Assertion Is A Statement (`src/security.mjs`)** — a rewritten expected value whose keyword sat on a context line collected five green phases.
- [x] **Line Comments Are Stripped (`src/security.mjs`)** — they never were; `pending` was left at the comment and the copy after the loop put it back.
- [x] **The Boundary Reaches The Operator (`src/security.mjs`)** — the warning was wired to a function the gate does not call.
- [x] **Evidence Before Rules (`src/memory.mjs`)** — a hardcoded sentence was being injected into every prompt as if it were a fix.

> 📦 Milestone summaries for v0.20.0 – v0.65.0 are archived in [CHANGELOG.md](CHANGELOG.md) ("Archived Roadmap Milestone Summaries"); per-release notes for every version since v0.3.0 live there too.

---

## 🎯 Target Milestones (v0.74.0 & v1.0.0)

### v0.74.0: Distributed File Leases & Preemptive DAG Scheduling
- [ ] **Atomic Filesystem Lease & Heartbeat Protocol (`src/engine.mjs`, `src/flaky-ledger.mjs`)** — Directory-mutex file leasing with heartbeat timestamps, stale-lock detection via PID liveness inspection, and tombstone rotation without third-party daemons or Redis.
- [ ] **Preemptive Task Cancellation & Interface Fingerprints (`src/dag-engine.mjs`)** — Automatically aborts and yields downstream swarm tasks when upstream exported symbol interfaces diverge from their cryptographic SHA-256 fingerprints.
- [ ] **POSIX/Win32 Process Group Guillotine (`src/git.mjs:runCmd`, `src/engine.mjs`)** — Tree teardown via `process.kill(-pid, 'SIGKILL')` on POSIX and `taskkill /T /F /PID` on Windows in `runCmd` to eliminate orphaned test runners, dev-servers and background watchers on timeout (`ETIMEDOUT`).
- [ ] **Unicode Trojan Source & Homoglyph Fencing (`src/security.mjs`)** — Deterministic token scanner using V8 Unicode Property Escapes (`\p{Script=...}`) and NFKC normalization to block invisible Bidi overrides (CVE-2021-42574, isolates partially patched in PR #21) and mixed-script homoglyphs.

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
