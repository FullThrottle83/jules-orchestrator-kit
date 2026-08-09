# Onboarding and Task Wizard Specification

**Document:** `ONBOARDING_AND_TASK_WIZARD_SPEC.md`  
**Project:** `jules-orchestrator-kit`  
**Baseline:** `v0.28.2` (`bd3c1989b8b44489aca94049c2d6f945197a6058`)  
**Date:** 2026-08-10  
**Status:** Normative design specification  
**Audience:** maintainers, platform engineers, CLI engineers, security reviewers, and enterprise adopters

---

## 0. Executive summary

This document specifies a zero-third-party-runtime-dependency onboarding, configuration, preset, and task-authoring subsystem for `jules-orchestrator-kit`. It introduces two primary user journeys:

```text
agentctl init --interactive
agentctl task create
```

The design serves two very different users without creating two products:

- a novice who needs a safe, guided path from “connect my repository” to a well-scoped Jules task; and
- an expert who needs deterministic, headless, versioned configuration and machine-readable task envelopes.

The subsystem is divided into four modules:

| Module | Responsibility |
|---|---|
| **A. System Onboarding and Stack Oracle** | Detect repository/workspace topology, validate verification commands, configure Jules, select policy profiles, and atomically generate `.agent/` configuration. |
| **B. Guided Task Authoring and Scope Governor** | Convert intent, TODOs, or issues into falsifiable, scope-bounded, secret-scrubbed task envelopes. |
| **C. Preset and Extension Registry** | Load declarative, version-controlled workflow recipes from `.agent/presets/*.yml` without executing arbitrary extension code. |
| **D. Native Terminal UI Engine** | Provide single-select, multi-select, validated input, secret input, confirmations, and spinners using Node.js built-ins and ANSI only. |

The design has five governing decisions:

1. **Configuration is declarative; extensions are not executable JavaScript.** This preserves the zero-dependency and security model.
2. **Detection proposes; verification proves.** A manifest heuristic may suggest `pytest`, but only a successful user-approved validation establishes an oracle.
3. **No task may be dispatched without a falsifiable oracle.** Documentation-only tasks may use deterministic file/link/schema checks, but “looks better” is not sufficient.
4. **Provider quotas and local policy budgets are separate.** A profile may request a local ceiling, but effective dispatch capacity is the minimum of local policy and current provider availability.
5. **Interactive and headless modes share one plan engine.** The TUI only collects decisions. A pure planner validates and produces a transaction; a writer atomically applies it.

---

## 1. Goals, non-goals, and invariants

### 1.1 Goals

The subsystem MUST:

- initialize a repository without overwriting user-owned files silently;
- identify one or many workspace roots across heterogeneous stacks;
- produce deterministic test, build, lint, and typecheck command candidates;
- require the user or headless input to confirm executable verification oracles;
- configure Jules v1alpha repository and repoless task defaults;
- preserve the distinction between `startingBranch` and any output branch naming policy;
- support `automationMode: "AUTO_CREATE_PR"` and `requirePlanApproval`;
- generate a canonical `.agent/config.yml` and a compatibility `.agent/jules.yml`;
- enable built-in presets without copying maintainer scripts into consumer repositories;
- create versioned, hashable task envelopes;
- run scope, protected-path, secret, payload, and verification preflight checks;
- work interactively on a TTY and deterministically in CI without a TTY;
- use only Node.js built-in modules at runtime;
- make every write atomic, journaled, recoverable, and previewable;
- produce stable JSON output and exit codes for automation.

### 1.2 Non-goals

The subsystem MUST NOT:

- claim to infer every build system perfectly;
- implement full AST parsers for every language inside the core;
- store `JULES_API_KEY`, webhook secrets, GitHub tokens, or cloud credentials in tracked config;
- download packages merely to identify a stack;
- run inferred commands without user approval unless headless input explicitly authorizes them;
- treat a guessed command as a verified oracle;
- allow presets to import JavaScript or execute lifecycle hooks;
- mutate GitHub settings, Jules account settings, or provider quotas without explicit integration support;
- silently weaken protected paths for a preset;
- call a shell with user-provided interpolation unless the command is explicitly trusted and approved;
- conflate Jules plan limits with local orchestrator safety budgets;
- use an LLM to replace deterministic validation.

### 1.3 Hard invariants

#### Zero third-party runtime dependencies

Allowed runtime modules include:

```text
node:assert
node:child_process
node:crypto
node:events
node:fs
node:http
node:https
node:os
node:path
node:readline/promises
node:stream
node:string_decoder
node:tty
node:url
node:util
```

External development tools such as `git`, `cargo`, `go`, `python`, `docker`, `cmake`, `bazel`, `pnpm`, or `gh` MAY be invoked only when they belong to the target repository workflow, are detected locally, and are represented as explicit command capabilities. They are not npm runtime dependencies.

#### Read before write

Every generated task MUST state:

```text
Inspect the current definitions, call sites, tests, and repository-local instructions before editing. Do not invent file paths, symbols, command names, or API signatures.
```

The authoring wizard MUST resolve referenced paths at the selected base commit or working tree before saving a task.

#### Falsifiability

Every dispatchable task MUST contain at least one required verification criterion whose result is mechanically evaluable. A criterion MUST reference one of:

- a command with expected exit status;
- a file existence/nonexistence predicate;
- a content/hash/schema predicate;
- a test identifier and passing test command;
- a benchmark with a numeric threshold;
- a generated artifact with a deterministic validator.

#### Deny before allow

Protected and denied paths MUST be evaluated before task-specific allow paths. No preset or task may override a hard deny. A protected path may be authorized only through an explicit, recorded elevated approval.

#### Provider intent fidelity

For repository sessions:

```json
{
  "sourceContext": {
    "source": "sources/github/owner/repo",
    "githubRepoContext": {
      "startingBranch": "main"
    }
  }
}
```

For repoless sessions, `sourceContext` MUST be absent. `startingBranch` MUST default to `base_branch`, then `main`; it MUST never default to an output branch prefix.

#### No secrets in tracked configuration

Configuration stores environment variable names, not values:

```yaml
api_key_env: "JULES_API_KEY"
webhook_secret_env: "JULES_WEBHOOK_SECRET"
```

#### Transactional writes

Initialization and task creation MUST follow:

```text
plan -> preview -> lock -> journal intent -> write temporary files
     -> fsync -> atomic rename -> verify hashes -> journal done -> unlock
```

---

## 2. System architecture

### 2.1 Control flow

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                               agentctl                                      │
├──────────────────────┬───────────────────────────┬──────────────────────────┤
│ init --interactive   │ task create               │ headless commands        │
│ onboarding UI        │ task authoring UI         │ flags / JSON / env       │
└──────────┬───────────┴──────────────┬────────────┴────────────┬─────────────┘
           │                          │                         │
           ▼                          ▼                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Wizard Input Adapter                                │
│ TTY adapter │ headless adapter │ existing-config adapter │ defaults adapter │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Pure Planning Core                                 │
│                                                                             │
│ repository facts -> stack candidates -> workspace graph -> oracle plan      │
│ user intent -> decomposition -> scope plan -> verification -> Jules intent  │
│ config/preset/task schema validation -> safety policy -> transaction plan   │
└──────────────┬───────────────────────┬──────────────────────┬───────────────┘
               │                       │                      │
               ▼                       ▼                      ▼
┌──────────────────────┐  ┌────────────────────────┐  ┌──────────────────────┐
│ Stack Oracle         │  │ Safety and Scope       │  │ Jules v1alpha        │
│ manifests/toolchains │  │ gate/envelope/secrets  │  │ source/session plan  │
└──────────┬───────────┘  └────────────┬───────────┘  └──────────┬───────────┘
           └───────────────────────────┼─────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Transaction and State Layer                             │
│ VFS mutex │ intent journal │ backups │ atomic writes │ manifest hashes      │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ .agent/config.yml  .agent/jules.yml  .agent/presets/  .agent/jules-queue/  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Module boundaries

```text
src/wizard/
├── controller.mjs          # command-agnostic wizard orchestration
├── io.mjs                  # WizardIO interface + headless adapter
├── tui.mjs                 # native terminal implementation
├── plan.mjs                # immutable plan/result types
├── transaction.mjs         # lock, journal, backup, atomic apply
├── yaml-lite.mjs           # bounded YAML parser/emitter
├── migrate.mjs             # pure schema migrations
├── config-schema.mjs       # hand-written zero-dependency validators
├── task-schema.mjs         # task and criterion validators
├── preset-schema.mjs       # preset validators
├── stack-oracle.mjs        # repository detection coordinator
├── workspace-graph.mjs     # boundaries, edges, impact routing
├── oracle-validator.mjs    # command validation and evidence
├── source-resolver.mjs     # git remote -> Jules Source mapping
├── intent.mjs              # deterministic intent decomposition
├── falsifiability.mjs      # criterion quality checks
├── prompt-compiler.mjs     # prompt assembly and budgets
└── secret-preflight.mjs    # redaction/blocking reports
```

No module in `src/wizard/` may import `bin/agentctl.mjs`. The command router imports wizard modules, ensuring SDK reuse and testability.

### 2.3 Separation of planning and effects

All user answers produce an immutable plan before any write:

```js
{
  kind: "init-plan",
  root: "/repo",
  changes: [
    { operation: "create", path: ".agent/config.yml", mode: 0o644, contentHash: "..." },
    { operation: "update-managed", path: ".agent/jules.yml", mode: 0o644, contentHash: "..." }
  ],
  validations: [
    { id: "config-schema", ok: true },
    { id: "oracle:frontend:test", ok: true }
  ],
  warnings: [],
  requiresApproval: true
}
```

Interactive mode previews the plan. Headless mode emits it with `--dry-run --json`. Only `applyWizardPlan()` writes.

---

## 3. Command model

### 3.1 Primary commands

```text
agentctl init --interactive
agentctl init --answers .agent/init-answers.json --yes
agentctl init --check --json

agentctl task create
agentctl task create --from-todo <candidate-id>
agentctl task create --from-issue <owner/repo>#<number>
agentctl task create --answers task.json --yes
agentctl task create --repoless --prompt-file request.md

agentctl preset list
agentctl preset show <id>
agentctl preset validate [path]
agentctl preset enable <id>
agentctl preset disable <id>

agentctl config validate
agentctl config migrate --dry-run
agentctl config migrate --apply
```

### 3.2 Compatibility and migration

The existing top-level `agentctl create` dispatch alias SHOULD be deprecated in favor of unambiguous commands:

```text
agentctl task create       # author/save a task
agentctl task dispatch     # dispatch a saved task
agentctl dispatch          # immediate dispatch compatibility command
```

For at least one minor release:

```text
agentctl create -> warning + agentctl dispatch compatibility behavior
```

The tool MUST never silently change `create` from local drafting to live dispatch without a migration warning.

### 3.3 Common flags

| Flag | Meaning |
|---|---|
| `--interactive` | Require TTY wizard. Fail if no TTY. |
| `--no-interactive` | Never prompt; missing required values fail. |
| `--answers <file>` | Load non-secret answers from JSON. `-` reads stdin. |
| `--yes` | Apply a complete valid plan without confirmation. Never invent missing required values. |
| `--dry-run` | Build and validate plan without writes or dispatch. |
| `--json` | Machine-readable stdout; diagnostics to stderr. |
| `--root <path>` | Explicit repository root. |
| `--force` | Permit managed-file replacement only; never overwrite user-owned fields silently. |
| `--no-color` | Disable ANSI. Equivalent to `NO_COLOR=1`. |
| `--verbose` | Include evidence and detector explanations. |

### 3.4 Exit codes

| Code | Meaning |
|---:|---|
| `0` | Success. |
| `1` | General execution failure. |
| `2` | Provider/network failure. |
| `3` | Scope/protected-path violation. |
| `5` | Payload/diff budget exceeded. |
| `6` | Secret or sensitive-content block. |
| `7` | Local budget exhausted. |
| `8` | Flaky verification quarantine. |
| `64` | Invalid or incomplete CLI/answer input. |
| `65` | Invalid config/task/preset schema. |
| `66` | Required repository/tool/source unavailable. |
| `70` | Internal wizard planning/transaction error. |
| `130` | User cancelled with Ctrl+C. |

---

# 4. Module A — `agentctl init --interactive`

## 4.1 End-to-end onboarding flow

```text
START
  │
  ├─► Resolve root and Git state
  │     ├─ not Git? offer repoless-only config or abort
  │     └─ Git root found
  │
  ├─► Acquire wizard-config mutex
  │
  ├─► Read existing config and migration manifest
  │     ├─ newer unsupported schema -> abort, never downgrade
  │     ├─ older schema -> build migration preview
  │     └─ no config -> fresh plan
  │
  ├─► Collect repository facts (read-only)
  │
  ├─► Detect workspaces and stack candidates
  │
  ├─► Build verification-oracle candidates
  │
  ├─► User confirms/edits each affected workspace
  │     └─ no deterministic oracle -> block completion or bootstrap
  │
  ├─► Configure Jules Source, base branch, automation, approval
  │
  ├─► Select local policy profile and effective provider limits
  │
  ├─► Select presets and schedule projection
  │
  ├─► Preview generated files and warnings
  │
  ├─► Optional validation run
  │
  ├─► Journal + atomic apply
  │
  ├─► Re-read and schema/hash verification
  │
  └─► Print next safe command
END
```

## 4.2 Screen-by-screen terminal walkthrough

