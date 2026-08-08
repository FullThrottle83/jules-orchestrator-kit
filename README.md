# jules-orchestrator-kit

*Disclaimer: This is an independent open-source orchestration tool and is not officially affiliated with or endorsed by Google.*

[![Jules PR Audit](https://github.com/FullThrottle83/jules-orchestrator-kit/actions/workflows/jules-audit.yml/badge.svg)](https://github.com/FullThrottle83/jules-orchestrator-kit/actions/workflows/jules-audit.yml)
[![npm version](https://img.shields.io/npm/v/jules-orchestrator-kit.svg)](https://www.npmjs.com/package/jules-orchestrator-kit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Turn Google Jules into an autonomous code builder that writes, tests, and fixes itself.**  
The orchestrator automates verification, scopes file boundaries, and prevents Jules from breaking your CI.

> [!WARNING]
> **Alpha Release:** Active development. Exercise caution before integrating into critical production pipelines. Always start with `JULES_DRY_RUN=1`.

---

## ⚡ 30-Second Quick Start

```bash
# 1. Initialize orchestrator in your repository
npx jules-orchestrator-kit init

# 2. Dispatch a task (Dry Run mode)
JULES_DRY_RUN=1 agentctl dispatch --title "Refactor Auth" --prompt "Implement JWT validation"

# 3. Audit workspace safety gates
agentctl gate
```

> 💡 **Unified Engine CLI (`agentctl`)**: Zero-dependency executable powering dispatching, safety gate auditing, mutex locks, and swarm management across all project types (Node, Rust, Go, Python, etc.).

---

## 🎯 Choose Your Path

| I want to... | Role / Goal | Jump To |
| :--- | :--- | :--- |
| 🚀 **Add Jules to my repo** | App Developer / Junior | [Quick Start & Setup](#-30-second-quick-start) & [Configuration](#-complete-reference-manual) |
| 🤖 **Connect to Cursor/Claude/SDK** | AI Engineer / SDK User | [MCP & SDK Integration](#-complete-reference-manual) |
| 🛡️ **Enforce Security & CI/CD** | DevOps / Security Engineer | [Security Invariants](#%EF%B8%8F-core-security--reliability-invariants) & [Exit Codes](#-complete-reference-manual) |

---

## 🔄 How It Works

```text
[ 1. Dispatch Task ] ──► [ 2. Isolated Worktree ] ──► [ 3. Safety Gatekeeper ] ──► [ 4. OODA Auto-Repair ] ──► [ 5. PR Ready ]
```

1. **Dispatch Task:** Define prompt, title, and target scope (`agentctl dispatch`).
2. **Execution Sandbox:** Jules applies code in an isolated Git worktree.
3. **Safety Gatekeeper:** Audits scope (`forbidden_paths`), secret entropy, and test/build commands.
4. **OODA Auto-Repair:** If tests fail, auto-corrects with stderr traces up to 3 attempts with thrash protection.
5. **Safe Delivery:** Exit Code 0 proves 100% verification pass before pushing PR.

🔍 *For a deep dive into the complete execution sequence, see [Architecture & Pipeline Flow](docs/architecture.md).*

---

## 🛡️ Core Security & Reliability Invariants

- **[Capability-Bounded Execution Envelope (CBEE)](file:///home/jonas/WebDev/jules-orchestrator-kit/src/execution_envelope.mjs):** Immutably binds `baseSha`, `configSha`, `scope`, and `verifyCmds` before dispatch to prevent runtime scope drift.
- **[Zero-Trust Base Resolution](file:///home/jonas/WebDev/jules-orchestrator-kit/src/git.mjs#L60):** Security rules (`forbidden_paths`) are fetched strictly from `origin/main` (never untrusted PR branches).
- **[OODA Thrash & State Fingerprinting](file:///home/jonas/WebDev/jules-orchestrator-kit/src/engine.mjs#L14):** SHA-256 state fingerprinting over stderr and diffs halts repair loops early (`DETERMINISTIC_REGRESSION`, Exit Code 4) to save API tokens.
- **[Hash-Chain State Ledger](file:///home/jonas/WebDev/jules-orchestrator-kit/src/state.mjs#L48):** SHA-256 cryptographic hash-chaining over JSONL audit logs detects record tampering or reordering.
- **[Secret & PII Redaction](file:///home/jonas/WebDev/jules-orchestrator-kit/src/security.mjs#L35):** Entropy scanner (> 3.6 bits) redacts API keys and masks PII (emails, IPs, phone numbers) before outbound dispatches.

---

## 📖 Complete Reference Manual

<details>
<summary><b>⚙️ Configuration (.agent/jules.yml)</b></summary>

The orchestrator auto-detects your tech stack, but `.agent/jules.yml` provides fine-grained control:

```yaml
version: 2
test_cmd: "npm test"
build_cmd: "npm run build"
forbidden_paths:
  - ".github/**"
  - "**/secrets/**"
  - "**/*.pem"
  - "**/lock-manager/**"
  - "scripts/jules-*"
  - ".agent/jules.yml"
allow_paths: []
```
</details>

<details>
<summary><b>🔌 Model Context Protocol (MCP) & SDK Reference</b></summary>

### 1. Native MCP Server (`npx jules-mcp`)
Connect `jules-orchestrator-kit` directly as a stdio Model Context Protocol (MCP) server to AI tools like **Antigravity**, **Claude Desktop**, and **Cursor**:

```json
{
  "mcpServers": {
    "jules-orchestrator": {
      "command": "npx",
      "args": ["-y", "jules-orchestrator-kit", "mcp"]
    }
  }
}
```

*Exposed MCP Tools:* `dispatch_jules_task`, `audit_jules_gate`, `check_risk_tier`, `get_jules_status`.

### 2. Programmatic Node.js SDK (`index.mjs`)
```js
import { gate, dispatch, createExecutionEnvelope, fingerprintFailureState } from "jules-orchestrator-kit";

// Dispatch task programmatically
await dispatch({ title: "Refactor Auth", prompt: "Implement JWT validation" });

// Run 4-phase safety gatekeeper audit
const audit = await gate({ base: "main" });
```
</details>

<details>
<summary><b>🛠️ CLI Command Reference (agentctl & npm scripts)</b></summary>

| Command | Description |
| :--- | :--- |
| `agentctl init` / `npm run init` | Initializes orchestrator & `.agent/` directory |
| `agentctl gate` / `npm run jules:audit` | Runs 4-phase safety gatekeeper audit |
| `agentctl dispatch` / `npm run jules:dispatch` | Dispatches single task to Jules |
| `agentctl queue` / `npm run jules:queue` | Runs local queue processor (`.agent/jules-queue`) |
| `agentctl status` / `npm run jules:status` | Shows real-time 3-bucket status |
| `agentctl mcp` / `npx jules-mcp` | Starts stdio MCP JSON-RPC 2.0 server |
| `agentctl swarm` / `npm run jules:swarm` | Launches multi-agent swarm in parallel worktrees |
| `agentctl merge-swarm` / `npm run jules:merge-swarm` | Autonomous PR merge engine with Safety Gate lock |
| `agentctl scan` / `npm run jules:scan` | Scans codebase for TODO/FIXME comments |
| `agentctl cleanup` / `npm run jules:cleanup` | Audits and closes merged or stale REST sessions |
</details>

<details>
<summary><b>🔐 Environment Variables Reference</b></summary>

| Variable | Description | Default |
| :--- | :--- | :--- |
| `JULES_API_KEY` | Google Jules REST API key | *(none)* |
| `JULES_REPO` | Target GitHub Repository (`owner/repo`) | Auto-detected |
| `JULES_DRY_RUN` | Set to `1` or `true` for dry-run simulation | `false` |
| `JULES_DAILY_BUDGET` | Daily max session budget | `300` |
| `JULES_MAX_DIFF_KB` | Max git diff payload limit in KB | `50` |
| `JULES_ALLOW_COMMAND_FILE_CHANGES` | Allow PR changes to command files (`package.json`, etc.) | `false` |
| `JULES_ALLOW_AGENT_RULE_CHANGES` | Allow PR changes to agent rule files (`AGENTS.md`, etc.) | `false` |
| `BASE_BRANCH` | Base branch for PR Audits & Merge-Base | `main` |
| `JULES_SWARM_CONCURRENCY` | Maximum parallel dispatches for swarm runs | `3` |
| `JULES_SWARM_STAGGER_MS` | Dispatch stagger interval in ms | `1500` |
| `NO_COLOR` | Set to `true` to disable ANSI color output | `false` |
</details>

<details>
<summary><b>🚦 Exit Code Registry</b></summary>

| Code | Classification | Description |
| :--- | :--- | :--- |
| `0` | **Success** | All tests, security checks, and gate audits passed cleanly. |
| `1` | **Pre-Dispatch / Arg Error** | Invalid arguments, prompt > 50 KB, or premise validation failure. |
| `2` | **API / Network Error** | HTTP 429 rate limit or worker quota limit. |
| `3` | **Security / Scope Breach** | Modified file breached `forbidden_paths` or command files. Fails closed. |
| `4` | **Verification / Thrash Exhausted** | Tests failed and OODA repair loop exhausted retries or hit deterministic regression. |
| `5` | **Diff Payload Limit** | Diff payload size exceeded governor limit (`JULES_MAX_DIFF_KB`). |
| `6` | **Secret Leak Prevented** | High-confidence secret or private key pattern detected in diff. |
| `7` | **Budget Exhausted** | Daily session budget limit reached. |
</details>

<details>
<summary><b>🌐 Supported Tech Stacks & Auto-Detection</b></summary>

| Stack / Ecosystem | Manifest File | Test Command | Build Command |
| :--- | :--- | :--- | :--- |
| **Turborepo** | `turbo.json` | `npx turbo run test` | `npx turbo run build` |
| **pnpm Workspace** | `pnpm-workspace.yaml` | `pnpm test` | `pnpm build` |
| **Nx Workspace** | `nx.json` | `npx nx run-many -t test` | `npx nx run-many -t build` |
| **JavaScript / TypeScript** | `package.json` | `npm test` | `npm run build` |
| **Rust** | `Cargo.toml` | `cargo test --workspace` | `cargo build` |
| **Go** | `go.mod` | `go test ./...` | `go build ./...` |
| **Python** | `pyproject.toml` | `pytest` | *(none)* |
| **Bun / Deno** | `bunfig.toml` / `deno.json` | `bun test` / `deno test` | `bun run build` |
| **Elixir / Ruby / Swift** | `mix.exs` / `Gemfile` / `Package.swift` | `mix test` / `rake test` | *(standard build)* |
| **Java / C / C++** | `pom.xml` / `Makefile` | `mvn test` / `make test` | `mvn compile` / `make` |
</details>

---

## 🤝 Contributing & Standards

1. **Zero Runtime Dependencies**: Use ONLY native Node.js ESM built-ins (`node:fs`, `node:path`, `node:crypto`, `node:child_process`).
2. **100% Verification Suite**: All unit tests must pass cleanly (`npm test`).
3. **Cross-Platform Compatibility**: Normalize Windows backslashes (`\`) to POSIX slashes (`/`).

## 📄 License
MIT License - Open Source and free to use.
