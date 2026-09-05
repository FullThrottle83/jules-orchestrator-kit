# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
*A session that has not finished is not a session that passed.*

An audit of the Jules session layer against the API it talks to. Twelve findings, each traced to a file and line in `docs/jules-quality-plan.md`; the three below are the ones that let the kit believe something about a session that was not true.

### Fixed
- **The Retry Was Dispatched Without The Failure It Existed To Fix (`src/session-ops.mjs`)**: `retrySession` collected its diagnostics from `act.error`, `act.executionOutput`, `act.exitCode` and `act.status`. None of those four fields exists in the documented `Activity` type — what the API returns is `artifacts[].bashOutput.{command,output,exitCode}` and `sessionFailed.reason`. Measured against a response shaped exactly like the documentation, a `FAILED` session whose bash artifact carries `not ok 1 - invoice totals must round to cents … AssertionError: expected 10.01 to equal 10.00` with `exitCode: 1`, the retry went out with `[PREVIOUS_ATTEMPT_FAILURE_DIAGNOSTIC]` set to *"Previous session did not complete cleanly."* It was handed a sentence when it needed the assertion, the file and the line. `extractFailureDiagnostics` reads the documented fields, returns them highest-signal first so the 4000-character cut drops the least useful evidence rather than the one that failed, deduplicates repeats, and still reads the legacy spellings for provider shapes that have not been observed.
- **An Unfinished Session Was Reported As COMPLETED (`src/engine.mjs`)**: `pollSessionState` recognised two of the nine documented `SessionState` values and returned `String(session.status || "COMPLETED")` for every other exit — and `session.status` is never set on a fresh dispatch. Measured: a session in `AWAITING_USER_FEEDBACK` and one still `IN_PROGRESS` when the poll budget expired both came back `COMPLETED`, so `QUEUED`, `PLANNING`, `PAUSED` and a session waiting on a human were indistinguishable from success. Terminal, blocked and timed-out are now three distinct verdicts, a provider that stops answering is `unreachable` rather than a timeout describing the wrong thing, and nothing synthesises `COMPLETED` any more. The one path that still returns it is the dry-run simulation, and it is now flagged `simulated`.

### Added
- **A Contract For The Poll (`test/session-poll.test.mjs`)**: 22 cases across all nine `SessionState` values, the timeout and wall-clock paths, the `approvePlan` side effect granted and refused, the unreachable paths, and the dry-run short-circuit. `pollSessionState` decides whether an agent session is believed to have finished writing — every later gate builds on that — and `grep -rn "pollSession" test/` returned nothing. That is the same class of hole `scripts/guard-reach-check.mjs` exists to close, in the one function that most needed it.
- **A Green Run Is Not Evidence (`test/session-ops.test.mjs`)**: the opposite failure of a diagnostic collector is one that flags everything, which buries the command that failed under a hundred that passed. `pytest` printing `13 passed`, node:test printing `# fail 0` and `go test` printing `ok` on exit 0 each yield no diagnostics.

### Changed
- **`agentctl retry` Says When The Trace Is The Fallback (`bin/agentctl.mjs`, `src/session-ops.mjs`)**: `failureReason` alone cannot tell a real trace from the generic sentence — both are non-empty strings. `retrySession` now returns `diagnosticsFound` and `diagnosticSources`, and the CLI prints the count and where the evidence came from, or says plainly that the retry is going out with nothing but the generic line.
- **A Non-Terminal Session Is Announced Before The Gate Runs (`src/engine.mjs`)**: the repair loop polled the session and discarded the answer, then ran re-verification against a tree the agent might not have finished writing. The verdict is now read: a non-terminal session prints `[SESSION_NOT_TERMINAL]` naming what it is waiting on and appends a `session_not_terminal` telemetry event. The gate still runs either way — it is the authority on whether the change works — but it no longer runs silently on a half-applied patch.

## [0.69.0] - 2026-09-04
*A denominator is not evidence if the things counted in it were never read.*

A third cold-start trial against v0.68.0. Twelve findings; six reproduced, and the two most serious were graded lower by the trial than they deserved. The pattern in both: the guard recognised a line as an assertion, counted it in `assertionsSeen`, and reported `PASS` without ever reading the value being asserted. `UNREADABLE` exists precisely so that "I could not read this" and "I read this and it is fine" look different — and a line could pass the readability test while its expectation stayed opaque.

### Fixed
- **Expected-Value-First Assertions Were Dismissed As Reworded Messages (`src/security.mjs`)**: `messageArgIndices` treated a string in argument 0 of any two-or-more argument assertion as prose for a human. JUnit and PHPUnit *document* the opposite order — `assertEquals(expected, actual)` — so no Java or PHP repository had any protection against a rewritten string expectation, and neither did Python's `assertIn(member, container)` or `assertNotIn`. Measured: `assertEquals("Hello World", out)` → `assertEquals("Hello Tampered", out)` returned `PASS` with `assertionsSeen: 2`. The one dialect that really does put prose first is JUnit 4's three-argument form, and it is distinguishable, because its trailing argument is the actual value rather than a message.
- **A Rewritten Regex Was Neither A Change Nor A Loss (`src/security.mjs`)**: `blankLiterals` blanked strings, numbers and booleans, and left regex literals alone — so `toMatch(/Hello World/)` and `toMatch(/Hello Tampered/)` normalised to two different shapes, never met in a bucket, and balanced each other out in the count: one specific assertion removed, one added, silence. Jest's `toMatch` and `toThrow` and RSpec's `match` all take the pattern as their only argument, which is where a test states what it expects. The lookbehind separating a regex from a division is what makes this safe: an operand never precedes the opening `/` of a pattern.
- **Renaming A Test Was Reported As Rewriting An Expectation (`src/security.mjs`)**: on the one-line form — `test("adds", () => { assert.strictEqual(add(2, 3), 5); });` — the name blanked to the same shape as its replacement, the two paired, and an author who renamed a test and nothing else was handed a `CRITICAL` finding quoting their whole line back at them. The multi-line form was never affected, because `NON_JOINING_CALL` already keeps a test name from joining to the assertion below it; this is the same rule for statements that fit on one line. A rename that also moves the expectation still differs after the name is blanked, so it is still reported.
- **A Verification Command With An Environment Prefix Never Started (`src/git.mjs`)**: `PYTHONPATH=src python3 -m pytest` is how a large part of the Python world writes its test command. `execFileSync` took the whole assignment as the program name and failed with `spawnSync PYTHONPATH=src ENOENT`, which the gate reported as a failed verification — telling the user their tests broke when the command had never run. Leading assignments are peeled into the child's environment, which behaves the same on every platform where handing the string to a shell would not.
- **`node -e ""` Was An Oracle (`src/stack-detector.mjs`)**: `true`, `echo ok` and `exit 0` were refused; the same no-op spelled as an interpreter with an empty program was accepted, and the gate returned `APPROVED (Exit 0)` on a change verified by nothing. Nothing can enumerate every way to write a command that runs nothing — that is what the collection floor is for, one-sidedly and by design — but the spellings that *look* like work are a small, decidable set.
- **The Timeout Message Named Neither The Limit Nor The Knob (`src/git.mjs`, `src/engine.mjs`, `src/wizard-init.mjs`, `README.md`)**: the default was 60 seconds, which an ordinary mid-sized suite exceeds on cold caches, and the explanation was suppressed by a guard testing for a token that Node's own `spawnSync sh ETIMEDOUT` already contains — so it was skipped exactly when it was needed. `verify.timeout_ms` existed and worked, and appeared in no README, no generated config, and no error message. Default is now 300000, the key is written into the config `init` generates, and the message says the command was killed rather than failed.

### Changed
- **`init` Rejects An Oracle That Proves Nothing (`src/wizard-init.mjs`)**: `pnpm -r test` on a workspace whose packages declare no test script exits 0, prints nothing, and runs nothing — and the probe blessed it, leaving the repository configured to approve every future change against silence. Choosing a command is the right moment to be strict about this: at `init` the cost of rejecting a candidate is trying the next one, where at gate time it would be a hard red on a repository that is fine. Two passes now — prefer a command that proves it ran something, and only settle for one that merely exits 0 while saying so out loud.
- **Seven More Runners State Their Count (`src/ops/test-collection.mjs`)**: Python `unittest`, GoogleTest, Catch2, `deno test`, `bun test`, AVA, and a bare TAP plan all landed in the same "I could not tell" bucket as a command that ran nothing. The floor stays one-sided — an unrecognised runner still passes, because failing on "I could not tell" would hard-red every correct repository not on the list — so widening it only ever converts silence into an answer.

### Also Fixed
- **The Documented Default Was Never The Loader's Default (`src/config.mjs`)**: the fallback was added to the engine, and `loadConfig` always supplied a value — so the fallback was unreachable and every repository without an explicit `timeout_ms` kept the one-minute limit while the changelog said five. A default belongs where the value is resolved, not where it is consumed. This is the third time in this project's history that a rule has been written in one place while another kept the old answer, so the regression test asserts the value a caller actually receives rather than any one site.
- **Two Tests Gated This Repository Against Itself (`test/engine.test.mjs`, `test/kit.test.mjs`)**: both called the gate with `root: process.cwd()`, so the verify stage ran `npm test` — the whole suite, from inside the suite. Neither could finish; the stage timeout was their only stopping condition, and each asserted little more than that a boolean was a boolean. They cost one full timeout per run and were invisible while that timeout was 60 seconds. Raising it to 300 turned them into a CI failure on every matrix cell, which is how a pair of tests that verified nothing finally got noticed. Both now run against a fixture with a bounded oracle and assert the verdict. The suite went from 67s to 19s.
- **The Egress Guard Could Not See `.js` (`test/egress-allowlist.test.mjs`)**: the scan collected `.mjs` only, so `bin/init.js` — published as the `jules-init` binary — sat outside the boundary entirely. Harmless as it stands, but the guard's whole purpose is that a reviewer can trust the boundary without reading every commit.

### Not Reproduced
Six of the twelve did not hold, and five quoted terminal output that does not exist anywhere in the shipped code. `--allow-test-change expectation` propagates correctly through both phases and returns `APPROVED`; `--allow-test-change removal` allows deleting a dead test alongside its dead function, also `APPROVED` — both reported failures were a test suite genuinely broken by the reporter's own edit, which is the same fixture artefact this project has hit repeatedly. `agentctl plan approve --dry-run` errors with *"Session ID is required"* rather than printing the quoted *"Plan Approved Successfully!"*. `task create -p` did not block on a prompt. A protected `package.json` is the design, and the gate already prints `To allow protected files in this run, pass: agentctl gate --allow-protected` — the finding stated there were no flag hints in the output. The `TEST_DIALECT_UNREADABLE` remediation copy was already correct: *"Exit 6 Test Integrity Violation — no secret was found"*, not the quoted *"Secret Leak Prevented"*. And `pnpm -r test` exits 0 on pnpm 10.33.4 rather than the reported `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT` — the real defect there was worse than the one reported, and is fixed above.

### Added
- **Eleven Cases In The Policy Contract (`src/guard-policy.mjs`)**: seven canaries for the expectation forms that were invisible — JUnit and PHPUnit expected-first, `assertIn`, `assertNotIn`, and regex patterns in `toMatch`, `toThrow` and RSpec `match` — and four innocent edits for the renames that were called tampering, plus JUnit 4's message-first form, which must stay silent. 42 canaries, 16 innocent edits.

## [0.68.0] - 2026-09-04
*A check that examined nothing does not get to say APPROVED.*

A second cold-start trial against v0.67.0, run as an unprimed stranger against the published package. Thirteen findings; eleven reproduced.

### Changed
- **An Unreadable Dialect Now Blocks (`src/security.mjs`, `src/engine.mjs`, `bin/agentctl.mjs`)**: the guard printed *"this change was NOT checked for tampering … it is not an approval either"* and then returned `APPROVED (Exit 0)`. That is the exact shape this project exists to refuse — a verdict from a check that examined nothing, dressed as a pass — and the trial walked a tampered test over broken production code straight through it on node-tap, and again on BATS. Changed test files with no recognisable assertion are now `Exit 6`. Three ways out, best first: report the dialect so it gets covered; set `verify.tamperGuard: "warn"` in the committed config, which says so on the record; or allow one run with `--allow-unreadable-tests`. Like every other trusted field, the config setting is read from the base commit, so an uncommitted edit cannot switch the guard off.
- **A Command That Cannot Fail Is Not An Oracle (`src/engine.mjs`)**: `agentctl task create` already refused one — *"Unfalsifiable Task Rejected: Task must include a non-trivial verification test/build command"* — while the gate approved against `verify.test: "true"` and printed an advisory. The same kit disagreed with itself about the same string. The collection floor cannot catch this (`true` states no count, and failing on "I could not tell" would break every unlisted runner), but a command that is *recognisably* a placeholder is not an unlisted runner. `Exit 4`, naming the command.

### Fixed
- **chai And node-tap Were Invisible (`src/security.mjs`)**: chai's `.to.equal(` is a dot chain where RSpec's is a space, so it never reached that branch — swapping `expect(x).to.equal(v)` for `expect(x).toBeDefined()` lost no *specific* assertion and the weakening check stayed quiet, in direct contradiction of a README promise. node-tap's assertions hang off whatever the sub-test callback named its argument, which is `ct` as often as `t`. And `{ skip: true }` puts the comma before the brace, not before the key.
- **A Reformat Read As A Weakening (`src/security.mjs`)**: `assert (` alone on a line names no value, so Black or Ruff splitting one assertion across three lines removed one specific assertion and added none — a `CRITICAL` finding for running a formatter. The denominator had been moved to statement level one release earlier; the weakening count had not. It is the same defect one level down, for the second release running.
- **`bootstrap` Wrote An Oracle That Asserts Its Own Impossibility (`src/stack-detector.mjs`)**: a CSS library, icon set or font package has a `package.json` and no JavaScript, and `bootstrap` wrote `node --test .agent/smoke.test.mjs` into one anyway. The next gate run died on the generated suite's own assertion — correct, but arriving after the config had been written, which left the user following the gate's repair advice into a dead end. It declines now, and says what to set instead.
- **`npm run jules:doc-sync` Failed In The Installed Package (`scripts/doc-sync-check.mjs`, `package.json`)**: it compares documentation against the test suite, which is not shipped. It says so now, and `CHANGELOG.md`, `ROADMAP_V1.md` and `AGENTS.md` are shipped, because a consumer has reason to read them.
- **Exit 6 Is Documented As What It Is (`README.md`)**: "Secret **or** test integrity", not "Secret".

### Not Reproduced
Two findings did not reproduce against the shipped code. The assertion-message case (`assert enc == expect` → `assert enc == expect, "..."`) returns `PASS` on a real clone of `pallets/itsdangerous` running the reported command verbatim — and the transcript names a function, `test_int_to_bytes`, that the repository does not contain. The scaffold-exemption case does not collapse on an untracked file; it collapses on a *protected* one, such as a lockfile, which is the rule working as designed.

## [0.67.0] - 2026-09-04
*The last four from the trial, and the rule that a move is not a deletion.*

### Fixed
- **A Test Could Be Silenced With Its Own Standard Library (`src/security.mjs`)**: the decorator and annotation forms were covered — `@pytest.mark.skip`, `@Disabled`, `it.skip` — and the in-body call was not. Measured silent on six of seven: `self.skipTest()`, `pytest.skip()`, `raise unittest.SkipTest`, mocha's `this.skip()`, `test.todo()`, and Go's `t.SkipNow()` (`t.Skip(` was listed, but the pattern required the parenthesis immediately after the name). `self.skipTest()` is how unittest's own documentation writes it.
- **Moving A Test Read As Deleting It (`src/security.mjs`)**: assertion tracking was strictly per file, so ordinary refactoring produced `CRITICAL` tampering findings for assertions that still exist and still run. An exact arrival elsewhere in the same diff now accounts for a departure — exact on purpose: an assertion that changed on the way across is a different claim and is judged normally, and two departures cannot both claim one arrival.
- **`npm test` In An Installed Copy Crashed (`scripts/run-tests.mjs`)**: `files` ships `scripts/` and not `test/`, so it failed with a raw `ENOENT: no such file or directory, scandir '.../test'`. The suite is not missing; it was never in the tarball. It now says so, and points at `npm run guard-reach` for checking an installed copy — exiting 1, because a runner that ran nothing must not claim success even here.
- **A Tampering Failure Was Labelled As A Secret Leak (`bin/agentctl.mjs`)**: exit 6 is shared with the secret scanner and the codes are frozen, but a bare `Phase [SECRETS] : ❌ FAIL` sent operators looking for a credential to rotate when an assertion had been deleted. The rendered label now names what actually failed. The machine contract is unchanged: the phase is still `secrets`.

### Added
- **Two-File Cases In The Policy Contract (`src/guard-policy.mjs`)**: a verdict that depends on what two files do together could not be expressed before, so the rule that a move is not a removal had no witness. Three cases: moved, deleted outright, and changed on the way across.

### Credit
This completes the cold-start trial: all twelve findings closed. Five more were found while reproducing them — a comment read as a line continuation, a message written outside the call, an argument walker that started one character early, line comments that `stripComments` had never stripped, and a test fixture that had left 18 GB in /tmp.

## [0.66.0] - 2026-09-04
*Saying nothing and saying approved must not look the same.*

