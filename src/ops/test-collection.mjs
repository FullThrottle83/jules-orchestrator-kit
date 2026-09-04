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
];

/** Go prints this per package that has no test files at all. */
const GO_NO_TEST_FILES = /\[no test files\]/;
/** Any sign that a Go package did run tests. */
const GO_RAN_SOMETHING = /^(?:ok|FAIL|---\s+(?:PASS|FAIL|SKIP)):?\s/m;

/**
 * Read a collected-test count out of a runner's output.
 *
 * @param {string} [stdout]
 * @param {string} [stderr]
 * @returns {{ count: number|null, runner: string|null }}
 *   `count` is null when no recognised runner stated one — which is not a
 *   finding, only an absence of evidence.
 */
export function parseCollectedTests(stdout = "", stderr = "") {
  const text = `${stdout || ""}\n${stderr || ""}`;
  if (!text.trim()) return { count: null, runner: null };

  for (const rule of EXPLICIT_ZERO) {
    if (rule.re.test(text)) return { count: 0, runner: rule.name };
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

  for (const rule of COUNT_PATTERNS) {
    const m = rule.re.exec(text);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n)) return { count: n, runner: rule.name };
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

  const { count, runner } = parseCollectedTests(testResult.stdout, testResult.stderr);
  if (count === null || count >= minTests) {
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
