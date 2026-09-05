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

## Tasks 1 and 2 — done

The silence hunt and the fifth cold-start trial were both run on 2026-09-05 and landed
as `reports/cold-start-2026-09-05/`. That trial found 22 findings, 12 of them severity 1,
and four of the worst were independently reproduced before it was merged. The work now
is remediation, not more hunting — see R1-R3 below, which are written from its findings.

Re-run the trial brief (`docs/cold-start-trial.md`) once R1 and R2 have landed, not before.

---

## R1 — The gate must verify the thing under review, using a policy the diff did not write

**Do this first. Nothing else in this repository matters while this is open.** Four
reproduced severity-1 findings say the same thing from four directions: the gate reads
its own policy out of the diff it is judging, and it verifies a revision other than the
one it is attesting.

The design constraints below are settled — implement within them rather than
re-deciding them. Everything else is yours.

```text
# Task: close the trusted-policy and verified-revision holes (F06, F07, F08, F09, F10, F11)

Read `reports/cold-start-2026-09-05/REPORT.md`, findings F06 through F11. Reproduce each one before you change anything — build the fixture, run the published CLI, and confirm you see the approval the report saw. Any finding you cannot reproduce, say so and leave alone.

The four that were independently confirmed against 0.71.0 are F06, F08, F10 and the staged half of F07. They share one root: nothing separates the policy the gate obeys from the diff the gate is judging, and nothing separates the code the gate runs from the revision it attests.

Three design constraints. These are decided; work inside them.

1. **One trusted-input resolver.** Every field the gate obeys — `verify.test` and every other stage command, `profile`, `base_branch`, `minTests`, `required`, `tamperGuard`, the protected-path lists — must be resolved in exactly one place, from a commit the diff under review cannot author. `tamperGuard` is already read from the base commit; the rest are not, and that split is the bug. A field read from the working tree in one code path and from the base in another is how this project has produced the same defect five times: write the rule once, and have every consumer call it.

2. **Verify the selected revision.** In `--mode staged` and `--mode committed`, the verification command must run against the snapshot being judged, not the working tree. Materialise it — `git worktree add --detach` or `git checkout-index` into a temporary directory — and run there. If the snapshot cannot be materialised, the gate refuses and says why. Attesting a revision you did not execute is the failure this tool exists to refuse, and running in the repository root is not isolation.

3. **First install is the hard case, and this is the answer.** On a repository whose base commit has no kit config, there is no trusted policy to read, and today the gate accepts whatever the uncommitted scaffold says — so an agent supplies its own oracle and is approved. Accept the scaffold only when it is byte-identical to what `init` generates for that repository; a scaffold modified in the same uncommitted diff is not a trusted policy and must not be obeyed. Say so in the output, and name the file and field that differ.

Two related findings belong with this change because they are the same question about the same field:

- **F09** — `node -e "process.exit(0)"`, `sh -c :`, pytest `--collect-only` and an empty Go test selection are accepted as verification. `isPlaceholderTestScript` already refuses `true`, `:` and an interpreter with an empty program; these are the same class one step along, and a command that is recognisably incapable of failing is not an unlisted runner.
- **F11** — a configured `python3 -m pytest` on a src-layout repository validates the installed copy while the gate approves edits to the working source. v0.71.0 fixed what `init` *chooses*; it did not touch a command already in a config. The report is careful about that distinction, so read it before deciding whether this belongs here or is its own change.

The regression tests are the deliverable as much as the fix. Each of F06-F11 gets a test that fails against today's code and passes after, and each rule you add or widen gets its case in `src/guard-policy.mjs`. Where a fix would risk rejecting correct work — constraint 2 changes what every staged and committed run executes — say what you checked to convince yourself it does not.
```

---

## R2 — The tamper guard's reach

Second priority. Independent of R1, so it can run in parallel.