### Screen 1 — Welcome and mode

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ jules-orchestrator-kit setup                                             │
│ Repository: /work/acme-platform                                          │
│ Git remote: github.com/acme/platform                                     │
└──────────────────────────────────────────────────────────────────────────┘

This wizard will inspect your repository, propose verification commands,
and write a previewable .agent configuration. It will not store API keys.

? Setup mode
  ❯ Guided — explain each decision
    Express — accept only high-confidence validated defaults
    Custom — review every field

↑/↓ move • Enter select • Esc cancel
```

### Screen 2 — Existing configuration

```text
Existing agent configuration detected (schema 2).

  .agent/config.yml       user + managed fields
  .agent/jules.yml        generated compatibility projection
  .agent/presets/         2 custom presets

? Configuration action
  ❯ Preview migration to schema 3
    Validate only; make no changes
    Start a separate profile
    Cancel
```

The wizard MUST show field-level migration changes and ownership before proceeding.

### Screen 3 — Detection progress

```text
⠹ Inspecting repository

  ✓ Git base and remotes
  ✓ 4 workspace boundaries
  ✓ Node/pnpm workspace metadata
  ✓ Rust Cargo workspace metadata
  ✓ Docker Compose services
  … Validating command candidates
```

Detection progress goes to stderr in JSON mode and MUST never corrupt stdout.

### Screen 4 — Workspace summary

```text
Detected 4 verification domains

  ID          Path              Stack                 Confidence  Oracle
  web         apps/web          TypeScript / pnpm     0.98        3/4 verified
  api         services/api      Python / uv           0.93        3/4 verified
  worker      crates/worker     Rust / Cargo          0.99        3/4 verified
  contracts   packages/schema   Protobuf / Make       0.76        2/4 proposed

? Workspaces to configure
  ◉ web
  ◉ api
  ◉ worker
  ◉ contracts

Space toggle • A all • N none • Enter continue
```

### Screen 5 — Oracle confirmation

```text
Workspace: web (apps/web)
Evidence:
  • apps/web/package.json scripts.test = "vitest run"
  • pnpm-lock.yaml at repository root
  • tsconfig.json found
  • eslint.config.mjs found

? Test command
  ❯ pnpm --filter @acme/web test
    pnpm --dir apps/web test
    Enter a custom command
    Mark unavailable (blocks dispatch for this workspace)

? Validate this command now? Yes

✓ exit 0 in 4.2s — 184 tests passed
```

Commands MUST be stored structurally when possible. The displayed shell form is a rendering, not the canonical representation.

### Screen 6 — Jules account/source

```text
Jules API key
  ✓ JULES_API_KEY is present in the environment (value hidden)
  ✓ Jules API reachable

Connected Sources
  ❯ sources/github/acme/platform          default branch: main
    sources/github/acme/platform-fork     default branch: develop
    Configure repoless-only mode

? Starting branch
  ❯ main
    develop
    Enter another connected branch

? Default completion behavior
  [x] AUTO_CREATE_PR
  [ ] Require plan approval for every task

Recommended: require plan approval for high-risk tasks even if the default is off.
```

The source selector MUST obtain actual Source resource names. It MUST NOT synthesize a fake source.

### Screen 7 — Policy profile

```text
? Local orchestration profile
  ❯ Free / Individual — concurrency 1, 3s stagger, local ceiling 30
    Pro — concurrency 4, 1.5s stagger, local ceiling 300
    Custom Enterprise — configure every limit and integration

Provider note:
  Your configured local daily ceiling may exceed your Jules plan limit.
  Effective dispatch capacity is min(local policy, provider availability).
```

### Screen 8 — Presets

```text
? Enable workflow presets
  [x] nightly-security-audit
  [x] flaky-test-quarantine
  [ ] multi-agent-refactor-swarm
  [x] doc-sync-sentinel

Schedules are registry entries. Choose an executor later:
  Jules Scheduled Tasks, GitHub Actions, or an external scheduler.
```

### Screen 9 — Preview and apply

```text
Planned changes

  CREATE  .agent/config.yml
  CREATE  .agent/jules.yml
  CREATE  .agent/presets/nightly-security-audit.yml
  CREATE  .agent/presets/flaky-test-quarantine.yml
  CREATE  .agent/presets/doc-sync-sentinel.yml
  UPDATE  .gitignore                         +4 managed lines
  CREATE  .agent/sync-manifest.json

Validation
  ✓ Configuration schema
  ✓ 11 required command oracles
  ✓ Source and base branch
  ✓ Protected-path policy
  ✓ No secrets in generated files
  ! contracts/typecheck is unavailable; tasks in contracts require a custom oracle

? Apply atomically? Yes
```

### Screen 10 — Completion

```text
✓ Configuration written and verified
✓ Backup: .agent/history/2026-08-10T09-14-22Z-init/
✓ Manifest hash: sha256:2d5f…a41c

Next:
  agentctl task create

Diagnostics:
  agentctl doctor --verbose
  agentctl config validate
```

---

## 4.3 Multi-tier stack detection and verification oracles

### 4.3.1 Detection principle

The Stack Oracle MUST distinguish:

```text
fact -> candidate -> validated oracle
```

Example:

```text
Fact:      pyproject.toml exists and [tool.pytest] is present
Candidate: python -m pytest
Oracle:    command approved and observed with expected semantics
```

A candidate is never silently promoted to an oracle.

### 4.3.2 Detection tiers

#### Tier 0 — Repository facts, no subprocesses

Collect with bounded filesystem traversal:

- Git root, remotes, base branch, tracked files;
- manifests and lockfiles;
- directory depth and file counts;
- existing `AGENTS.md`, README, contributing guide;
- existing `.agent` configuration;
- Docker/Devcontainer descriptors;
- known workspace descriptors;
- test/config filenames;
- package scripts from JSON manifests;
- CMake presets from JSON;
- language/project extensions as weak supporting evidence.

Traversal MUST:

- ignore `.git`, `node_modules`, build outputs, caches, vendor directories, and configured excludes;
- cap entries, depth, bytes, and elapsed time;
- use `lstat` and not follow symlink directories;
- preserve NUL-safe paths internally;
- normalize paths to repository-relative POSIX form.

#### Tier 1 — Manifest-aware parsing

Use native parsing where the format permits it:

| Ecosystem | Evidence |
|---|---|
| npm/pnpm/yarn/bun | `package.json`, scripts, `workspaces`, lockfile, package manager field |
| Turbo | `turbo.json` tasks/pipeline and package workspaces |
| Nx | `nx.json`, `project.json`, package scripts |
| Rust | `Cargo.toml` locations; defer semantic graph to `cargo metadata` |
| Go | `go.mod`, `go.work` locations; module path from first directive |
| Python | `pyproject.toml`, `pytest.ini`, `tox.ini`, `poetry.lock`, `uv.lock`, requirements files |
| C/C++ | `CMakeLists.txt`, `CMakePresets.json`, `BUILD`, `BUILD.bazel`, `MODULE.bazel`, Makefile |
| Elixir | `mix.exs`, umbrella `apps/`, lockfile |
| Java/JVM | `pom.xml`, Gradle wrapper/settings/build files |
| .NET | solution/project files and test-project naming |
| Docker | Compose descriptors, Dockerfiles, Devcontainer config |

The zero-dependency parser MUST NOT pretend to implement full TOML, YAML, XML, Starlark, or Elixir semantics. It may extract bounded, documented facts and lower confidence when syntax is not fully parsed.

#### Tier 2 — Toolchain metadata, read-only and timeout-bounded

When the tool exists and the user permits it:

```text
cargo metadata --no-deps --format-version 1
go env GOMOD GOWORK
pnpm list -r --depth -1 --json
npm query .workspace
nx show projects --json
bazel query //... --output=package
cmake --list-presets
mix cmd --app mix.exs pwd       # umbrella evidence only when safe

docker compose config --services
```

Every probe MUST use argument arrays with `shell: false`, a timeout, output cap, controlled environment, and no prompt. Probes that may access the network MUST be disabled by default or run under the network guard.

#### Tier 3 — User-approved validation

Validation may execute:

- command `--version`/help probes;
- package manager script resolution;
- selected lint/typecheck/build/test commands;
- a dry-run/list-tests mode when supported.

The wizard MUST display expected runtime and side effects before executing. “Run tests now?” defaults to yes in guided local mode and no in CI unless explicitly requested.

### 4.3.3 Candidate command precedence

For each workspace and command kind:

```text
1. Existing valid .agent user override
2. Existing repository script/config explicitly naming the operation
3. Toolchain metadata
4. Ecosystem convention with strong evidence
5. User custom command
6. Unavailable — task dispatch blocked for affected workspace
```

### 4.3.4 Oracle quality model

Each candidate receives a score, never presented as certainty:

| Signal | Weight example |
|---|---:|
| Explicit existing agent config | +50 |
| Manifest script named exactly `test`/`lint`/`build`/`typecheck` | +35 |
| Tool metadata confirms workspace | +25 |
| Test files/config found | +15 |
| Lockfile/package manager consistent | +10 |
| Conventional guess only | +5 |
| Required binary missing | −40 |
| Command validation failed | −60 |
| Ambiguous competing package manager | −20 |

Suggested levels:

```text
0.90–1.00  high confidence; still confirm
0.70–0.89  medium; explain alternatives
0.40–0.69  low; require edit or explicit acceptance
<0.40      do not propose as default
```

### 4.3.5 Structured command model

Canonical config MUST prefer:

```yaml
commands:
  test:
    executable: "pnpm"
    args: ["--filter", "@acme/web", "test"]
    cwd: "."
    timeout_ms: 600000
    required: true
    network: "blocked"
```

Shell commands are explicit:

```yaml
commands:
  legacy_check:
    shell: true
    command: "make lint && make test"
    shell_program: "/bin/sh"
    cwd: "legacy"
    timeout_ms: 600000
    required: true
    trusted: true
```

The wizard MUST warn that shell text is executable policy.

### 4.3.6 Ambiguous and polyglot repositories

The oracle MUST produce a workspace graph, not one global stack:

```text
repository
├── apps/web             Node / React / pnpm
├── services/api         Python / uv / pytest
├── crates/worker        Rust / Cargo
├── packages/contracts   Protobuf / Make
└── shared triggers      openapi.yaml, compose.yaml, root lock/config
```

When a changed file maps to one workspace, run that workspace’s required commands. When it touches a shared trigger, run every dependent workspace or the configured global verification plan.

If two manifests claim the same path, the wizard MUST ask for ownership or choose the nearest manifest only when confidence is high and display the decision.

---

## 4.4 Monorepo workspace graph

### 4.4.1 Node model

Each node contains:

```text
id, path, ecosystems, manifests, package name, commands,
dependencies, dependents, ownership globs, shared triggers, confidence
```

Edges come from strongest available evidence:

1. toolchain metadata (`cargo metadata`, workspace package manager output);
2. explicit manifest dependencies;
3. configured contract/shared-file relationships;
4. directory ancestry only as a fallback.

### 4.4.2 Discovery algorithm

```text
1. Scan known root workspace descriptors.
2. Find manifests under bounded traversal.
3. Group manifests by nearest candidate root.
4. Ask toolchains for semantic package graphs when available.
5. Normalize all nodes to repository-relative paths.
6. Resolve overlapping ownership.
7. Add shared triggers and contract edges.
8. Detect graph cycles; cycles are allowed for impact grouping but not task DAG order.
9. Compute routing globs.
10. Present summaries in pages, with filter/search for large repositories.
```

### 4.4.3 Fifteen-service UX

Do not display fifteen full forms sequentially. Group by identical command templates:

```text
12 services share: go test ./...
  [x] apply template to all
  [ ] review each service

3 exceptions:
  billing    custom integration tests
  gateway    Docker Compose required
  legacy     no verified tests
