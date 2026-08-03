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

## Prerequisites
To use this kit, you will need:
- Node.js `18.0.0` or higher
- `git` installed and available in your PATH
- A Google Jules REST API key (set as `JULES_API_KEY`) **OR** the native `jules` binary in your PATH.

## Quick Start
Initialize your repository:
```bash
npx jules-orchestrator-kit init
```

Dispatch a task or run the queue using `agentctl`:
```bash
agentctl dispatch --title "Refactor Auth" --prompt "Implement JWT verification in auth handler"
agentctl queue
agentctl gate
```

> 💡 **Unified Engine CLI (`agentctl`)**:
> `agentctl` is the zero-dependency CLI executable that powers dispatching, safety gate auditing, mutex locks, and swarm management across all project types (Node, Rust, Go, Python, etc.).
> Legacy `scripts/jules-*.mjs` shims are preserved for backward compatibility.

---

## How It Works

1. **You Assign Task:** Define what needs fixing or building (supports text and multimodal image mockups).
2. **Jules Writes Code:** Proposes changes in an isolated Git worktree sandbox.
3. **Run Tests & Linters:** The Gatekeeper runs your test suite, linters, and type checks.
4. **Self-Correction:** If anything fails, Jules automatically retries with fixes (OODA loop).
5. **Safe Delivery:** Once tests pass, the PR is verified and ready for review.

```mermaid
sequenceDiagram
    autonumber
    
    box "Client Edge" #F4F4F4
        actor Trigger as Client (CLI / CI / SDK)
    end
    
    box "Control Plane" #E8F4F8
        participant Orc as Orchestrator Core
        participant Gate as Self-Audit Gatekeeper
    end
    
    box "Execution Sandbox" #F8E8E8
        participant API as Google Jules API
        participant Git as Git Worktree Sandbox
    end

    Trigger->>+Orc: Dispatch Task Payload
    
    note over Orc,Git: Phase 1: Security Redaction & Provisioning
    Orc->>Orc: Redact Secrets (Entropy > 3.6) & Enforce Dynamic Guardrails
    Orc->>+Git: Provision Isolation Sandbox (git worktree)
    Git-->>-Orc: Sandbox Ready
    
    loop OODA Repair Cycle (Max 3 Retries)
        note over Orc,Git: Phase 2: Agent Execution & Dispatch
        Orc->>+API: Dispatch Task + <MCP_DIRECTIVE> & Target Scope
        API->>+Git: Apply Proposed Code Changes
        Git-->>-API: Changes Written
        API-->>-Orc: Execution Complete
        
        note over Orc,Gate: Phase 3: Tiered Verification & Gatekeeping
        Orc->>+Gate: Trigger Self-Audit (trusted origin/main rules)
        
        Gate->>+Git: Scope Audit (`git diff -z --name-only` vs forbidden_paths)
        Git-->>-Gate: Diff Stats & File List
        
        alt Scope Breach (Forbidden Path OR Diff Payload > 75 KB)
            Gate-->>Orc: Security / Scope Violation Detected
            Orc->>Orc: Record Telemetry (metrics.jsonl)
            Orc-->>Trigger: Abort Execution (Exit 3)
            break Fatal Security Error
                Orc->>Git: Teardown Worktree Sandbox
            end
        else Scope Verification Passed
            Gate->>+Git: Run Dynamic Verification (`testCmd` & `buildCmd`)
            Git-->>-Gate: stdout / stderr verification results
        end

        alt 100% Verification Suite Passed
            Gate-->>-Orc: Verification Success
            Orc->>+Git: Commit & Push to Remote Branch / PR
            Git-->>-Orc: PR Ready
            Orc->>Orc: Record Telemetry (metrics.jsonl)
            Orc-->>Trigger: Dispatch Succeeded (Exit 0)
            break Task Completed
                Orc->>Git: Teardown Worktree Sandbox
            end
        else Verification Failed
            Gate-->>Orc: Verification Failed (Stderr Trace output)
            Orc->>Orc: Record Failure Telemetry
            
            alt Retries Remaining (< 3)
                Orc->>Orc: Construct Repair Prompt with Stderr Trace
            else Max Retries Exceeded (3/3)
                Orc-->>-Trigger: Abort & Log Diagnostic Feedback (Exit 4)
                Orc->>Git: Teardown Worktree Sandbox
            end
        end
    end
```