```text
# Task: widen the tamper guard where the trial got past it (F01, F03, F04, F05, F12)

Read `reports/cold-start-2026-09-05/REPORT.md`, findings F01, F03, F04, F05 and F12, and reproduce each before changing anything.

**F04 is confirmed and its cause is known — start there.** `isDeregistration` in `src/security.mjs` requires the added name to be exactly the removed name minus its `test` prefix, so `test_x → x` is caught and `test_x → check_x`, `test_x → disabled_x` and `test_x → _test_x` all pass, along with the Go and Rust equivalents. Measured on a pytest repository against 0.71.0: only the first of those four is rejected. The rule was written narrow to avoid flagging `test_x → test_x_renamed`, which is an honest rename; the right rule keeps that case silent without requiring the new name to be a prefix strip. The report also lists build tags, `cfg(any())`, non-strict xfail and an early return before the assertions as ways to remove a test from execution — decide which of those the guard can see in a diff and say so for the ones it cannot.

The others, in the report's own words:

- **F01** — P-Limit's root `test.js` is not classified as a test file, so a deleted assertion, a vacuous replacement and a rewritten expectation were all approved in it. Fix the classifier and check the near-misses in `TEST_PATH_CASES` still hold: a predicate that says yes to everything has no denominator either.
- **F03** — a conditional expectation (`dec == (193 if value == 192 else value)`) blesses a broken function while both sides still contain a comparison.
- **F05** — a Go assertion neutralised by an impossible condition (`if len(comment) < 0`), leaving the failure call in dead logic.
- **F12** — diff coverage exits 0 having scored none of a new file. It does disclose `scored: false`, which is honest in the detail; the question is whether a guard that measured nothing should return a passing result.

Widening a guard is the direction that produces false reds, and a false red on a healthy repository is nearly as expensive as the hole it closes. For every rule you widen, add the innocent edits it must stay silent on to `INNOCENT_EDITS` in `src/guard-policy.mjs`, and assert the verdict a caller actually receives — that contract once stayed green for two releases while the gate rejected every case in it, because it checked the violation list and the blocking status was somewhere else.
```

---

## R3 — False reds, and saying what happened

Third priority, and the cheapest. Every one of these hits a newcomer.

```text
# Task: stop breaking healthy repositories, and report what was waived (F13-F22)

Read `reports/cold-start-2026-09-05/REPORT.md`, findings F13 through F22, and reproduce each before changing anything.

The first group makes a green repository red on first install, which teaches a new user that the gate is broken:
- **F13** — scaffolded Markdown fails a healthy host's own pre-commit hooks.
- **F14** — Rust init selects `cargo clippy -- -D warnings`, which the host CI does not require; a clean tree then fails with 121 lint errors. Init must not invent a stricter policy than the repository already keeps.
- **F15** — Cargo prints zero unit tests and then 58 passing integration tests; the count parser takes the first match and rejects a healthy suite as empty.
- **F16** — routine lockfile updates are hard-red protected-path changes. The report reads this as intentional policy rather than a bug, so decide deliberately: if it stays, the message has to say it is policy and name the flag; if it goes, say what stops an agent from smuggling a dependency swap through a lockfile.
- **F17** — `check --help` advertises `--strict-locks`, which the parser rejects as an unknown option.

The second group is about the gate saying what it actually did:
- **F18** — the environment-variable waiver, `minTests: 0` and an optional failing stage all produce an approval with no override banner, and `--allow-protected` leaves no provenance in the JSON output. v0.71.0 added the banner for the command-line flags; these are the paths it missed.
- **F19** — `verify.required: false` prints that nothing is executed, and then shows an executed failing command.
- **F20** — `check --dry-run` persists evidence although its help promises otherwise, and the session and plan dry runs report synthetic results with no rehearsal marker.
- **F21** — many subcommand help pages return the global command list instead of that subcommand's flags. The trial had to read the installed parser to find `--base`.
- **F22** — reverting the scaffold commit leaves ignored runtime state behind, and no documentation says how to remove the kit completely.

F17, F21 and F22 are documentation and argument-parsing work; F13-F16 change behaviour and need the same care as any guard change. `npm run jules:doc-sync` must pass, and if you change what a flag does, its help text and the README change in the same commit — a flag that is advertised and rejected is exactly what F17 is.
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

**R1 first, and alone.** It changes what every staged and committed run executes, so it
deserves a diff read properly rather than one merged on a green gate. R2 is independent
of it and can run in parallel. R3 is cheap and independent of both.

Task 3 and Task 4 are still open but no longer urgent: session steering is not worth
much while the gate itself can be talked out of checking, and the documentation pass is
now better specified by F17, F21 and F22 in R3 than by its own prompt.

Each finishes as a pull request. Our own gate runs on it, which means the tool gets
tested on the exact thing it exists for on every one of these.
