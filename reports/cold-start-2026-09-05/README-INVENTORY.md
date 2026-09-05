# Phase 0 — README and CLI inventory

The installed v0.71.0 README was read in full; its bytes matched the supplied checkout. The exact document is preserved in the evidence archive. This inventory separates **promises** from **verified behavior**. A help invocation is not proof that the corresponding live provider operation works.

## Every command in the README CLI reference, literally

The following table is copied from that README, not terminal output and not an endorsement of its promises. The descriptions and exit-code claims are part of what was inventoried.

| Command | Usage | Description | Exit Codes |
| :--- | :--- | :--- | :--- |
| `init` | `agentctl init [--interactive] [--tier pro] [--provider <name>] [--profile <name>] [--force]` | Interactive onboarding wizard & stack detector. Generates `.agent/config.yml` and scaffolds `AGENTS.md`, the role prompts, the guardrails and the runtime `.gitignore` entries. Existing files are preserved unless `--force`. | `0` (Created) |
| `budget` | `agentctl budget [--by-user] [--json] [reset]` | Reports rolling 24h task budget, quota headroom, and per-developer task attribution without external auth servers. | `0` (Status), `2` (Arg Error) |
| `task create` | `agentctl task create [<prompt>] [--title <t>] [-p <prompt>] [-f <file>] [--template <id>] [--role <name>] [--tier fast\|complex]` | Interactively authors & scopes falsifiable task envelopes with secret scrubbing, preflight gate checks, and DAG dependency wiring. | `0` (Queued), `1` (Secret/Unfalsifiable) |
| `task template` | `agentctl task template [<id>] [--list] [--json]` | Lists and synthesizes pre-calibrated task envelopes (Web, Deep Think, Universal & Agent Hardening: `web-cwv`, `web-wcag`, `web-seo`, `web-playwright`, `agent-dead-code-audit`, `web-flaky-heal`, `web-i18n`, `web-ai-access`, `agent-qa-mutation`, `agent-ci-falsify`, `agent-service-isolate`, `agent-error-paths`, `agent-security-audit`, `agent-dep-audit`, `agent-doc-drift`, `agent-config-audit`, `agent-api-contract`, `deep-debug`, `deep-feature`, `deep-optimize`, `deep-harden`). | `0` (Listed/Synthesized) |
| `dispatch` | `agentctl dispatch [<prompt>] [-p <prompt>] [-f <file>] [-r <role>] [-t <tier>] [--author <name>] [--check-premise] [--auto-pr] [--repoless] [--dry-run]` | Dispatches autonomous task to the active provider with pre-flight idempotency checks, payload limits, and role prompt resolution. `--dry-run` stops short of the provider call and reports itself as a rehearsal rather than a dispatch. | `0` (Dispatched), `1` (Error) |
| `plan approve` | `agentctl plan approve <sessionId> [--dry-run] [--json]` | Approves pending execution plan for an active Jules session (`:approvePlan`) with automatic 404/503 retry backoff. | `0` (Approved), `1` (Error) |
| `session get` | `agentctl session get <sessionId> [--dry-run] [--json]` | Retrieves live session lifecycle state from provider REST API with token rotation. | `0` (Fetched), `1` (Error) |
| `patch` | `agentctl patch <sessionId> [--apply] [--save <path>] [--json]` | Extracts raw git diff patch from a completed Jules session and tests or applies it locally with `git apply --check` safety. | `0` (Clean/Applied), `1` (Conflict/Error) |
| `retry` | `agentctl retry <sessionId> [--role <role>] [--with-failure] [--json]` | Fetches error traces and activity logs from a failed session and synthesizes a targeted OODA retry dispatch. | `0` (Dispatched), `1` (Error) |
| `prune` | `agentctl prune [--age 7d] [--state <state>] [--delete] [--yes] [--json]` | Queries and batch-archives or deletes stale/completed sessions via Jules v1alpha API to keep workspaces clean. | `0` (Cleaned) |
| `pr harvest` | `agentctl pr harvest [--tier r0,r1] [--limit <n>] [--auto] [--allow-no-checks] [--dry-run]` | Discovers open agent PRs, evaluates CI checks & risk tiers, and auto-squashes green low-risk changes autonomously. A PR reporting **no** CI checks is skipped unless `--allow-no-checks` is passed, and an unavailable changed-file list blocks rather than classifying as low risk. | `0` (Triaged/Merged), `1` (Error) |
| `providers` | `agentctl providers [--json]` | Probes every built-in provider and reports which ones this machine can dispatch to, what each one is missing, and which is active. For a CLI provider, "ready" means the binary is on `PATH` — it does not prove the CLI is signed in. | `0` (Active provider ready), `1` (Not ready) |
| `provider set` | `agentctl provider set <name>` | Switches the active provider in `.agent/config.yml` in place, preserving comments. | `0` (Set), `1` (No manifest), `2` (Name missing) |
| `profile` | `agentctl profile [--list] [--set minimal\|standard\|max] [--json]` | Shows the verification stages the configured profile expands to on this stack, or writes a new profile into `.agent/config.yml` without disturbing comments. | `0` (Shown/Set), `2` (Unknown profile) |
| `ci init` | `agentctl ci init [--target github\|gitlab] [--force] [--dry-run] [--json]` | Generates a stack-aware CI gate workflow (`.github/workflows/agent-gate.yml` or `.gitlab-ci.agent-gate.yml`) that runs `agentctl check --mode committed`. Refuses to overwrite without `--force`. | `0` (Written/Skipped), `1` (Write error), `2` (Unknown target) |
| `doctor` | `agentctl doctor [--probe] [--json]` | Diagnostic check runner. `--probe` additionally starts the configured provider's CLI to confirm it answers, rather than only finding it on `PATH`. | `0` (Healthy), `1` (Failures) |
| `queue` | `agentctl queue [--dag] [--concurrency <n>] [--dry-run] [--json]` | Consumes and executes task envelopes in `.agent/jules-queue/` with Kahn's DAG dependency resolution. Non-task files (manifests, `README.md`) are skipped, and `--dry-run` previews without moving anything. | `0` (Complete) |
| `swarm` | `agentctl swarm [--json]` | Runs parallel multi-agent swarm across worker slots with PID liveness detection. | `0` (Complete) |
| `check` / `gate` / `audit`| `agentctl check [--mode working-tree] [--fix] [--allow-protected] [--allow-test-change <kind>] [--json] [--json-report <path>]` | Runs security, secret scanning, rules budget audit, and tiered verification gates (with declarative assertion support) against working tree or branch. | `0` (Approved), `1` (Budget/Arg), `3` (Scope), `4` (Verify), `5` (Diff >75K), `6` (Secret **or** test integrity), `8` (Flaky) |
| `mutate` / `mutation` | `agentctl mutate [--min-score <n>] [--max-mutants <n>] [--cmd <testCmd>] [--json]` | Runs zero-dependency diff mutation testing harness on changed hunks with operator inversion and safety rollback. | `0` (Passed), `1` (Score Low) |
| `coverage` | `agentctl coverage [--min <pct>] [--cmd <testCmd>] [--base <ref>] [--json]` | Runs native zero-dependency V8 diff coverage check against added diff lines. | `0` (Passed), `1` (Low Coverage) |
| `probe` / `stability` | `agentctl probe [--repeat <n>] [--min <passRate>] [--cmd <testCmd>] [--json]` | Probes test suite flakiness across N consecutive iterations with oscillation detection. | `0` (Passed), `1` (Flaky) |
| `perf` / `event-loop` | `agentctl perf [--max-ms <n>] [--cmd <testCmd>] [--json]` | Monitors Node.js Event Loop delay and Big-O lag to prevent main-thread event loop starvation. | `0` (Healthy), `1` (Lag Exceeded) |
| `fix` | `agentctl fix [--file <path>] [--task] [--dry-run] [--json]` | Auto-repairs failure traces from piped stdin (`npm test 2>&1 \| agentctl fix`) or synthesizes OODA queue tasks. | `0` (Resolved), `1` (Failed) |
| `rules` | `agentctl rules <check\|compile> [--out <path>] [--json]` | Audits instruction files against character/line budgets or compiles unified rules block with SHA-256 and length anti-truncation sentinels. | `0` (Valid/Compiled), `1` (Violations) |
| `assert` | `agentctl assert [--dir <d>] [--file <f>] [--max-mb <n>] [--gzip] [--targets <g>] [--patterns <p>] [--json] [--json-report <p>]` | Runs declarative zero-dependency verification assertion primitives (`assert:dir-size`, `assert:file-size`, `assert:file-patterns`, `assert:exists`, `assert:mutation`, `assert:test-integrity`, `assert:diff-coverage`, `assert:test-stability`, `assert:event-loop-lag`). | `0` (Passed), `1` (Assertion Failed) |
| `rollback` | `agentctl rollback [sessionId \| --latest]` | Restores exact commit, uncommitted files, and cleans orphan task worktrees from pre-flight checkpoints. | `0` (Restored), `1` (Error) |
| `resume` | `agentctl resume <sessionId> --response "<reply>"` | Streams engineer response back into active Google Jules warm session context window. | `0` (Resumed), `1` (Error) |
| `test-gen` | `agentctl test-gen --title <t> --spec <s> [--run]` | Scaffolds falsifiable unit tests, verifies RED failure state, and locks test in `scope.deny`. | `0` (Scaffolded/Red) |
| `dashboard` | `agentctl dashboard [port]` | Starts zero-dependency local HTTP telemetry and audit visualizer dashboard. | `0` (Running) |
| `evidence` | `agentctl evidence <generate\|verify\|show>` | Generates, verifies, or prints SHA-256 evidence manifests (unkeyed digests: tamper-evident, not signed) with test-tamper locking. | `0` (Verified), `1` (Tamper) |
| `flaky` | `agentctl flaky <status\|heal\|reset>` | Manages Wilson-quarantined tests (Exit Code 8) and dispatches automated anti-flakiness healing swarms. | `0` (Healed/Listed) |
| `mcp` | `agentctl mcp` | Starts stdio Model Context Protocol (MCP) server for Claude, Cursor, and Antigravity. | `0` / Stdio stream |
| `mcp init` | `agentctl mcp init [--target cursor\|vscode\|claude\|all]` | 1-click config scaffolding for Cursor (`.cursor/mcp.json`), VS Code tasks (`tasks.json`), and Claude Desktop. | `0` (Scaffolded) |


