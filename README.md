# Google Jules Orchestration Kit 🤖⚡

[![npm version](https://img.shields.io/npm/v/jules-orchestrator-kit.svg)](https://www.npmjs.com/package/jules-orchestrator-kit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-blue.svg)](#)

A lightweight, zero-dependency toolkit that upgrades **Google Jules** into a **fully autonomous, self-correcting background code builder** for any repository (Next.js, Vite, Node, Bun, Deno, Python, Go, Rust, Elixir, Ruby, Swift, Java, C/C++, Monorepos, etc.).

> **TL;DR**: Don't just chat with Google Jules—put it to work. Run `npx jules-orchestrator-kit` inside your project. Assign tasks, and the kit will automatically test the AI's code, tell it to fix any mistakes, and only present you with working, tested Pull Requests.

---

## 🎯 Who is this for?

**🌱 For Everyday Developers:**  
AI agents can write broken code or skip tests. This kit acts as an automated safety net: it detects your tech stack, runs your tests against the AI's code, catches errors, and prompts the AI to self-correct *before* you review the Pull Request.

**🔥 For Power Users & Senior Engineers:**  
Unlock deterministic, production-grade orchestration. Includes Git Worktree multi-task swarms, Shannon Entropy secret redaction, MCP (Model Context Protocol) directive envelopes, OODA self-healing feedback loops, and scope boundary locks.

---

## ⚡ 1-Step Quick Setup for Any Project

Run this command inside the root of **any target repository**:

```bash
npx jules-orchestrator-kit

# Or launch the interactive setup wizard:
npx jules-init --interactive
```

---

## 🧠 How It Works: The Autonomous Loop

Instead of blindly trusting AI code mutations, the Orchestrator acts as a strict manager enforcing a **Tiered Verification Gate**:

1. **Queue a Task:** Dispatch via CLI, REST API, or drop markdown files into `.agent/jules-queue/`.
2. **Secret & Path Defense:** Hides passwords, API keys (Shannon Entropy > 3.6), and blocks path traversal (`../`).
3. **Jules Proposes Code:** Google Jules mutates code in an isolated environment.
4. **Tiered Verification:** Enforces scope bounds (`git diff`), runs fast-fail linters/type-checks, then executes full test/build suites.
5. **Self-Correction (OODA Loop):** If tests fail, stderr traces are fed back to Jules to self-correct (up to 4 attempts).
6. **Clean Pull Request:** Once verified green, commits & pushes clean code to GitHub.

*(System Architecture Sequence Diagram):*

```mermaid
sequenceDiagram
    autonumber
    participant CLI as CI Trigger / CLI
    participant Orc as jules-orchestrator
    participant Jules as Google Jules Agent
    participant Git as Git Worktree Sandbox

    CLI->>Orc: Dispatch Task ("Refactor Auth")
    
    note over Orc,Git: Phase 1: Isolation & Setup
    Orc->>Orc: Redact Secrets & Check Path Traversal
    Orc->>Git: Provision Worktree (`git worktree add`)
    Orc->>Jules: Dispatch Context, Invariants & Target Scope

    loop Max Retries (Attempts < 4)
        Jules->>Git: Propose Code Mutations
        
        note over Orc,Git: Phase 2: Tiered Verification
        Orc->>Git: Scope Audit (`git diff --name-only` vs forbidden_paths)
        alt Scope Breach
            Git-->>Orc: Scope Violation Error
        else Scope OK
            Orc->>Git: Run Fast-Fail Checks (Lint / Typecheck)
            opt Pass Static Checks
                Orc->>Git: Run Heavy Suite (`build_cmd` & `test_cmd`)
            end
        end

        alt Verification Gates Pass
            Orc->>Git: Commit, Push & Cleanup Worktree
            Orc->>CLI: Return Success + Metrics (.agent/history/metrics.jsonl)
            note over Jules,Git: Exit Loop
        else Verification Gates Fail (Attempts < 4)
            Git-->>Orc: Execution Trace (stdout/stderr / Diff)
            Orc->>Jules: Inject OODA Feedback & Error Context
        end
    end

    opt Verification Gates Fail (Attempts >= 4)
        Orc->>Git: Abort & Rollback Worktree (`git worktree remove --force`)
        Orc->>CLI: Return Terminal Failure (.agent/history/errors.jsonl)
    end
```

---

<details open>
<summary><b>💡 Core Capabilities (8 Component Suite)</b></summary>

### 🛠️ The Basics

1. **Auto-Configuration (`bin/init.js`)**: Instantly scaffolds your repo using `node:util.parseArgs` with interactive TTY wizard (`-i, --interactive`) and silent CI fallback.
2. **Queue Runner (`scripts/jules-queue-runner.mjs`)**: Drop markdown task specifications into `.agent/jules-queue/` and let the runner process them sequentially.
3. **Nightly Maintenance (`scripts/jules-nightly.mjs`)**: Schedules automated background audits (security leak scans, WCAG accessibility checks, dead code pruning, unused env var cleanup).

### 🔒 Security & Guardrails

4. **Secret & Traversal Redaction (`scripts/jules-dispatch.mjs`)**: Shannon Entropy detector strips API keys and secrets ($\text{entropy} > 3.6$, length $\ge 20$) while preserving valid file paths. Supports dry-run testing (`JULES_DRY_RUN=1`).
5. **Dynamic Guardrails (`.agent/rules/dynamic-guardrails.json`)**: RegEx-based rule matching that injects targeted stack guardrails into prompts on-the-fly.

### 🐝 Advanced Orchestration

6. **Monorepo Boundary Resolver (`scripts/command-resolver.mjs`)**: Auto-detects `turbo`, `nx`, `pnpm`, or `Cargo` workspaces to run targeted affected package verifications (`git diff`) instead of full-repo test suites.
7. **Self-Healing Gatekeeper (`scripts/jules-self-audit.mjs`)**: Unshallows git history in CI runners (`git fetch --unshallow`), enforces `forbidden_paths`, extracts OODA feedback error traces, and logs telemetry to `.agent/history/metrics.jsonl`.
8. **Git Worktree Swarms (`scripts/jules-swarm.mjs`)**: Manages multi-task batches in isolated Git worktrees (`JULES_USE_WORKTREES=true`) with scope boundary isolation.

</details>

---

<details>
<summary><b>🛠️ Supported Language Manifests & Workspace Graphs (15+ Tech Stacks)</b></summary>

| Stack / Ecosystem | Manifest / Workspace File | Default Verification Command |
|---|---|---|
| **Turborepo** | `turbo.json` | `npx turbo run test --filter=<pkg>...` |
| **pnpm Workspace** | `pnpm-workspace.yaml` | `pnpm --filter=...<pkg> test` |
| **Nx Workspace** | `nx.json` | `npx nx run-many -t test -p <pkg> --with-deps` |
| **Bun** | `bunfig.toml` / `bun.lockb` | `bun test && bun run build` |
| **Deno** | `deno.json` / `deno.jsonc` | `deno test && deno task build` |
| **JavaScript / TypeScript** | `package.json` | `npm run lint && npm test` (or `npm run check:all`) |
| **Rust** | `Cargo.toml` | `cargo test -p <pkg>` / `cargo test --workspace` |
| **Go** | `go.mod` | `go test ./... && go build ./...` |
| **Python** | `pyproject.toml` / `requirements.txt` | `pytest` |
| **Elixir** | `mix.exs` | `mix test && mix compile` |
| **Ruby** | `Gemfile` | `bundle exec rake test` |
| **Swift** | `Package.swift` | `swift test && swift build` |
| **Java (Maven)** | `pom.xml` | `mvn test && mvn compile` |
| **Java (Gradle)** | `build.gradle` | `./gradlew test && ./gradlew assemble` |
| **C / C++** | `Makefile` | `make test && make build` |
| **Custom Config (v2)** | `.agent/jules.yml` | Configurable `test_cmd`, `build_cmd`, `forbidden_paths` & `allow_paths` |

</details>

---

<details>
<summary><b>📖 Usage Recipes & Workflows (Single Tasks, Swarms, Queue, Nightly)</b></summary>

### 1. Dispatch a single task to Jules

```bash
# Dry-run test prompt payload locally without executing remote API/CLI
JULES_DRY_RUN=1 node scripts/jules-dispatch.mjs "Refactor rate limiter" "Implement sliding window rate limiting in src/utils/rate-limit.ts"

# Real dispatch
node scripts/jules-dispatch.mjs "Refactor rate limiter" "Implement sliding window rate limiting in src/utils/rate-limit.ts"
```

### 2. Dispatch an entire queue of markdown task specifications

```bash
npm run jules:queue
```

### 3. Run Rate-Limited Swarm with Scope Isolation

```bash
JULES_SWARM_CONCURRENCY=5 JULES_USE_WORKTREES=true node scripts/jules-swarm.mjs tasks.json
```

Where `tasks.json` supports file boundary `scope` segregation to prevent parallel task collisions:
```json
[
  { "id": "t1", "title": "Refactor Auth", "prompt": "Refactor auth middleware to ESM", "scope": ["src/auth/**"] },
  { "id": "t2", "title": "Fix Memory Leak", "prompt": "Fix listener memory leak in websocket event loop", "scope": ["src/ws/**"] }
]
```

### 4. Run Nightly Maintenance Suite

```bash
node scripts/jules-nightly.mjs --dry-run
```

### 5. Audit Jules PRs before merging

```bash
node scripts/jules-self-audit.mjs
```

</details>

---

<details>
<summary><b>🌐 Integration Interfaces: CLI, REST API & MCP Directives</b></summary>

`jules-orchestrator-kit` supports three primary integration channels:

### 1. Direct REST API Mode (`jules.googleapis.com`)
When `JULES_API_KEY` and `JULES_REPO` are present in your environment (`.env` or CI secrets), `scripts/jules-dispatch.mjs` dispatches payloads directly to the official Google Jules REST API endpoint:
```http
POST https://jules.googleapis.com/v1alpha/sessions
X-Goog-Api-Key: $JULES_API_KEY
Content-Type: application/json
```
- Handles HTTP 429 rate limits gracefully without falling back to CLI.
- Automatically maps `startingBranch` (`BASE_BRANCH` or `main`) and `sourceContext`.

### 2. Native Jules CLI Fallback (`jules new`)
If `JULES_API_KEY` is omitted or unconfigured, `jules-dispatch.mjs` seamlessly falls back to invoking the local `jules` CLI binary:
```bash
jules new --repo owner/repo
```
Prompts are piped directly via `stdin` to bypass OS `ARG_MAX` shell argument length limits.

### 3. MCP (Model Context Protocol) Directives
All task dispatches dynamically inject `<MCP_DIRECTIVE>` envelopes into task prompts:
```xml
<MCP_DIRECTIVE>
  <system_state>HEADLESS_CI_MODE</system_state>
  <strict_invariants>
    <rule>1. READ-BEFORE-WRITE: Inspect symbol definitions before editing.</rule>
    <rule>2. VERIFICATION LOOP: Execute test_cmd and build_cmd and pass with 0 errors.</rule>
    <rule>3. ABORT CONDITION: Terminate on 4+ repeated test failures.</rule>
    <rule>4. ASSERTION QUALITY: Unit tests created or modified MUST contain explicit assertions.</rule>
  </strict_invariants>
</MCP_DIRECTIVE>
```
This forces Jules to adhere to strict read-before-write invariants and deterministic execution when operating alongside MCP server tools.

</details>

---

<details>
<summary><b>⚙️ Configuration & Zero-Trust Security (`.agent/jules.yml`)</b></summary>

```yaml
# Google Jules Repository Configuration (Version 2)
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

> 🛡️ **Zero-Trust Security Model**: `allow_paths` and `forbidden_paths` rules are read **strictly from the target base branch** (`origin/main`), never from untrusted PR branches. Even if an AI agent tries to modify its own security rules in a PR branch, the Orchestrator enforces the rules defined on `main`.

</details>

---

<details>
<summary><b>🤝 Contributing & Code Guidelines</b></summary>

We welcome contributions! Please follow these core principles when submitting Pull Requests:

1. **Zero External Dependencies**: Keep the orchestrator engine 100% dependency-free. Use ONLY native Node.js built-in modules (`node:fs`, `node:path`, `node:child_process`, `node:crypto`, `node:util`).
2. **Verification Suite**: Ensure 100% of unit tests pass cleanly (`npm test`).
3. **Conventional Commits**: Use standardized commit message prefixes (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
4. **Cross-Platform Compatibility**: Always normalize Windows backslashes (`\`) to POSIX slashes (`/`) for glob patterns and paths.

</details>

---

## 📜 License & Disclaimer

MIT License - feel free to use, modify, and share!

*Disclaimer: This is an independent open-source orchestration tool and is not officially affiliated with or endorsed by Google.*
