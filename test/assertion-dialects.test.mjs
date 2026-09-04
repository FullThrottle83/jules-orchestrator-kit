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
  MULTILINE_CANARIES,
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

function diffFor({ file, removed = [], added = [], context, lead }) {
  const ctx = context || `${commentFor(file)} context`;
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1,20 +1,20 @@",
    ` ${ctx}`,
    ...(lead || []).map((l) => ` ${l}`),
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

describe("an assertion is a statement, not a line", () => {
  for (const c of MULTILINE_CANARIES) {
    it(`${c.id} is caught even though its keyword never appears in the diff`, () => {
      const res = checkTestTampering(diffFor(c));
      assert.ok(
        (res.violations || []).some((v) => v.type === c.expect),
        `expected ${c.expect}, got ${JSON.stringify((res.violations || []).map((v) => v.type))}`
      );
      assert.ok(res.assertionsSeen > 0, "and the denominator has to see it too");
    });
  }

  it("counts an assertion the change sits inside", () => {
    // Before: `assertionsSeen: 0` and a clean PASS, because the keyword was on
    // an unchanged context line and none of the changed lines looked like an
    // assertion. Five green phases on a rewritten expected value.
    const res = checkTestTampering(diffFor(MULTILINE_CANARIES[0]));
    assert.notEqual(res.status, "PASS");
  });

  it("changed lines in a test file with no assertion recognised is not a pass", () => {
    const res = checkTestTampering(
      diffFor({ file: "test/helper.test.js", removed: ["  const timeout = 100;"], added: ["  const timeout = 200;"] })
    );
    assert.equal(res.assertionsSeen, 0);
    assert.equal(res.status, "UNREADABLE", "saying nothing and saying approved must not look the same");
  });
});

describe("line comments are stripped, and always were not", () => {
  // `copyCode(i)` copied the code up to the comment and left `pending` at its
  // start; the `copyCode(n)` after the loop copied the comment straight back
  // in. Block comments were stripped, which is why `/* … */` behaved and
  // `// …` did not — and why a comment edit only stayed silent by landing in
  // a different shape bucket by accident.
  const mk = (a, b) =>
    ["--- a/test/add.test.js", "+++ b/test/add.test.js", "@@ -1,6 +1,6 @@", " assert.equal(", "   add(1, 2),", a, b, "   );"].join("\n");

  for (const [name, a, b] of [
    ["after a comma", "-  3, // the answer", "+  3, // the real answer"],
    ["after a value", "-  3 // the answer", "+  3 // the real answer"],
    ["block comment", "-  3, /* the answer */", "+  3, /* the real answer */"],
  ]) {
    it(`rewording a comment ${name} is not a rewritten expectation`, () => {
      assert.deepEqual((checkTestTampering(mk(a, b)).violations || []).map((v) => v.type), []);
    });
  }

  it("but changing the value beside the comment still is", () => {
    const types = (checkTestTampering(mk("-  3, // the answer", "+  -1, // the answer")).violations || []).map((v) => v.type);
    assert.deepEqual(types, ["ASSERTION_EXPECTATION_CHANGED"]);
  });
});

describe("the guard reports its boundary on the path the gate uses", () => {
  it("scanDiff carries the unreadable dialect, not just assertTestIntegrity", async () => {
    // The gate calls `scanDiff`. Wiring the warning into `assertTestIntegrity`
    // — which the gate never calls — meant the operator saw an unblemished
    // pass while the guard had computed UNREADABLE.
    const { scanDiff } = await import("../src/security.mjs");
    const res = scanDiff(diffFor(UNREADABLE_DIALECTS[0]));
    assert.ok(
      (res.findings || []).some((f) => f.type === "TEST_DIALECT_UNREADABLE"),
      `no boundary finding in ${JSON.stringify((res.findings || []).map((f) => f.type))}`
    );
    assert.equal(res.ok, true, "an unlisted assertion library is not the user's fault and must not block");
  });
});

describe("absence of evidence is reported as absence", () => {
  it("a runner that stated no count says so", async () => {
    const { checkCollectionFloor } = await import("../src/ops/test-collection.mjs");
    const res = checkCollectionFloor({ ok: true, stdout: "all tests passed" });
    assert.equal(res.ok, true, "failing on 'I could not tell' would break every unlisted runner");
    assert.equal(res.unverified, true);
    assert.match(res.note, /no recognised test runner stated how many tests it ran/);
  });

  it("a runner that did state one does not", async () => {
    const { checkCollectionFloor } = await import("../src/ops/test-collection.mjs");
    const res = checkCollectionFloor({ ok: true, stdout: "# tests 191\n# pass 190" });
    assert.equal(res.ok, true);
    assert.ok(!res.unverified);
  });
});
