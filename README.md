# jules-orchestrator-kit

*Disclaimer: This is an independent open-source orchestration tool for Google Jules and is not officially affiliated with or endorsed by Google.*

[![Jules PR Audit](https://github.com/FullThrottle83/jules-orchestrator-kit/actions/workflows/jules-audit.yml/badge.svg)](https://github.com/FullThrottle83/jules-orchestrator-kit/actions/workflows/jules-audit.yml)
[![GitHub Release](https://img.shields.io/github/v/tag/FullThrottle83/jules-orchestrator-kit)](https://github.com/FullThrottle83/jules-orchestrator-kit/tags)
[![npm version](https://img.shields.io/npm/v/jules-orchestrator-kit.svg)](https://www.npmjs.com/package/jules-orchestrator-kit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **v0.20.0 Early Community Release Candidate**  
> High-volume autonomous orchestration engine for Google Jules. Built specifically to handle 300+ daily sessions and parallel agent swarms with zero external runtime dependencies.

---

## ⚡ 2-Minute Quickstart

Get up and running in under 2 minutes:

```bash
# 1. Install or initialize in your target codebase
npx jules-orchestrator-kit init

# 2. Dispatch a task (Dry-Run mode for testing)
JULES_DRY_RUN=1 npx agentctl dispatch \
  --title "Add JWT Validator" \
  --prompt "Implement JWT validation middleware with unit tests"

# 3. Run security & verification gatekeeper
npx agentctl gate

# 4. Start stdio MCP Server (for Cursor, Claude Code, or AGY integration)
npx agentctl mcp
```

---

## 🚀 Built for High-Volume Jules Swarms

`jules-orchestrator-kit` provides the production-hardened control plane needed to execute parallel Google Jules agent swarms safely:

- **Parallel Agent Swarms**: Execute multi-agent task batches concurrently with deterministic lock management and automatic collision prevention.
- **Self-Healing OODA Loop**: Automatic test/build verification and repair loop with sliding-window thrash detection to halt non-convergent agent loops ($A \rightarrow B \rightarrow A \rightarrow B$) and preserve API token budgets.
- **4-Phase Security Gatekeeper**: Fails closed on untrusted PRs by verifying Scope (`forbidden_paths`), Diff Payload Size, Secret Entropy (> 3.6 bits), and Trusted Build/Test Execution.

---

## ⚙️ Core Technical Architecture

Built strictly on native Node.js 18+ ESM with **Zero External Runtime Dependencies** (`"node": ">=18.0.0"`):

- **Linearizable VFS Mutex (`src/state.mjs`)**: Kernel-level directory mutex (`withVfsMutex`) guaranteeing serial linearizability for SHA-256 hash-chained session ledgers under high concurrency.
- **PID Recycling & Stale Lock Protection (`src/state.mjs`)**: Linux `/proc/<pid>/stat` launch-time validation prevents false-positive lock reaps from recycled OS process IDs.
- **Memory-Bounded Content-Length MCP Streaming (`src/mcp.mjs`)**: Native MCP server over stdio streams using `McpFrameDecoder` with a 4 MB memory safety ceiling and panic boundaries to prevent stdout stack trace leaks.
- **Process Group Isolation (`src/process-group.mjs`)**: `ProcessGroupManager` creates isolated process groups (`detached: true`) and catches `SIGINT`/`SIGTERM`/`exit` signals to execute `process.kill(-pgid)`, guaranteeing zero zombie processes.
- **TOCTOU & Symlink Defense (`src/security.mjs`)**: `safeAtomicWrite()` uses `O_CREAT | O_EXCL | O_WRONLY` temp files with `fsyncSync` + `renameSync` and `lstatSync`/`realpathSync` symlink checks.
- **3-Way Structural AST/JSON Merge (`scripts/jules-merge-swarm.mjs`)**: Pure Node `deepMerge3Way()` algorithm for recursive object and array merges executed in isolated temporary directories (`os.tmpdir()`).

---

## 🛠️ CLI Command Reference (`agentctl`)

| Command | Usage | Description |
| :--- | :--- | :--- |
| `agentctl dispatch` | `agentctl dispatch --title "..." --prompt "..."` | Dispatches an autonomous task to Jules |
| `agentctl gate` | `agentctl gate [--fix] [--base main]` | Runs 4-Phase Safety Gatekeeper against workspace |
| `agentctl queue` | `agentctl queue` | Processes pending task queue from `.agent/jules-queue/` |
| `agentctl swarm` | `agentctl swarm` | Executes parallel swarm task queue |
| `agentctl merge-swarm` | `agentctl merge-swarm` | Performs 3-way structural merge on completed swarm PRs |
| `agentctl mcp` | `agentctl mcp` | Starts stdio Model Context Protocol (MCP) server |
| `agentctl doctor` | `agentctl doctor` | Verifies stack configuration, environment, and budget |

---

## 📋 Exit Code Protocol

Standardized exit codes enforced across all CLI utilities:

| Code | Status | Description |
| :---: | :--- | :--- |
| `0` | **Success** | Task completed cleanly; verification passed 100%. |
| `1` | **Arg / Pre-Dispatch Failure** | Invalid arguments, prompt > 50 KB, or pre-dispatch error. |
| `2` | **API / Network Failure** | Jules API rate-limit (429), `FAILED_PRECONDITION`, or timeout. |
| `3` | **Scope Violation** | Attempted modification of protected/forbidden files. |
| `4` | **OODA Exhausted / Regression** | Verification failed after max repair attempts or thrash loop. |
| `5` | **Diff Payload Exceeded** | Git diff exceeds payload budget (`limits.diffKb`, default 75 KB). |
| `6` | **Secret Detected** | High-confidence secret or token detected in patch diff. |
| `7` | **Budget Exhausted** | Daily task session quota limit reached (`limits.dailyTasks`, default 300). |

---

## 🤝 Join the Community & Field-Testing

We are actively field-testing `v0.20.0` across 300+ daily autonomous sessions and opening the kit to the Google Jules developer community for feedback and contributions!

- **Test & Benchmark**: Clone the repository, test your edge cases, and run parallel swarms against your codebases.
- **Report Issues**: Found a bug, state race condition, or edge-case failure? Open an issue on GitHub.
- **Submit PRs**: We welcome contributions! Ensure all additions preserve our Zero Runtime Dependency invariant and pass `npm test` & `npm run lint`.

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
