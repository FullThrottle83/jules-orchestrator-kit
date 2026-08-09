<div align="center">

# 🚀 jules-orchestrator-kit

### High-Volume Autonomous AI Agent Orchestration Engine for Google Jules

[![Jules PR Audit](https://github.com/FullThrottle83/jules-orchestrator-kit/actions/workflows/jules-audit.yml/badge.svg)](https://github.com/FullThrottle83/jules-orchestrator-kit/actions/workflows/jules-audit.yml)
[![npm version](https://img.shields.io/npm/v/jules-orchestrator-kit.svg)](https://www.npmjs.com/package/jules-orchestrator-kit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20native-blue.svg)](https://nodejs.org)

<p align="center">
  <b>Zero-dependency safety kernel and high-throughput orchestration engine for autonomous AI agent swarms.</b><br/>
  Built specifically to execute 300+ daily agent sessions and parallel worktree swarms safely on native Node.js 20+ ESM.
</p>

</div>

---

<p align="center">
  <img src="docs/assets/hero-flow.svg?v=3" alt="Autonomous Orchestration Pipeline" width="100%" />
</p>

---

## ⚡ 2-Minute Quickstart

> 💡 **TIP**: **New to Google Jules or agent automation?** You don't need any complex setup! `jules-orchestrator-kit` works out of the box with standard `npm test` and zero external dependencies.

```bash
# 1. Initialize orchestrator structure in your target codebase
npx jules-orchestrator-kit init

# 2. Dispatch an autonomous task (Dry-Run mode for local simulation)
JULES_DRY_RUN=1 npx agentctl dispatch \
  --title "Add JWT Validator" \
  --prompt "Implement JWT validation middleware with unit tests"

# 3. Run the 4-phase security & verification gatekeeper
npx agentctl gate

# 4. Connect as a native stdio MCP server (for Claude Code, Cursor, or Antigravity)
npx agentctl mcp
```

> 📖 **NOTE**: **Looking for production deployment patterns?**  
> Check out [**EXAMPLES.md**](./EXAMPLES.md) for 6 real-world recipes (Nightly TODO Scanner, Composite CI Action, Multi-Worktree Swarms, OODA Auto-Fix, MCP IDE setup, and Specialist Rosters).

---

## 🎯 Why jules-orchestrator-kit?

Whether you are dispatching your first automated coding task or managing high-throughput CI/CD swarms across large engineering teams, `jules-orchestrator-kit` provides total operational safety:

| Feature | 🐣 For Rookies & Beginners | 🛠️ For Senior Developers & Infrastructure Engineers |
| :--- | :--- | :--- |
| **Safety First** | Never breaks `main` branch or pushes failing code. | 4-Phase Safety Gatekeeper fails closed on scope drift, high entropy secrets, or test regressions. |
| **Token Budget Protection** | Prevents runaway loops from burning API quotas. | Sliding-window OODA thrash detector ($A \rightarrow B \rightarrow A \rightarrow B$) halts non-convergent repair cycles automatically. |
| **Zero Setup Hassle** | Works out of the box with standard `npm test`. | **Zero External Runtime Dependencies** (`node:fs`, `node:path`, `node:crypto`, `node:child_process`). |
| **Multi-Agent Swarms** | Run multiple tasks simultaneously without conflict. | Deterministic VFS mutex and 3-way structural merge engine resolve parallel worktree changes cleanly. |
| **IDE & Tooling** | Seamlessly connects to your favorite editor. | Native Model Context Protocol (MCP) server over memory-bounded stdio streams. |

---

## 🏛️ System Architecture & Visual Diagrams

<details open>
<summary><b>📐 1. Control Plane Architecture Layers</b></summary>

<br/>

<p align="center">
  <img src="docs/assets/architecture-layers.svg?v=3" alt="Control Plane Architecture Layers" width="100%" />
</p>

<br/>

### Engine System Highlights

- **Native Task DAG Executor (`src/dag-engine.mjs`)**: Zero-dependency `DagExecutor` with Kahn's topological sort algorithm, SHA-256 interface fingerprinting post-task execution, and pre-execution cycle detection (`DagCycleError`).
- **Intent Journaling & Zombie Worktree Reaper (`src/journal.mjs`)**: Automatic boot-time scan (`reapOrphanedIntents`) in `agentctl` and MCP server that tracks git operations in `.agent/state/journal.jsonl` and prunes orphaned worktrees left by crashed/recycled processes.
- **Hermetic Network Egress Guard (`src/preload-net-guard.mjs`)**: Intercepts and blocks unmocked outbound HTTP/HTTPS egress during test execution (`NODE_OPTIONS="--import ./src/preload-net-guard.mjs"`), enforcing hermetic testing while allowing local loopback (`localhost`, `127.0.0.1`).
- **Linearizable VFS Mutex (`src/state.mjs`)**: Kernel-level directory mutex (`withVfsMutex`) guaranteeing serial linearizability for SHA-256 hash-chained session ledgers with atomic budget reservation (`reserveBudgetAtomic`).
- **PID Recycling & Stale Lock Protection (`src/state.mjs`)**: Linux `/proc/<pid>/stat` launch-time validation and random UUID nonces prevent false-positive lock reaps from recycled OS process IDs.
- **Memory-Bounded Content-Length MCP Streaming (`src/mcp.mjs`)**: Native MCP server over stdio streams using `McpFrameDecoder` with a 4 MB memory safety ceiling and panic boundaries to prevent stdout stack trace leaks.
- **Process Group Isolation (`src/process-group.mjs`)**: `ProcessGroupManager` creates isolated process groups (`detached: true`) and catches `SIGINT`/`SIGTERM`/`exit` signals to execute `process.kill(-pgid)`, guaranteeing zero zombie processes.
- **TOCTOU & Symlink Defense (`src/security.mjs`)**: `safeAtomicWrite()` uses `O_CREAT | O_EXCL | O_WRONLY` temp files with `fsyncSync` + `renameSync` and `lstatSync`/`realpathSync` symlink checks.
- **3-Way Structural AST/JSON Merge (`scripts/jules-merge-swarm.mjs`)**: Pure Node `deepMerge3Way()` algorithm for recursive object and array merges executed in isolated temporary directories (`os.tmpdir()`).

</details>

<details>
<summary><b>🔁 2. Self-Healing OODA Loop Cycle</b></summary>

<br/>

<p align="center">
  <img src="docs/assets/ooda-loop-cycle.svg?v=3" alt="Self-Healing OODA Loop" width="100%" />
</p>

<br/>

> 🚨 **IMPORTANT**: The OODA (Observe-Orient-Decide-Act) loop executes up to 3 repair attempts when tests fail. If the failure output oscillates deterministically without progress, the OODA engine halts repair to save API tokens and returns Exit Code 4.

</details>

<details>
<summary><b>🛡️ 3. Zero-Trust Security Shield & 4-Phase Gate</b></summary>

<br/>

<p align="center">
  <img src="docs/assets/security-shield.svg?v=3" alt="Zero-Trust Security Guarantees" width="100%" />
</p>

<br/>

### The 4-Phase Safety Audit & Security Boundary (`agentctl gate`)

1. **Scope Fencing (`forbidden_paths`)**: Ensures agents cannot modify protected files (`package.json`, `.github/`, deployment keys) without explicit overrides.
2. **Diff Payload Governor**: Rejects oversized diffs (> 75 KB) to prevent truncation and hidden payload injections.
3. **Secret Entropy Scanner**: Scans diffs for high-confidence secrets (AWS keys, Stripe keys, GitHub tokens, SSH private keys) using Shannon Entropy analysis (> 3.6 bits).
4. **Trusted Verification Suite**: Executes auto-detected unit tests and linters (`npm test`) inside a hermetic network sandbox to guarantee zero regressions before merging.
5. **Prompt Guard Boundary (`src/prompt-guard.mjs`)**: `sanitizeUntrustedData` strips bidi control characters, ANSI escape sequences, zero-width unicode, and neutralizes prompt injection tags (`<|im_start|>`, `[INST]`).
6. **MCP Stream Isolation (`src/mcp.mjs`)**: Seals `process.stdout.write` framing stream to prevent log output from corrupting JSON-RPC stdio frames.

> ⚠️ **WARNING**: All security rules are fetched strictly from `origin/main` (never untrusted PR branches) to prevent prompt-injection attacks from altering security rules.

</details>

<details>
<summary><b>🐝 4. Parallel Swarm Topology & Isolated Worktrees</b></summary>

<br/>

<p align="center">
  <img src="docs/assets/swarm-topology.svg?v=3" alt="Multi-Agent Swarm Topology" width="100%" />
</p>

<br/>

> 📌 **NOTE**: Swarm execution spawns dedicated git worktrees for each task in parallel, isolated by VFS locks. Completed tasks are verified and merged back using 3-way AST/JSON structural merging (`agentctl swarm`).

</details>

<details>
<summary><b>🔌 5. Model Context Protocol (MCP) & IDE Integration</b></summary>

<br/>

<p align="center">
  <img src="docs/assets/mcp-integration.svg?v=3" alt="Dual-Way MCP Integration" width="100%" />
</p>

<br/>

### Connecting to Claude Desktop, Cursor, or Antigravity

Start the native stdio MCP server:

```bash
npx agentctl mcp
```

#### MCP Tool Registry Exposed:
- `dispatch_jules_task`: Dispatch autonomous coding tasks directly from your LLM prompt.
- `audit_jules_gate`: Execute the 4-phase safety gate against the workspace.
- `check_risk_tier`: Classify workspace changes into Risk Tiers (R0 Cosmetic to R3 Restricted).
- `get_jules_status`: Fetch real-time status of active, pending, and completed tasks.
- `telemetry_tail`: Query last N real-time telemetry events from the SHA-256 hash spine.

</details>

<details>
<summary><b>💳 6. Subscription Tier Presets Matrix</b></summary>

<br/>

<p align="center">
  <img src="docs/assets/tier-presets.svg?v=3" alt="Subscription Tier Presets Matrix" width="100%" />
</p>

<br/>

Tailor session limits and rate-limiting behavior to your Google Jules API subscription tier:

| Tier | `dailyTasks` | `repairAttempts` | `concurrency` | `staggerMs` | Target Usage |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **`free`** | `15` | `1` | `1` | `3000 ms` | **Hobby / Free Tier:** Conserves quota, prevents HTTP 429 rate limits. |
| **`pro`** | `100` | `2` | `2` | `1500 ms` | **Developer Pro:** Balanced throughput for everyday work. |
| **`ultra`** *(default)* | `300` | `3` | `3` | `1000 ms` | **Swarm / Enterprise:** Maximum parallel throughput & CI/CD. |

**How to activate:**
- **Environment Variable:** `export JULES_TIER=free` (or set in `.env`)
- **Config File (`.agent/jules.yml`):** Set `tier: free`

</details>

---

## 🤖 Specialist Agent Prompt Presets (`.agent/prompts/`)

Specialized prompt presets enforce payload limits (< 75 KB) and domain guardrails out of the box:

| Preset | Role & Domain | Primary Focus |
| :--- | :--- | :--- |
| **`Overseer.md`** | **Architect & Supervisor** | System-wide refactoring, linearizable state, and structural integrity. |
| **`Bolt.md`** | **Performance Engineer** | Bottleneck elimination, streaming optimization, and low-latency execution. |
| **`Sentinel.md`** | **Security Auditor** | Vulnerability patching, secret sanitization, and TOCTOU defense. |
| **`Janitor.md`** | **Technical Debt & Cleanup** | Dead code elimination, unused import pruning, and zero-dependency compliance. |

```bash
# Example: Dispatch a cleanup task using the Janitor preset
npx agentctl dispatch \
  --prompt "$(cat .agent/prompts/Janitor.md) Prune unused helper methods in src/utils.mjs"
```

---

## ⚡ GitHub Actions Composite Action (`.github/actions/setup-jules`)

Integrate `jules-orchestrator-kit` into any GitHub Actions workflow with 3 lines of YAML:

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: FullThrottle83/jules-orchestrator-kit/.github/actions/setup-jules@main
    with:
      action: 'gate'
      base_branch: 'main'
      tier: 'ultra'
    env:
      JULES_API_KEY: ${{ secrets.JULES_API_KEY }}
```

---

## 🛠️ CLI Command Reference (`agentctl`)

| Command | Usage Example | Description |
| :--- | :--- | :--- |
| **`init`** | `npx agentctl init` | Initializes `.agent/` configuration, workflows, and task queue directory |
| **`dispatch`** | `agentctl dispatch --title "Fix Bug" --prompt "..."` | Dispatches an autonomous task to Google Jules |
| **`gate`** | `agentctl gate [--fix] [--base main]` | Runs 4-phase safety gatekeeper audit against workspace |
| **`queue`** | `agentctl queue` | Processes pending task queue sequentially from `.agent/jules-queue/` |
| **`swarm`** | `agentctl swarm` | Launches parallel multi-agent swarm in isolated git worktrees |
| **`merge-swarm`** | `agentctl merge-swarm` | Performs 3-way structural merge on completed swarm PRs |
| **`mcp`** | `agentctl mcp` | Starts stdio Model Context Protocol (MCP) JSON-RPC 2.0 server |
| **`doctor`** | `agentctl doctor` | Verifies stack configuration, environment keys, and daily token budget |
| **`scan`** | `agentctl scan` | Scans codebase for `TODO` and `FIXME` comments and generates task queue |
| **`clean`** | `agentctl clean` | Audits and cleans up stale git worktrees, orphaned intents, locks, and temporary state files |

---

## 📝 Configuration Reference (`.agent/jules.yml`)

Auto-generated by `agentctl init` at the root of your project:

```yaml
version: 2
tier: "pro" # Options: free, pro, ultra (default: ultra)
test_cmd: "npm test"
build_cmd: "npm run build"
forbidden_paths:
  - ".github/"
  - "package.json"
  - ".agent/jules.yml"
allow_paths: []
limits:
  dailyTasks: 300
  repairAttempts: 3
  diffKb: 75
```

---

## 🚦 Exit Code Registry & Troubleshooting

Standardized exit codes enforced across all CLI utilities and CI pipelines:

| Exit Code | Classification | Description & Immediate Remediation Action |
| :---: | :--- | :--- |
| `0` | **Success** | Task completed cleanly; PR opened or verification passed. |
| `1` | **Pre-Dispatch / Arg Error** | Invalid arguments, prompt > 50 KB, or pre-dispatch validation error. |
| `2` | **API / Network Failure** | Jules API rate-limit (HTTP 429), `FAILED_PRECONDITION` quota, or timeout. |
| `3` | **Scope Violation** | Attempted modification of restricted files (`.github/`, command files, agent rules). |
| `4` | **OODA Exhausted / Thrash** | Verification suite failed after 3 repair attempts or hit deterministic regression. |
| `5` | **Diff Payload Limit** | Post-change git diff exceeds payload budget (`limits.diffKb`, default 75 KB). |
| `6` | **Secret Detected** | High-confidence secret or private key detected in patch diff (Shannon entropy > 3.6 bits). |
| `7` | **Budget Exhausted** | Daily task session quota limit reached (`limits.dailyTasks`, default 300). |
| `8` | **FLAKY_QUARANTINE** | Statistical test flakiness detected (oscillation >= 0.4, Wilson CI); OODA repair suppressed. |
| `124` | **Execution Timeout** | Subprocess execution exceeded hard timeout limit (default 10 minutes). |
| `188` | **ERR_UNMOCKED_NET** | Unmocked outbound HTTP/HTTPS egress intercepted by hermetic network guard. |

---

## 🔐 Environment Variables Reference

| Variable | Description | Default |
| :--- | :--- | :--- |
| `JULES_API_KEY` | Google Jules REST API key | *(none)* |
| `JULES_REPO` | Target GitHub Repository (`owner/repo`) | Auto-detected from `git remote` |
| `JULES_TIER` | Subscription tier preset (`free`, `pro`, `ultra`) | `ultra` |
| `JULES_DRY_RUN` | Set to `1` or `true` for dry-run simulation mode | `false` |
| `JULES_DAILY_BUDGET` | Custom daily session budget limit | `300` |
| `JULES_MAX_DIFF_KB` | Custom git diff payload limit in KB | `75` |
| `JULES_ALLOW_COMMAND_FILE_CHANGES` | Allow PR changes to command files (`package.json`, etc.) | `false` |
| `JULES_ALLOW_AGENT_RULE_CHANGES` | Allow PR changes to agent rule files (`AGENTS.md`, etc.) | `false` |
| `BASE_BRANCH` | Base branch for PR Audits & Merge-Base checks | `main` |
| `NO_COLOR` | Set to `true` to disable ANSI color output | `false` |

---

## 🌐 Supported Tech Stacks & Auto-Detection

The orchestrator automatically infers verification and build commands across ecosystems:

| Stack / Ecosystem | Manifest File | Inferred Test Command | Inferred Build Command |
| :--- | :--- | :--- | :--- |
| **Turborepo** | `turbo.json` | `npx turbo run test` | `npx turbo run build` |
| **pnpm Workspace** | `pnpm-workspace.yaml` | `pnpm test` | `pnpm build` |
| **Nx Workspace** | `nx.json` | `npx nx run-many -t test` | `npx nx run-many -t build` |
| **JavaScript / TypeScript** | `package.json` | `npm test` | `npm run build` |
| **Rust** | `Cargo.toml` | `cargo test --workspace` | `cargo build` |
| **Go** | `go.mod` | `go test ./...` | `go build ./...` |
| **Python** | `pyproject.toml` | `pytest` | *(none)* |
| **Bun / Deno** | `bunfig.toml` / `deno.json` | `bun test` / `deno test` | `bun run build` |
| **Elixir / Ruby** | `mix.exs` / `Gemfile` | `mix test` / `rake test` | *(standard build)* |
| **Java / C / C++** | `pom.xml` / `Makefile` | `mvn test` / `make test` | `mvn compile` / `make` |

---

## 🤝 Contributing & Standards

We welcome community contributions! Please adhere to our core engineering invariants:

1. **Zero External Runtime Dependencies**: Use ONLY native Node.js ESM built-in modules (`node:fs`, `node:path`, `node:crypto`, `node:child_process`, `node:os`).
2. **100% Verification Suite**: All test suites must pass cleanly with 0 errors.
3. **Cross-Platform Compatibility**: Always normalize Windows backslashes (`\`) to POSIX slashes (`/`).

### Running Tests Locally

```bash
# Clone the repository
git clone https://github.com/FullThrottle83/jules-orchestrator-kit.git
cd jules-orchestrator-kit

# Run ESLint & node unit test suite (100% zero external runtime deps)
npm run lint
npm test
```

---

## 📄 License

Distributed under the [MIT License](LICENSE).
