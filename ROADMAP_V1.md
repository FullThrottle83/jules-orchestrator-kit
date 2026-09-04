# 🗺️ Jules Orchestrator Kit — Roadmap to v1.0 & Beyond

The **jules-orchestrator-kit** is the zero-dependency safety gatekeeper and self-healing engineering kernel for autonomous coding agents — **Google Jules**, **Claude Code**, **Codex** and the **Gemini CLI** — in any repository and any stack.

> [!IMPORTANT]
> **Zero Runtime Dependencies is a strict core invariant.**  
> Every feature on this roadmap is built strictly with native Node.js 20+ built-in modules (`node:fs`, `node:child_process`, `node:crypto`, `node:http`, `node:readline`, `node:test`).

---

## 📌 Release Milestones Overview

```
 v0.62.0 (Current Stable) ──► v0.63.0 (Distributed Swarms & Leases) ──► v1.0.0 (Production Hardened Kernel)
 (No Denominator, No Claim)  (Multi-Agent DAG & Resource Locks)        (Enterprise Telemetry & SLA)
```

---

## ✅ Shipped Milestones (v0.20.0 – v0.62.0)


### v0.62.0: No Denominator, No Claim
- [x] **A File Is Not A Claim (`src/stack-detector.mjs`)** — `make test` requires the Makefile to declare the target; `app.json` requires a package.json beside it; a `test` script that is `echo … && exit 0` is a placeholder, not an oracle.
- [x] **The Generated Fallback Oracle Can Fail (`src/stack-detector.mjs`)** — It checks that every source file parses instead of asserting that the working directory exists, and refuses to pass with nothing to check.
- [x] **Lockfiles And Toolchain Pins Are Protected (`src/config.mjs`)** — `package.json` was protected and `package-lock.json` was not. Plus `.envrc`, `.git-credentials`, cloud credential trees and CodeBuild.
- [x] **The Sixth Spelling Of "Where Are The Tests" (`src/evidence.mjs`)** — Go co-located tests and every monorepo produced `fileCount: 0`, which switched `strictTestLock` off in silence.
- [x] **Seven More Runners In The Collection Floor** — Maven, Gradle, PHPUnit, RSpec, dotnet, XCTest, ctest, ExUnit.
- [x] **100% Of Nothing Is Not 100% (`src/coverage.mjs`)** — Diff coverage reports `scored: false` where V8 measured nothing, instead of the best possible number.


### v0.61.0: Green Against Nothing
- [x] **Collection Floor (`src/ops/test-collection.mjs`)** — A verification command that exits 0 having collected zero tests is no longer a pass. The count is read from the runner's own summary across node:test, pytest, cargo, jest, vitest, mocha and go; an unrecognised runner states no count and is not failed for it.


### v0.60.0: A Guard Worth Reading
- [x] **Per-Check Overrides (`--allow-test-change <kind>`)** — Answering one tamper finding no longer silences the five other checks in the bundle. `--allow-test-modifications` remains as the blunt form.
- [x] **Unchanged Assertions Cancel Before Pairing (`src/security.mjs`)** — Reordering or moving an assertion is no longer reported as two rewritten expectations.
- [x] **A Reworded Message Is Not A Rewritten Expectation (`src/security.mjs`)** — Message-position string arguments are compared apart from value positions, so improving the wording of a failure is silent while `assert.equal(name(), "Alice")` → `"Bob"` still fires.


### v0.59.0: One Answer Per Question
- [x] **One Test-Path Classifier (`src/test-paths.mjs`)** — Five modules had five definitions of "is this a test file?"; the tamper guard's could not see `tests/test_calc.py`, so every check in it was off for the standard pytest, Rust and RSpec layouts. All five now share `isTestPath`.
- [x] **Statement-Level Expectation Pairing (`src/security.mjs`)** — Assertions are reassembled from the diff's two images before pairing, so wrapping one across lines no longer walks through the guard. Contributed as PR #14 by an external agent; verified and merged.
- [x] **Numeric Literals Beyond Decimal (`src/security.mjs`)** — Hex, binary, octal, exponent and underscored literals normalise, so `0xFF` → `0xFE` is a rewritten expectation like any other.


