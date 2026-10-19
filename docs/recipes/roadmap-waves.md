# Planning roadmap work as safe Jules waves

This is an **optional operating recipe**, not a new JOK command or an automated planner. It uses the existing task queue, task envelopes, independent gate, and GitHub review process. Do not interpret a provider-reported success or an opened PR as approval.

## When to use it

Use this for a roadmap containing multiple cross-layer tasks, especially when schema or API changes will affect downstream consumers. Skip it for one independently reviewable fix.

The planning agent may inspect the repository and propose task prompts. It must **not** edit application code, modify JOK policy, create Jules sessions, or merge PRs while planning.

## Planning artifacts (user-owned)

Keep the planning files outside `.agent/` so they cannot be confused with JOK's trusted configuration or runtime state:

- `plans/ACTIVE_INTENT.md`: the currently approved cycle, its baseline, risks, waves, and evidence.
- `plans/tasks/wave-N-<task>.md`: one ready-to-review task prompt per independently reviewable intent.

These are **advisory project documents**. A planning agent cannot grant itself access to protected files, bypass the configured gate, or change branch protection by writing them. Commit them only if you want the plan tracked with project history.

## How to divide the work

1. Inspect `ROADMAP.md` (or the project's equivalent), `AGENTS.md`, real paths, current APIs, schemas, and tests. Record a concrete base-branch commit SHA. If evidence is missing, mark it **unknown**; do not invent a file, contract, or test.
2. Make one task per reviewable outcome rather than one task per file. Prefer cohesive vertical slices with bounded change scope. File-count or line-count ceilings are only project-specific guidance, **not** universal correctness criteria.
3. Map both **file overlaps** and **shared contracts**: database schemas, event names, routes, payloads, types, configuration, and generated interfaces. Disjoint files alone do **not** make tasks independent.
4. For an evolving contract, place producer/schema/API changes in an earlier wave; place consumers in a later wave. Within a wave, parallelize only when there is no overlapping file scope **and** no unverified contract dependency.
5. Treat migrations, authentication, security policy, CI, protected paths, and production operations as higher-risk work. Obtain appropriate explicit approval; no autonomous production writes or merge.
6. Require a verifiable acceptance oracle and stop condition for every task. A passing agent-run test is evidence to inspect, not an independent gate result.

### Five inputs for each task prompt

Each `plans/tasks/*.md` should state:

- **Outcome and boundaries:** observable result, exact allowed paths, forbidden paths, and relevant invariants.
- **Architectural data flow:** producer or source of truth → interface/transport (route, event, schema, payload) → consumer; say “not applicable” for isolated changes.
- **Dependency decisions:** task IDs that must finish and merge first, including dependencies on shared contracts even where paths do not overlap.
- **Implementation choices:** known product behavior and available dependencies. Do not prescribe speculative packages or copy a project-specific architecture into unrelated codebases.
- **Verification:** targeted tests, project-wide checks when needed, evidence expected, and circumstances that require stopping.

Protect existing tests and acceptance configuration. If a task truly needs to change tests or policy, re-scope and obtain separate authorization before dispatch.

## Copyable planning prompt

Give this prompt and the project's roadmap to an interactive planning agent (for example, Antigravity). Review its output before running any command:

```text
You are planning a bounded development cycle for this repository.

Read the actual roadmap, repository instructions, current source paths,
existing API/schema/event contracts, and verification commands. Fetch the
current base branch and record its commit SHA. Do not guess missing details.
Do not modify application code, tests, gate configuration, protected paths,
or CI. Do not dispatch agents, approve plans, merge PRs, or run migrations.

Produce:
1. plans/ACTIVE_INTENT.md with:
   - requested cycle/outcomes and explicitly excluded work
   - inspected baseline SHA and unresolved assumptions
   - a compact task table: ID, outcome, allowed files, risk lane, wave,
     prerequisites, verification and stop condition
   - a dependency explanation covering BOTH file overlaps and shared
     schema/API/event contracts
   - an explicit review/merge gate between dependent waves
   - current status only from verifiable Git/Jules/CI evidence
2. plans/tasks/wave-N-<task>.md, one standalone Jules-ready prompt per task.
   For cross-layer work, identify source of truth, transport contract,
   consumer, and compatibility requirements. Give exact tests and expected
   evidence. Do not introduce arbitrary line ceilings.
3. A short list of uncertainties that block safe delegation.

Only propose tasks whose assumptions and acceptance criteria can be checked.
Do not declare two tasks independent because their file lists differ.
Plan future waves, but do not queue them before prerequisite merges.
An opened PR or Jules-completed session is not a passing independent gate.
Do not automatically approve, merge, or alter enforcement to unblock a task.
```

## Record the active intent

A minimal `plans/ACTIVE_INTENT.md` can be structured as:

```markdown
# Active intent: cycle <name>

Base: main @ <commit SHA>
Goal: <observable cycle outcome>
Out of scope: <explicit exclusions>
Unknowns: <unverified files, contracts, environments>

| Task | Wave | Allowed paths | Depends on | Contract | Risk | Oracle | Status |
|------|------|---------------|------------|----------|------|--------|--------|
| T1   | 1    | ...           | none       | ...      | ...  | ...    | proposed |
| T2   | 2    | ...           | T1 merged + gate | ... | ... | ... | blocked |

Wave 1 acceptance: PR(s) independently checked, reviewed and merged.
Wave 2 baseline: re-fetch main and update the SHA before dispatch.

Evidence: PR URL, head/base SHA, CI result and local gate result per task.
Stop: scope drift, unknown contract, missing oracle, protected-file change,
      failed verification or unresolved merge conflicts.
```

The task statuses are records of observed events, not inferred progress. Update the plan after each independent verification and merge; do not replace GitHub/Jules as sources of truth.

## Execute one wave at a time

The following commands are illustrative; replace the paths, title, verification command, and concurrency with values verified for the project.

```sh
# Review the first task without writing an envelope.
agentctl task create --non-interactive --title "Wave 1: backend contract" \
  --prompt-file plans/tasks/wave-1-backend.md \
  --verify-cmd "npm test" --dry-run

# Queue only wave 1. Do not queue dependent wave 2 yet.
agentctl task create --non-interactive --title "Wave 1: backend contract" \
  --prompt-file plans/tasks/wave-1-backend.md \
  --verify-cmd "npm test" --require-plan-approval --auto-pr

agentctl queue --dry-run
agentctl queue --dag --serialize dispatched --concurrency 1
```

JOK v0.76.1 supports three DAG dependency wait modes (PR #121):

| Mode | When a dependent task can start |
| --- | --- |
| `--serialize dispatched` (default) | After its prerequisite was dispatched successfully |
| `--serialize completed` | After the prerequisite provider session reaches terminal completion |
| `--serialize merged` | After the prerequisite provider session finishes and all discovered PRs are merged |

For an *explicitly linked* producer → consumer dependency, `--serialize merged` is the safer single-run option. For example, after reviewing the task plan and ensuring `dependsOn` references the actual upstream task ID:

```sh
agentctl queue --dag --serialize merged --serialize-timeout 240 --concurrency 2
```

`--serialize-timeout` is a per-task wait timeout in **minutes** (default 15); choose it deliberately if a human may need to review PRs before the next task is dispatched. A closed-unmerged PR, no discovered PR URL, a failed provider session, or timeout blocks dependent tasks; check the recorded evidence instead of blindly rerunning.

**Important:** `merged` checks provider/PR state; it does *not* run `agentctl gate`, grant merge approval, guarantee CI/branch protection, or prove that the next remote session uses a refreshed base commit. Configure independent CI/branch protection and require human review as appropriate. Re-fetch `main` and reassess base drift/contract compatibility before dependent work. Where that cannot be guaranteed, **keep sequential waves as separate, manually reviewed queue runs**.

Only parallelize independent tasks when neither file scopes nor shared contracts conflict.

Before releasing wave 2:

1. Inspect each PR's actual diff against its current base and validate forbidden paths, unexpected scratch files, schema/event consumers, and test changes.
2. Check the PR's independent CI results and run `agentctl gate` against the correct local candidate branch or snapshot. A local `gate` command does not fetch or check out a remote PR for you.
3. Obtain human approval and merge only when required checks pass. Never equate an agent's reported tests with independent verification.
4. Fetch the updated base branch, rerun the relevant full/integration tests (including cross-layer seams), and revise wave 2 prompts against the new SHA. Stop if contracts changed unexpectedly.
5. Only then create and dispatch the next wave's task envelopes.

If the base branch advances after task planning, re-evaluate affected paths and contracts before dispatch. JOK v0.76.1 includes opt-in base-drift preflight (PR #120), but a drift check is not a substitute for refreshing the planning baseline, verifying the actual new contract, or independently reviewing candidate code.

## Completion and handover

Record what actually merged, what was independently verified, the precise next task, and remaining risks. Use JOK's existing `agentctl handover` capability for session handovers when appropriate; `plans/ACTIVE_INTENT.md` tracks the **cycle plan**, not a second authoritative runtime state store.

When a task fails, send narrowly scoped feedback or request an explicit repair; cap attempts and stop on repeated failures. Do not let an agent rewrite tests, policy, or approval conditions to obtain a green result.