```

Allow:

- all workspaces;
- a named group;
- only changed/affected workspaces;
- selected workspaces;
- shared-contract impact expansion.

### 4.4.4 Task scope routing

Given task scope paths:

```text
services/api/**
packages/contracts/openapi.yaml
```

The graph computes:

```text
Direct:     api, contracts
Dependent:  web, worker
Verify:     contracts -> api -> {web, worker}
Ownership:  disjoint edits unless task explicitly spans nodes
```

---

## 4.5 Usage profile and quota configuration

### 4.5.1 Separate local policy from provider quota

The profile values below are local orchestration policy requested by this specification. They MUST NOT be described as official Jules plan entitlements.

As of the referenced Jules documentation, provider plan limits may be lower than the requested local daily ceiling. The wizard displays both and computes:

```text
effectiveDailyCapacity = min(localDailyTasks, providerKnownOrObservedCapacity)
effectiveConcurrency   = min(localConcurrency, providerKnownOrObservedConcurrency)
```

If provider limits cannot be queried, the wizard labels them “informational/unverified” and relies on 429 handling.

### 4.5.2 Profile matrix

| Profile | Local concurrency | Local dailyTasks | staggerMs | diffKb | Default approval |
|---|---:|---:|---:|---:|---|
| Free / Individual | 1 | 30 | 3000 | 50 | Plans approved manually for R2/R3 |
| Pro | 4, editable 3–5 | 300 | 1500 | 75 | Auto-plan for R0/R1, manual R2/R3 |
| Custom Enterprise | 1–60 policy range | custom | custom | max 75 by default | policy-driven |

The 75 KB default is a kit safety governor, not a claim about a permanent provider limit.

### 4.5.3 Custom Enterprise fields

```text
concurrency
local daily/rolling budget
stagger and retry policy
provider source mapping
runner mode: local | worktree | container | external
worktree root and retention
webhook enablement and secret environment name
schedule executor
human approval policy by risk tier
telemetry retention/export
network policy
workspace groups
```

### 4.5.4 Wizard interaction

The wizard first asks for a profile, then shows editable values. It validates:

- integer and range constraints;
- concurrency not greater than configured hard maximum;
- diff limit not greater than organization policy;
- stagger not negative;
- webhook secret environment variable exists when enabling receiver;
- external runner has an explicit command/endpoint;
- source exists and branch belongs to it.

---

## 4.6 Preset swarm and schedule registry

Presets are declarative recipes. Enabling a preset writes an entry to config and, optionally, materializes a managed copy in `.agent/presets/`. It does not immediately schedule anything without choosing an executor.

### 4.6.1 `nightly-security-audit`

Purpose:

- run built-in secret-pattern scan over selected committed range;
- scan TODO/FIXME candidates without dispatching them automatically;
- run ecosystem-native dependency audits where configured;
- create one bounded task per verified finding cluster;
- require plan approval by default;
- never auto-merge security changes.

Native audit command examples selected per workspace:

```text
npm audit --omit=dev --json
pnpm audit --prod --json
cargo audit                    # only if already installed/configured; not bundled
pip-audit                      # only if already installed/configured; not bundled
govulncheck ./...              # only if already installed/configured; not bundled
mix hex.audit                  # only if available/configured
```

The preset MUST skip unavailable tools with an explicit finding; it MUST NOT install them automatically.

Schedule default:

```text
cron: "0 2 * * *"
timezone: "UTC"
executor: "unconfigured"
```

### 4.6.2 `flaky-test-quarantine`

Purpose:

- aggregate stable test identities where the runner exposes them;
- use command-level fallback only when individual tests are unavailable;
- compute oscillation and Wilson intervals over bounded windows;
- suppress blind source repair when verdict is quarantined;
- create a deterministic stabilization task;
- never delete or skip a test automatically.

Default policy:

```text
window: 10
minimum observations: 6
oscillation threshold: 0.40
confidence z: 1.96
repair on deterministic regression: true
repair on quarantined flaky result: false
```

### 4.6.3 `multi-agent-refactor-swarm`

Purpose:

- decompose a broad refactor by workspace graph and file ownership;
- reserve non-overlapping edit domains;
- identify read-only shared interfaces;
- create a task DAG when contracts must change first;
- dispatch only after all child tasks have deterministic oracles;
- create separate PRs by default rather than performing unsafe automatic code merge.

Decomposition algorithm:

```text
1. Identify affected workspace nodes.
2. Expand shared-contract dependents.
3. Partition writable files by nearest owner.
4. Mark shared files as single-writer.
5. Generate contract-first tasks.
6. Add dependency edges.
7. Validate no two ready tasks have overlapping write globs.
8. Acquire locks at execution time.
9. Gate each result independently.
10. Require human integration for overlapping or R2/R3 outputs.
```

### 4.6.4 `doc-sync-sentinel`

Purpose:

- compare exported SDK symbols with API reference inventory;
- compare CLI help with documented commands/options;
- check version strings and local links;
- validate `AGENTS.md` commands/paths against repository facts;
- identify stale examples and architecture claims;
- create documentation tasks only when deterministic drift evidence exists.

It MUST not rewrite prose autonomously without a task and review.

---

## 4.7 Configuration ownership and file layout

```text
.agent/
├── config.yml                  # canonical user + managed orchestration config
├── jules.yml                   # generated compatibility/provider projection
├── sync-manifest.json          # ownership, source hashes, schema/version
├── presets/
│   ├── nightly-security-audit.yml
│   ├── flaky-test-quarantine.yml
│   ├── multi-agent-refactor-swarm.yml
│   ├── doc-sync-sentinel.yml
│   └── team-custom.yml
├── rules/
│   └── jules-protocol.md
├── jules-queue/
│   ├── TASK-*.md
│   ├── completed/
│   ├── failed/
│   └── .state/
├── history/                    # ignored backups and migration reports
├── cache/                      # ignored detection cache
└── state/                      # ignored locks, journals, ledgers, telemetry
```

`config.yml`, `jules.yml`, presets, and shared rules are normally tracked. State, cache, generated backups, and task runtime sidecars are ignored.

---

## 4.8 YAML-Lite v1 format

Because Node.js does not provide a built-in YAML parser and third-party YAML libraries are forbidden, these files use a deliberately bounded YAML subset.

Supported:

- UTF-8;
- spaces-only indentation in multiples of two;
- maps;
- scalar sequences;
- maps keyed by stable IDs instead of sequences of maps;
- quoted strings;
- booleans, null, finite numbers;
- inline scalar arrays;
- comments outside quoted strings.

Forbidden:

- tabs for indentation;
- anchors and aliases;
- tags;
- merge keys;
- implicit dates;
- arbitrary object construction;
- duplicate keys;
- multiline folded/literal scalars;
- complex keys;
- executable interpolation.

Prompt bodies live in Markdown task files or referenced template files, not YAML multiline fields.

The parser MUST return line/column diagnostics, null-prototype maps, duplicate-key errors, size/depth limits, and prototype-key rejection.

---

## 4.9 Complete `.agent/config.yml` specification

```yaml
schema: "agentctl/config-v3"
config_revision: 1

kit:
  generated_by: "jules-orchestrator-kit"
  generated_version: "0.28.2"
  managed_profile: "guided"
  last_migrated_from: null

project:
  name: "acme-platform"
  root: "."
  repository_mode: "repository"
  base_branch: "main"
  default_source: "sources/github/acme/platform"
  instructions_file: "AGENTS.md"

provider:
  name: "jules"
  api_version: "v1alpha"
  api_base_url: "https://jules.googleapis.com/v1alpha"
  api_key_env: "JULES_API_KEY"
  request_timeout_ms: 120000
  default_automation_mode: "AUTO_CREATE_PR"
  require_plan_approval: false
  source_validation: "required"

profile:
  id: "pro"
  local_daily_tasks: 300
  concurrency: 4
  stagger_ms: 1500
  repair_attempts: 2
  prompt_kb: 50
  diff_kb: 75
  provider_limit_mode: "min-local-and-provider"

runner:
  mode: "worktree"
  isolation: "git-worktree"
  worktree_root: ".agent/worktrees"
  retain_failed_worktrees: true
  default_command_timeout_ms: 600000
  network_policy: "blocked-during-verification"

scope:
  deny: [".git/**", "**/.env", "**/.env.*", "**/*.pem", "**/*.key", ".github/**", ".agent/rules/**"]
  protect: ["package.json", "package-lock.json", "pnpm-lock.yaml", "Cargo.toml", "Cargo.lock", "go.mod", "go.sum", "pyproject.toml", "Makefile"]
  default_allow: []
  protected_override_policy: "explicit-human-approval"
  max_files_per_task: 40

security:
  pre_dispatch_secret_scan: true
  block_high_confidence_secrets: true
  confirm_low_confidence_secrets: true
  entropy_threshold: 3.6
  minimum_entropy_length: 20
  pii_redaction: true
  untrusted_context_fencing: true

verification:
  require_oracle: true
  aggregate_strategy: "all-required"
  local_gate_mode: "working-tree"
  ci_gate_mode: "committed"
  staged_gate_mode: "staged"
  no_oracle_policy: "block-dispatch"

workspaces:
  web:
    path: "apps/web"
    ecosystem: "node-typescript"
    package_name: "@acme/web"
    confidence: 0.98
    manifests: ["apps/web/package.json", "pnpm-workspace.yaml", "apps/web/tsconfig.json"]
    ownership: ["apps/web/**"]
    shared_triggers: ["packages/contracts/openapi.yaml"]
    commands:
      test:
        executable: "pnpm"
        args: ["--filter", "@acme/web", "test"]
        cwd: "."
        timeout_ms: 600000
        required: true
        network: "blocked"
      build:
        executable: "pnpm"
        args: ["--filter", "@acme/web", "build"]
        cwd: "."
        timeout_ms: 600000
        required: true
        network: "blocked"
      lint:
        executable: "pnpm"
        args: ["--filter", "@acme/web", "lint"]
        cwd: "."
        timeout_ms: 300000
        required: true
        network: "blocked"
      typecheck:
        executable: "pnpm"
        args: ["--filter", "@acme/web", "typecheck"]
        cwd: "."
        timeout_ms: 300000
        required: true
        network: "blocked"
  api:
    path: "services/api"
    ecosystem: "python-uv"
    package_name: "acme-api"
    confidence: 0.93
    manifests: ["services/api/pyproject.toml", "services/api/uv.lock"]
    ownership: ["services/api/**"]
    shared_triggers: ["packages/contracts/openapi.yaml"]
    commands:
      test:
        executable: "uv"
        args: ["run", "pytest", "-q"]
        cwd: "services/api"
        timeout_ms: 600000
        required: true
        network: "blocked"
      build:
        executable: "python"
        args: ["-m", "compileall", "-q", "."]
        cwd: "services/api"
        timeout_ms: 300000
        required: true
        network: "blocked"
      lint:
        executable: "uv"
        args: ["run", "ruff", "check", "."]
        cwd: "services/api"
        timeout_ms: 300000
        required: true
        network: "blocked"
      typecheck:
        executable: "uv"
        args: ["run", "mypy", "."]
        cwd: "services/api"
        timeout_ms: 300000
        required: false
        network: "blocked"
  worker:
    path: "crates/worker"
    ecosystem: "rust-cargo"
    package_name: "worker"
    confidence: 0.99
    manifests: ["Cargo.toml", "crates/worker/Cargo.toml", "Cargo.lock"]
    ownership: ["crates/worker/**"]
    shared_triggers: ["packages/contracts/proto/**"]
    commands:
      test:
        executable: "cargo"
        args: ["test", "-p", "worker"]
        cwd: "."
        timeout_ms: 900000
        required: true
        network: "blocked"
      build:
        executable: "cargo"
        args: ["build", "-p", "worker"]
        cwd: "."
        timeout_ms: 900000
        required: true
        network: "blocked"
      lint:
        executable: "cargo"
        args: ["clippy", "-p", "worker", "--", "-D", "warnings"]
        cwd: "."
        timeout_ms: 900000
        required: true
        network: "blocked"
      typecheck:
        executable: "cargo"
        args: ["check", "-p", "worker", "--all-targets"]
        cwd: "."
        timeout_ms: 900000
        required: true
        network: "blocked"
  contracts:
    path: "packages/contracts"
    ecosystem: "protobuf-make"
    package_name: "contracts"
    confidence: 0.76
    manifests: ["packages/contracts/Makefile", "packages/contracts/openapi.yaml"]
    ownership: ["packages/contracts/**"]
    shared_triggers: ["packages/contracts/openapi.yaml", "packages/contracts/proto/**"]
    commands:
      test:
        executable: "make"
        args: ["test"]
        cwd: "packages/contracts"
        timeout_ms: 300000
        required: true
        network: "blocked"
      build:
        executable: "make"
        args: ["generate"]
        cwd: "packages/contracts"
        timeout_ms: 300000
        required: true
        network: "blocked"
      lint:
        executable: "make"
        args: ["lint"]
        cwd: "packages/contracts"
        timeout_ms: 300000
        required: true
        network: "blocked"
      typecheck:
        executable: "make"
        args: ["validate"]
        cwd: "packages/contracts"
        timeout_ms: 300000
        required: true
        network: "blocked"

workspace_edges:
  contracts_to_web:
    from: "contracts"
    to: "web"
    trigger: "packages/contracts/openapi.yaml"
  contracts_to_api:
    from: "contracts"
    to: "api"
    trigger: "packages/contracts/openapi.yaml"
  contracts_to_worker:
    from: "contracts"
    to: "worker"
    trigger: "packages/contracts/proto/**"

presets:
  nightly-security-audit:
    enabled: true
    file: ".agent/presets/nightly-security-audit.yml"
  flaky-test-quarantine:
    enabled: true
    file: ".agent/presets/flaky-test-quarantine.yml"
  multi-agent-refactor-swarm:
    enabled: false
    file: ".agent/presets/multi-agent-refactor-swarm.yml"
  doc-sync-sentinel:
    enabled: true
    file: ".agent/presets/doc-sync-sentinel.yml"

schedules:
  nightly-security:
    preset: "nightly-security-audit"
    enabled: false
    executor: "unconfigured"
    cron: "0 2 * * *"
    timezone: "UTC"

queue:
  directory: ".agent/jules-queue"
  completed_directory: ".agent/jules-queue/completed"
  failed_directory: ".agent/jules-queue/failed"
  state_directory: ".agent/jules-queue/.state"
  retry_max_attempts: 5
  retry_base_ms: 30000
  retry_max_ms: 3600000
  retry_jitter: 0.20

state:
  directory: ".agent/state"
  journal: ".agent/state/journal.jsonl"
  lock_directory: ".agent/state/locks"
  telemetry_retention_days: 30
  ledger_fail_closed: true

webhook:
  enabled: false
  bind_host: "127.0.0.1"
  port: 8787
  secret_env: "JULES_WEBHOOK_SECRET"
  allowed_repositories: ["acme/platform"]
  delivery_ttl_hours: 24

migration:
  preserve_unknown_fields: true
  backup_before_apply: true
  managed_manifest: ".agent/sync-manifest.json"
```

---

## 4.10 Complete generated `.agent/jules.yml` compatibility projection

This file is generated from canonical config. It contains only fields used by the current dispatch/gate compatibility layer and MUST begin with a managed hash comment.

```yaml
schema: "agentctl/jules-projection-v3"
generated_from: ".agent/config.yml"
generated_by_version: "0.28.2"
source_config_sha256: "2d5f7c9b8c3be71db411c30f7ccfbc7ac26172d845653e9f97b38c3b0ce3a41c"

provider: "jules"
api_version: "v1alpha"
api_key_env: "JULES_API_KEY"
source: "sources/github/acme/platform"
base_branch: "main"
automation_mode: "AUTO_CREATE_PR"
require_plan_approval: false

test_cmd: "pnpm -r test && cargo test --workspace && uv run --project services/api pytest -q"
build_cmd: "pnpm -r build && cargo build --workspace && python -m compileall -q services/api"
lint_cmd: "pnpm -r lint && cargo clippy --workspace -- -D warnings && uv run --project services/api ruff check ."
typecheck_cmd: "pnpm -r typecheck && cargo check --workspace --all-targets"

forbidden_paths: [".git/**", "**/.env", "**/.env.*", "**/*.pem", "**/*.key", ".github/**", ".agent/rules/**"]
protected_paths: ["package.json", "package-lock.json", "pnpm-lock.yaml", "Cargo.toml", "Cargo.lock", "go.mod", "go.sum", "pyproject.toml", "Makefile"]
allow_paths: []

limits:
  diff_kb: 75
  prompt_kb: 50
  daily_tasks: 300
  repair_attempts: 2
  concurrency: 4
  stagger_ms: 1500

gate:
  local_mode: "working-tree"
  ci_mode: "committed"
  require_oracle: true
```

The projection’s shell aggregate commands are compatibility renderings. The canonical structured command model remains authoritative.

---

# 5. Module B — `agentctl task create`

## 5.1 Purpose

`agentctl task create` creates a task artifact; it does not dispatch by default. It turns developer intent into:

- a precise objective;
- grounded repository references;
- explicit current and expected behavior;
- a bounded write scope;
- inherited hard denies;
- deterministic acceptance criteria;
- selected workspace oracles;
- Jules source/repoless/branch/automation choices;
- a secret-scrubbed prompt;
- a hashable execution envelope;
- an optional dispatch confirmation.

## 5.2 End-to-end flow

```text
SEED
  ├─ manual intent
  ├─ TODO/FIXME candidate
  ├─ GitHub issue
  ├─ file/line selection
  └─ JSON/headless input
       │
       ▼
GROUNDING
  ├─ resolve paths/symbol hints
  ├─ identify workspaces
  ├─ read repository instructions
  └─ classify untrusted context
       │
       ▼
DECOMPOSITION
  ├─ objective
  ├─ current behavior
  ├─ expected behavior
  ├─ constraints/non-goals
  └─ split recommendation
       │
       ▼
SCOPE GOVERNOR
  ├─ allow paths
  ├─ inherited deny/protect
  ├─ overlap/lock check
  ├─ changed-file gate
  └─ risk tier
       │
       ▼
FALSIFIABILITY
  ├─ acceptance criteria
  ├─ command refs
  ├─ expected outcomes
  └─ oracle validation
       │
       ▼
JULES INTENT
  ├─ source or repoless
  ├─ starting branch
  ├─ auto PR
  └─ plan approval
       │
       ▼
SECURITY PREFLIGHT
  ├─ secret/PII scan
  ├─ prompt budget
  ├─ diff limit
  └─ envelope validation
       │
       ▼
PREVIEW -> SAVE -> OPTIONAL DISPATCH
```

---

## 5.3 Terminal walkthrough

### Screen 1 — Seed source

```text
? Start from
  ❯ Describe a task
    TODO/FIXME candidate from agentctl scan
    GitHub issue
    Existing task/preset
    Repoless request
```

### Screen 2 — Intent

```text
? What should change?
  Add bounded retry handling to the payment webhook sender

The request contains a broad verb but no observed failure yet.

? Current behavior
  A transient 502 fails the delivery immediately.

? Expected behavior
  Retry 502/503 responses up to 3 times with bounded exponential backoff,
  preserve idempotency headers, and return the final typed failure.
```

The wizard uses deterministic prompts. It does not need an LLM to ask for missing current/expected behavior.

### Screen 3 — Repository grounding

```text
Likely workspace: services/payments (Node / TypeScript)

Candidate references
  [x] services/payments/src/webhook-sender.ts
  [x] services/payments/test/webhook-sender.test.ts
  [ ] packages/http-client/**

? Writable scope
  ❯ services/payments/src/webhook-sender.ts
    Add another file or directory
    Select from repository tree
```

Paths are resolved against the selected base and current working tree. Missing paths require correction; the wizard never invents them.

### Screen 4 — Scope and risk

```text
Scope summary

  Allow write:
    services/payments/src/webhook-sender.ts
    services/payments/test/webhook-sender.test.ts

  Read-only context:
    packages/http-client/**
    AGENTS.md

  Inherited deny:
    .github/**
    .agent/rules/**
    **/.env*

  Protected:
    package.json
    pnpm-lock.yaml