> 💡 **Core Architectural Invariants**:
> - **Zero-Trust Base-Branch Security**: Security rules (`forbidden_paths`) are fetched exclusively from `origin/main` (never untrusted PR branches).
> - **Automatic PII & Secret Redaction**: Outbound task prompts are automatically sanitized to redact API secrets and mask sensitive PII (emails, IPs, phone numbers).
> - **Ledger Hash-Chain Integrity**: Hashing over JSONL event streams detects unauthorized log tampering or record deletions.
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

## Integration Interfaces

The orchestrator supports three primary integration channels:

**1. Direct REST API Mode (`jules.googleapis.com`)**
When `JULES_API_KEY` and `JULES_REPO` are present in your environment, payloads are dispatched directly to the official Google Jules REST API endpoint. Handles HTTP 429 rate limits gracefully.

**2. Native Jules CLI Fallback**
If no API key is configured, the kit seamlessly falls back to invoking your local `jules` CLI binary via standard streams.

**3. Programmatic Node.js SDK (`index.mjs`)**
Downstream Node.js tools, MCP servers, and LLM orchestrators can import kit functions directly:
```js
import { gate, dispatch, anonymizePii, redactSecrets, acquireLock } from "jules-orchestrator-kit";

// Anonymize sensitive PII (emails, IPs, phone numbers) before sending prompts
const cleanPrompt = anonymizePii("Contact support at john@example.com");

// Programmatically dispatch tasks
await dispatch({ title: "Refactor Auth", prompt: cleanPrompt });

// Run 4-phase safety gate audit
const audit = await gate({ base: "main" });
```

---

## Known Limitations

**Code Suggestions (Web UI Only)**
Currently, there is no way to automatically extract "Suggestions" (the inline code review comments Jules sometimes proposes instead of direct commits) via the CLI or API. Suggestions can only be read directly inside the **Jules Web UI**.

*Workaround for Local LLM Users:* If you are tinkering with Jules alongside a local LLM and Jules leaves a Suggestion, the easiest workflow is to open the Jules Web UI, copy the suggestion block, and paste it back into your local LLM.

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
| `npm run jules:status` | Shows real-time 3-bucket status (Action Required, In Progress, Completed) |
| `npm run jules:audit` | Runs the self-audit gatekeeper (verifies tests, forbidden paths, and scope) |
| `npm run jules:cleanup` | Audits and closes merged or stale REST sessions |
| `npm run jules:scan` | Scans the codebase for TODO/FIXME comments and generates a suggested tasks file |
| `npm run jules:swarm` | Launches a multi-agent swarm in parallel across isolated worktrees |
| `npm run jules:merge-swarm` | Autonomous PR merge engine with Safety Gate lock verification |
| `npm run jules:nightly` | Nightly maintenance job (usually triggered in CI) |

### Specialist Agent Prompts & Templates (`.agent/prompts/`)
The kit includes pre-configured single-responsibility prompt presets in `.agent/prompts/`:
- **`Overseer.md`**: Codebase architecture auditor & technical debt mapper.
- **`Bolt.md`**: Performance micro-optimizer and payload governor (enforces < 75 KB payload diff limits).
- **`Sentinel.md`**: Security audit specialist for input sanitization and secret scanning.
- **`Task_Template.md`**: Machine-readable master task prompt template schema.

### Environment Variables