### v0.58.0: Locks That Lock
- [x] **A CLI Lock Is A Lease (`src/state.mjs`, `bin/agentctl.mjs`)** — `lock acquire` no longer witnesses its own exiting process, so two agents can no longer both hold the same file. `--ttl` bounds it; `--pid` binds it to a real long-lived process instead.
- [x] **A URL No Longer Disables The Secret Scanner (`src/security.mjs`)** — URLs, data: URIs and integrity hashes are stripped from a line rather than skipping the whole line, and a URL's userinfo and query values are scanned on their own.
- [x] **Untracked Symlinks Are Judged By Their Target (`src/git.mjs`)** — Working-tree mode resolves links git has never seen, and a symlink is rendered as its target *path* rather than read through.
- [x] **Rewritten Expectations Are Reported (`src/security.mjs`)** — An assertion whose literal changed while its shape did not is `ASSERTION_EXPECTATION_CHANGED`, with `--allow-test-modifications` as the documented override.
- [x] **Scope Guard Covers Every Forge (`src/config.mjs`)** — GitLab, CircleCI, Jenkins, Azure, Travis, Drone, Buildkite and Woodpecker definitions are denied alongside `.github/**`; build and test-runner configuration is protected.
- [x] **Python Runs As A Module (`src/stack-detector.mjs`)** — `python -m pytest` under whichever interpreter name this machine has, so an ordinary layout is not rejected on first contact.
- [x] **Build Artifacts Do Not Read As Tampering (`src/evidence.mjs`)** — Caches a test run writes itself are excluded from the integrity hash.


### v0.57.0: Honest Reporting
- [x] **Stack-Native TDD Oracles (`src/ops/tdd-generator.mjs`)** — Generated in the runner's own language, with a RED check that requires the assertion to have actually run rather than accepting any non-zero exit.
- [x] **JSON Envelopes Reach The DAG Runner (`src/dag-engine.mjs`)** — `isDagTaskFile` is exported and used for the CLI's count, so a queue of `.json` envelopes is no longer reported as empty.
- [x] **`swarm` Honours Its Flags (`bin/agentctl.mjs`)** — `--json`, `--dry-run` and `--concurrency` are parsed, and the registry describes a dispatcher rather than an inspector.
- [x] **No Score Where Nothing Was Measured (`src/mutation.mjs`)** — An empty mutant population reports `null` and a reason instead of a vacuous 100%.
- [x] **New Files Are Visible To Every Gate (`src/git.mjs`)** — The synthetic diff for an untracked file carries a `@@` header, so mutation and diff coverage can place its lines at all.


### v0.56.0: Wired, Not Just Shipped
- [x] **File-Aware Locking (`src/state.mjs`)** — `acquireLock()` compares the requested paths against every live lock instead of only the task id.
- [x] **Checkpoints That Exist (`src/engine.mjs`, `src/session-ops.mjs`)** — Taken before a dispatch and before `patch --apply`, so `agentctl rollback` finally has something to restore.
- [x] **Reachable Monorepo Scoping (`verify.scope: affected`)** — The boundary resolver is called by the gate, opt-in, defaulted on for repositories detected as monorepos and widening again when a shared file changes.
- [x] **Process-Group Reaping For The Test Runner (`scripts/run-tests.mjs`)** — An interrupted run takes its whole tree with it instead of orphaning every process below the first level. A first instance of the v0.60.0 guillotine, applied where the leak was actually observed.
- [x] **Live-Path Corrections (`src/provider.mjs`, `src/engine.mjs`)** — `listSources()` works against the real API, and Node's test-runner context no longer masks a failing verification command.