## Core behavior claims, literally

## Core Capabilities

* **Provider-Agnostic:** Dispatches to Google Jules (hosted REST), the Claude Code CLI, the OpenAI Codex CLI or the Gemini CLI. `agentctl providers` probes each one — a credential for the hosted provider, a binary on `PATH` for the local ones — and every verification gate works with no provider configured at all.
* **Vendor-Neutral Configuration:** Every `JULES_*` environment variable also answers to an `AGENT_*` spelling (`AGENT_API_KEY`, `AGENT_REPO`, `AGENT_SWARM_CONCURRENCY`). The legacy name always wins where both are set, so adding an alias cannot change a working setup.
* **One-Word Verification Depth:** `verify.profile: minimal | standard | max` expands at load time into a stack-aware pipeline — `max` adds mutation scoring, flakiness probing and, where the runtime emits it, V8 diff coverage. A Cargo repository is never asked for `NODE_V8_COVERAGE`.
* **Generated, Not Copied, CI:** `agentctl ci init` writes a GitHub Actions or GitLab job carrying the toolchain the detected stack needs (`setup-python`, `setup-go`, `setup-java`, …) plus Node for the CLI itself.
* **Zero Runtime Dependencies:** Built exclusively on Node.js 20+ built-in modules (`node:fs`, `node:child_process`, `node:crypto`, `node:path`, `node:http`, `node:tty`, `node:test`).
* **Cross-Platform Parity:** Verified 100% green across Linux, macOS (Darwin), and Windows on Node 20, 22, and 24.
* **Autonomous Self-Healing Loop:** Captures test stderr/stdout, fingerprints error traces, and feeds structured context back into automated repair turns (up to 3 attempts) before human escalation.
* **Fail-Closed Verification:** A change that ran no verification command at all is rejected, not approved — "nothing to run" is not a pass. Repositories using only the scope and secret phases opt out explicitly with `verify.required: false`.
* **Anti-Tamper That Reads Semantics:** Counting assertions cannot see a value check swapped for a truthiness check. The guard tracks assertions that name an expected value, so weakening a test is a violation even when the line count is unchanged.
* **Binary-Aware Scanning:** Files git renders as `Binary files ... differ` are read directly for structured credentials, and their real size is charged against the diff ceiling, so a leading NUL byte cannot hide a token and a committed blob cannot walk past the payload governor.
* **Fail-Closed Security & Secret Redaction:** Evaluates explicit Deny rules before Allow rules against canonicalized, case-folded paths. Redacts high-entropy keys and base64-encoded credentials (such as Kubernetes `Secret` manifests).
* **Complexity & Cost Router:** Zero-dependency heuristic classifier (`src/router.mjs`) routing mechanical tasks to lightweight models while reserving primary models for complex refactors, with a `node --check` syntax-verification gate that transparently escalates a FAST-tier result to the primary provider if it left broken JS on disk.
* **Terminal UI & Diagnostic Matrix (`agentctl doctor`):** Interactive terminal dashboard, task sidecar manager, and automated transactional self-repair.
* **Verified Test Suite:** Tested with **1299 unit tests across 174 suites**, green on every supported platform.

