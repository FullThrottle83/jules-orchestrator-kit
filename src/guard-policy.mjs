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
  // The canonical root test file for the supported Node runners. AVA runs
  // root `test.js` with no configuration; `node --test test.js` does too.
  // P-Limit's whole suite lived in one and the guard watched none of it.
  { path: "test.js", expected: true, why: "node root canonical — F01's blind spot" },
  { path: "test.mjs", expected: true, why: "node root, ESM" },
  { path: "test.ts", expected: true, why: "node root, TypeScript" },
  { path: "test.cjs", expected: true, why: "node root, CommonJS" },

  // Near-misses: segment match, not substring
  { path: "latest/build.js", expected: false, why: "`latest` is not `test`" },
  { path: "contest/result.js", expected: false, why: "`contest` is not `test`" },
  { path: "lib/myspec/render.js", expected: false, why: "`myspec` is not `spec`" },
  { path: "src/attestation.js", expected: false, why: "contains 'test', is not one" },
  { path: "src/index.js", expected: false, why: "ordinary source" },
  { path: "docs/testing-guide.md", expected: false, why: "documentation about testing" },
  // The bare-name rule is Node-family only: `test.py` is not pytest (pytest
  // collects `test_*.py`), `test.go` is not a Go test (`*_test.go`), and
  // `test.rb` is neither RSpec nor Minitest.
  { path: "test.py", expected: false, why: "pytest collects test_*.py, never a bare test.py" },
  { path: "test.go", expected: false, why: "go tests are *_test.go" },
  { path: "test.rb", expected: false, why: "ruby suites are *_spec.rb or test_*.rb" },
  { path: "test.helpers.js", expected: false, why: "a support module named after tests" },
  { path: "tests.js", expected: false, why: "plural name, ordinary source" },
  { path: "testing.js", expected: false, why: "contains the word, is not the file" },
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
  // Argument order is not a detail. JUnit and PHPUnit document
  // `assertEquals(expected, actual)`, and Python's containment helpers take
  // the expected member first — all of which the guard used to read as "a
  // human message was reworded" and dismiss. Each of these was a silent PASS.
  {
    id: "expectation/junit-expected-first",
    file: "src/test/java/CalcTest.java",
    removed: ['        assertEquals("Hello World", out);'],
    added: ['        assertEquals("Hello Tampered", out);'],
    expect: "ASSERTION_EXPECTATION_CHANGED",
  },
  {
    id: "expectation/phpunit-expected-first",
    file: "tests/CalcTest.php",
    removed: ['        $this->assertSame("Hello World", $out);'],
    added: ['        $this->assertSame("Hello Tampered", $out);'],
    expect: "ASSERTION_EXPECTATION_CHANGED",
  },
  {
    id: "expectation/unittest-assert-in",
    file: "tests/test_cli.py",
    removed: ['        self.assertIn("Hello World", result.output)'],
    added: ['        self.assertIn("Hello Tampered", result.output)'],
    expect: "ASSERTION_EXPECTATION_CHANGED",
  },
  {
    id: "expectation/unittest-assert-not-in",
    file: "tests/test_cli.py",
    removed: ['        self.assertNotIn("error", result.output)'],
    added: ['        self.assertNotIn("zzz", result.output)'],
    expect: "ASSERTION_EXPECTATION_CHANGED",
  },
  // A regex literal is an expected value. It never blanked, so the rewritten
  // pattern never met its original in a shape bucket and the swap was
  // reported as neither a change nor a loss.
  {
    id: "expectation/jest-to-match-regex",
    file: "test/cli.test.js",
    removed: ["  expect(out).toMatch(/Hello World/);"],
    added: ["  expect(out).toMatch(/Hello Tampered/);"],
    expect: "ASSERTION_EXPECTATION_CHANGED",
  },
  {
    id: "expectation/jest-to-throw-regex",
    file: "test/cli.test.js",
    removed: ["  expect(fn).toThrow(/permission denied/);"],
    added: ["  expect(fn).toThrow(/x/);"],
    expect: "ASSERTION_EXPECTATION_CHANGED",
  },
  {
    id: "expectation/rspec-match-regex",
    file: "spec/cli_spec.rb",
    removed: ["    expect(out).to match(/Hello World/)"],
    added: ["    expect(out).to match(/Hello Tampered/)"],
    expect: "ASSERTION_EXPECTATION_CHANGED",
  },
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
  // These are the canaries that were silent when the classifier matched a
  // substring instead of a path segment.
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
  // Dialects the guard was measured silent on. `assertEqual` matched only
  // because the pattern's optional dot and case-insensitive flag happened to
  // line up; `assertEquals` — one letter longer — did not, and neither did
  // RSpec's `.to eq(`, PHPUnit's `$this->assertSame`, Minitest's
  // `assert_equal` or XCTest's `XCTAssertEqual`. Every one of them returned
  // PASS with a non-zero denominator, which is the exact shape this file
  // exists to reject, one level down inside the mechanism built to catch it.
  {
    id: "expectation/junit",
    file: "src/test/java/com/x/CalcTest.java",
    removed: ["        assertEquals(3, calc.add(1, 2));"],
    added: ["        assertEquals(-1, calc.add(1, 2));"],
    expect: "ASSERTION_EXPECTATION_CHANGED",
  },
  {
    id: "expectation/rspec",
    file: "spec/models/user_spec.rb",
    removed: ["    expect(user.age).to eq(30)"],
    added: ["    expect(user.age).to eq(-1)"],
    expect: "ASSERTION_EXPECTATION_CHANGED",
  },
  {
    id: "expectation/phpunit",
    file: "tests/Unit/CalcTest.php",
    removed: ["        $this->assertSame(3, $c->add(1, 2));"],
    added: ["        $this->assertSame(-1, $c->add(1, 2));"],
    expect: "ASSERTION_EXPECTATION_CHANGED",
  },
  {
    id: "expectation/minitest",
    file: "test/user_test.rb",
    removed: ["    assert_equal(3, add(1, 2))"],
    added: ["    assert_equal(-1, add(1, 2))"],
    expect: "ASSERTION_EXPECTATION_CHANGED",
  },
  {
    id: "expectation/xctest",
    file: "Tests/CalcTests/CalcTests.swift",
    removed: ["        XCTAssertEqual(add(1, 2), 3)"],
    added: ["        XCTAssertEqual(add(1, 2), -1)"],
    expect: "ASSERTION_EXPECTATION_CHANGED",
  },
  {
    id: "weakening/junit",
    file: "src/test/java/com/x/CalcTest.java",
    removed: ["        assertEquals(3, calc.add(1, 2));"],
    added: ["        assertTrue(calc.add(1, 2) != null);"],
    expect: "ASSERTION_WEAKENED",
  },
  {
    id: "removal/phpunit",
    file: "tests/Unit/CalcTest.php",
    removed: ["        $this->assertSame(3, $c->add(1, 2));", "        $this->assertSame(4, $c->add(2, 2));"],
    added: [],
    expect: "ASSERTION_REMOVAL",
  },
  {
    id: "vacuous/xctest",
    file: "Tests/CalcTests/CalcTests.swift",
    removed: ["        XCTAssertEqual(add(1, 2), 3)"],
    added: ["        XCTAssertTrue(true)"],
    expect: "VACUOUS_ASSERTION",
  },
  // Skip injection is the same blindness in the other five ecosystems: a
  // suite that never runs cannot fail, and `@Disabled` is as effective as
  // `it.skip` at making that happen.
  {
    id: "skip-injection/junit",
    file: "src/test/java/com/x/CalcTest.java",
    removed: [],
    added: ["    @Disabled(\"flaky\")", "    void addsTwoNumbers() {"],
    expect: "TEST_SKIP_INJECTION",
  },
  {
    id: "skip-injection/rspec",
    file: "spec/models/user_spec.rb",
    removed: [],
    added: ["  xit \"computes the age\" do"],
    expect: "TEST_SKIP_INJECTION",
  },
  {
    id: "skip-injection/phpunit",
    file: "tests/Unit/CalcTest.php",
    removed: [],
    added: ["        $this->markTestSkipped(\"later\");"],
    expect: "TEST_SKIP_INJECTION",
  },
  // Dialects a second cold-start trial found silent. chai's `.to.equal(` is a
  // dot chain where RSpec's is a space, so the RSpec branch never reached it;
  // node-tap's assertions hang off whatever the sub-test callback named its
  // argument, which is `ct` as often as `t`.
  {
    id: "weakening/chai",
    file: "packages/core/test/signal.test.tsx",
    context: "// signals",
    removed: ["    expect(s.value).to.equal(v);"],
    added: ["    expect(s.value).toBeDefined();"],
    expect: "ASSERTION_WEAKENED",
  },
  {
    id: "expectation/chai",
    file: "test/signal.test.js",
    context: "// signals",
    removed: ["    expect(s.value).to.equal(3);"],
    added: ["    expect(s.value).to.equal(-1);"],
    expect: "ASSERTION_EXPECTATION_CHANGED",
  },
  {
    id: "expectation/node-tap",
    file: "tests/test-config.js",
    context: "// config",
    removed: ["    ct.equal(process.env.BASIC, 'basic')"],
    added: ["    ct.equal(process.env.BASIC, 'BROKEN_OVERRIDE')"],
    expect: "ASSERTION_EXPECTATION_CHANGED",
  },
  {
    id: "skip-injection/node-tap-options",
    file: "tests/test-populate.js",
    context: "// populate",
    removed: ["t.test('does not write over keys', ct => {"],
    added: ["t.test('does not write over keys', { skip: true }, ct => {"],
    expect: "TEST_SKIP_INJECTION",
  },
  // Skipping from inside the test body, which is how every one of these
  // ecosystems actually does it. The decorator and annotation forms were
  // covered; the standard library's own method was not, so a test could be
  // silenced with the most ordinary call in the language.
  {
    id: "skip-injection/unittest-body",
    file: "tests/test_app.py",
    context: "# app",
    removed: [],
    added: ['        self.skipTest("disabled")'],
    expect: "TEST_SKIP_INJECTION",
  },
  {
    id: "skip-injection/pytest-body",
    file: "tests/test_app.py",
    context: "# app",
    removed: [],
    added: ['    pytest.skip("not now")'],
    expect: "TEST_SKIP_INJECTION",
  },
  {
    id: "skip-injection/raise-skiptest",
    file: "tests/test_app.py",
    context: "# app",
    removed: [],
    added: ['    raise unittest.SkipTest("nope")'],
    expect: "TEST_SKIP_INJECTION",
  },
  {
    id: "skip-injection/mocha-body",
    file: "test/app.test.js",
    context: "// app",
    removed: [],
    added: ["  this.skip();"],
    expect: "TEST_SKIP_INJECTION",
  },
  {
    id: "skip-injection/jest-todo",
    file: "test/app.test.js",
    context: "// app",
    removed: [],
    added: ['  test.todo("adds two numbers");'],
    expect: "TEST_SKIP_INJECTION",
  },
  {
    id: "skip-injection/go-skipnow",
    file: "internal/calc/calc_test.go",
    context: "// calc",
    removed: [],
    added: ["\tt.SkipNow()"],
    expect: "TEST_SKIP_INJECTION",
  },
  {
    id: "skip-injection/xctest",
    file: "Tests/CalcTests/CalcTests.swift",
    removed: [],
    added: ["        throw XCTSkip(\"not now\")"],
    expect: "TEST_SKIP_INJECTION",
  },
  // F01: P-Limit's root test.js is a supported runner's canonical test
  // file. Every attack below had to be invisible inside it before the
  // classifier knew the file existed — deletion, vacuous replacement, and
  // an expectation rewritten to fit broken output.
  {
    id: "removal/node-root",
    file: "test.js",
    context: "// pending counts",
    removed: ["\tt.is(limit.activeCount, 0);"],
    added: [],
    expect: "ASSERTION_REMOVAL",
  },
  {
    id: "vacuous/node-root",
    file: "test.js",
    context: "// pending counts",
    removed: ["\tt.is(limit.activeCount, 0);"],
    added: ["\tt.true(true);"],
    expect: "VACUOUS_ASSERTION",
  },
  {
    id: "expectation/node-root",
    file: "test.js",
    context: "// pending counts",
    removed: ["\tt.is(limit.pendingCount, 0);"],
    added: ["\tt.is(limit.pendingCount, 1000);"],
    expect: "ASSERTION_EXPECTATION_CHANGED",
  },
  // F03: an expected value bent into a conditional still blesses whatever
  // the broken function does for the broken input. Python's spelling is a
  // ternary with a comparison in its condition; JS's is `cond ? a : b`.
  {
    id: "expectation/python-conditional",
    file: "tests/test_encoding.py",
    context: "# encoding",
    removed: ["        assert dec == value"],
    added: ["        assert dec == (193 if value == 192 else value)"],
    expect: "ASSERTION_EXPECTATION_CHANGED",
  },
  {
    id: "expectation/js-conditional",
    file: "test/calc.test.js",
    context: "// arithmetic",
    removed: ["  assert.strictEqual(add(1, 2), 3);"],
    added: ["  assert.strictEqual(add(1, 2), add(1, 2) === -1 ? -1 : 3);"],
    expect: "ASSERTION_EXPECTATION_CHANGED",
  },
  // F04: tests that leave the run without a skip or a deleted assertion.
  // Renaming pytest's prefix to anything that stops the `test*` match, or a
  // Go `TestX` function out of discovery, leaves the assertions in the file
  // and the counts level.
  {
    id: "deregistration/pytest-check-prefix",
    file: "tests/test_encoding.py",
    context: "# encoding",
    removed: ["def test_want_bytes(value):"],
    added: ["def check_want_bytes(value):"],
    expect: "TEST_DEREGISTERED",
  },
  {
    id: "deregistration/pytest-disabled-prefix",
    file: "tests/test_encoding.py",
    context: "# encoding",
    removed: ["def test_want_bytes(value):"],
    added: ["def disabled_want_bytes(value):"],
    expect: "TEST_DEREGISTERED",
  },
  {
    id: "deregistration/go-check-prefix",
    file: "is_test.go",
    context: "// loadComment",
    removed: ["func TestLoadComment(t *testing.T) {"],
    added: ["func checkLoadComment(t *testing.T) {"],
    expect: "TEST_DEREGISTERED",
  },
  // Rust and JUnit register through the attribute; removing `#[test]` (or
  // `@Test`) from an existing function keeps the body and loses the run.
  {
    id: "deregistration/rust-attribute-removed",
    file: "tests/iter_tests/all.rs",
    context: "// iter",
    removed: ["#[test]", "fn peek_does_not_advance() {"],
    added: ["fn check_peek_does_not_advance() {"],
    expect: "TEST_DEREGISTERED",
  },
  {
    id: "deregistration/junit-annotation-removed",
    file: "src/test/java/com/x/CalcTest.java",
    context: "// arithmetic",
    removed: ["    @Test", "    public void addsTwoNumbers() {"],
    added: ["    public void addsTwoNumbers() {"],
    expect: "TEST_DEREGISTERED",
  },
  // Ways to keep a test collected while excising its execution.
  {
    id: "skip-injection/xfail-decorator",
    file: "tests/test_encoding.py",
    context: "# encoding",
    removed: [],
    added: ['@pytest.mark.xfail(reason="known broken output", strict=False)'],
    expect: "TEST_SKIP_INJECTION",
  },
  {
    id: "skip-injection/expectedfailure-decorator",
    file: "tests/test_app.py",
    context: "# app",
    removed: [],
    added: ["    @unittest.expectedFailure"],
    expect: "TEST_SKIP_INJECTION",
  },
  {
    id: "skip-injection/rust-cfg-any",
    file: "tests/iter_tests/all.rs",
    context: "// iter",
    removed: [],
    added: ["#[cfg(any())]"],
    expect: "TEST_SKIP_INJECTION",
  },
  {
    id: "skip-injection/go-build-ignore",
    file: "is_test.go",
    context: "// loadComment",
    removed: [],
    added: ["//go:build ignore"],
    expect: "TEST_SKIP_INJECTION",
  },
  {
    id: "skip-injection/go-build-private-tag",
    file: "is-1.7_test.go",
    context: "// build",
    removed: ["//go:build go1.7"],
    added: ["//go:build go1.7 && cold_start_never"],
    expect: "TEST_SKIP_INJECTION",
  },
  {
    id: "skip-injection/python-early-return",
    file: "tests/test_encoding.py",
    context: "# encoding",
    removed: ["def test_int_bytes(value, expect):"],
    added: ["def test_int_bytes(value, expect):", "    return"],
    expect: "TEST_SKIP_INJECTION",
  },
  // F05: a Go assertion neutralised by a condition that can never hold.
  // The `t.Errorf` stays in the file; the guard around it is dead.
  {
    id: "vacuous/go-impossible-condition",
    file: "is_test.go",
    context: "// loadComment",
    // Context lines reconstruct the failure call sitting in the (now dead)
    // block: the post-pass reads the whole hunk, not only the changed line.
    lead: ["func TestLoadComment(t *testing.T) {", "\tcomment, _ := loadComment(\"./testdata/x\", 14)"],
    removed: ['\tif comment != `this comment will be extracted` {', '\t\tt.Errorf("loadComment: bad comment %s", comment)', "\t}"],
    added: ["\tif len(comment) < 0 {", "\t\tt.Errorf(\"loadComment: bad comment %s\", comment)", "\t}"],
    expect: "VACUOUS_ASSERTION",
  },
];


