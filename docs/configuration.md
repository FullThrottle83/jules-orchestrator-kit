# Configuration Reference

How `jules-orchestrator-kit` resolves, validates, and overrides configuration in any repository.
For the guided setup path, start with the [README Quickstart](../README.md#quickstart); this page is the exhaustive reference.

---

## How Configuration Resolves

The kit derives configuration directly from repository manifests across five core dimensions:

| Dimension | Resolution Mechanism | Inspect / Override |
| :--- | :--- | :--- |
| **Monorepo Scope** | Monorepo diffs resolve to affected sub-projects (`verify.scope: affected`), widening to root commands when shared files change. Activated automatically when monorepo manifests are detected. | `agentctl check --json`<br/>`verify.scope` in `.agent/config.yml` |
| **Stack & Tooling** | `detectPolyglotStack()` inspects 26+ ecosystems (Cargo, Go, Python, Bun, Deno, Maven, Gradle, .NET, PHP, Ruby, Elixir, Swift, Flutter, CMake, Make, Turbo/pnpm/Nx) and extracts native test and build commands. | `agentctl doctor`<br/>`verify:` in `.agent/config.yml` |
| **Agent Provider** | Supports Google Jules (hosted REST), Claude Code CLI, OpenAI Codex CLI, and Gemini CLI. Validates environment credentials for hosted APIs and `PATH` binaries for local agents. | `agentctl providers`<br/>`agentctl init --provider <name>` |
| **Verification Depth** | `verify.profile` (`minimal`, `standard`, `max`) expands dynamically into stack-compatible verification stages, reporting explicit skip reasons for unsupported platform checks. | `agentctl profile`<br/>`agentctl profile --set max` |
| **CI Generation** | Generates tailored CI workflows containing the project's native runtime and toolchain rather than copying a fixed template. | `agentctl ci init [--target github\|gitlab]` |

## `.agent/config.yml` Reference

`jules-orchestrator-kit` auto-detects stack defaults, but allows explicit overrides through `.agent/config.yml`:

```yaml
# .agent/config.yml — Universal Orchestrator Configuration

version: 1
provider: "jules"        # Provider key ("jules" | "claude-code" | "codex" | "gemini-flash")
baseBranch: "main"       # Default target base branch
branchPrefix: "agent/"   # Prefix for task branches

# Verification commands (auto-detected by Stack Detector if omitted)
verify:
  test: "npm test"
  build: "npm run build"
  timeout_ms: 300000     # Per-stage kill time in ms (default 300000)
  minTests: 1            # Floor for "the suite actually ran" (0 disables)
  required: true         # false = this repo uses only the scope/secret phases

# Scope protection rules (Deny-first evaluation)
scope:
  deny:
    - ".github/**"
    - "keys/**"

# Plan tier. Defaults to `free` when unset — the kit will not assume you are
# paying for a larger plan than you are. Set this to unlock your real limits.
tier: "free"             # free | pro | ultra

# Risk model for auto-merge triage. Builtin patterns cover what is dangerous in
# any repository (CI, lockfiles, migrations, key material, IaC, auth). Add the
# paths that are sensitive to YOUR domain — these EXTEND the builtins.
risk:
  restricted:            # R3 — never auto-merged
    - "**/pricing/**"
    - "**/billing/**"
  consequential:         # R2 — always requires a human read
    - "packages/api/**"
  max_routine_diff_lines: 400

# Operational limits & governors (tier defaults shown; any key here overrides)
limits:
  diffKb: 75             # Diff Payload Governor limit
  promptKb: 50           # Maximum prompt payload size
  dailyTasks: 300        # Task quota per rolling 24h window (not per calendar day)
  repairAttempts: 3      # Maximum repair iterations
  concurrency: 15        # Worker slots (defaults free: 3, pro: 8, ultra: 15)

# Dynamic Complexity & Cost Router — opt-in, disabled by default.
router:
  enabled: false
  fast: "gemini-flash"    # Trivial/mechanical tasks (score <= threshold)
  complex: "jules"        # Complex/multi-file/safety-sensitive tasks
  threshold: 0            # Heuristic score threshold for escalation
```

## Agent Providers

- **Google Jules** (`jules`) — hosted REST API; requires `JULES_API_KEY`. Jules runs in Google's cloud against the connected GitHub repository and opens the PR itself.
- **Claude Code** (`claude-code`), **OpenAI Codex** (`codex`), **Gemini CLI** (`gemini-flash`) — local CLI providers executed on this machine against the local checkout; "ready" means the binary is on `PATH` (it does not prove the CLI is signed in).

```bash
# Which agents can this machine dispatch to, and what is missing for the rest?
agentctl providers

# Switch the active provider without re-running onboarding
agentctl provider set claude-code
```

## Environment Variables

Every knob answers to both spellings — `AGENT_*` (vendor-neutral) and `JULES_*` (legacy). Where both are set, the `JULES_*` spelling wins. Examples: `AGENT_API_KEY` / `JULES_API_KEY`, `AGENT_REPO` / `JULES_REPO`, `AGENT_SWARM_CONCURRENCY` / `JULES_SWARM_CONCURRENCY`. See [.env.example](../.env.example) for the full list.

## Supported Languages, Frameworks & Stacks

```
Ecosystems Natively Detected & Verified by Stack Detector:
├── Python / Django (pyproject.toml, requirements.txt, setup.py, manage.py)
├── Systems / Rust Cargo (Cargo.toml)
├── Systems / Go (go.mod)
├── Systems / CMake & Make (CMakeLists.txt, Makefile)
├── JS / TS Workspaces (turbo.json, pnpm-workspace.yaml, nx.json)
├── JS / TS Runtimes (bunfig.toml, deno.json, package.json)
├── PHP / Laravel / WordPress (composer.json, phpunit.xml, pest.php, artisan, wp-cli.yml)
├── .NET / C# / F# (*.sln, *.csproj, *.fsproj, global.json)
├── Mobile / Dart / Flutter (pubspec.yaml)
├── Mobile / Swift / Xcode (Package.swift)
├── Mobile / React Native (app.json, react-native.config.js)
├── Web3 / Solidity Foundry (foundry.toml, remappings.txt) — offline-enforced
├── Web3 / Solidity Hardhat (hardhat.config.js, hardhat.config.ts)
├── Elixir / Phoenix (mix.exs)
├── Ruby / Rails (Gemfile)
├── Java / Maven & Gradle (pom.xml, build.gradle, build.gradle.kts)
└── Devcontainers & Docker Compose (.devcontainer/devcontainer.json, docker-compose.yml, Dockerfile)
```

## Related

- [Architecture & Pipeline Flow](architecture.md) — how the resolved config drives the dispatch and verification pipelines.
- [CLI Command Reference](COMMAND_REFERENCE.md) — every flag, generated from the command registry.
- [SDK & MCP Integrations](sdk.md) — programmatic provider failover, cost routing, and MCP tool aliases.