Risk: R1 Routine
Overlapping active reservations: none
```

If protected paths are selected:

```text
! package.json is protected.

? Resolution
  ❯ Remove it from task scope
    Request elevated approval and record rationale
    Split dependency change into a separate task
    Cancel
```

### Screen 5 — Acceptance criteria

```text
? Required pass/fail criteria
  [x] Existing payment tests pass
      pnpm --filter @acme/payments test
  [x] New tests cover 502 success-after-retry and final failure
      evidence: named test cases in webhook-sender.test.ts
  [x] Typecheck passes
      pnpm --filter @acme/payments typecheck
  [ ] Build passes (optional)
      pnpm --filter @acme/payments build

? Add a numeric criterion
  Maximum attempts = 3
```

### Screen 6 — Vague-prompt remediation

For “make the code better”:

```text
This request is not dispatchable yet.

Missing:
  • observable current behavior
  • expected outcome
  • bounded scope
  • deterministic acceptance criterion

? Refine goal
  ❯ Reduce p95 parser benchmark by at least 5%
    Remove a named duplication while preserving public behavior
    Add tests for a named uncovered edge case
    Enter a different measurable outcome
```

The wizard does not reject natural language merely for being short. It rejects missing evidence.

### Screen 7 — Jules options

```text
? Execution target
  ❯ Repository: sources/github/acme/platform
    Repoless

Starting branch: main

? Session behavior
  [x] AUTO_CREATE_PR
  [ ] Require plan approval

Risk policy recommends plan approval for R2/R3.
```

### Screen 8 — Preflight

```text
⠸ Running task preflight

  ✓ Referenced paths exist
  ✓ Allowed scope does not breach hard denies
  ✓ No active ownership overlap
  ✓ working-tree gate is clean for selected scope
  ✓ 3 deterministic criteria
  ✓ Prompt 4.8 KB / 50 KB
  ✓ Estimated diff budget 18 KB / 75 KB
  ✓ No high-confidence secrets
```

### Screen 9 — Final task

```text
Task ID: TASK-20260810-091422-webhook-retry
File: .agent/jules-queue/TASK-20260810-091422-webhook-retry.md
Envelope: sha256:6a14…e991

? Next action
  ❯ Save only
    Save and dispatch
    Save and add to swarm batch
    Export JSON to stdout
```

---

## 5.4 Seed sources

### 5.4.1 Manual

Collect objective, current behavior, expected behavior, constraints, scope, and evidence.

### 5.4.2 TODO/FIXME

`agentctl scan --json` MUST emit stable candidates:

```json
{
  "id": "todo:services/api/auth.py:84:3f822f17",
  "tag": "TODO",
  "path": "services/api/auth.py",
  "line": 84,
  "text": "Handle expired refresh token race",
  "context": {
    "before": ["..."],
    "after": ["..."]
  },
  "workspace": "api"
}
```

The scanner MUST exclude:

- `.git`, state, cache, generated suggested-task files;
- test fixtures that intentionally contain TODO strings unless `--include-tests`;
- its own source-pattern literals;
- minified/binary/vendor/build outputs.

Candidate text is untrusted context, never operator instruction.

### 5.4.3 GitHub issue

Preferred resolution order:

1. `gh issue view ... --json` if `gh` is installed and user approves;
2. native `fetch()` to GitHub REST using `GH_TOKEN`/`GITHUB_TOKEN`;
3. pasted/exported JSON input;
4. no network: ask user to paste issue body.

Issue title/body/comments are untrusted data. Store URL, number, repository, author, and content hash. Do not store tokens.

### 5.4.4 Existing task or preset

Load only schema-valid files under repository containment. Migration to current task schema is previewed and non-destructive.

### 5.4.5 Repoless

Require output expectations such as:

- generated file names;
- syntax/runtime validator;
- exact format/schema;
- no repository scope;
- safe local output directory if artifacts are downloaded.

---

## 5.5 Deterministic intent decomposition

The wizard uses a fixed question graph:

```text
What changes?
Why is it needed?
What happens now?
What must happen instead?
Where may edits occur?
What must not change?
How will a machine prove success?
What evidence is expected in the PR/session output?
```

It proposes a split when any condition holds:

- multiple independent workspace nodes;
- overlapping protected and routine changes;
- more than configured maximum writable files;
- estimated diff exceeds 75 KB;
- unrelated acceptance criteria;
- contract change plus independent consumers;
- more than one high-risk domain (auth, finance, migrations, CI).

Split output is a DAG only when dependencies are explicit.

---

## 5.6 Falsifiability engine

### 5.6.1 Criterion model

A criterion contains:

```text
id
statement
kind
command reference or predicate
expected result
required flag
evidence description
workspace
```

Supported kinds:

- `command-exit`;
- `test-name`;
- `file-exists`;
- `file-absent`;
- `content-match`;
- `json-schema`;
- `hash-unchanged`;
- `benchmark-threshold`;
- `diff-property`.

### 5.6.2 Dispatchability rules

A task is dispatchable only if:

```text
at least one required criterion
AND every writable workspace has a required oracle
AND no criterion is only subjective
AND command references resolve to approved config commands
AND expected outcomes are concrete
```

Examples:

| Request | Result |
|---|---|
| “Make UI nicer” | Block; subjective and unbounded. |
| “Match attached mockup” | Require visual baseline plus Playwright/screenshot/accessibility criterion. |
| “Improve performance” | Require benchmark and numeric threshold. |
| “Refactor module” | Require behavior-preserving tests/typecheck and bounded files. |
| “Update docs” | Require link check, exported-symbol comparison, generated-doc diff, or named content predicates. |
| “Fix bug” | Require reproduction and regression test or deterministic command. |

### 5.6.3 Oracle bootstrap

If no oracle exists, task creation offers:

```text
1. Configure an existing command.
2. Generate a non-tautological syntax/import/startup check.
3. Create a preliminary test-harness task requiring human review.
4. Save draft as non-dispatchable.
```

A smoke test that only asserts the directory exists is invalid.

---

## 5.7 Scope and envelope isolation

### 5.7.1 Scope classes

```text
write_allow       agent may modify
read_context      agent may inspect but should not modify
deny              hard block
protect           requires explicit approval
shared_singleton  one task may write at a time
```

### 5.7.2 Validation order

```text
1. Normalize paths and reject absolute/escaping/symlink paths.
2. Apply hard deny.
3. Apply protected policy.
4. Apply task write allowlist.
5. Resolve workspace ownership.
6. Detect active and queued overlap.
7. Validate base commit and path existence.
8. Run selected gate mode.
9. Freeze/hash envelope.
```

The wizard calls the same exported `validateEnvelope()` implementation used by `scripts/validate-envelope.mjs`; it MUST NOT fork a second validator. For compatibility and black-box testing, the saved artifact is also accepted by:

```bash
node scripts/validate-envelope.mjs <exported-envelope.json>
```

The JSON export and Markdown front matter represent the same canonical envelope hash.

### 5.7.3 Working-tree preflight

Default local task authoring runs:

```text
agentctl gate --mode working-tree
```

The implementation MUST actually forward mode through name, diff, and byte functions. For task-specific preflight, unrelated dirty files are reported separately; they are never hidden. The user may:

- commit/stash unrelated changes;
- narrow to staged mode;
- save a draft without dispatch;
- cancel.

### 5.7.4 Locks and journal

Task creation acquires only a short queue-write mutex. Long-lived ownership reservations are created when a task enters queued/running state:

```json
{
  "taskId": "TASK-...",
  "writeGlobs": ["services/payments/**"],
  "readGlobs": ["packages/http-client/**"],
  "baseSha": "...",
  "state": "queued",
  "nonce": "...",
  "createdAt": "..."
}
```

Overlap is checked across all live reservations, not by task ID filename alone.

---

## 5.8 Jules flags and payload synthesis

### 5.8.1 Repository session mapping

```js
const request = {
  title: task.title,
  prompt: compiledPrompt,
  sourceContext: {
    source: task.jules.source,
    githubRepoContext: {
      startingBranch: task.jules.startingBranch,
    },
  },
  ...(task.jules.autoPr ? { automationMode: "AUTO_CREATE_PR" } : {}),
  ...(task.jules.requirePlanApproval ? { requirePlanApproval: true } : {}),
};
```

### 5.8.2 Repoless mapping

```js
const request = {
  title: task.title,
  prompt: compiledPrompt,
  ...(task.jules.requirePlanApproval ? { requirePlanApproval: true } : {}),
};
```

No fabricated source is permitted.

### 5.8.3 Guardrail footer

The compiler appends one concise, versioned footer rather than duplicating entire rule files:

```text
EXECUTION INVARIANTS
1. Read AGENTS.md and applicable repository-local instructions before editing.
2. Inspect referenced definitions and call sites; do not invent paths or signatures.
3. Modify only WRITE SCOPE paths. Treat READ-ONLY CONTEXT as non-writable.
4. Never modify DENIED paths. Protected paths require explicit approval.
5. Do not weaken, delete, skip, or replace valid tests to obtain a pass.
6. Run every REQUIRED VERIFICATION command and report command, exit status, and evidence.
7. Keep the resulting diff below 75 KB. If the task cannot fit safely, stop and propose a split.
8. Do not include credentials, private keys, tokens, or unredacted PII in code, logs, commits, or PR text.
9. Before finalizing, compare against the current base. If the base advanced, rebase or stop on conflicts; never discard unrelated upstream changes.
10. If requirements are ambiguous or the oracle cannot be satisfied without leaving scope, stop and request clarification.
```

The footer includes a short policy version and hash in machine metadata, not prose.

---

## 5.9 Complete task artifact schema and example

Task files are Markdown with YAML-Lite front matter and a compiled prompt body.

```markdown
---
schema: "agentctl/task-v1"
id: "TASK-20260810-091422-webhook-retry"
title: "Add bounded retry handling to payment webhooks"
state: "draft"
created_at: "2026-08-10T09:14:22.000Z"
created_by: "agentctl"
base_ref: "main"
base_sha: "9c6c4f5709d8aa8448013f7231d36179b6b4a9dd"
risk_tier: "R1_ROUTINE"
intent_hash: "sha256:54c7c55d0aaccc6b0585f08a39b5d96f7506793067e60dfb04ecf571e6172c71"
envelope_hash: "sha256:6a14b7fc85d66d4af4a2b43baf62e0563e27487e6b548ab6aed354e504f4e991"

