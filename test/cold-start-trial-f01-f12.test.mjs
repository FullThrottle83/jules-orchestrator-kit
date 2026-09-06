import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { checkTestTampering, scanDiff } from "../src/security.mjs";
import { isTestPath } from "../src/test-paths.mjs";
import { calculateDiffCoverage } from "../src/coverage.mjs";

/**
 * Regression tests for the second cold-start trial's widened tamper guard:
 *
 *   F01 — root test.js not classified as a test file
 *   F03 — a conditional expectation blessing a broken function
 *   F04 — tests leaving the run via rename, attribute removal, build tag,
 *         cfg(any()), xfail, or an early return
 *   F05 — a Go assertion neutralised by an impossible condition
 *   F12 — diff coverage passing having scored none of a new file
 *
 * Each reproduces the trial's edit shape and asserts the *verdict a caller
 * receives* (`scanDiff(...).ok` and the gate exit status), not only that a
 * violation with the expected name exists — the contract that once stayed
 * green for two releases while the gate rejected everything.
 */

const diff = (file, removed, added, { context = "// ctx", lead = [] } = {}) =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1,40 +1,40 @@",
    ` ${context}`,
    ...lead.map((l) => ` ${l}`),
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    ` ${context}`,
  ].join("\n");

const blocks = (file, removed, added, opts) => {
  const d = diff(file, removed, added, opts);
  const res = scanDiff(d);
  return res.ok === false && (res.findings || []).some((f) => f.type === "TEST_TAMPERING_DETECTED");
};
const silent = (file, removed, added, opts) => {
  const d = diff(file, removed, added, opts);
  const res = scanDiff(d);
  const tamper = (res.findings || []).filter((f) => f.type === "TEST_TAMPERING_DETECTED");
  return res.ok === true && tamper.length === 0;
};

describe("F01 — the canonical root test file is inside the guard", () => {
  it("classifies test.js at the repository root", () => {
    assert.equal(isTestPath("test.js"), true);
    assert.equal(isTestPath("test.mjs"), true);
    assert.equal(isTestPath("test.ts"), true);
  });

  it("does not over-classify non-Node bare test files", () => {
    for (const f of ["test.py", "test.go", "test.rb", "test.helpers.js", "tests.js", "testing.js"]) {
      assert.equal(isTestPath(f), false, `${f} should not be a classified test file`);
    }
  });

  it("blocks a deleted assertion in root test.js", () => {
    assert.ok(
      blocks("test.js", ["\tt.is(limit.activeCount, 0);"], [], { context: "// active" }),
      "deletion in test.js was approved"
    );
  });

  it("blocks a vacuous replacement in root test.js", () => {
    assert.ok(
      blocks("test.js", ["\tt.is(limit.activeCount, 0);"], ["\tt.true(true);"], { context: "// active" }),
      "vacuous replacement in test.js was approved"
    );
  });

  it("blocks an expectation rewritten in root test.js", () => {
    assert.ok(
      blocks("test.js", ["\tt.is(limit.pendingCount, 0);"], ["\tt.is(limit.pendingCount, 1000);"], { context: "// pending" }),
      "expectation rewrite in test.js was approved"
    );
  });

  it("still counts t.is(...) / t.true(...) assertions", () => {
    const res = checkTestTampering(diff("test.js", [], ["\tt.is(x, 1);"], { context: "// x" }));
    assert.ok(res.assertionsSeen > 0, "t.is assertions were not counted in the root file");
  });
});

