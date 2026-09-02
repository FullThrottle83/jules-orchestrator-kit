import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import {
  mapV8RangesToLines,
  extractAddedLinesFromDiff,
  calculateDiffCoverage,
  isExcludedFromCoverage,
  runV8Coverage,
} from "../src/coverage.mjs";
import { assertDiffCoverage } from "../src/assertions.mjs";

const CLI = fileURLToPath(new URL("../bin/agentctl.mjs", import.meta.url));

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "jules-cov-test-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "test-pkg",
      version: "1.0.0",
      type: "module",
      scripts: { test: "node --test" },
    })
  );
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

test("Native V8 Diff Coverage Engine", async (t) => {
  await t.test("isExcludedFromCoverage correctly filters tests, configs, and docs", () => {
    assert.equal(isExcludedFromCoverage("src/math.mjs"), false);
    assert.equal(isExcludedFromCoverage("test/math.test.mjs"), true);
    assert.equal(isExcludedFromCoverage("tests/math.spec.js"), true);
    assert.equal(isExcludedFromCoverage(".agent/config.yml"), true);
    assert.equal(isExcludedFromCoverage("README.md"), true);
    assert.equal(isExcludedFromCoverage("package.json"), true);
  });

  await t.test("mapV8RangesToLines maps function offset ranges to line execution counts", () => {
    const code = [
      "export function add(a, b) {", // line 1 (covered)
      "  if (a === 0) {",            // line 2 (covered)
      "    return b;",                // line 3 (uncovered)
      "  }",                          // line 4
      "  return a + b;",              // line 5 (covered)
      "}",
    ].join("\n");

    // Range 0..CodeLength covered count 1, but range covering line 3 (offset 35..49) count 0
    const v8Functions = [
      {
        functionName: "add",
        ranges: [
          { startOffset: 0, endOffset: code.length, count: 1 },
          { startOffset: code.indexOf("return b;"), endOffset: code.indexOf("return b;") + "return b;".length, count: 0 },
        ],
      },
    ];

    const lineHits = mapV8RangesToLines(code, v8Functions);
    assert.equal(lineHits.get(1), 1);
    assert.equal(lineHits.get(2), 1);
    assert.equal(lineHits.get(3), 0);
    assert.equal(lineHits.get(5), 1);
  });

  await t.test("extractAddedLinesFromDiff extracts line numbers from unified diff", () => {
    const diff = [
      "diff --git a/src/calc.js b/src/calc.js",
      "--- a/src/calc.js",
      "+++ b/src/calc.js",
      "@@ -1,3 +1,5 @@",
      " function calc() {",
      "+  const x = 10;",
      "+  return x * 2;",
      " }",
    ].join("\n");

    const added = extractAddedLinesFromDiff(diff);
    assert.ok(added.has("src/calc.js"));
    assert.deepEqual(added.get("src/calc.js"), [2, 3]);
  });

  await t.test("calculateDiffCoverage evaluates 100% vs partial coverage accurately", () => {
    const root = tempRepo();
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      const srcFile = join(root, "src/math.js");
      writeFileSync(
        srcFile,
        "export function add(a, b) {\n  if (a === 0) return b;\n  return a + b;\n}\n"
      );

      const diff = [
        "diff --git a/src/math.js b/src/math.js",
        "--- /dev/null",
        "+++ b/src/math.js",
        "@@ -0,0 +1,4 @@",
        "+export function add(a, b) {",
        "+  if (a === 0) return b;",
        "+  return a + b;",
        "+}",
      ].join("\n");

      // Full coverage mock: all lines hit
      const fullCoverage = new Map([
        [
          "src/math.js",
          [
            {
              functionName: "add",
              ranges: [{ startOffset: 0, endOffset: 100, count: 1 }],
            },
          ],
        ],
      ]);

      const fullReport = calculateDiffCoverage(fullCoverage, diff, { root, minCoverage: 100 });
      assert.equal(fullReport.ok, true);
      assert.equal(fullReport.score, 100);
      assert.equal(fullReport.missedLines, 0);

      // Partial coverage mock: line 2 branch not taken
      const partialCoverage = new Map([
        [
          "src/math.js",
          [
            {
              functionName: "add",
              ranges: [
                { startOffset: 0, endOffset: 100, count: 1 },
                { startOffset: 28, endOffset: 52, count: 0 },
              ],
            },
          ],
        ],
      ]);

      const partialReport = calculateDiffCoverage(partialCoverage, diff, { root, minCoverage: 100 });
      assert.equal(partialReport.ok, false);
      assert.ok(partialReport.score < 100);
      assert.ok(partialReport.missedLines > 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("runV8Coverage collects real V8 coverage dumps using Node native flags", () => {
    const root = tempRepo();
    try {
      writeFileSync(
        join(root, "calc.mjs"),
        "export function double(n) { return n * 2; }\n"
      );
      writeFileSync(
        join(root, "calc.test.mjs"),
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { double } from "./calc.mjs";\ntest("doubles", () => { assert.equal(double(4), 8); });\n'
      );

      const res = runV8Coverage("node --test calc.test.mjs", { root });
      assert.equal(res.ok, true);
      assert.ok(res.coverageFiles > 0);
      assert.ok(res.coverageByFile.has("calc.mjs"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("assertDiffCoverage primitive validates coverage and reports diagnostics", () => {
    const root = tempRepo();
    try {
      writeFileSync(
        join(root, "calc.mjs"),
        "export function double(n) { return n * 2; }\n"
      );
      writeFileSync(
        join(root, "calc.test.mjs"),
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { double } from "./calc.mjs";\ntest("doubles", () => { assert.equal(double(4), 8); });\n'
      );

      const diff = [
        "diff --git a/calc.mjs b/calc.mjs",
        "--- /dev/null",
        "+++ b/calc.mjs",
        "@@ -0,0 +1,1 @@",
        "+export function double(n) { return n * 2; }",
      ].join("\n");

      const res = assertDiffCoverage(
        { cmd: "node --test calc.test.mjs", diffStr: diff, minCoverage: 100 },
        root
      );
      assert.equal(res.ok, true);
      assert.equal(res.score, 100);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("agentctl coverage CLI outputs JSON and returns exit 0 on clean coverage", () => {
    const root = tempRepo();
    try {
      writeFileSync(
        join(root, "app.mjs"),
        "export function greet() { return 'hello'; }\n"
      );
      writeFileSync(
        join(root, "app.test.mjs"),
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { greet } from "./app.mjs";\ntest("greets", () => { assert.equal(greet(), "hello"); });\n'
      );
      execFileSync("git", ["add", "."], { cwd: root });

      const proc = spawnSync(
        process.execPath,
        [CLI, "coverage", "--cmd", "node --test app.test.mjs", "--min", "100", "--json"],
        { cwd: root, encoding: "utf-8" }
      );

      assert.equal(proc.status, 0);
      const parsed = JSON.parse(proc.stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.score, 100);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