<br/>

---

<br/>



## Additional first-hour promises and cross-references

| Claim | Observed coverage / limitation |
|---|---|
| Three-command quickstart works in any repository; init asks seven questions; --yes detects and probes before writing | All three commands were run in two PTYs and two non-TTY directories. The random no-suite repository stopped at an honest task refusal. The real seven-question init completed. |
| Existing files are preserved unless --force | Repeated init produced identical file hashes across all four ecosystems. Force-overwrite was not used to fabricate a clean outcome. |
| -p skips to review; no-argument agentctl gives one state-sensitive next step | -p queued immediately in both terminal modes, without a review prompt. No-argument agentctl gave a useful missing-key next step. |
| init chooses a reachable provider and generates CI for the host toolchain | With none reachable it said so and selected unavailable Jules. Plain init did not create a CI workflow; the separate ci init command did. No unsupported claim that credentials existed was made. |
| Affected monorepo suites, widening to root for shared files | Monorepo native verification was blocked by crates.io; no runtime assurance claimed. |
| 24+/26+ detected stacks; minimal/standard/max stack-aware pipelines | Four runnable ecosystems; default Rust falsely rejected. Max Go stated why V8 coverage was skipped. Node max mutation caught an untested arithmetic file. Other stacks not tested. |
| Every local gate needs no API key, provider CLI, or network | check, rules, doctor, evidence, coverage and mutation ran locally. A configured host suite still needs its dependencies. Probe/stability was exercised through max on Go; every standalone variant and perf were not characterized. |
| Only 100% clean tests yield PR approval; isolated sandbox; scoped verification; strict payload/security | False approvals and wrong-snapshot proofs refute the trust implication. No live PR gate, OS sandbox boundary, secret-redaction corpus, or payload stress corpus was tested. |
| free/pro/ultra quotas, worker concurrency, 75 KB diff and 50 KB prompt ceilings | Free init reported 3 workers/15 daily tasks. Full quotas/concurrency not exercised; no paid sessions used. The gate default and README contain different tier-specific numbers; no release claim is made solely from that comparison. |
| Automatic repair up to three attempts, rollback, quarantine, locks, DAG, warm sessions | Queue rehearsal and no-key failures tested. Live repair, actual rollback of provider work, high-contention locks and quarantine transitions not verified. |
| Binary-aware and base64 secret detection; deny-first scope; symlinks/canonical paths | Protected config and ordinary deny-vs-protect behavior tested. Broad secret, symlink, binary and cross-platform path promises inventoried only. |
| Evidence is SHA-256 tamper-evident, explicitly not signed | Generation/show/verify worked. A digest is not proof the correct source was exercised; no signed provenance claim is attributed to the README. |
| SDK failover, complexity router, syntax-verified FAST fallback | All three SDK examples read. No provider credentials/CLI, so live behavior unverified. |
| Test-gen creates RED tests and locks them; prompt optimizer and task envelopes are falsifiable | Task creation enforced presence of an oracle, generated real queue files, and refused the no-oracle random repo. Real TDD generation/provider execution unverified. |
| Cross-platform parity and 1299 tests/174 suites | Not independently verified. This trial intentionally did not run the kit’s own gate/test suite as evidence about strangers’ repositories. |

