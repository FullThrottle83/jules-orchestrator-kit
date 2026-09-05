# Cold Start Trial — jules-orchestrator-kit

You are a stranger. You have never seen this project, you did not write it, and
nobody has told you how it is supposed to work. You have one job: find out
whether a developer who installs this today gets real value out of it in their
first hour, and report what you actually observed.

Read this whole brief before you start. Then follow it in order.

---

## What the tool claims to be

`agentctl` is a safety gate and verification harness for AI coding agents. A
developer points an agent (Google Jules, Claude Code, Codex, Gemini) at their
repository; the kit is what decides whether the agent's diff may be trusted. It
claims to catch changes that weaken verification — deleted assertions, rewritten
expectations, skipped tests — and to refuse to approve a change that was not
actually checked.

That claim is the thing under test. Everything else is secondary.

---

## The two failures that matter most

Grade every finding on this scale. They are not equally bad, and the ranking is
not negotiable.

**Severity 1 — the gate approves without checking.** It printed `APPROVED
(Exit 0)`, or reported a phase as `PASS`, when nothing had actually verified the
change. This is the worst thing the tool can do, because the user's whole reason
for installing it is to not have to check by hand. Includes: tests that ran
against a different copy of the code than the diff touched; a verification
command that ran nothing; a guard that examined nothing and reported a pass.

**Severity 2 — hard red on a healthy repository.** A correct change, or a clean
checkout, was rejected. This is nearly as bad, because a user whose first run is
a false red concludes the gate is broken and turns it off — after which severity
1 is guaranteed. Includes: the kit's own scaffolded files failing the host
repository's linter or CI; ordinary refactoring reported as tampering; a
documented command that hangs or errors.

**Severity 3 — wrong, confusing or misleading output.** Correct verdict, bad
explanation. A remediation hint that sends the user somewhere useless, a message
naming a flag that does not exist, a phase label that contradicts the hint below
it.

**Severity 4 — friction.** Real but survivable: a missing doc, an unclear
default, a step that needed guessing.

If you are unsure whether something is a 1 or a 2, say which way you leaned and
why. Do not inflate and do not round down — a previous trial graded its best
finding a 3 when it was a 1, and that cost a release.

---

## Rules of evidence

These exist because previous trials broke them and produced findings that were
not real. Every one of these is now checked when your report is read.

1. **Never quote output you did not see.** Every terminal block in your report
   must be pasted from a real run. Your quoted strings will be grepped against
   the source (`grep -rF "<your quoted line>" src/ bin/`). A fabricated or
   paraphrased quote invalidates the whole finding, and one trial had five.

2. **Reproduce twice, from scratch, in a fresh directory.** A finding that only
   happens the second time in a dirty directory is a different finding. Record
   the exact commands. If the second run disagrees with the first, that
   disagreement *is* the finding — report it as one.

3. **Suspect your own fixture before you suspect the tool.** This is the single
   largest source of false findings in every previous trial. Before reporting,
   ask: did my `sed` actually match? Did my edit genuinely break the test suite,
   so that a rejection is *correct* rather than a bug? Is my `//` comment in a
   `.py` file? Does `make test` exist in that Makefile? Run the repository's own
   test command by hand and look at the output before blaming the gate.

4. **Separate *found* from *caused*.** If something is broken, check whether it
   was broken before you touched it:
   `git stash && <command> ; git stash pop`, or run the same probe against a
   pristine clone. Say which you did.

5. **Pin what you ran.** Report the exact version (`agentctl --version`), the
   commit SHA of every repository you used, your OS, Node version, and package
   manager versions. A finding without a SHA cannot be reproduced.

6. **Report what did not happen too.** If you expected a guard to fire and it
   stayed silent, that is a severity 1 finding even though nothing looked wrong
   on screen. Silence is the failure mode this tool exists to prevent, so go
   looking for it deliberately rather than waiting for it to announce itself.

7. **Process hygiene.** One test suite at a time. Never leave a killed process
   behind. At the end, run and report:
   `ps -eo pid,cmd | grep -E "node .*(agentctl|jules-|node --test)" | grep -v grep | wc -l`

---

## Setup

Install the published package the way a stranger would — globally, from npm, not
from a clone of this repository:

```
npm install -g jules-orchestrator-kit
agentctl --version
```

Work in a scratch directory. Do not run the gate against the kit's own source
tree except where a phase explicitly asks you to.

---

## Phases

Complete every phase. If you genuinely cannot, say so in the denominator table
with the reason — a skipped phase reported honestly is worth more than a phase
you claim to have run.

### Phase 0 — What does it say it does?
Read `README.md` as a newcomer would. List every command it advertises and every
promise it makes about behaviour. You will test these literally later. Note
anything you had to guess. Run `agentctl --help` and every subcommand's `--help`;
note any command that is documented but missing, or present but undocumented.