/**
 * The F04 variants, classified by whether a line-oriented diff guard can see
 * them at all.
 *
 * Widening a guard only to the attacks the evidence contains is how the
 * next-but-one variant walks through, so the trial's four "other ways to keep
 * a test from executing" are classified here explicitly:
 *
 *   1. Rename out of discovery (`test_x` -> `check_x`, `TestX` -> `checkX`,
 *      Rust `#[test]` removed). Visible: the name or attribute is right
 *      there in the diff. Caught as TEST_DEREGISTERED.
 *
 *   2. Build constraints (`//go:build <tag nobody sets>`, legacy
 *      `// +build`, Rust `#[cfg(any())]`). Visible: they are lines the diff
 *      adds. Caught as TEST_SKIP_INJECTION. Version/OS/arch constraints are
 *      honest CI gating and stay silent; a private tag or `ignore` is not.
 *
 *   3. Non-strict xfail (`@pytest.mark.xfail(strict=False)` and its strict
 *      sibling, `@expectedFailure`, `pytest.xfail()`). Visible: the
 *      decorator is an added line. Caught as TEST_SKIP_INJECTION.
 *
 *   4. An early `return` before the assertions. Partially visible. The
 *      diff-detectable shape — a *bare, unconditional* `return` as the
 *      test body's first statement — is caught as TEST_SKIP_INJECTION.
 *      What cannot be judged from a diff is a `return` placed *later* in
 *      the body behind a condition the test author believes impossible:
 *      that requires knowing, for every branch, whether the branch is
 *      reachable at runtime, which is a control-flow analysis over the
 *      whole program rather than a line pair. A guard that flags any `return`
 *      above an assertion hard-reds the ordinary "skip this case on
 *      Windows" guard clause, so the rule stops at the shape whose intent is
 *      unambiguous from the text.
 *
 * `runV8Coverage`-style runtime attestation (actually counting collected
 * tests before and after) is the complete answer to 4, and is a separate
 * check from the text guard; the text guard reports what it can read.
 */