jules:
  mode: "repository"
  source: "sources/github/acme/platform"
  starting_branch: "main"
  auto_pr: true
  require_plan_approval: false

scope:
  write_allow: ["services/payments/src/webhook-sender.ts", "services/payments/test/webhook-sender.test.ts"]
  read_context: ["packages/http-client/**", "AGENTS.md"]
  deny: [".github/**", ".agent/rules/**", "**/.env*"]
  protect: ["package.json", "pnpm-lock.yaml"]
  ownership_domain: "services/payments"

limits:
  diff_kb: 75
  prompt_kb: 50
  max_files: 2

verification:
  workspace: "payments"
  required: ["payments-test", "payments-typecheck", "retry-regression-tests"]
  optional: ["payments-build"]

criteria:
  payments-test:
    kind: "command-exit"
    command_ref: "workspaces.payments.commands.test"
    expected_exit: 0
    required: true
  payments-typecheck:
    kind: "command-exit"
    command_ref: "workspaces.payments.commands.typecheck"
    expected_exit: 0
    required: true
  retry-regression-tests:
    kind: "test-name"
    command_ref: "workspaces.payments.commands.test"
    expected_tests: ["retries transient 502 and succeeds", "returns typed failure after three attempts", "preserves idempotency header"]
    required: true
  payments-build:
    kind: "command-exit"
    command_ref: "workspaces.payments.commands.build"
    expected_exit: 0
    required: false

seed:
  kind: "manual"
  source_url: null
  untrusted_context_hash: null
---

# Objective

Add bounded retry handling to the existing payment webhook sender.

## Current behavior

A transient HTTP 502 or 503 causes the delivery to fail immediately.

## Expected behavior

Retry HTTP 502 and 503 responses up to three total attempts using bounded exponential backoff. Preserve the existing idempotency header on every attempt. Return the existing typed failure after the final attempt.

## Write scope

- `services/payments/src/webhook-sender.ts`
- `services/payments/test/webhook-sender.test.ts`

## Read-only context

- `packages/http-client/**`
- `AGENTS.md`

## Non-goals

- Do not change package dependencies.
- Do not change webhook payload format.
- Do not retry non-transient 4xx responses.
- Do not modify CI workflows.

## Required verification

1. `payments-test` exits 0.
2. `payments-typecheck` exits 0.
3. Regression tests prove transient success, final failure, and idempotency preservation.

## Execution invariants

1. Read `AGENTS.md` and inspect current definitions and call sites before editing.
2. Do not invent paths, symbols, or API signatures.
3. Modify only the write scope.
4. Never weaken tests.
5. Keep the diff below 75 KB.
6. Report exact verification commands, exit statuses, and evidence.
7. Stop and request clarification if completion requires leaving scope.
```

---

# 6. Module C — custom presets and extension architecture

## 6.1 Security model

Presets are data, not code. A preset MAY:

- define prompts and deterministic questions;
- reference configured command IDs;
- declare scope templates;
- select workspaces and fan-out strategy;
- set Jules flags within policy;
- define schedule metadata;
- define required approvals;
- define acceptance criterion templates.

A preset MUST NOT:

- import or execute JavaScript;
- define arbitrary preinstall/postinstall hooks;
- embed secrets;
- weaken hard denies;
- execute a shell command not already approved in canonical config unless an elevated preset approval records it;
- fetch remote includes at runtime;
- use path traversal in includes or template references.

## 6.2 Resolution and precedence

```text
Built-in preset defaults
  < repository preset file
  < organization managed policy
  < task-specific values
  < hard security policy (cannot be overridden)
```

Custom preset IDs shadow built-ins only when explicitly namespaced:

```text
team.acme/nightly-security-audit
```

## 6.3 Template variables

Allowed variables are typed and escaped:

```text
{{task.title}}
{{task.objective}}
{{workspace.id}}
{{workspace.path}}
{{source.name}}
{{base.branch}}
{{criterion.summary}}
```

There is no expression language, function call, property traversal beyond allowlisted paths, or command substitution. Unknown variables fail validation.

## 6.4 Complete preset format

```yaml
schema: "agentctl/preset-v1"

metadata:
  id: "team.acme/api-hardening"
  name: "API hardening task"
  version: "1.2.0"
  description: "Create a bounded API hardening task with security-focused verification."
  owner: "platform-security"
  minimum_kit_version: "0.28.2"

compatibility:
  modes: ["repository"]
  ecosystems: ["node-typescript", "python", "go", "rust-cargo"]
  required_capabilities: ["tests", "secret-scan", "working-tree-gate"]

inputs:
  workspace:
    type: "workspace-id"
    required: true
    prompt: "Select the API workspace"
  endpoint_path:
    type: "repo-path"
    required: true
    prompt: "Select the endpoint or handler path"
  threat:
    type: "single-select"
    required: true
    options: ["authentication", "authorization", "input-validation", "rate-limiting", "secret-handling"]
  auto_pr:
    type: "boolean"
    required: false
    default: true

selection:
  workspace_input: "workspace"
  include_dependents: false
  include_shared_triggers: true

scope:
  write_templates: ["{{workspace.path}}/**"]
  read_templates: ["AGENTS.md"]
  deny_additions: []
  protected_policy: "require-approval"
  max_files: 20

prompt:
  title_template: "Harden {{threat}} in {{workspace.id}}"
  recipe_file: ".agent/prompts/api-hardening.md"
  append_standard_invariants: true

verification:
  require_workspace_test: true
  require_workspace_lint: true
  require_workspace_typecheck: false
  custom_criteria:
    regression-test:
      kind: "test-name"
      statement: "Add a regression test demonstrating the threat before and after the fix."
      required: true
    no-new-secret:
      kind: "diff-property"
      statement: "No high-confidence secret appears in added lines."
      required: true

jules:
  auto_pr_from_input: "auto_pr"
  require_plan_approval: true
  repoless: false

fanout:
  strategy: "single-task"
  max_tasks: 1
  ownership: "workspace"

schedule:
  allowed: false

risk:
  minimum_tier: "R2_CONSEQUENTIAL"
  require_human_review: true
```

## 6.5 Built-in preset files

Built-ins SHOULD be shipped as package assets but copied only when enabled or customized. The sync manifest records package source version and base hash so migrations can perform a three-way comparison.

## 6.6 Preset validation

`agentctl preset validate` checks:

- schema and version;
- ID namespace;
- unknown/duplicate fields;
- referenced files under repository root;
- variable allowlist;
- command references;
- workspace/capability compatibility;
- deny/protected-policy monotonicity;
- fan-out limits;
- schedule syntax bounds;
- prompt and file size;
- cycles in preset includes;
- minimum kit version.

---

# 7. Module D — native Node.js TUI engine

## 7.1 Requirements

The TUI MUST:

- use native ESM only;
- restore raw mode and cursor on success, error, SIGINT, and cancellation;
- work with color disabled;
- write UI to stderr when stdout is reserved for JSON;
- handle terminal width;
- support arrow keys, Enter, Escape, Space, Home, End, `a`, `n`, Ctrl+C;
- provide a non-TTY error rather than hanging;
- avoid writing secrets to history or terminal output;
- keep interactive state separate from business planning.

## 7.2 ANSI conventions

```text
CSI = ESC + "["
clear line = CSI + "2K"
move column 1 = "\r"
move up N = CSI + N + "A"
hide cursor = CSI + "?25l"
show cursor = CSI + "?25h"
```

ANSI is enabled only when output is a TTY, `TERM !== "dumb"`, and `NO_COLOR` is absent.

## 7.3 Complete runnable native TUI primitive module

The following is a complete reference implementation for `src/wizard/tui.mjs`. It intentionally contains no third-party imports.

```js
import { createInterface } from "node:readline/promises";
import { isatty } from "node:tty";

const ESC = "\u001b";
const CSI = `${ESC}[`;

export class WizardCancelledError extends Error {
  constructor(message = "Wizard cancelled") {
    super(message);
    this.name = "WizardCancelledError";
    this.code = 130;
  }
}

export class NonInteractiveError extends Error {
  constructor(message = "Interactive input requires a TTY") {
    super(message);
    this.name = "NonInteractiveError";
    this.code = 64;
  }
}

export function supportsAnsi(output = process.stderr) {
  return Boolean(
    output &&
      output.isTTY &&
      process.env.TERM !== "dumb" &&
      process.env.NO_COLOR === undefined
  );
}

export function createTheme(output = process.stderr) {
  const ansi = supportsAnsi(output);
  const wrap = (open, close) => (value) =>
    ansi ? `${open}${String(value)}${close}` : String(value);

  return Object.freeze({
    ansi,
    bold: wrap(`${CSI}1m`, `${CSI}22m`),
    dim: wrap(`${CSI}2m`, `${CSI}22m`),
    cyan: wrap(`${CSI}36m`, `${CSI}39m`),
    green: wrap(`${CSI}32m`, `${CSI}39m`),
    yellow: wrap(`${CSI}33m`, `${CSI}39m`),
    red: wrap(`${CSI}31m`, `${CSI}39m`),
  });
}

export function stripAnsi(value) {
  return String(value).replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

export function terminalColumns(output = process.stderr) {
  const columns = Number(output?.columns);
  return Number.isFinite(columns) && columns >= 20 ? columns : 80;
}

export function truncateDisplay(value, width) {
  const text = stripAnsi(String(value)).replace(/[\r\n\t]/g, " ");
  if (width <= 1) return text.slice(0, Math.max(0, width));
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

function requireTty(input, output) {
  const inputFd = Number.isInteger(input?.fd) ? input.fd : -1;
  if (!input?.isTTY || !output?.isTTY || inputFd < 0 || !isatty(inputFd)) {
    throw new NonInteractiveError();
  }
  if (typeof input.setRawMode !== "function") {
    throw new NonInteractiveError("Input TTY does not support raw mode");
  }
}

function write(output, value) {
  output.write(String(value));
}

function eraseRegion(output, lineCount) {
  if (lineCount > 0) write(output, `${CSI}${lineCount}A`);
  for (let i = 0; i < lineCount; i += 1) {
    write(output, `${CSI}2K\r`);
    if (i < lineCount - 1) write(output, "\n");
  }
  if (lineCount > 1) write(output, `${CSI}${lineCount - 1}A`);
  write(output, "\r");
}

function nextChunk(input) {
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      cleanup();
      resolve(String(chunk));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      input.off("data", onData);
      input.off("error", onError);
    };
    input.once("data", onData);
    input.once("error", onError);
  });
}

function decodeKey(chunk) {
  if (chunk === "\u0003") return "ctrl-c";
  if (chunk === "\r" || chunk === "\n") return "enter";
  if (chunk === " ") return "space";
  if (chunk === "\u001b") return "escape";
  if (chunk === "\u001b[A" || chunk === "\u001bOA") return "up";
  if (chunk === "\u001b[B" || chunk === "\u001bOB") return "down";
  if (chunk === "\u001b[H" || chunk === "\u001bOH") return "home";
  if (chunk === "\u001b[F" || chunk === "\u001bOF") return "end";
  if (chunk === "\u007f" || chunk === "\b") return "backspace";
  if (chunk.toLowerCase() === "a") return "all";
  if (chunk.toLowerCase() === "n") return "none";
  return chunk;
}

async function withRawMode(input, output, fn) {
  requireTty(input, output);
  const wasRaw = Boolean(input.isRaw);
  const wasPaused = input.isPaused();
  input.setEncoding("utf8");
  input.setRawMode(true);
  input.resume();
  write(output, `${CSI}?25l`);

  try {
    return await fn();
  } finally {
    write(output, `${CSI}?25h`);
    if (!wasRaw) input.setRawMode(false);
    if (wasPaused) input.pause();
  }
}