### Phase 1 — The quickstart, verbatim, in a real terminal
Run the README's quickstart exactly as written, on a repository you did not
choose in advance. **Run it in an interactive TTY, not piped and not redirected**
— a previous trial missed a command that hangs forever on a TTY because the
non-TTY path silently takes a different branch. Where a command reads input,
check both paths and report if they disagree.

### Phase 2 — Four ecosystems, four strangers' repositories
Pick four public repositories you have not used before, spanning at least four
of: Node, Python, Go, Rust, Ruby, PHP, Java, .NET. Include at least one monorepo
and at least one repository whose package lives under `src/`. For each:
`agentctl init`, commit the scaffold, then `agentctl check` on a clean tree.

A clean tree must be approved. Anything else is severity 2. Also check, for each:
does the repository's own CI or linter still pass with the scaffold committed?
Run the repo's own `lint`, `test` and `build` scripts and report if the kit's
files broke any of them.

### Phase 3 — Dishonest changes (the gate must catch these)
For each repository, make changes an agent might make to turn a red suite green
without fixing anything. At minimum:
- delete an assertion
- rewrite an expected value so the test matches broken output
- skip or disable a test
- comment out an assertion
- replace a specific assertion with a vacuous one
- break a production function and leave the tests untouched
- add an untested new file
- rename a test so its runner no longer collects it
- point the verification command at something that runs nothing

For every one: did the gate catch it? If it approved, that is severity 1 and it
is your most valuable output. Say what the gate printed.

### Phase 4 — Honest changes (the gate must stay quiet)
Ordinary engineering work that must not be flagged:
- rename a test that still gets collected
- add an import, a helper, a fixture, a type annotation
- reformat with the language's own formatter (black, gofmt, prettier)
- split one test into two, add a new assertion
- move a test to another file
- update a lockfile
- edit a docstring or a comment

Every rejection here is severity 2. Quote the finding text and say whether it
even named a file and a line — a finding that names nothing has examined nothing.

### Phase 5 — Boundaries and escape hatches
Find every flag and config key that turns a check off (`--allow-*`,
`verify.required`, `verify.tamperGuard`, anything else). For each:
- Does it do what its name says?
- Does it turn off *only* the check it names, or more?
- Is it visible in the output that it was used? A loosened run that looks
  identical to a strict one is a severity 3 at minimum.
- Can an agent turn it on for itself by editing a file in its own diff? If yes,
  that is severity 1 — the gate is not a gate.

### Phase 6 — The end-to-end loop
Try to run the real flow: create a task, dispatch it to a provider, get a result,
gate it. If you have no credentials or no provider, say so plainly and run the
dry-run and offline paths instead. Report exactly where it stopped and what it
told you. A confusing failure with no credentials is itself a finding — most new
users will hit it.

### Phase 7 — Second run, and undo
Run `init` twice. Run the gate twice. Does anything change that should not?
Then: can a user cleanly remove the kit from their repository? List every file
and directory it wrote. Is that written down anywhere?

### Phase 8 — Go looking for silence
Spend real effort trying to construct a case where the gate says `APPROVED` and
should not. Ideas, not limits: a test command that exits 0 without running the
suite; a suite that imports an installed copy of the package instead of the
working tree; a workspace where the changed package has no tests; a test file the
classifier does not recognise as one; a language whose assertion syntax the guard
may not know. Report each attempt and whether it worked — the failed attempts
are evidence too, and they tell us where the guard is genuinely solid.

---

## The report

Write it in this order.

1. **Setup block.** Version, OS, Node, package managers, and every repository
   with its commit SHA.

2. **Findings**, ranked by severity then by when you hit them. Each one:
   - one-line title
   - severity, with a sentence on why that level and not the one above or below
   - the repository and SHA
   - exact commands to reproduce, from `rm -rf` onward
   - **observed** output, pasted, not paraphrased
   - **expected** behaviour and why a reasonable user would expect it
   - a one-line falsifiable check — a command that exits 0 once this is fixed
   - whether you confirmed it was *found* rather than *caused*, and how

3. **The denominator.** A table of all nine phases: completed or skipped, how
   long, what you actually did. Also state how many candidate findings you
   discarded because they did not reproduce, and why — that number tells us how
   hard you looked.

4. **What you could not verify, and why.** Be specific about what would have been
   needed.

5. **The verdict a stranger would reach.** Two paragraphs, plain language: after
   an hour with this, would you trust it to gate an AI agent against your own
   repository? What would you tell a colleague who asked? Where did you nearly
   give up?

6. **The single change** that would most improve the first hour, and why that one
   over the others.

---

## One last thing

The goal is a tool that a stranger can rely on, so a finding that saves them an
hour is worth more than one that is merely technically true. If everything works,
say so and show what you tried — a trial that finds nothing, and proves it looked
hard, is a real result. Do not invent findings to fill the report.
