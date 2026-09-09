# agentctl Command Reference

> Auto-generated from `src/ops/command-registry.mjs`. Do not edit by hand —
run `node scripts/generate-command-reference.mjs` to regenerate.

Total commands: 52

## Index

- [`agentctl assert`](#assert) — Run declarative zero-dependency verification assertion primitives
- [`agentctl doctor`](#doctor) — Run repository diagnostics and guided fixes
- [`agentctl queue`](#queue) — Execute pending task envelopes: dispatches each to the provider and moves it out of the queue
- [`agentctl swarm`](#swarm) — Dispatch every queued task in parallel across worker slots
- [`agentctl task`](#task) — Manage task envelopes: create, template, or optimize prompts (see task create | task template | task optimize)
- [`agentctl task create`](#task-create) — Author a scoped, falsifiable task
- [`agentctl task template`](#task-template) — List and synthesize web task template envelopes
- [`agentctl task optimize`](#task-optimize) — Score task prompt falsifiability and static path resolution
- [`agentctl init`](#init) — Configure Stack Oracle and Jules provider manifests
- [`agentctl dashboard`](#dashboard) — Start local web dashboard server
- [`agentctl budget`](#budget) — Show today's task budget, where its limit came from, and reconcile a wrong count
- [`agentctl status`](#status) — Show operating status and health summary
- [`agentctl escalate`](#escalate) — Dispatch or manage webhook escalation incidents with Silence Governor
- [`agentctl flaky`](#flaky) — Manage Wilson-quarantined tests and dispatch healing swarm
- [`agentctl handover`](#handover) — Inspect or generate Baton Pass session handover envelopes
- [`agentctl mutate`](#mutate) — Run zero-dependency diff mutation testing harness
- [`agentctl mutation`](#mutation) — Alias of mutate: run zero-dependency diff mutation testing harness
- [`agentctl coverage`](#coverage) — Run native zero-dependency V8 diff coverage check
- [`agentctl gate`](#gate) — Run CI security, rules, and stack verification gate
- [`agentctl check`](#check) — Alias of gate: run all-in-one CI security, rules, and stack verification gate
- [`agentctl audit`](#audit) — Alias of gate: run CI security and verification gate against current branch
- [`agentctl probe`](#probe) — Run test flakiness stability probe across N repetitions
- [`agentctl stability`](#stability) — Alias of probe: run test flakiness stability probe across N repetitions
- [`agentctl perf`](#perf) — Monitor Node.js event loop delay and Big-O performance lag
- [`agentctl event-loop`](#event-loop) — Alias of perf: monitor Node.js event loop delay and Big-O performance lag
- [`agentctl dispatch`](#dispatch) — Dispatch a single task to an AI agent
- [`agentctl bootstrap`](#bootstrap) — Bootstrap zero-test repository with verification oracle
- [`agentctl pr harvest`](#pr-harvest) — Scan, audit and auto-merge verified agent pull requests
- [`agentctl harvest`](#harvest) — Harvest failure traces and record resolution observations into system memory
- [`agentctl session get`](#session-get) — Retrieve remote execution status for a session ID
- [`agentctl session list`](#session-list) — List recent and active Jules sessions from remote API or local ledger
- [`agentctl plan approve`](#plan-approve) — Approve a pending execution plan for an agent session
- [`agentctl lock`](#lock) — Multi-agent coordination locks: acquire, release, or view file status
- [`agentctl evidence`](#evidence) — Manage cryptographic audit evidence (generate | verify | show)
- [`agentctl fix`](#fix) — Auto-repair from piped terminal logs or error trace (npm test 2>&1 | agentctl fix)
- [`agentctl patch`](#patch) — Extract and test/apply git patch from a Jules session
- [`agentctl retry`](#retry) — Retry failed session with automated failure-trace injection
- [`agentctl prune`](#prune) — Batch-archive or delete stale sessions via Jules API
- [`agentctl clean`](#clean) — Clean stale branches, worktrees, locks, and ledgers
- [`agentctl provider`](#provider) — Show provider readiness or switch the active provider (provider set <name>)
- [`agentctl providers`](#providers) — List agent providers and whether this machine can reach them
- [`agentctl profile`](#profile) — Show or set the verification profile
- [`agentctl ci init`](#ci) — Generate a stack-aware CI gate workflow
- [`agentctl review-repair`](#review-repair) — Parse PR review comments and synthesize OODA repair tasks
- [`agentctl scan`](#scan) — Scan codebase for TODO/FIXME task candidates
- [`agentctl rollback`](#rollback) — Restore git state and working tree to atomic pre-flight checkpoint
- [`agentctl resume`](#resume) — Resume warm session with human response
- [`agentctl test-gen`](#test-gen) — Scaffold and run automated TDD Red-to-Green test cycle
- [`agentctl mcp`](#mcp) — Start stdio MCP server or scaffold IDE integration config (mcp init)
- [`agentctl hydrate`](#hydrate) — Prepend active system learnings and baton-pass state to a prompt
- [`agentctl learning`](#learning) — Record a system learning rule into .agent/knowledge/
- [`agentctl rules`](#rules) — Audit rule token budgets or compile rule sentinels (check | compile)

## `agentctl assert`

**ID:** `assert` · **Category:** Inspect · **Risk:** LOW · **Mutates:** no

Run declarative zero-dependency verification assertion primitives

**Shortcuts:** `ast`

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--dir` | string | Target directory path for dir-size assertion (-d) |
| `--file` | string | Target file path for file-size assertion (-f) |
| `--targets` | string | Target glob/path for pattern matching (-t) |
| `--patterns` | string | Comma-separated patterns or regex to ban (-p) |
| `--patterns-file` | string | Path to JSON file containing banned patterns |
| `--max-bytes` | string | Maximum byte limit |
| `--max-kb` | string | Maximum KiB limit |
| `--max-mb` | string | Maximum MiB limit |
| `--gzip` | boolean | Measure gzip compressed byte size |
| `--config` | string | Path to assertion JSON/YAML config (-c) |
| `--json` | boolean | Output structured JSON assertion result (-j) |
| `--json-report` | string | Write structured JSON report to target path |

**Examples:**

```sh
agentctl assert --dir dist --max-mb 10 --gzip
agentctl assert --file dist/server.js --max-kb 500
agentctl assert --patterns "console.log" --targets "src/**/*.js"
agentctl assert --config assert.json --json
```

## `agentctl doctor`

**ID:** `doctor` · **Category:** Repair · **Risk:** LOW · **Mutates:** no

Run repository diagnostics and guided fixes

**Shortcuts:** `d`, `doc`

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--probe` | boolean | Actively start the provider CLI to check it answers, rather than only finding it on PATH |
| `--json` | boolean | Output structured JSON doctor report (-j) |

**Examples:**

```sh
agentctl doctor
agentctl doctor --probe
agentctl doctor --json
```

## `agentctl queue`

**ID:** `queue` · **Category:** Operate · **Risk:** MODERATE · **Mutates:** yes

Execute pending task envelopes: dispatches each to the provider and moves it out of the queue

**Shortcuts:** `q`

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--dag` | boolean | Resolve depends-on order via Kahn's algorithm before running |
| `--concurrency` | string | Parallel worker slots (defaults to limits.concurrency) (-c) |
| `--dry-run` | boolean | Report what would run without dispatching or moving anything (-d) |
| `--json` | boolean | Output structured JSON queue snapshot (-j) |

**Examples:**

```sh
agentctl queue --dry-run
agentctl queue
agentctl queue --dag --concurrency 3
agentctl queue --json
```

## `agentctl swarm`

**ID:** `swarm` · **Category:** Operate · **Risk:** MODERATE · **Mutates:** yes

Dispatch every queued task in parallel across worker slots

**Shortcuts:** `s`

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--concurrency` | string | Parallel worker slots (defaults to limits.concurrency) (-c) |
| `--dry-run` | boolean | Report what would run without dispatching (-d) |
| `--json` | boolean | Output structured JSON swarm result (-j) |

**Examples:**

```sh
agentctl swarm --dry-run
agentctl swarm
agentctl swarm --concurrency 3 --json
```

## `agentctl task`

**ID:** `task` · **Category:** Create · **Risk:** MODERATE · **Mutates:** yes

Manage task envelopes: create, template, or optimize prompts (see task create | task template | task optimize)

**Flags:** none.

**Examples:**

```sh
agentctl task create --title "Fix webhook" --prompt "Add retry handling"
agentctl task template --list
agentctl task optimize "Refactor auth" --fix
```

## `agentctl task create`

**ID:** `task-create` · **Category:** Create · **Risk:** MODERATE · **Mutates:** yes

Author a scoped, falsifiable task

**Shortcuts:** `tc`

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--title` | string | Short title for task (-t) |
| `--prompt` | string | Detailed task instructions (-p) |
| `--prompt-file` | string | Read prompt from file (-f) |
| `--role` | string | Specialist role (auditor, performance, security, hygiene, resilience, types, debugger, testing, e2e, database, docs, a11y) (-r) |
| `--tier` | string | Execution tier override (fast | complex) |
| `--template` | string | Task template preset ID |
| `--depends-on` | string | Comma-separated task dependency IDs |
| `--depends` | string | Alias for --depends-on |
| `--verify-cmd` | string | Verification command override (-v) |
| `--verify` | string | Alias for --verify-cmd |
| `--auto-pr` | boolean | Automatically create GitHub PR upon completion |
| `--require-plan-approval` | boolean | Require approval of agent plan before execution |
| `--repoless` | boolean | Execute in repoless sandbox mode |
| `--interactive` | boolean | Launch interactive task wizard (-i) |
| `--non-interactive` | boolean | Bypass interactive prompts and use CLI flags |
| `--no-interactive` | boolean | Alias for --non-interactive |
| `--yes` | boolean | Accept default values non-interactively (-y) |
| `--dry-run` | boolean | Simulate task envelope creation without queueing (-d) |
| `--json` | boolean | Output structured JSON envelope (-j) |

**Examples:**

```sh
agentctl task create --title "Fix webhook" --prompt "Add retry handling" --verify-cmd "npm test"
agentctl task create --interactive
```

## `agentctl task template`

**ID:** `task-template` · **Category:** Create · **Risk:** LOW · **Mutates:** no

List and synthesize web task template envelopes

**Shortcuts:** `tt`

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--list` | boolean | List available task templates (-l) |
| `--verify-cmd` | string | Verification command override (-v) |
| `--verify` | string | Alias for --verify-cmd |
| `--dry-run` | boolean | Simulate envelope synthesis (-d) |
| `--json` | boolean | Output structured JSON envelope (-j) |

**Examples:**

```sh
agentctl task template --list
agentctl task template <id> --json
```

## `agentctl task optimize`

**ID:** `task-optimize` · **Category:** Inspect · **Risk:** LOW · **Mutates:** no

Score task prompt falsifiability and static path resolution

**Shortcuts:** `to`, `optimize`

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--fix` | boolean | Synthesize optimized markdown task envelope (-f) |
| `--prompt` | string | Task prompt text to score (-p) |
| `--prompt-file` | string | Read prompt from file |
| `--file` | string | Alias for --prompt-file: path to text file containing task prompt |
| `--dir` | string | Target repository directory root (-d) |
| `--web` | boolean | Enable web-intent detection and optimization (-w) |
| `--verify-cmd` | string | Verification command override (-v) |
| `--verify` | string | Alias for --verify-cmd |
| `--dry-run` | boolean | Simulate scoring without side effects |
| `--json` | boolean | Output structured JSON prompt evaluation (-j) |

**Examples:**

```sh
agentctl task optimize "Fix JWT token expiry in src/auth.js"
agentctl task optimize "Refactor auth" --fix
agentctl task optimize --file prompt.txt --json
```

## `agentctl init`

**ID:** `init` · **Category:** Configure · **Risk:** MODERATE · **Mutates:** yes

Configure Stack Oracle and Jules provider manifests

**Shortcuts:** `i`

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--tier` | string | Target configuration tier (free, pro, ultra, enterprise) (-t) |
| `--provider` | string | Provider preset to record in the manifest (jules, claude-code, codex, gemini-flash) |
| `--profile` | string | Verification profile to record (minimal, standard, max) |
| `--interactive` | boolean | Launch interactive onboarding wizard (-i) |
| `--non-interactive` | boolean | Run non-interactively with defaults |
| `--no-interactive` | boolean | Alias for --non-interactive |
| `--yes` | boolean | Accept auto-detected Stack Oracle defaults (-y) |
| `--force` | boolean | Force overwrite existing config and assets (-f) |
| `--dry-run` | boolean | Preview plan without writing files (-d) |
| `--json` | boolean | Output structured JSON manifest (-j) |

**Examples:**

```sh
agentctl init
agentctl init --interactive
agentctl init --tier pro --yes
```

## `agentctl dashboard`

**ID:** `dashboard` · **Category:** Inspect · **Risk:** LOW · **Mutates:** no

Start local web dashboard server

**Shortcuts:** `dash`

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--port` | string | HTTP server port (default 4100) |
| `--host` | string | Bind host address (default 127.0.0.1) |

**Examples:**

```sh
agentctl dashboard
agentctl dashboard --port 3000
agentctl dashboard 3000
```

## `agentctl budget`

**ID:** `budget` · **Category:** Inspect · **Risk:** LOW · **Mutates:** no

Show today's task budget, where its limit came from, and reconcile a wrong count

**Shortcuts:** `b`

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--json` | boolean | Output structured JSON budget snapshot |
| `--by-user` | boolean | Show per-author attribution table (-u) |
| `--dry-run` | boolean | Report what reset would release, write nothing |
| `--yes` | boolean | Confirm releasing open reservations (-y) |
| `--all` | boolean | Also release reservations that reached the provider (reset only) |

**Examples:**

```sh
agentctl budget
agentctl budget --json
agentctl budget --by-user
agentctl budget reset --dry-run
agentctl budget reset --yes
agentctl budget reset --yes --all
```

## `agentctl status`

**ID:** `status` · **Category:** Inspect · **Risk:** LOW · **Mutates:** no

Show operating status and health summary

**Shortcuts:** `st`

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--json` | boolean | Output status in JSON format |

**Examples:**

```sh
agentctl status
agentctl status --json
```

## `agentctl escalate`

**ID:** `escalate` · **Category:** Operate · **Risk:** LOW · **Mutates:** yes

Dispatch or manage webhook escalation incidents with Silence Governor

**Shortcuts:** `esc`

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--reason` | string | Escalation reason category (-r) |
| `--branch` | string | Target git branch (-b) |
| `--logs` | string | Error logs text (-l) |
| `--log-file` | string | Read error logs from file |
| `--critical` | boolean | Bypass Silence Governor and alert immediately |
| `--flush` | boolean | Flush buffered escalation digest |
| `--status` | boolean | Inspect digest status and interruption budget |
| `--clear` | boolean | Clear pending digest buffer |
| `--dry-run` | boolean | Simulate dispatch without sending HTTP requests (-d) |
| `--json` | boolean | Output JSON structured response (-j) |

**Examples:**

```sh
agentctl escalate sess-123 --reason "AWAITING_USER_FEEDBACK"
agentctl escalate --status
agentctl escalate --flush
agentctl escalate --clear
```

## `agentctl flaky`

**ID:** `flaky` · **Category:** Repair · **Risk:** MODERATE · **Mutates:** yes

Manage Wilson-quarantined tests and dispatch healing swarm

**Shortcuts:** `flk`

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--dispatch` | boolean | Dispatch healing tasks directly to AI agents |
| `--role` | string | Agent persona role (default: hygiene) (-r) |
| `--test-cmd` | string | Target specific test command (-t) |
| `--dry-run` | boolean | Simulate healing swarm generation without writing (-d) |
| `--json` | boolean | Output JSON structured response (-j) |

**Examples:**

```sh
agentctl flaky status
agentctl flaky heal
agentctl flaky heal "npm test"
agentctl flaky reset
```

## `agentctl handover`

**ID:** `handover` · **Category:** Operate · **Risk:** LOW · **Mutates:** yes

Inspect or generate Baton Pass session handover envelopes

**Shortcuts:** `ho`

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--intent` | string | Task intent or goal description (-i) |
| `--status` | string | Handover status (aborted, rolled-back, escalated, failed) (-s) |
| `--completed` | string | Completed progress summary (-c) |
| `--assumptions` | string | Validated assumptions (-a) |
| `--landmines` | string | Obstacles or error summary (-l) |
| `--next-steps` | string | Actionable next steps for successor agent (-n) |
| `--limit` | string | Maximum handovers to list or keep on prune |
| `--context` | boolean | Print show output as injectable prompt context (show only) |
| `--json` | boolean | Output JSON structured response (-j) |

**Examples:**

```sh
agentctl handover list
agentctl handover show sess-123
agentctl handover create sess-123 --intent "Refactor auth" --status rolled-back
```

## `agentctl mutate`

**ID:** `mutate` · **Category:** Inspect · **Risk:** LOW · **Mutates:** no

Run zero-dependency diff mutation testing harness

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--base` | string | Base comparison branch (default: main or config base_branch) (-b) |
| `--mode` | string | Evaluation mode (working-tree | committed | staged) (-m) |
| `--working-tree` | boolean | Evaluate the working tree (default mode) |
| `--staged` | boolean | Evaluate staged changes |
| `--committed` | boolean | Evaluate committed changes |
| `--min-score` | string | Target minimum mutation score threshold (0-100) |
| `--max-mutants` | string | Maximum number of mutants to generate and test |
| `--cmd` | string | Test command override |
| `--json` | boolean | Output structured JSON mutation report (-j) |

**Examples:**

```sh
agentctl mutate
agentctl mutate --min-score 80
agentctl mutate --max-mutants 20 --cmd "npm test"
```

## `agentctl mutation`

**ID:** `mutation` · **Category:** Inspect · **Risk:** LOW · **Mutates:** no

Alias of mutate: run zero-dependency diff mutation testing harness

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--base` | string | Base comparison branch (default: main or config base_branch) (-b) |
| `--mode` | string | Evaluation mode (working-tree | committed | staged) (-m) |
| `--working-tree` | boolean | Evaluate the working tree (default mode) |
| `--staged` | boolean | Evaluate staged changes |
| `--committed` | boolean | Evaluate committed changes |
| `--min-score` | string | Target minimum mutation score threshold (0-100) |
| `--max-mutants` | string | Maximum number of mutants to generate and test |
| `--cmd` | string | Test command override |
| `--json` | boolean | Output structured JSON mutation report (-j) |

**Examples:**

```sh
agentctl mutation
agentctl mutation --min-score 80
agentctl mutation --max-mutants 20 --cmd "npm test"
```

## `agentctl coverage`

**ID:** `coverage` · **Category:** Inspect · **Risk:** LOW · **Mutates:** no

Run native zero-dependency V8 diff coverage check

**Shortcuts:** `cov`

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--min` | string | Minimum diff line coverage percentage required (-m) |
| `--min-coverage` | string | Alias for --min |
| `--cmd` | string | Test command override to run with V8 coverage (-c) |
| `--base` | string | Base comparison branch (default: main or config base_branch) (-b) |
| `--mode` | string | Evaluation mode (working-tree | committed | staged) |
| `--json` | boolean | Output structured JSON coverage report (-j) |

**Examples:**

```sh
agentctl coverage
agentctl coverage --min 80
agentctl coverage --cmd "node --test"
```

## `agentctl gate`

**ID:** `gate` · **Category:** Inspect · **Risk:** LOW · **Mutates:** no

Run CI security, rules, and stack verification gate

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--base` | string | Base comparison branch (default: main or config base_branch) (-b) |
| `--mode` | string | Evaluation mode (working-tree | committed | staged) (-m) |
| `--working-tree` | boolean | Evaluate the working tree (default mode) |
| `--staged` | boolean | Evaluate staged changes |
| `--committed` | boolean | Evaluate committed changes |
| `--fix` | boolean | Trigger automated OODA self-repair loop on failure |
| `--allow-protected` | boolean | Bypass protected path checks for authorized maintainers |
| `--allow-unreadable-tests` | boolean | Permit unreadable test dialects for this run |
| `--allow-test-modifications` | boolean | Waive every test-tampering check for this run |
| `--allow-test-change` | string | Waive one tampering check kind (repeatable) |
| `--strict-locks` | boolean | Enforce strict anti-tampering verification on test files |
| `--dry-run` | boolean | Simulate gate evaluation without persisting evidence (-d) |
| `--json` | boolean | Output structured JSON gate report (-j) |
| `--json-report` | string | Write structured JSON report to target path |

**Examples:**

```sh
agentctl gate
agentctl gate --mode working-tree
agentctl gate --fix
agentctl gate --json
```

## `agentctl check`

**ID:** `check` · **Category:** Inspect · **Risk:** LOW · **Mutates:** no

Alias of gate: run all-in-one CI security, rules, and stack verification gate

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--base` | string | Base comparison branch (default: main or config base_branch) (-b) |
| `--mode` | string | Evaluation mode (working-tree | committed | staged) (-m) |
| `--working-tree` | boolean | Evaluate the working tree (default mode) |
| `--staged` | boolean | Evaluate staged changes |
| `--committed` | boolean | Evaluate committed changes |
| `--fix` | boolean | Trigger automated OODA self-repair loop on failure |
| `--allow-protected` | boolean | Bypass protected path checks for authorized maintainers |
| `--allow-unreadable-tests` | boolean | Permit unreadable test dialects for this run |
| `--allow-test-modifications` | boolean | Waive every test-tampering check for this run |
| `--allow-test-change` | string | Waive one tampering check kind (repeatable) |
| `--strict-locks` | boolean | Enforce strict anti-tampering verification on test files |
| `--dry-run` | boolean | Simulate gate evaluation without persisting evidence (-d) |
| `--json` | boolean | Output structured JSON gate report (-j) |
| `--json-report` | string | Write structured JSON report to target path |

**Examples:**

```sh
agentctl check
agentctl check --base main --strict-locks
agentctl gate --strict-locks  # canonical spelling; check is an alias
agentctl check --fix
agentctl check --json
```

## `agentctl audit`

**ID:** `audit` · **Category:** Inspect · **Risk:** LOW · **Mutates:** no

Alias of gate: run CI security and verification gate against current branch

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--base` | string | Base comparison branch (default: main or config base_branch) (-b) |
| `--mode` | string | Evaluation mode (working-tree | committed | staged) (-m) |
| `--working-tree` | boolean | Evaluate the working tree (default mode) |
| `--staged` | boolean | Evaluate staged changes |
| `--committed` | boolean | Evaluate committed changes |
| `--fix` | boolean | Trigger automated OODA self-repair loop on failure |
| `--allow-protected` | boolean | Bypass protected path checks for authorized maintainers |
| `--allow-unreadable-tests` | boolean | Permit unreadable test dialects for this run |
| `--allow-test-modifications` | boolean | Waive every test-tampering check for this run |
| `--allow-test-change` | string | Waive one tampering check kind (repeatable) |
| `--strict-locks` | boolean | Enforce strict anti-tampering verification on test files |
| `--dry-run` | boolean | Simulate gate evaluation without persisting evidence (-d) |
| `--json` | boolean | Output structured JSON gate report (-j) |
| `--json-report` | string | Write structured JSON report to target path |

**Examples:**

```sh
agentctl audit
agentctl audit --mode working-tree
agentctl audit --fix
agentctl audit --json
```

## `agentctl probe`

**ID:** `probe` · **Category:** Inspect · **Risk:** LOW · **Mutates:** no

Run test flakiness stability probe across N repetitions

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--repeat` | string | Number of probe executions (default: 5) (-r) |
| `--iterations` | string | Alias for --repeat (-n) |
| `--min` | string | Minimum pass rate 0-1 (alias for --min-pass-rate) (-m) |
| `--min-pass-rate` | string | Minimum pass rate 0-1 (default: 1.0) |
| `--cmd` | string | Test command to probe (-c) |
| `--test-cmd` | string | Alias for --cmd (-t) |
| `--verify-cmd` | string | Alias for --cmd |
| `--record` | boolean | Persist results to flaky quarantine ledger (default: true) |
| `--no-record` | boolean | Skip recording to flaky quarantine ledger |
| `--json` | boolean | Output structured JSON probe telemetry (-j) |

**Examples:**

```sh
agentctl probe
agentctl probe --repeat 10
agentctl probe --repeat 5 --cmd "pytest"
```

## `agentctl stability`

**ID:** `stability` · **Category:** Inspect · **Risk:** LOW · **Mutates:** no

Alias of probe: run test flakiness stability probe across N repetitions

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--repeat` | string | Number of probe executions (default: 5) (-r) |
| `--iterations` | string | Alias for --repeat (-n) |
| `--min` | string | Minimum pass rate 0-1 (alias for --min-pass-rate) (-m) |
| `--min-pass-rate` | string | Minimum pass rate 0-1 (default: 1.0) |
| `--cmd` | string | Test command to probe (-c) |
| `--test-cmd` | string | Alias for --cmd (-t) |
| `--verify-cmd` | string | Alias for --cmd |
| `--record` | boolean | Persist results to flaky quarantine ledger (default: true) |
| `--no-record` | boolean | Skip recording to flaky quarantine ledger |
| `--json` | boolean | Output structured JSON probe telemetry (-j) |

**Examples:**

```sh
agentctl stability
agentctl stability --repeat 10
agentctl stability --repeat 5 --cmd "pytest"
```

## `agentctl perf`

**ID:** `perf` · **Category:** Inspect · **Risk:** LOW · **Mutates:** no

Monitor Node.js event loop delay and Big-O performance lag

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--max-ms` | string | Maximum allowable event loop delay threshold in ms (-m) |
| `--threshold` | string | Alias for --max-ms (-t) |
| `--cmd` | string | Command to execute during performance monitoring (-c) |
| `--resolution` | string | Sampling resolution in ms (default: 10) (-r) |
| `--json` | boolean | Output structured JSON performance report (-j) |

**Examples:**

```sh
agentctl perf
agentctl perf --max-ms 50 --cmd "npm test"
```

## `agentctl event-loop`

**ID:** `event-loop` · **Category:** Inspect · **Risk:** LOW · **Mutates:** no

Alias of perf: monitor Node.js event loop delay and Big-O performance lag

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--max-ms` | string | Maximum allowable event loop delay threshold in ms (-m) |
| `--threshold` | string | Alias for --max-ms (-t) |
| `--cmd` | string | Command to execute during performance monitoring (-c) |
| `--resolution` | string | Sampling resolution in ms (default: 10) (-r) |
| `--json` | boolean | Output structured JSON performance report (-j) |

**Examples:**

```sh
agentctl event-loop
agentctl event-loop --max-ms 50 --cmd "npm test"
```

## `agentctl dispatch`

**ID:** `dispatch` · **Category:** Operate · **Risk:** MODERATE · **Mutates:** yes

Dispatch a single task to an AI agent

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--title` | string | Task title (-t) |
| `--prompt` | string | Task prompt instructions (-p) |
| `--prompt-file` | string | Read prompt from file (-f) |
| `--role` | string | Specialist role (auditor, performance, security, hygiene, resilience, types, debugger, testing, e2e, database, docs, a11y) (-r) |
| `--tier` | string | Execution tier override (fast | complex) |
| `--check-premise` | boolean | Verify premise locally before dispatching |
| `--idempotent` | boolean | Alias for --check-premise |
| `--author` | string | Attribution author for the dispatch |
| `--verify-cmd` | string | Verification command override (-v) |
| `--verify` | string | Alias for --verify-cmd |
| `--source` | string | Jules repository source identifier (-s) |
| `--branch` | string | Starting branch for task execution (-b) |
| `--repoless` | boolean | Dispatch task in repoless execution mode |
| `--auto-pr` | boolean | Automatically create PR upon completion |
| `--require-plan-approval` | boolean | Require human approval for proposed plan |
| `--auto-approve-plans` | boolean | Run unattended without pausing for plan approval |
| `--auto-approve` | boolean | Alias for --auto-approve-plans |
| `--dry-run` | boolean | Simulate dispatch without sending to provider (-d) |
| `--json` | boolean | Output JSON structured dispatch result (-j) |

**Examples:**

```sh
agentctl dispatch --prompt "Add retry handling to src/webhook.js"
agentctl dispatch -p "Fix type errors" --role types --tier fast
agentctl dispatch --prompt-file task.md --dry-run
```

## `agentctl bootstrap`

**ID:** `bootstrap` · **Category:** Configure · **Risk:** MODERATE · **Mutates:** yes

Bootstrap zero-test repository with verification oracle

**Shortcuts:** `bs`

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--force` | boolean | Overwrite existing verification oracle or config (-f) |
| `--dry-run` | boolean | Simulate bootstrap without writing files (-d) |
| `--json` | boolean | Output JSON structured bootstrap result (-j) |

**Examples:**

```sh
agentctl bootstrap
agentctl bootstrap --force
```

## `agentctl pr harvest`

**ID:** `pr-harvest` · **Category:** Operate · **Risk:** MODERATE · **Mutates:** yes

Scan, audit and auto-merge verified agent pull requests

**Shortcuts:** `pr`

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--tier` | string | Filter PRs by tier label |
| `--limit` | string | Maximum PRs to harvest |
| `--auto` | boolean | Automatically merge qualifying green PRs |
| `--merge` | boolean | Merge matching PRs |
| `--allow-no-checks` | boolean | Allow PR merge when no CI checks are configured |
| `--dry-run` | boolean | Simulate PR harvest without merging (-d) |
| `--json` | boolean | Output structured JSON harvest report (-j) |

**Examples:**

```sh
agentctl pr harvest
agentctl pr harvest --auto
agentctl pr harvest --dry-run
agentctl pr harvest --json
```

## `agentctl harvest`

**ID:** `harvest` · **Category:** Operate · **Risk:** LOW · **Mutates:** yes

Harvest failure traces and record resolution observations into system memory

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--exit-code` | string | Failing command exit code (default: 4) |
| `--log` | string | Path to failure log file |
| `--diff` | string | Diff text or path describing the attempted change |
| `--task` | string | Task identifier for the failure |
| `--agent` | string | Agent name that produced the failure (default: jules) |
| `--dry-run` | boolean | Simulate harvesting without writing (-d) |
| `--json` | boolean | Output structured JSON harvest result (-j) |

**Examples:**

```sh
agentctl harvest --exit-code 4 --task TASK-1 --agent jules
agentctl harvest --exit-code 1 --log ./fail.log --json
```

## `agentctl session get`

**ID:** `session-get` · **Category:** Inspect · **Risk:** LOW · **Mutates:** no

Retrieve remote execution status for a session ID

**Shortcuts:** `session status`, `session`

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--dry-run` | boolean | Simulate session retrieval (-d) |
| `--json` | boolean | Output structured JSON session data (-j) |

**Examples:**

```sh
agentctl session get <sessionId>
agentctl session get <sessionId> --dry-run
agentctl session get <sessionId> --json
```

## `agentctl session list`

**ID:** `session-list` · **Category:** Inspect · **Risk:** LOW · **Mutates:** no

List recent and active Jules sessions from remote API or local ledger

**Shortcuts:** `sessions`

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--limit` | string | Maximum number of sessions to list (default: 20) (-l) |
| `--page-size` | string | Alias for --limit |
| `--remote` | boolean | Query remote Jules API |
| `--dry-run` | boolean | Simulate listing without remote requests (-d) |
| `--json` | boolean | Output structured JSON session list (-j) |

**Examples:**

```sh
agentctl session list
agentctl session list --limit 10
agentctl session list --json
```

## `agentctl plan approve`

**ID:** `plan-approve` · **Category:** Operate · **Risk:** MODERATE · **Mutates:** yes

Approve a pending execution plan for an agent session

**Shortcuts:** `approve`, `plan`

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--dry-run` | boolean | Simulate plan approval (-d) |
| `--json` | boolean | Output structured JSON result (-j) |

**Examples:**

```sh
agentctl plan approve <sessionId>
agentctl plan approve <sessionId> --dry-run
agentctl approve <sessionId>
```

## `agentctl lock`

**ID:** `lock` · **Category:** Operate · **Risk:** LOW · **Mutates:** yes

Multi-agent coordination locks: acquire, release, or view file status

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--ttl` | string | Lease duration in minutes for acquire (default: 120) |
| `--pid` | string | Bind the lock to a process id instead of a time lease |
| `--json` | boolean | Output structured JSON result (-j) |

**Examples:**

```sh
agentctl lock status
agentctl lock acquire agent-1 task-1 src/main.js
agentctl lock acquire agent-1 task-1 src/main.js --ttl 60
agentctl lock release task-1
```

## `agentctl evidence`

**ID:** `evidence` · **Category:** Inspect · **Risk:** LOW · **Mutates:** no

Manage cryptographic audit evidence (generate | verify | show)

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--output` | string | Output path for generate (-o) |
| `--manifest` | string | Manifest path for verify or show (-m) |
| `--markdown` | string | Markdown output path for generate |
| `--dry-run` | boolean | Simulate without writing (-d) |
| `--json` | boolean | Output structured JSON result (-j) |

**Examples:**

```sh
agentctl evidence generate
agentctl evidence verify
agentctl evidence show --json
```

## `agentctl fix`

**ID:** `fix` · **Category:** Repair · **Risk:** MODERATE · **Mutates:** yes

Auto-repair from piped terminal logs or error trace (npm test 2>&1 | agentctl fix)

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--input` | string | Inline error log text (-i) |
| `--file` | string | Path to file containing error logs (-f) |
| `--cmd` | string | Verification command for the repair task (-c) |
| `--task` | boolean | Synthesize a repair task envelope instead of dispatching (-t) |
| `--author` | string | Attribution author for the repair |
| `--dry-run` | boolean | Simulate repair without dispatching |
| `--json` | boolean | Output structured JSON result (-j) |

**Examples:**

```sh
npm test 2>&1 | agentctl fix
agentctl fix --file ./fail.log
agentctl fix --input "Error: boom" --task --json
```

## `agentctl patch`

**ID:** `patch` · **Category:** Operate · **Risk:** MODERATE · **Mutates:** yes

Extract and test/apply git patch from a Jules session

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--session` | string | Session ID (positional also accepted) (-s) |
| `--apply` | boolean | Apply the patch to the working tree (-a) |
| `--save` | string | Save patch content to file path |
| `--json` | boolean | Output structured JSON result (-j) |

**Examples:**

```sh
agentctl patch <sessionId>
agentctl patch <sessionId> --apply
agentctl patch <sessionId> --save ./fix.patch --json
```

## `agentctl retry`

**ID:** `retry` · **Category:** Operate · **Risk:** MODERATE · **Mutates:** yes

Retry failed session with automated failure-trace injection

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--session` | string | Session ID (positional also accepted) (-s) |
| `--role` | string | Specialist role for the retry (-r) |
| `--title` | string | Title for the retry session (-t) |
| `--without-failure` | boolean | Retry without injecting previous failure diagnostics |
| `--dry-run` | boolean | Simulate retry without dispatching (-d) |
| `--json` | boolean | Output structured JSON result (-j) |

**Examples:**

```sh
agentctl retry <sessionId>
agentctl retry <sessionId> --role debugger
agentctl retry <sessionId> --dry-run --json
```

## `agentctl prune`

**ID:** `prune` · **Category:** Operate · **Risk:** MODERATE · **Mutates:** yes

Batch-archive or delete stale sessions via Jules API

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--age` | string | Only match sessions older than this (e.g. 7d) (-a) |
| `--state` | string | Only match sessions in this state (-s) |
| `--delete` | boolean | Delete matched sessions instead of archiving |
| `--dry-run` | boolean | Report matches without archiving (-d) |
| `--yes` | boolean | Confirm archiving matched sessions (-y) |
| `--json` | boolean | Output structured JSON result (-j) |

**Examples:**

```sh
agentctl prune --json
agentctl prune --age 7d --dry-run
agentctl prune --age 30d --state COMPLETED --yes
```

## `agentctl clean`

**ID:** `clean` · **Category:** Operate · **Risk:** LOW · **Mutates:** yes

Clean stale branches, worktrees, locks, and ledgers

**Flags:** none.

**Examples:**

```sh
agentctl clean
```

## `agentctl provider`

**ID:** `provider` · **Category:** Configure · **Risk:** LOW · **Mutates:** yes

Show provider readiness or switch the active provider (provider set <name>)

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--json` | boolean | Output structured JSON provider list (-j) |

**Examples:**

```sh
agentctl provider
agentctl provider set codex
agentctl provider --json
```

## `agentctl providers`

**ID:** `providers` · **Category:** Inspect · **Risk:** LOW · **Mutates:** no

List agent providers and whether this machine can reach them

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--json` | boolean | Output structured JSON provider list (-j) |

**Examples:**

```sh
agentctl providers
agentctl providers --json
agentctl provider set codex
```

## `agentctl profile`

**ID:** `profile` · **Category:** Configure · **Risk:** LOW · **Mutates:** yes

Show or set the verification profile

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--list` | boolean | List available verification profiles (-l) |
| `--set` | string | Set the active verification profile |
| `--json` | boolean | Output structured JSON result (-j) |

**Examples:**

```sh
agentctl profile
agentctl profile --list
agentctl profile --set max
```

## `agentctl ci init`

**ID:** `ci` · **Category:** Configure · **Risk:** MODERATE · **Mutates:** yes

Generate a stack-aware CI gate workflow

**Shortcuts:** `ci-init`

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--target` | string | CI target (github | gitlab, default: github) |
| `--force` | boolean | Overwrite existing workflow file (-f) |
| `--dry-run` | boolean | Report what would be written (-d) |
| `--json` | boolean | Output structured JSON result (-j) |

**Examples:**

```sh
agentctl ci init
agentctl ci init --target gitlab --force
agentctl ci init --dry-run --json
```

## `agentctl review-repair`

**ID:** `review-repair` · **Category:** Repair · **Risk:** LOW · **Mutates:** no

Parse PR review comments and synthesize OODA repair tasks

**Flags:** none.

**Examples:**

```sh
agentctl review-repair ./reviews.json
```

## `agentctl scan`

**ID:** `scan` · **Category:** Inspect · **Risk:** LOW · **Mutates:** no

Scan codebase for TODO/FIXME task candidates

**Flags:** none.

**Examples:**

```sh
agentctl scan
```

## `agentctl rollback`

**ID:** `rollback` · **Category:** Repair · **Risk:** HIGH · **Mutates:** yes

Restore git state and working tree to atomic pre-flight checkpoint

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--reason` | string | Rollback reason recorded in the handover (-r) |
| `--intent` | string | Intent recorded in the handover (-i) |
| `--handover` | boolean | Write a Baton Pass handover envelope (default: true) |
| `--latest` | boolean | Restore the newest checkpoint explicitly |
| `--json` | boolean | Output structured JSON result (-j) |

**Examples:**

```sh
agentctl rollback --latest
agentctl rollback <sessionId> --json
agentctl rollback --latest --reason "bad deploy"
```

## `agentctl resume`

**ID:** `resume` · **Category:** Operate · **Risk:** MODERATE · **Mutates:** yes

Resume warm session with human response

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--response` | string | Human response text for the warm session (-r) |
| `--dry-run` | boolean | Simulate resume without provider call (-d) |
| `--json` | boolean | Output structured JSON result (-j) |

**Examples:**

```sh
agentctl resume <sessionId> --response "approved, continue"
agentctl resume <sessionId> --dry-run --json
```

## `agentctl test-gen`

**ID:** `test-gen` · **Category:** Create · **Risk:** MODERATE · **Mutates:** yes

Scaffold and run automated TDD Red-to-Green test cycle

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--title` | string | Feature title for the generated test (-t) |
| `--spec` | string | Requirement specification text (-s) |
| `--run` | boolean | Run the TDD Red check after scaffolding (-r) |
| `--dry-run` | boolean | Simulate scaffolding without writing (-d) |
| `--json` | boolean | Output structured JSON result (-j) |

**Examples:**

```sh
agentctl test-gen --title my-feature --spec "Handles EOF"
agentctl test-gen --title my-feature --run
agentctl test-gen --title my-feature --json
```

## `agentctl mcp`

**ID:** `mcp` · **Category:** Configure · **Risk:** LOW · **Mutates:** yes

Start stdio MCP server or scaffold IDE integration config (mcp init)

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--target` | string | IDE target for init (cursor | vscode | claude | all) (-t) |
| `--dry-run` | boolean | Report what would be written for init (-d) |
| `--json` | boolean | Output structured JSON init result (-j) |

**Examples:**

```sh
agentctl mcp
agentctl mcp init cursor
agentctl mcp init --target vscode --dry-run
```

## `agentctl hydrate`

**ID:** `hydrate` · **Category:** Inspect · **Risk:** LOW · **Mutates:** no

Prepend active system learnings and baton-pass state to a prompt

**Flags:** none.

**Examples:**

```sh
agentctl hydrate "Fix the flaky login test"
agentctl hydrate
```

## `agentctl learning`

**ID:** `learning` · **Category:** Operate · **Risk:** LOW · **Mutates:** yes

Record a system learning rule into .agent/knowledge/

**Flags:** none.

**Examples:**

```sh
agentctl learning add "flaky port bind" "retry with port 0"
```

## `agentctl rules`

**ID:** `rules` · **Category:** Inspect · **Risk:** LOW · **Mutates:** yes

Audit rule token budgets or compile rule sentinels (check | compile)

**Flags:**

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--max-chars` | string | Override max characters per file for check |
| `--max-lines` | string | Override max lines per file for check |
| `--out` | string | Write compiled rules to file for compile (-o) |
| `--json` | boolean | Output structured JSON result (-j) |

**Examples:**

```sh
agentctl rules check
agentctl rules check --json
agentctl rules compile --out .agent/rules.compiled.md
```
