# Google Jules Orchestration Kit

A lightweight, framework-agnostic toolkit for turning **Google Jules** into a deterministic, autonomous background code builder for any repository (Next.js, Vite, Node, Bun, Deno, Python, Go, Rust, Elixir, Ruby, Swift, Java, C/C++, Monorepos, etc.).

> **TL;DR**: Don't use Google Jules like a chat assistant. Use it as an autonomous background worker. Run `npx github:FullThrottle83/jules-orchestrator-kit` inside any repository to automatically detect your tech stack, generate prompt guardrails, set up test/build verification gates, and install Jules orchestration scripts.

---

## ⚡ 1-Step Quick Setup for Any Project

Run this command inside the root of **any target repository**:

```bash
npx github:FullThrottle83/jules-orchestrator-kit
```

This single command will:
1. **Detect your tech stack & workspace structure** (Node, Bun, Deno, Rust, Go, Python, Elixir, Ruby, Swift, Java, C/C++, Turborepo, Nx, pnpm) via `command-resolver.mjs`.
2. **Generate `AGENTS.md`** pre-populated with pre-execution `<MCP_DIRECTIVE>` rules and verification invariants.
3. **Create `.agent/jules.yml` (v2 Schema)** pre-configured with detected test/build commands and glob-based `forbidden_paths`.
4. **Install `.agent/rules/dynamic-guardrails.json`** for RegEx-based dynamic prompt guardrail injection.
5. **Install orchestration scripts** into `./scripts/` (`jules-dispatch.mjs`, `jules-self-audit.mjs`, `jules-swarm.mjs`, `jules-queue-runner.mjs`, `jules-nightly.py`).

---

## 💡 What This Toolkit Provides

1. **Init Scaffolding CLI (`bin/init.js`)**: Auto-scaffolds any repo in 1 second.
2. **Monorepo & Command Resolver (`scripts/command-resolver.mjs`)**: Auto-detects project manifests and monorepo workspace graphs (`turbo.json`, `pnpm-workspace.yaml`, `nx.json`, `Cargo.toml` workspaces) to run targeted affected package verifications instead of full-repo test suites.
3. **Dynamic Guardrail Composition (`.agent/rules/dynamic-guardrails.json`)**: RegEx-based rule matching that injects targeted stack guardrails into prompts on-the-fly.
4. **Pre-Flight Secret Redaction & REST/stdin Dispatcher (`scripts/jules-dispatch.mjs`)**: Auto-redacts API keys (`ghp_`, `AKIA`, `sk-`, `Bearer`, RSA keys), streams prompts over REST / stdin to bypass OS `ARG_MAX` shell limits, and handles HTTP 429 rate limits.

5. **PR Self-Auditor & Glob Boundary Gatekeeper (`scripts/jules-self-audit.mjs`)**: Unshallows git history in CI runners (`git fetch --unshallow`), filters token bloat, enforces dynamic glob-based security boundaries (`forbidden_paths`), and runs scoped workspace test suites.
6. **Queue Runner (`scripts/jules-queue-runner.mjs`)**: Iterates through `.agent/jules-queue/`, dispatches queued markdown tasks, and moves finished tasks to `.agent/jules-queue/completed/`.
7. **Rate-Limited Swarm Orchestrator (`scripts/jules-swarm.mjs`)**: Manages multi-task batches with controlled concurrency (`JULES_SWARM_CONCURRENCY`, default 3), staggered dispatches (1.5s interval), and batch cooldowns to eliminate API rate-limit thrashing.
8. **Nightly Maintenance Suite (`scripts/jules-nightly.py`)**: Schedules automated background audits (security leak scans, WCAG accessibility checks, dead code pruning, unused env var cleanup).

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

### Run Rate-Limited Swarm Dispatch

```bash
JULES_SWARM_CONCURRENCY=5 node scripts/jules-swarm.mjs tasks.json
```

### Run Nightly Maintenance Suite

```bash
python3 scripts/jules-nightly.py --dry-run
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