describe("F03 — a conditional expectation does not bless a broken function", () => {
  it("blocks the Python ternary spelling from the trial", () => {
    assert.ok(
      blocks(
        "tests/test_encoding.py",
        ["    assert dec == value"],
        ["    assert dec == (193 if value == 192 else value)"],
        { context: "# encoding" }
      )
    );
  });

  it("blocks the JS ternary spelling", () => {
    assert.ok(
      blocks(
        "test/calc.test.js",
        ["  assert.strictEqual(add(1, 2), 3);"],
        ["  assert.strictEqual(add(1, 2), add(1, 2) === -1 ? -1 : 3);"],
        { context: "// arithmetic" }
      )
    );
  });

  it("stays silent for a brand-new conditional assertion (no removed original)", () => {
    assert.ok(
      silent("test/calc.test.js", [], ["  assert.strictEqual(add(1, 2), flag ? 3 : 3);"], { context: "// arithmetic" }),
      "a new conditional assertion was reported as a rewrite"
    );
  });

  it("stays silent for an identifier renamed in the expectation (no conditional)", () => {
    assert.ok(
      silent("tests/test_calc.py", ["    assert add(1, 2) == expected"], ["    assert add(1, 2) == wanted"], {
        context: "# arithmetic",
      }),
      "renaming a variable compared against is not a conditional rewrite"
    );
  });
});

describe("F04 — tests cannot leave the run without the guard noticing", () => {
  it("catches pytest test_x -> check_x / disabled_x", () => {
    assert.ok(blocks("tests/test_encoding.py", ["def test_want_bytes(value):"], ["def check_want_bytes(value):"], { context: "# w" }));
    assert.ok(blocks("tests/test_encoding.py", ["def test_want_bytes(value):"], ["def disabled_want_bytes(value):"], { context: "# w" }));
  });

  it("keeps the original test_x -> x strip and still allows honest renames", () => {
    assert.ok(blocks("tests/test_totals.py", ["def test_totals():"], ["def totals():"], { context: "# t" }));
    assert.ok(silent("tests/test_encoding.py", ["def test_want_bytes(value):"], ["def test_want_bytes_for_text(value):"], { context: "# w" }));
    // pytest's test* glob collects this without the underscore.
    assert.ok(silent("tests/test_encoding.py", ["def test_want_bytes(value):"], ["def testwant_bytes(value):"], { context: "# w" }));
  });

  it("catches Go TestX -> checkX and stays silent on TestXRenamed", () => {
    assert.ok(blocks("is_test.go", ["func TestLoadComment(t *testing.T) {"], ["func checkLoadComment(t *testing.T) {"], { context: "// l" }));
    assert.ok(silent("is_test.go", ["func TestLoadComment(t *testing.T) {"], ["func TestLoadCommentFromFixture(t *testing.T) {"], { context: "// l" }));
  });

  it("catches a removed Rust #[test] attribute", () => {
    assert.ok(
      blocks(
        "tests/iter_tests/all.rs",
        ["#[test]", "fn peek_does_not_advance() {"],
        ["fn check_peek_does_not_advance() {"],
        { context: "// iter" }
      )
    );
  });

  it("stays silent when #[test] is kept on a renamed fn (honest Rust rename)", () => {
    assert.ok(
      silent(
        "tests/iter_tests/all.rs",
        ["#[test]", "fn peek_does_not_advance() {"],
        ["#[test]", "fn peek_preserves_position() {"],
        { context: "// iter" }
      )
    );
  });

  it("catches #[cfg(any())], xfail decorators, and an early body return", () => {
    assert.ok(
      blocks(
        "tests/iter_tests/all.rs",
        ["#[test]", "fn peek() {"],
        ["#[test]", "#[cfg(any())]", "fn peek() {"],
        { context: "// iter" }
      )
    );
    assert.ok(
      blocks(
        "tests/test_app.py",
        [],
        ['@pytest.mark.xfail(reason="broken", strict=False)'],
        { context: "# app" }
      )
    );
    assert.ok(
      blocks(
        "tests/test_encoding.py",
        ["def test_int_bytes(value, expect):", "    assert dec == value"],
        ["def test_int_bytes(value, expect):", "    return", "    assert dec == value"],
        { context: "# enc" }
      )
    );
  });

  it("catches impossible and private-tag Go build constraints, stays silent on versions", () => {
    assert.ok(blocks("is_test.go", [], ["//go:build ignore"], { context: "// build" }));
    assert.ok(blocks("is-1.7_test.go", ["//go:build go1.7"], ["//go:build go1.7 && cold_start_never"], { context: "// build" }));
    assert.ok(silent("is-1.7_test.go", ["//go:build go1.7"], ["//go:build go1.24"], { context: "// build" }));
  });

  it("does not flag a real guard clause's early return", () => {
    // The return is inside an `if` branch — reachable code, not the body's
    // first statement.
    const res = checkTestTampering(
      diff(
        "tests/test_encoding.py",
        ["def test_int_bytes(value, expect):", "    if not data:", "        return", "    assert dec == value"],
        ["def test_int_bytes(value, expect):", "    if not data or not ready:", "        return", "    assert dec == value"],
        { context: "# enc" }
      )
    );
    assert.deepEqual(res.violations.map((v) => v.type), []);
  });
});