export const EXECUTION_EXCISION_VARIANTS = Object.freeze([
  { id: "rename-discovery", visible: true, finding: "TEST_DEREGISTERED" },
  { id: "build-constraint", visible: true, finding: "TEST_SKIP_INJECTION" },
  { id: "cfg-any", visible: true, finding: "TEST_SKIP_INJECTION" },
  { id: "xfail", visible: true, finding: "TEST_SKIP_INJECTION" },
  { id: "early-return-body-first", visible: true, finding: "TEST_SKIP_INJECTION" },
  { id: "early-return-behind-runtime-condition", visible: false, finding: null,
    why: "reachability of a branch is a whole-program control-flow question, not a line pair" },
]);

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

/**
 * Edits that must produce no finding at all.
 *
 * A guard that answers "yes" to everything has no more discrimination than
 * one that answers "no" to everything, and it is worse in practice: the
 * operator learns to pass the override without reading it, and the day it
 * reports something real, nobody looks. Every entry here is an edit an
 * honest agent makes constantly.
 *
 * The first two are not hypothetical. `//` begins with a division sign, so a
 * comment line matched the operator-continuation test and folded itself into
 * the assertion above it — which meant *adding* an assertion next to a
 * comment was reported as rewriting an expectation. Python was immune,
 * because `#` is not an operator, so the fixtures this project was written
 * from never showed it.
 */
