import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isTestPath } from "../src/test-paths.mjs";
import { checkTestTampering } from "../src/security.mjs";
import { isExcludedFromMutation } from "../src/mutation.mjs";

/**
 * Five modules each had their own answer to "is this a test file?", and the
 * disagreements were not academic: the substring `/test/` has no match in
 * `tests/test_calc.py`, so the whole tamper guard — every check in it — was
 * switched off for the standard pytest, Rust and RSpec layouts. Whatever else
 * changes, that predicate has one definition.
 */

describe("isTestPath recognises the layouts every runner actually uses", () => {
  const testPaths = [
    "tests/test_calc.py",          // pytest, repository root — the reported gap
    "test/test_calc.py",
    "tests/integration.rs",        // Rust integration tests
    "spec/models/user_spec.rb",    // RSpec
    "specs/api.js",
    "test/a.test.js",
    "src/foo_test.go",             // Go
    "src/__tests__/foo.js",
    "packages/api/tests/handler.py",
    "contracts/Token.t.sol",       // Foundry
    "contracts/TokenTest.sol",
    "lib/user.spec.ts",
    "lib/user_spec.rb",
  ];

  for (const p of testPaths) {
    it(`classifies ${p} as a test file`, () => {
      assert.equal(isTestPath(p), true);
    });
  }

  const sourcePaths = [
    "src/index.js",
    "src/engine.mjs",
    "latest/build.js",             // segment match, not substring: not `test/`
    "lib/myspec/render.js",        // not `spec/`
    "src/attestation.js",          // contains "test" but is not one
    "docs/testing-guide.md",
    "README.md",
  ];

  for (const p of sourcePaths) {
    it(`does not classify ${p} as a test file`, () => {
      assert.equal(isTestPath(p), false);
    });
  }

  it("survives the shapes that are not paths", () => {
    assert.equal(isTestPath(""), false);
    assert.equal(isTestPath(null), false);
    assert.equal(isTestPath(undefined), false);
    assert.equal(isTestPath(42), false);
    assert.equal(isTestPath("test\\unit\\a.test.js"), true, "Windows separators");
  });
});

describe("the consumers agree with it", () => {
  const rewrite = (file) =>
    [
      `--- a/${file}`,
      `+++ b/${file}`,
      "@@ -1,9 +1,9 @@",
      " context",
      "-assert.equal(add(1, 2), 3);",
      "+assert.equal(add(1, 2), -1);",
      " context",
    ].join("\n");

  for (const file of ["tests/test_calc.py", "tests/integration.rs", "spec/a_spec.rb"]) {
    it(`the tamper guard now covers ${file}`, () => {
      const res = checkTestTampering(rewrite(file));
      assert.equal(res.ok, false, `${file} was invisible to every tamper check`);
      assert.equal(res.violations[0].type, "ASSERTION_EXPECTATION_CHANGED");
    });
  }

  it("mutation excludes the same files it used to mutate", () => {
    // The mirror of the bug above: these were not recognised, so the harness
    // mutated operators inside the tests and scored the result.
    assert.equal(isExcludedFromMutation("tests/test_calc.py"), true);
    assert.equal(isExcludedFromMutation("tests/integration.rs"), true);
    assert.equal(isExcludedFromMutation("spec/a_spec.rb"), true);
    assert.equal(isExcludedFromMutation("src/engine.mjs"), false);
  });
});
