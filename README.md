# Google Jules Orchestration Kit

A lightweight, framework-agnostic toolkit for turning **Google Jules** into a deterministic, autonomous background code builder for any repository (Next.js, Vite, Node, Python, Go, Rust, Java, etc.).

> **TL;DR**: Don't use Google Jules like a chat assistant. Use it as an autonomous background worker. Run `npx github:FullThrottle83/jules-orchestrator-kit` inside any repository to automatically detect your tech stack, generate prompt guardrails, set up test/build verification gates, and install Jules orchestration scripts.

---

## ⚡ 1-Step Quick Setup for Any Project

Run this command inside the root of **any target repository**:

```bash
npx github:FullThrottle83/jules-orchestrator-kit
```

This single command will:
1. **Detect your tech stack** (Node, Rust, Go, Python, Java, C/C++) via `command-resolver.mjs`.
2. **Generate `AGENTS.md`** pre-populated with pre-execution `<MCP_DIRECTIVE>` rules and verification invariants.
3. **Create `.agent/jules.yml`** pre-configured with detected `test_cmd` and `build_cmd`.
4. **Install `.agent/rules/dynamic-guardrails.json`** for RegEx-based dynamic prompt guardrail injection.
5. **Install orchestration scripts** into `./scripts/` (`jules-dispatch.mjs`, `jules-self-audit.mjs`, `jules-swarm.mjs`, `jules-queue-runner.mjs`, `jules-nightly.py`).

---

## 💡 What This Toolkit Provides

1. **Init Scaffolding CLI (`bin/init.js`)**: Auto-scaffolds any repo in 1 second.
2. **Dynamic Command Resolution (`scripts/command-resolver.mjs`)**: Auto-detects project manifests (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `pom.xml`, `build.gradle`, `Makefile`, `.agent/jules.yml`) to inject exact build and test commands per language.
3. **Dynamic Guardrail Composition (`.agent/rules/dynamic-guardrails.json`)**: RegEx-based rule matching that injects targeted stack guardrails into prompts on-the-fly.
4. **CLI & REST Dispatcher (`scripts/jules-dispatch.mjs`)**: Auto-injects dynamic guardrails, bypasses OS `ARG_MAX` payload limits via ephemeral files, and handles HTTP 429 backoff.
5. **PR Self-Auditor (`scripts/jules-self-audit.mjs`)**: Automatically unshallows git history in CI runners (`git fetch --unshallow`), filters out lockfiles/binary bloat, checks restricted boundaries, and runs test suites.
6. **Queue Runner (`scripts/jules-queue-runner.mjs`)**: Iterates through `.agent/jules-queue/`, dispatches queued markdown tasks, and moves finished tasks to `.agent/jules-queue/completed/`.
7. **Swarm Orchestrator (`scripts/jules-swarm.mjs`)**: Runs multi-task batches in parallel with `Promise.allSettled()` and 15-minute TTL timeouts.
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

### Run Nightly Maintenance Suite

```bash
python3 scripts/jules-nightly.py --dry-run
```

### Audit Jules PRs before merging

```bash
node scripts/jules-self-audit.mjs
```

---

## 🛠️ Supported Language Manifests

The command resolver automatically sniffs your codebase and invokes the right verification chain:

| Language | Manifest File | Default Test & Build Commands |
|---|---|---|
| **JavaScript / TypeScript** | `package.json` | `npm run check:all && npm test && npm run build` |
| **Rust** | `Cargo.toml` | `cargo test --workspace && cargo build` |
| **Go** | `go.mod` | `go test ./... && go build ./...` |
| **Python** | `pyproject.toml` / `requirements.txt` | `pytest` |
| **Java (Maven)** | `pom.xml` | `mvn test && mvn compile` |
| **Java (Gradle)** | `build.gradle` | `./gradlew test && ./gradlew assemble` |
| **C / C++** | `Makefile` | `make test && make build` |
| **Custom** | `.agent/jules.yml` | User-defined `test_cmd` & `build_cmd` |

---

## 📜 License

MIT License - feel free to use, modify, and share!
