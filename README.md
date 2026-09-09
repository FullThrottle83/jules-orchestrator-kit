<div align="center">

# jules-orchestrator-kit

### Task orchestration and automated verification harness for coding agents

<br/>

[![Jules PR Audit](https://github.com/FullThrottle83/jules-orchestrator-kit/actions/workflows/jules-audit.yml/badge.svg)](https://github.com/FullThrottle83/jules-orchestrator-kit/actions/workflows/jules-audit.yml)
[![npm version](https://img.shields.io/npm/v/jules-orchestrator-kit.svg)](https://www.npmjs.com/package/jules-orchestrator-kit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20native-blue.svg)](https://nodejs.org)
[![Platform: Linux | macOS | Windows](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-blueviolet.svg)](https://nodejs.org)

<br/>

<p align="center">
  <b>Zero-dependency safety gatekeeper, scoped sandboxing, and automated verification for coding agents.</b><br/>
  Runs deterministic test verification, secret scrubbing, and automated repair loops across any stack or monorepo before opening Pull Requests.
</p>

<br/>

<p align="center">
  <a href="#quickstart">Quickstart</a> &nbsp;•&nbsp;
  <a href="#any-repository">Any Repository</a> &nbsp;•&nbsp;
  <a href="#overview">Overview</a> &nbsp;•&nbsp;
  <a href="#target-workflows">Target Workflows</a> &nbsp;•&nbsp;
  <a href="#triage-guidelines">Triage</a> &nbsp;•&nbsp;
  <a href="#cli-docs">CLI Docs</a> &nbsp;•&nbsp;
  <a href="#deep-dives">Deep Dives</a>
</p>

</div>

<br/>

<p align="center">
  <img src="docs/assets/hero-flow.svg" alt="Autonomous Orchestration Pipeline" width="100%" />
</p>

<br/>

---

<br/>

<a id="quickstart"></a>
## Prompt Sanitization & Content Filters

`sanitizePromptVocabulary()` in `src/prompt-guard.mjs` transforms high-trigger
operational terms in prompt prose to reduce false-positive provider content
filter refusals. For example, prose containing `kill -9` becomes
`terminate with SIGTERM`, and `SIGKILL` becomes `SIGTERM`. These substitutions
can change technical meaning: SIGTERM is not equivalent to SIGKILL.

Fenced code blocks (triple backticks) and inline backtick code spans are
preserved verbatim by this vocabulary transformation (commit `ad2011a`). Put
exact commands and identifiers in code spans or blocks when their spelling
matters. This preservation does not exempt content from other prompt guards
or secret redaction.

Vocabulary rewriting is not a security boundary, a guarantee of provider
acceptance, or a replacement for provider content filters. Review transformed
prompt text when exact operational semantics matter; scope checks, execution
envelopes, and verification remain separate controls.

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

`init` derives configuration directly from repository manifests, connects reachable agent providers, and generates CI workflows matching the project toolchain.

```bash
# Which agents can this machine dispatch to, and what is missing for the rest?
npx jules-orchestrator-kit providers
```

```bash
# How hard should the gate verify agent work? (minimal | standard | max)
npx jules-orchestrator-kit profile --set max
```

> [!TIP]
> **Context-Aware Next Step:**  
> Running `agentctl` without arguments inspects the local repository state (git status, active API keys, queued tasks) and prints the immediate next action.

> [!TIP]
> **Global Installation:**  
> Install globally for direct command access:
> ```bash
> npm install -g jules-orchestrator-kit
> agentctl init && agentctl task create && agentctl queue
> ```

<br/>

---

<br/>

<a id="any-repository"></a>
## Using It In Any Repository

The kit derives configuration directly from repository manifests across five core dimensions:

| Dimension | Resolution Mechanism | Inspect / Override |
| :--- | :--- | :--- |
| **Monorepo Scope** | Monorepo diffs resolve to affected sub-projects (`verify.scope: affected`), widening to root commands when shared files change. Activated automatically when monorepo manifests are detected. | `agentctl check --json`<br/>`verify.scope` in `.agent/config.yml` |
| **Stack & Tooling** | `detectPolyglotStack()` inspects 26+ ecosystems (Cargo, Go, Python, Bun, Deno, Maven, Gradle, .NET, PHP, Ruby, Elixir, Swift, Flutter, CMake, Make, Turbo/pnpm/Nx) and extracts native test and build commands. | `agentctl doctor`<br/>`verify:` in `.agent/config.yml` |
| **Agent Provider** | Supports Google Jules (hosted REST), Claude Code CLI, OpenAI Codex CLI, and Gemini CLI. Validates environment credentials for hosted APIs and `PATH` binaries for local agents. | `agentctl providers`<br/>`agentctl init --provider <name>` |
| **Verification Depth** | `verify.profile` (`minimal`, `standard`, `max`) expands dynamically into stack-compatible verification stages, reporting explicit skip reasons for unsupported platform checks. | `agentctl profile`<br/>`agentctl profile --set max` |
| **CI Generation** | Generates tailored CI workflows containing the project's native runtime and toolchain rather than copying a fixed template. | `agentctl ci init [--target github\|gitlab]` |

### Verification Profiles

| Profile | Stages | Recommended Use |
| :--- | :--- | :--- |
| `minimal` | Setup → Tests | Large/slow test suites or initial project onboarding. |
| `standard` | Setup → Lint → Tests → Build → Diff Anti-Tamper | Default gate for routine pull requests. |
| `max` | All stages above → AST Mutation Scoring → V8 Diff Coverage *(Node)* → 3-Pass Flakiness Probe | High-risk refactors or critical infrastructure changes. |

Verification profiles evaluate gates dynamically per runtime. Unsupported platform checks (such as V8 coverage on Cargo or Go projects) are bypassed with explicit diagnostic logs rather than failing the gate.

### Standalone Local Verification

All security, integrity, and test gates execute locally without external network access or API keys:
`agentctl check`, `agentctl gate`, `agentctl mutate`, `agentctl coverage`, `agentctl probe`, `agentctl evidence`, `agentctl doctor`. Agent providers are required only for dispatching autonomous tasks.

<br/>

---

<br/>

<a id="overview"></a>
## Overview

> **`jules-orchestrator-kit` serves as a safety gate and automated test runner for AI coding agents.**  
> It drafts falsifiable task envelopes, executes verification commands in an isolated sandbox, automatically retries on test failures using captured diagnostics, and approves PRs only when 100% of tests pass cleanly.

<br/>

<a id="target-workflows"></a>
### Target Workflows

| Persona / Team | Primary Value | Everyday Commands |
| :--- | :--- | :--- |
| **Solo Developers** | Safely experiment with autonomous coding without risking broken branches, leaked API keys, or ruined git history. | `agentctl init`<br/>`agentctl task create` |
| **Repo Maintainers** | Automate bug fixes, dependency bumps, and PR reviews with self-healing test loops. | `agentctl gate`<br/>`agentctl queue` |
| **Monorepo Teams** | Isolate subproject verification (`backend/`, `frontend/`, `cli/`) so agent edits never thrash global test suites. | `agentctl swarm`<br/>`agentctl lock` |
| **Platform & Security** | Enforce fail-closed security policies, pre-commit secret scrubbing (including base64), and strict 75 KB diff limits. | `agentctl doctor`<br/>`agentctl dashboard` |

<br/>

---

<br/>

<a id="triage-guidelines"></a>
## Triage Guidelines: When to Dispatch Tasks

To maximize PR merge rates, dispatch tasks according to deterministic boundaries:

### Ideal Tasks (High Success Rate)
* **Scoped Bug Fixes & Code Changes:** Mechanically verifiable via unit tests (`pytest`, `npm test`, `cargo test`, `dotnet test`, `go test`).
* **Type & Linter Migrations:** Strict mode conversions, type annotations, and dead code elimination.
* **Dependency Bumps & CVE Patches:** Upgrading vulnerable lockfile dependencies with hermetic test validation.
* **Backend Refactoring:** Modularizing route controllers, API handlers, or database schemas.
* **Headless E2E / Playwright Tests:** UI changes verified by automated visual snapshots (`npx playwright test`).

### Out of Scope (Keep Human-in-the-Loop)
* **Unverifiable Visual UI Tweaks:** CSS/Tailwind adjustments without automated Playwright regression tests.
* **Closed Proprietary Platforms Without CLI:** Systems lacking local CLI or git integration (e.g. Salesforce GUI, Webflow).
* **Unmocked Live Cloud Systems:** Code requiring live connections to external cloud APIs without local mocks or emulators.
* **Protected Infrastructure Files:** Direct edits to `.github/workflows/`, deployment keys, or agent security gate rules (blocked fail-closed by `Agent Scope Guard`).

<br/>

---

<br/>

## Core Capabilities

* **Multi-Provider Dispatch:** Dispatches to Google Jules (hosted REST API), Claude Code CLI, OpenAI Codex CLI, and Gemini CLI. `agentctl providers` inspects environment credentials and binary availability across providers.
* **Vendor-Neutral Configuration:** Supports both `JULES_*` and `AGENT_*` environment variables (`AGENT_API_KEY`, `AGENT_REPO`, `AGENT_SWARM_CONCURRENCY`), with legacy `JULES_*` variables taking precedence.
* **Dynamic Verification Profiles:** Configured via `verify.profile: minimal | standard | max`. Automatically schedules linting, unit testing, build stages, AST mutation testing, and stability probing suited to the project toolchain.
* **Stack-Native Generated CI:** `agentctl ci init` generates GitHub Actions and GitLab CI configurations containing the project's exact toolchain (`setup-python`, `setup-go`, `setup-bun`, etc.) alongside Node.js for CLI execution.
* **Zero Runtime Dependencies:** Implemented strictly using native Node.js 20+ standard modules (`node:fs`, `node:child_process`, `node:crypto`, `node:path`, `node:http`, `node:readline`, `node:test`).
* **Cross-Platform Parity:** Verified 100% green across Linux, macOS (Darwin), and Windows on Node 20, 22, and 24.
* **Autonomous OODA Repair Loop:** Captures test stdout/stderr traces, fingerprints failure patterns, and executes automated repair cycles (up to 3 turns) before requesting human intervention.
* **Fail-Closed Verification:** Rejects diffs that execute zero verification commands unless explicitly waived with `verify.required: false`.
* **Semantic Anti-Tamper Guard:** Detects test tampering across languages: weakened assertions, removed assertions, vacuous tautologies (`expect(true).toBe(true)`), and assertions nested inside dead conditions (`if False:`, `if (false)`, `if 0:`).
* **Binary & Symlink Payload Inspection:** Inspects binary diffs and symlink targets directly, charging real byte sizes against the diff ceiling to prevent payload governor bypasses.
* **Fail-Closed Security & Secret Scrubbing:** Evaluates Deny-before-Allow rules against canonicalized paths. Detects high-entropy strings and base64-encoded credentials (e.g. Kubernetes manifests).
* **Complexity & Cost Router:** Zero-dependency heuristic classifier (`src/router.mjs`) routing mechanical tasks to lightweight models while reserving primary models for complex refactors, backed by syntax-check fallback recovery.
* **Terminal UI & Diagnostics (`agentctl doctor`):** Interactive terminal dashboard, VFS lock management, and automated system diagnostics.
* **Mechanically Verified:** Comprehensive test suite of **1524 unit tests across 204 suites**, with 59 activation-coverage canaries and 100% pass rate.

<br/>

---

<br/>

<a id="cli-docs"></a>
## CLI Command Reference (`agentctl`)

`agentctl` is the unified command-line interface for `jules-orchestrator-kit`, available via `npx jules-orchestrator-kit <command>` or `agentctl <command>`. The per-command flag reference is generated from the same registry that powers `--help`: see [docs/COMMAND_REFERENCE.md](docs/COMMAND_REFERENCE.md).

| Command | Usage | Description | Exit Codes |
| :--- | :--- | :--- | :--- |
| `init` | `agentctl init [--interactive] [--tier pro] [--provider <name>] [--profile <name>] [--force]` | Interactive onboarding wizard & stack detector. Generates `.agent/config.yml` and scaffolds `AGENTS.md`, the role prompts, the guardrails and the runtime `.gitignore` entries. Existing files are preserved unless `--force`. | `0` (Created) |
| `budget` | `agentctl budget [--by-user] [--json] [reset]` | Reports rolling 24h task budget, quota headroom, and per-developer task attribution without external auth servers. | `0` (Status), `2` (Arg Error) |
| `task create` | `agentctl task create [<prompt>] [--title <t>] [-p <prompt>] [-f <file>] [--template <id>] [--role <name>] [--tier fast\|complex]` | Interactively authors & scopes falsifiable task envelopes with secret scrubbing, preflight gate checks, and DAG dependency wiring. | `0` (Queued), `1` (Secret/Unfalsifiable) |
| `task template` | `agentctl task template [<id>] [--list] [--json]` | Lists and synthesizes pre-calibrated task envelopes (Web, Deep Think, Universal & Agent Hardening: `web-cwv`, `web-wcag`, `web-seo`, `web-playwright`, `agent-dead-code-audit`, `web-flaky-heal`, `web-i18n`, `web-ai-access`, `agent-qa-mutation`, `agent-ci-falsify`, `agent-service-isolate`, `agent-error-paths`, `agent-security-audit`, `agent-dep-audit`, `agent-doc-drift`, `agent-config-audit`, `agent-api-contract`, `deep-debug`, `deep-feature`, `deep-optimize`, `deep-harden`). | `0` (Listed/Synthesized) |
| `dispatch` | `agentctl dispatch [<prompt>] [-p <prompt>] [-f <file>] [-r <role>] [-t <tier>] [--author <name>] [--check-premise] [--auto-pr] [--repoless] [--dry-run]` | Dispatches autonomous task to the active provider with pre-flight idempotency checks, payload limits, and role prompt resolution. `--dry-run` stops short of the provider call and reports itself as a rehearsal rather than a dispatch. | `0` (Dispatched), `1` (Error) |
| `plan approve` | `agentctl plan approve <sessionId> [--dry-run] [--json]` | Approves pending execution plan for an active Jules session (`:approvePlan`) with automatic 404/503 retry backoff. | `0` (Approved), `1` (Error) |
| `session get` | `agentctl session get <sessionId> [--dry-run] [--json]` | Retrieves live session lifecycle state from provider REST API with token rotation. | `0` (Fetched), `1` (Error) |
| `patch` | `agentctl patch <sessionId> [--apply] [--save <path>] [--json]` | Extracts raw git diff patch from a completed Jules session and tests or applies it locally with `git apply --check` safety. | `0` (Clean/Applied), `1` (Conflict/Error) |
| `retry` | `agentctl retry <sessionId> [--role <role>] [--with-failure] [--json]` | Fetches error traces and activity logs from a failed session and synthesizes a targeted OODA retry dispatch. | `0` (Dispatched), `1` (Error) |
| `prune` | `agentctl prune [--age 7d] [--state <state>] [--delete] [--yes] [--json]` | Queries and batch-archives or deletes stale/completed sessions via Jules v1alpha API to keep workspaces clean. | `0` (Cleaned) |
| `pr harvest` | `agentctl pr harvest [--tier r0,r1] [--limit <n>] [--auto] [--allow-no-checks] [--dry-run]` | Discovers open agent PRs, evaluates CI checks & risk tiers, and auto-squashes green low-risk changes autonomously. A PR reporting **no** CI checks is skipped unless `--allow-no-checks` is passed, and an unavailable changed-file list blocks rather than classifying as low risk. | `0` (Triaged/Merged), `1` (Error) |
| `providers` | `agentctl providers [--json]` | Probes every built-in provider and reports which ones this machine can dispatch to, what each one is missing, and which is active. For a CLI provider, "ready" means the binary is on `PATH` — it does not prove the CLI is signed in. | `0` (Active provider ready), `1` (Not ready) |
| `provider set` | `agentctl provider set <name>` | Switches the active provider in `.agent/config.yml` in place, preserving comments. | `0` (Set), `1` (No manifest), `2` (Name missing) |
| `profile` | `agentctl profile [--list] [--set minimal\|standard\|max] [--json]` | Shows the verification stages the configured profile expands to on this stack, or writes a new profile into `.agent/config.yml` without disturbing comments. | `0` (Shown/Set), `2` (Unknown profile) |
| `ci init` | `agentctl ci init [--target github\|gitlab] [--force] [--dry-run] [--json]` | Generates a stack-aware CI gate workflow (`.github/workflows/agent-gate.yml` or `.gitlab-ci.agent-gate.yml`) that runs `agentctl check --mode committed`. Refuses to overwrite without `--force`. | `0` (Written/Skipped), `1` (Write error), `2` (Unknown target) |
| `doctor` | `agentctl doctor [--probe] [--json]` | Diagnostic check runner. `--probe` additionally starts the configured provider's CLI to confirm it answers, rather than only finding it on `PATH`. | `0` (Healthy), `1` (Failures) |
| `queue` | `agentctl queue [--dag] [--concurrency <n>] [--dry-run] [--json]` | Consumes and executes task envelopes in `.agent/jules-queue/` with Kahn's DAG dependency resolution. Non-task files (manifests, `README.md`) are skipped, and `--dry-run` previews without moving anything. | `0` (Complete) |
| `swarm` | `agentctl swarm [--json]` | Runs parallel multi-agent swarm across worker slots with PID liveness detection. | `0` (Complete) |
| `check` / `gate` / `audit`| `agentctl check [--mode working-tree] [--fix] [--allow-protected] [--allow-test-change <kind>] [--json] [--json-report <path>]` | Runs security, secret scanning, rules budget audit, and tiered verification gates (with declarative assertion support) against working tree or branch. | `0` (Approved), `1` (Budget/Arg), `3` (Scope), `4` (Verify), `5` (Diff >75K), `6` (Secret **or** test integrity), `8` (Flaky) |
| `mutate` / `mutation` | `agentctl mutate [--min-score <n>] [--max-mutants <n>] [--cmd <testCmd>] [--json]` | Runs zero-dependency diff mutation testing harness on changed hunks with operator inversion and safety rollback. | `0` (Passed), `1` (Score Low) |
| `coverage` | `agentctl coverage [--min <pct>] [--cmd <testCmd>] [--base <ref>] [--json]` | Runs native zero-dependency V8 diff coverage check against added diff lines. | `0` (Passed), `1` (Low Coverage) |
| `probe` / `stability` | `agentctl probe [--repeat <n>] [--min <passRate>] [--cmd <testCmd>] [--json]` | Probes test suite flakiness across N consecutive iterations with oscillation detection. | `0` (Passed), `1` (Flaky) |
| `perf` / `event-loop` | `agentctl perf [--max-ms <n>] [--cmd <testCmd>] [--json]` | Monitors Node.js Event Loop delay and Big-O lag to prevent main-thread event loop starvation. | `0` (Healthy), `1` (Lag Exceeded) |
| `fix` | `agentctl fix [--file <path>] [--task] [--dry-run] [--json]` | Auto-repairs failure traces from piped stdin (`npm test 2>&1 \| agentctl fix`) or synthesizes OODA queue tasks. | `0` (Resolved), `1` (Failed) |
| `rules` | `agentctl rules <check\|compile> [--out <path>] [--json]` | Audits instruction files against character/line budgets or compiles unified rules block with SHA-256 and length anti-truncation sentinels. | `0` (Valid/Compiled), `1` (Violations) |
| `assert` | `agentctl assert [--dir <d>] [--file <f>] [--max-mb <n>] [--gzip] [--targets <g>] [--patterns <p>] [--json] [--json-report <p>]` | Runs declarative zero-dependency verification assertion primitives (`assert:dir-size`, `assert:file-size`, `assert:file-patterns`, `assert:exists`, `assert:mutation`, `assert:test-integrity`, `assert:diff-coverage`, `assert:test-stability`, `assert:event-loop-lag`). | `0` (Passed), `1` (Assertion Failed) |
| `rollback` | `agentctl rollback [sessionId \| --latest]` | Restores exact commit, uncommitted files, and cleans orphan task worktrees from pre-flight checkpoints. | `0` (Restored), `1` (Error) |
| `resume` | `agentctl resume <sessionId> --response "<reply>"` | Streams engineer response back into active Google Jules warm session context window. | `0` (Resumed), `1` (Error) |
| `test-gen` | `agentctl test-gen --title <t> --spec <s> [--run]` | Scaffolds falsifiable unit tests, verifies RED failure state, and locks test in `scope.deny`. | `0` (Scaffolded/Red) |
| `dashboard` | `agentctl dashboard [port] [--port <n>]` | Starts zero-dependency local HTTP telemetry and audit visualizer dashboard (default port 4100; valid range 1024–65535). | `0` (Running), `1` (Invalid port) |
| `evidence` | `agentctl evidence <generate\|verify\|show>` | Generates, verifies, or prints SHA-256 evidence manifests (unkeyed digests: tamper-evident, not signed) with test-tamper locking. | `0` (Verified), `1` (Tamper) |
| `flaky` | `agentctl flaky <status\|heal\|reset>` | Manages Wilson-quarantined tests (Exit Code 8) and dispatches automated anti-flakiness healing swarms. | `0` (Healed/Listed) |
| `mcp` | `agentctl mcp` | Starts stdio Model Context Protocol (MCP) server for Claude, Cursor, and Antigravity. | `0` / Stdio stream |
| `mcp init` | `agentctl mcp init [--target cursor\|vscode\|claude\|all]` | 1-click config scaffolding for Cursor (`.cursor/mcp.json`), VS Code tasks (`tasks.json`), and Claude Desktop. | `0` (Scaffolded) |

<br/>

---

<br/>

<a id="deep-dives"></a>
## Deep Dives & Technical Reference

<details>
<summary><b>Configuration Reference (<code>.agent/config.yml</code>)</b></summary>

<br/>

`jules-orchestrator-kit` auto-detects stack defaults, but allows explicit overrides through `.agent/config.yml`:

```yaml
# .agent/config.yml — Universal Orchestrator Configuration

version: 1
provider: "jules"        # Provider key ("jules" | "claude-code" | "codex" | "gemini-flash")
baseBranch: "main"       # Default target base branch
branchPrefix: "agent/"   # Prefix for task branches

# Verification commands (auto-detected by Stack Detector if omitted)
verify:
  test: "npm test"
  build: "npm run build"
  timeout_ms: 300000     # Per-stage kill time in ms (default 300000)
  minTests: 1            # Floor for "the suite actually ran" (0 disables)
  required: true         # false = this repo uses only the scope/secret phases

# Scope protection rules (Deny-first evaluation)
scope:
  deny:
    - ".github/**"
    - "keys/**"

# Plan tier. Defaults to `free` when unset — the kit will not assume you are
# paying for a larger plan than you are. Set this to unlock your real limits.
tier: "free"             # free | pro | ultra

# Risk model for auto-merge triage. Builtin patterns cover what is dangerous in
# any repository (CI, lockfiles, migrations, key material, IaC, auth). Add the
# paths that are sensitive to YOUR domain — these EXTEND the builtins.
risk:
  restricted:            # R3 — never auto-merged
    - "**/pricing/**"
    - "**/billing/**"
  consequential:         # R2 — always requires a human read
    - "packages/api/**"
  max_routine_diff_lines: 400

# Operational limits & governors (tier defaults shown; any key here overrides)
limits:
  diffKb: 75             # Diff Payload Governor limit
  promptKb: 50           # Maximum prompt payload size
  dailyTasks: 300        # Task quota per rolling 24h window (not per calendar day)
  repairAttempts: 3      # Maximum repair iterations
  concurrency: 15        # Worker slots (defaults free: 3, pro: 8, ultra: 15)

# Dynamic Complexity & Cost Router — opt-in, disabled by default.
router:
  enabled: false
  fast: "gemini-flash"    # Trivial/mechanical tasks (score <= threshold)
  complex: "jules"        # Complex/multi-file/safety-sensitive tasks
  threshold: 0            # Heuristic score threshold for escalation
```

</details>

<br/>

<details>
<summary><b>26+ Supported Languages, Frameworks & Stacks</b></summary>

<br/>

```
Ecosystems Natively Detected & Verified by Stack Detector:
├── Python / Django (pyproject.toml, requirements.txt, setup.py, manage.py)
├── Systems / Rust Cargo (Cargo.toml)
├── Systems / Go (go.mod)
├── Systems / CMake & Make (CMakeLists.txt, Makefile)
├── JS / TS Workspaces (turbo.json, pnpm-workspace.yaml, nx.json)
├── JS / TS Runtimes (bunfig.toml, deno.json, package.json)
├── PHP / Laravel / WordPress (composer.json, phpunit.xml, pest.php, artisan, wp-cli.yml)
├── .NET / C# / F# (*.sln, *.csproj, *.fsproj, global.json)
├── Mobile / Dart / Flutter (pubspec.yaml)
├── Mobile / Swift / Xcode (Package.swift)
├── Mobile / React Native (app.json, react-native.config.js)
├── Web3 / Solidity Foundry (foundry.toml, remappings.txt) — offline-enforced
├── Web3 / Solidity Hardhat (hardhat.config.js, hardhat.config.ts)
├── Elixir / Phoenix (mix.exs)
├── Ruby / Rails (Gemfile)
├── Java / Maven & Gradle (pom.xml, build.gradle, build.gradle.kts)
└── Devcontainers & Docker Compose (.devcontainer/devcontainer.json, docker-compose.yml, Dockerfile)
```

</details>

<br/>

<details>
<summary><b>System Architecture & Verification Diagrams</b></summary>

<br/>

### 1. Control Plane Architecture Layers
<p align="center">
  <img src="docs/assets/architecture-layers.svg" alt="Control Plane Architecture Layers" width="100%" />
</p>

### 2. Autonomous Verification & Repair Loop
<p align="center">
  <img src="docs/assets/ooda-loop-cycle.svg" alt="Autonomous Verification & Repair Loop" width="100%" />
</p>

### 3. Polyglot Monorepo Scoped Boundary Resolver
<p align="center">
  <img src="docs/assets/monorepo-resolver.svg" alt="Polyglot Monorepo Scoped Boundary Resolver" width="100%" />
</p>

### 4. Multi-Agent Parallel Swarm Topology
<p align="center">
  <img src="docs/assets/swarm-topology.svg" alt="Multi-Agent Parallel Swarm Topology" width="100%" />
</p>

</details>

<br/>

<details>
<summary><b>Multi-Provider Failover & Cost Router SDK</b></summary>

<br/>

### Multi-Provider Failover SDK (`createFailoverProvider`)
```javascript
import { createFailoverProvider, loadConfig } from "jules-orchestrator-kit";

const config = loadConfig(process.cwd());
const provider = createFailoverProvider(["jules", "claude-code"], config);

const result = await provider.dispatch(
  { title: "Repair failing tests", prompt: "Fix the failing test suite." },
  { root: process.cwd() }
);
```

### Cost Router SDK (`resolveRoutedProvider`)
```javascript
import { resolveRoutedProvider, loadConfig } from "jules-orchestrator-kit";

const config = loadConfig(process.cwd()); // router.enabled must be true in .agent/config.yml
const { provider, classification } = resolveRoutedProvider(
  { title: "Fix typo", prompt: "Fix a typo in the README." },
  config
);
console.log(classification.tier); // "fast" | "complex"
```

### Syntax-Verified FAST Tier (`createSyntaxVerifiedProvider`)
`resolveRoutedProvider()` already wraps the FAST tier with this; use it directly only when composing your own provider cascade.
```javascript
import { createProvider, createSyntaxVerifiedProvider, loadConfig } from "jules-orchestrator-kit";

const config = loadConfig(process.cwd());
const fast = createSyntaxVerifiedProvider(
  createProvider("gemini-flash", config),
  createProvider("jules", config),
  config
);

// If gemini-flash leaves broken .js/.mjs/.cjs on disk, this transparently
// re-dispatches through "jules" instead of returning the broken result.
const result = await fast.dispatch({ prompt: "Fix a typo." }, { root: process.cwd() });
```

</details>

<br/>

<details>
<summary><b>Feature Roadmap & Shipped Milestones</b></summary>

<br/>

| Feature | Module / Command | Architectural Description | Status |
| :--- | :--- | :--- | :---: |
| **Child Streams & Polyglot Build Detection** | `src/git.mjs`, `src/stack-detector.mjs`, `bin/agentctl.mjs` | Native `spawnSync` execution in `runCmd()` preserving stderr stream on status 0 (supporting Bun test output), conditional `buildCmd` resolution for Bun/Deno scripts, and `--verify` alias parity. | **v0.72.2** *(Shipped)* |
| **Staged Diff Fidelity & Indentation Dead Guards** | `src/git.mjs`, `src/security.mjs` | Query cached index in staged mode (`git diff --cached <base>`), detect literal falsity dead guards (`if False:`, `if (false)`, `if 0:`), and support indentation-aware block traversal for Python test suites. | **v0.72.1** *(Shipped)* |
| **Cold-Start Hardened Kernel & Tamper Defense** | `src/config.mjs`, `src/engine.mjs`, `src/git.mjs`, `src/security.mjs` | Full remediation of 22 cold-start audit findings (F01–F22): authoritative base policy resolution, ephemeral snapshot worktree isolation, canonical root test tamper guard, conditional assertion defense, multi-target Cargo test aggregation, Python src-layout injection, and complete repository uninstall documentation. | **v0.72.0** *(Shipped)* |
| **Silence Is Not A Suite & Scaffolding Linter Fixes** | `src/ops/test-collection.mjs`, `src/wizard-init.mjs`, `src/config.mjs` | Reject zero-output test suite commands, quote-aware YAML parser with scalar emission, test de-registration detection (`TEST_DEREGISTERED`), and active waiver telemetry banner. | **v0.71.0** *(Shipped)* |
| **Terminal State Classification & Error Diagnostics** | `src/engine.mjs`, `src/session-ops.mjs` | Triple-verdict session resolution (terminal, blocked, timed-out), diagnostic extraction for failed session retries (`AssertionError`, tracebacks), and 22-case session polling contract. | **v0.70.0** *(Shipped)* |
| **Expected-Value Scanning & Safe Scaffolding** | `src/security.mjs`, `src/wizard-init.mjs` | Multi-language expected-value first assertions (JUnit/PHPUnit), prefix-aware test rename verification, and rejection of empty/trivial verification oracles. | **v0.69.0** *(Shipped)* |
| **Dialect Hardening & Scope Protection** | `src/security.mjs`, `src/config.mjs`, `scripts/guard-reach-check.mjs` | Unreadable test dialects fail closed, lockfiles and toolchain pins guarded against silent tampering, and 59-canary activation coverage gate in CI. | **v0.63.0** *(Shipped)* |
| **Process-Group Reaping & Subprocess Lifecycles** | `scripts/run-tests.mjs`, `src/git.mjs` | Tree-wide process group cleanup on interruption and zero-output test collection guards. | **v0.60.0** *(Shipped)* |

<br/>

> For the complete history of all shipped milestones (v0.20.0 – v0.72.2), see [ROADMAP_V1.md](ROADMAP_V1.md).

</details>

<br/>

---

<br/>

## 🧹 Complete Uninstall / Removing the Kit (Undo Init)

To completely remove `jules-orchestrator-kit` from a repository after running `agentctl init`, follow the procedure below. Note that `agentctl clean` performs operational maintenance (clearing ephemeral locks, temporary worktrees, and evidence caches), not an uninstaller.

### 1. Generated Assets & Manifest

`agentctl init` / `scaffoldRepoAssets()` writes the following project files and directories:
- **Core configuration and rules:** `.agent/config.yml` (or `.agent/jules.yml`), `.agent/rules/`, `.agent/prompts/`, `.agent/workflows/`, and `AGENTS.md`.
- **System contracts:** `SPEC.md`, `CONSTRAINTS.md` (and optional `DESIGN.md`).
- **Queue runtime stub:** `.agent/jules-queue/README.md`.
- **Optional IDE & CI integrations:** `.github/workflows/agent-gate.yml`, `.gitlab-ci.agent-gate.yml`, and `.cursor/rules/jules.mdc`.

### 2. Runtime State & Working Trees

During execution, the kit produces untracked runtime artifacts in:
- `.agent/evidence/` — Cryptographic evidence manifests and stage run recordings.
- `.agent/state/` — Flaky test ledgers, budget trackers, and escalation queues.
- `.agent/worktrees/` — Isolated snapshot worktrees used by the verification sandbox.
- `.agent/history/` and `.agent/handovers/` — Local agent session memories.

### 3. Removal Procedure (Preserving Pre-Existing User Files)

To completely undo `init` and restore your working tree to its exact original state:

```bash
# 1. Remove tracked orchestrator assets (skips any files that were not scaffolded)
git rm -rf --ignore-unmatch \
  .agent \
  AGENTS.md \
  SPEC.md \
  CONSTRAINTS.md \
  DESIGN.md \
  .github/workflows/agent-gate.yml \
  .gitlab-ci.agent-gate.yml \
  .cursor/rules/jules.mdc

# 2. Remove untracked runtime directories and temporary caches
rm -rf .agent .agentctl

# 3. Clean up .gitignore additions
# Revert the appended "# Jules Orchestrator runtime state & credentials" block from .gitignore
git checkout .gitignore   # If .gitignore had no other unstaged changes, or edit by hand

# 4. Optional: Uninstall global CLI package
npm uninstall -g jules-orchestrator-kit
```

<br/>

---

<br/>

## 📖 Documentation & External References

- [**System Architecture & Pipeline Overview**](./docs/architecture.md) — Comprehensive technical sequence diagrams and control plane specifications.
- [**Google Jules Official Documentation**](https://jules.google) — Official platform overview and API specifications for Google Jules.
- [**Examples & Task Envelope Recipes**](./EXAMPLES.md) — Production YAML and Markdown task envelopes.
- [**Changelog**](./CHANGELOG.md) — Full release history and migration guides.
- [**Contributing**](./CONTRIBUTING.md) — PR-based contribution flow, Conventional Commits, and commit-signing rules.
- [**Contributors & Provenance**](./CONTRIBUTORS.md) — Attribution ledger: human maintainers and autonomous coding agents.

<br/>

---

<br/>

## 🤝 Contributions & Provenance

`jules-orchestrator-kit` is a **human-led, agent-assisted** open-source project.
It is maintained by **Jonas Pudas** ([`FullThrottle83`](https://github.com/FullThrottle83))
and developed with supervised autonomous coding agents — **`jules-agent`**
(Google Jules) and **Arena Agent** — which author code inside the task-envelope
and verification framework defined in `AGENTS.md`. In the `git log`
(2026-07-26 → 2026-09-09, 448 commits) the majority of commits (~80%) are
authored by autonomous agents and ~18% by the human maintainers. Every commit
is CI-verified and merged under maintainer oversight, and agent authorship is
preserved transparently in git `Author`/`Co-authored-by` metadata — it is
never hidden or rewritten. See
[`CONTRIBUTORS.md`](./CONTRIBUTORS.md) for the full provenance ledger and
[`CONTRIBUTING.md`](./CONTRIBUTING.md) for contribution rules.

<br/>

---

<br/>

## ⚖️ Disclaimer

`jules-orchestrator-kit` is an independent, community-driven open-source project and is not affiliated with, endorsed by, or sponsored by Google, Google LLC, or Alphabet Inc. "Google", "Google Jules", and related marks are trademarks of Google LLC.

<br/>

---

<br/>

<div align="center">
  <p><b>jules-orchestrator-kit</b> • Zero runtime dependencies • MIT License • Universal safety and verification for autonomous coding agents.</p>
</div>


## Provider-neutral MCP tool aliases

The MCP server advertises and accepts `agent_*` aliases alongside all existing
names. Every `jules_*` tool has an equivalent `agent_*` name (for example,
`jules_list_sessions` → `agent_list_sessions` and `jules_send_message` →
`agent_send_message`). The other provider-branded tools map as follows:

| Existing name | Provider-neutral alias |
| :-- | :-- |
| `dispatch_jules_task` | `agent_dispatch_task` |
| `audit_jules_gate` | `agent_audit_gate` |
| `get_jules_status` | `agent_get_status` |
| `optimize_jules_prompt` | `agent_optimize_prompt` |

Aliases use identical input schemas, handlers, and safety checks. Existing
clients need no changes. Naming is provider-neutral; actual capabilities
still depend on the configured provider, and an alias does not make a
Jules-specific operation supported by every provider.