function normalizeOptions(options) {
  if (!Array.isArray(options) || options.length === 0) {
    throw new TypeError("options must be a non-empty array");
  }
  return options.map((option, index) => {
    if (typeof option === "string") {
      return { value: option, label: option, description: "", disabled: false };
    }
    if (!option || typeof option !== "object") {
      throw new TypeError(`option ${index} must be a string or object`);
    }
    return {
      value: option.value,
      label: String(option.label ?? option.value ?? `Option ${index + 1}`),
      description: String(option.description ?? ""),
      disabled: Boolean(option.disabled),
    };
  });
}

function nextEnabled(options, start, delta) {
  let index = start;
  for (let count = 0; count < options.length; count += 1) {
    index = (index + delta + options.length) % options.length;
    if (!options[index].disabled) return index;
  }
  return start;
}

export async function singleSelect({
  message,
  options,
  initialIndex = 0,
  input = process.stdin,
  output = process.stderr,
}) {
  const items = normalizeOptions(options);
  if (items.every((item) => item.disabled)) {
    throw new TypeError("at least one option must be enabled");
  }

  let index = Math.max(0, Math.min(items.length - 1, Number(initialIndex) || 0));
  if (items[index].disabled) index = nextEnabled(items, index, 1);
  const theme = createTheme(output);
  const height = items.length + 2;
  let rendered = false;

  const render = () => {
    if (rendered) eraseRegion(output, height);
    const width = terminalColumns(output) - 4;
    write(output, `${theme.bold("?")} ${message}\n`);
    items.forEach((item, itemIndex) => {
      const selected = itemIndex === index;
      const marker = selected ? theme.cyan("❯") : " ";
      const plain = `${item.label}${item.description ? ` — ${item.description}` : ""}`;
      const displayed = truncateDisplay(plain, width);
      const label = item.disabled ? theme.dim(displayed) : displayed;
      write(output, `${marker} ${label}\n`);
    });
    write(output, theme.dim("↑/↓ move • Enter select • Esc cancel\n"));
    rendered = true;
  };

  return withRawMode(input, output, async () => {
    render();
    while (true) {
      const key = decodeKey(await nextChunk(input));
      if (key === "ctrl-c" || key === "escape") {
        throw new WizardCancelledError();
      }
      if (key === "up") index = nextEnabled(items, index, -1);
      if (key === "down") index = nextEnabled(items, index, 1);
      if (key === "home") index = items.findIndex((item) => !item.disabled);
      if (key === "end") {
        const reversed = [...items].reverse().findIndex((item) => !item.disabled);
        index = items.length - 1 - reversed;
      }
      if (key === "enter" && !items[index].disabled) {
        eraseRegion(output, height);
        write(output, `${theme.green("✓")} ${message}: ${items[index].label}\n`);
        return items[index].value;
      }
      render();
    }
  });
}

export async function multiSelect({
  message,
  options,
  initialValues = [],
  minimum = 0,
  maximum = Number.POSITIVE_INFINITY,
  input = process.stdin,
  output = process.stderr,
}) {
  const items = normalizeOptions(options);
  const selected = new Set(initialValues);
  let index = items.findIndex((item) => !item.disabled);
  if (index < 0) throw new TypeError("at least one option must be enabled");
  const theme = createTheme(output);
  const height = items.length + 2;
  let rendered = false;

  const render = (error = "") => {
    if (rendered) eraseRegion(output, height);
    const width = terminalColumns(output) - 7;
    write(output, `${theme.bold("?")} ${message}${error ? theme.red(` — ${error}`) : ""}\n`);
    items.forEach((item, itemIndex) => {
      const cursor = itemIndex === index ? theme.cyan("❯") : " ";
      const checked = selected.has(item.value) ? theme.green("◉") : "◯";
      const displayed = truncateDisplay(item.label, width);
      const label = item.disabled ? theme.dim(displayed) : displayed;
      write(output, `${cursor} ${checked} ${label}\n`);
    });
    write(output, theme.dim("Space toggle • A all • N none • Enter continue • Esc cancel\n"));
    rendered = true;
  };

  return withRawMode(input, output, async () => {
    render();
    while (true) {
      const key = decodeKey(await nextChunk(input));
      if (key === "ctrl-c" || key === "escape") {
        throw new WizardCancelledError();
      }
      if (key === "up") index = nextEnabled(items, index, -1);
      if (key === "down") index = nextEnabled(items, index, 1);
      if (key === "all") {
        items.filter((item) => !item.disabled).forEach((item) => selected.add(item.value));
      }
      if (key === "none") selected.clear();
      if (key === "space" && !items[index].disabled) {
        const value = items[index].value;
        if (selected.has(value)) selected.delete(value);
        else if (selected.size < maximum) selected.add(value);
      }
      if (key === "enter") {
        if (selected.size < minimum) {
          render(`select at least ${minimum}`);
          continue;
        }
        if (selected.size > maximum) {
          render(`select no more than ${maximum}`);
          continue;
        }
        eraseRegion(output, height);
        write(output, `${theme.green("✓")} ${message}: ${selected.size} selected\n`);
        return [...selected];
      }
      render();
    }
  });
}

export async function textInput({
  message,
  defaultValue = "",
  validate = () => true,
  input = process.stdin,
  output = process.stderr,
}) {
  requireTty(input, output);
  const theme = createTheme(output);

  while (true) {
    const rl = createInterface({ input, output, terminal: true });
    try {
      const suffix = defaultValue ? theme.dim(` (${defaultValue})`) : "";
      const answer = await rl.question(`${theme.bold("?")} ${message}${suffix}: `);
      const value = answer.length > 0 ? answer : String(defaultValue);
      const result = await validate(value);
      if (result === true) return value;
      write(output, `${theme.red("!")} ${String(result || "Invalid value")}\n`);
    } finally {
      rl.close();
    }
  }
}

export async function numberInput({
  message,
  defaultValue,
  minimum = Number.NEGATIVE_INFINITY,
  maximum = Number.POSITIVE_INFINITY,
  integer = true,
  input = process.stdin,
  output = process.stderr,
}) {
  const value = await textInput({
    message,
    defaultValue: String(defaultValue ?? ""),
    input,
    output,
    validate: (raw) => {
      const number = Number(raw);
      if (!Number.isFinite(number)) return "Enter a finite number";
      if (integer && !Number.isInteger(number)) return "Enter an integer";
      if (number < minimum) return `Minimum is ${minimum}`;
      if (number > maximum) return `Maximum is ${maximum}`;
      return true;
    },
  });
  return Number(value);
}

export async function confirm({
  message,
  defaultValue = false,
  input = process.stdin,
  output = process.stderr,
}) {
  return singleSelect({
    message,
    input,
    output,
    initialIndex: defaultValue ? 0 : 1,
    options: [
      { value: true, label: "Yes" },
      { value: false, label: "No" },
    ],
  });
}

export async function secretInput({
  message,
  validate = () => true,
  input = process.stdin,
  output = process.stderr,
}) {
  const theme = createTheme(output);
  let value = "";
  let renderedLength = 0;

  return withRawMode(input, output, async () => {
    write(output, `${theme.bold("?")} ${message}: `);
    while (true) {
      const chunk = await nextChunk(input);
      const key = decodeKey(chunk);
      if (key === "ctrl-c" || key === "escape") throw new WizardCancelledError();
      if (key === "backspace") value = value.slice(0, -1);
      else if (key === "enter") {
        const result = await validate(value);
        if (result === true) {
          write(output, `\r${CSI}2K${theme.green("✓")} ${message}: ${"•".repeat(Math.min(value.length, 8))}\n`);
          return value;
        }
        write(output, `\r${CSI}2K${theme.red("!")} ${String(result || "Invalid value")}\n`);
        value = "";
        renderedLength = 0;
        write(output, `${theme.bold("?")} ${message}: `);
        continue;
      } else if (chunk.length === 1 && chunk >= " " && chunk !== "\u007f") {
        value += chunk;
      }

      if (key !== "enter") {
        if (renderedLength > 0) write(output, `${"\b".repeat(renderedLength)}${" ".repeat(renderedLength)}${"\b".repeat(renderedLength)}`);
        const masked = "•".repeat(value.length);
        write(output, masked);
        renderedLength = masked.length;
      }
    }
  });
}

export class Spinner {
  constructor({
    message,
    output = process.stderr,
    frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    intervalMs = 80,
  }) {
    this.message = String(message);
    this.output = output;
    this.frames = frames;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.index = 0;
    this.theme = createTheme(output);
  }

  start() {
    if (this.timer) return this;
    if (!this.output.isTTY) {
      write(this.output, `${this.message}...\n`);
      return this;
    }
    const tick = () => {
      const frame = this.frames[this.index % this.frames.length];
      this.index += 1;
      write(this.output, `\r${CSI}2K${this.theme.cyan(frame)} ${this.message}`);
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop({ status = "success", message = this.message } = {}) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.output.isTTY) return;
    const icon = status === "success" ? this.theme.green("✓") : status === "warning" ? this.theme.yellow("!") : this.theme.red("✗");
    write(this.output, `\r${CSI}2K${icon} ${message}\n`);
  }
}

export async function withSpinner(message, operation, output = process.stderr) {
  const spinner = new Spinner({ message, output }).start();
  try {
    const result = await operation();
    spinner.stop({ status: "success", message });
    return result;
  } catch (error) {
    spinner.stop({ status: "error", message: `${message}: ${error.message}` });
    throw error;
  }
}
```

## 7.4 TUI process policy

The command entrypoint wraps the wizard:

```js
try {
  await runWizard();
} catch (error) {
  if (error?.code === 130) {
    process.stderr.write("\nWizard cancelled. No changes were applied.\n");
    process.exitCode = 130;
  } else {
    process.stderr.write(`\nWizard failed: ${error.message}\n`);
    process.exitCode = typeof error?.code === "number" ? error.code : 1;
  }
}
```

No module should call `process.exit()` while holding a lock or raw mode. Let `finally` cleanup run, then set `process.exitCode`.

---

# 8. TypeScript and ESM contracts

The runtime remains `.mjs`; these TypeScript interfaces define the public contract and may be published as declarations without adding a runtime dependency.

```ts
export type GateMode = "working-tree" | "staged" | "committed";
export type RepositoryMode = "repository" | "repoless";
export type RunnerMode = "local" | "worktree" | "container" | "external";
export type NetworkPolicy = "blocked" | "allowlisted" | "inherited";
export type CommandKind = "test" | "build" | "lint" | "typecheck" | "custom";
export type CriterionKind =
  | "command-exit"
  | "test-name"
  | "file-exists"
  | "file-absent"
  | "content-match"
  | "json-schema"
  | "hash-unchanged"
  | "benchmark-threshold"
  | "diff-property";

export interface StructuredCommand {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  required: boolean;
  network: NetworkPolicy;
  env?: Record<string, string>;
}

export interface TrustedShellCommand {
  shell: true;
  command: string;
  shellProgram: string;
  cwd: string;
  timeoutMs: number;
  required: boolean;
  trusted: true;
  network: NetworkPolicy;
}

export type CommandSpec = StructuredCommand | TrustedShellCommand;

export interface DetectionEvidence {
  kind: "manifest" | "lockfile" | "script" | "tool-metadata" | "file-pattern" | "existing-config";
  path?: string;
  detail: string;
  weight: number;
}

export interface CommandCandidate {
  kind: CommandKind;
  command: CommandSpec;
  confidence: number;
  evidence: DetectionEvidence[];
  validation?: CommandValidation;
}

export interface CommandValidation {
  attempted: boolean;
  ok: boolean;
  exitCode?: number;
  durationMs?: number;
  stdoutDigest?: string;
  stderrDigest?: string;
  summary?: string;
}

export interface WorkspaceNode {
  id: string;
  path: string;
  ecosystem: string;
  packageName?: string;
  manifests: string[];
  ownership: string[];
  sharedTriggers: string[];
  dependencies: string[];
  dependents: string[];
  confidence: number;
  commands: Partial<Record<CommandKind, CommandSpec>>;
}

export interface JulesConfiguration {
  name: "jules";
  apiVersion: "v1alpha";
  apiBaseUrl: string;
  apiKeyEnv: string;
  requestTimeoutMs: number;
  defaultSource?: string;
  baseBranch: string;
  defaultAutomationMode?: "AUTO_CREATE_PR";
  requirePlanApproval: boolean;
}

export interface LocalProfile {
  id: "free-individual" | "pro" | "custom-enterprise" | string;
  localDailyTasks: number;
  concurrency: number;
  staggerMs: number;
  repairAttempts: number;
  promptKb: number;
  diffKb: number;
}

export interface AgentConfigurationV3 {
  schema: "agentctl/config-v3";
  configRevision: number;
  project: {
    name: string;
    root: string;
    repositoryMode: RepositoryMode;
    baseBranch: string;
    defaultSource?: string;
    instructionsFile: string;
  };
  provider: JulesConfiguration;
  profile: LocalProfile;
  runner: {
    mode: RunnerMode;
    isolation: string;
    worktreeRoot: string;
    retainFailedWorktrees: boolean;
    defaultCommandTimeoutMs: number;
  };
  scope: {
    deny: string[];
    protect: string[];
    defaultAllow: string[];
    protectedOverridePolicy: "forbid" | "explicit-human-approval";
    maxFilesPerTask: number;
  };
  security: {
    preDispatchSecretScan: boolean;
    blockHighConfidenceSecrets: boolean;
    confirmLowConfidenceSecrets: boolean;
    entropyThreshold: number;
    minimumEntropyLength: number;
    piiRedaction: boolean;
    untrustedContextFencing: boolean;
  };
  verification: {
    requireOracle: boolean;
    aggregateStrategy: "all-required";
    localGateMode: GateMode;
    ciGateMode: GateMode;
    noOraclePolicy: "block-dispatch" | "allow-with-explicit-override";
  };
  workspaces: Record<string, WorkspaceNode>;
  presets: Record<string, { enabled: boolean; file: string }>;
}