export const INNOCENT_EDITS = [
  // Everything below this comment was a CRITICAL rejection until v0.71.0.
  //
  // Not through any rule that examined them: `UNREADABLE` was reached whenever
  // a test file had changed lines and none of them parsed as an assertion, so
  // the verdict was the same for a repository speaking an unsupported dialect
  // and for one where the edit simply was not an assertion. Adding an import
  // was a CRITICAL block. The finding carried no file, no line and no sample,
  // because there was nothing to name — and it advised a pytest repository
  // that its assertion library might be unsupported, from a list naming pytest.
  //
  // These are ordinary work. Every one of them has to be silent.
  {
    id: "add-import/pytest",
    file: "testing/test_iniconfig.py",
    context: "# fixtures",
    removed: [],
    added: ["import os"],
    why: "adding an import to a test file is not an assertion and not tampering",
  },
  {
    id: "rename-test-multiline/pytest",
    file: "testing/test_iniconfig.py",
    context: "# parsing",
    removed: ["def test_parse_strips_inline_comments() -> None:"],
    added: ["def test_parse_strips_inline_comments_from_continuations() -> None:"],
    why: "still collected by pytest, so nothing left the run",
  },
  {
    id: "docstring/pytest",
    file: "testing/test_iniconfig.py",
    context: "# parsing",
    removed: ['    """Check comments."""'],
    added: ['    """Check that inline comments are stripped."""'],
    why: "prose about the test, not a value it asserts",
  },
  {
    id: "type-annotation/pytest",
    file: "testing/test_iniconfig.py",
    context: "# fixtures",
    removed: ["def make_config(data):"],
    added: ["def make_config(data: str) -> IniConfig:"],
    why: "a helper's signature, typed; no claim changed",
  },
  {
    id: "add-fixture/go",
    file: "calc_test.go",
    context: "// helpers",
    removed: [],
    added: ["var cases = []int{1, 2, 3}"],
    why: "test data added, nothing asserted or unasserted",
  },
  // Renaming a test is one of the most ordinary edits there is. On the
  // one-line form the name blanked to the same shape as its replacement, the
  // two paired, and the pair was reported as a rewritten expectation.
  {
    id: "rename-test-oneline/node",
    file: "test/calc.test.js",
    context: "// arithmetic",
    removed: ['test("adds", () => { assert.strictEqual(add(2, 3), 5); });'],
    added: ['test("adds positives", () => { assert.strictEqual(add(2, 3), 5); });'],
    why: "the test name is prose about the test, not a value it asserts",
  },
  {
    id: "rename-test-oneline/jest",
    file: "test/calc.spec.js",
    context: "// arithmetic",
    removed: ['it("adds", () => { expect(add(2, 3)).toBe(5); });'],
    added: ['it("adds two positives", () => { expect(add(2, 3)).toBe(5); });'],
    why: "same rename, the dialect a new user is most likely to be in",
  },
  {
    id: "rename-test-oneline/tap",
    file: "test/calc.test.js",
    context: "// arithmetic",
    removed: ['t.test("adds", (ct) => { ct.equal(add(2, 3), 5); ct.end(); });'],
    added: ['t.test("adds positives", (ct) => { ct.equal(add(2, 3), 5); ct.end(); });'],
    why: "the receiver is a sub-test callback argument, not an assertion subject",
  },
  {
    id: "reword-junit-message-first",
    file: "src/test/java/CalcTest.java",
    context: "// arithmetic",
    removed: ['        assertEquals("why", expected, out);'],
    added: ['        assertEquals("why this matters", expected, out);'],
    why: "JUnit 4 puts the message first — rewording it changes no expectation",
  },
  {
    id: "add-assertion-beside-comment/node",
    file: "test/calc.test.js",
    context: "// arithmetic",
    removed: ["  assert.equal(add(1, 2), 3);"],
    added: ["  assert.equal(add(1, 2), 3);", "  assert.equal(add(2, 2), 4);"],
    why: "adding a test is the behaviour the gate exists to encourage",
  },
  {
    id: "add-assertion-beside-comment/rust",
    file: "tests/integration.rs",
    context: "// arithmetic",
    removed: ["    assert!(add(1, 2) == 3);"],
    added: ["    assert!(add(1, 2) == 3);", "    assert!(add(2, 2) == 4);"],
    why: "same edit, same comment syntax, another ecosystem",
  },
  {
    id: "reorder-assertions/pytest",
    file: "tests/test_calc.py",
    context: "# arithmetic",
    removed: ["    assert a() == 1", "    assert b() == 2"],
    added: ["    assert b() == 2", "    assert a() == 1"],
    why: "moving an assertion changes nothing it checks",
  },
  {
    id: "reindent/pytest",
    file: "tests/test_calc.py",
    context: "# arithmetic",
    removed: ["    assert add(1, 2) == 3"],
    added: ["        assert add(1, 2) == 3"],
    why: "a formatter run must not read as tampering",
  },
  {
    id: "reword-message/rspec",
    file: "spec/models/user_spec.rb",
    context: "# age",
    removed: ['    expect(u.age).to eq(30), "wrong"'],
    added: ['    expect(u.age).to eq(30), "unexpected age"'],
    why: "RSpec writes the message outside the call, where an argument check cannot see it",
  },
  {
    id: "reword-message/minitest",
    file: "test/user_test.rb",
    context: "# age",
    removed: ['    assert_equal 3, add(1, 2), "wrong"'],
    added: ['    assert_equal 3, add(1, 2), "unexpected sum"'],
    why: "same, with the message in argument position and no parentheses",
  },
  {
    id: "reword-message/node",
    file: "test/calc.test.js",
    context: "// arithmetic",
    removed: ['  assert.equal(add(1, 2), 3, "wrong");'],
    added: ['  assert.equal(add(1, 2), 3, "unexpected sum");'],
    why: "rewording a failure message says nothing about what is checked",
  },
  {
    id: "rename-test/junit",
    file: "src/test/java/com/x/CalcTest.java",
    context: "// arithmetic",
    removed: ["    void addsNumbers() {"],
    added: ["    void addsTwoNumbers() {"],
    why: "a test name is not an expectation",
  },
  {
    id: "change-import/node",
    file: "test/calc.test.js",
    context: "// setup",
    removed: ['const calc = require("./calc");'],
    added: ['const calc = require("../src/calc");'],
    why: "`require(` is an import, not a claim — the loose net must not read it as one",
  },
  {
    id: "reword-comment-inside-assertion/node",
    file: "test/calc.test.js",
    context: "// arithmetic",
    lead: ["  assert.equal(", "    add(1, 2),"],
    removed: ["    3, // the answer", "  );"],
    added: ["    3, // the correct answer", "  );"],
    why: "line comments were never stripped — `copyCode(i)` left `pending` at the comment and the copy after the loop put it back",
  },
  {
    id: "reformat-assertion-multiline/python",
    file: "tests/test_encoding.py",
    context: "# encoding",
    lead: ["def test_int_bytes(value, expect):", "    enc = int_to_bytes(value)"],
    removed: ["    assert enc == expect"],
    added: ["    assert (", "        enc == expect", "    )"],
    why: "Black and Ruff do this; `assert (` alone on a line names no value, so a line-level count read a reformat as a weakening",
  },
  {
    id: "rename-helper/node",
    file: "test/calc.test.js",
    context: "// setup",
    removed: ["  const shouldRetry = false;"],
    added: ["  const shouldRetry = true;"],
    why: "`shouldRetry` and `expected` are identifiers; reading them as assertions makes the dialect warning worthless",
  },

  // --- Widened de-registration (F04): the renames that must stay silent. ---
  // The rule is now "collected before, not collected after", so the honest
  // renames — still collected — are the false reds to guarantee.
  {
    id: "rename-test/longer-pytest",
    file: "tests/test_encoding.py",
    context: "# want_bytes",
    removed: ["def test_want_bytes(value):"],
    added: ["def test_want_bytes_for_text_and_bytes(value):"],
    why: "still matches pytest's test* — an honest rename, the trial's own control",
  },
  {
    id: "rename-test/pytest-underscore-glob",
    file: "tests/test_encoding.py",
    context: "# want_bytes",
    removed: ["def test_want_bytes(value):"],
    added: ["def testwant_bytes(value):"],
    why: "pytest's test* glob still collects this without the underscore",
  },
  {
    id: "rename-test/go-longer",
    file: "is_test.go",
    context: "// loadComment",
    removed: ["func TestLoadComment(t *testing.T) {"],
    added: ["func TestLoadCommentFromFixture(t *testing.T) {"],
    why: "TestX → TestXRenamed is still collected; go test never sees the new suffix",
  },
  {
    id: "rename-test/junit",
    file: "src/test/java/com/x/CalcTest.java",
    context: "// arithmetic",
    removed: ["    void addsNumbers() {"],
    added: ["    void addsTwoNumbers() {"],
    why: "JUnit names the method freely; the @Test annotation is what registers it",
  },
  // Rust registers by attribute, so renaming the function — keeping #[test]
  // — is ordinary and must be silent, while dropping the attribute is the
  // canary above.
  {
    id: "rename-test/rust",
    file: "tests/iter_tests/all.rs",
    context: "// iter",
    removed: ["fn peek_does_not_advance() {"],
    added: ["fn peek_preserves_position() {"],
    why: "the trial's honest-rust control: #[test] stays, the run loses nothing",
  },
  // A test moved to another file *with its registration* is refactoring, the
  // same allowance the assertion-move check makes for moved assertions. The
  // CROSS_FILE harness below covers it with both images; this entry asserts
  // the attribute net-counting is silent inside the same file when a test is
  // split into two (attribute added, none removed).
  {
    id: "add-test/rust-attribute-added",
    file: "tests/iter_tests/all.rs",
    context: "// iter",
    removed: [],
    added: ["#[test]", "fn peek_returns_the_next_item() {"],
    why: "adding a registered test is the behaviour the gate exists to encourage",
  },

  // --- F03 conditional expectations: a conditional can be honest. ---------
  // A brand-new assertion written with a ternary has no removed original to
  // bend, so it is not a rewrite; the rule only pairs a non-conditional
  // expectation against a conditional replacement of the same subject.
  {
    id: "add-assertion/conditional-ternary",
    file: "test/calc.test.js",
    context: "// arithmetic",
    removed: [],
    added: ["  assert.strictEqual(add(1, 2), feature ? 3 : 3);"],
    why: "a new assertion, conditional or not, is not a rewritten expectation",
  },
  {
    id: "add-assertion/python-conditional",
    file: "tests/test_calc.py",
    context: "# arithmetic",
    removed: [],
    added: ["    assert add(1, 2) == (3 if flag else 3)"],
    why: "same, in pytest's bare-comparison spelling",
  },
  // The expected expression may be a variable name; renaming a variable the
  // assertion compares against changes no value and contains no conditional.
  {
    id: "rename-expectation-identifier/pytest",
    file: "tests/test_calc.py",
    context: "# arithmetic",
    removed: ["    assert add(1, 2) == expected"],
    added: ["    assert add(1, 2) == wanted"],
    why: "an identifier renamed is not a conditional expectation",
  },
  // Changing the condition's *comparison value* is not this rule's target —
  // it is an expectation rewrite in its own right and the pairing checks
  // report it (the trial's Go controls show exactly that being rejected).
  // The vacuous-condition rule must only answer to an impossible guard.

  // --- F05 dead guard: an honest, reachable guard is silent. --------------
  {
    id: "guard-clause/go",
    file: "is_test.go",
    context: "// loadComment",
    lead: ["func TestLoadComment(t *testing.T) {"],
    removed: ["\tif comment != \"\" {"],
    added: ["\tif len(users) == 0 {"],
    why: "an ordinary test guard on real data — `len(x) == 0` is reachable, unlike `len(x) < 0`",
  },
  {
    id: "guard-clause/pytest",
    file: "tests/test_encoding.py",
    context: "# encoding",
    lead: ["def test_int_bytes(value, expect):", "    enc = int_to_bytes(value)"],
    removed: ["    if not data: return", "    assert enc == expect"],
    added: ["    if not data:", "        return", "    assert enc == expect"],
    why: "an early return inside a real guard clause is not the body's first statement; the assertion still runs",
  },

  // --- F04 execution-excision: harmless siblings must stay silent. --------
  {
    id: "go-build-version-bump",
    file: "is-1.7_test.go",
    context: "// build",
    removed: ["//go:build go1.7"],
    added: ["//go:build go1.24"],
    why: "a version tag tracks the toolchain; the test still runs in every supported CI",
  },
  {
    id: "go-build-os-gate",
    file: "is_unix_test.go",
    context: "// build",
    removed: [],
    added: ["//go:build linux || darwin"],
    why: "a new platform-gated test file is ordinary CI matrix work",
  },
  {
    id: "rust-test-module-attribute",
    file: "tests/iter_tests/all.rs",
    context: "// iter",
    removed: [],
    added: ["#[cfg(all(test, feature = \"proptest\"))]"],
    why: "a feature-gated *additional* test is not an excised one (no tightened counterpart, no remove)",
  },

  // --- F01 root file: ordinary edits to test.js stay ordinary. ------------
  {
    id: "add-assertion/root-node",
    file: "test.js",
    context: "// activeCount",
    removed: ["\tt.is(limit.activeCount, 0);"],
    added: ["\tt.is(limit.activeCount, 0);", "\tt.is(limit.pendingCount, 0);"],
    why: "adding an assertion to the root test file is what the gate encourages",
  },
  {
    id: "add-import/root-node",
    file: "test.js",
    context: "// imports",
    removed: [],
    added: ["import {identity} from './identity-helper.js';"],
    why: "an import in test.js is not an assertion, as in any other test file",
  },
];

