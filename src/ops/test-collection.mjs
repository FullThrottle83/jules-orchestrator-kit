/**
 * How many tests the runner actually collected, read out of its own output.
 *
 * The gate's oracle is one number: the exit code of the verification command.
 * That number cannot distinguish "every test passed" from "there were no
 * tests". Several runners report the second case as success, by design:
 *
 *   go test ./...        →  "?  example.com/app  [no test files]", exit 0
 *   jest --passWithNoTests →  "No tests found, exiting with code 0"
 *   npm test --workspaces →  exit 0 when the changed package has no suite
 *   pytest --exitfirst on a path that matches nothing, in some configurations
 *
 * So a repository could invert a function, add an untested one, and collect
 * five green phases — verified against nothing. `verify.required: false` is
 * the switch for a repository that genuinely has no oracle; silently passing
 * is not.
 *
 * The parsing is deliberately one-sided. A count is only returned when the
 * runner stated one in a form recognised here; an unrecognised runner yields
 * `null`, and null is not a failure. Failing on "I could not tell" would break
 * every runner not on this list, which is most of them.
 */

/**
 * Patterns that state a test count, per runner family.
 *
 * Each entry captures a single number. The first pattern that matches wins,
 * so the more specific summaries come first.
 */
const COUNT_PATTERNS = [
  // node:test — spec reporter ("ℹ tests 940") and tap ("# tests 940")
  { name: "node:test", re: /^[^\n]*?(?:ℹ|#)\s*tests\s+(\d+)\s*$/m },
  // pytest — "collected 12 items", "12 passed", "no tests ran in 0.01s"
  { name: "pytest", re: /^\s*collected\s+(\d+)\s+items?/m },
  { name: "pytest", re: /=+\s*(\d+)\s+passed/m },
  // cargo — "running 7 tests"
  { name: "cargo", re: /^\s*running\s+(\d+)\s+tests?\s*$/m },
  // jest / vitest — "Tests:       12 passed, 12 total"
  { name: "jest", re: /^\s*Tests:\s+.*?(\d+)\s+total\s*$/m },
  // mocha — "12 passing"
  { name: "mocha", re: /^\s*(\d+)\s+passing/m },
  // Maven / Surefire — "Tests run: 12, Failures: 0"
  { name: "surefire", re: /\bTests run:\s*(\d+)/i },
  // PHPUnit — "OK (12 tests, 30 assertions)"
  { name: "phpunit", re: /\bOK\s*\((\d+)\s+tests?/i },
  // RSpec / ExUnit — "12 examples, 0 failures" / "12 tests, 0 failures"
  { name: "rspec", re: /^\s*(\d+)\s+examples?,\s*\d+\s+failures?/m },
  { name: "exunit", re: /^\s*(\d+)\s+tests?,\s*\d+\s+failures?/m },
  // dotnet test — "Total tests: 12" / "Passed!  - Failed: 0, Passed: 12"
  { name: "dotnet", re: /\bTotal(?:\s+tests)?:\s*(\d+)/i },
  // swift test / XCTest — "Executed 12 tests"
  { name: "xctest", re: /\bExecuted\s+(\d+)\s+tests?/i },
  // Every runner below states a count the gate used to read as silence, and
  // silence is what makes `pnpm -r test` on a workspace with no package-level
  // test script indistinguishable from a suite that ran. The floor stays
  // one-sided — an unrecognised runner still passes — so widening the list
  // only ever converts an "I could not tell" into an answer.
  // Python unittest — "Ran 12 tests in 0.003s"
  { name: "unittest", re: /^Ran\s+(\d+)\s+tests?\s+in\b/m },
  // GoogleTest — "[==========] 12 tests from 3 test suites ran."
  { name: "gtest", re: /\[=+\]\s+(\d+)\s+tests?\s+from\b/ },
  // Catch2 — "test cases: 12 | 12 passed"
  { name: "catch2", re: /\btest cases:\s*(\d+)/i },
  // deno test — "ok | 12 passed | 0 failed"
  { name: "deno", re: /\|\s*(\d+)\s+passed\s*\|/ },
  // bun test — "12 pass"
  { name: "bun", re: /^\s*(\d+)\s+pass\s*$/m },
  // ava — "12 tests passed"
  { name: "ava", re: /^\s*(\d+)\s+tests?\s+passed\s*$/m },
  // A bare TAP plan, which is how tape, bats and the TAP producers that
  // print no summary state their count. Last of the count patterns: node:test
  // emits TAP too, and its own line above is the more specific reading.
  { name: "tap", re: /^1\.\.(\d+)\s*$/m },
];

/** Per-test lines, which `go test` only prints under -v. */
const GO_PER_TEST = /^\s*--- (?:PASS|FAIL|SKIP):/gm;

/** Phrases that state, in so many words, that nothing was collected. */
const EXPLICIT_ZERO = [
  { name: "pytest", re: /\bno tests ran\b/i },
  { name: "pytest", re: /^\s*collected\s+0\s+items?/m },
  { name: "jest", re: /\bNo tests found\b/i },
  { name: "vitest", re: /\bNo test files found\b/i },
  { name: "mocha", re: /^\s*0\s+passing/m },
  { name: "cargo", re: /^\s*running\s+0\s+tests?\s*$/m },
  { name: "phpunit", re: /\bNo tests executed!/i },
  { name: "gradle", re: /^>\s*Task\s+:\S*test\S*\s+NO-SOURCE\s*$/mi },
  { name: "ctest", re: /\bNo tests were found\b/i },
  { name: "flutter", re: /\bNo tests ran\.?/i },
];

/** Go prints this per package that has no test files at all. */
const GO_NO_TEST_FILES = /\[no test files\]/;
/**
 * Any sign that a Go package did run tests.
 *
 * The negative lookahead is what separates Go from TAP. `ok 1 - performance`
 * is a TAP result line and `ok  example.com/lib 0.004s` is a Go package
 * summary, and a bare `^ok\s` matched both — so a 190-test TAP suite was
 * classified as Go and reported as having stated no count at all.
 */
const GO_RAN_SOMETHING = /^(?:(?:ok|FAIL)\s+(?!\d+\s)\S+|---\s+(?:PASS|FAIL|SKIP):?\s)/m;

/**
 * Read a collected-test count out of a runner's output.
 *
 * @param {string} [stdout]
 * @param {string} [stderr]
 * @returns {{ count: number|null, runner: string|null }}
 *   `count` is null when no recognised runner stated one — which is not a
 *   finding, only an absence of evidence.
 */
/**
 * Did the command write nothing at all, on either stream?
 *
 * This is the one absence that is evidence rather than the lack of it. The
 * one-sided floor exists because an unrecognised runner states no count, and
 * hard-redding every runner not on the list would be worse than the hole it
 * closes. But an unrecognised runner still *prints*: dots, a summary line,
 * a package name, something. Zero bytes on both streams is not a dialect the
 * list has yet to learn — it is a command that ran nothing.
 *
 * `pnpm -r test` on a workspace whose packages declare no test script is the
 * shape that made this necessary: it exits 0, writes nothing anywhere, and
 * was indistinguishable from a full suite by every signal the gate had.
 *
 * Resolved here and consumed in two places — the gate's floor and `init`'s
 * oracle probe — because writing the rule once in each is how this project
 * has repeatedly ended up with two answers to one question.
 */
export function producedNoOutput(stdout = "", stderr = "") {
  return `${stdout || ""}${stderr || ""}`.trim() === "";
}

/**
 * Does this command claim to run a test suite?
 *
 * Silence alone cannot carry the verdict, and the first version of this rule
 * assumed it could. `node --check index.js`, `tsc --noEmit`, `go vet ./...`
 * and `python3 -m compileall -q .` all exit 0 having printed nothing — and
 * they are honest static gates, two of which this kit writes itself for
 * repositories that have no suite yet. Failing on silence alone hard-redded
 * every one of them, which is the same first-run rejection of correct code
 * that the whole collection floor is careful to avoid.
 *
 * Nothing in the *output* separates `pnpm -r test` from `tsc --noEmit`; both
 * are empty. The difference is in what the command says it is. So this reads
 * the command, the same way `isPlaceholderTestScript` does: a command that is
 * recognisably a suite invocation and printed nothing ran no suite, while a
 * static checker that printed nothing did exactly what it promised.
 *
 * One-sided in the safe direction, like everything else here. An unrecognised
 * command is not treated as a suite, so an unusual runner keeps its advisory
 * pass rather than becoming a hard red.
 */
const TEST_SUITE_COMMAND =
  /(?:^|\s|\/)(?:pytest|jest|vitest|mocha|ava|karma|jasmine|nyc|c8|tap|tape|rspec|minitest|phpunit|behave|nose2?|ginkgo|gotestsum|nextest)\b|\b(?:go|cargo|swift|dart|flutter|deno|bun|dotnet|mix|lein|sbt|gradlew?|mvn)\s+test\b|\bunittest\b|-m\s+(?:pytest|unittest)\b|\bnode\s+--test\b|(?:^|&&|;|\|)\s*(?:npm|pnpm|yarn|bun|npx)\b[^&;|]*?\btest\b/;

export function looksLikeTestSuiteCommand(cmd) {
  return typeof cmd === "string" && TEST_SUITE_COMMAND.test(cmd);
}

export function parseCollectedTests(stdout = "", stderr = "") {
  const text = `${stdout || ""}\n${stderr || ""}`;
  if (!text.trim()) return { count: null, runner: null };

  // A stated count wins over a phrase that merely resembles one.
  //
  // `EXPLICIT_ZERO` used to be consulted first, so any output containing the
  // words "no tests found" was read as a zero — including a healthy TAP run
  // of 190 passing tests whose one skipped fixture printed
  // `# SKIP no tests found`. The gate rejected the suite as empty and named
  // Jest as the runner, in a repository that does not use Jest. A phrase
  // appears anywhere in a stream; a count is stated deliberately, so the
  // count is the better witness and has to be asked first.
  for (const rule of COUNT_PATTERNS) {
    const m = rule.re.exec(text);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n)) return { count: n, runner: rule.name };
  }

  // Go states absence per package rather than as a count, so it needs its own
  // pass before the generic patterns.
  if (GO_NO_TEST_FILES.test(text) || GO_RAN_SOMETHING.test(text)) {
    // Only a run where *no* package did anything is a zero: a monorepo where
    // one package has no tests and three do is a normal, healthy repository.
    if (!GO_RAN_SOMETHING.test(text)) return { count: 0, runner: "go" };
    // Something ran. `--- PASS:` lines are per-test but appear only under -v,
    // so their absence means the count was not stated — not that it was zero.
    // Reporting zero here would have failed every ordinary `go test ./...`.
    const perTest = text.match(GO_PER_TEST);
    return { count: perTest && perTest.length > 0 ? perTest.length : null, runner: "go" };
  }

  // Only now: no runner stated a number, so a declared absence is all there is.
  for (const rule of EXPLICIT_ZERO) {
    if (rule.re.test(text)) return { count: 0, runner: rule.name };
  }

  return { count: null, runner: null };
}

/**
 * Decide whether a passing verification command actually verified anything.
 *
 * @param {object} testResult - the test stage's result ({ ok, stdout, stderr, command })
 * @param {object} [opts]
 * @param {number} [opts.minTests=1] - the floor, from `verify.minTests`.
 * @returns {{ ok: boolean, count: number|null, runner: string|null, reason: string|null }}
 */
export function checkCollectionFloor(testResult, opts = {}) {
  const minTests = Number.isFinite(opts.minTests) ? opts.minTests : 1;
  if (minTests <= 0) return { ok: true, count: null, runner: null, reason: null };
  // Only a *passing* command can lie about this. A failing one already fails.
  if (!testResult || testResult.ok !== true) {
    return { ok: true, count: null, runner: null, reason: null };
  }

  // A command that says it runs a suite, and printed nothing, ran no suite.
  //
  // Both halves are required. Silence alone would hard-red `tsc --noEmit` and
  // `python3 -m compileall`, which are honest static gates this kit generates
  // itself; the command shape alone would say nothing, because a real suite
  // prints. Together they are decidable, and they are exactly `pnpm -r test`
  // on a workspace whose packages declare no test script.
  if (looksLikeTestSuiteCommand(testResult.command) && producedNoOutput(testResult.stdout, testResult.stderr)) {
    return {
      ok: false,
      count: 0,
      runner: null,
      silent: true,
      reason:
        `The verification command ${testResult.command ? `${JSON.stringify(testResult.command)} ` : ""}` +
        `exited 0 and wrote nothing at all — no test names, no summary, no count. ` +
        `Every test runner prints something, so this command ran no suite, and approving this change ` +
        `would certify nothing. A workspace command such as \`pnpm -r test\` does this when no package ` +
        `declares a test script. Point verify.test at the suite that covers this repository ` +
        `(often the root script rather than the recursive one), or — if this repository intentionally ` +
        `uses only the scope and secret phases — set verify.required: false, which says so on the record.`,
    };
  }

  const { count, runner } = parseCollectedTests(testResult.stdout, testResult.stderr);

  // Deliberately one-sided: only a *stated* zero fails, because failing on
  // "I could not tell" would break every runner not on the list. But passing
  // and saying nothing makes `echo "all tests passed"` indistinguishable from
  // a real suite, so the absence of evidence is reported as an absence.
  if (count === null) {
    return {
      ok: true,
      count: null,
      runner: null,
      reason: null,
      unverified: true,
      note:
        `The verification command exited 0, but no recognised test runner stated how many tests it ran, ` +
        `so the gate cannot tell a full suite from a command that ran nothing. Verified by exit code alone.`,
    };
  }
  if (count >= minTests) {
    return { ok: true, count, runner, reason: null };
  }

  return {
    ok: false,
    count,
    runner,
    reason:
      `The verification command exited 0 without running any tests` +
      (runner ? ` (${runner} reported ${count})` : "") +
      `, so this change was approved against nothing. ` +
      `Point verify.test at a suite that covers this repository, lower the floor with verify.minTests, ` +
      `or — if this repository intentionally uses only the scope and secret phases — set verify.required: false.`,
  };
}
