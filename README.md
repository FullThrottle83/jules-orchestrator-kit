# Google Jules Orchestration Kit

[![npm version](https://img.shields.io/npm/v/jules-orchestrator-kit.svg)](https://www.npmjs.com/package/jules-orchestrator-kit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-blue.svg)](#)

A lightweight, zero-dependency toolkit for turning **Google Jules** into a deterministic, autonomous background code builder for any repository (Next.js, Vite, Node, Bun, Deno, Python, Go, Rust, Elixir, Ruby, Swift, Java, C/C++, Monorepos, etc.).

> **TL;DR**: Don't use Google Jules like a chat assistant. Use it as an autonomous background worker. Run `npx jules-orchestrator-kit` inside any repository to automatically detect your tech stack, generate prompt guardrails, set up test/build verification gates, and install Jules orchestration scripts.

---

## ⚡ 1-Step Quick Setup for Any Project

Run this command inside the root of **any target repository**:

```bash
npx jules-orchestrator-kit
# or launch interactive setup wizard
npx jules-init --interactive
```

This single command will:
1. **Detect your tech stack & workspace structure** (Node, Bun, Deno, Rust, Go, Python, Elixir, Ruby, Swift, Java, C/C++, Turborepo, Nx, pnpm) via `command-resolver.mjs`.
2. **Generate `AGENTS.md`** pre-populated with pre-execution `<MCP_DIRECTIVE>` rules and verification invariants.
3. **Create `.agent/jules.yml` (v2 Schema)** pre-configured with detected test/build commands and glob-based `forbidden_paths`.
4. **Install `.agent/rules/dynamic-guardrails.json`** for RegEx-based dynamic prompt guardrail injection.
5. **Install orchestration scripts** into `./scripts/` (`jules-dispatch.mjs`, `jules-self-audit.mjs`, `jules-swarm.mjs`, `jules-queue-runner.mjs`, `jules-nightly.mjs`).

---

## 🧠 Architecture: The Autonomous Loop

```mermaid
sequenceDiagram
    participant CLI as CI Trigger / CLI
    participant Orc as jules-orchestrator
    participant Jules as Google Jules Agent
    participant Git as Git Worktree Sandbox

    CLI->>Orc: Dispatch Task ("Refactor Auth")
    Orc->>Orc: Redact Secrets (Entropy & Patterns) + Path Traversal Defense
    Orc->>Jules: Dispatch Context & Invariants
    Jules->>Git: Propose Code Mutations
    Orc->>Git: Execute Stack `build_cmd` & `test_cmd`
    alt Verification Gates Fail
        Git-->>Orc: stdout/stderr Trace
        Orc->>Jules: Inject OODA Feedback Logs for Self-Correction
    else Verification Gates Pass
        Orc->>Git: Determinism Verified -> Commit & Push
        Orc->>CLI: Metrics Logged (.agent/history/metrics.jsonl)
    end
```

---

## 💡 What This Toolkit Provides

1. **Init Scaffolding CLI (`bin/init.js`)**: Auto-scaffolds any repo using `node:util.parseArgs` with interactive TTY wizard (`-i, --interactive`) and silent CI fallback.
2. **Monorepo & Command Resolver (`scripts/command-resolver.mjs`)**: Auto-detects project manifests and monorepo workspace graphs (`turbo.json`, `pnpm-workspace.yaml`, `nx.json`, `Cargo.toml` workspaces) to run targeted affected package verifications (`git diff`) instead of full-repo test suites.
3. **Dynamic Guardrail Composition (`.agent/rules/dynamic-guardrails.json`)**: RegEx-based rule matching that injects targeted stack guardrails into prompts on-the-fly.
4. **Shannon Entropy Redaction & REST/stdin Dispatcher (`scripts/jules-dispatch.mjs`)**:
   - **Shannon Entropy Redaction**: Auto-redacts API keys and high-entropy secret tokens ($\text{entropy} > 3.6$, length $\ge 20$) alongside pattern matching (`ghp_`, `AKIA`, `sk-`, `Bearer`, RSA keys).
   - **Path Traversal Defense**: Enforces canonical `realpathSync` boundaries to block directory traversal (`../`) and symlink attacks.
   - **Payload Streaming**: Streams prompts over REST / stdin to bypass OS `ARG_MAX` shell limits and handle HTTP 429 rate limits.
5. **PR Self-Auditor & Self-Healing Gatekeeper (`scripts/jules-self-audit.mjs`)**: Unshallows git history in CI runners (`git fetch --unshallow`), enforces `forbidden_paths`, extracts OODA feedback error traces on test failures, and logs telemetry to `.agent/history/metrics.jsonl`.
6. **Transactional Queue Runner (`scripts/jules-queue-runner.mjs`)**: Iterates through `.agent/jules-queue/`, dispatches queued markdown tasks, moves completed tasks, and logs status transitions (`RUNNING`, `COMPLETED`, `FAILED`) to `.agent/jules-queue/queue.jsonl`.
7. **Git Worktree Swarm Orchestrator (`scripts/jules-swarm.mjs`)**: Manages multi-task batches in isolated Git worktrees (`JULES_USE_WORKTREES=true`) with controlled concurrency (`JULES_SWARM_CONCURRENCY`), staggered dispatches, and batch cooldowns.
8. **Nightly Maintenance Suite (`scripts/jules-nightly.mjs`)**: Schedules automated background audits (security leak scans, WCAG accessibility checks, dead code pruning, unused env var cleanup).

---

## 🛠️ Usage Examples

### Dispatch a single task to Jules

```bash
node scripts/jules-dispatch.mjs "Refactor rate limiter" "Implement sliding window rate limiting using Redis. Must pass tests."
```

### Dispatch an entire queue of markdown task specifications

```bash
npm run jules:queue
```

### Run Rate-Limited Swarm in Isolated Git Worktrees

```bash
JULES_SWARM_CONCURRENCY=5 JULES_USE_WORKTREES=true node scripts/jules-swarm.mjs tasks.json
```

Where `tasks.json` is formatted as:
```json
[
  { "id": "t1", "title": "Refactor Auth", "prompt": "Refactor auth middleware to ESM" },
  { "id": "t2", "title": "Fix Memory Leak", "prompt": "Fix listener memory leak in websocket event loop" }
]
```

### Run Nightly Maintenance Suite

```bash
node scripts/jules-nightly.mjs --dry-run
```

### Audit Jules PRs before merging

```bash
node scripts/jules-self-audit.mjs
```

---

## 🛠️ Supported Language Manifests & Workspace Graphs

The command resolver automatically sniffs your codebase and invokes the right verification chain:

| Stack / Ecosystem | Manifest / Workspace File | Default Verification Command |
|---|---|---|
| **Turborepo** | `turbo.json` | `npx turbo run test --filter=<pkg>...` |
| **pnpm Workspace** | `pnpm-workspace.yaml` | `pnpm --filter=...<pkg> test` |
| **Nx Workspace** | `nx.json` | `npx nx run-many -t test -p <pkg> --with-deps` |
| **Bun** | `bunfig.toml` / `bun.lockb` | `bun test && bun run build` |
| **Deno** | `deno.json` / `deno.jsonc` | `deno test && deno task build` |
| **JavaScript / TypeScript** | `package.json` | `npm run check:all` or `npm test` |
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

---

## ⚙️ Configuration (`.agent/jules.yml`)

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

> 🛡️ **Security Trust Model**: `allow_paths` is read **strictly from the target base branch** (`origin/main`), never from untrusted PR branches. Any path specified in `allow_paths` on `main` overrides the immutable default forbidden paths for automated background workers.

---

## 📜 License & Disclaimer

MIT License - feel free to use, modify, and share!

*Disclaimer: This is an independent open-source orchestration tool and is not officially affiliated with or endorsed by Google.*