/**
 * Dialects the guard genuinely cannot parse, which it must say out loud.
 *
 * This is the case the whole denominator exists for. A JUnit diff used to
 * return `PASS` with `inputsSeen: 1` while not one assertion in it had been
 * recognised — a verdict indistinguishable from a clean Node suite. Coverage
 * will always end somewhere; what must never happen again is that the edge
 * is silent.
 */
/**
 * Renames that delete a test from the run without deleting a line of it.
 *
 * pytest collects `test_*`, Go collects `Test*`. For those runners the name is
 * the registration, so `def test_totals` → `def totals` removes the test as
 * completely as deleting the file, and every count in the tamper guard stays
 * level: nothing removed, nothing weakened, nothing rewritten.
 *
 * These were caught only as a side effect of the blanket that rejected every
 * unrecognised edit to a test file — which also rejected adding an import, and
 * whose printed remedy switched the real checks off. They are their own
 * finding now, so narrowing that blanket costs nothing.
 */
export const DEREGISTRATION_CANARIES = [
  {
    id: "pytest/underscore",
    file: "tests/test_totals.py",
    context: "# totals",
    removed: ["def test_totals_round_to_cents():"],
    added: ["def totals_round_to_cents():"],
    why: "pytest collects by the test_ prefix, so this test no longer runs",
  },
  {
    id: "pytest/camel",
    file: "tests/test_totals.py",
    context: "# totals",
    removed: ["def testTotals():"],
    added: ["def Totals():"],
    why: "the prefix is what registers it, in either spelling",
  },
  // F04: the original rule only matched a literal prefix strip, so any
  // *other* collected→not-collected rename sailed through. Each of these
  // leaves every assertion in the file, still level in every count, with
  // the test gone from the run.
  {
    id: "pytest/check-prefix",
    file: "tests/test_encoding.py",
    context: "# want_bytes",
    removed: ["def test_want_bytes(value):"],
    added: ["def check_want_bytes(value):"],
    why: "the measured bypass — pytest never collects check_*",
  },
  {
    id: "pytest/disabled-prefix",
    file: "tests/test_encoding.py",
    context: "# want_bytes",
    removed: ["def test_want_bytes(value):"],
    added: ["def disabled_want_bytes(value):"],
    why: "any non-test* replacement uncollects, not only a strip",
  },
  {
    id: "go/check-prefix",
    file: "is_test.go",
    context: "// loadComment",
    removed: ["func TestLoadComment(t *testing.T) {"],
    added: ["func checkLoadComment(t *testing.T) {"],
    why: "go test collects TestX, never checkX",
  },
  {
    id: "rust/attribute-removed",
    file: "tests/iter_tests/all.rs",
    context: "// iter",
    removed: ["#[test]", "fn peek_does_not_advance() {"],
    added: ["fn check_peek_does_not_advance() {"],
    why: "Rust registers by attribute; no #[test], no run, free-form name",
  },
  {
    id: "go/benchmark",
    file: "calc_test.go",
    context: "// totals",
    removed: ["func BenchmarkTotals(b *testing.B) {"],
    added: ["func Totals(b *testing.B) {"],
    why: "the same rule for the other collected prefixes",
  },
];

