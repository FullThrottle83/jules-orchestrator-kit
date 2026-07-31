# jules-orchestrator-kit

*Disclaimer: This is an independent open-source orchestration tool and is not officially affiliated with or endorsed by Google.*

[![Jules PR Audit](https://github.com/FullThrottle83/jules-orchestrator-kit/actions/workflows/jules-audit.yml/badge.svg)](https://github.com/FullThrottle83/jules-orchestrator-kit/actions/workflows/jules-audit.yml)
[![npm version](https://img.shields.io/npm/v/jules-orchestrator-kit.svg)](https://www.npmjs.com/package/jules-orchestrator-kit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Turn Google Jules into an autonomous code builder that writes, tests, and fixes itself.**
The orchestrator automates verification, scopes file boundaries, and prevents Jules from breaking your CI.

> [!WARNING]
> **Alpha Release:** This kit is in active development. Please exercise caution before integrating it into critical production pipelines.

> [!CAUTION]
> **Task Limit Warning:** Autonomous loops can quickly consume your daily API limits. We strongly recommend starting with `JULES_DRY_RUN=1` to understand the workflow before scaling up.

### Quick Start
Navigate to your project root and run:
```bash
npx jules-orchestrator-kit
npm run jules:create "Refactor Auth"
npm run jules:queue
```

---

## How It Works

1. **You Assign Task:** Define what needs fixing or building.
2. **Jules Writes Code:** Proposes changes in an isolated Git worktree sandbox.
3. **Run Tests & Linters:** The Gatekeeper runs your test suite, linters, and type checks.
4. **Self-Correction:** If anything fails, Jules automatically retries with fixes (OODA loop).
5. **Safe Delivery:** Once tests pass, the PR is verified and ready for review.

> 💡 **Core Architectural Invariants**:
> - **Zero-Trust Base-Branch Security**: Security rules (`forbidden_paths`) are fetched exclusively from `origin/main` (never untrusted PR branches).
> - **Dynamic Command Resolution (`command-resolver.mjs`)**: Auto-detects workspace boundaries (Turborepo, pnpm, Nx, Cargo, pytest, npm).
>
> 🔍 For a deep dive into the execution protocol, see the [Architecture & Pipeline Flow](docs/architecture.md).

---

## Configuration

The orchestrator automatically detects your tech stack, but you can edit `.agent/jules.yml` for fine-grained control:

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

---

## Expand with MCP

All task dispatches dynamically inject `<MCP_DIRECTIVE>` envelopes into task prompts. This forces Jules to adhere to strict read-before-write invariants.

You can supercharge Jules with external MCP servers by connecting them to your environment, granting Jules direct access to your infrastructure and real-time documentation. Examples:
* **SaaS APIs & Tooling:** Context 7, Linear, and v0.
* **Databases & Cloud:** Render, Neon, Supabase, Stitch.
* **Framework Documentation:** Astro Docs, Cloudflare Docs, Next.js Docs.

---

## Supported Tech Stacks

| Stack / Ecosystem           | Manifest / Workspace File             | Test Command                             | Build Command                            |
| --------------------------- | ------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| **Turborepo**               | `turbo.json`                          | `npx turbo run test --filter=...`        | `npx turbo run build --filter=...`       |
| **pnpm Workspace**          | `pnpm-workspace.yaml`                 | `pnpm --filter=... test`                 | `pnpm --filter=... build`                |
| **Nx Workspace**            | `nx.json`                             | `npx nx run-many -t test -p ...`         | `npx nx run-many -t build -p ...`        |
| **Bun**                     | `bunfig.toml` / `bun.lockb`           | `bun test`                               | `bun run build`                          |
| **Deno**                    | `deno.json` / `deno.jsonc`            | `deno test`                              | `deno task build`                        |
| **JavaScript / TypeScript** | `package.json`                        | `npm test`                               | `npm run build`                          |
| **Rust**                    | `Cargo.toml`                          | `cargo test --workspace`                 | `cargo build`                            |
| **Go**                      | `go.mod`                              | `go test ./...`                          | `go build ./...`                         |
| **Python**                  | `pyproject.toml` / `requirements.txt` | `pytest`                                 | *(none)*                                 |
| **Elixir**                  | `mix.exs`                             | `mix test`                               | `mix compile`                            |
| **Ruby**                    | `Gemfile`                             | `bundle exec rake test`                  | *(none)*                                 |
| **Swift**                   | `Package.swift`                       | `swift test`                             | `swift build`                            |
| **Java (Maven/Gradle)**     | `pom.xml` / `build.gradle`            | `mvn test` / `./gradlew test`            | `mvn compile` / `./gradlew assemble`     |
| **C / C++**                 | `Makefile`                            | `make test`                              | `make build`                             |

---

## Reference Material

### CLI Commands
All commands are registered in `package.json` and can be run via `npm run <command>`.

| Command | Description |
| ------- | ----------- |
| `npm run init` | Initializes the orchestrator and `.agent/` directory |
| `npm run test` | Runs the orchestrator kit's own unit tests |
| `npm run jules:dispatch` | Dispatches a single task directly to Jules |
| `npm run jules:queue` | Runs the local queue processor (picks up tasks from `.agent/jules-queue`) |
| `npm run jules:create` | Scaffolds a new boilerplate task markdown file |
| `npm run jules:status` | Shows the real-time status of all queued and completed tasks |
| `npm run jules:audit` | Runs the self-audit gatekeeper (verifies tests, forbidden paths, and scope) |
| `npm run jules:cleanup` | Cleans up orphaned worktrees and lockfiles |
| `npm run jules:scan` | Scans the codebase for TODO/FIXME comments and generates a suggested tasks file |
| `npm run jules:swarm` | Launches a multi-agent swarm in parallel across isolated worktrees |
| `npm run jules:nightly` | Nightly maintenance job (usually triggered in CI) |

### Environment Variables

| Variable | Description |
| -------- | ----------- |
| `JULES_API_KEY` | Your Google Jules REST API key (required for API mode). |
| `JULES_REPO` | Target repository name/identifier. |
| `JULES_DRY_RUN` | Set to `1` to run without executing mutating API calls. |
| `BASE_BRANCH` | The target base branch for security checks (defaults to `main`). |
| `CI` | Set automatically in CI environments; alters fallback behaviors. |
| `ALLOW_AUTO_REPAIR` | Set to `1` to allow OODA repair loops in CI environments. |
| `JULES_WEB_SETUP` | Cryptographic handshake token for web integration. |
| `GITHUB_HEAD_REF` | Used during PR self-audit to determine branch context. |
| `DATABASE_URL` | Sterilized during pre-flight sandbox tests. |
| `NPM_TOKEN` | Sterilized during pre-flight sandbox tests. |
| `GITHUB_TOKEN` / `GH_TOKEN` | Sterilized during pre-flight sandbox tests. |
| `AWS_ACCESS_KEY_ID` | Sterilized during pre-flight sandbox tests. |
| `STRIPE_TEST_KEY` | Sterilized during pre-flight sandbox tests. |

*(Note: There are other internal variables used during execution, but these are the primary ones for users).*

### Exit Codes
The Gatekeeper (`jules-self-audit.mjs` and related scripts) uses standard exit codes to signal status to CI systems.

| Code | Meaning | Action Taken |
| ---- | ------- | ------------ |
| `0`  | **Success** | All tests and security checks passed. |
| `1`  | **General Error** | Missing dependencies, syntax error, or general failure. Execution aborted. |
| `2`  | **Setup / Context Error** | Git not found, invalid `BASE_BRANCH`, or shallow history preventing merge-base calculation. |
| `3`  | **Security Violation** | Modified file breached `forbidden_paths` or `allow_paths` boundary. Fails closed immediately. |
| `4`  | **Verification Exhausted** | Tests failed and the OODA Auto-Repair loop either exhausted its max retries or is disabled. |

---

## Contributing
We welcome contributions! Please follow these core principles:
1. **Zero External Dependencies**: Use ONLY native Node.js built-in modules (`node:fs`, `node:path`, `node:child_process`, `node:crypto`, `node:util`).
2. **Verification Suite**: Ensure 100% of unit tests pass cleanly (`npm test`).
3. **Conventional Commits**: Use standardized prefixes (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
4. **Cross-Platform Compatibility**: Normalize Windows backslashes (`\`) to POSIX slashes (`/`) for glob patterns and paths.

Please read our [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

## License
MIT License - feel free to use, modify, and share!
