# Running Claude Fable 5.1 in Arena Agent Mode against this repo

Arena agent mode clones the repo into a sandbox, lets the model read, edit and run
commands, and opens a pull request at the end. Our own gate runs on that PR, so a
bad change is caught before it lands.

Every prompt below is **one paste**: Block A followed by one task block. Block A is
identical every time — it is the model-behaviour and repo-contract preamble, and the
task blocks assume it is present.

## Settings

- **Effort:** start at `high` for everything here. Anthropic's guidance is to treat
  `high` as the starting point and move to `xhigh`/`max` only where you have measured
  a gain. The one place `xhigh` is worth trying is Task 1, which is pure reasoning
  over existing code.
- **Progress updates:** Fable 5.1 writes fewer user-facing updates during long tool
  chains than earlier models, and the notes it does write come back as progress-update
  `thinking` blocks that are empty unless the client asks for them. Whether Arena
  requests them is Arena's choice, not ours — if the agent looks like it has gone
  quiet for minutes, that is expected, not a hang.
- **Don't over-specify.** Prompts written for older models tend to be too prescriptive
  and that lowers Fable's output quality. The task blocks below state the goal, the
  evidence standard and the constraints, and deliberately leave the method alone.

---

## Block A — paste this first, every time

```text
You are operating autonomously. The user is not watching in real time and cannot answer questions mid-task, so asking 'Want me to…?' or 'Shall I…?' will block the work. For reversible actions that follow from the original request, proceed without asking. Stop only for destructive actions or genuine scope changes the user must decide. Offering follow-ups after the task is done is fine; asking permission before doing the work is not.

Before ending your turn, check your last paragraph. If it is a plan, an analysis, a question, a list of next steps, or a promise about work you have not done ('I'll…', 'let me know when…'), do that work now with tool calls. That includes retrying after errors and gathering missing information yourself. Do not stop because the context or session is long. End your turn only when the task is complete or you are blocked on input only the user can provide.

# Delivering work
The user's request sets the scope, and the scope is the deliverable: don't quietly narrow, widen, or swap it. Read ambiguity the way a careful colleague would: make routine judgment calls yourself, and check in only when different readings would lead to materially different work. If one part turns out to be blocked, complete every other part in full and say exactly what you left out and why.

If, while working or testing, you find a pre-existing bug, a performance concern, or behavior the task doesn't mention, don't fix, optimize or extend it in this change unless the requested behavior cannot work without it; report it as a follow-up in your summary. Commit tests only where the task asks for them or this repository already keeps tests for this kind of change, sized like the neighboring test files, and don't turn scratch checks into additional permanent test files. This is about extras only: implement every behavior the task asks for, completely.

The number of tokens used to edit files is best minimized, all else being equal. Therefore, when it will not affect the end result, try to surgically edit a file rather than rewrite the entire thing. This repository's source comments carry measured evidence for why each rule exists — a whole-file rewrite destroys that record, so edit in place.

First privately list what you need next; then request every item that doesn't depend on another's result in this one response.

# What this repository is
`agentctl` is a zero-dependency Node 20+ CLI that acts as a safety gate and verification harness for AI coding agents. It decides whether an agent's diff can be trusted: it looks for changes that weaken verification — deleted assertions, rewritten expected values, skipped tests, a verification command that ran nothing — and refuses to approve a change that was not actually checked.

Two failure shapes matter more than all others, and they set the priority of everything you do here:
1. The gate reports APPROVED when nothing actually verified the change. This is the worst outcome, because the user installed this tool precisely so they would not have to check by hand.
2. The gate hard-rejects a correct change or a clean checkout. Nearly as bad: a user whose first run is a false red concludes the gate is broken and turns it off, after which (1) is guaranteed.

# House rules — these are not style preferences
- Zero runtime dependencies. Only `node:*` builtins. A test enforces this; do not add a package.
- Code, comments and commit messages in English.
- Comments explain *why*, with the measured evidence — what was observed, on what input, and what the tool wrongly reported. Match the density and voice of the surrounding code.
- Reproduce before fixing. Measure every claim against the code as it actually is before changing anything. If you cannot reproduce something, say so and do not fix it.
- Suspect your own test fixture before you suspect the tool. This is the single largest source of false findings in this project's history: a `sed` that did not match, an edit that genuinely broke the suite so the rejection was correct, a `//` comment in a `.py` file. Run the repository's own test command by hand and read the output before concluding the gate is wrong.
- Separate *found* from *caused*: check whether something was already broken before you touched it (`git stash`, or the same probe against a pristine checkout), and say which you did.
- Never hardcode a provider, stack, CI system or environment-variable name to one setup. The kit must stay universal.
- One test suite at a time. Never leave a killed process behind.