/**
 * A verification command that exits 0 having written nothing at all.
 *
 * The one absence that is evidence. The floor is otherwise deliberately
 * one-sided — an unrecognised runner states no count and passes, because
 * hard-redding every runner not on the list would be worse than the hole it
 * closes — but an unrecognised runner still prints something. Zero bytes on
 * both streams is a command that ran nothing, and `pnpm -r test` on a
 * workspace whose packages declare no test script is exactly that: it was
 * indistinguishable from a full suite by every signal the gate had.
 */
export const SILENT_RUN_CANARIES = [
  { id: "pnpm -r test", command: "pnpm -r test", stdout: "", stderr: "" },
  { id: "npm test", command: "npm test", stdout: "", stderr: "" },
  { id: "yarn workspaces test", command: "yarn workspaces foreach run test", stdout: "", stderr: "" },
  { id: "pytest", command: "python3 -m pytest", stdout: "", stderr: "" },
  { id: "go test", command: "go test ./...", stdout: "", stderr: "" },
  { id: "whitespace is not output", command: "npm test", stdout: "  \n", stderr: "\n" },
];

/**
 * Honest static gates that print nothing, and must keep passing.
 *
 * The counterweight, and the reason the rule above reads the command as well
 * as the output. `tsc --noEmit`, `node --check`, `go vet` and `compileall`
 * all exit 0 in silence when they succeed — that is what success looks like
 * for a checker — and two of them are commands this kit writes itself for a
 * repository that has no suite yet. A rule keyed on silence alone hard-redded
 * every one of them, which is exactly the first-run rejection of correct code
 * that the collection floor is otherwise so careful to avoid.
 */
