/**
 * The policy this kit claims to enforce, written by hand.
 *
 * Every entry here is derived from what the tool *advertises* — the stacks
 * `detectStack` declares, the layouts each ecosystem actually uses — and never
 * from the regexes, path lists or registries that implement the checks. That
 * separation is the whole point: a contract generated from the implementation
 * makes the implementation its own oracle, and an implementation that is its
 * own oracle cannot be wrong.
 *
 * This is what the substring bug in the file classifier cost. `isTestFile`
 * matched `/test/`, which does not occur in `tests/test_calc.py`, so the entire
 * tamper guard was off for the standard pytest, Rust and RSpec layouts — and
 * every mechanism that should have caught it (a large suite, a doc-sync gate,
 * a nine-way CI matrix, two cold reviews, a blocking release) was sampling the
 * same distribution the implementation was written from. Nine runs of
 * `test/foo.test.js` do not explore `tests/test_calc.py`.
 *
 * Adding a stack to `detectStack` is not finished until it has a row here.
 */

/**
 * Paths the policy says are test files, and near-misses it says are not.
 *
 * The near-misses matter as much as the hits: a predicate that answers "yes"
 * to everything also has no denominator.
 */
export const TEST_PATH_CASES = [
  // Node / JavaScript
  { path: "test/calc.test.js", expected: true, why: "node, conventional" },
  { path: "src/calc.spec.ts", expected: true, why: "co-located spec" },
  { path: "src/__tests__/calc.js", expected: true, why: "jest convention" },
  // Python
  { path: "tests/test_calc.py", expected: true, why: "pytest, repository root — the reported gap" },
  { path: "test/test_calc.py", expected: true, why: "pytest, singular directory" },
  { path: "backend/tests/test_api.py", expected: true, why: "pytest, nested" },
  // Go
  { path: "internal/calc/calc_test.go", expected: true, why: "go, co-located with the code" },
  { path: "cmd/api/main_test.go", expected: true, why: "go, command package" },
  // Rust
  { path: "tests/integration.rs", expected: true, why: "rust integration tests" },
  // Ruby
  { path: "spec/models/user_spec.rb", expected: true, why: "rspec" },
  { path: "test/user_test.rb", expected: true, why: "minitest" },
  // JVM / .NET / PHP
  { path: "src/test/java/com/x/CalcTest.java", expected: true, why: "maven layout" },
  { path: "tests/Unit/CalcTest.php", expected: true, why: "phpunit" },
  // Solidity
  { path: "test/Token.t.sol", expected: true, why: "foundry" },
  // Monorepo position
  { path: "packages/api/test/handler.test.js", expected: true, why: "monorepo package" },

  // Near-misses: segment match, not substring
  { path: "latest/build.js", expected: false, why: "`latest` is not `test`" },
  { path: "contest/result.js", expected: false, why: "`contest` is not `test`" },
  { path: "lib/myspec/render.js", expected: false, why: "`myspec` is not `spec`" },
  { path: "src/attestation.js", expected: false, why: "contains 'test', is not one" },
  { path: "src/index.js", expected: false, why: "ordinary source" },
  { path: "docs/testing-guide.md", expected: false, why: "documentation about testing" },
];

/**
 * Known-bad diffs, one per guard rule, each with the finding it MUST produce.
 *
 * A canary that comes back clean is not a passing test — it is proof that the
 * rule it names has stopped being reachable. `layout` is deliberately varied
 * across ecosystems so that a canary set cannot be green by only ever handing
 * the guard the layout the implementation was written from.
 */