export interface AcceptanceCriterion {
  id: string;
  statement: string;
  kind: CriterionKind;
  required: boolean;
  commandRef?: string;
  expectedExit?: number;
  expectedTests?: string[];
  predicate?: Record<string, unknown>;
  evidence: string;
  workspace?: string;
}

export interface TaskEnvelopeV1 {
  schema: "agentctl/task-v1";
  id: string;
  title: string;
  state: "draft" | "queued" | "running" | "completed" | "failed" | "deferred";
  createdAt: string;
  baseRef: string;
  baseSha: string;
  riskTier: string;
  intentHash: string;
  envelopeHash: string;
  jules: {
    mode: RepositoryMode;
    source?: string;
    startingBranch?: string;
    autoPr: boolean;
    requirePlanApproval: boolean;
  };
  objective: string;
  currentBehavior: string;
  expectedBehavior: string;
  nonGoals: string[];
  scope: {
    writeAllow: string[];
    readContext: string[];
    deny: string[];
    protect: string[];
    ownershipDomain: string;
  };
  limits: {
    diffKb: number;
    promptKb: number;
    maxFiles: number;
  };
  criteria: AcceptanceCriterion[];
  prompt: string;
}

export interface PresetV1 {
  schema: "agentctl/preset-v1";
  metadata: {
    id: string;
    name: string;
    version: string;
    description: string;
    owner: string;
    minimumKitVersion: string;
  };
  inputs: Record<string, PresetInput>;
  scope: Record<string, unknown>;
  verification: Record<string, unknown>;
  jules: Record<string, unknown>;
  fanout: Record<string, unknown>;
  schedule: Record<string, unknown>;
  risk: Record<string, unknown>;
}

export interface PresetInput {
  type: "string" | "boolean" | "integer" | "single-select" | "multi-select" | "repo-path" | "workspace-id";
  required: boolean;
  prompt: string;
  default?: unknown;
  options?: unknown[];
}

export interface WizardChange {
  operation: "create" | "update-managed" | "delete-managed";
  path: string;
  mode: number;
  previousHash?: string;
  contentHash: string;
  content: string;
}

export interface WizardPlan {
  kind: "init-plan" | "task-plan" | "migration-plan";
  root: string;
  changes: WizardChange[];
  warnings: Array<{ code: string; message: string }>;
  errors: Array<{ code: string; message: string }>;
  evidence: Array<Record<string, unknown>>;
  requiresApproval: boolean;
  planHash: string;
}

export interface WizardIO {
  choose<T>(key: string, message: string, choices: Array<{ value: T; label: string; description?: string }>, initial?: T): Promise<T>;
  chooseMany<T>(key: string, message: string, choices: Array<{ value: T; label: string }>, initial?: T[]): Promise<T[]>;
  text(key: string, message: string, options?: { defaultValue?: string; validate?: (value: string) => true | string }): Promise<string>;
  number(key: string, message: string, options: { defaultValue: number; minimum: number; maximum: number }): Promise<number>;
  confirm(key: string, message: string, defaultValue?: boolean): Promise<boolean>;
  secret(key: string, message: string): Promise<string>;
  info(message: string): void;
  warn(message: string): void;
}
```

### 8.1 ESM service contracts

The public declaration surface is normative. It defines complete callable contracts without pretending that interface declarations are runtime implementations.

```ts
export interface InitPlanningInput {
  root: string;
  io: WizardIO;
  flags: Record<string, string | number | boolean | undefined>;
  env: Readonly<Record<string, string | undefined>>;
}

export interface TaskPlanningInput {
  root: string;
  io: WizardIO;
  seed: Record<string, unknown>;
  flags: Record<string, string | number | boolean | undefined>;
  env: Readonly<Record<string, string | undefined>>;
}

export interface AppliedWizardPlan {
  applied: boolean;
  files: string[];
  manifestHash: string;
}

export interface WorkspaceDetectionResult {
  nodes: WorkspaceNode[];
  warnings: Array<{ code: string; message: string }>;
}

export interface TaskValidationResult {
  ok: boolean;
  errors: Array<{ code: string; message: string; path?: string }>;
  warnings: Array<{ code: string; message: string; path?: string }>;
}

export interface CompiledPrompt {
  prompt: string;
  bytes: number;
  sections: Array<{ id: string; bytes: number }>;
  hash: string;
}

export declare function planInteractiveInit(input: InitPlanningInput): Promise<WizardPlan>;
export declare function planTaskCreate(input: TaskPlanningInput): Promise<WizardPlan>;
export declare function applyWizardPlan(
  plan: WizardPlan,
  options: { root: string; dryRun?: boolean },
): Promise<AppliedWizardPlan>;
export declare function detectWorkspaceGraph(
  root: string,
  options?: Record<string, unknown>,
): Promise<WorkspaceDetectionResult>;
export declare function validateCommand(
  commandSpec: CommandSpec,
  options?: Record<string, unknown>,
): Promise<CommandValidation>;
export declare function validateTaskEnvelope(
  task: TaskEnvelopeV1,
  config: AgentConfigurationV3,
): TaskValidationResult;
export declare function compileTaskPrompt(
  task: TaskEnvelopeV1,
  config: AgentConfigurationV3,
): CompiledPrompt;
```

Runtime implementations MUST satisfy these contracts and the normative behavior in this document, and MUST be verified through public command and packed-artifact tests.

---

# 9. Headless and non-interactive mode

## 9.1 Detection

Interactive mode requires both input and output TTYs. In CI or redirected execution:

- never enable raw mode;
- never prompt;
- never select a default that changes security posture;
- require flags, answers JSON, existing valid config, or safe detection defaults;
- fail with exit 64 and a list of missing answer keys.

## 9.2 Answer precedence

```text
explicit CLI flag
> answers JSON
> allowed environment variable
> existing user config
> validated high-confidence detection
> profile default
> missing required error
```

Secrets are read only from environment or a secret input channel; answer files may name secret environment variables but may not contain secret values.

## 9.3 Init answers example

```json
{
  "schema": "agentctl/init-answers-v1",
  "root": ".",
  "mode": "repository",
  "source": "sources/github/acme/platform",
  "baseBranch": "main",
  "profile": "pro",
  "profileOverrides": {
    "concurrency": 4,
    "localDailyTasks": 300
  },
  "workspaces": {
    "web": {
      "test": ["pnpm", "--filter", "@acme/web", "test"],
      "build": ["pnpm", "--filter", "@acme/web", "build"],
      "lint": ["pnpm", "--filter", "@acme/web", "lint"],
      "typecheck": ["pnpm", "--filter", "@acme/web", "typecheck"]
    }
  },
  "presets": ["nightly-security-audit", "flaky-test-quarantine", "doc-sync-sentinel"],
  "validateCommands": true
}
```

## 9.4 Task answers example

```json
{
  "schema": "agentctl/task-answers-v1",
  "title": "Add bounded retry handling to payment webhooks",
  "objective": "Retry transient 502/503 responses up to three attempts.",
  "currentBehavior": "A transient response fails immediately.",
  "expectedBehavior": "Bounded backoff retries while preserving idempotency.",
  "writeAllow": [
    "services/payments/src/webhook-sender.ts",
    "services/payments/test/webhook-sender.test.ts"
  ],
  "readContext": ["packages/http-client/**"],
  "workspace": "payments",
  "criteria": [
    {
      "id": "test",
      "kind": "command-exit",
      "commandRef": "workspaces.payments.commands.test",
      "expectedExit": 0,
      "required": true,
      "statement": "Payment tests pass",
      "evidence": "Exit 0 and named regression tests"
    }
  ],
  "jules": {
    "mode": "repository",
    "source": "sources/github/acme/platform",
    "startingBranch": "main",
    "autoPr": true,
    "requirePlanApproval": false
  }
}
```

## 9.5 Headless examples

```bash
agentctl init \
  --no-interactive \
  --answers .ci/agent-init.json \
  --yes \
  --json

cat task.json | agentctl task create \
  --no-interactive \
  --answers - \
  --yes \
  --json

agentctl task create \
  --prompt-file request.md \
  --source sources/github/acme/platform \
  --branch main \
  --auto-pr \
  --scope 'services/api/**' \
  --verify workspace:api:test \
  --no-interactive \
  --json
```

## 9.6 JSON output contract

Success:

```json
{
  "ok": true,
  "command": "task create",
  "planHash": "sha256:...",
  "applied": true,
  "task": {
    "id": "TASK-...",
    "path": ".agent/jules-queue/TASK-....md",
    "dispatchable": true
  },
  "warnings": []
}
```

Failure:

```json
{
  "ok": false,
  "command": "task create",
  "code": 64,
  "error": "MISSING_REQUIRED_ANSWERS",
  "missing": ["objective", "criteria", "scope.writeAllow"],
  "warnings": []
}
```

---

# 10. Secret scrubbing and pre-dispatch analysis

## 10.1 Scan surfaces

Before save and again before dispatch, scan:

- operator task instructions;
- untrusted issue/TODO/review context;
- attached text snippets;
- generated prompt;
- task metadata;
- selected working-tree/staged/committed diff according to gate mode.

Never ingest `.env`, private-key files, credential stores, or ignored secret paths as context.

## 10.2 Detection layers

```text
Layer 1: high-confidence token/private-key patterns -> block
Layer 2: low-confidence key/value and authorization patterns -> confirm/block by policy
Layer 3: entropy candidates -> review with false-positive filters
Layer 4: active environment secret exact-value redaction -> redact
Layer 5: PII patterns -> redact or explicit approval
```

Entropy is not a universal secret detector. Apply it only to bounded token-like substrings with:

- minimum length;
- mixed character classes;
- exclusion of hashes explicitly labeled as public checksums;
- exclusion of paths/UUIDs/test fixtures under policy;
- no output of the candidate value.

## 10.3 Finding output

```text
Blocked sensitive content

  Source: pasted issue context
  Line: 14
  Type: GitHub personal access token pattern
  Fingerprint: sha256:8a71c42e

The value was not printed or stored.
Remove it from the task and rotate it if it may be live.
```

Store only type, location, and a short one-way fingerprint. Never write the value to telemetry.

## 10.4 Override policy

High-confidence secrets are never dispatchable through an override. A user may mark a known synthetic fixture via a tracked allow rule containing a content hash and reason, not the plaintext secret.

Low-confidence/PII exceptions require:

- interactive confirmation or signed headless policy;
- reason;
- field-level redaction preview;
- no CI default override.

---

# 11. Migration and template drift

## 11.1 Schema versioning

Every managed file declares a schema ID. Config migrations are pure transforms:

```text
agentctl/config-v1 -> v2 -> v3
agentctl/task-v1   -> future task versions
agentctl/preset-v1
```

A tool MUST NOT write a schema newer than it understands or downgrade a newer file.

## 11.2 Sync manifest

`.agent/sync-manifest.json` records per managed region/file:

```json
{
  "schema": "agentctl/sync-manifest-v1",
  "kitVersion": "0.28.2",
  "configSchema": "agentctl/config-v3",
  "files": {
    ".agent/jules.yml": {
      "ownership": "generated",
      "baseHash": "sha256:...",
      "currentHash": "sha256:...",
      "templateVersion": "3.0.0"
    },
    ".agent/presets/doc-sync-sentinel.yml": {
      "ownership": "managed-copy",
      "baseHash": "sha256:...",
      "currentHash": "sha256:...",
      "templateVersion": "1.1.0"
    },
    "AGENTS.md": {
      "ownership": "user",
      "currentHash": "sha256:..."
    }
  }
}
```

## 11.3 Three-way migration

For each managed file:

```text
BASE    template content last installed
OURS    current repository content
THEIRS  new package template
```

Rules:

- `OURS == BASE`: update to THEIRS;
- `THEIRS == BASE`: keep OURS;
- both changed: generate conflict plan, never concatenate or discard;
- user-owned file: never overwrite; propose a patch/managed block only;
- unknown fields: preserve unless invalid under hard policy;
- deleted custom preset: do not recreate unless explicitly enabled.

## 11.4 Migration UX

```text
Configuration migration: schema 2 -> 3

Safe automatic changes: 8
User conflicts: 2
Security-required changes: 1

  CONFLICT .agent/config.yml / workspaces.api.commands.test
    current: pytest -q
    proposed: uv run pytest -q

? Resolution
  ❯ Keep current
    Use proposed
    Enter custom
    Skip migration