## Inline command mentions, including commands outside the CLI table

- `agentctl`
- `agentctl <command>`
- `agentctl assert [--dir <d>] [--file <f>] [--max-mb <n>] [--gzip] [--targets <g>] [--patterns <p>] [--json] [--json-report <p>]`
- `agentctl budget [--by-user] [--json] [reset]`
- `agentctl check`
- `agentctl check --json`
- `agentctl check --mode committed`
- `agentctl check [--mode working-tree] [--fix] [--allow-protected] [--allow-test-change <kind>] [--json] [--json-report <path>]`
- `agentctl ci init`
- `agentctl ci init [--target github\|gitlab]`
- `agentctl ci init [--target github\|gitlab] [--force] [--dry-run] [--json]`
- `agentctl coverage [--min <pct>] [--cmd <testCmd>] [--base <ref>] [--json]`
- `agentctl dashboard`
- `agentctl dashboard [port]`
- `agentctl dispatch [<prompt>] [-p <prompt>] [-f <file>] [-r <role>] [-t <tier>] [--author <name>] [--check-premise] [--auto-pr] [--repoless] [--dry-run]`
- `agentctl doctor`
- `agentctl doctor [--probe] [--json]`
- `agentctl evidence <generate\|verify\|show>`
- `agentctl fix [--file <path>] [--task] [--dry-run] [--json]`
- `agentctl flaky <status\|heal\|reset>`
- `agentctl gate`
- `agentctl init`
- `agentctl init --provider <name>`
- `agentctl init [--interactive] [--tier pro] [--provider <name>] [--profile <name>] [--force]`
- `agentctl lock`
- `agentctl mcp`
- `agentctl mcp init [--target cursor\|vscode\|claude\|all]`
- `agentctl mutate [--min-score <n>] [--max-mutants <n>] [--cmd <testCmd>] [--json]`
- `agentctl patch <sessionId> [--apply] [--save <path>] [--json]`
- `agentctl perf [--max-ms <n>] [--cmd <testCmd>] [--json]`
- `agentctl plan approve <sessionId> [--dry-run] [--json]`
- `agentctl pr harvest [--tier r0,r1] [--limit <n>] [--auto] [--allow-no-checks] [--dry-run]`
- `agentctl probe [--repeat <n>] [--min <passRate>] [--cmd <testCmd>] [--json]`
- `agentctl profile`
- `agentctl profile --set max`
- `agentctl profile [--list] [--set minimal\|standard\|max] [--json]`
- `agentctl provider set <name>`
- `agentctl providers`
- `agentctl providers [--json]`
- `agentctl prune [--age 7d] [--state <state>] [--delete] [--yes] [--json]`
- `agentctl queue`
- `agentctl queue [--dag] [--concurrency <n>] [--dry-run] [--json]`
- `agentctl resume <sessionId> --response "<reply>"`
- `agentctl retry <sessionId> [--role <role>] [--with-failure] [--json]`
- `agentctl review-repair`
- `agentctl rollback`
- `agentctl rollback [sessionId \| --latest]`
- `agentctl rules <check\|compile> [--out <path>] [--json]`
- `agentctl session get <sessionId> [--dry-run] [--json]`
- `agentctl swarm`
- `agentctl swarm [--json]`
- `agentctl task create`
- `agentctl task create [<prompt>] [--title <t>] [-p <prompt>] [-f <file>] [--template <id>] [--role <name>] [--tier fast\|complex]`
- `agentctl task optimize`
- `agentctl task template [<id>] [--list] [--json]`
- `agentctl test-gen`
- `agentctl test-gen --title <t> --spec <s> [--run]`
- `bin/agentctl.mjs`
- `cargo test`
- `dotnet test`
- `go test`
- `npm test`
- `npm test 2>&1 \| agentctl fix`
- `npx jules-orchestrator-kit <command>`
- `pytest`