export const TAMPER_CANARIES = [
  {
    id: "skip-injection/node",
    file: "test/calc.test.js",
    removed: [],
    added: ['it.skip("adds", () => { assert.equal(add(1,2), 3); });'],
    expect: "TEST_SKIP_INJECTION",
  },
  {
    id: "vacuous/node",
    file: "test/calc.test.js",
    removed: ["assert.equal(add(1, 2), 3);"],
    added: ["assert.ok(true);"],
    expect: "VACUOUS_ASSERTION",
  },
  {
    id: "commented/node",
    file: "test/calc.test.js",
    removed: ["assert.equal(add(1, 2), 3);"],
    added: ["// assert.equal(add(1, 2), 3);"],
    expect: "COMMENTED_ASSERTION",
  },
  {
    id: "removal/node",
    file: "test/calc.test.js",
    removed: ["assert.equal(add(1, 2), 3);", "assert.equal(add(2, 2), 4);"],
    added: [],
    expect: "ASSERTION_REMOVAL",
  },
  {
    id: "weakening/node",
    file: "test/calc.test.js",
    removed: ["assert.strictEqual(add(1, 2), 3);"],
    added: ["assert.ok(add(1, 2) !== undefined);"],
    expect: "ASSERTION_WEAKENED",
  },
  {
    id: "expectation/node",
    file: "test/calc.test.js",
    removed: ["assert.equal(add(1, 2), 3);"],
    added: ["assert.equal(add(1, 2), -1);"],
    expect: "ASSERTION_EXPECTATION_CHANGED",
  },
  // The same attacks, in the layouts the classifier used to be blind to.
  // These are the canaries that would have failed before v0.59.0.
  {
    id: "expectation/pytest-root",
    file: "tests/test_calc.py",
    removed: ["    self.assertEqual(add(1, 2), 3)"],
    added: ["    self.assertEqual(add(1, 2), -1)"],
    expect: "ASSERTION_EXPECTATION_CHANGED",
  },
  {
    id: "skip-injection/pytest-root",
    file: "tests/test_calc.py",
    removed: [],
    added: ["@pytest.mark.skip", "def test_add():"],
    expect: "TEST_SKIP_INJECTION",
  },
  {
    id: "expectation/rust",
    file: "tests/integration.rs",
    removed: ["    assert_eq!(add(1, 2), 3);"],
    added: ["    assert_eq!(add(1, 2), -1);"],
    expect: "ASSERTION_EXPECTATION_CHANGED",
  },
  {
    id: "expectation/go-colocated",
    file: "internal/calc/calc_test.go",
    removed: ['\t\tt.Errorf("got %d want %d", got, 3)'],
    added: ['\t\tt.Errorf("got %d want %d", got, 999)'],
    expect: "ASSERTION_EXPECTATION_CHANGED",
  },
  {
    id: "removal/monorepo",
    file: "packages/api/test/handler.test.js",
    removed: ["expect(handler(req)).toBe(200);", "expect(handler(bad)).toBe(400);"],
    added: [],
    expect: "ASSERTION_REMOVAL",
  },
];

/**
 * Mutants of the applicability predicate.
 *
 * Each one must kill at least one canary. A mutant that survives means no
 * canary ever required the guard to *activate* — the suite would stay green if
 * the guard silently stopped looking, which is precisely the defect.
 *
 * These are hand-written rather than generated: the original bug was not an
 * untested branch, it was a branch nobody wrote, and no mutation operator
 * invents the case the code never handled.
 */
export const PREDICATE_MUTANTS = [
  { id: "alwaysFalse", fn: () => false, why: "the guard looks at nothing" },
  { id: "rootBlind", fn: (p) => String(p).includes("/test/"), why: "the original substring bug" },
  { id: "nodeOnly", fn: (p) => /\.(test|spec)\.[jt]sx?$/.test(String(p)), why: "only the layout the code was written from" },
  { id: "caseSensitive", fn: (p) => String(p) === String(p).toLowerCase() && /(^|\/)tests?\//.test(String(p)), why: "case and separator drift" },
];

/** Runner outputs that state zero collected tests, per ecosystem. */
export const EMPTY_RUN_CANARIES = [
  { id: "pytest", output: "collected 0 items\n\nno tests ran in 0.01s" },
  { id: "jest", output: "No tests found, exiting with code 0" },
  { id: "vitest", output: "No test files found, exiting with code 0" },
  { id: "cargo", output: "running 0 tests\ntest result: ok. 0 passed" },
  { id: "mocha", output: "  0 passing (1ms)" },
  { id: "go", output: "?   example.com/app\t[no test files]" },
  { id: "surefire", output: "Tests run: 0, Failures: 0, Errors: 0, Skipped: 0" },
  { id: "gradle", output: "> Task :test NO-SOURCE" },
  { id: "phpunit", output: "No tests executed!" },
  { id: "rspec", output: "0 examples, 0 failures" },
  { id: "dotnet", output: "Total tests: 0" },
  { id: "xctest", output: "Executed 0 tests" },
  { id: "ctest", output: "No tests were found!!!" },
];

/** Paths the policy says an agent must never modify without an override. */
export const SCOPE_CANARIES = [
  { path: ".github/workflows/ci.yml", rule: "deny", why: "runs with repo credentials" },
  { path: ".gitlab-ci.yml", rule: "deny", why: "same, another forge" },
  { path: "Jenkinsfile", rule: "deny", why: "same, another forge" },
  { path: ".envrc", rule: "deny", why: "direnv executes it on cd" },
  { path: "package-lock.json", rule: "protect", why: "decides which code installs" },
  { path: "Cargo.lock", rule: "protect", why: "same, another ecosystem" },
  { path: "conftest.py", rule: "protect", why: "runs before every pytest collection" },
  { path: "jest.config.js", rule: "protect", why: "decides which tests run" },
  { path: "CODEOWNERS", rule: "protect", why: "decides who must approve" },
];
