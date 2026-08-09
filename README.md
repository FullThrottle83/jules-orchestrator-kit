# jules-orchestrator-kit

*Disclaimer: This is an independent open-source orchestration tool for Google Jules and is not officially affiliated with or endorsed by Google.*

[![Jules PR Audit](https://github.com/FullThrottle83/jules-orchestrator-kit/actions/workflows/jules-audit.yml/badge.svg)](https://github.com/FullThrottle83/jules-orchestrator-kit/actions/workflows/jules-audit.yml)
[![npm version](https://img.shields.io/npm/v/jules-orchestrator-kit.svg)](https://www.npmjs.com/package/jules-orchestrator-kit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org)

> **High-Volume Autonomous Orchestration Engine for Google Jules**  
> Built specifically to execute 300+ daily agent sessions and parallel swarms safely. Zero external runtime dependencies. Built strictly on native Node.js 20+ ESM.

---

![Autonomous Orchestration Pipeline](docs/assets/hero-flow.svg?v=3)

---

## ⚡ 2-Minute Quickstart

Get up and running in under 2 minutes with zero complex configuration:

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

> 📖 **Looking for production deployment patterns?**  
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

<details open>
<summary><b>⚙️ Control Plane Architecture & Deep Dive</b></summary>

<br/>

![Control Plane Architecture Layers](docs/assets/architecture-layers.svg?v=3)

<br/>

![Self-Healing OODA Loop](docs/assets/ooda-loop-cycle.svg?v=3)

### Engine System Highlights

- **Linearizable VFS Mutex (`src/state.mjs`)**: Kernel-level directory mutex (`withVfsMutex`) guaranteeing serial linearizability for SHA-256 hash-chained session ledgers under high concurrency.
- **PID Recycling & Stale Lock Protection (`src/state.mjs`)**: Linux `/proc/<pid>/stat` launch-time validation prevents false-positive lock reaps from recycled OS process IDs.
- **Memory-Bounded Content-Length MCP Streaming (`src/mcp.mjs`)**: Native MCP server over stdio streams using `McpFrameDecoder` with a 4 MB memory safety ceiling and panic boundaries to prevent stdout stack trace leaks.
- **Process Group Isolation (`src/process-group.mjs`)**: `ProcessGroupManager` creates isolated process groups (`detached: true`) and catches `SIGINT`/`SIGTERM`/`exit` signals to execute `process.kill(-pgid)`, guaranteeing zero zombie processes.
- **TOCTOU & Symlink Defense (`src/security.mjs`)**: `safeAtomicWrite()` uses `O_CREAT | O_EXCL | O_WRONLY` temp files with `fsyncSync` + `renameSync` and `lstatSync`/`realpathSync` symlink checks.
- **3-Way Structural AST/JSON Merge (`scripts/jules-merge-swarm.mjs`)**: Pure Node `deepMerge3Way()` algorithm for recursive object and array merges executed in isolated temporary directories (`os.tmpdir()`).

</details>

<details>
<summary><b>🛡️ Zero-Trust Security Gatekeeper</b></summary>

<br/>

![Zero-Trust Security Guarantees](docs/assets/security-shield.svg?v=3)

### The 4-Phase Safety Audit (`agentctl gate`)

1. **Scope Fencing (`forbidden_paths`)**: Ensures agents cannot modify protected files (`package.json`, `.github/`, deployment keys) without explicit overrides.
2. **Diff Payload Governor**: Rejects oversized diffs (> 75 KB) to prevent truncation and hidden payload injections.
3. **Secret Entropy Scanner**: Scans diffs for high-confidence secrets (AWS keys, Stripe keys, GitHub tokens, SSH private keys) using Shannon Entropy analysis (> 3.6 bits).
4. **Trusted Verification Suite**: Executes auto-detected unit tests and linters (`npm test`) to guarantee zero regressions before merging.

> [!NOTE]
> All security rules are fetched strictly from `origin/main` (never untrusted PR branches) to prevent prompt-injection attacks from altering security rules.

</details>

<details>
<summary><b>🔌 Model Context Protocol (MCP) & IDE Integration</b></summary>

<br/>

![Dual-Way MCP Integration](docs/assets/mcp-integration.svg?v=3)

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

</details>

<details>
<summary><b>🤖 Specialist Agent Prompt Presets (.agent/prompts/)</b></summary>

<br/>

Specialized prompt presets enforcement payload limits (< 75 KB) and domain guardrails out of the box:

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

</details>

<details>
<summary><b>⚡ GitHub Actions Composite Action (.github/actions/setup-jules)</b></summary>

<br/>

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

</details>

<details>
<summary><b>🛠️ CLI Command Reference (`agentctl`)</b></summary>

<br/>

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
| **`cleanup`** | `agentctl cleanup` | Audits and cleans up stale git worktrees and temporary state files |

</details>

<details>
<summary><b>💳 Subscription Tier Presets (Free / Pro / Ultra)</b></summary>

<br/>

![Subscription Tier Presets Matrix](docs/assets/tier-presets.svg?v=3)

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

<details>
<summary><b>📝 Configuration Reference (`.agent/jules.yml`)</b></summary>

<br/>

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

</details>

<details>
<summary><b>🚦 Exit Code Registry & Troubleshooting</b></summary>

<br/>

Standardized exit codes enforced across all CLI utilities:

| Exit Code | Status | Description & Immediate Action |
| :---: | :--- | :--- |
| `0` | **Success** | Task completed cleanly; PR opened or verification passed. |
| `1` | **Pre-Dispatch / Arg Error** | Invalid arguments, prompt > 50 KB, or pre-dispatch validation error. |
| `2` | **API / Network Failure** | Jules API rate-limit (HTTP 429), `FAILED_PRECONDITION` quota, or timeout. |
| `3` | **Scope Violation** | Attempted modification of restricted files (`.github/`, command files, agent rules). |
| `4` | **OODA Exhausted / Thrash** | Verification suite failed after 3 repair attempts or hit deterministic regression. |
| `5` | **Diff Payload Limit** | Post-change git diff exceeds payload budget (`limits.diffKb`, default 75 KB). |
| `6` | **Secret Detected** | High-confidence secret or private key detected in patch diff. |
| `7` | **Budget Exhausted** | Daily task session quota limit reached (`limits.dailyTasks`, default 300). |

</details>

<details>
<summary><b>🔐 Environment Variables Reference</b></summary>

<br/>

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

</details>

<details>
<summary><b>🌐 Supported Tech Stacks & Auto-Detection</b></summary>

<br/>

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

</details>

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