## Help coverage

**76** invocations completed with exit 0. **41** were byte-identical to the top-level help rather than command-specific help. The complete command, exit, duration, byte length and SHA-256 are in `help-inventory.json` in the raw archive.

| Help invocation | Exit | Result |
|---|---:|---|
| `agentctl dispatch --help` | 0 | Specific output / version |
| `agentctl create --help` | 0 | Specific output / version |
| `agentctl check --help` | 0 | Specific output / version |
| `agentctl gate --help` | 0 | Specific output / version |
| `agentctl audit --help` | 0 | Specific output / version |
| `agentctl mutate --help` | 0 | Specific output / version |
| `agentctl mutation --help` | 0 | Specific output / version |
| `agentctl coverage --help` | 0 | Specific output / version |
| `agentctl probe --help` | 0 | Specific output / version |
| `agentctl stability --help` | 0 | Specific output / version |
| `agentctl perf --help` | 0 | Specific output / version |
| `agentctl event-loop --help` | 0 | Specific output / version |
| `agentctl fix --help` | 0 | Global help again |
| `agentctl queue --help` | 0 | Specific output / version |
| `agentctl swarm --help` | 0 | Specific output / version |
| `agentctl mcp --help` | 0 | Global help again |
| `agentctl clean --help` | 0 | Global help again |
| `agentctl doctor --help` | 0 | Specific output / version |
| `agentctl providers --help` | 0 | Global help again |
| `agentctl profile --help` | 0 | Global help again |
| `agentctl bootstrap --help` | 0 | Specific output / version |
| `agentctl review-repair --help` | 0 | Global help again |
| `agentctl dashboard --help` | 0 | Specific output / version |
| `agentctl init --help` | 0 | Specific output / version |
| `agentctl test-gen --help` | 0 | Global help again |
| `agentctl rollback --help` | 0 | Global help again |
| `agentctl resume --help` | 0 | Global help again |
| `agentctl patch --help` | 0 | Global help again |
| `agentctl retry --help` | 0 | Global help again |
| `agentctl prune --help` | 0 | Global help again |
| `agentctl escalate --help` | 0 | Specific output / version |
| `agentctl flaky --help` | 0 | Specific output / version |
| `agentctl status --help` | 0 | Specific output / version |
| `agentctl budget --help` | 0 | Specific output / version |
| `agentctl scan --help` | 0 | Global help again |
| `agentctl hydrate --help` | 0 | Global help again |
| `agentctl harvest --help` | 0 | Global help again |
| `agentctl assert --help` | 0 | Specific output / version |
| `agentctl version --help` | 0 | Specific output / version |
| `agentctl task --help` | 0 | Global help again |
| `agentctl rules --help` | 0 | Global help again |
| `agentctl lock --help` | 0 | Global help again |
| `agentctl provider --help` | 0 | Global help again |
| `agentctl ci --help` | 0 | Global help again |
| `agentctl handover --help` | 0 | Specific output / version |
| `agentctl plan --help` | 0 | Global help again |
| `agentctl session --help` | 0 | Global help again |
| `agentctl pr --help` | 0 | Global help again |
| `agentctl learning --help` | 0 | Global help again |
| `agentctl evidence --help` | 0 | Global help again |
| `agentctl task create --help` | 0 | Specific output / version |
| `agentctl task optimize --help` | 0 | Specific output / version |
| `agentctl task template --help` | 0 | Global help again |
| `agentctl provider set --help` | 0 | Global help again |
| `agentctl ci init --help` | 0 | Global help again |
| `agentctl plan approve --help` | 0 | Global help again |
| `agentctl session get --help` | 0 | Global help again |
| `agentctl pr harvest --help` | 0 | Global help again |
| `agentctl mcp init --help` | 0 | Global help again |
| `agentctl budget reset --help` | 0 | Specific output / version |
| `agentctl learning add --help` | 0 | Global help again |
| `agentctl rules check --help` | 0 | Global help again |
| `agentctl rules compile --help` | 0 | Global help again |
| `agentctl lock acquire --help` | 0 | Global help again |
| `agentctl lock release --help` | 0 | Global help again |
| `agentctl lock status --help` | 0 | Global help again |
| `agentctl handover list --help` | 0 | Specific output / version |
| `agentctl handover show --help` | 0 | Specific output / version |
| `agentctl handover create --help` | 0 | Specific output / version |
| `agentctl handover prune --help` | 0 | Specific output / version |
| `agentctl flaky status --help` | 0 | Specific output / version |
| `agentctl flaky heal --help` | 0 | Specific output / version |
| `agentctl flaky reset --help` | 0 | Specific output / version |
| `agentctl evidence generate --help` | 0 | Global help again |
| `agentctl evidence verify --help` | 0 | Global help again |
| `agentctl evidence show --help` | 0 | Global help again |

## Documented/present discrepancies and things requiring a guess

- No advertised top-level command was proven missing. `check --strict-locks` was advertised by help but rejected; F17 has the actual run.
- `clean`, `bootstrap`, `handover`, `status`, `scan`, `harvest`, and several operational helpers are in global help but not the README’s primary command table. Some others (lock, learning, hydrate, escalate, review-repair, task optimize) are mentioned outside that table rather than fully documented there.
- `create` is listed beside dispatch in global help, while `create --help` returns task-authoring help. This mismatch was inventoried, not used to claim that a remote task dispatched.
- Gate help omits accepted `--base`, `--allow-test-change`, `--allow-test-modifications`, `--allow-unreadable-tests`, and `--json-report`. Parser inspection was needed to enumerate the actual trust controls. Init help omits provider/profile selection despite README examples.
- `init --yes` selected no test command for the no-suite random repository, while accepting the interactive init defaults chose `npm test`, tried it, reported failure, and retained it. That difference was recorded twice; neither path demonstrated a healthy suite that the tool failed to detect.
- Removal was not explained in the README or checked docs. A bare revert does not remove ignored runtime state. See FILES-AND-UNDO.md.