### Fixed
- **An Assertion Is A Statement, Not A Line (`src/security.mjs`)**: the denominator counted `+`/`-` lines, so the commonest shape in every language with multi-line calls was invisible — `self.assertEqual(` on an unchanged context line, only its argument lines edited. Nothing among the changed lines matched an assertion pattern and nothing looked assertion-shaped, so a five-element expected list rewritten to one element to match broken output reported `assertionsSeen: 0` and a clean `PASS`. Measured on a real repository: five green phases and `APPROVED`. Detection missed it a second time even after the count was honest, because shape pairing compares statements with their literals blanked and a list that shrank lands in a different bucket; a new argument-level pass takes the arguments as the witness — same assertion, same arity, same *subject*, different expected value.
- **Line Comments Were Never Stripped (`src/security.mjs`)**: `copyCode(i)` copied the code up to the comment and left `pending` sitting at its start, and the `copyCode(n)` after the loop copied the comment straight back in. Block comments were stripped, which is why `/* … */` behaved and `// …` did not. Comment edits stayed silent only by landing in a different shape bucket — an accident that ran out the moment pairing learned to look across buckets.
- **The Boundary Warning Reached Nobody (`src/security.mjs`)**: `UNREADABLE` was computed and then wired into `assertTestIntegrity`, which the gate does not call. The gate calls `scanDiff`. An operator whose repository used an unlisted assertion library was shown an unblemished pass while the guard had already concluded it could not read a single assertion. It now reports `TEST_DIALECT_UNREADABLE` on the path the gate actually uses — without blocking, because an unlisted library is not the user's fault.
- **Absence Of Evidence Is Reported As Absence (`src/ops/test-collection.mjs`, `src/engine.mjs`)**: the collection floor stays deliberately one-sided — failing on "I could not tell" would break every runner not on the list — but passing silently made `echo "all tests passed"` indistinguishable from a real suite. The verify phase now prints what it could not establish.
- **The Checkpoint Test Left 239 MB Behind Per Run (`test/checkpoint.test.mjs`)**: the checkpoint store lives inside the tree it snapshots, so without the ignore rule `init` writes, checkpoint N captures checkpoints 1..N-1 and each is roughly three times the last — 12 KB at the fifth, 157 MB at the fifteenth, 18 GB accumulated across runs, and a full disk. A real repository has that line; the fixture did not.

### Changed
- **Evidence Before Rules In The Learning Ledger (`src/memory.mjs`)**: everything here is prepended to every dispatch prompt, so it decides what the agent is told is true. `harvestFailure` wrote one hardcoded sentence into `solution` on every call and `hydratePrompt` rendered it as `WHEN X → THEN <sentence>` — a record of *failing* to solve something, shipped as instructions for solving it. Its trigger carried 120 characters of raw log line, so exact-string dedup never matched twice: measured at five entries, five injected rows and five fabricated solutions for one recurring `ECONNREFUSED`. Triggers now normalize to a signature, recurrences update in place with a count, and the ledger is bounded. Harvested failures record no solution, because there is none; once one has recurred three times it reaches the prompt in its own block, stated as a count in the past tense. Learnings a person recorded deliberately are confirmed on sight — choosing to write something down is evidence of a different kind. Two mechanisms here already had this discipline: `flaky-ledger` wants repeated runs before calling a test flaky, `remediation` is fingerprint-keyed and short-lived. This was the one learning path that skipped both.

### Credit
The first three come from the cold-start trial's severity-1 findings. Two of them were defects in the mechanism built one release earlier to prevent exactly this class, which is the argument for having somebody else measure.

## [0.65.0] - 2026-09-04
*A gate that refuses its own installation is not strict, it is broken.*

Four failures from a cold-start trial on four public repositories nobody here chose. Every one of them meets a user before they have done anything, and every one was invisible to a suite measured in a repository that was already set up correctly by someone who knew how the tool worked.

### Fixed
- **The Quickstart Rejected Its Own Output (`src/engine.mjs`, `bin/agentctl.mjs`)**: `init` writes `.agent/**` and then tells the user to commit it. Doing exactly that produced `Exit 3` with five scope violations on the first gate run, because the base branch does not have that commit yet and every scaffolded path matches `BUILTIN_PROTECT` or `BUILTIN_DENY`. The hint printed alongside it advised `--allow-protected` — so a newcomer's first lesson was how to switch the scope guard off. The gate now accepts that scaffold, and *says* it accepted it, under conditions narrow enough that nothing is weakened: the base commit must have no gate config at all — in which case `trustedScope` is already built-ins only and nothing in the added files is trusted — and every violating path must be scaffold the base does not have. A repository already under the gate keeps the full rule, verified: editing `.agent/config.yml` is still `Exit 3`, adding a rules file is still `Exit 3`, and one `.github/workflows/ci.yml` in the diff withdraws the exemption from all of it.
- **A Phrase Outranked A Stated Count (`src/ops/test-collection.mjs`)**: `EXPLICIT_ZERO` was consulted before any positive count, so any output containing the words "no tests found" was read as empty — including a healthy TAP suite of 190 passing tests whose one skipped fixture printed `# SKIP no tests found`. The gate rejected it as an empty suite and named Jest as the runner, in a repository that does not use Jest. A phrase appears anywhere in a stream; a count is stated deliberately. The count is asked first now. Go's `^ok\s` witness was equally undiscriminating — `ok 1 - performance` is TAP and `ok  example.com/lib` is Go — so it now requires the package-shaped form.
- **`init` Saved A Command It Had Just Watched Fail (`src/wizard-init.mjs`, `src/stack-detector.mjs`)**: the probe ran, printed `Oracle verification probe failed (Exit 2)`, and the wizard wrote the broken command into the config anyway — in a repository where `pytest` was on PATH and all 360 tests passed in 1.3s. Worse, on the `--yes` path the probe did not run at all, because it lived inside the interactive branch: the user who is not watching, and therefore cannot notice, was the only one who got no check. The probe now runs on both paths, and `oracleCandidates` offers the ecosystem's other conventions when the first one does not run. When nothing runs, it says so in terms the operator can act on instead of leaving a failed spinner to scroll past.
- **The Remediation Hint Named A Lever Connected To Nothing (`src/engine.mjs`)**: the empty-suite failure tells the operator to "lower the floor with `verify.minTests`". `trustedVerify` copied thirteen fields and not that one, so the setting was silently dropped and the floor stayed at 1 no matter what the config said.

### Changed
- **The Quickstart Describes What `init` Does (`README.md`)**: it promised "zero configuration required" and then asked seven questions. `--yes` answers them, and is now what the quickstart shows.

### Credit
Found by a cold-start trial conducted as an unprimed stranger — install from the registry, `init` on four foreign stacks, then try to make the tool lie. Eleven of its twelve findings reproduced against the shipped code; two were worse than reported. The four here are the ones a user meets first. The rest — the silent-negative family, skip dialects, cross-file test moves, packaging — follow.

## [0.64.0] - 2026-09-04
*A guard that cannot read your dialect must say so, not pass.*

### Fixed
- **The Package We Published Was Not The Tree We Tested (`package.json`, `src/guard-policy.mjs`)**: `scripts/guard-reach-check.mjs` shipped in the tarball while the policy contract it imports did not, because `files` lists `scripts/` and not `test/`. Unpacked and run, it threw `ERR_MODULE_NOT_FOUND`. The check whose entire purpose is to prove that no guard has silently gone missing was itself silently missing — and every signal that should have caught it (1015 tests, a nine-way matrix, a blocking release) was measured in the source tree, where the file exists by construction. The contract now lives in `src/`, where it is part of the product it describes.
- **The Tamper Guard Was Silent For Five Ecosystems (`src/security.mjs`)**: `assertEqual` was recognised only because the pattern's optional dot and case-insensitive flag happened to line up. `assertEquals` — one letter longer — fell out of it, and took JUnit, PHPUnit, Minitest, RSpec (`.to eq(`, not `.toBe(`) and XCTest with it. All five returned `PASS` on a diff that rewrote an expected value. Skip injection was equally blind: `@Disabled`, `@Ignore`, `markTestSkipped`, `XCTSkip` and RSpec's `xit` all passed.
- **pytest's Ordinary Assertion Stated No Expectation (`src/security.mjs`)**: `assert add(1, 2) == 3` is how pytest is actually written, and it named no comparison function, so a list of function names could never reach it. Rust's `assert!(a == b)` and Elixir's `assert f(x) == 3` were missed for the same reason. Inequality is deliberately excluded: `assert!(x != 0)` names no expected value, and counting it as one would hide the downgrade from `assert_eq!(x, 5)`.
- **A Comment Was Read As A Line Continuation (`src/security.mjs`)**: `//` begins with a division sign and `--` with a minus, so both matched the operator-continuation test and folded the comment line into the statement above it. The cost was a false accusation on a virtuous act — *adding* an assertion next to a `// …` line made the new assertion absorb the comment, stop matching its unchanged twin, and get reported as a rewritten expectation. Python was immune because `#` is not an operator, which is exactly why every fixture this project was written from passed.
- **A Message Written Outside The Call Read As A Rewritten Value (`src/security.mjs`)**: RSpec puts it there — `expect(x).to eq(3), "explain"` — where an argument-position check cannot see it. `splitAssertionArgs` also began its walk one character early whenever the matched pattern ended on a bare name rather than an opening paren, so every argument boundary after it was wrong.

### Added
- **Package Integrity (`scripts/package-integrity-check.mjs`, blocking in CI and in `npm run release`)**: asks the packer what it would ship, then resolves the import graph *inside that answer*. Its first version reported "every relative import resolves" on the broken package, because its matcher was bounded by `[^;\n]*?` and the missing import spanned several lines — the same failure the tool exists to prevent, committed by the tool's own integrity check. It now carries hand-written extraction cases, masks strings and comments so a picture of an import is not read as one, and handles the regex literal holding a quote (`/["']/`) that desynchronised the mask in the very file most full of them. Verified by reintroducing the original defect: it named the file, the specifier and the missing path, and exited 1.
- **`UNREADABLE`: The State That Must Not Be Silent (`src/security.mjs`)**: coverage will always end somewhere; what must never happen again is that the edge looks like approval. When assertion-shaped lines are present and none of them parse, the guard says so — in the return value and in the diagnostics an operator reads. It does not block: an unlisted assertion library is the user's normal, not their fault.
- **A Denominator The Rules Actually Consume (`src/security.mjs`)**: counting *files* was not enough. A JUnit diff produced `inputsSeen: 1` and a clean `PASS` while not one assertion in it had been recognised — the previous release's ambiguity surviving one level down, inside the mechanism built to remove it. `inputsSeen` now counts lines examined and `assertionsSeen` counts assertions understood, and the reach check fails when an assertion rule reports a finding having parsed none.
- **Contracts For The Opposite Failures (`src/guard-policy.mjs`)**: `INNOCENT_EDITS` — ten ordinary edits that must produce no finding, because a guard that answers "yes" to everything has no more discrimination than one that answers "no", and is worse in practice: the operator learns to pass the override without reading it. `UNREADABLE_DIALECTS` — dialects the guard genuinely cannot parse and must report. `IMPORT_EXTRACTION_CASES` — the import forms the package check must be able to see.

### Changed
- **Canaries Carry Their Language (`src/guard-policy.mjs`)**: each fixture now supplies its own comment syntax. A `//` line in a `.py` fixture is not a comment, and a fixture that lies about the language under test measures the fixture rather than the guard — which is how two false results were briefly read as two defects during this work.
- **Test-Language Coverage (`src/security.mjs`)**: `.java`, `.kt`, `.scala`, `.groovy`, `.swift`, `.cs`, `.php`, `.c`, `.cpp`, `.m`, `.sol` and `.rb` are now named explicitly rather than falling through to the JavaScript scanner by default, which is how a `#` comment came to be read as code.

## [0.63.0] - 2026-09-04
*A defect that turns a check off cannot be found by the check it turns off.*

### Added
- **Activation Coverage (`scripts/guard-reach-check.mjs`, blocking in CI and in `npm run release`)**: the question no existing mechanism could ask — *can every blocking guard still be made red?* When `isTestFile` matched the substring `/test/` and went silent for the standard pytest, Rust and RSpec layouts, five independent safety mechanisms all reported green while working exactly as designed. The unit suite sampled the same distribution the implementation was written from, so its fixtures re-confirmed the dialect it already knew. The doc-sync gate compares counts and versions, and a guard that guards nothing still contributes passing tests. The nine-way CI matrix varies OS and Node version — dimensions orthogonal to the defect; nine runs of `test/foo.test.js` never explore `tests/test_calc.py`. Cold review reads code against its stated intent, and there the code and the intent agreed: the eye supplies the leading slash. And the release gate is a conjunction over those four, where a signal that silently goes absent contributes `true`.

  Three steps, all in-process, 88 ms total. **Policy**: a hand-written witness table must hold. **Canaries**: eleven known-bad diffs across Node, pytest, Rust, Go and a monorepo must each still produce the finding they name — a canary that comes back clean is not a pass, it is proof that the rule stopped being reachable. **Mutants**: four hand-written mutants of the applicability predicate must each break at least one canary; a survivor means no canary ever required the guard to *activate*, so the suite would stay green if it silently stopped looking. Verified by reintroducing the original substring bug: the check named the exact paths and the exact canary that went silent, and exited 1.

- **A Policy Contract Independent Of Its Implementation (`src/guard-policy.mjs`)**: every witness is derived from what the tool advertises — the stacks `detectStack` declares, the layouts each ecosystem actually uses — and never from the regexes, path lists or registries that implement the checks. A contract generated from the implementation makes the implementation its own oracle, and an implementation that is its own oracle cannot be wrong. Adding a stack is not finished until it has a row here.

### Changed
- **`checkTestTampering` Reports What It Examined (`src/security.mjs`)**: `inputsSeen` plus a `PASS` / `FAIL` / `NOT_APPLICABLE` status. `ok: true` from a guard that looked at nothing was byte-identical to `ok: true` from a guard that looked at everything and approved it; that ambiguity is the defect class, and a verdict without a denominator is not a verdict. `NOT_APPLICABLE` is still not a failure — it is just no longer indistinguishable from a pass. The applicability predicate is injectable so the meta-check can blind it.

### Credit
Both independent analyses of how the classifier defect survived converged on this mechanism — canaries plus activation coverage, and the rule that a guard must report what it examined rather than only what it found. Neither had seen the other's work.

## [0.62.0] - 2026-09-04
*A guard that reports "pass" without saying what it examined is reporting the wrong thing.*

### Fixed
- **A File's Existence Was Taken As A Claim About Its Contents (`src/stack-detector.mjs`)**: a `Makefile` in the root produced `make test` whether or not it declared a `test` target — measured on a repository whose `package.json` declared a perfectly good `vitest run`, where `make test` exits 2 with "No rule to make target". A hard red on day one is how a user learns the gate is broken and turns it off. `app.json` likewise claimed a Node stack for a Rust repository with no `package.json` in it. Both now have to earn the claim.
- **A Placeholder Test Script Counted As An Oracle (`src/stack-detector.mjs`)**: `bootstrapZeroTestRepo` asked whether `scripts.test` was set, never what was in it, so `"test": "echo 'no tests yet' && exit 0"` — the single most dangerous input the gate can receive — was reported as `EXISTING_VERIFICATION_ORACLE`. `isPlaceholderTestScript` now reads the command. npm's own default (`… && exit 1`) is correctly not a placeholder: it fails loudly rather than certifying nothing.
- **The Generated Fallback Oracle Could Not Fail (`src/stack-detector.mjs`)**: for a JS repo with no tests, `bootstrap` wrote a suite asserting `fs.existsSync(process.cwd())` and that the directory is non-empty. Both hold for every repository and every change — and worse, running it *silenced* the `missingOracle` guard, which fires only when no command ran at all. A repository that honestly had no oracle was converted into one that claimed to have one. It now checks that every source file parses, and refuses to pass with nothing to check.
- **Lockfiles Decide Which Code Runs, And Were Unprotected (`src/config.mjs`)**: `package.json` was protected and `package-lock.json` was not, so a changed `resolved` URL or integrity hash — swapping the code that actually gets installed — passed the scope phase untouched. The entropy scanner skips lockfiles by design, so it was invisible twice over; `BUILTIN_RESTRICTED` in risk.mjs already knew they mattered, but only the risk tier consumed it. Added with toolchain pins (`.nvmrc`, `rust-toolchain*`, gradle-wrapper), `CODEOWNERS`, `.pre-commit-config.yaml`, and to the deny tier: `.envrc` (direnv runs it on `cd`), `.git-credentials`, `.aws/`, `.kube/`, `.docker/config.json` and AWS CodeBuild.
- **The Sixth Spelling Of "Where Are The Tests" (`src/evidence.mjs`)**: v0.59.0 unified five test-path predicates behind `isTestPath` and missed this one, because it is a list of *root-level directory names* rather than a predicate. Go puts its tests beside the code and every monorepo puts them under `packages/*/test/`, so the walk found nothing, `fileCount` was 0, and `strictTestLock` — which requires `fileCount > 0` — switched itself off without saying so. The tree hash then became the SHA-256 of the empty string and the evidence manifest attested to it.
- **Seven Runners The Collection Floor Did Not Know (`src/ops/test-collection.mjs`)**: Maven/Surefire, Gradle `NO-SOURCE`, PHPUnit, RSpec, `dotnet test`, XCTest and ctest all report zero collected tests in a spelling v0.61.0 could not read, so the floor passed them.
- **100% Of Nothing Is Not 100% (`src/coverage.mjs`)**: the denominator counts only added lines V8 mapped, and V8 maps nothing outside Node — so a Python diff adding three executable lines measured zero of them and was reported as `score: 100`, the best possible number, from a measurement that never happened. `mutation.mjs` had the identical bug and was fixed in v0.57.0; this was the same shape one module over. Diff coverage now reports `scored: false` with a reason.

### Added
- **The Evidence Manifest Records What Was Counted**: a `verification` block with `testsCollected`, `counted` and `runner`, covered by the manifest digest. The collection floor deliberately lets an unstated count pass — failing on "I could not tell" would break every runner not on the list — and a manifest that omits that reads as though a suite ran. A quiet runner (`cargo test --quiet`, `pytest -q`) suppresses the very line the floor reads, and `counted: false` is the honest shape for that run.

### Credit
Two independent analyses of the same question — one from an external agent, one run here — converged on the same four findings about `init` without seeing each other's work, which is stronger evidence than either alone. Each finding was reproduced against the shipped code before it was changed. Two further findings arrived from a separate analysis of how the classifier defect in v0.59.0 survived five independent safety mechanisms; both named the class, and both proposed the same remedy: a guard must report what it examined, never only what it found.

## [0.61.0] - 2026-09-04
*A command that ran is not a command that tested something.*

