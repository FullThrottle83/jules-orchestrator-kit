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
  {
    id: "skip-injection/xctest",
    file: "Tests/CalcTests/CalcTests.swift",
    removed: [],
    added: ["        throw XCTSkip(\"not now\")"],
    expect: "TEST_SKIP_INJECTION",
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
    id: "rename-helper/node",
    file: "test/calc.test.js",
    context: "// setup",
    removed: ["  const shouldRetry = false;"],
    added: ["  const shouldRetry = true;"],
    why: "`shouldRetry` and `expected` are identifiers; reading them as assertions makes the dialect warning worthless",
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