# The gate must be green before you open the PR
Run all five and paste the real output in the PR description:
    npm test
    npm run guard-reach
    npm run jules:doc-sync
    npm run package-integrity
    npm run lint
`npm test` prints its own totals; `guard-reach` proves every blocking guard can still be made red. If you add or change a rule in the guard, add its case to the hand-written contract in `src/guard-policy.mjs` — that file is deliberately written from what the tool *claims* to do, never from the regexes that implement it, so do not generate it from the implementation.

# Leave the release alone
Do not bump the version in `package.json`, do not edit released sections of `CHANGELOG.md`, and do not create tags. Releases are run separately with `scripts/release.mjs`. Put what you would have written in the CHANGELOG into the PR description instead.
```

---

## Task 1 — Hunt for silence (start here)

The highest-value job, the lowest risk, and the one that plays to a strong reasoning
model: nothing ships behaviour changes, only evidence and contract cases. Try `xhigh`
here if you try it anywhere.

```text
# Task: find a way to make this gate say APPROVED when it should not

Read the guard implementation — `src/security.mjs`, `src/engine.mjs`, `src/ops/test-collection.mjs`, `src/stack-detector.mjs`, `src/config.mjs` — and then try hard to defeat it.

Your goal is a concrete, reproducible case where `agentctl check` returns `APPROVED (Exit 0)` on a change that genuinely weakens verification, or where a guard reports a pass having examined nothing. Build real fixture repositories in a scratch directory and run the real CLI against them. Do not reason about what the code would do — run it.

Directions worth trying, as starting points rather than a checklist:
- a verification command that exits 0 without exercising the changed code at all
- a test suite that imports an installed copy of the package instead of the working tree
- a workspace or monorepo where the package the diff touched has no tests
- a test file the classifier does not recognise as a test file
- an assertion dialect the tamper guard does not know, on a language it claims to cover
- a diff shape that makes an assertion removal and an addition cancel out in the counting
- anything that reaches a `PASS` status through a path where the evidence list is empty

For each attempt, report whether it worked. **The failed attempts are as valuable as the successes** — they say where the guard is genuinely solid, and this repository has no record of them. Do not invent a finding to fill the report.

Deliver:
1. `docs/silence-audit.md` — every attempt, the exact fixture and commands, what the gate printed, and whether the guard held. Group by whether it held.
2. For each case that got through: a failing test that pins it, added to the existing suite in the style of its neighbours, plus its case in `src/guard-policy.mjs`. Add the test even if you do not fix the underlying hole — a red test naming a real hole is a better deliverable than a silent one.
3. For each case that held: a line in the audit saying which rule caught it, so a future reader knows the coverage is real and not accidental.

Fix a hole only where the fix is small and obviously safe. Where it is not, write the failing test and describe the fix in the PR instead — the guard is easy to make wrong in the direction of rejecting correct code, and that is nearly as bad as the hole.
```

---

## Task 2 — The fifth cold-start trial

The repo already carries the brief. This runs it end-to-end and costs us nothing.

```text
# Task: run the cold start trial in docs/cold-start-trial.md

Read `docs/cold-start-trial.md` and execute it in full, exactly as written, against the **published** package rather than this checkout:

    npm install -g jules-orchestrator-kit
    agentctl --version