```

## 11.5 Backups and rollback

Before apply:

```text
.agent/history/<timestamp>-migration/
├── manifest.json
├── config.yml
├── jules.yml
└── presets/...
```

Backups MUST exclude secrets and ignored runtime state. A journal records intent/done. `agentctl config rollback <migration-id>` validates hashes before restoring.

---

# 12. August 2026 context-window and payload optimization

## 12.1 Do not assume one model context size

Jules model access and context behavior may vary by plan and time. The wizard uses byte budgets and structural relevance, not a hard-coded model token count.

## 12.2 Prompt layers

Compile in this order:

```text
1. Short task objective
2. Expected behavior and non-goals
3. Exact write/read scope
4. Acceptance criteria and command references
5. Minimal untrusted seed context
6. Standard invariant footer
```

Do not paste:

- entire source files Jules can read from the repository;
- lockfiles;
- generated/minified code;
- full CI logs when a normalized failure excerpt is enough;
- duplicate AGENTS/rule text;
- binary data;
- unrelated issue discussions.

## 12.3 Context index instead of content dump

```text
Relevant symbols (hints, verify before use):
- services/payments/src/webhook-sender.ts: sendWebhook
- services/payments/test/webhook-sender.test.ts: existing webhook tests
- packages/http-client/src/retry.ts: read-only retry conventions
```

These are hints from deterministic search, not asserted signatures. The read-before-write invariant requires Jules to inspect them.

## 12.4 Budget model

Track separately:

```text
promptBytes
untrustedContextBytes
failureEvidenceBytes
diffBudgetBytes
artifactBytes
```

Defaults:

```text
prompt hard cap: 50 KB
untrusted context target: <= 10 KB
failure excerpt target: <= 8 KB
diff governor: 75 KB
```

A token estimate MAY be displayed as `ceil(characters / 4)` for rough English planning, explicitly labeled approximate and never used as a security boundary.

## 12.5 Reduction algorithm

When over budget:

```text
1. Remove duplicate whitespace and repeated rules.
2. Replace copied source with path/symbol index.
3. Summarize untrusted discussion while retaining a hash and direct quoted requirement lines.
4. Keep only first/last bounded failure excerpts plus normalized fingerprint.
5. Split independent acceptance criteria into tasks.
6. Split workspaces by ownership.
7. Never truncate the invariant footer or required criteria.
8. Abort if safe reduction cannot fit.
```

## 12.6 Anti-truncation integrity

The compiled prompt carries metadata:

```json
{
  "policyVersion": "agentctl/invariants-v1",
  "promptBytes": 4871,
  "promptSha256": "...",
  "sections": ["objective", "scope", "criteria", "context", "invariants"]
}
```

Do not expect the model to verify a hash. The hash is for transport/audit integrity.

## 12.7 Follow-up over initial overload

For interactive sessions, send a concise initial task. Use activities and `sendMessage` for genuinely new feedback rather than preloading speculative context. Plan approval is the right point to correct assumptions.

---

# 13. Strategic open questions — decisions

## 13.1 Monorepo and workspace graph resolution

**Decision:** build a graph from manifests and tool metadata; do not use one root stack.

- detect package boundaries with bounded scanning;
- use ecosystem metadata tools when available;
- group repeated service templates;
- ask users to resolve overlaps;
- route changed files to nearest owners;
- expand shared contracts to dependents;
- provide selection/filter UX for large graphs;
- store stable workspace IDs in config;
- re-detect incrementally using manifest hashes;
- never dispatch a broad refactor until ownership domains are disjoint or sequenced.

Innovative extension: maintain an **impact lens** for task creation. As paths are toggled, the TUI updates direct and dependent verification domains live, making hidden blast radius visible before dispatch.

## 13.2 Headless/non-interactive CI

**Decision:** one planner, multiple input adapters.

- TTY adapter gathers answers;
- JSON adapter supplies answers;
- flags override JSON;
- environment supplies secret references and selected operational values;
- `--yes` approves a complete plan only;
- missing required answers fail, never prompt;
- `--dry-run --json` is the review artifact;
- stdout is JSON only; progress goes to stderr;
- deterministic exit codes;
- no raw mode without a TTY;
- no hidden default that enables auto-PR or weakens approval.

Innovative extension: CI can sign an answers file hash in repository policy, allowing centrally reviewed setup/task templates without storing secrets.

## 13.3 Secret scrubbing and static analysis

**Decision:** block known high-confidence secrets, review entropy findings, redact all outbound context classes, and never display secret values.

- scan operator and untrusted fields separately;
- exact-match active environment values;
- regex token families;
- bounded entropy candidates;
- PII redaction;
- short SHA-256 fingerprint only;
- synthetic fixture allow rules by hash/reason;
- repeat scan after prompt compilation;
- repeat diff scan in selected gate mode;
- refuse override for probable live credentials.

Innovative extension: a **sensitivity budget** records how many redactions occurred by context source. Tasks with unexpected redaction density are stopped for human review rather than sent as degraded prompts.

## 13.4 Template drift and migration

**Decision:** schema migrations plus manifest-backed three-way updates.

- distinguish generated, managed-copy, managed-block, and user-owned files;
- preserve unknown/custom fields;
- never overwrite user files on package upgrade;
- preview every migration;
- back up before apply;
- journal and hash writes;
- conflict resolution is interactive or explicit headless input;
- package templates carry semantic versions;
- config schema is independent of package version;
- rollback validates current hashes.

Innovative extension: `doc-sync-sentinel` can open a migration advisory task when templates drift, but the config migrator remains deterministic and local.

## 13.5 2026 context optimization

**Decision:** optimize for relevance and invariant survival, not maximum context consumption.

- repository paths instead of pasted code;
- exact criteria instead of long personas;
- one standard footer by policy version;
- deduplicate instructions already in AGENTS;
- bounded issue/log excerpts;
- graph-aware workspace context;
- split tasks at ownership and verification boundaries;
- approximate tokens only for UX;
- enforce byte caps mechanically;
- use follow-up messages for new information;
- never truncate scope, criteria, or safety invariants.

Innovative extension: the wizard computes an **instruction density score**:

```text
actionable requirement bytes / total prompt bytes
```

Low-density prompts trigger a preview suggesting removable narrative, duplicated rules, and copied source.

---

# 14. Security and operational edge cases

## 14.1 Interrupted init

- lock and journal remain;
- next invocation reaps only after PID/start-time validation;
- temp files are ignored and identified by operation ID;
- no partial rename set is considered success;
- manifest update is last;
- recovery verifies every intended target hash.

## 14.2 Dirty repository

Initialization may write only `.agent` and managed `.gitignore` lines after preview. Task creation defaults to working-tree inspection. Dispatch is blocked on conflicting dirty paths.

## 14.3 Symlink paths

All wizard reads/writes use `lstat`. Managed outputs reject symlink targets. Repository selections resolve real paths and verify containment. Untracked diff generation must not follow symlinks outside root.

## 14.4 Huge repositories

Defaults:

```text
max scan entries: 200,000
max depth: 20
max single manifest: 2 MB
max total manifest bytes: 32 MB
scan timeout: 15s local default
```

On limit, return partial evidence and require explicit workspace roots.

## 14.5 Missing tools

Detection remains useful without execution. A missing binary lowers confidence and prevents oracle validation. The wizard never installs the tool automatically.

## 14.6 Container-only projects

Ask for:

- Compose file;
- service name selected from `docker compose config --services`;
- noninteractive exec command;
- setup/start policy;
- cleanup policy;
- mounted working directory;
- test command inside service.

Store structured container execution, not a hard-coded `app` service.

## 14.7 Protected dependency tasks

Dependency audit presets often need lockfiles. They require a separate elevated task type:

- lockfile write scope explicit;
- package manifest protected approval;
- install command recorded;
- dependency diff size handled separately;
- license/security checks;
- human review required.

## 14.8 Jules source unavailable

The wizard lists Sources. If the repository is not connected:

```text
1. Explain how to install/authorize the Jules GitHub App.
2. Provide official settings link.
3. Offer repoless mode only when semantically valid.
4. Never fabricate a source name.
5. Save a draft configuration with `source_validation: pending` only if dispatch stays blocked.
```

## 14.9 Quota mismatch

Local profile is a desired safety maximum. On 429:

- respect `Retry-After`;
- persist deferred-until;
- reduce effective concurrency;
- never mark completed;
- display provider-limited status;
- do not rewrite the user’s chosen profile automatically.

---

# 15. Testing strategy

## 15.1 Unit tests

- YAML-Lite parsing/emission, duplicates, blocked keys, depth/size;
- schema validation;
- detector confidence;
- workspace overlap and graph edges;
- command rendering and path containment;
- answer precedence;
- falsifiability rules;
- prompt compiler budgets/deduplication;
- secret finding redaction;
- preset variable expansion and cycles;
- migration transforms and three-way decisions;
- TUI key decoding and rendering with fake streams.

## 15.2 Integration fixtures

```text
fixtures/
├── node-npm/
├── node-pnpm-workspace/
├── turbo/
├── nx/
├── rust-workspace/
├── go-work/
├── python-poetry/
├── python-uv/
├── cmake/
├── bazel/
├── elixir-umbrella/
├── docker-compose/
└── polyglot-monorepo/
```

Each fixture asserts detection facts, candidate commands, user decisions, config output, and task routing. External tool validation is skipped only with an explicit reason.

## 15.3 Packed-artifact tests

From `npm pack`:

- install in empty temporary Git repository;
- install in Node repository;
- run ephemeral init path;
- run every generated command;
- ensure no copied unresolved scripts;
- verify workflow/preset assets exist;
- import public wizard APIs;
- compare generated config hashes.

## 15.4 TTY tests

Use a pseudo-terminal in CI only if available through operating-system tools; core rendering logic MUST be testable with fake readable/writable streams without third-party libraries. Manual acceptance covers terminal emulators on Linux, macOS, Windows Terminal, PowerShell, and CI non-TTY.

## 15.5 Security tests

- prompt secret fixtures without static live-looking literals;
- untrusted issue secret redaction;
- symlink escape;
- path traversal;
- preset variable injection;
- shell metacharacter workspace path;
- malicious YAML keys/anchors/tags;
- oversized answer/config/task;
- interrupted transaction;
- stale/live mutex distinction;
- protected-path precedence;
- working-tree/staged/committed gate end to end.

---

# 16. Rollout plan

## Milestone 1 — Planning core and schemas

- YAML-Lite v1;
- config/task/preset validators;
- pure plan model;
- migrations and sync manifest;
- no TUI yet;
- headless JSON tests first.

## Milestone 2 — Stack Oracle

- bounded facts scan;
- workspace graph;
- Node/Rust/Go/Python initial adapters;
- custom oracle fallback;
- structured command validation.

## Milestone 3 — Native TUI

- primitives from Module D;
- init screens;
- cancellation/cleanup;
- accessibility/no-color behavior.

## Milestone 4 — Task authoring

- seed adapters;
- decomposition/falsifiability;
- scope governor;
- secret preflight;
- task artifact and prompt compiler.

## Milestone 5 — Presets and schedules

- four built-ins;
- custom preset validator;
- schedule registry projection;
- no automatic scheduler activation.

## Milestone 6 — Enterprise hardening

- webhook/runner fields;
- organization policy overlay;
- migrations/rollback;
- packed-artifact matrix;
- Windows/macOS support;
- external beta.

---

# 17. Definition of done

The subsystem is production-ready only when all are true:

### Init

- [ ] Fresh and existing repositories produce deterministic plans.
- [ ] No write occurs before preview/approval.
- [ ] Config migration preserves user changes.
- [ ] Every configured workspace has a validated required oracle or is blocked.
- [ ] Jules Source and base branch are real and validated.
- [ ] No secret value enters tracked files.
- [ ] Generated files pass schema and hash checks.
- [ ] Empty, Node, non-Node, and polyglot packed-artifact tests pass.

### Task create

- [ ] Vague tasks cannot become dispatchable without measurable criteria.
- [ ] Paths exist and scope is deny-first.
- [ ] Working-tree/staged/committed mode works end to end.
- [ ] Active ownership overlaps are blocked or sequenced.
- [ ] High-confidence secrets are blocked in every context class.
- [ ] Prompt and diff budgets are enforced.
- [ ] Repository and repoless Jules bodies are correct.
- [ ] Auto-PR and plan-approval choices appear in captured request bodies.
- [ ] Saved task hash verifies after re-read.

### Presets

- [ ] Presets are declarative and cannot execute arbitrary extension code.
- [ ] Variables are allowlisted and escaped.
- [ ] Hard denies cannot be weakened.
- [ ] Built-ins pass schema and fixture tests.
- [ ] Custom files survive package migration.

### TUI/headless

- [ ] Raw mode/cursor always restored.
- [ ] Ctrl+C exits 130 without partial writes.
- [ ] NO_COLOR and narrow terminals work.
- [ ] No-TTY mode never prompts or hangs.
- [ ] JSON stdout is uncontaminated.
- [ ] Answer precedence and missing-field errors are stable.

### Operations

- [ ] Transactions are locked, journaled, atomic, and recoverable.
- [ ] Versioned migrations and rollback work.
- [ ] State corruption fails closed.
- [ ] Audit output contains no secrets.
- [ ] Documentation examples execute in CI.

---

# 18. Final recommendation

Implement the wizard as a deterministic planning and policy subsystem, not as a collection of interactive prompts bolted directly onto `bin/agentctl.mjs`. The key architectural seam is:

```text
inputs -> immutable plan -> validated transaction
```

That seam enables:

- the same behavior in TTY and CI;
- complete previewability;
- reliable migration;
- packed-artifact testing;
- enterprise policy overlays;
- zero-dependency implementation;
- honest safety boundaries.

The Stack Oracle should be deliberately humble: it gathers evidence, proposes candidates, and proves commands when authorized. The Task Wizard should be deliberately strict: it refuses to dispatch work that has no deterministic definition of success. Presets should remain declarative and reviewable. The TUI should remain a replaceable adapter around pure logic.

Done this way, onboarding becomes more than setup convenience. It becomes the first enforcement point for source correctness, scope ownership, verification quality, secret hygiene, provider intent, and durable agent operations—the properties required to make Google Jules useful to both first-time users and high-volume engineering teams.