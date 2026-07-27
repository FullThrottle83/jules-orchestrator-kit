# Google Jules Orchestration Kit

A lightweight, framework-agnostic toolkit for turning **Google Jules** into a deterministic, autonomous background code builder for any repository (Next.js, Vite, Node, Python, Go, Rust, Java, etc.).

> **TL;DR**: Don't use Google Jules like a chat assistant. Use it as an autonomous background worker. This toolkit grounds Jules with pre-execution documentation lookups (`MCP DIRECTIVE`), dynamic language test/build command auto-discovery, PR self-auditing against merge-base, CI shallow-clone defense, and scheduled nightly maintenance audits.

---

## 💡 Why This Toolkit Exists

Most developers find AI coding agents like Jules slow or inaccurate because they treat them like interactive chat assistants. Jules is an **autonomous background developer**. 

This toolkit provides:
1. **Dynamic Command Resolution (`scripts/command-resolver.mjs`)**: Auto-detects project manifests (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `pom.xml`, `build.gradle`, `Makefile`, `.agent/jules.yml`) to inject the exact build and test verification commands per language.
2. **Dynamic Guardrail Composition (`.agent/rules/dynamic-guardrails.json`)**: RegEx-based rule matching that injects targeted stack guardrails into prompts on-the-fly.
3. **CLI & REST Dispatcher (`scripts/jules-dispatch.mjs`)**: Auto-injects dynamic guardrails, bypasses OS `ARG_MAX` payload limits via ephemeral files, and handles HTTP 429 backoff.
4. **PR Self-Auditor (`scripts/jules-self-audit.mjs`)**: Automatically unshallows git history in CI runners (`git fetch --unshallow`), filters out lockfiles/binary bloat, checks restricted boundaries, and runs test suites.
5. **Queue Runner (`scripts/jules-queue-runner.mjs`)**: Iterates through `.agent/jules-queue/`, dispatches queued markdown tasks, and moves finished tasks to `.agent/jules-queue/completed/`.
6. **Swarm Orchestrator (`scripts/jules-swarm.mjs`)**: Runs multi-task batches in parallel with `Promise.allSettled()` and 15-minute TTL timeouts.
7. **Nightly Maintenance Suite (`scripts/jules-nightly.py`)**: Schedules automated background audits (security leak scans, WCAG accessibility checks, dead code pruning, unused env var cleanup).
8. **Directives Template (`JULES_RULES_TEMPLATE.md`)**: A framework-agnostic rule set with machine-readable XML `<MCP_DIRECTIVE>` envelopes.

---

## 🚀 Quick Setup for Any Project

### Step 1: Copy rules into your project
Copy `JULES_RULES_TEMPLATE.md` to `AGENTS.md` or `JULES.md` at the root of your target repository:

```bash
cp JULES_RULES_TEMPLATE.md /path/to/your-repo/AGENTS.md
```

### Step 2: Add scripts to your repo
Copy the `scripts/` directory into your project:

```bash
cp -r scripts/ /path/to/your-repo/scripts/
```

### Step 3: Dispatch a task to Jules

```bash
node scripts/jules-dispatch.mjs "Refactor rate limiter" "Implement sliding window rate limiting using Redis. Must pass tests."
```

Or process an entire queue of markdown task specifications:

```bash
npm run jules:queue
```

### Step 4: Run Nightly Maintenance

```bash
python3 scripts/jules-nightly.py --dry-run
```

### Step 5: Audit Jules PRs before merging

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

## 🎯 Core Operating Principles

1. **MCP-First Directive**: Force Jules to fetch current framework & library documentation *before* writing code (`MCP DIRECTIVE: ...`).
2. **Dynamic Verification Mandate**: Every prompt mandates execution of language-specific build & test suites before PR creation.
3. **Zero Token Bloat**: Excludes lockfiles (`package-lock.json`, `Cargo.lock`), minified bundles, and binary assets from diff representations.
4. **Restricted Boundaries**: Prevents Jules from modifying CI/CD workflows (`.github/`), security scripts, or dangerous database migrations without explicit approval.

---

## 📜 License

MIT License - feel free to use, modify, and share!
