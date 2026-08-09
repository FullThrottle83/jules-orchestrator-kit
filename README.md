# jules-orchestrator-kit

*Disclaimer: This is an independent open-source orchestration tool for Google Jules and is not officially affiliated with or endorsed by Google.*

[![Jules PR Audit](https://github.com/FullThrottle83/jules-orchestrator-kit/actions/workflows/jules-audit.yml/badge.svg)](https://github.com/FullThrottle83/jules-orchestrator-kit/actions/workflows/jules-audit.yml)
[![npm version](https://img.shields.io/npm/v/jules-orchestrator-kit.svg)](https://www.npmjs.com/package/jules-orchestrator-kit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org)

> **Zero-dependency safety kernel for autonomous AI agent swarms.**  
> Built specifically to execute 300+ daily agent sessions and parallel swarms safely with zero external runtime dependencies. Built strictly on native Node.js 20+ ESM standard library.

---

## 🏗️ Architecture Layer Diagram

```text
===================================================================================
                   JULES ORCHESTRATOR KIT — ARCHITECTURE LAYERS                    
===================================================================================

 +-------------------------------------------------------------------------------+
 |                              GOVERNANCE PLANE                                 |
 |  +--------------------+  +--------------------+  +-------------------------+  |
 |  | Scope Guard        |  | Secret Scanner     |  | Risk Classifier         |  |
 |  | (builtin & custom) |  | (entropy > 3.6b)   |  | (R0 Cosmetic - R3 Restr)|  |
 |  +--------------------+  +--------------------+  +-------------------------+  |
 |  +--------------------+  +--------------------+  +-------------------------+  |
 |  | Prompt Firewall    |  | Dynamic Guardrails |  | Flaky Test Quarantine   |  |
 |  | (injection strip)  |  | (rule budget sync) |  | (Wilson CI / Exit 8)    |  |
 |  +--------------------+  +--------------------+  +-------------------------+  |
 +----------------------------------------+--------------------------------------+
                                          |
                                          v
 +-------------------------------------------------------------------------------+
 |                              EXECUTION PLANE                                  |
 |  +--------------------+  +--------------------+  +-------------------------+  |
 |  | Agent Envelope     |  | Task DAG Engine    |  | OODA Auto-Repair        |  |
 |  | (sanitized payload)|  | (Kahn's / Fingerpr)|  | (3-strike thrash guard) |  |
 |  +--------------------+  +--------------------+  +-------------------------+  |
 |  +--------------------+  +--------------------+  +-------------------------+  |
 |  | Process Group Mgr  |  | Hermetic Net Guard |  | 3-Way Structural Merger |  |
 |  | (detached / SIGKILL|  | (ERR_UNMOCKED_NET) |  | (AST/JSON & block diff) |  |
 |  +--------------------+  +--------------------+  +-------------------------+  |
 +----------------------------------------+--------------------------------------+
                                          |
                                          v
 +-------------------------------------------------------------------------------+
 |                                KERNEL PLANE                                   |
 |  +--------------------+  +--------------------+  +-------------------------+  |
 |  | VFS Mutex          |  | Telemetry Spine    |  | Stdio MCP Stream        |  |
 |  | (linearizable CAS) |  | (O(1) SHA-256 chain)|  | (Content-Length 4MB)    |  |
 |  +--------------------+  +--------------------+  +-------------------------+  |
 |  +--------------------+  +--------------------+  +-------------------------+  |
 |  | Intent Journal     |  | Worktree Reaper    |  | Atomic Budget Ledger    |  |
 |  | (append-only sync) |  | (zombie PID prune) |  | (sliding window / proc) |  |
 |  +--------------------+  +--------------------+  +-------------------------+  |
 +-------------------------------------------------------------------------------+
===================================================================================
```

---

## ⚡ Quick Start Guide

### 1. Command Line Interface (`agentctl`)

Install globally or run via `npx`:

```bash
# Initialize orchestrator structure and configuration in target project
npx agentctl init

# Dispatch an autonomous coding task (Dry-run mode for local simulation)
JULES_DRY_RUN=1 npx agentctl dispatch \
  --title "Implement JWT Validator" \
  --prompt "Implement JWT validation middleware with unit tests"

# Run the 4-phase security and verification gatekeeper against current workspace
npx agentctl gate

# Launch parallel multi-agent swarm in isolated git worktrees
npx agentctl swarm
```

### 2. Model Context Protocol (MCP) Client Configuration (`agentctl-mcp`)

Connect `jules-orchestrator-kit` directly to **Claude Desktop**, **Cursor IDE**, or **Antigravity IDE** via native stdio MCP framing.

#### Claude Desktop Configuration (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "jules-orchestrator": {
      "command": "npx",
      "args": ["agentctl-mcp"],
      "env": {
        "JULES_API_KEY": "YOUR_JULES_API_KEY"
      }
    }
  }
}
```

#### Cursor / VS Code MCP Configuration (`.vscode/mcp.json`)

```json
{
  "mcpServers": {
    "agentctl-mcp": {
      "command": "npx",
      "args": ["-y", "jules-orchestrator-kit", "mcp"],
      "env": {
        "JULES_API_KEY": "YOUR_JULES_API_KEY"
      }
    }
  }
}
```

---

## 📝 Configuration Reference (`.agent/config.yml`)

The orchestrator reads configuration from `.agent/config.yml` (or legacy `.agent/jules.yml`). Scaffolded automatically via `agentctl init`:

```yaml
# Google Jules Repository Configuration
version: 2
tier: "ultra" # Preset options: free, pro, ultra (default: ultra)
provider: "jules"

# Automated verification suite commands (auto-detected if omitted)
test_cmd: "npm test"
build_cmd: "npm run build"

# Scope protection boundaries (builtin protections are automatically merged)
forbidden_paths:
  - ".github/**"
  - "package.json"
  - ".agent/config.yml"
  - ".agent/jules.yml"

allow_paths: []

# Operational limits & budgets
limits:
  dailyTasks: 300       # Maximum agent tasks per 24-hour cycle window
  repairAttempts: 3     # Maximum OODA auto-repair retries on test failure
  diffKb: 75            # Git diff payload ceiling in KB (Governor)
  concurrency: 3        # Maximum parallel worktree swarm workers
  staggerMs: 1000       # Dispatch stagger delay in milliseconds
```

---

## 🚦 Exit Code Reference Table

Standardized exit codes enforced across all CLI commands (`agentctl`), scripts, and CI/CD pipelines:

| Exit Code | Classification | Description & Immediate Remediation Action |
| :---: | :--- | :--- |
| `0` | **Gate Approved / Success** | Verification suite passed; task, audit, or gate operation completed cleanly. |
| `1` | **Git Base / Config Error** | Pre-dispatch argument error, missing git repository root, invalid prompt (>50 KB), or bad configuration. |
| `2` | **API / Network Failure** | Jules REST API HTTP 429 rate-limit, `FAILED_PRECONDITION` quota limit, or connection timeout. |
| `3` | **Scope Guard Violation** | Attempted modification of protected/forbidden files (`package.json`, `.github/`, deployment keys). |
| `4` | **Verification Failure** | Unit test or build command failed after 3 OODA auto-repair attempts or hit non-convergent loop. |
| `5` | **Diff Payload Governor** | Post-change git diff exceeded maximum payload budget (`limits.diffKb`, default >75 KB limit). |
| `6` | **Secret Scanner Finding** | High-confidence secret, API token, or SSH private key detected in diff (Shannon entropy > 3.6 bits). |
| `7` | **Budget Exhausted** | Daily task session quota limit reached (`limits.dailyTasks`, default 300 per 24h cycle). |
| `8` | **FLAKY_QUARANTINE** | Statistical test flakiness detected (oscillation >= 0.4, Wilson CI); OODA repair suppressed. |
| `124` | **Execution Timeout** | Subprocess execution exceeded hard execution timeout limit (default 10 minutes). |
| `188` | **ERR_UNMOCKED_NET** | Unmocked outbound HTTP/HTTPS egress intercepted during test execution by hermetic network guard. |

---

## 🛡️ Security Model & Honest Boundaries

### Security Guarantees

1. **Zero-Trust Scope Fencing**: Scope guard enforces strict forbidden path lists (`.github/`, credentials, agent rules). User additions complement builtin rules without override vulnerabilities.
2. **Shannon Entropy Secret Scanner**: Scans diffs for high-confidence secrets (AWS, Stripe, GitHub tokens, RSA private keys) using Shannon Entropy analysis (> 3.6 bits).
3. **Hermetic Network Guard (`ERR_UNMOCKED_NET`)**: Intercepts unmocked outbound HTTP/HTTPS egress during verification runs (`node:http`, `node:https`, `fetch`), enforcing offline-first hermetic execution while permitting local loopback.
4. **Prompt Firewall (`src/prompt-guard.mjs`)**: Neutralizes prompt injection patterns, strips zero-width unicode, bidi control characters, and ANSI escape codes before payloads reach LLM context boundaries.
5. **Linearizable VFS Directory Mutex (`src/state.mjs`)**: CAS directory mutex guarantees serial linearizability across multi-process swarms. Process start time validation against `/proc/<pid>/stat` prevents stale lock corruption from recycled OS process IDs.
6. **O(1) SHA-256 Telemetry Hash-Spine (`src/telemetry.mjs`)**: Cryptographically links all session events in an append-only ledger with automatic head-desync self-healing.

### Honest System Boundaries

- **Zero External Dependencies**: The orchestrator core uses **100% native Node.js ESM modules** (`node:fs`, `node:path`, `node:crypto`, `node:child_process`, `node:stream`). No supply-chain dependency risk.
- **Diff Governor Envelope Ceiling**: Hard diff payload limit of 75 KB prevents hidden payload injection and API payload truncation.
- **Process Subtree Cleanup**: `ProcessGroupManager` creates detached process groups and handles system termination signals (`SIGINT`/`SIGTERM`) to kill whole subtrees, guaranteeing zero zombie processes.
- **Rule Verification Scope**: Security checks are evaluated strictly against `origin/main` baseline to prevent untrusted PR branches from modifying their own guardrails.

---

## 🤝 Contributing & Testing

```bash
# Clone repository
git clone https://github.com/FullThrottle83/jules-orchestrator-kit.git
cd jules-orchestrator-kit

# Run ESLint and comprehensive unit test suite
npm run lint
npm test
```

---

## 📄 License

Distributed under the [MIT License](LICENSE).