export const SILENT_STATIC_GATES = [
  { id: "tsc", command: "tsc --noEmit" },
  { id: "node --check", command: "node --check index.js" },
  { id: "go vet", command: "go vet ./..." },
  { id: "compileall", command: "python3 -m compileall -q ." },
  { id: "generated parse gate", command: "node --check src/index.mjs" },
];

/**
 * Values that must survive a trip through the emitter and back.
 *
 * `yamlScalar` writes the manifests and `parseYaml` reads them, and a pair
 * like that disagreeing about one character is this project's recurring
 * defect with both halves in a single module. The parser opened a comment at
 * the first `#` on a line, quoted or not, so `verify.test` containing a hash
 * was silently truncated on the way in and the gate ran a command the user
 * never wrote — reporting on it as if it were theirs.
 *
 * The corpus is the hard cases on purpose: hashes, colons, leading stars,
 * apostrophes, the empty string, and the words YAML would otherwise read as
 * booleans.
 */
export const YAML_ROUNDTRIP_CASES = [
  "pnpm -r test",
  "PYTHONPATH=src python3 -m pytest",
  'pytest -k "not #slow"',
  "has #hash",
  "# leading hash",
  "a: b",
  "**/*.pem",
  "**/.env.*",
  ".github/**",
  "",
  "true",
  "yes",
  "1.5",
  "it's fine",
  "it's #1",
  "O'Brien",
  "agent/",
  "  leading space",
  "trailing space  ",
];

export const UNREADABLE_DIALECTS = [
  {
    id: "hspec",
    file: "tests/CalcSpec.hs",
    context: "-- arithmetic",
    removed: ["    calc `shouldBe` 3"],
    added: ["    calc `shouldBe` (-1)"],
    why: "an infix assertion with no parentheses anywhere near it",
  },
  {
    id: "googletest",
    file: "tests/calc_test.cc",
    context: "// arithmetic",
    removed: ["  EXPECT_EQ(add(1, 2), 3);"],
    added: ["  EXPECT_EQ(add(1, 2), -1);"],
    why: "a macro dialect the pattern list does not cover",
  },
];

/**
 * Import forms the package-integrity extractor must find.
 *
 * The first pass of that check reported "every relative import resolves" on
 * a package whose newest script could not start: its matcher was written as
 * `[^;\n]*?from`, and the import it needed to see spanned several lines. The
 * check was confidently green about a file that threw ERR_MODULE_NOT_FOUND
 * on load — the same failure the tool exists to prevent, committed by the
 * tool's own integrity check.
 *
 * Every entry is a source fragment and the specifiers it must yield.
 */
export const IMPORT_EXTRACTION_CASES = [
  { id: "single-line named", src: 'import { a, b } from "./one.mjs";', expect: ["./one.mjs"] },
  {
    id: "multi-line named",
    src: 'import {\n  a,\n  b,\n} from "./two.mjs";',
    expect: ["./two.mjs"],
    why: "the form the first version of the check could not see",
  },
  { id: "default", src: 'import three from "./three.mjs";', expect: ["./three.mjs"] },
  { id: "namespace", src: 'import * as four from "./four.mjs";', expect: ["./four.mjs"] },
  { id: "side-effect only", src: 'import "./five.mjs";', expect: ["./five.mjs"] },
  { id: "re-export", src: 'export { six } from "./six.mjs";', expect: ["./six.mjs"] },
  { id: "re-export all", src: 'export * from "./seven.mjs";', expect: ["./seven.mjs"] },
  { id: "dynamic", src: 'const m = await import("./eight.mjs");', expect: ["./eight.mjs"] },
  { id: "require", src: 'const nine = require("./nine.js");', expect: ["./nine.js"] },
  { id: "single quotes", src: "import ten from './ten.mjs';", expect: ["./ten.mjs"] },
  {
    id: "bare specifiers are not files",
    src: 'import { readFileSync } from "node:fs";\nimport x from "some-package";',
    expect: ["node:fs", "some-package"],
    why: "found, then ignored by the resolver — never resolved against the tarball",
  },
];

