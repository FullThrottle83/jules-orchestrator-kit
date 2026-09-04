# Using Google Jules To The Fullest — Quality Plan

Audited against `54f0688` (branch `main`). Every finding below names the file and
line it was read from, and the ones marked **[reproduced]** were produced by
running the real code path against a response shaped exactly like the
documented Jules `v1alpha` API
(<https://jules.google/docs/api/reference/types>).

Baseline measured on this commit: `npm test` → **1222 tests, 172 suites, 0
fail, 127 s**, which matches the count `README.md:211` advertises. The
verification kernel is in good shape. The gaps are almost all in the *Jules
session* half of the system — the part that talks to the API and decides what
to do with what comes back.

---

## Summary

| # | Finding | Severity | Effort | Status |
| :-- | :-- | :-- | :-- | :-- |
| 1 | The OODA retry re-dispatches blind — real diagnostics are dropped | **P0** | S | **Fixed** |
| 2 | `pollSessionState` reports unfinished sessions as `COMPLETED` | **P0** | S | **Fixed** |
| 3 | `pollSessionState` has zero test coverage | **P0** | S | **Fixed** |
| 4 | `:sendMessage` is implemented but never called — no mid-session steering | P1 | M | Open |
| 5 | `AWAITING_USER_FEEDBACK` sessions die silently | P1 | M | Open |
| 6 | The generated plan is never inspected before it is approved | P1 | M | Open |
| 7 | Risk tier does not influence dispatch policy | P1 | S | Open |
| 8 | Activity stream is read one page deep | P1 | S | Open |
| 9 | `archiveSession` targets an endpoint the API does not document | P1 | S | Open |
| 10 | No session-outcome telemetry — merge rate is unmeasurable | P2 | M | Open |
| 11 | `v1alpha` is hardcoded in three files | P2 | S | Open |
| 12 | Test scratch directories are committed to the repository | P2 | S | Open |

---

## P0 — Fix before dispatching anything consequential

### 1. The retry loop throws away the failure it exists to fix

`retrySession()` (`src/session-ops.mjs:233-241`) collects diagnostics from
`act.error`, `act.executionOutput`, `act.exitCode` and `act.status`. None of
those four fields exist in the documented `Activity` type. What the API
actually returns is `artifacts[].bashOutput.{command,output,exitCode}`,
`sessionFailed.reason` and `agentMessaged.agentMessage`.

**[reproduced]** Fed an activity carrying
`bashOutput: { command: "npm test", output: "not ok 1 - invoice totals must
round to cents … AssertionError: expected 10.01 to equal 10.00", exitCode: 1 }`
on a `state: "FAILED"` session, `retrySession()` returned:

```
failureReason extracted: "Previous session did not complete cleanly."
diagnostics carried into retry: NO — the real error was dropped
```

So the new session is dispatched with `[PREVIOUS_ATTEMPT_FAILURE_DIAGNOSTIC]`
containing a sentence instead of the assertion, the file and the line. This is
the loop `AGENTS.md` §2 rule 5 exists to prevent.

**Change (shipped).** `extractFailureDiagnostics(activities)` in
`src/session-ops.mjs`, returning `{ source, text }` blocks in this order — the
order matters, because `retrySession` truncates the joined result to 4000
characters from the front, so it decides which evidence survives the cut:

1. `artifacts[].bashOutput` where `exitCode !== 0`, rendered as
   `` `$ ${command}\n${output}\n(exit code N)` ``.
2. `sessionFailed.reason`.
3. `artifacts[].bashOutput` whose `exitCode` is `0` or absent but whose output
   still reads as a failure (`not ok`, `# fail N`, `N failed`, `N failing`,
   `AssertionError`, `FAILED`, a Python traceback, a Go panic, `error:`).
4. The legacy spellings, kept because they cost nothing and cover provider
   shapes that have not been observed.
5. `description` of activities whose `originator` is `"agent"`.
6. Only then the previous fallback sentence.

Repeated blocks are deduplicated, and redaction stays where it was — at the
point `retrySession` builds the prompt.

`retrySession` now also returns `diagnosticsFound` and `diagnosticSources`,
because `failureReason` alone cannot tell a real trace from the fallback
sentence: both are non-empty strings. `agentctl retry` prints the difference,
and says so out loud when the retry is going out with nothing but the generic
line.

**Acceptance (met).** `test/session-ops.test.mjs` asserts that a
documented-shape failed session yields a `failureReason` containing the
assertion message, the file and line, and the exit code; that a green run
produces no diagnostics at all — a collector that flags everything buries the
one that failed; and that the fallback sentence is returned only when the
session genuinely carried nothing readable.

### 2. `pollSessionState` fails open

`src/engine.mjs:1005-1061`. The only terminal states it recognises are
`COMPLETED` and `FAILED` (line 1051); everything else falls out of the loop
into:

```js
return { ...session, status: String(session.status || "COMPLETED").toUpperCase() };
```

`session.status` is never set on a fresh dispatch (`dispatch` returns `id`,
`state`, `url`), so the default resolves to `COMPLETED`.

**[reproduced]**

| Provider returns | Reported status |
| :-- | :-- |
| `AWAITING_USER_FEEDBACK` (5 polls) | `COMPLETED` |
| `IN_PROGRESS` until the attempt budget is spent | `COMPLETED` |

Four of the nine documented `SessionState` values — `PLANNING`,
`AWAITING_USER_FEEDBACK`, `PAUSED`, `QUEUED` — are indistinguishable from
success. The OODA loop at `src/engine.mjs:902` then runs the gate against a
tree the agent never finished writing.

**Change (shipped).** `src/engine.mjs` now exports `TERMINAL_SESSION_STATES`
and `BLOCKING_SESSION_STATES`, and the verdict says which of three things
happened:

- `COMPLETED` / `FAILED` → `terminal: true`.
- `AWAITING_PLAN_APPROVAL` / `AWAITING_USER_FEEDBACK` / `PAUSED` →
  `terminal: false, blockedOn: <state>`, returned on the first poll. Polling a
  state that needs an actor is not waiting, it is spending the budget.
- Anything else, when the budget runs out → the **last observed** state with
  `timedOut: true`, or `UNKNOWN` if the provider never answered. A provider
  that stops answering mid-flight returns `unreachable: true` rather than
  looping to a timeout that describes the wrong thing.

`AWAITING_PLAN_APPROVAL` is still the one blocking state the loop may resolve
itself, and only when the caller asked for it — and a refused
`approvePlan` now surfaces as `approvePlanError` instead of being swallowed.

Nothing synthesises `COMPLETED` any more. The one place that returns it is the
dry-run path, which is a simulation and is now flagged `simulated: true`.

The caller at `src/engine.mjs` (the OODA repair loop) consumes the verdict: a
non-terminal session prints `[SESSION_NOT_TERMINAL] …` naming what it is
waiting on, and appends a `session_not_terminal` telemetry event, because the
re-verification gate is about to judge a tree the agent may not have finished
writing. The gate still runs either way — it is the authority on whether the
change works — but it no longer runs silently on a half-applied patch.

**Acceptance (met).** `pollSessionState` returns `AWAITING_USER_FEEDBACK` for a
session that asks a question and spends exactly one poll doing it, and
`IN_PROGRESS` + `timedOut: true` for one that never terminates.

### 3. The most decision-bearing function in the kit is untested

`grep -rn "pollSession" test/` returns nothing. `pollSessionState` decides
whether a session is believed to have finished — the assumption every later
gate builds on — and it is the one function with no contract. Given the
repository's own standard ("a guard that cannot be made red is switched off"),
this is the same class of hole `scripts/guard-reach-check.mjs` was written to
close.

**Acceptance (met).** `test/session-poll.test.mjs` — 22 cases: all nine
`SessionState` values, a loop asserting every non-terminal one is
distinguishable from success, the timeout path, the wall-clock budget, the
`approvePlan` side effect (granted, refused, and requested from the session
object), the unreachable paths for a provider that returns `null` and one that
throws, the `pollFn` fallback, the dry-run short-circuit, and the no-session
case.

---

## P1 — Close the loop with the running session

### 4. `:sendMessage` exists and nothing calls it

`src/provider.mjs:578` builds the `:sendMessage` URL and `dispatch`-adjacent
code is wired for it. `grep -rn "\.sendMessage(" src/ scripts/ bin/` returns
**zero** call sites. Today the only repair move available is a whole new
session (`retrySession`, `src/session-ops.mjs:210`), which costs a full
dispatch, re-clones the repository and discards everything the agent had
already worked out.

**Change.** Two entry points:

- `agentctl session message <id> "<text>"` — an operator answering a question.
- An engine hook: when `pollSessionState` reports `AWAITING_USER_FEEDBACK`,
  look up the question in a bounded answer table from the task envelope
  (`clarifications:` block, pre-approved by the author) and reply in-session.
  Budget it — e.g. `maxClarifications: 3` — and escalate to a human past that.

This is the single largest quota and latency win available: a steered session
keeps its context, a re-dispatched one does not.

### 5. `AWAITING_USER_FEEDBACK` should never be silent

`src/webhook.mjs:19` documents that this state is *deliberately* not
auto-answered. Keeping it un-answered is right; letting it expire unnoticed is
not. Today a session that stops to ask a question is reported `COMPLETED`
(finding 2) and the queue moves on.

**Change.** Treat it as an incident with the existing escalation machinery
(`agentctl escalate`), including the last `agentMessaged.agentMessage` so the
operator sees the actual question rather than a state name.

**Then harvest the questions.** Every `agentMessaged` that put a session into
this state is a question the envelope should have pre-answered. Feed them into
`agentctl learning add` automatically. After a few weeks this is the
highest-signal input to prompt quality that exists, and it costs one query.

### 6. Inspect the plan before approving it

`requirePlanApproval` is plumbed end to end (`src/wizard-task.mjs:309`,
`src/provider.mjs:384`) and `src/engine.mjs:1044` auto-approves when asked.
The plan itself — `activities[].planGenerated.plan.steps[].{title,description}`
— is never read by anything in the repository.

That is the cheapest high-value gate in the whole system: the plan states the
agent's intent **before** a single byte is written, which is exactly when a
scope violation is free to reject and expensive to fix.

**Change.** A `lintPlan(plan, { protectedPaths, envelopeScope })` step between
plan generation and `:approvePlan`:

- Reject when a step names a path in `.agent/protected-paths.json` or
  `.agent/jules.yml` `forbidden_paths`.
- Warn when steps reference files outside the envelope's declared scope.
- Record the verdict in the evidence manifest alongside the test results.

### 7. Let the risk tier drive dispatch policy

`classifyRiskTier()` (`src/risk.mjs:147`) is called from
`src/execution-envelope.mjs:106` and `scripts/risk-tier.mjs`. It is **not**
consulted at dispatch time. Meanwhile `src/wizard-task.mjs:308-309` defaults to
`autoPr: true` and `requirePlanApproval: false` for every task, whatever its
risk.

**Change.** Defaults, overridable per task:

| Tier | `requirePlanApproval` | `automationMode` |
| :-- | :-- | :-- |
| low | `false` | `AUTO_CREATE_PR` |
| medium | `true` | `AUTO_CREATE_PR` |
| high / consequential | `true` | unspecified (no auto-PR) |

### 8. Read the whole activity stream

`listActivities` (`src/provider.mjs:951-968`) accepts and returns
`nextPageToken`, and `pageSize` is capped at 100 by the API with a default of
50. Every caller — `extractSessionPatch` (`src/session-ops.mjs:50`),
`retrySession` (line 227) — calls it **once**. On a long session the final
`changeSet` sits past the first page and `agentctl patch` reports
`"No git patch found in session output or activities."`

**Change.** Follow `nextPageToken` to completion behind a `maxPages` guard,
and pass the documented `createTime` cursor when the caller already holds a
timestamp, so a watch loop costs one page per poll instead of the full history.

### 9. `archiveSession` posts to an endpoint the API does not list

`src/provider.mjs:980` issues `POST /v1alpha/sessions/{id}:archive`. The
documented session methods are `create`, `list`, `get`, `delete`, `sendMessage`
and `approvePlan`; there is no `archive`. `deleteSession` immediately below it
uses the correct `DELETE`. `pruneSessions` (`src/session-ops.mjs:317`) defaults
to archive, so `agentctl prune --yes` takes the undocumented path first.

*Not verified against the live API — no key in this environment.* Either the
call is a no-op that reports success, or it 404s and the per-session result
records `ERROR: …`. Both are worth knowing before anyone relies on pruning.

**Change.** Probe it once with a real key; keep it if it works, otherwise make
`pruneSessions` default to `deleteSession` and drop `archiveSession` from the
MCP surface (`src/mcp.mjs:242`).

---

## P2 — Make quality measurable

### 10. There is no session-outcome ledger

`src/telemetry.mjs` records nine event kinds:
`checkpoint_created`, `dag_task_completed`, `dag_task_started`,
`gate_finished`, `gate_phase`, `gate_started`, `ooda_repair_attempt`,
`router_decision`, `verify_scope_narrowed`.

None of them tie a **session** to an **outcome**. So the questions that decide
prompt quality — which role merges, which template gets rejected, does `max`
profile actually raise the merge rate — cannot be answered from data today.

**Change.** Emit `session_dispatched` (id, role, template, profile, risk tier,
prompt bytes), `session_terminal` (state, wall time, activities, patch bytes)
and `session_merged` (PR, gate verdict). Then `agentctl dashboard` can answer
"merge rate by role over the last 30 sessions", and every prompt change in
`AGENTS.md` becomes falsifiable instead of anecdotal.

### 11. Pin the API version in one place

`v1alpha` appears in `src/provider.mjs` (6 occurrences), `src/wizard-task.mjs`
and `.env.example`. A `v1beta` cut means touching all of them.

**Change.** One `JULES_API_VERSION` constant (with the existing `AGENT_*`
alias convention), plus a `agentctl doctor` probe that reports the version the
endpoint actually answers on.

### 12. Remove committed test scratch directories

`git ls-files` lists eight tracked files under
`.test-kernel-fix-1788437002942/` and `.test-kernel-fix-1788528407802/`,
including `.agent/state/journal.jsonl` and a mutex lock file.
`test/kernel-integration-fix.test.mjs:10` creates its scratch root under
`process.cwd()` and cleans it in `t.after` — which does not run when the
process is reaped, and `.gitignore` has no pattern for it, so the leftovers got
committed.

**Change.** `mkdtempSync(join(tmpdir(), "kernel-fix-"))`, add
`.test-kernel-fix-*/` to `.gitignore`, and `git rm -r --cached` the two trees.

---

### Noted in passing: the egress guard does not read `.js`

`test/egress-allowlist.test.mjs` picks its files with
`entry.endsWith(".mjs")`. `bin/init.js` — a shipped entry point, published as
`jules-init` in `package.json` — is therefore outside the scan, and it carries a
host literal at line 264 (`https://jules.google`, in generated documentation
text rather than a fetch). Harmless as it stands. But the guard's stated claim
is that a reviewer can trust the boundary without auditing every future commit,
and a shipped binary outside the scan is the exception to that. Widening the
glob to `.js` and `.cjs` is a one-line change that puts it under the same rule
as everything else.

---

## Sequencing

1. ~~**Findings 1-3**~~ — **shipped on this branch**: `src/session-ops.mjs`
   (`extractFailureDiagnostics`), `src/engine.mjs` (`pollSessionState` and its
   caller), `bin/agentctl.mjs`, `test/session-poll.test.mjs` and new cases in
   `test/session-ops.test.mjs`.
2. **Findings 8, 9, 12** — correctness and hygiene, no design work.
3. **Findings 4-7** — the closed loop: read the plan, steer the session,
   answer its questions, gate on risk. This is where the merge rate actually
   moves.
4. **Finding 10** — then measure it.
5. **Finding 11** — whenever convenient.

## What this deliberately does not propose

- No new runtime dependencies. Everything above is native Node.
- No changes to the verification kernel. It passes 1222 tests and its guards
  are covered by an activation check; the findings here are in the session
  layer, and mixing the two in one PR would make both unreviewable.
- No auto-answering of `AWAITING_USER_FEEDBACK` beyond an author-supplied,
  bounded clarification table. Unbounded auto-reply is how a session ends up
  confidently wrong.
