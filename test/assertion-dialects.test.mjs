import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { checkTestTampering } from "../src/security.mjs";
import { assertTestIntegrity } from "../src/assertions.mjs";
import { extractSpecifiers } from "../scripts/package-integrity-check.mjs";
import {
  TAMPER_CANARIES,
  INNOCENT_EDITS,
  UNREADABLE_DIALECTS,
  IMPORT_EXTRACTION_CASES,
} from "../src/guard-policy.mjs";

/**
 * The guard reported `PASS` with a non-zero denominator on a JUnit diff that
 * rewrote an expected value, and on RSpec, PHPUnit, Minitest and XCTest doing
 * the same. `assertEqual` was recognised only because the pattern's optional
 * dot and case-insensitive flag happened to line up; `assertEquals` was not.
 *
 * That is the shape the activation-coverage work exists to reject — a verdict
 * from a check that read nothing — surviving one level down, inside the
 * mechanism built to remove it.
 */

const COMMENT = { py: "#", rb: "#", exs: "#", hs: "--", default: "//" };
const commentFor = (file) => COMMENT[file.split(".").pop()] ?? COMMENT.default;

function diffFor({ file, removed = [], added = [], context }) {
  const ctx = context || `${commentFor(file)} context`;
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1,20 +1,20 @@",
    ` ${ctx}`,
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    ` ${ctx}`,
  ].join("\n");
}

describe("every canary in the policy contract still fires", () => {
  for (const c of TAMPER_CANARIES) {
    it(`${c.id} produces ${c.expect}`, () => {
      const res = checkTestTampering(diffFor(c));
      const types = (res.violations || []).map((v) => v.type);
      assert.ok(types.includes(c.expect), `expected ${c.expect}, got ${JSON.stringify(types)}`);
    });
  }
});

describe("a finding about assertions must have parsed an assertion", () => {
  for (const c of TAMPER_CANARIES.filter((c) => c.expect !== "TEST_SKIP_INJECTION")) {
    it(`${c.id} counts what it read`, () => {
      // `inputsSeen` counted files, so a JUnit diff reported one input
      // examined and a clean PASS while not one assertion in it parsed.
      const res = checkTestTampering(diffFor(c));
      assert.ok(res.assertionsSeen > 0, `${c.id} reported a finding having parsed 0 assertions`);
    });
  }
});

describe("the opposite failure: flagging what is innocent", () => {
  for (const e of INNOCENT_EDITS) {
    it(`${e.id} is silent — ${e.why}`, () => {
      const types = (checkTestTampering(diffFor(e)).violations || []).map((v) => v.type);
      assert.deepEqual(types, [], `an ordinary edit was reported as tampering`);
    });
  }

  it("a comment is not a continuation, but a comment inside a call still is", () => {
    // `//` begins with a division sign, so it matched the operator
    // continuation test and folded itself into the assertion above — which
    // made *adding* an assertion next to a comment read as rewriting one.
    // Python was immune because `#` is not an operator, which is why the
    // fixtures this project was written from never showed it.
    const inner = checkTestTampering(
      [
        "--- a/test/calc.test.js",
        "+++ b/test/calc.test.js",
        "@@ -1,20 +1,20 @@",
        " let x = 1;",
        "-  assert.equal(",
        "-    // why",
        "-    add(1, 2), 3);",
        "+  assert.equal(",
        "+    // why",
        "+    add(1, 2), -1);",
        " let y = 2;",
      ].join("\n")
    );
    assert.deepEqual(
      (inner.violations || []).map((v) => v.type),
      ["ASSERTION_EXPECTATION_CHANGED"],
      "a comment inside an open call must still join its statement"
    );
  });
});

describe("coverage may end, but never silently", () => {
  for (const d of UNREADABLE_DIALECTS) {
    it(`${d.id} is reported as unreadable, not passed`, () => {
      const res = checkTestTampering(diffFor(d));
      assert.equal(res.status, "UNREADABLE");
      assert.equal(res.assertionsSeen, 0);
      assert.ok(res.unreadable.length > 0);
    });
  }

  it("says so where an operator will actually read it", () => {
    const d = UNREADABLE_DIALECTS[0];
    const res = assertTestIntegrity({ diffStr: diffFor(d) });
    assert.ok(
      res.diagnostics.some((line) => /matched no known dialect/.test(line)),
      "an unreadable dialect must reach the diagnostics, not just the return value"
    );
    assert.equal(res.ok, true, "an unlisted assertion library is not the user's fault and must not block");
  });

  it("does not cry unreadable over ordinary identifiers", () => {
    for (const line of ["  const shouldRetry = false;", "  const expected = 3;", "  let assertions = 0;"]) {
      const res = checkTestTampering(diffFor({ file: "test/calc.test.js", removed: [line], added: [line.replace("false", "true").replace("3", "4").replace("0", "1")] }));
      assert.equal(res.unreadable.length, 0, `${line} is an identifier, not an assertion`);
    }
  });
});

describe("the published package is checked the way it is installed", () => {
  for (const c of IMPORT_EXTRACTION_CASES) {
    it(`finds ${c.id}`, () => {
      assert.deepEqual(extractSpecifiers(c.src).sort(), [...c.expect].sort());
    });
  }

  it("a multi-line import is visible to the extractor", () => {
    // The first version of the check bounded its matcher with `[^;\n]*?`, so
    // it could not see the one import that was actually missing from the
    // tarball, and reported the broken package as sound.
    const src = 'import {\n  TEST_PATH_CASES,\n  TAMPER_CANARIES,\n} from "../src/guard-policy.mjs";';
    assert.deepEqual(extractSpecifiers(src), ["../src/guard-policy.mjs"]);
  });
});