### v0.55.0: Verification Integrity
- [x] **Assertion Weakening Detection (`src/security.mjs`)** — A specific expectation swapped for a vague one is reported as `ASSERTION_WEAKENED`, closing the one-out-one-in bypass that counting assertions could never see.
- [x] **Symlink-Aware Scope (`src/git.mjs`, `src/engine.mjs`)** — Added links are judged by the path they resolve to as well as their own name, without following anything on disk.
- [x] **Source-Bound Evidence (`src/evidence.mjs`)** — Manifests attest to the source tree, not only the tests, and the integrity hash finally sees test files that live at the repository root.


### v0.54.1: The Gate Fails Closed
- [x] **No Oracle, No Approval (`src/engine.mjs`)** — A change that ran zero verification commands is rejected rather than approved; `verify.required: false` is the deliberate opt-out, read from the base commit.
- [x] **Binary Payload Inspection (`src/security.mjs`, `src/git.mjs`)** — Files git renders as "Binary files ... differ" are read directly for structured credentials, closing the NUL-byte bypass, and their real size is charged against the payload ceiling.


### v0.54.0: First-Run Friction — Honest Errors, Detected Defaults
- [x] **Base Branch Detection (`src/git.mjs`)** — `detectDefaultBranch()` resolves `origin/HEAD`, a local `main`/`master`, then the checked-out branch, replacing the hardcoded `main` that failed the first gate in every `master` or `develop` repository.
- [x] **Diagnosable Gate Output (`bin/agentctl.mjs`, `src/ops/verify-output.mjs`)** — Phase errors are rendered instead of swallowed, and a failing stage's stdout is no longer discarded because the spawn wrapper wrote one line to stderr.
- [x] **Truthful Remediation Hints (`bin/agentctl.mjs`)** — Test tampering no longer advises rotating API keys, and a provider that refused the dispatch is no longer reported as an exhausted repair loop.
- [x] **Provider-First Onboarding & `agentctl provider set` (`src/wizard-init.mjs`, `src/config-edit.mjs`)** — The wizard asks which agent before asking about one vendor's plans, and switching providers no longer means re-running onboarding.
- [x] **Named Targets And Flags Actually Take Effect (`bin/agentctl.mjs`, `src/ops/ide-scaffold.mjs`, `src/ops/cli-intent.mjs`)** — `mcp init <target>`, `task create --title/--prompt` and `doctor --probe` all did something other than what they said; each now does what it says, or is no longer advertised.
- [x] **Onboarding Trap Distinguished From Overreach (`src/git.mjs`)** — `partitionTracked()` tells uncommitted scaffolding apart from an agent editing its own rules, so the first-run exit 3 advises committing rather than bypassing the gate.
- [x] **Rehearsals Write Nothing (`src/wizard-task.mjs`)** — `task create --dry-run` synthesizes and validates the envelope without queueing it.


### v0.53.0: Universal Portability — Any Stack, Any Agent, Any CI
- [x] **Provider Readiness Probe (`src/provider-readiness.mjs`, `agentctl providers`)** — Per-provider capability descriptors: a credential for the hosted `jules` adapter, a `PATH` binary for the `claude-code`/`codex`/`gemini-flash` exec adapters, with a cross-platform PATHEXT-aware resolver that spawns nothing.
- [x] **Vendor-Neutral Environment Spellings (`src/env-aliases.mjs`)** — Every `JULES_*` knob also answers to `AGENT_*`, normalised once at CLI entry, with the legacy name always winning.
- [x] **Verification Profiles (`src/profiles.mjs`, `agentctl profile`)** — `minimal | standard | max` expanded at load time into a stack-aware pipeline that skips unsupported gates with a stated reason rather than failing the diff.
- [x] **Generated Stack-Aware CI (`src/ci-templates.mjs`, `agentctl ci init`)** — GitHub Actions and GitLab jobs carrying the detected stack's toolchain, replacing the copy of this repository's own nine-way Node matrix.
- [x] **Consumer Repository Hygiene (`bin/init.js`)** — `init` no longer copies the kit's twenty internal scripts into the target repository, and both entry points now write the same manifest pair.


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