Work in a scratch directory. Treat this repository's source as reference material you may read when a finding needs explaining, but never gate against it and never let reading it substitute for running the CLI.

The brief's rules of evidence are the binding part. In particular: every terminal block in your report must be pasted from a real run, because the quoted strings get grepped against the source afterwards and a previous trial carried five that existed nowhere. Reproduce twice from an empty directory. Suspect your own fixture first.

If a phase cannot run — no credentials, no network to a repository host, a package manager missing — say so plainly in the denominator table with the reason. A phase honestly skipped is worth more than one you claim to have run.

Deliver the report as `docs/trials/trial-05.md`, in the structure the brief specifies, ending with the two-paragraph verdict a stranger would reach and the single change that would most improve their first hour. Do not change any source file in this PR — this is a measurement, and mixing it with fixes makes both harder to trust.
```

---

## Task 3 — Close the loop with the running session (P1, findings 4–6)

Real feature work, already specified. This is the biggest of the four.

```text
# Task: implement findings 4, 5 and 6 from docs/jules-quality-plan.md

Read `docs/jules-quality-plan.md`. Implement the three P1 findings that concern the running session:

- **4** — `:sendMessage` is implemented and nothing calls it, so there is no mid-session steering.
- **5** — `AWAITING_USER_FEEDBACK` sessions die silently.
- **6** — the generated plan is never inspected before it is approved.

The plan document states the problem and the shape of each fix; the design decisions inside that shape are yours. Where the plan and the code disagree, the code as it exists today wins — verify each finding still reproduces before implementing it, and say so in the PR if one does not.

Two things to hold on to while you work:

The Jules API is the authority on its own shapes. This project has already shipped a bug where the retry read four fields the documented `Activity` type does not contain, and another where a poll recognised two of nine documented `SessionState` values and synthesised `COMPLETED` for the rest. Read what the API documents before you read what the code assumes.

A session that has not finished is not a session that passed, and a plan that was never read is not a plan that was approved. Wherever your change makes the kit decide something about a session, the state where it *could not tell* must be distinguishable from the state where it *checked and it was fine*. That distinction is this project's central concern and its most repeated defect.

`test/session-poll.test.mjs` and `test/session-ops.test.mjs` show the level of coverage this area is held to. Match it for the paths you add.
```

---

## Task 4 — The stranger's first hour, on paper

Cheap, high leverage, and a different muscle: this one is about writing.

```text
# Task: make the first hour work for someone who has never seen this project

Install the published package the way a newcomer would (`npm install -g jules-orchestrator-kit`), then follow `README.md` from the top on a public repository you did not choose in advance, doing exactly what it says and nothing it does not say. Record every point where you had to guess, backtrack, or read source code to find out what a command would do.

Then fix the documentation so the next person does not hit those points. In scope: `README.md`, `EXAMPLES.md`, and the onboarding text the CLI itself prints. Out of scope: behaviour changes — if a command's behaviour is the problem rather than its description, note it in the PR as a follow-up rather than changing it here.

Three things to check specifically, because they are how a newcomer actually gets lost:
- Every command the README advertises exists and does what the README says it does. Run each one.
- Every promise about behaviour is literally true. "Pass the prompt to skip straight to review" has to skip straight to review.
- The exit codes are documented and match what the CLI returns. Exit 6 is shared between the secret scanner and the test-integrity guard; a reader must be able to tell which one they hit.

`npm run jules:doc-sync` enforces that the documented test counts and version strings match reality — it must pass. Keep the existing voice: this project's documentation says what a thing does and what it costs, without marketing register.
```

---

## Running them

Task 1 and Task 2 are independent of each other and of everything else — run them first
and in parallel if Arena allows it. Task 4 touches only documentation. Task 3 is the one
that changes dispatch behaviour, so land it on its own and read the diff properly.

Each finishes as a pull request. Our own gate runs on it, which means the tool gets
tested on the exact thing it exists for on every one of these.