### Fixed
- **A Runner That Collected Nothing Counted As Verification (`src/ops/test-collection.mjs`, `src/engine.mjs`)**: the gate's oracle is one number — the verification command's exit code — and that number cannot tell "every test passed" from "there were no tests". Several runners report the second as success by design: `go test ./...` prints `[no test files]` and exits 0, jest has `--passWithNoTests`, and `npm test --workspaces` is green when the one package the diff touched has no suite. So a change could invert a function, add an untested one, and collect five green phases, verified against nothing at all. The v0.57.0 `missingOracle` check catches "no stage executed"; it cannot catch "a stage executed and tested nothing". The collected count is now read out of the runner's own summary (node:test, pytest, cargo, jest, vitest, mocha, go) and a stated zero fails the verify phase as `empty-suite`.

  The parsing is one-sided on purpose. A count is only used when a recognised runner stated one; anything else yields no count and passes, because failing on "I could not tell" would break every runner not on the list. Two cases that cost a false rejection were found while building it and are covered by tests: a Go monorepo where only some packages have tests is healthy, not empty, and `go test` without `-v` prints no per-test lines at all — reading their absence as zero would have failed every ordinary Go run in existence. `verify.minTests` sets the floor (default 1, `0` opts out); `verify.required: false` remains the switch for a repository that genuinely has no oracle.

### Credit
Identified in an independent analysis of the oracle problem, which named the collection floor and cross-revision discrimination as the two gaps that are still *checks* rather than proxies for effort. The floor is shipped here. Discrimination — running the new tests against the base revision, and failing when they pass on both — is not, and is under consideration: its own author estimates a 10–25% false-positive rate on behaviour-preserving refactors, which is above the rate at which an operator starts reaching for the override by reflex.

## [0.60.0] - 2026-09-03
*Making the expectation guard worth reading a month from now.*

### Fixed
- **One Override For Six Checks (`src/security.mjs`, `bin/agentctl.mjs`)**: `--allow-test-modifications` returned early from `checkTestTampering`, so the only way to accept a legitimately changed expectation was to also switch off injected `.skip()`, `expect(true).toBe(true)`, commented-out assertions, outright deletions and weakened assertions — none of which the operator had looked at. That makes the check with the highest firing rate the ceiling for every other check in the bundle: the more useful the expectation check became, the more often it would be used to turn the others off. `--allow-test-change <kind>` now accepts exactly one (`expectation`, `removal`, `weakening`, `skip`, `vacuous`, `commented`, or `all`), takes a list, rejects a name it does not recognise rather than guessing, and the violation message names the narrow flag instead of the blunt one. `--allow-test-modifications` still means all six.
- **Reordering Two Assertions Reported Two Rewrites (`src/security.mjs`)**: swapping two assertions removes both and adds both back unchanged, but positional alignment matched the first removed against the first added — a *different* assertion of the same shape — and reported a rewritten expectation for each. Same for an assertion that merely moved within its block. Candidates that are byte-identical on both sides now cancel before anything is aligned; only the residue can have been rewritten. An edit that both reorders and rewrites still reports the rewrite.
- **Rewording A Failure Message Reported A Rewritten Expectation (`src/security.mjs`)**: a message is a string literal, so blanking literals made `assert.equal(f(1), 1, "should be one")` and `assert.equal(f(1), 1, "must be one")` the same shape, and improving the wording of a failure fired a CRITICAL finding. Assertion arguments are now compared position by position, and a difference confined to a message position is not an expectation change — trailing for `assert.equal(got, want, "…")` and `assert_eq!(a, b, "…")`, leading for Go's `t.Errorf("got %d want %d", …)`. Two arguments stays the classic `(actual, expected)` shape, so `assert.equal(name(), "Alice")` → `"Bob"` still fires, as does a Go table's `want` value when only the format string was left alone.

## [0.59.0] - 2026-09-03
*The bypass I found in my own new check, closed by someone else — and the larger hole they noticed while closing it.*

### Fixed
- **Five Modules Disagreed On What A Test File Is (`src/test-paths.mjs`, and five callers)**: `security.mjs` matched the substring `/test/`, which has no match in `tests/test_calc.py` — so the standard pytest layout, the standard Rust integration layout (`tests/*.rs`) and every RSpec suite (`spec/`) were not test files, and *the entire tamper guard was switched off for them*: skip injection, vacuous assertions, commented-out assertions, removal, weakening, expectation rewrites, all silent. `mutation.mjs` had the same substring bug pointed the other way and mutated operators inside those tests, scoring the result. `engine.mjs` never looked for `_test.`, so `strictTestLock` did not consider a Go test file to be a test file. `coverage.mjs` and `evidence.mjs` each had a fourth and fifth spelling. A predicate carrying this much weight cannot have five definitions; `isTestPath` is now the only one, matching whole path segments rather than substrings (so `latest/` is not `test/`) and covering pytest's `test_*.py`, Go's `_test.go`, RSpec's `_spec.rb` and Foundry's `.t.sol`.
- **An Assertion Wrapped Across Lines Escaped The Expectation Guard (`src/security.mjs`)**: the pairing added in v0.58.0 ran on physical lines, so the value moving to a line of its own — which is what every formatter does the day a line runs long — meant neither side carried the assertion keyword and no pair was ever formed. Pairing now runs on statements reassembled from the diff's two images, using a per-language scanner that tracks string, comment and delimiter state across lines (Python triple-quotes, Go and Rust raw strings, JS template literals and regex literals, Rust's nested block comments). Verified closed for JavaScript, Python, Go and Rust; a realistic diff that only re-indents, reorders or reformats still passes silently.
- **Hex, Octal, Binary And Exponent Literals Were Invisible (`src/security.mjs`)**: literal normalisation required a decimal digit run, so `0xFF` never became a placeholder, the two shapes never matched, and `assert.equal(flags, 0xFF)` → `0xFE` was not a rewritten expectation. In a file full of bit flags that was every value change.

