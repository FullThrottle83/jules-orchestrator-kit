import test from "node:test";
import assert from "node:assert/strict";
import { checkTestTampering } from "../src/security.mjs";

// Minimal unified diff for one test file. `hunkLines` carry their own
// prefix: " " context, "-" removed, "+" added. With no context lines the
// diff is zero-context, the case the statement assembler must survive on
// fragments alone.
function diff(file, ...hunkLines) {
  const removed = hunkLines.filter((l) => l.startsWith("-")).length;
  const added = hunkLines.filter((l) => l.startsWith("+")).length;
  const ctx = hunkLines.length - removed - added;
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${removed + ctx} +1,${added + ctx} @@`,
    ...hunkLines,
  ].join("\n");
}

const EXPECTATION = "ASSERTION_EXPECTATION_CHANGED";

function expectationViolations(res) {
  return res.violations.filter((v) => v.type === EXPECTATION);
}

test("statement-level expectation-rewrite detection", async (t) => {
  await t.test("catches the reported bypass: a reflowed assertion with a changed value", () => {
    const res = checkTestTampering(diff("test/add.test.js",
      "-assert.equal(",
      "-  add(1, 2),",
      "-  3",
      "-);",
      "+assert.equal(",
      "+  add(1, 2),",
      "+  -1",
      "+);"
    ));
    assert.equal(res.ok, false, JSON.stringify(res.violations));
    // Reported once — not also as a removal or a weakening.
    assert.deepEqual(res.violations.map((v) => v.type), [EXPECTATION]);
  });

  await t.test("catches the inverse: a wrapped assertion collapsed to one line", () => {
    const res = checkTestTampering(diff("test/add.test.js",
      "-assert.equal(",
      "-  add(1, 2),",
      "-  3",
      "-);",
      "+assert.equal(add(1, 2), -1);"
    ));
    assert.equal(res.ok, false, JSON.stringify(res.violations));
    assert.equal(expectationViolations(res).length, 1, JSON.stringify(res.violations));
  });

  await t.test("catches a value edit inside an existing wrapped assertion (no reflow in the diff)", () => {
    const res = checkTestTampering(diff("test/invoice.test.js",
      " assert.equal(",
      "   formatInvoice(bill),",
      '-    "Total: 42.00"',
      '+    "Total: 99.99"',
      "   );"
    ));
    assert.equal(res.ok, false, JSON.stringify(res.violations));
    assert.equal(expectationViolations(res).length, 1, JSON.stringify(res.violations));
  });

  await t.test("catches a value edit when the hunk has no context lines at all", () => {
    const res = checkTestTampering(diff("test/invoice.test.js",
      '-    "Total: 42.00"',
      '+    "Total: 99.99"'
    ));
    assert.equal(res.ok, false, JSON.stringify(res.violations));
    assert.equal(expectationViolations(res).length, 1, JSON.stringify(res.violations));
  });

  await t.test("catches a Go if-got!=want comparison edit", () => {
    const res = checkTestTampering(diff("calc_test.go",
      " func TestAdd(t *testing.T) {",
      "- 	if got := Add(1, 2); got != 3 {",
      "+ 	if got := Add(1, 2); got != -1 {",
      " 		t.Errorf(\"Add(1, 2) = %d\", got)",
      " 	}",
      " }"
    ));
    assert.equal(res.ok, false, JSON.stringify(res.violations));
    assert.equal(expectationViolations(res).length, 1, JSON.stringify(res.violations));
  });

  await t.test("an identifier rename in a Go comparison is not a value change", () => {
    const res = checkTestTampering(diff("calc_test.go",
      " func TestAdd(t *testing.T) {",
      "- 	if got := Add(1, 2); got != tt.want {",
      "+ 	if got := Add(1, 2); got != tt.wantX {",
      " 		t.Errorf(\"Add(1, 2) = %d\", got)",
      " 	}",
      " }"
    ));
    assert.equal(res.ok, true, JSON.stringify(res.violations));
  });

  await t.test("catches a Go table-driven want edit inside the test function", () => {
    const res = checkTestTampering(diff("calc_test.go",
      " func TestAdd(t *testing.T) {",
      " 	tests := []struct{ a, b, want int }{",
      "- 		{1, 2, 3},",
      "+ 		{1, 2, 999},",
      " 		{4, 5, 9},",
      " 	}",
      " 	for _, tt := range tests {",
      " 		if got := Add(tt.a, tt.b); got != tt.want {",
      " 			t.Errorf(\"Add(%d, %d) = %d, want %d\", tt.a, tt.b, got, tt.want)",
      " 		}",
      " 	}",
      " }"
    ));
    assert.equal(res.ok, false, JSON.stringify(res.violations));
    assert.equal(expectationViolations(res).length, 1, JSON.stringify(res.violations));
  });

  await t.test("catches a Python multi-line assertEqual edit", () => {
    const res = checkTestTampering(diff("svc/tests/test_invoice.py",
      " def test_total(self):",
      "     self.assertEqual(",
      "         result,",
      "-         42",
      "+         -7",
      "     )"
    ));
    assert.equal(res.ok, false, JSON.stringify(res.violations));
    assert.equal(expectationViolations(res).length, 1, JSON.stringify(res.violations));
  });

  await t.test("catches a Rust multi-line assert_eq! edit", () => {
    const res = checkTestTampering(diff("tests/amount_test.rs",
      " #[test]",
      " fn total() {",
      "     assert_eq!(",
      "         compute(&input),",
      "-         42",
      "+         -7",
      "     );",
      " }"
    ));
    assert.equal(res.ok, false, JSON.stringify(res.violations));
    assert.equal(expectationViolations(res).length, 1, JSON.stringify(res.violations));
  });

  await t.test("catches a Jest expect() chain split across lines with nested calls", () => {
    const res = checkTestTampering(diff("test/invoice.test.js",
      " test('formats', () => {",
      "-   expect(",
      "-     formatInvoice(bill)",
      '-   ).toBe("Total: 42.00");',
      "+   expect(",
      "+     formatInvoice(bill)",
      '+   ).toBe("Total: 99.99");',
      " });"
    ));
    assert.equal(res.ok, false, JSON.stringify(res.violations));
    assert.equal(expectationViolations(res).length, 1, JSON.stringify(res.violations));
  });

  await t.test("catches a hex literal value edit", () => {
    const res = checkTestTampering(diff("test/flags.test.js",
      "-assert.equal(flags, 0xFF);",
      "+assert.equal(flags, 0xFE);"
    ));
    assert.equal(res.ok, false, JSON.stringify(res.violations));
    assert.equal(expectationViolations(res).length, 1, JSON.stringify(res.violations));
  });

  await t.test("catches a multi-line template literal value edit", () => {
    const res = checkTestTampering(diff("test/render.test.js",
      " assert.equal(",
      "   render(card),",
      "-  `Line 1",
      "-   42.00`",
      "+  `Line 1",
      "+   99.99`",
      "   );"
    ));
    assert.equal(res.ok, false, JSON.stringify(res.violations));
    assert.equal(expectationViolations(res).length, 1, JSON.stringify(res.violations));
  });

  await t.test("does not fire on a pure whitespace reformat of an assertion", () => {
    const res = checkTestTampering(diff("test/add.test.js",
      "-assert.equal(",
      "-  add(1, 2),",
      "-  3",
      "-);",
      "+assert.equal(add(1, 2), 3);"
    ));
    assert.equal(res.ok, true, JSON.stringify(res.violations));
  });

  await t.test("does not fire on renaming a test whose body contains an unchanged assertion", () => {
    const res = checkTestTampering(diff("test/add.test.js",
      '-it("adds numbers", () => {',
      '+it("adds its numbers correctly", () => {',
      "   expect(add(1, 2)).toBe(3);",
      " });"
    ));
    assert.equal(res.ok, true, JSON.stringify(res.violations));
  });

  await t.test("re-adding the original alongside a new assertion of the same shape is an addition, not a rewrite", () => {
    const res = checkTestTampering(diff("test/add.test.js",
      "-assert.equal(add(1, 2), 3);",
      "+assert.equal(add(1, 2), 3);",
      "+assert.equal(add(1, 2), -1);",
      " assert.equal(sub(5, 1), 4);"
    ));
    assert.equal(res.ok, true, JSON.stringify(res.violations));
  });

  await t.test("a formatter run over a block of same-shape assertions is silent", () => {
    const res = checkTestTampering(diff("test/table.test.js",
      "-  assert.equal(f(0), 0);",
      "-  assert.equal(f(1), 1);",
      "-  assert.equal(f(2), 2);",
      "+    assert.equal(f(0), 0);",
      "+    assert.equal(f(1), 1);",
      "+    assert.equal(f(2), 2);"
    ));
    assert.equal(res.ok, true, JSON.stringify(res.violations));
  });

  await t.test("a value swap across two assertions is reported for both", () => {
    const res = checkTestTampering(diff("test/add.test.js",
      "-assert.equal(a, 1);",
      "-assert.equal(b, 2);",
      "+assert.equal(a, 2);",
      "+assert.equal(b, 1);"
    ));
    assert.equal(res.ok, false, JSON.stringify(res.violations));
    assert.equal(expectationViolations(res).length, 2, JSON.stringify(res.violations));
  });

  await t.test("a number changed inside a comment does not pair as a value change", () => {
    const res = checkTestTampering(diff("test/add.test.js",
      " assert.equal(",
      "   add(1, 2),",
      "-  3, // the answer",
      "+  3, // the real answer",
      "   );"
    ));
    assert.equal(res.ok, true, JSON.stringify(res.violations));
  });

  await t.test("a 4000-line test refactor stays fast and silent on renames", () => {
    const file = "test/big.test.js";
    const lines = [`--- a/${file}`, `+++ b/${file}`, "@@ -1,4000 +1,4000 @@"];
    for (let i = 0; i < 1000; i++) {
      lines.push(`-test("case ${i}", () => {`);
      lines.push(`+test("case ${i} renamed", () => {`);
      lines.push(`   assert.equal(f(${i}), ${i});`);
      lines.push(`-});`);
      lines.push(`+});`);
    }
    const started = process.hrtime.bigint();
    const res = checkTestTampering(lines.join("\n"));
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`  4000-line refactor: ${ms.toFixed(1)} ms, ${res.violations.length} violations`);
    assert.ok(ms < 2000, `took ${ms.toFixed(1)} ms`);
    assert.equal(res.ok, true, JSON.stringify(res.violations.slice(0, 3)));
  });
});