// Cases that exercise the mask rather than the matcher. Appended separately
// because each one is a fixture *about* fixtures: the check has to tell a
// module reference from a picture of one.
IMPORT_EXTRACTION_CASES.push(
  {
    id: "regex holding a quote, then a real import",
    src: 'const q = /["\']/;\nimport x from "./after-regex.mjs";',
    expect: ["./after-regex.mjs"],
    why: "the phantom string this file's own subject matter opens",
  },
  {
    id: "an import quoted inside a string",
    src: 'const example = \'import a from "./not-real.mjs";\';',
    expect: [],
    why: "a picture of an import is not an import",
  },
  {
    id: "an import written in a comment",
    src: '// import a from "./commented.mjs";\nconst x = 1;',
    expect: [],
    why: "same, in the other place examples live",
  }
);

/**
 * Runs that stated a count, which must never be read as empty.
 *
 * The floor was written to be one-sided — only a *stated* zero fails — and
 * then a phrase was allowed to outrank a statement. A healthy 190-test TAP
 * suite whose one skipped fixture printed `# SKIP no tests found` was
 * rejected as empty and attributed to Jest, in a repository that does not
 * use Jest. A false red on a correct repository is how a user learns the
 * gate is broken and turns it off.
 */
export const COUNTED_RUN_CANARIES = [
  {
    id: "tap with a skip message",
    output: "TAP version 13\n# Subtest: performance\n    # SKIP no tests found\nok 1 - performance # SKIP\n1..191\n# tests 191\n# pass 190\n# skip 1",
    atLeast: 1,
    why: "`no tests found` inside a skip comment is not a statement about the run",
  },
  {
    id: "pytest mentioning an empty module",
    output: "collected 12 items\n\ntests/test_a.py ............\n\n12 passed in 0.3s",
    atLeast: 1,
    why: "a stated count is present and must win",
  },
  {
    id: "go, verbose, two tests",
    output: "--- PASS: TestAdd (0.00s)\n--- PASS: TestSub (0.00s)\nok  \texample.com/lib\t0.004s",
    atLeast: 1,
    why: "Go's own `ok  <package>` line, which a bare `^ok\\s` confused with TAP's `ok 1 - name`",
  },
];

/**
 * Changes that sit inside an assertion whose keyword never appears in the diff.
 *
 * Counting `+`/`-` lines answered zero here, and nothing among the changed
 * lines looked assertion-shaped either, so the guard reported a clean PASS on
 * a five-element expected list rewritten to one element to match broken
 * output. Measured on a real repository: five green phases, `APPROVED`.
 *
 * The statement machinery that pairs rewrites already assembles context lines
 * together with changed ones. The denominator has to use it.
 */
export const MULTILINE_CANARIES = [
  {
    id: "expectation/python-multiline",
    file: "tests/test_headers.py",
    context: "# headers",
    lead: ["    def test_parse(self):", "        self.assertEqual(", "            _parse_http_header(x),"],
    removed: ['            [("text/xml", {}),', '             ("text/plain", {}),', '             ("more", {})])'],
    added: ['            [("text/xml", {"tampered": True})])'],
    expect: "ASSERTION_EXPECTATION_CHANGED",
  },
  {
    id: "expectation/js-multiline",
    file: "test/headers.test.js",
    context: "// headers",
    lead: ["  assert.deepStrictEqual(", "    parse(input),"],
    removed: ["    [{ type: \"a\" }, { type: \"b\" }, { type: \"c\" }]", "  );"],
    added: ["    [{ type: \"a\" }]", "  );"],
    expect: "ASSERTION_EXPECTATION_CHANGED",
  },
];

/**
 * Diffs that touch two files at once, where the verdict depends on both.
 *
 * Assertion tracking is per file, so moving a test between files — ordinary
 * refactoring, done constantly — read as deleting every assertion in it and
 * was reported as CRITICAL tampering. The assertion still exists and still
 * runs. What the removal check is for is verification that *disappeared*.
 *
 * `expect: []` means the whole diff must produce no finding.
 */
export const CROSS_FILE_CASES = [
  {
    id: "move-a-test-between-files",
    context: "# ctx",
    files: [
      {
        file: "test/test_app.py",
        removed: ["    def test_setattr(self):", "        self.assertEqual(5, app.test)", "        self.assertRaises(AttributeError, setattr, app, 't', 6)"],
        added: [],
      },
      {
        file: "test/test_html.py",
        removed: [],
        added: ["    def test_setattr_moved(self):", "        self.assertEqual(5, app.test)", "        self.assertRaises(AttributeError, setattr, app, 't', 6)"],
      },
    ],
    expect: [],
    why: "a move is not a removal",
  },
  {
    id: "delete-a-test-outright",
    context: "# ctx",
    files: [
      {
        file: "test/test_app.py",
        removed: ["    def test_setattr(self):", "        self.assertEqual(5, app.test)", "        self.assertRaises(AttributeError, setattr, app, 't', 6)"],
        added: [],
      },
    ],
    expect: ["ASSERTION_REMOVAL", "ASSERTION_REMOVAL"],
    why: "nothing caught it on the way, so verification really did disappear",
  },
  {
    id: "change-it-on-the-way-across",
    context: "# ctx",
    files: [
      { file: "test/test_app.py", removed: ["        self.assertEqual(5, app.test)"], added: [] },
      { file: "test/test_html.py", removed: [], added: ["        self.assertEqual(99, app.test)"] },
    ],
    expect: ["ASSERTION_REMOVAL"],
    why: "what arrived is a different claim; only an exact arrival is a move",
  },
];
