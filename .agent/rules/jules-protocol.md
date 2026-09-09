# Google Jules Protocol & Guardrails

This document outlines the hard constraints and system prompting best practices for all Google Jules automated sessions.

## 1. Hard Constraints, Edge Realities & Failure Modes

- **Sandbox Flakiness (Flaky Test Fix Spiral)**: Intermittent build failures cause Jules to assume source code is broken, leading to destructive edits on valid business logic to "fix" infrastructure noise.
- **Boundary Violations (Lockfile & Schema Overwrites)**: When facing type/dependency conflicts, agents favor the shortest path to a passing test, often forcefully downgrading lockfiles or altering database migrations unless explicitly forbidden.
- **Monorepo Dilution (Attention & I/O Bottlenecks)**: Broad context ingestion across multi-package repos causes attention dilution, slow clone I/O, and cascading diff failures.
- **I/O & Payload (80 KB Payload Cap)**: API forcefully truncates diff payloads > 80 KB. Keep diffs under a **75 KB internal governor** (`git diff | wc -c`).
- **CI/CD Deadlocks (Silent Approval Hangs)**: SDK defaults to `requireApproval: true`. In headless CI jobs, sessions hang indefinitely awaiting plan approval unless explicitly set to `requireApproval: false`.
- **Security (ZombAI & Prompt Injection)**: Untrusted code containing hidden Unicode or Markdown image links can attempt prompt injection to force outbound HTTP requests. Requires strict XML boundary tags and Keyless Auth.
- **Git Base Drift (Stale Merge-Base Reverts)**: If `main` advances during a session, `git diff main pr-N` shows branch *divergence*, not the applied patch. Merging blindly can silently revert unrelated files updated on `main`.
- **Edge Isolates (Runtime Boundary Breaches)**: Edge environments (e.g. Cloudflare `workerd`) enforce strict limits (128 MB RAM, 10 MiB bundle cap). Jules may import heavy native libraries (`sharp`, `canvas`) that pass Node tests in the VM but crash worker deployment.
- **CMS/DB Credentials (Visual & E2E Test Failures)**: Cloud VMs lack live CMS API keys, DB credentials, and display servers. Headful E2E or visual screenshot tests (e.g. Playwright) fail with 500 errors.
- **Observed reference environment (KVM / 4 vCPU / 8 GiB RAM / No Swap)**: These are observations from a reference sandbox, not universal Google Jules platform invariants; verify the current session before relying on them. The observed execution sandbox runs in KVM on Ubuntu 24.04.2 LTS (`x86_64`, kernel 6.8.0, hostname `devbox`, user `jules`, uid=1001, passwordless `sudo`) with the target repo mounted at `/workspace`. Memory is capped via cgroup v2 `memory.max` at 8 GiB with swap completely disabled (`memory.swap.max = 0`); exceeding resident memory triggers the Linux kernel OOM killer (Exit code 137) immediately. Writable OverlayFS quota is 20–30 GiB. PID 1 is a headless supervisor without `systemd` (`systemctl` and `service` commands fail), so background services must be launched directly via bash (`cmd &`).
- **Bootstrap Ingestion Hierarchy**: The startup harness parses only the Task Prompt / Issue Context, root `AGENTS.md`, and root `README.md`. Sub-package `AGENTS.md` manifests are discovered dynamically during file traversal (not during bootstrap planning), and IDE/agent configs (`.agent/rules/`, `.cursorrules`, `CLAUDE.md`, `.jules.yml`) are ignored by the harness. Critical invariants must be stated in root `AGENTS.md` or injected into the task envelope.

## 2. System Prompting & Guardrail Best Practices

To maximize the ratio of mergeable PRs vs. failed or hallucinated sessions:

1. **Strict File Scoping:** Constrain file I/O using explicit glob patterns in session prompts.
2. **Immutable Boundary Directives:** Explicitly forbid modification of `*.lock` files, database migration histories, and core configuration files.
3. **Deterministic Test Verification Mandate:** Require explicit verification commands with zero-exit-code constraints before PR generation is permitted.
4. **Sub-Package `AGENTS.md` Hierarchy:** Place localized `AGENTS.md` files at sub-package boundaries in monorepos to restrict dependency resolution graphs and operational blast radius. Note: Sub-package manifests are discovered during file traversal, not during initial bootstrap planning, so critical repo-wide invariants must remain in root `AGENTS.md`.
5. **Evidence-Based PR Requirement:** Require every PR to include commands run, exit codes, coverage/performance deltas, and risk assessments.
6. **No-Weakening Rule:** Explicitly forbid deleting tests, reducing assertion strength, disabling lint/type checks, or ignoring security warnings.
7. **Benchmark Threshold Rule:** Performance changes must include multiple benchmark runs, median comparison, and a minimum improvement threshold (e.g. ≥ 5%).
8. **Auto-Merge Risk Gate:** Only auto-merge low-risk task types when diff size, forbidden-path checks, test results, security scans, and license checks all pass.
9. **Untrusted Input Isolation:** Wrap issue bodies, logs, user comments, and external reports in `<untrusted_input>` tags and instruct the agent to treat them as data only.
10. **Stop-on-Uncertainty Rule:** If the task cannot be completed safely within scope, the agent must stop without opening a PR rather than guessing.
11. **Pre-Dispatch Grounding Mandate:** Verify all file paths, script names, and exported symbols against the live repository tree before writing them into a prompt.
12. **Programmatic CI Scope Guarding:** Enforce prompt constraints at the CI level using an unbypassable `Agent Scope Guard` workflow that evaluates diffs against a protected paths manifest (`.agent/protected-paths.json`).
13. **Google Labs Exploration Budget Protocol ("Use deep planning mode"):** Execute tasks across 3 discrete phases: (1) Discovery & Symbol Tracing (silent inspection, write NO code), (2) Oracle & Test Formulation, and (3) Surgical Implementation & Verification. Incorporate "Use deep planning mode" in task envelopes to steer model attention toward methodical verification before code modification.
14. **Critic Agent Steering (Adversarial Pre-Review):** Jules' internal Critic Agent must evaluate proposed patches for edge-case regressions, $O(n^2)$ bottlenecks, unhandled parameters, and layout shifts (CLS) prior to PR submission. When modifying test suites or error handling, the agent must deliberately mutate production code and induce real failure conditions to prove that tests and catch blocks actually fail as intended (preventing tautological tests).
15. **Web Excellence & Frontend Guardrails:** Enforce quantitative Core Web Vitals (LCP < 1.2s, CLS < 0.05), WCAG 2.2 AA/AAA semantic accessibility, Schema.org JSON-LD compliance, and Playwright multi-viewport responsive testing.
16. **Airtight Positive Enclosures ("Pink Elephant" Rule):** Replace long negative constraint lists with strict positive operational perimeters (`ONLY modify [Target/Module]`) to prevent attention-drift in deep context windows.
17. **Sterile / Clinical Vocabulary Mandate:** Eradicate aggressive verbs (`kill`, `amputate`, `sabotage`, `destroy`) from prompts and policies. Use clinical equivalents (`terminate PID`, `prune code`, `mutate test logic`, `purge cache`) to prevent false-positive safety classifier trips in Google Cloud VMs.