| Variable | Description |
| -------- | ----------- |
| `JULES_API_KEY` | Your Google Jules REST API key (required for API mode) |
| `GEMINI_API_KEY` | Alias for `JULES_API_KEY` (fallback) |
| `JULES_API_URL` | Override the Jules REST API URL |
| `JULES_REPO` | Target GitHub Repository (Format: `owner/repo`) |
| `JULES_REPOLESS` | Set to `true` or `1` to run in repoless/serverless mode |
| `JULES_DRY_RUN` | Set to `true` or `1` to simulate dispatching without making API calls |
| `JULES_DAILY_BUDGET` | Daily max session budget for autonomous dispatches (Default: `300`) |
| `JULES_MAX_DIFF_KB` | Maximum git diff payload size in KB before aborting with Exit Code 5 (Default: `50`) |
| `JULES_ALLOW_COMMAND_FILE_CHANGES` | Set to `true` to allow PR changes to command/config files like `package.json`, `tsconfig.json`, `vite.config.ts` (Default: `false`) |
| `JULES_ALLOW_AGENT_RULE_CHANGES` | Set to `true` to allow PR changes to agent rule files like `AGENTS.md`, `JULES_RULES_TEMPLATE.md` (Default: `false`) |
| `BASE_BRANCH` | Base branch for PR Audits & Merge-Base calculations (Default: `main`) |
| `GITHUB_HEAD_REF` | PR Head Branch (Used dynamically by CI during OODA repair) |
| `JULES_PROJECT_ROOT` | Root directory of the project (Auto-assigned during swarm executions) |
| `JULES_SWARM_CONCURRENCY` | Maximum parallel dispatches for swarm runs (Default: `3`) |
| `JULES_SWARM_STAGGER_MS` | Dispatch stagger interval in milliseconds (Default: `1500`) |
| `JULES_PACE_MS` | Rate-limit for the `jules:queue` command (Default: `500`) |
| `JULES_USE_WORKTREES` | Use Git Worktrees instead of cloning for swarm isolation (Default: `false`) |
| `JULES_SLOT_INDEX` | Current slot index for partitioning tasks (Swarm mode) |
| `JULES_SLOT_TOTAL` | Total number of slots for partitioning tasks (Swarm mode) |
| `CI` | Set to `true` to change log output and fail-fast behaviors for CI environments |
| `ALLOW_AUTO_REPAIR` | Set to `true` to allow OODA Auto-Repair even when running in CI |
| `GITHUB_STEP_SUMMARY` | GitHub Actions Step Summary File Path |
| `NO_COLOR` | Set to `true` to disable ANSI color output |

> [!NOTE]
> **Scope Enforcement via `allow_paths`**
> In `.agent/jules.yml`, defining `allow_paths` acts as a strict allowlist (deny-by-default). When non-empty, any file modified outside `allow_paths` will trigger a security violation (Exit Code 3). `forbidden_paths` always take absolute precedence and cannot be overridden.

### Exit Codes
The Gatekeeper (`jules-self-audit.mjs` and related scripts) uses standard exit codes to signal status to CI systems.

| Code | Meaning | Action Taken |
| ---- | ------- | ------------ |
| `0`  | **Success** | All tests and security checks passed. |
| `1`  | **Pre-Dispatch / Arg Error** | Missing dependencies, prompt > 50 KB, syntax error, or pre-dispatch failure. |
| `2`  | **API / Network / Quota Error** | REST API HTTP 429 rate limit, HTTP 400 `FAILED_PRECONDITION` quota (~30 active limit), or connection timeout. |
| `3`  | **Security / Scope Violation** | Modified file breached `forbidden_paths` or changed command-defining files (`package.json`, `Cargo.toml`). Fails closed immediately. |
| `4`  | **Verification Exhausted** | Tests failed and the OODA Auto-Repair loop either exhausted its max retries (3) or is disabled. |
| `5`  | **Diff Payload Limit** | Diff payload size exceeded payload governor budget (`JULES_MAX_DIFF_KB`, default 50 KB). Split task. |
| `6`  | **Secret Leak Prevented** | High-confidence secret or private key pattern detected in diff. Aborted immediately. |
| `7`  | **Budget Exhausted** | Daily session budget limit reached or budget state locked. |

---

## Contributing
We welcome contributions! Please follow these core principles:
1. **Zero Runtime Dependencies**: Use ONLY native Node.js built-in modules (`node:fs`, `node:path`, `node:child_process`, `node:crypto`, `node:util`).
2. **Verification Suite**: Ensure 100% of unit tests pass cleanly (`npm test`).
3. **Conventional Commits**: Use standardized prefixes (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
4. **Cross-Platform Compatibility**: Normalize Windows backslashes (`\`) to POSIX slashes (`/`) for glob patterns and paths.

Please read our [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

## License
MIT License - feel free to use, modify, and share!