### Credit
The statement-level pairing, the per-language scanners and the numeric-literal fix arrived as [PR #14](https://github.com/FullThrottle83/jules-orchestrator-kit/pull/14) from an external coding agent, in response to the multi-line bypass being published as an open problem. Verified independently — reproduced against the shipped CLI, re-run on this machine, probed for false positives on realistic diffs — before merging. The test-path classifier is the hole that PR noticed and deliberately left alone as out of scope; it turned out to be the larger of the two.

## [0.58.0] - 2026-09-03
*A second cold review, from a reviewer who had never seen the project. Seven findings, all reproduced against the shipped CLI before anything was changed — and two more that only surfaced while fixing them.*

### Fixed
- **A Lock Taken From The CLI Locked Nothing (`src/state.mjs`, `bin/agentctl.mjs`)**: `acquireLock` stored `process.pid` and tested it for liveness on the next call — but `agentctl lock acquire` writes the record and exits *by design*, so that test always answered "dead". The next acquire reaped the lock as abandoned and granted the same files to a second agent, telling both they had exclusive access. Two agents editing one file while the mutex reported success is worse than no mutex at all. A record written by a one-shot caller now marks itself `leased` and is bounded by `expiresAt` alone; `--ttl <minutes>` sets the window and `--pid <n>` binds the lock to a real long-lived process when there is one. In-process callers (the engine, the swarm) keep pid liveness, so a crash still cannot wedge the repository.
- **Any URL On The Line Switched Off The Secret Scanner (`src/security.mjs`)**: `hasHighEntropyToken` skipped an entire line containing `://`. So a bare 32-character key was caught, and the identical key was approved the moment a comment with a link sat beside it — a fetch call and its endpoint on one line is ordinary code, and no attacker sophistication is required to stumble into it. URLs, `data:` URIs and subresource-integrity digests are now stripped from the line instead of ending it, and the two halves of a URL that genuinely carry credentials — userinfo and query values — are scanned on their own. That closes the bypass *and* catches `?api_key=…` and `//user:password@host`, neither of which the old code could ever see.
- **An Untracked Symlink Escaped Scope Entirely (`src/git.mjs`)**: `symlinkChanges` read only `git diff --raw`, which has nothing to say about a file git has never seen. In working-tree mode — the default for `agentctl check` — `ln -s /etc/os-release leak.txt` therefore reached `checkScope` as the plain name `leak.txt` and was approved; committing the identical link was correctly rejected. Worse, the synthetic diff read *through* the link, so the target's contents were pulled into the diff and shipped to the provider as ordinary added lines. Untracked links are now resolved and judged, and a symlink is rendered as its target path the way git renders one.
- **Rewriting What A Test Expects Was Invisible (`src/security.mjs`, `bin/agentctl.mjs`, `src/engine.mjs`)**: `assert.equal(add(1,2), 3)` becoming `assert.equal(add(1,2), -1)` removes one specific assertion and adds one, so every count stayed level and the tamper guard said nothing — while the suite went from checking that addition works to certifying that it is broken. It is the cheapest way to make a red suite green and the one this tool exists to refuse. Two assertion lines that are identical once their literals are blanked, and different before, are now reported as `ASSERTION_EXPECTATION_CHANGED`. It cannot tell an attack from a deliberate change of spec — nothing can, from a diff — so it reports rather than decides, and `--allow-test-modifications` is the answer when the new expectation is the correct one. **That flag is new to the CLI:** the override existed in the engine and was reachable only from JavaScript, so every finding the tamper guard raised was previously an outage with no documented way past it.
- **A Standard Python Project Was Rejected On First Contact (`src/stack-detector.mjs`)**: the default test command was the bare console script `pytest`, which does not put the working directory on `sys.path`. The most ordinary layout there is — a module at the root, its test under `tests/` importing it — failed at collection with `ModuleNotFoundError`, and the gate reported exit 4 on a suite that passes perfectly when the developer types `python3 -m pytest`. A first-run rejection of correct code is the most expensive failure this tool can produce: it teaches the user the gate is wrong. Python now runs as a module, under whichever interpreter name the machine actually has (`python3`, `python`, `py`) — which also fixes every hardcoded `python3` on Windows, where that name does not exist.
- **The Scope Guard Was Only Safe On GitHub (`src/config.mjs`)**: `BUILTIN_DENY` listed `.github/**` and no other forge, so an identical exfiltration job placed in `.gitlab-ci.yml` was approved where `.github/workflows/x.yml` was rejected. GitLab, CircleCI, Jenkins, Azure Pipelines, Travis, Drone, Bitbucket, Buildkite, Woodpecker, AppVeyor, TeamCity and `.githooks/**` now share that tier. Build definitions that execute code at install or build time (`setup.py`, `build.rs`, `pom.xml`, `build.gradle`, `CMakeLists.txt`, `Gemfile`, `Dockerfile`) join `package.json` under `protect`, and so does **test-runner configuration** (`conftest.py`, `pytest.ini`, `tox.ini`, `jest.config.*`, `vitest.config.*`, `.mocharc.*`, `karma.conf.*`, `phpunit.xml`, `.nycrc*`) — rewriting *that* is the cheapest way to make a suite green without touching a single assertion, and the tamper guard reads test files, so none of it was visible to anything.
- **"Cryptographic Signature" Was A Bare Digest (`bin/agentctl.mjs`, `src/evidence.mjs`, `README.md`)**: there is no key anywhere in the system. The value is a SHA-256 of the manifest, so anyone who can write the file can recompute it and have `evidence verify` agree. It proves the manifest has not been edited *since* it was written — tamper evidence, not authorship. It is now printed and documented as a digest.

### Fixed — found while fixing the above
- **Every Python Project Failed As "Tampered" (`src/evidence.mjs`)**: with `pytest` finally running, the next gate failed on test-integrity. pytest writes `tests/__pycache__/*.pyc` on collection, the post-run hash no longer matched the pre-run hash, and the runner accused itself of rewriting the suite mid-flight. A false accusation of tampering is worse than a missed one — it teaches the operator to pass `--allow-test-modifications` by reflex. Caches and compiled output are now excluded from both integrity hashes.
- **A Signed Literal Broke Its Own Detector (`src/security.mjs`)**: the first cut of the expectation-rewrite check normalised `3` and `-1` to different shapes, because `\b` finds no boundary before a leading minus. The pair never matched and the attack it was written for still passed. The sign belongs to the literal.

## [0.57.0] - 2026-09-03
*The last four review findings — and two more that only surfaced once the fourth stopped lying.*

### Fixed
- **Generated TDD Oracles Were Always JavaScript (`src/ops/tdd-generator.mjs`)**: `test-gen` emitted a `node:test` file for every stack and then, in a Python project, ran `pytest generated-x.test.mjs`. pytest exits 4 on a file it cannot collect, and the cycle read any non-zero exit as RED — so it reported a verified failing oracle, and locked an uncollectable file into `scope.deny`, having proven nothing. Oracles are now written in the runner's language (pytest for Python/Django, a `tests/*.rs` integration test for Cargo, `*_test.go` for Go, `node:test` otherwise), and the RED check requires the generated assertion's marker in the output — a runner that never collected the file cannot pass as a falsifiable failure.
- **`queue --dag` Could Not See JSON Envelopes (`src/dag-engine.mjs`, `bin/agentctl.mjs`)**: the DAG runner accepts `.json` and `.task` envelopes as well as Markdown and does its own discovery, but the CLI gated whether it ran at all on the Markdown-only filter. A queue holding only JSON envelopes reported "0 queued task(s)" and did nothing. `isDagTaskFile` is now exported and used for the count when `--dag` is passed.
- **`swarm` Accepted No Flags (`bin/agentctl.mjs`, `src/ops/command-registry.mjs`)**: the case had no `parseArgs` at all, so `--json` and `--dry-run` were documented, accepted by the shell and silently discarded — a rehearsal dispatched for real. The registry also described it as an inspector (`mutates: false`, `risk: low`) and advertised an `--interactive` dashboard that does not exist, while the handler dispatches every queued task in parallel and spends budget.
- **"100% Of Nothing" Was Reported As A Perfect Score (`src/mutation.mjs`, `src/assertions.mjs`, `bin/agentctl.mjs`)**: a diff with no mutable operators produced zero mutants and a hardcoded `mutationScore: 100`, telling operators their untested code had scored perfectly — the exact false confidence the harness exists to remove. There is no score to report, so there is none: `mutationScore` is `null`, `scored` is `false`, and `reason` says why. `ok` stays true, because nothing failed to be falsified and a gate that blocks every import-only diff gets switched off.

### Fixed — found because the above stopped lying
- **Untracked Files Were Invisible To Mutation And Coverage (`src/git.mjs`)**: `diffText` synthesises a diff for untracked files, and it emitted no `@@` hunk header. Both the mutation harness and the V8 diff-coverage mapper walk hunks to place an added line, so both silently reported nothing to do for a brand-new file — precisely where untested code arrives. The secret scanner never noticed, because it only reads `+` lines. A valid header is now emitted. This was hidden behind the vacuous 100 above: `test/mutation.test.mjs` asserted `typeof mutationScore === "number"` and passed on the defect it should have caught.
- **`--min-score 0` Enforced 80 (`bin/agentctl.mjs`)**: `Number(x) || 80` swallows a legitimate zero, so the documented way to run the harness for its report without a threshold quietly applied the default instead.

## [0.56.0] - 2026-09-03
*Three advertised features that were never wired into the execution path, plus two bugs only a live provider call could surface.*

### Fixed
- **Locks Did Not Lock Files (`src/state.mjs`)**: the lock file was named after the task, so `acquireLock()` only ever asked "is this same task already running?". The `files` argument — the entire point of the call — was stored as metadata and compared against nothing, so two agents could each be told they held exclusive access to the same path. Requested paths are now checked against every live lock, separators normalised first, and a conflict names the holder and the overlapping files.
- **`agentctl rollback` Had Nothing To Restore (`src/engine.mjs`, `src/session-ops.mjs`)**: `createCheckpoint()` shipped, was documented, and was called from nowhere — the checkpoint directory was always empty and the command answered "No checkpoints found" to everyone who reached for it, at exactly the moment they needed it. A snapshot is now taken before a dispatch can touch the working tree and before `patch --apply` writes into it. Never fatal: a repository that cannot be snapshotted still dispatches, with a warning that rollback will not cover it. Rehearsals (`--dry-run`) snapshot nothing.
- **Monorepo Boundary Resolver Was Dead Code (`src/engine.mjs`, `src/config.mjs`, `src/wizard-init.mjs`)**: `resolveWorkspaceBoundary()` was drawn in the architecture diagrams and documented as a headline feature, and `gate()` called it never — so a one-package change ran every other package's suite. Now reachable through `verify.scope: affected`, which resolves changed files to their sub-projects and runs those commands. Opt-in on purpose: silently narrowing what runs is the same class of defect as approving a change that ran nothing, and an existing repository's gate must not change meaning on an upgrade. `agentctl init` writes `affected` for a repository it detects as a monorepo, and the scope widens back to the root command whenever the change reaches a shared file.
- **`listSources()` Could Never Succeed (`src/provider.mjs`)**: it reuses `getSession()` as an authenticated GET and passes `customUrl` with no session id, but the id guard fired before the url was consulted — so listing a repository's connected sources threw a `TypeError` against the live API on every call. Found by making a real request; no dry run or unit test can reach it, because both stop before the request is built.
- **Node Test Context Leaked Into Verification (`src/engine.mjs`)**: `NODE_TEST_CONTEXT` and `NODE_CHANNEL_FD` were inherited by the verification command, so a `node --test` suite run by a gate that was itself running under `node --test` switched to child-reporter mode and stopped propagating failures — the gate saw exit 0 and approved a change whose tests had failed. `src/perf.mjs` already stripped these; the gate, which is the one that decides, did not.
- **An Interrupted Test Run Orphaned Its Whole Tree (`scripts/run-tests.mjs`)**: `spawnSync` signals only the direct child, and this suite's children spawn children of their own — a verification command, an `npm` that fans out to a node per workspace, a git subprocess per fixture. Interrupting a run therefore detached everything below the first level, and those orphans kept running *and kept spawning*: several interrupted runs accumulated enough of them to exhaust 32 GB of RAM and 24 GB of swap on a developer machine, and two CI runners logged pages of "Terminate orphan process" at the end of a job that had already failed. The runner now leads its own process group and reaps the entire group on exit and on SIGINT/SIGTERM/SIGHUP — `taskkill /T` on Windows, which has no process groups. Verified by killing a run mid-flight: zero survivors.
- **Test Suite Saturated Every Core (`scripts/run-tests.mjs`)**: Node runs one test file per core, and several suites spawn a verification command of their own — the monorepo fixtures fan out to one node per package — so the real peak was a multiple of the file count. On a many-core machine that pinned every core for the length of the run and made the throughput assertions fail for reasons unrelated to the code. Concurrency now defaults to half the cores, overridable with `JULES_TEST_CONCURRENCY`; two-core CI runners are already below this and are unaffected.
- **Test Fixture Wrote Into The Repository (`test/ooda_thrash.test.mjs`)**: the OODA thrash fixture built its temp tree under `.agent/` of the checkout being tested, leaving debris behind whenever a run was interrupted — in a consumer's repository that debris is theirs to clean up. Moved to the OS temp directory.

## [0.55.0] - 2026-09-03
*Verification integrity. Three more ways an agent's work could look checked without being checked, all reproduced before being fixed.*

### Security
- **Test Weakening By Replacement (`src/security.mjs`)**: `checkTestTampering` counted assertions — `removed.length > added` — so swapping `assert.strictEqual(add(2,3), 5)` for `assert.ok(add(2,3) !== undefined)` was one out and one in, the guard stayed silent, and the suite stopped checking the answer. Assertions that name an expected value are now counted separately across dialects (`strictEqual`/`toBe`/`assert_eq!`/`require.Equal`/`t.Errorf`), and a fall in that count is reported as `ASSERTION_WEAKENED`. Strengthening, renaming and adding are unaffected; an assertion deleted outright stays a single `ASSERTION_REMOVAL` rather than being reported twice.
- **Symlinks Walked Past Scope (`src/git.mjs`, `src/engine.mjs`)**: `checkScope` is lexical by design, so a link named `notes.md` pointing at `.agent/config.yml` was judged as `notes.md` and the protected path it reached was never considered. New `symlinkChanges()` reads each added link's target from the git object — resolved lexically against the link's own directory, never followed on disk — and the gate now judges both names, reporting the violation against the link the diff actually adds.
- **Evidence That Outlived What It Attested To (`src/evidence.mjs`)**: manifests hashed the test files and nothing else, so `evidence generate` followed by rewriting `src/` left verification reporting PASSED over an implementation nobody had checked. Manifests now carry `sourceIntegrity`, and `verifyEvidenceManifest` fails when the source tree has moved, naming both the manifest's commit and the current one. Separately, `computeDirectoryHash` only walked `test/`, `tests/`, `__tests__/`, `spec/` and `src/` — a suite living beside `package.json` was invisible to every hash the manifest recorded, which is why a rewritten root-level test file verified clean. Root-level source files are now included at depth one, restricted to source extensions so the hash cannot churn on the kit's own `EVIDENCE.md`.

### Changed
- **`parseRawDiff()` (`src/git.mjs`)**: the `git diff --raw -z` parsing behind binary sizing and symlink detection lives in one place rather than two.

## [0.54.1] - 2026-09-03
*Security hotfix. Three ways the gate could report APPROVED for work it had not checked, all found by a cold-start adversarial review and all reproduced before being fixed. The first two predate this series — the false green is present in 0.52.8.*

### Security
- **The Gate Approved Changes It Never Verified (`src/engine.mjs`, `src/config.mjs`)**: `testResult` started optimistic and the stage loop skipped any stage without a command, so a repository with no test oracle ran **zero** verification steps and was told `APPROVED (Exit 0)` — syntactically broken code included. The gate now fails closed (`Exit 4`, stage `oracle`) when no command executed against the change, naming `agentctl bootstrap` and `verify.test` as the fix. Assertions do not count as verification: `assert:test-integrity` proves a test was not weakened, not that the code works. A repository that deliberately uses only the scope and secret phases opts out with `verify.required: false`, read from the base commit like every other trusted field so an uncommitted edit cannot switch the gate off.
- **Credentials Hidden In Binary Files (`src/security.mjs`, `src/git.mjs`, `src/engine.mjs`)**: `git diff` renders a binary file as one 43-byte summary line, and every scanner downstream reads the diff *text* — so prefixing a file with a single NUL byte walked a live GitHub token through a green gate. New `binaryDiffEntries()` identifies those files and `scanBinaryPayloads()` inspects their contents directly, extracting printable runs the way `strings(1)` does. Only structured high-confidence patterns are applied, never entropy: a real PNG is high-entropy by nature, while `ghp_[A-Za-z0-9]{36}` inside one is not a coincidence. A file above the 8 MB scan ceiling is reported as `BINARY_PAYLOAD_UNSCANNED` rather than passed silently.
- **Payload Governor Bypassed By Binary Blobs (`src/git.mjs`)**: `diffBytes` measured the diff text, so a committed 500 KB binary weighed 250 bytes and the 75 KB ceiling could be walked past with a file of any size. It now adds the real size of every binary blob, taken from the object git recorded or from the working file when there is none, so both `committed` and `working-tree` modes get a true figure.

### Fixed
- **Wrong Remediation For A Missing Oracle (`bin/agentctl.mjs`)**: the exit-4 hint offered `--fix`, which cannot help when there was no command to run and no failure to repair.

## [0.54.0] - 2026-09-03
*First-run friction pass. Every item here was found by running a fresh dummy project through the whole chain; the engine was not the problem, the CLI's presentation layer was.*

### Fixed
- **Hardcoded `main` Base Branch (`src/git.mjs`, `src/wizard-init.mjs`, `bin/agentctl.mjs`)**: `init` scaffolded `base_branch: main` without ever asking git what the repository uses, so the very first `agentctl check` in any repo created on `master` (still the default of many installed gits) or standardised on `develop` failed to resolve its base ref. New `detectDefaultBranch()` resolves `origin/HEAD`, then a local `main`/`master`, then the checked-out branch (covering a repo with no commits yet), then `main`. `agentctl coverage` separately ignored `config.baseBranch` and assumed `main`; it now honours it.
- **Silent Phase Failures (`bin/agentctl.mjs`)**: A phase that failed with an `error` — `git_resolution` reports its cause in nothing else — printed a bare `Phase [GIT_RESOLUTION] : ❌ FAIL` with no explanation, forcing a re-run with `--json` to find out what the tool objected to. The error is now rendered, and exit 1 from that phase gets a remediation hint naming `git branch -a`, `--base` and `base_branch:`.
- **Test Output Discarded By The Spawn Wrapper (`src/ops/verify-output.mjs`)**: `printVerifyFailure` preferred stderr whenever it held anything, and the wrapper always writes `Command failed: npm test` there — so the entire node:test report on stdout, assertion text and stack included, was thrown away and the operator saw only the command they had just typed. Output selection is now in a testable `selectFailureOutput()`: stdout wins when stderr is wrapper noise, both are shown when each carries something real.
- **Test Tampering Reported As A Secret Leak (`bin/agentctl.mjs`)**: `TEST_TAMPERING_DETECTED`, `EDGE_RUNTIME_VIOLATION` and `CROSS_PACKAGE_BOUNDARY_VIOLATION` travel with the secret scanner under exit 6, so weakening an assertion told the user a credential had leaked and advised rotating exposed keys. The hint is now chosen from the finding types and says plainly that nothing needs rotating. The exit code is unchanged — it is part of the frozen contract.
- **Provider Auth Failures Masked As Exhausted Repairs (`bin/agentctl.mjs`)**: `gate --fix` reported "Automated self-repair could not pass tests cleanly" when the provider had rejected the dispatch and no repair was ever attempted, sending the operator to read agent output that did not exist — and `doctor` then found nothing wrong, because binary-on-PATH readiness cannot see an authentication failure. The hint now distinguishes the two and prints the provider's own error.
- **`--dry-run` Ignored By `task create` (`src/wizard-task.mjs`, `bin/agentctl.mjs`)**: The flag was parsed and never passed on, so a rehearsal queued real work. `runTaskCreateWizard` now honours `dryRun`, synthesizing and validating the envelope without writing it or creating the queue directory.
- **`mcp init <target>` Ignored Its Target (`bin/agentctl.mjs`, `src/ops/ide-scaffold.mjs`)**: `parseArgs` set `default: "all"` eagerly, so `values.target` was always truthy and the `|| args[2]` fallback was unreachable — `agentctl mcp init cursor`, the spelling `--help` advertises, scaffolded Cursor, VS Code *and* Claude Desktop. The default moved to the end of the resolution chain, and `--dry-run` now reaches `scaffoldIdeConfig`, which no longer creates directories on a rehearsal.
- **`task create` Re-asked For Answers It Was Given (`src/ops/cli-intent.mjs`, `bin/agentctl.mjs`)**: `agentctl task create --title X --prompt Y` states the whole task, but interactivity was concluded from the absence of `--yes`/`--non-interactive` rather than the presence of the answers — so it opened the wizard and asked for the title and prompt again in a terminal, and hung a CI job that had no terminal. New `resolveWizardInteractivity()` treats a fully specified invocation as headless; an explicit `--interactive` still wins.
- **`doctor --probe` Was Inert (`bin/agentctl.mjs`)**: The flag was advertised in the command registry, declared in no `parseArgs` call, and never reached `runDoctorChecks` as `activeProbe`.
- **Green Provider Row Read As "The Provider Works" (`src/provider-readiness.mjs`, `src/ops/doctor-registry.mjs`, `bin/agentctl.mjs`)**: `doctor` showed `✅ Provider Readiness` for a CLI that was merely on PATH, while the account behind it had no entitlement — and the renderer hid the summary for passing rows, so the caveat could not be read. The row now always prints what was checked and what was not, and `--probe` runs the CLI's own `--version` (new `probeProviderLiveness()`) to catch an installation that will not start. Entitlement still cannot be proven without a dispatch, and the summary says so.
- **Windows `.cmd` Shim Spawn (`src/provider-readiness.mjs`)**: `probeProviderLiveness` spawned the provider binary directly, which Node has refused for `.cmd`/`.bat` since the fix for CVE-2024-27980 — and a global npm install is exactly what puts `claude.cmd`/`gemini.cmd` on a Windows PATH, so every Windows CLI would have been reported as unable to run. Routed through the existing `resolveWindowsSpawn` helper that `runCmd` already uses. Caught by the cross-platform CI matrix, not by the local suite.
- **Doctor Advertised Flags It Does Not Implement (`src/ops/command-registry.mjs`)**: `--interactive`, `--fix` and `--yes` were listed for `doctor`; nothing applies remediation entries. Removed until an apply step exists, the same correction made to `queue`.
- **Onboarding Scope Trap Given Bypass Advice (`src/git.mjs`, `bin/agentctl.mjs`)**: The first `agentctl check` after `init` fails on exit 3, because the manifest and guardrails `init` just wrote are gate-protected and not yet committed — and the hint offered `--allow-protected`, teaching a first-time user to bypass the gate on their first run. New `partitionTracked()` distinguishes untracked scaffolding from an agent editing rules it is governed by; the first case now prints the `git add … && git commit` line that actually resolves it.
- **`queue --help` Described The Opposite Of What It Does (`src/ops/command-registry.mjs`)**: Documented as a passive browser with `mutates: false, risk: low` and flags `--interactive/--json/--limit`, while the handler dispatches every task to the provider and spends budget, taking `--dag`, `--concurrency` and `--dry-run`. The descriptor now matches the handler.

### Changed
- **Onboarding Asks Which Agent First (`src/wizard-init.mjs`)**: The wizard's opening question was "Which plan does your Jules account use?", asked of everyone — including people who came to drive Claude Code or Codex and were left guessing whether a Jules subscription was a prerequisite. It now asks which agent should run the tasks, asks the plan question only when that answer is `jules`, and asks for a verification profile.
- **`agentctl provider set <name>` (`src/config-edit.mjs`, `bin/agentctl.mjs`)**: `agentctl providers` pointed at `agentctl init --provider <name>` to switch, which restarts the entire onboarding wizard to change one line. `src/profiles-io.mjs` is now `src/config-edit.mjs` and carries both setters. Both setters remind the operator to commit the gate-protected manifest.
- **Honest Readiness Wording (`bin/agentctl.mjs`)**: `agentctl providers` now states that "ready" for a CLI provider means the binary is on PATH and does not prove the CLI is signed in.

## [0.53.0] - 2026-09-03
### Added
- **Provider Readiness Probe (`src/provider-readiness.mjs`, `agentctl providers`, `index.mjs`)**: Introduced per-provider capability descriptors so readiness is evaluated against the *selected* provider — a credential for the hosted `jules` adapter, a `PATH` binary for the `claude-code`, `codex` and `gemini-flash` exec adapters — plus `whichBinary()` (cross-platform, PATHEXT-aware, no subprocess), `probeProvider()`, `detectAvailableProviders()` and `suggestProvider()`.
- **Vendor-Neutral Environment Spellings (`src/env-aliases.mjs`, `bin/agentctl.mjs`, `.env.example`)**: Every `JULES_*` variable now also answers to an `AGENT_*` alias (`AGENT_API_KEY`, `AGENT_REPO`, `AGENT_SWARM_CONCURRENCY`, …), normalised once at CLI entry. An existing `JULES_*` value always wins, so an alias can never alter a working setup.
- **Verification Profiles (`src/profiles.mjs`, `src/profiles-io.mjs`, `src/config.mjs`, `agentctl profile`)**: `verify.profile: minimal | standard | max` expands at load time into a stack-aware stage pipeline — `max` adds mutation scoring, a 3-pass stability probe and, only on V8-coverage-capable runtimes, diff coverage. Unsupported gates are skipped with a stated reason instead of failing the diff. `agentctl profile --set` rewrites the key in place without disturbing comments.
- **Generated Stack-Aware CI (`src/ci-templates.mjs`, `agentctl ci init`)**: Emits a GitHub Actions or GitLab job carrying the detected stack's toolchain (`setup-python`, `setup-go`, `setup-java`, `setup-dotnet`, Bun/Deno) alongside Node for the CLI, targeting the repository's own base branch. Refuses to overwrite an existing workflow without `--force`.
- **`agentctl init --provider / --profile`**: Both selectable at onboarding; the wizard detects a provider the machine can actually reach when none is given.
### Fixed
- **Consumer Repository Pollution (`bin/init.js`)**: `init` no longer copies the kit's own twenty orchestration scripts into the target repository's `scripts/` directory, nor its nine-way Node CI matrix (`jules-audit.yml`) into repositories of any other stack. Both are replaced by the `agentctl` CLI and a generated workflow.
- **Divergent Init Entry Points (`bin/init.js`, `src/wizard-init.mjs`)**: `jules-init` wrote a thinner `.agent/jules.yml` while `agentctl init` wrote the `.agent/config.yml` the runtime reads, so which scaffolder was run decided whether a repository had a provider, tier or profile at all. Both now go through `planInit`.
- **Kit-Private Paths In Scaffolded Deny Lists (`src/wizard-init.mjs`)**: The scaffolded `forbidden_paths` named `**/lock-manager/**` and `scripts/jules-self-audit.mjs` — paths that exist only in this repository — and omitted `**/.env*` and `**/*.key`.
- **Committed Environment Templates Denied (`src/security.mjs`)**: The builtin `**/.env` and `**/.env.*` deny rules blocked `.env.example`, `.env.sample`, `.env.template`, `.env.dist` and their `.env.<env>.<suffix>` forms — the file nearly every repository commits to document its variables — so no agent in any project could be asked to document a new one. Exempted narrowly: only when a builtin pattern matched, never for a repository's own broader dot-env rule, and the diff secret scanner still fails a real credential pasted into a template on exit 6.
- **Provider-Blind Guidance (`src/ops/next-step.mjs`, `src/ops/doctor-registry.mjs`)**: The next-step advisor and `doctor` demanded `JULES_API_KEY` regardless of the configured provider, permanently reporting a correctly configured `claude-code` or `codex` repository as misconfigured. Both now probe the selected provider, and `doctor` additionally reports which other providers are ready on the machine.
### Changed
- **Default Pipeline Deduplicated (`src/engine.mjs`, `src/profiles.mjs`)**: `gate()`'s built-in stage sequence moved to `buildDefaultStages()` so `agentctl profile` describes exactly what the gate runs rather than a second implementation of it.
- **Vendor-Neutral npm Scripts (`bin/init.js`)**: Injected helpers are now `agent:gate`, `agent:dispatch`, `agent:queue`, `agent:create`, `agent:status`, `agent:doctor`, `agent:swarm`, `agent:clean`. Pre-existing `jules:*` entries are left untouched.

## [0.52.8] - 2026-09-03
### Fixed
- **Binary Asset Classification Guard (`src/security.mjs`, `test/hardening-vulnerabilities.test.mjs`)**: Bound the binary asset skipping condition (`printableRatio < 0.9`) strictly to payloads with `token.length >= 256`.

## [0.52.7] - 2026-09-03
### Added
- **Linux eBPF Runtime Security & Network Auditing (`.github/workflows/*.yml`)**: Integrated `step-security/harden-runner@e14015d583714f6e62063499dc959a02595150a1` (# v2.21.1) across all GitHub Action…

## [0.52.6] - 2026-09-03
### Fixed
- **Composite Action Template Injection (`.github/actions/setup-jules/action.yml`)**: Bound action inputs (`action`, `title`, `prompt`, `base_branch`) strictly to environment variables (`$INPUT_ACTION`, `$INPUT_TITLE`, `$INPUT_PROMPT`, `$BASE_BRANCH`) before shell invocation, eliminati…
- **Windows `cmd.exe` Redirection Operator Conflict (`test/server-probe.test.mjs`)**: Replaced arrow function `()=>{}` with `function(){}` in timeout fixture commands to prevent `cmd.exe` from misinterpreting `>` as a stream redirection operator.
### Security
- **Least-Privilege GitHub Actions Permissions (`.github/workflows/*.yml`)**: Declared explicit top-level and job-level `permissions: contents: read` across all workflow definitions (`agent-scope-guar…
- **Credential Leak Prevention via Git Persistence (`.github/workflows/*.yml`)**: Configured `persist-credentials: false` across all `actions/checkout` steps to prevent `GITHUB_TOKEN` from lingering in `.git/config`.
- **Action Pinning & Supply Chain Hardening (`.github/`)**: Pinned all workflow actions (`checkout`, `setup-node`, `cache`, `zizmor-action`) to immutable full commit SHAs.

## [0.52.5] - 2026-09-02
### Fixed
- **Test Deletion Bypass Tamper Guard (`src/security.mjs`, `test/test-tampering.test.mjs`, `test/hardening-vulnerabilities.test.mjs`)**: Tracked pre-image (`oldLineNo`) and post-image (`newLineNo`) line numbers from unified diff hunk headers in `checkTestTampering`.
- **Diff Payload Governor Base-Commit Binding (`src/engine.mjs`, `test/hardening-vulnerabilities.test.mjs`)**: Bound `limitBytes` in `gate()` strictly to `trustedConfigRaw.limits` from the base commit, preventing uncommitted disk config from inflating the diff ceiling in `--mode committed`.
- **Onboarding PR Scope Catch-22 Resolution (`src/config.mjs`, `test/hardening-vulnerabilities.test.mjs`)**: Moved `.agent/config.yml` and `.agent/jules.yml` from `BUILTIN_DENY` to `BUILTIN_PROTECT`, allowing `--allow-protected` and `allow-protected-paths` to land configs while keeping agents gated out.
### Added
- **Shannon Entropy Diff Scanner (`src/security.mjs`, `index.mjs`, `test/api-surface.test.mjs`, `test/hardening-vulnerabilities.test.mjs`)**: Implemented and exported `hasHighEntropyToken()` to detect unstructured tokens ($\ge 24$ chars, Shannon entropy $> 4.5$) on added diff lines as `HIGH_ENTROPY_TOKEN`.

## [0.52.4] - 2026-09-02
### Fixed
- **Base64 Line-Wrapped Secret Smuggling (`src/security.mjs`, `test/arena-audit-remediation.test.mjs`)**: In `secretScanVariants`, `hasEncodedSecret`, and `classifyAddedLines`, collapsed whitespace and newlines between adjacent base64 characters (RFC 4648 line-wrapped PEM certificates/keys, template liter…
- **Assertion Weakening & Vacuous Test Tampering (`src/security.mjs`, `test/arena-audit-remediation.test.mjs`)**: Added `VACUOUS_ASSERTIONS` detection to `checkTestTampering` to identify vacuous truth and identity assertions (`assert.ok(true)`, `expect(true).toBe(true)`, `assert.equal(1, 1)`, etc.) as critical te…
- **Offline Network Guard Exit Code 188 Classification (`src/engine.mjs`, `bin/agentctl.mjs`, `AGENTS.md`)**: Differentiated preload network guard egress kills (Exit 188) from ordinary test regressions (Exit 4); suppressed OODA repair loop on Exit 188 and provided remediation hints advising `npm install` and network mocking.
- **Git `--base HEAD` Local Reference Resolution (`src/git.mjs`, `test/arena-audit-remediation.test.mjs`)**: Excluded `HEAD` and relative commit references (`HEAD~*`, `HEAD^*`, `HEAD@*`) from `origin/` remote candidate prefixing in `resolveBase()`, ensuring local commit pointers are accurately resolved witho…

## [0.52.3] - 2026-09-02
### Fixed
- **Jules API Activity Patch Ingestion (`src/session-ops.mjs`, `src/provider.mjs`, `test/session-ops.test.mjs`, `test/provider-hardening.test.mjs`)**: Fixed `listActivities` in `provider.mjs` which called `getSession("", ...)` with empty string causing a `TypeError`.
- **Dynamic `execSync` Subprocess Hardening (`src/coverage.mjs`, `src/mutation.mjs`, `src/perf.mjs`)**: Replaced raw `execSync` with safety-hardened `runCmd` with `{ ignoreError: true }`, ensuring cross-platform `.cmd` shim resolution, execution timeouts, maxBuffer guards, and graceful handling of inten…
### Added
- **Edge Runtime Webhook Support (`src/webhook.mjs`, `test/webhook.test.mjs`)**: Refactored `verifySignature` and `parseWebhookPayload` to use `Uint8Array`, `TextEncoder`, and `TextDecoder`, preventing runtime crashes on Vercel Edge and Cloudflare Workers.
- **Whack-a-Mole Prompt Injection Defense (`src/remediation.mjs`, `test/whack-a-mole.test.mjs`)**: Enclosed oscillating test names inside `<UNTRUSTED>` fencing tags in the synthesized prompt directive.

## [0.52.2] - 2026-09-02
### Fixed
- **Zero-Test Oracle Bootstrapping on Empty Verify Command (`src/stack-detector.mjs`, `test/stack-detector.test.mjs`)**: `bootstrapZeroTestRepo` now inspects existing `verify.test` and only treats it as an established oracle if it is a non-empty command.
- **Git Remote Origin Repository Resolution for Dispatch (`src/git.mjs`, `src/provider.mjs`, `test/git.test.mjs`, `test/provider-hardening.test.mjs`)**: Implemented and exported `parseGitHubRepo(url)` to parse `owner/repo` across SSH (`git@github.com:owner/repo.git`, `ssh://...`), HTTPS, git-protocol, and authenticated URLs.

## [0.52.1] - 2026-09-02
### Fixed
- **Queue Task Ghost False Positive (`src/ops/next-step.mjs`, `test/next-step.test.mjs`)**: Filtered queue directory files using `isTaskFile(f, queueDir)` instead of blind extension matching, preventing `.agent/jules-queue/README.md` from being reported as a pending queued task immediately a…
- **Contract Files Post-Init Commit Hint (`bin/agentctl.mjs`, `README.md`)**: Dynamically constructed the post-init `git add` recommendation to include `SPEC.md`, `CONSTRAINTS.md`, and UI contracts alongside `.agent`, `AGENTS.md`, and `.gitignore` to avoid immediate doctor warnings.
- **Subcommand `--help` Interception (`bin/agentctl.mjs`, `src/ops/command-registry.mjs`)**: Delegated subcommand help flags (`agentctl <subcommand> --help`) to `formatCommandHelp` using registry descriptors rather than dumping global top-level help.
- **Non-Interactive Initialization Support (`bin/agentctl.mjs`, `src/wizard-task.mjs`)**: Added `--non-interactive`, `--no-interactive`, and `-y`/`--yes` CLI flags to `init` and `task create` for CI/scripted onboarding.
### Added
- **Roadmap v1.0.0 OODA Attempt Diff Retention (`ROADMAP_V1.md`)**: Registered target milestone for persisting intermediate working tree failure patches under `.agent/state/ooda/*.patch` for developer inspection via `agentctl patch --attempt <n>`.

## [0.52.0] - 2026-09-02
### Added
- **Power-User Session Operations Engine (`src/session-ops.mjs`, `agentctl patch`, `agentctl retry`, `agentctl prune`)**: `extractSessionPatch(sessionId, opts)`: Extracts raw git diff patch, pull request metadata, and affected file lists from completed Jules session outputs and activity artifacts.
- **Provider Remote Lifecycle Endpoints (`src/provider.mjs`)**: Implemented `listSessions()`, `listActivities()`, `archiveSession()`, `deleteSession()`, and `listSources()` across `createProvider`, `createFailoverProvider`, and `createSyntaxVerifiedProvider`.
- **Full Model Context Protocol (MCP) Server Tools Suite (`src/mcp.mjs`, 17 tools total)**: Added MCP tools: `jules_list_sessions`, `jules_list_activities`, `jules_get_session_output`, `jules_archive_session`, `jules_delete_session`, `jules_retry_session`, `jules_apply_patch`, `jules_list_so…
- **API Surface Extension (`index.mjs`, `test/api-surface.test.mjs`)**: Exported `extractSessionPatch`, `applySessionPatch`, `retrySession`, `pruneSessions`, and `parseAgeDuration` with locked SDK snapshot at 236 symbols.

## [0.51.0] - 2026-09-02
### Added
- **Diff-Hunk Mutation Testing Engine (`src/mutation.mjs`, `agentctl mutate`, `assert:mutation`)**: Evaluates agent-authored code against transactional operator inversion (`===`/`!==`, `>=`/$<$, `&&`/`||`, `true`/`false`, `+`/`-`) with multiline string/template/comment shielding (`getFileStringLiter…
- **Native Zero-Dep V8 Diff Coverage Enforcer (`src/coverage.mjs`, `agentctl coverage`, `assert:diff-coverage`)**: Harnesses `NODE_V8_COVERAGE` to map raw block hit counts to added `+` git diff hunks with zero external coverage tooling.
- **Whack-a-Mole Test-Oscillation Cycle Detector (`src/remediation.mjs`, `src/engine.mjs`)**: Tracks test failure bitvectors and rolling SHA-256 state tuples in OODA loops to halt infinite oscillation ($Test_A \to Test_B \to Test_A$) and inject architectural anti-local-maximum guidance.
- **Flakiness Stability Prober (`src/stability.mjs`, `agentctl probe`, `assert:test-stability`)**: Executes target suites across $N$ isolated passes to reject intermittent timing races and non-deterministic flakiness before merge.

## [0.43.0] - 2026-08-24
### Added
- **Four specialist role prompts ship in `.agent/prompts/`**: `A11y.md` (WCAG 2.2, keyboard/focus, measured contrast), `Scribe.md` (metadata, JSON-LD, canonical/OpenGraph parity, honest claims), `Spectator.md` (headless E2E, deterministic assertions, no `waitFor…
- **Four universal, stack-agnostic task envelopes (`src/web-templates.mjs`)**: `agent-dep-audit` (pinned/checksummed dependency resolution, stale-lockfile gate, install-script scrutiny, offline — no advisory API calls), `agent-doc-drift` (documented CLI flags, env vars and SDK e…
- **Test that every documented specialist role ships a prompt file** (`test/role-prompts.test.mjs`), and **tests for the four universal templates including a stack-neutrality assertion that pins no np…
### Changed
- **`scaffoldRepoAssets()` now lists all eight roles** in its created-files summary instead of only the original four (`src/scaffold.mjs`).
- **`AGENTS.md`, `JULES_RULES_TEMPLATE.md`, `README.md` and `EXAMPLES.md`** document the eight personas (with `--role` invocation) and the universal envelopes.

## [0.42.0] - 2026-08-24
### Added
- **First-Class Rules CLI Subcommands (`agentctl rules`, `bin/agentctl.mjs`)**: Added `agentctl rules check` to audit instruction files (`AGENTS.md`, `.agent/rules/*.md`, etc.) against token and line budgets (<10,000 chars, <250 lines) to prevent silent LLM context truncation.
- **All-In-One CI Verification Gate (`agentctl check`, `bin/agentctl.mjs`)**: Added `check` as a unified entrypoint for CI pipelines, running secret scanning, scope guard, diff payload budget (<75 KB), rules budget, and stack-detected test/build commands in one shot.
- **Stack-Tailored Contract Template Scaffolding (`src/scaffold.mjs`)**: Added `scaffoldContracts()` integrated into `agentctl init` / `scaffoldRepoAssets`.
- **Rules CLI Test Suite (`test/rules-cli.test.mjs`)**: Added 11 unit and integration tests verifying rules audit, compilation sentinels, and multi-stack contract generation.

## [0.41.1] - 2026-08-23
### Fixed
- **A lockfile bump failed closed as a CRITICAL secret leak (`src/security.mjs`)**: `decodeBase64Blobs` counted every token matching the base64 alphabet against a 64-payload cap and failed closed on overflow.
- **`agentctl init` left the kit's own bookkeeping in the working tree (`src/scaffold.mjs`, `bin/agentctl.mjs`, `bin/init.js`)**: the gate audits that tree, so every ledger, evidence manifest and telemetry line the kit wrote came back as a diff the agent was accused of making — first as a scope violation, then, once enough evide…
- **The two init paths scaffolded different repositories (`src/scaffold.mjs`)**: `jules-init` wrote `AGENTS.md`, the role prompts and the guardrails; `agentctl init` — the one the README's quickstart points at — wrote neither.
- **`agentctl queue` reported success for a queue that dispatched nothing (`bin/agentctl.mjs`)**: a run where every task was rejected — no API key is the common one — still printed `Processed 3 task(s).` and exited `0`.
### Changed
- **Every command that takes a prompt now takes it the same three ways (`bin/agentctl.mjs`)**: `dispatch` accepted a flag, a file or a positional; `task create` accepted only `--prompt`; `task optimize` accepted only a positional.

## [0.41.0] - 2026-08-22
### Added
- **Structural Flash-Router Governors (`src/router.mjs`)**: `classifyTaskComplexity()` gained three deterministic overrides ahead of the keyword scorer — a Declarative Asset Override (100% non-executable file extensions bypass the sensitive-path penalty), a Co…
- **`node --check` Syntax-Verification Escalation Gate (`createSyntaxVerifiedProvider`, `src/provider.mjs`)**: the FAST tier's cascade (`resolveRoutedProvider()`) now wraps the fast provider so that, after it dispatches, any `.js`/`.mjs`/`.cjs` file changed in the local working tree is parsed with `node --chec…
- **Optimistic Schema Degradation (`src/provider.mjs`)**: an HTTP 400 response mentioning deprecated fields (`temperature`, `top_p`, `thinking_budget`) is retried once with those fields stripped (`thinking_budget` mapped to `thinking_level: "high"`), and the…
- **Zero-Dependency Multi-User Budget Attribution (`src/budget.mjs`, `src/state.mjs`, `bin/agentctl.mjs`)**: `resolveAmbientIdentity()` resolves a developer identity (`--author` flag → `GITHUB_ACTOR` → sanitized `git config user.email` → OS username → `anonymous-local`), and `agentctl budget --by-user` repor…
### Fixed
- **`--author` never reached the real budget reservation (`src/engine.mjs`)**: `dispatch()`'s live path calls `withBudget(runDispatch, root, budget.limit, { enforce: budget.certain })` — no `author` was ever included, so `resolveAmbientIdentity()` was exercised only by unit test…

## [0.40.0] - 2026-08-22
### Changed
- **`FALLBACK_TIER` is now `free`, was `ultra` (`src/config.mjs`)**: a repository with no `tier:` — every repository until someone sets one — was granted a 300-task allowance and 60 concurrent workers.
- **The risk model no longer ships one project's directory names to everyone (`src/risk.mjs`, `.agent/config.yml`)**: the builtins contained `**/vat/**`, `**/pricing/**`, `**/contracts/**`, `wrangler.jsonc`, `packages/db/**`, and this kit's own `src/engine.mjs` and `src/security.mjs` — a domain model for one installa…
- **Shipped role prompts are stack-neutral (`.agent/prompts/`, `src/role-resolver.mjs`)**: `.agent/prompts/` ships inside the npm package, so every `agentctl init` in any language got this kit's own contribution rules — run `npm test`, run `npm run lint`, and "you are STRICTLY FORBIDDEN fro…
### Fixed
- **Interactive `agentctl task create` discarded every answer (`src/wizard-task.mjs`, `src/wizard-init.mjs`)**: both wizards spread `...options` **last** when handing off to their planning function.
- **`agentctl init` ignored the tier picked from the menu (`bin/agentctl.mjs`, `src/wizard-init.mjs`)**: the same defect, with a hardcoded `values.tier || "pro"` on top of it.

## [0.39.0] - 2026-08-22
### Added
- **Jules Provider Session API & Plan Approval (`src/provider.mjs`, `bin/agentctl.mjs`)**: Implemented first-class `getSession(sessionId)` and `approvePlan(sessionId)` on `createProvider("jules")` and `createFailoverProvider`.
- **Automated PR Harvester & Triage Engine (`src/ops/pr-harvest.mjs`, `bin/agentctl.mjs`)**: Added `agentctl pr harvest [--tier r0,r1] [--limit <n>] [--auto]` to discover open agent PRs, evaluate CI check rollups, map Risk Tiers (`R0_COSMETIC`, `R1_ROUTINE`), verify safety gate mutex locks (`…
- **Pre-Flight Idempotency & Premise Verification Gate (`src/engine.mjs`, `bin/agentctl.mjs`)**: Added `--check-premise` / `--idempotent` to `agentctl dispatch` / `create`.
- **Automatic Swarm Conflict Serialization (`src/dag-engine.mjs`)**: `executeQueueDag` now inspects `targetFiles` / `referenced_paths`.

## [0.38.2] - 2026-08-21
### Fixed
- **Manifests No Longer Dispatched as Tasks (`src/dag-engine.mjs`)**: `executeQueueDag` accepted every `.json` file in the queue directory as a task.
- **`--dry-run` No Longer Drains the Queue (`src/dag-engine.mjs`, `src/engine.mjs`)**: Both queue runners moved task files into `completed/` on a dry run, created `completed/` if it did not exist, and wrote a `task_completed` ledger entry — so the second preview of the same queue found …
### Added
- **Provider Injection in `run()` (`src/engine.mjs`)**: `run({ provider })` forwards to `dispatch`, mirroring the injection point `dispatch` and `gate` already expose.

## [0.38.1] - 2026-08-21
### Added
- **Documentation Sync Gate in CI (`.github/workflows/jules-audit.yml`)**: The gate `release.mjs` blocks on at step 1b now runs on every push and pull request as its own job.
- **CI Verification Gate in the Release Pipeline (`scripts/release.mjs`, step 1c)**: A release now refuses to proceed unless every CI run for `HEAD` has completed successfully.
- **Interactive Wizard Smoke Test (`test/wizard-smoke.test.mjs`)**: Drives the real `runInitWizard` — the function the CLI calls — over a fake TTY, reacting to what the wizard prints rather than to fixed delays.
### Fixed
- **Hung Tests Now Fail Instead of Stalling (`scripts/run-tests.mjs`, `.github/workflows/jules-audit.yml`)**: The `readKeypresses()` stdin regression failed by hanging rather than throwing.
- **Windows Path Assertion in the Handover Suite (`test/handover.test.mjs`)**: `createHandover` returns a native path, which the test matched against a forward-slash regex — red on `windows-latest` only, green on both other platforms.

## [0.38.0] - 2026-08-20
### Added
- **Multi-OS CI Matrix across Node 20, 22, and 24 (`.github/workflows/jules-audit.yml`)**: Fully automated test matrix executing 559 tests across 81 suites on Ubuntu Linux, macOS (Darwin), and Windows (PowerShell/CMD).
- **Deterministic Cross-Platform Test Runner (`scripts/run-tests.mjs`)**: Native zero-dependency runner that resolves all `test/*.test.mjs` test suites via `node:fs` and executes them via `node --test`, eliminating shell-globbing divergences across Windows CMD/PowerShell, m…
- **Darwin / macOS PID Inspection (`src/state.mjs`)**: Added BSD/Darwin `ps -p <pid> -o lstart=` support in `getProcessStartTime` so PID recycling checks and mutex stale-lock reapers work reliably on macOS where `/proc` is absent.
### Fixed
- **Windows Command Quoting & Shell Execution (`src/git.mjs`)**: Replaced custom arguments parsing with native `child_process.execSync` for shell-mode command execution, ensuring Windows `cmd.exe` properly preserves quoted string arguments without pathspec syntax corruption.
- **Windows Path Backslash Normalization in Test Harnesses (`test/tiered-verification.test.mjs`, `test/wizard-task.test.mjs`, `test/kit.test.mjs`)**: Ensured all generated temporary file paths and code evaluation snippets normalize Windows backslashes (`\`) to POSIX slashes (`/`), preventing JavaScript string escape corruption.

## [0.37.0] - 2026-08-20
### Added
- **The secret scanner now decodes base64 values before matching (`src/security.mjs`)**: base64 is less an evasion technique than a file format — every value under `data:` in a Kubernetes Secret manifest is base64 by specification, and whole `.env` files get encoded into a single CI variable.
- **`redactSecrets()` removes the encoded form too**: otherwise `scanDiff()` blocked the dispatch and the escalation payload reporting the block leaked the very value it blocked on.
### Fixed
- **`agentctl budget reset` released reservations that had demonstrably reached Jules (`src/budget.mjs`, `bin/agentctl.mjs`)**: `budget_committed` was written to the ledger and read by `scanBudgetWindow()`, and `releaseOpenReservations()` even counted committed versus uncommitted for its report — then released both alike.
- **`agentctl budget reset` silently ignored unrecognised flags**: a misremembered option — `--root`, `--force` — dropped straight through to a full release.
### Changed
- **`agentctl budget` reports the split**: open reservations are shown as *confirmed dispatched* versus *never closed*, so the number `reset` will act on is visible before it is run.

## [0.36.0] - 2026-08-20
### Added
- **`web-ai-access` Task Envelope Template (`src/web-templates.mjs`, `agentctl task template web-ai-access`)**: Verifies that AI crawler directives agree across every surface — `robots.txt`, per-page robots meta tags, and `X-Robots-Tag` headers — for `GPTBot`, `ClaudeBot`, `Google-Extended`, `PerplexityBot`, `C…

## [0.35.2] - 2026-08-20
### Fixed
- **The governor was inert by default (`src/webhook.mjs`, `src/config.mjs`)**: `AWAITING_USER_FEEDBACK` is both the fallback `reason` and was listed in `DEFAULT_CRITICAL_REASONS`, so every escalation that did not name a reason took the critical bypass.
- **`--dry-run` spent the interruption budget (`src/webhook.mjs`)**: `recordInterruption()` ran before the dry-run and no-webhook-configured early returns, so previewing an escalation — or raising one in a repo with no webhook — charged the operator's hourly allowance …
- **`--dry-run --flush` destroyed the digest (`src/webhook.mjs`)**: previewing a flush called `clearEscalationDigest()` and returned the payload, discarding every buffered incident without sending anything.
- **Oversized flushes dropped incidents silently (`src/webhook.mjs`)**: Slack truncated the summary block and Discord rendered only the first 10 fields, after which the entire buffer was cleared — so a digest of 50 reported 10 and lost 40.
### Changed
- **`DEFAULT_CRITICAL_REASONS` moved to `src/config.mjs`** and is re-exported from `src/webhook.mjs`.

## [0.35.1] - 2026-08-20
### Added
- **`web-i18n` Task Envelope Template (`src/web-templates.mjs`, `agentctl task template web-i18n`)**: Pre-calibrated verification envelope for multi-language locale routing, bidirectional symmetric `<link rel="alternate" hreflang="...">` tags (including `x-default`), dynamic `<html lang="...">` valida…

## [0.35.0] - 2026-08-20
### Added
- **Type III Silence Governor & Interruption Budgeting (`src/webhook.mjs`, `src/config.mjs`, `agentctl escalate`)**: Configurable notification modes (`mode: "immediate" | "digest" | "threshold" | "silent"`) via `.agent/config.yml` under `notifications:`.
- **Automated Flaky Test Healing Swarm (`src/flaky-ledger.mjs`, `agentctl flaky`)**: `listQuarantinedTests(root)` scans historical test outcomes and identifies Wilson-quarantined suites (Exit Code 8, oscillation $\ge 0.40$).
- **Repository `.gitattributes` Linguist Overrides**: De-indexes and collapses internal agent prompt templates, state directories, test suites, and generated data from GitHub language statistics and diff search.

## [0.34.0] - 2026-08-20
### Fixed
- **The daily budget reset at local midnight instead of on the provider's rolling 24-hour window.** The ledger rotates per calendar day (`ledger-<date>.jsonl`) and the count never looked past today's …
- **A learned ceiling expired at midnight too.** A refusal observed at 23:00 was discarded an hour later, unblocking an operator the provider was still refusing; one observed at 00:30 kept them blocke…
- **An anonymous `budget_released` entry could drift away from the reservation it cancelled.** Id-less reservations can only be matched by position, so once the window advanced past a released reserva…
### Changed
- **Concurrency presets raised toward what the plans actually allow.** Free 1 → 3, Pro 2 → 8, Ultra 3 → 15, against published ceilings of 3 / 15 / 60.
- **`TIER_PRESETS` now records `maxConcurrency`** — the vendor's ceiling — separately from `concurrency`, the kit's default.

## [0.33.0] - 2026-08-20
### Fixed
- **Two disagreeing tier tables (`TIER_PRESETS` in `src/config.mjs` vs `TIER_PROFILES` in `src/wizard-init.mjs`)**: the wizard scaffolded `free: daily_tasks: 30` while the runtime budgeted free accounts at `15`, and the written value won the merge — so a freshly initialised free-tier repo was cleared for **twice it…
- **`ultra` was never offered by the onboarding wizard** despite being the runtime's fallback tier, and `tier: enterprise` resolved to no preset at all.
- **Hardcoded version strings in four modules**: the CLI banner read `0.32.8` while `src/mcp.mjs`, `src/dashboard.mjs` and the config the wizard scaffolded still claimed `0.29.x`.
- **Reservations written with no `reservationId` (`reserveDailyBudget()` in `scripts/utils.mjs`)**: these counted against the daily budget but could never be named by a rollback, commit or reconcile, so they stayed charged until the ledger rotated at midnight.
### Added
- **Limit provenance (`src/budget.mjs`, `resolveDailyLimit()`)**: the kit now records whether a daily limit came from the operator (`limits.daily_tasks` or `JULES_DAILY_BUDGET`), from the provider refusing work, or from a tier preset.

## [0.32.8] - 2026-08-20
### Fixed
- **`--dry-run` consumed a real daily task slot (`dispatch()` in `src/engine.mjs`)**: `withBudget()` wrapped the provider call unconditionally, so the budget was reserved *before* the dry-run branch was reached.
- **The test suite wrote to the operator's real budget ledger**: `test/engine.test.mjs`, `test/kit.test.mjs` and the CLI dry-run probes in `test/mcp.test.mjs` all dispatched against `process.cwd()`, appending permanent `budget_reserved` entries to `.agent/state/led…
### Added
- **`opts.provider` injection for `dispatch()`**: mirrors the injection point `gate()` already exposed, so dispatch can be exercised without reaching a live provider.
- Regression coverage for both defects: a dry run must not change the reserved count, a live dispatch must consume exactly one slot, `agentctl dispatch --dry-run` must exit `0` under an exhausted budg…

## [0.32.7] - 2026-08-20
### Fixed
- **Stale `v0.29.1` version strings in `doctor`, `status`, `dashboard` banners and `index.mjs` JSDoc**: All now read dynamically from the `VERSION` constant or `package.json` instead of hardcoded strings.
- **`--version` output**: Now uses the `VERSION` constant instead of a hardcoded string.
- **Subcommand `--help` / `-h` fatal error**: `agentctl <subcommand> --help` previously threw `[FATAL ERROR] Unknown option '--help'` because `node:util` `parseArgs` runs in strict mode.
- **Subcommand `--dry-run` / `-d` fatal error**: Added `--dry-run` as a recognized option to all 10 `parseArgs` call sites that were missing it (gate, bootstrap, init, task create, task template, task optimize, test-gen, mcp init, harvest, evidence).

## [0.32.6] - 2026-08-20
### Security
- **Cross-platform path canonicalisation (`canonicalizePath()` in `src/config.mjs`, `checkScope()`/`matchesGlob()`/`isForbiddenPath()` in `src/security.mjs`)**: Deny and protect matching previously ran against the raw path string, so `./x`, `a/../x` and `a//x` each presented the same file under a spelling the patterns did not literally match.
- **Secret scanner evasion hardening (`scanDiff()` in `src/security.mjs`)**: Patterns are now matched against three variants of the added-line text — as-written, with invisible characters stripped (zero-width, soft hyphen, bidi controls, BOM), and with source-level string conc…
- **Router Windows-path parity (`collectReferencedPaths()` in `src/router.mjs`)**: `extractPathTokens()` recognises only `/`, so a sensitive path written `src\auth\session.mjs` by a Windows author was invisible to the force-complex guard and the task could be routed to the cheap tier.
- **New export**: `canonicalizePath` is exported from `index.mjs` alongside `normalizePath`.
### Added
- **Documentation Sync Gate (`scripts/doc-sync-check.mjs`, `npm run jules:doc-sync`)**: Implements the previously-advertised-but-unbuilt `doc-sync-sentinel` preset.

## [0.32.5] - 2026-08-20
### Security
- **Provider URL Token Leakage Guard (`src/provider.mjs`, `test/provider-hardening.test.mjs`)**: Added strict validation in `createProvider()` rejecting custom HTTP provider specifications whose `url` or `sendMessageUrl` templates contain `{token}`.
- **Additive Git Core Test Suite (`test/git.test.mjs`)**: Created comprehensive native `node:test` suite for `src/git.mjs` verifying command execution (`runCmd`, non-zero exit codes, buffer limits `ENOBUFS`, timeouts `ETIMEDOUT`), shell escaping, git operati…
- **Dynamic Complexity & Cost Router (`src/router.mjs`, `router:` in `.agent/config.yml`)**: New zero-dependency, rule-based `classifyTaskComplexity()` heuristic and `resolveRoutedProvider()` resolver.
- **Safety-First Routing**: Tasks touching `config.scope.deny` or built-in sensitive path patterns (`auth/**`, `migrations/**`, `pricing/**`, `secrets/**`, `*.pem`, `*.key`, `.github/**`) always force the primary provider, as do…
### Changed
- **DAG-Ordered Queue Execution (`src/dag-engine.mjs`, `agentctl queue --dag`)**: Added `DagExecutor` with Kahn's-algorithm dependency resolution, cycle detection (`DagCycleError`), per-task timeout wrapping, and `--concurrency <n>` worker slot control, driven by `--depends-on` on …

## [0.32.4] - 2026-08-18
### Changed
- **Type III Situational Awareness & Silence Governor Alignment (`ROADMAP_V1.md`, `PRIOR_ART.md`)**: Documented architectural roadmap for Google Labs `/code` Type III agentic paradigm ("Silence is an explicit, strategic decision") including Interruption Budgeting, quiet-by-default digest mode in `src…
- **Documentation & Version Synchronization (`README.md`, `bin/agentctl.mjs`, `package.json`)**: Synchronized semantic version to `v0.32.4` across CLI binaries, help menus, and documentation descriptors.

## [0.32.3] - 2026-08-15
### Changed
- **Queue Runtime Hygiene & Git Sterilisation (`.gitignore`)**: Untracked historical local task execution files and tightened `.gitignore` rules to guarantee an empty, clean `.agent/jules-queue/` on fresh clones.
- **Swarm Merge Safety Gate Hardening (`scripts/jules-merge-swarm.mjs`)**: Scoped risk tier evaluation in `checkSafetyGate` specifically to the target swarm PR branch diff rather than uncommitted local workspace working tree state.
- **Documentation Alignment (`README.md`, `ROADMAP_V1.md`)**: Synchronized CLI tables, version output descriptors, and release milestone roadmaps to current stable `v0.32.3`.

## [0.32.2] - 2026-08-15
### Changed
- **Web Development Task Templates (`src/web-templates.mjs`, `agentctl task template`)**: Added zero-dependency template synthesis engine supporting `web-cwv` (Core Web Vitals & Lighthouse Budget Guard), `web-wcag` (WCAG 2.2 AA/AAA semantic accessibility & modal focus traps), `web-seo` (Sc…
- **Google Labs Exploration Budget Protocol (`src/task-optimizer.mjs`)**: Implemented 3-phase discovery envelope injection (Phase 1: Discovery & Symbol Tracing, Phase 2: Oracle Formulation, Phase 3: Surgical Implementation & Verification), proven by Google Labs research to …
- **Internal Critic Agent Steering (`src/task-optimizer.mjs`, `src/web-templates.mjs`)**: Added adversarial pre-review directives targeting Jules' internal Critic Agent to catch $O(n^2)$ bottlenecks, dropped arguments, Cumulative Layout Shifts (CLS), and accessibility defects before PR creation.
- **CLI & MCP Tool Extensions (`bin/agentctl.mjs`, `src/mcp.mjs`)**: Added `agentctl task template [id]`, `agentctl task create --template <id>`, `agentctl task optimize --web`, and the `get_web_task_template` MCP stdio tool.

## [0.32.1] - 2026-08-12
### Changed
- **Universal Edge-Runtime Detection (`src/stack-detector.mjs`)**: Added `detectEdgeRuntime()` helper detecting Cloudflare Workers (`wrangler.toml`/`wrangler.json`), Vercel Edge (`@vercel/edge`), Netlify Edge Functions (`@netlify/edge-functions`), and Deno runtimes a…
- **Edge Import Security Gatekeeper (`src/security.mjs`, `checkEdgeRuntimeImports`)**: Added static verification gate flagging unsupported native Node.js built-in module imports (`node:fs`, `node:child_process`, `node:net`, `node:tls`, `node:vm`, etc.) in Edge diff contexts or files dec…
- **Documentation & Unit Tests (`AGENTS.md`, `README.md`, `test/security.test.mjs`, `test/stack-detector.test.mjs`)**: Updated system directives, security gatekeeper documentation, and test assertions covering Edge stack detection and import violations.

## [0.32.0] - 2026-08-12
### Changed
- **CI Unshallow Gate Fix (`src/git.mjs`, `scripts/stale-base-check.mjs`)**: Added `ensureBaseFetched()` helper with `--depth=100` / `--unshallow` fallback for shallow clones in CI, and enforced hard `exit 1` on base branch resolution failure in `stale-base-check.mjs`.
- **SPORE Memory Engine & System Learnings (`src/memory.mjs`, `bin/agentctl.mjs`)**: Added zero-dependency memory module providing `recordLearning()`, `hydratePrompt()`, and `harvestFailure()`.
- **Unit Test Coverage (`test/spore-memory.test.mjs`)**: Added test suite for learning recording, prompt hydration, and failure harvesting, bringing total passing unit tests to 378 across 54 test suites.

## [0.31.0] - 2026-08-10
### Changed
- **Warm Multi-Turn Session Resumption (`src/provider.mjs`)**: Added `resume(sessionId, prompt)` targeting `POST /v1alpha/sessions/{id}:sendMessage` with fail-soft cold dispatch fallback, saving 60–80% token consumption across OODA turns.
- **AST Blast-Radius Selective Testing (`src/dag-engine.mjs`)**: Implemented `resolveAffectedTests()` with `GLOBAL_CONTRACT_PATTERNS` guard to selectively run only affected leaf tests in large codebases while preserving full-suite verification on global changes.
- **Verification Lifecycle Sandbox (`src/config.mjs`, `src/engine.mjs`)**: Added `verify.setup` and `verify.teardown` lifecycle execution with guaranteed `try...finally` process-group cleanup for Prisma, Drizzle, Django, and SQLite migrations.
- **Prompt Falsifiability & Scope Linter (`src/task-optimizer.mjs`, `agentctl task optimize`)**: Added pre-dispatch prompt analyzer scoring testability (0–100), fuzzy typo resolution for file paths via Levenshtein distance, and automatic task envelope formatting.

## [0.30.0] - 2026-08-10
### Changed
- **Terminal Engine Hardening (`src/ux/`)**: Implemented zero-dependency terminal capabilities detector (`capabilities.mjs`), incremental sequence key decoder (`key-decoder.mjs`), raw mode lifecycle manager (`terminal-session.mjs`), virtual scre…
- **Guided Diagnostics & Auto-Remediation (`src/ops/`)**: Added diagnostic check DAG (`doctor-registry.mjs`), pure fix proposal planner (`doctor-planner.mjs`), transactional executor (`transaction.mjs`), and operation receipts system (`receipts.mjs`).
- **Interactive Queue & Swarm Manager (`src/ux/`, `src/ops/`)**: Implemented canonical task sidecar state machine (`queue-model.mjs`), swarm slot PID liveness detector (`swarm-model.mjs`), task action planner (`task-actions.mjs`), and swarm action planner (`swarm-actions.mjs`).
- **Command Registry & Interactive Command Palette (`src/ops/`, `src/ux/`)**: Added normative command descriptor registry (`command-registry.mjs`), CLI `--help` text generator, fuzzy search filter, and interactive command palette view (`palette.mjs`).

## [0.29.1] - 2026-08-10
### Changed
- **Canonical Queue Alignment (`src/wizard-task.mjs`)**: Updated `runTaskCreateWizard()` to write generated task files to canonical `getQueueDir(root)` (`.agent/jules-queue/`) rather than unread `.agent/queue/` directory.
- **Task ID Path Traversal Guard (`src/wizard-task.mjs`)**: Enforced strict task ID sanitization (`/[^a-zA-Z0-9_-]/g`) and path containment verification preventing directory traversal attacks via custom task IDs.
- **Atomic Writes & Config Preservation (`src/wizard-init.mjs`)**: Implemented atomic write operations (`tmp` file + `fsync` + `renameSync`) for `.agent/config.yml` and `.agent/jules.yml`.
- **Non-TTY Headless Guard (`src/wizard-init.mjs`)**: Enforced explicit error when running `runInitWizard()` in non-TTY mode without explicit parameters or `allowDefaults: true`.

## [0.29.0] - 2026-08-10
### Changed
- **Native Terminal UI (TUI) Engine (`src/tui.mjs`)**: Added zero-third-party-dependency TUI primitives built on `node:readline/promises`, `node:tty` (`setRawMode(true)`), and ANSI escape sequences, including single-select menus, multi-select checkboxes, …
- **Stack Oracle & Verification Probes (`src/wizard-oracle.mjs`)**: Added multi-tier stack inspection (Node, Cargo, Go, Pytest, CMake, Elixir, Docker, monorepos) and `runVerificationProbe()` execution validator.
- **Interactive Onboarding Engine (`src/wizard-init.mjs`, `agentctl init --interactive`)**: Added pure planning core `planInit()`, tier matrix (`free`, `pro`, `enterprise`), declarative preset loader (`.agent/presets/*.yml`), and atomic configuration generator.
- **Guided Task Authoring Subsystem (`src/wizard-task.mjs`, `agentctl task create`)**: Added task creation planning core `planTaskCreate()`, TODO candidate harvesting from `scanCodebaseForTodos()`, Shannon entropy secret leak scrubbing, falsifiability verification enforcement, `gate --m…

## [0.28.2] - 2026-08-10
### Changed
- **Jules Provider `startingBranch` & Source Validation (`src/provider.mjs`)**: Updated `startingBranch` to default to `config.baseBranch` (or `main`) rather than a target branch prefix (`agent/task`).
- **Automation & Plan Approval Body Mapping (`src/provider.mjs`)**: Mapped `task.autoPr` / `ctx.autoPr` to `automationMode: "AUTO_CREATE_PR"` and `task.requirePlanApproval` to `requirePlanApproval: true` in Google Jules REST API payloads.
- **Gate Mode Engine Wiring (`src/engine.mjs`)**: Wired `opts.mode` directly into `gate()`, passing `mode` down to `changedFiles()`, `diffBytes()`, and `diffText()`.
- **P0 Test Suite & E2E Verification (`test/p0-remediation.test.mjs`)**: Added end-to-end unit tests asserting `startingBranch` defaults, missing source validation, `automationMode` / `requirePlanApproval` body mapping, and `gate({ mode: "working-tree" })` untracked file secret blocking.

## [0.28.1] - 2026-08-10
### Changed
- **Node 22 Test Lifecycle Fix (`test/p0-remediation.test.mjs`)**: Made parent test callbacks `async` and awaited nested `t.test()` promises, resolving test cancellation failure on Node 22/20 CI runners.
- **Jules v1alpha Starting Branch Fix (`src/provider.mjs`)**: Updated `startingBranch` payload field to default to `config.baseBranch` (or `main`) rather than task target branch prefix (`agent/task`), conforming with Google Jules REST API spec.
- **Gate Working-Tree Mode Wiring (`src/engine.mjs`, `bin/agentctl.mjs`)**: Wired `opts.mode` into `gate()` (defaulting to `working-tree` for local runs) and added `--mode` (`working-tree`, `staged`, `committed`) options to `agentctl gate`.
- **CLI Options & Missing Commands (`bin/agentctl.mjs`)**: Added CLI options `--source`, `--branch`, `--repoless`, `--auto-pr`, `--require-plan-approval` to `agentctl dispatch`, added CLI command handlers for `create`, `status`, and `scan`, and normalized pro…

## [0.28.0] - 2026-08-09
### Changed
- **Google Jules REST v1alpha Provider Alignment (`src/provider.mjs`)**: Conformed default provider endpoint to `https://jules.googleapis.com/v1alpha/sessions` using `X-Goog-Api-Key` authentication header and structured `sourceContext` (`source` and `githubRepoContext.startingBranch`).
- **Prompt Guard Instruction Framing (`src/engine.mjs`, `src/prompt-guard.mjs`)**: Fixed `dispatch()` so primary user task instructions are passed as trusted operator instructions under `[TASK INSTRUCTIONS]` and not framed as untrusted data (`<<<UNTRUSTED-DATA>>>`).
- **Queue State Engine & Retry Semantics (`src/engine.mjs`)**: Updated `run()` so rate-limited (HTTP 429) or unavailable (HTTP 5xx) task dispatches leave task files in `queue/` for retry instead of moving them to `completed/`.
- **Working-Tree & Untracked File Gate Mode (`src/git.mjs`)**: Extended `changedFiles()`, `diffText()`, and `diffBytes()` with `working-tree` mode support to inspect uncommitted modifications, staged index, and untracked `.env`/secret files during pre-commit gating.

## [0.27.1] - 2026-08-09
### Changed
- **Dead Code Cleanup (`src/process-group.mjs`, `src/git.mjs`)**: Removed orphaned `src/process-group.mjs` module and unused `createBranch` / `worktreeAdd` exports from `src/git.mjs`.
- **Zero-Dependency Audit**: Verified 100% clean test execution and ESLint passing without introducing third-party analysis dependencies.

## [0.27.0] - 2026-08-09
### Changed
- **PR Review Auto-Remediation (`src/review-repair.mjs`)**: Implemented `parseReviewComments()` to parse GitHub PR review comments (`CHANGES_REQUESTED`), filter out conversational praise (`lgtm`, `looks good`, `thanks`), map file/line coordinates, and synthesi…
- **Multi-Provider Failover Router (`src/provider.mjs`)**: Implemented `createFailoverProvider()` allowing sequential failover across ordered provider lists (`["jules", "claude-code", "local-mcp"]`) on HTTP 429 rate limits or 5xx service unavailability.
- **Zero-Dependency Local Dashboard (`src/dashboard.mjs`)**: Implemented `createDashboardServer()` using `node:http` to serve a real-time dark-mode HTML visualizer and REST APIs (`/api/status`, `/api/telemetry`, `/api/flaky`, `/api/locks`).
- **Unit Test Suite (`test/v027-features.test.mjs`)**: Created test suite asserting PR review comment parsing, conversational noise filtering, multi-provider failover routing, and HTTP dashboard REST endpoints.

## [0.26.2] - 2026-08-09
### Changed
- **Triage Guidelines (`README.md`)**: Added explicit "When to Use vs.
- **Playwright Frontend Quickstart (`README.md`)**: Added Playwright E2E testing quickstart recipe demonstrating how visual/UI tasks can be made falsifiable via headless browser snapshot tests.

## [0.26.1] - 2026-08-09
### Changed
- **ESLint Fix (`src/merge-blocks.mjs`)**: Renamed unused `schemaType` parameter to `_schemaType` in `hashCrossLanguageInterface` signature, resolving ESLint `no-unused-vars` failure in CI.
- **Executive README Polish (`README.md`)**: Updated README with intuitive 2-sentence mental model, universal quickstarts across 5 stack archetypes, feature comparison matrix, architecture diagrams, and v0.27+ roadmap in an authoritative enterprise tone.

## [0.26.0] - 2026-08-09
### Changed
- **Universal Polyglot Stack Detector (`src/stack-detector.mjs`)**: Auto-detects 24+ tech ecosystems (PHP/Laravel/WP, .NET/C#/F#, Mobile Flutter/Swift/Dart/React-Native, Systems CMake/Cargo/Go/Make, Python, Node, Deno, Bun, Mix, Maven, Gradle, Bundler).
- **Container Execution Wrappers (`src/stack-detector.mjs`)**: Auto-detects `.devcontainer/devcontainer.json` or `docker-compose.yml` and wraps task verification commands in `docker compose exec -T app <cmd>` or `devcontainer exec`.
- **Scoped Monorepo Boundary Resolver (`resolveWorkspaceBoundary`)**: Isolates changed files up directory ancestry to nearest subproject root and synthesizes subshell test commands (`(cd backend && pytest) && (cd cli && cargo test)`), or falls back to global verificatio…
- **Zero-Test Repository Bootstrapping (`agentctl bootstrap`)**: Synthesizes non-destructive syntax check oracles (`php -l`, `python -m compileall`, `dotnet build`, `npx tsc --noEmit`) or generates `.agent/smoke.test.mjs` for untested repos.

## [0.25.1] - 2026-08-09
### Changed
- **Non-Blocking Queue Runner File I/O (`src/engine.mjs`)**: Replaced `fs.readFileSync` with `await fs.promises.readFile` inside the async batch processing map in `run()`, preventing event loop blocking during file prompt reads.
- **Command Resolver Sub-Parsers (`scripts/command-resolver.mjs`)**: Modularized `resolveProjectCommands` by extracting `parseYamlConfig` and `detectFrameworkCommands`.
- **Self-Audit Validation Passes (`scripts/jules-self-audit.mjs`)**: Modularized `runSelfAudit` into dedicated exported validation functions (`auditLedgers`, `auditWorktrees`, `auditGates`).

## [0.25.0] - 2026-08-09
### Changed
- **Provider Error Taxonomy (`src/provider.mjs`)**: Added typed error classes `ProviderRateLimitError` (HTTP 429), `ProviderUnavailableError` (5xx errors and socket timeouts), and `ProviderSchemaError` (invalid payload format).
- **Socket Timeout Support (`src/provider.mjs`)**: Configured 120s default socket timeout via `AbortSignal.timeout(timeoutMs)` for all HTTP provider dispatch requests.
- **Atomic Budget Rollback (`src/state.mjs`)**: Added `rollbackBudgetReservation()` to release reserved budget when provider calls fail to accept the session.
- **OODA Repair Bypass (`src/engine.mjs`)**: Updated `dispatch()` and `repair()` to catch provider infrastructure failures, roll back reserved budget, log backoff recommendations, and bypass OODA repair retries.

## [0.24.0] - 2026-08-09
### Changed
- **Fixed Queue Runner Dispatch (`scripts/jules-queue-runner.mjs`, `src/engine.mjs`)**: Refactored queue runner and `run()` engine to actually dispatch tasks via `dispatch()` before relocating them to `completed/`.
- **Code Pruning & Shim Cleanup**: Deleted obsolete shims (`scripts/jules-swarm.mjs`, `scripts/lock-manager.mjs`, `scripts/jules-cleanup.mjs`).
- **Premise Validation Fix (`src/envelope.mjs`)**: Fixed `git cat-file -e` premise check in `validateEnvelope` to evaluate exit code status (`status === 0`) instead of checking stdout length.
- **Lock Metadata Hardening (`src/state.mjs`)**: Included `branch` field in JSON lock payloads generated by `acquireLock`.

## [0.23.0] - 2026-08-09
### Changed
- **O(1) Telemetry Engine (`src/telemetry.mjs`)**: Implemented `appendTelemetry` with SHA-256 hash chaining, O(1) `.head` atomic cache file (`safeAtomicWrite` with `{ sync: false }`), cold scan fallback recovery, and 8 MB log segment rotation.
- **MCP Progress Streaming Bus (`src/mcp-progress.mjs`)**: Implemented `ProgressBus` with 150ms window coalescing (latest-wins intermediate state), stream backpressure safety (awaiting `"drain"`), 240-character progress message string capping, and `notificati…
- **MCP Tooling & System Integration (`src/mcp.mjs`, `src/engine.mjs`, `src/dag-engine.mjs`)**: Registered `telemetry_tail` MCP tool to query recent telemetry events.
- **Unit Test Suite (`test/telemetry-mcp-stream.test.mjs`)**: Added test suite verifying 1000 sequential O(1) appends (543ms), SHA-256 hash chain integrity, cold scan recovery, progress coalescing, message capping, backpressure safety, and tool execution.

## [0.22.9] - 2026-08-09
### Changed
- **Block Chunker & Merger (`src/merge-blocks.mjs`)**: Implemented `chunkBlocks` parsing column-0 declaration boundaries (`export`, `function`, `class`, `const`, `def`, etc.) with SHA-1 hashing, and `mergeBlocks3Way` performing 3-way block classification …
- **Syntax Verification Chain (`src/merge-verify.mjs`)**: Implemented `mergeVerifyChain` validating merged outputs via `node --check`, `tsc --noEmit` (if `tsconfig.json` exists), and `python3 -m py_compile`.
- **DAG Engine Hardening (`src/dag-engine.mjs`)**: Added registration freezing on `execute()`, `withTaskTimeout` per-task execution limits, and keyed output fingerprints (`${taskId}:${filePath}`).
- **Unit Test Suite (`test/merge-blocks.test.mjs`)**: Added tests asserting disjoint JS function additions, overlapping edit conflict generation, and post-execution `addTask()` rejection.

## [0.22.8] - 2026-08-09
### Changed
- **Flaky Test Ledger (`src/flaky-ledger.mjs`)**: Added `recordVerifyRun` appending run records to `.agent/state/flaky.jsonl` and `readVerifyRuns` / `getVerifyRuns` for reading stored run records.
- **Gate Integration (`src/engine.mjs`)**: Integrated verification run recording into `gate()`.
- **Unit Test Suite (`test/flaky-ledger.test.mjs`)**: Added test coverage verifying alternating P/F quarantine evaluation (`allowRepair = false`), 6 consecutive failures evaluation (`allowRepair = true`), ledger file IO, and gate exit code 8 return.
- **Documentation & Exit Code Registry (`AGENTS.md`)**: Documented Exit Code 8 (`FLAKY_QUARANTINE`) in exit code registry and troubleshooting matrix.

## [0.22.7] - 2026-08-09
### Changed
- **Stale Mutex Directory Reaper (`src/journal.mjs`)**: Added `reapStaleMutexDirs` scanning `.agent/state/` for `.mutex` directories older than `ttlMs` (30s) and using atomic grave paths (`.grave-<pid>`) with `rmdirSync` for CAS deletion.
- **PID Starttime Verification (`src/journal.mjs`)**: Updated `reapOrphanedIntents` lock cleanup to verify process start time via `isPidAlive(lockPid, lockStartTime)`, preventing lock deletion when process IDs are reused.
- **Absolute File URL Net-Guard Flag (`src/engine.mjs`, `src/git.mjs`)**: Updated net-guard `--import` flag to construct absolute file URLs (`new URL("./preload-net-guard.mjs", import.meta.url).href`), preventing `ERR_MODULE_NOT_FOUND` in downstream consumer repositories.
- **Prompt Guard Envelope Neutralization (`src/prompt-guard.mjs`, `src/engine.mjs`)**: Forced full re-sanitization in `buildAgentEnvelope` even if input strings contain `<<<UNTRUSTED-DATA-BEGIN` to close pre-trust bypass vectors.

## [0.22.6] - 2026-08-09
### Changed
- **Intent Journaling (`src/journal.mjs`)**: Implemented `journalIntent` and `journalDone` appending intent records to `.agent/state/journal.jsonl` with PID, `processStartTime`, operation type, target path, and timestamp.
- **Boot-Time Zombie Worktree Reaper (`src/journal.mjs`)**: Implemented `reapOrphanedIntents` to scan intent journal on startup, identify orphaned operations from dead/recycled PIDs using `isPidAlive`, prune orphaned git worktrees (`git worktree remove --force…
- **Boot Wiring (`bin/agentctl.mjs`, `src/mcp.mjs`)**: Integrated automatic reaping at CLI boot in `main()` and MCP server startup in `startMcpServer()`.
- **Git Mutation Wrapping (`src/git.mjs`)**: Wrapped `worktreeAdd` and `createBranch` with intent journaling.

## [0.22.5] - 2026-08-09
### Changed
- **Proc Stat Parsing (`src/state.mjs`)**: Refactored `getProcessStartTime` and added `parseProcStat` parsing fields strictly after `lastIndexOf(')') + 2` to prevent index shifts caused by process titles containing spaces or parentheses.
- **Queue Task Matching Filter (`src/engine.mjs`, `bin/agentctl.mjs`)**: Added `isTaskFile()` helper filtering out `README.md` and matching `TASK-*.md` or valid envelope front-matter in `.agent/jules-queue/`.
- **Process Execution Guardrails (`src/git.mjs`)**: Added default 10-minute timeout and 10 MB `maxBuffer` to process wrappers (`runCmd`, `git`).
- **Immutable Base Commit SHA Pinning (`src/git.mjs`, `src/execution_envelope.mjs`)**: Updated `resolveBase` to return exact 40-character commit SHAs output by `git rev-parse <ref>^{commit}` to pin `baseSha` immutably.

## [0.22.4] - 2026-08-09
### Changed
- **Task DAG Engine (`src/dag-engine.mjs`)**: Implemented native zero-dependency `DagExecutor` and `DagCycleError`.
- **SDK Export (`index.mjs`)**: Exported `DagExecutor` and `DagCycleError` for SDK consumption.
- **Unit Test Suite (`test/dag-engine.test.mjs`)**: Added test coverage asserting linear DAG execution order, diamond DAG concurrent dispatch, circular graph pre-execution cycle errors, interface fingerprinting gate validation, and lexicographical tie-…

## [0.22.3] - 2026-08-09
### Changed
- **Hermetic Preload Guard (`src/preload-net-guard.mjs`)**: Intercepts and blocks unmocked network egress in test sub-processes without external npm dependencies by monkey-patching `globalThis.fetch`, `node:http.request`, `node:http.get`, `node:https.request`,…
- **Engine Environment Injection (`src/engine.mjs`, `src/git.mjs`)**: Automatically injects `NODE_OPTIONS="--import ./src/preload-net-guard.mjs"` into verification/test suite executions inside `gate()` and passes custom `env` options in `runCmd()`.
- **Network Guard Unit Test Suite (`test/net-guard.test.mjs`)**: Added unit test suite asserting blocked unmocked egress (exit code `188` and `[FATAL] ERR_UNMOCKED_NET: <host>` output to stderr) and allowed loopback requests (`localhost`, `127.0.0.1`, `::1`).

## [0.22.2] - 2026-08-09
### Security
- **Input Sanitization Boundary (`src/prompt-guard.mjs`)**: Added `sanitizeUntrustedData` and `buildAgentEnvelope`.
- **MCP Stdout Stream Isolation (`src/mcp.mjs`)**: Sealed `process.stdout.write` and isolated stdout stream from generic writes (like `console.log`), redirecting unauthorized writes to `process.stderr` to prevent JSON-RPC framing stream corruption.
- **Prompt Guard Unit Test Suite (`test/prompt-guard.test.mjs`)**: Added test suite asserting injection neutralization, bidi/ANSI stripping, and stdout stream isolation during MCP execution.

## [0.22.1] - 2026-08-09
### Changed
- **Mutex Fail-Closed Enforcement (`src/state.mjs`)**: Updated `withVfsMutex` to strictly throw `MutexTimeoutError` on lock acquisition timeout instead of executing the critical section without a valid lock.
- **Robust PID Recycling Validation (`src/state.mjs`)**: Enhanced `isPidAlive()` to read field 22 (`starttime`) from `/proc/<pid>/stat` on Linux.
- **Atomic Budget Reservation (`src/state.mjs`)**: Added `reserveBudgetAtomic()` protecting budget checking, reservation writing, and `fsyncSync` under `.budget.mutex`.
- **Kernel Hardening Unit Test Suite (`test/kernel-hardening.test.mjs`)**: Added automated unit tests verifying fail-closed mutex behavior, PID recycling starttime validation, and atomic budget reservation under 20 concurrent tasks.

## [0.22.0] - 2026-08-09
### Changed
- **Node.js LTS Engine Bump (`package.json`, `README.md`, `action.yml`)**: Raised Node.js engine requirement from `>=18.0.0` to `>=20.0.0` (Active LTS baseline).

## [0.21.0] - 2026-08-09
### Changed
- **Falsy Zero-Budget Fix (`src/config.mjs`)**: Fixed `JULES_DAILY_BUDGET: 0` evaluating as falsy and bypassing zero-budget limits.
- **Rule Path Security Guard (`src/risk.mjs`)**: Added missing `.agent/rules/**` to `RESTRICTED_PATH_PATTERNS`, guaranteeing rule edits trigger R3 Restricted risk classification.
- **OODA Fingerprint Normalization (`src/engine.mjs`)**: Extended `fingerprintFailureState()` regex for ANSI escape codes (`[\u001b\x1b]\[[0-9;]*[a-zA-Z]`), URL query parameters, line numbers, and column numbers.
- **MCP Server Parameter Validation (`src/mcp.mjs`)**: Added JSON-RPC `-32602` error validation for `check_risk_tier` input parameters and `-32601` for invalid methods.

## [0.20.0] - 2026-08-08 (Community Release Candidate)
### Changed
- **Linearizable VFS Directory Mutex (`src/state.mjs`)**: Kernel-level VFS directory mutex (`withVfsMutex`) guaranteeing strict serial linearizability for SHA-256 hash-chained session ledgers under high-concurrency multi-agent swarms.
- **PID Recycling & Stale Lock Protection (`src/state.mjs`)**: Added process start-time verification (`/proc/<pid>/stat` field 22 on Linux) to `isPidAlive()`, eliminating false-positive lock reaps from recycled OS process IDs.
- **Memory-Bounded Content-Length MCP Streaming (`src/mcp.mjs`)**: Implemented `McpFrameDecoder` with a 4 MB memory safety ceiling, supporting both HTTP-style `Content-Length` header framing and line-delimited JSON-RPC 2.0 messages over stdio.
- **Process Group Isolation & Zombie Defense (`src/process-group.mjs`)**: Implemented `ProcessGroupManager` with `detached: true` process group targeting and signal hooks (`SIGINT`/`SIGTERM`/`exit`) executing `process.kill(-pgid)` to guarantee 100% leak-free process tree cleanup.

## [0.10.0] - 2026-08-08
### Security
- **Shell-less Process Execution (`src/git.mjs`, `src/engine.mjs`)**: Refactored `runCmd()` to tokenise command strings and execute directly via `execFileSync` without invoking system shell (`sh -c` / `cmd.exe /c`), preventing command injection vulnerabilities.
- **Fail-Closed Webhook Verification (`src/webhook.mjs`)**: Updated `verifySignature()` to fail closed when `JULES_WEBHOOK_SECRET` is unset.
- **Expanded Secret Scanning (`src/security.mjs`)**: Added 2026 key formats (`github_pat_`, Anthropic `sk-ant-`, OpenAI `sk-proj-`, Google OAuth `ya29.`, Slack bot tokens) to `HIGH_CONFIDENCE_PATTERNS`.
- **Execution Envelope Canonicalization (`src/execution_envelope.mjs`)**: Updated `hashExecutionEnvelope()` to include `baseRef` and `createdAt` alongside key-canonicalization in the SHA-256 digest.

## [0.9.4] - 2026-08-08
### Added
- **Zero-Dependency Stdio MCP Server (`src/mcp.mjs`, `bin/mcp-server.mjs`)**: Implemented native Model Context Protocol (MCP) server over stdio streams using Node.js `node:readline` and JSON-RPC 2.0.
- **CLI & Package Expositions**: Added `agentctl mcp` command and exposed `jules-mcp` and `agentctl-mcp` binary targets in `package.json`.
- **Exit Code 7 Alignment (`BudgetError`)**: Updated `withBudget` in `src/state.mjs` to throw `BudgetError` with explicit `code: 7` on daily session budget exhaustion (`dailyTasks: 300`).
- **Documentation & Remediation Matrix**: Documented `Exit 7` in `AGENTS.md` and added a complete Exit Code Troubleshooting & Remediation Matrix for codes `0–7`.

## [0.9.2] - 2026-08-03
### Added
- **Modular Domain Architecture (`src/`)**: Completely refactored from vendored script prototype into native ESM modules (`src/config.mjs`, `src/security.mjs`, `src/git.mjs`, `src/provider.mjs`, `src/state.mjs`, `src/engine.mjs`).
- **Unified Command-Line Interface (`agentctl`)**: Added single `bin/agentctl.mjs` CLI executable supporting `dispatch`, `gate`/`audit`, `queue`, `swarm`, `lock`, `doctor`, and `init` with `--json` output options.
- **Provider-Agnostic Engine Architecture**: Configuration-driven template adapters supporting `http` and `exec` providers (`jules`, `claude-code`, `codex`, Ollama, Bedrock) with shell-less execution (`spawnSync`, `shell: false`).
- **Zero-Dependency Guarantee**: Core engine built strictly using native Node.js ≥ 18 built-in modules (`node:fs`, `node:path`, `node:child_process`, `node:crypto`, `node:util`).

## [0.8.6] - 2026-08-03
### Added
- **Safety Gate Verification Engine**: Added `checkSafetyGate()` in `scripts/jules-merge-swarm.mjs` to inspect active worker locks (`.agent/state/locks/*.json`) before squashing PRs, preventing active session merge collisions.
- **UNTRUSTED Prompt Injection Fencing & Pre-Flight Static Checks**: Enhanced `<UNTRUSTED_TASK_CONTEXT_${nonce}>` directives in `scripts/jules-dispatch.mjs` with explicit injection defense rules and added `runPreflightStaticCheck()` to pre-run static analysis (`eslint`…
- **3-Bucket Status Categorization**: Added `categorizeTaskStatus()` in `scripts/jules-status.mjs` partitioning task outputs into *🚨 Action Required*, *⏳ In Progress*, and *✅ Completed / Terminal*.
- **Specialist Agent Prompts & Master Template**: Added `.agent/prompts/` directory featuring `Overseer.md` (codebase audit specialist), `Bolt.md` (micro-performance optimizer), `Sentinel.md` (security auditor), and `Task_Template.md` (master prompt template).

## [0.8.5] - 2026-08-03
### Added
- **Disjoint Swarm PR Auto-Merge Engine**: Added `scripts/jules-merge-swarm.mjs` (`npm run jules:merge-swarm`) to automatically verify CI checks, evaluate disjoint file cluster modifications (zero file collisions), and squash-merge passing Jul…
- **`baseBranch` REST Payload Decoupling**: Updated `startingBranch` in `jules-dispatch.mjs` to strictly use `BASE_BRANCH || "main"` (the remote base ref), preventing HTTP 400 `sessionFailed` errors from unpushed local feature branches.
- **Active Session Quota Backoff (`FAILED_PRECONDITION`)**: Added HTTP 400 `FAILED_PRECONDITION` detection (~30 concurrent max session limit) with exponential retry backoff in `jules-dispatch.mjs` and `concurrency_limit` classification in `jules-queue-runner.mjs`.
- **OODA Repair Secret Masking**: Wrapped failure logs in `redactSecrets(anonymizePii(failureLog))` inside `jules-self-audit.mjs` before dispatching auto-repair prompts.

## [0.8.4] - 2026-08-03
### Fixed
- **Dynamic Guardrails Schema Alignment**: Fixed schema drift in `jules-dispatch.mjs:getDynamicGuardrails` by supporting both `rule.directive` and `rule.guardrail` properties from `.agent/rules/dynamic-guardrails.json`.
- **PuTTY PPK Format Pattern Fix**: Updated PuTTY secret scanning pattern in `utils.mjs` to match actual PPK key headers (`PuTTY-User-Key-File-\d+:`).
- **Expanded Secret Redaction (10+ New Token Families)**: Added high-confidence & low-confidence secret regex patterns for Google OAuth client secrets (`GOCSPX-`), AWS STS tokens (`ASIA`), GitLab PATs (`glpat-`), DigitalOcean PATs (`dop_v1_`), SendGrid API k…
- **SDK & MCP Export Readiness**: Exported `dispatchTask` in `jules-dispatch.mjs` and `classifyQueueFailure` in `jules-queue-runner.mjs`, making them available from the `index.mjs` primary SDK entrypoint for programmatical and MCP server invocation.

## [0.8.3] - 2026-08-03
### Security
- **P0 Untrusted Prompt Envelope Noncing**: Replaced static `<UNTRUSTED_TASK_CONTEXT>` tags in `jules-dispatch.mjs` with crypto-random nonced tags (`<UNTRUSTED_TASK_CONTEXT_${nonce}>`) and case-insensitive closing tag stripping to prevent promp…
- **P0 Image Attachment Containment & Path Traversal Prevention**: Added `realpathSync` root containment checks in `extractImageAttachments` to block traversal attacks (`../../../etc/passwd.svg`) and eliminated the wasteful 500KB `dataUri` exfiltration vector.
- **P0 Secret Scanner Buffer Overflow & Fail-Closed Policy**: Expanded `runGitCommand` buffer in `jules-self-audit.mjs` to 25MB (`maxBuffer`) and disabled silent error swallowing on git diff execution (`ignoreError = false`), guaranteeing secret scans fail-closed on massive diffs.
- **P0 Unconditional CI Audit & Scope Guard Workflows**: Removed `jules/` head ref and actor restrictions from `.github/workflows/agent-scope-guard.yml` and `.github/workflows/jules-audit.yml`, ensuring gatekeeper checks run on all PRs regardless of actor.

## [0.8.2] - 2026-08-01
### Fixed
- **Safe CI Template Scaffold**: Updated `.github/workflows/jules-audit.yml` to use `npm run lint --if-present` and `npm test --if-present`, preventing scaffolded user repositories without a `lint` script from failing CI on first push.
- **Untrusted Prompt Fencing & Security Header**: Added `# SECURITY DIRECTIVE — UNTRUSTED CONTENT FENCE` header and untrusted specifications instruction inside `<UNTRUSTED_TASK_CONTEXT>`.
- **Queue Runner Non-Zero Exit on Permanent Failures**: Updated `jules-queue-runner.mjs` to exit with code 1 when any queue tasks fail permanently.
- **Package Payload Shrink**: Excluded `.github/social-preview.png` and scoped `files` in `package.json` to `.github/workflows/jules-audit.yml`, reducing npm tarball size by 87% (from 332.9 kB down to 44.8 kB).

## [0.8.1] - 2026-07-31
### Fixed
- **OODA Function Module-Scope Fix**: Moved `getOodaStateFile` to top-level module scope in `jules-self-audit.mjs`.
- **Queue Budget Deferral**: Daily budget exhaustion (`budget_exhausted`) is no longer treated as permanent failure.
- **Automatic 30-Day Ledger Pruning**: Added `pruneOldLedgers()` to `utils.mjs` to automatically clean up date-stamped `.jsonl` files older than 30 days.
- **Enhanced Guardrail Error Messages**: Updated `jules-self-audit.mjs` error messages to explicitly list offending files and matching override flags (`JULES_ALLOW_COMMAND_FILE_CHANGES=true` or `JULES_ALLOW_AGENT_RULE_CHANGES=true`).

## [0.8.0] - 2026-07-31
### Added
- **Daily Ledger Rotation**: Session ledgers rotate into daily date-stamped files (`.agent/state/sessions/YYYY-MM-DD.jsonl`), preventing ledger bloat and speeding up daily budget calculations.
- **Package Manager Detection**: `resolveProjectCommands` now automatically detects `pnpm` (`pnpm-lock.yaml`), `yarn` (`yarn.lock`), `bun` (`bun.lockb`), and `packageManager` fields before falling back to `npm`.
- **JSON Status Reporting**: Added `--json` output flag to `scripts/jules-status.mjs` for programmatic status and budget metric consumption.
- **Global Swarm Partitioning**: Updated `scripts/jules-swarm.mjs` to pass global task indices across the entire swarm queue rather than per-batch indices.

## [0.7.0] - 2026-07-31
### Added
- **Zero-Trust Base-Branch Rule Extraction**: `getBaseRules()` now fetches `AGENTS.md` and `JULES_RULES_TEMPLATE.md` directly from `origin/main` via `git show`, preventing untrusted PR branches from injecting malicious agent instructions.
- **Agent Rule Change Guardrail**: Added `RESTRICTED_AGENT_FILES` check (`AGENTS.md`, `JULES_RULES_TEMPLATE.md`, `.agent/rules/**`, `.agent/workflows/**`).
- **Executable Build Config Guardrail**: Expanded `COMMAND_DEFINING_FILES` with `EXECUTION_CONFIG_FILES` (`jest.config.*`, `vitest.config.*`, `playwright.config.*`, `vite.config.*`, `webpack.config.*`, `next.config.*`, `babel.config.*`, `tsc…
- **Safe Dispatch Cleanup**: Replaced `process.exit(7)` inside `executeDispatch` with a thrown error (`err.code = 7`), guaranteeing `finally { cleanupTmp(); }` executes and wipes temporary payload files.

## [0.6.3] - 2026-07-31
### Fixed
- **Removed Unverified Third-Party Setup URL**: Replaced misleading `app.jules.ai/setup` link in `bin/init.js` with official Google Jules portal `https://jules.google`.
- **Renamed Workspace Setup Code**: Clarified terminology in `bin/init.js` and `.agent/JULES_WEB_SETUP.md` from "Cryptographic Handshake" to "Encoded Workspace Manifest".
- **Added Missing Helper Scripts to Target `package.json`**: Added `"jules:cleanup"` and `"jules:scan"` script entries to injected `package.json` manifest.
- **Automatic `.gitignore` Security Scaffolding**: `bin/init.js` now automatically injects required security ignore rules (`.env`, `.agent/history/`, `.agent/state/`, `.agent/jules-queue/*.md`) into target `.gitignore` if missing.

## [0.6.2] - 2026-07-31
### Fixed
- **Dynamic Secret Test Fixtures**: Constructed secret strings dynamically in `kit.test.mjs` (`"gho_" + "1".repeat(36)`) to prevent static string literals from triggering Exit Code 6 on self-audits of test files.
- **Restored `redactSecrets` Test Coverage**: Added dedicated unit tests verifying that `redactSecrets` masks active environment variables, OAuth tokens, Bearer headers, private keys, npm tokens, and Stripe keys.
- **Lockfile-Only Diff Payload Governor**: Fixed payload size governor calculation when `changedCodeFiles` is empty (e.g., lockfile-only PRs), returning 0 bytes instead of falling back to full raw diff size.
- **CI OODA State Scope**: Documented that `.agent/state/ooda.json` tracks local retry state, whereas ephemeral CI runners rely on `git log` auto-repair commit history.

## [0.6.1] - 2026-07-31
### Fixed
- **Atomic Budget Lock Fix**: Fixed `reserveDailyBudget` lock fallback.
- **Budget Counting Fix**: `checkDailyBudget` now counts exclusively `budget_reserved` events, preventing double-counting with `session_dispatched`.
- **Added-Line Secret Scanner**: Secret scanner now evaluates enclaves of added diff lines (`+` prefix, ignoring `+++` headers) and separates High-Confidence secrets (Exit Code 6) from Low-Confidence/Test Keys (warnings).
- **Code Diff Payload Governor**: Calculated 75 KB payload governor size strictly on code files (`changedCodeFiles`), preventing lockfiles from triggering false positive Exit Code 5 errors.

## [0.6.0] - 2026-07-31
### Security
- **Command File Guardrail**: Added `COMMAND_DEFINING_FILES` check to `jules-self-audit.mjs`.
- **Immutable Forbidden Paths**: Enforced that `forbidden_paths` cannot be overridden by `allow_paths` in `.agent/jules.yml`.
- **Zero-Trust Base Branch Extraction**: Switched to safe `execFileSync` for `git archive` and `tar` without working-tree fallback on extraction error.
- **Enhanced Secret Redaction**: Added support for `gho_` GitHub OAuth tokens, word boundaries for Bearer tokens, generalized Google API key patterns, npm tokens, and Stripe keys.

## [0.5.2] - 2026-07-31
### Added
- Created standard `CONTRIBUTING.md`, `CHANGELOG.md`, and `SECURITY.md` files.
- Added a Node.js matrix check in GitHub Actions for broader compatibility testing.
- `.env.example` has been updated with all 19 supported configuration variables.
### Fixed
- Fixed an issue in `jules-self-audit.mjs` where `runCommand("git status")` would throw a ReferenceError by properly invoking `execSync`.
- Replaced `process.exit(1)` with `throw new Error()` in exported SDK functions so downstream consumers are not abruptly terminated.

## [0.5.0] - 2026-07-31
### Added
- Aligned project with Google Jules advanced protocol and guardrails.

## [0.3.0]
### Added
- Epistemic Bridge support: Cryptographic Handshake Token generation for Web UI synchronization.