describe("F05 — an impossible condition cannot neutralise an assertion", () => {
  it("blocks the trial's if len(comment) < 0 edit", () => {
    assert.ok(
      blocks(
        "is_test.go",
        ['\tif comment != `this comment will be extracted` {', '\t\tt.Errorf("loadComment: bad %s", comment)', "\t}"],
        ["\tif len(comment) < 0 {", '\t\tt.Errorf("loadComment: bad %s", comment)', "\t}"],
        { context: "// load" }
      )
    );
  });

  it("stays silent for a reachable guard (len(x) == 0) and an honest retarget", () => {
    assert.ok(
      silent(
        "is_test.go",
        ["\tif comment != \"\" {", '\t\tt.Errorf("empty")', "\t}"],
        ["\tif len(users) == 0 {", '\t\tt.Errorf("empty")', "\t}"],
        { context: "// load" }
      )
    );
  });
});

describe("F12 — coverage that scored none of a new Node file does not pass", () => {
  it("treats an unexecuted added JS module as uncovered", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "f12-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "arithmetic.js"), "export function add(a, b) {\n  return a - b;\n}\n");
      const d = [
        "diff --git a/src/arithmetic.js b/src/arithmetic.js",
        "--- /dev/null",
        "+++ b/src/arithmetic.js",
        "@@ -0,0 +1,3 @@",
        "+export function add(a, b) {",
        "+  return a - b;",
        "+}",
      ].join("\n");
      const report = calculateDiffCoverage(new Map(), d, { root, minCoverage: 100 });
      assert.equal(report.ok, false, "ok=true for code the test run never executed");
      assert.equal(report.scored, true);
      assert.equal(report.score, 0);
      assert.ok(report.totalLines > 0);
      assert.ok((report.unobservedFiles || []).includes("src/arithmetic.js"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps non-Node added code and comment-only diffs not-applicable", () => {
    const py = [
      "diff --git a/src/a.py b/src/a.py",
      "--- /dev/null",
      "+++ b/src/a.py",
      "@@ -0,0 +1,2 @@",
      "+def add(a, b):",
      "+    return a - b",
    ].join("\n");
    const pyReport = calculateDiffCoverage(new Map(), py, { root: "/", minCoverage: 100 });
    assert.equal(pyReport.ok, true);
    assert.equal(pyReport.scored, false);
    assert.equal(pyReport.score, null);
  });
});

describe("the verdict a caller receives", () => {
  const SCRIPT = fileURLToPath(new URL("../scripts/guard-reach-check.mjs", import.meta.url));
  const ROOT = fileURLToPath(new URL("..", import.meta.url));

  it("the activation meta-check is green and every widened rule has a canary", () => {
    const res = spawnSync(process.execPath, [SCRIPT, "--json"], { cwd: ROOT, encoding: "utf-8" });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const report = JSON.parse(res.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.activationCoverage.activated, report.activationCoverage.canaries);
  });

  it("findings block through scanDiff, not only through the violation list", () => {
    // The contract that once stayed green for two releases while the gate
    // rejected everything: assert the answer a gate actually receives.
    const d = diff("tests/test_encoding.py", ["def test_want_bytes(value):"], ["def check_want_bytes(value):"], { context: "# w" });
    const res = scanDiff(d);
    assert.equal(res.ok, false);
    assert.ok(res.findings.some((f) => f.severity === "CRITICAL"));
  });
});
