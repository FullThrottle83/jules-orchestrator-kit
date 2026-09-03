import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import {
  generateLineMutants,
  generateMutants,
  generateDiffMutants,
  executeMutant,
  runMutationTest,
  getFileStringLiteralLineMap,
  isExcludedFromMutation,
} from "../src/mutation.mjs";
import { assertMutation } from "../src/assertions.mjs";

const CLI = fileURLToPath(new URL("../bin/agentctl.mjs", import.meta.url));

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "jules-mutation-test-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "test-app", version: "1.0.0", type: "module", scripts: { test: "node --test" } }),
    "utf-8"
  );
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

test("Diff Mutation Testing Engine", async (t) => {
  await t.test("isExcludedFromMutation correctly identifies non-implementation files", () => {
    assert.equal(isExcludedFromMutation("src/engine.test.mjs"), true);
    assert.equal(isExcludedFromMutation("test/security.spec.js"), true);
    assert.equal(isExcludedFromMutation("package.json"), true);
    assert.equal(isExcludedFromMutation("README.md"), true);
    assert.equal(isExcludedFromMutation(".agent/rules/jules.md"), true);
    assert.equal(isExcludedFromMutation("src/engine.mjs"), false);
    assert.equal(isExcludedFromMutation("lib/auth.ts"), false);
  });

  await t.test("generateLineMutants generates discrete operator mutations", () => {
    // Equality
    const eqMutants = generateLineMutants("if (user.role === 'admin') {", 10, "src/auth.js");
    assert.ok(eqMutants.some((m) => m.mutatedLine.includes("!==")));

    // Relational
    const relMutants = generateLineMutants("if (count >= 10) {", 12, "src/counter.js");
    assert.ok(relMutants.some((m) => m.mutatedLine.includes("<")));

    // Logical
    const logMutants = generateLineMutants("return isValid && hasPermission;", 15, "src/guard.js");
    assert.ok(logMutants.some((m) => m.mutatedLine.includes("||")));

    // Arithmetic
    const arithMutants = generateLineMutants("const total = a + b;", 20, "src/calc.js");
    assert.ok(arithMutants.some((m) => m.mutatedLine.includes("a - b")));

    // Boolean Return
    const retMutants = generateLineMutants("return true;", 25, "src/check.js");
    assert.ok(retMutants.some((m) => m.mutatedLine.includes("return false")));

    // Skips comments and imports
    assert.deepEqual(generateLineMutants("// if (a === b)", 1, "src/test.js"), []);
    assert.deepEqual(generateLineMutants("import { x } from 'y';", 1, "src/test.js"), []);
  });

  await t.test("generateMutants generates mutants for multi-line file content", () => {
    const code = `
export function compute(x, y) {
  if (x === y) return true;
  return x + y;
}
`;
    const mutants = generateMutants(code, "src/compute.js");
    assert.ok(mutants.length >= 2);
    assert.ok(mutants.some((m) => m.mutationType === "EQUALITY"));
  });

  await t.test("getFileStringLiteralLineMap shields multiline template literals and block comments", () => {
    const code = `
const usage = \`
  Usage: agentctl <command>
  Options: --min-score, --max-mutants
  Pipe: npm test 2>&1 | agentctl fix
\`;
export function check(a, b) {
  /* multi-line
     comment with === and +
  */
  return a === b;
}
`;
    const lineMap = getFileStringLiteralLineMap(code);
    assert.ok(lineMap.get(3).length > 0); // inside template literal
    assert.ok(lineMap.get(4).length > 0); // inside template literal

    const mutants = generateMutants(code, "src/cli.js");
    // Should NOT mutate --min-score or 2>&1 in template literal or /* === */ in block comment
    assert.ok(!mutants.some((m) => m.originalLine.includes("Usage:")));
    assert.ok(!mutants.some((m) => m.originalLine.includes("--min-score")));
    assert.ok(!mutants.some((m) => m.originalLine.includes("comment with")));
    assert.ok(mutants.some((m) => m.originalLine.includes("return a === b")));
  });

  await t.test("generateDiffMutants extracts candidate mutants strictly from added lines in diff", () => {
    const diff = `
diff --git a/src/math.js b/src/math.js
--- a/src/math.js
+++ b/src/math.js
@@ -1,3 +1,5 @@
 function add(a, b) {
-  return 0;
+  if (a === 0) return b;
+  return a + b;
 }
`;
    const mutants = generateDiffMutants(diff);
    assert.ok(mutants.length >= 2);
    assert.ok(mutants.some((m) => m.mutatedLine.includes("a !== 0")));
    assert.ok(mutants.some((m) => m.mutatedLine.includes("a - b")));
  });

  await t.test("executeMutant executes test and restores file content safely", () => {
    const dir = tempRepo();
    try {
      const srcFile = join(dir, "calc.mjs");
      const originalCode = "export function isPositive(n) {\n  return n > 0;\n}\n";
      writeFileSync(srcFile, originalCode, "utf-8");

      const mutant = {
        id: "calc.mjs:2:rel",
        file: "calc.mjs",
        line: 2,
        originalLine: "  return n > 0;",
        mutatedLine: "  return n <= 0;",
        mutationType: "RELATIONAL",
        description: "Inverted comparison (> -> <=)",
      };

      // Mock executor that asserts mutant was applied, then fails the test (killing mutant)
      let observedContentDuringExec = "";
      const res = executeMutant(mutant, {
        root: dir,
        executor: ({ absPath }) => {
          observedContentDuringExec = readFileSync(absPath, "utf-8");
          return { exitCode: 1, stderr: "Assertion failed: expected true, got false" };
        },
      });

      assert.equal(res.status, "KILLED");
      assert.ok(observedContentDuringExec.includes("return n <= 0;"));
      // Assert rollback restored original code
      assert.equal(readFileSync(srcFile, "utf-8"), originalCode);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("runMutationTest calculates accurate mutation score and identifies survivors", () => {
    const dir = tempRepo();
    try {
      const srcFile = join(dir, "calc.mjs");
      writeFileSync(srcFile, "export function check(x) {\n  return x === 10;\n}\n", "utf-8");

      const report = runMutationTest({
        root: dir,
        files: ["calc.mjs"],
        minScore: 80,
        executor: () => ({ exitCode: 1 }),
      });

      assert.equal(report.totalMutants > 0, true);
      assert.equal(report.killedMutants, report.totalMutants);
      assert.equal(report.mutationScore, 100);
      assert.equal(report.ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("assertMutation primitive returns diagnostic on low score", () => {
    const dir = tempRepo();
    try {
      const srcFile = join(dir, "app.mjs");
      writeFileSync(srcFile, "export function calc(a, b) {\n  return a + b;\n}\n", "utf-8");

      // Test with minScore 100 but all mutants survive (exitCode 0)
      const res = assertMutation(
        {
          files: ["app.mjs"],
          minScore: 100,
          executor: () => ({ exitCode: 0 }),
        },
        dir
      );

      // Mutants survived because mock command exited 0
      assert.equal(res.ok, false);
      assert.ok(res.diagnostics.length > 0);
      assert.match(res.diagnostics[0], /Mutation score/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("agentctl mutate CLI command outputs JSON report", () => {
    const dir = tempRepo();
    try {
      const srcFile = join(dir, "index.mjs");
      writeFileSync(srcFile, "export function isValid(n) {\n  return n > 0;\n}\n", "utf-8");

      const res = spawnSync(process.execPath, [CLI, "mutate", "--json", "--min-score", "0"], {
        cwd: dir,
        encoding: "utf-8",
      });

      assert.equal(res.status, 0);
      const parsed = JSON.parse(res.stdout);
      // `totalMutants > 0` is the part that matters. This assertion used to be
      // satisfied by the vacuous 100 the harness returned for an empty mutant
      // population — and the population was empty because the synthetic diff
      // for an untracked file carried no `@@` header, so the mutation engine
      // could not place a single added line. The test passed on the defect it
      // should have caught.
      assert.ok(parsed.totalMutants > 0, "a new file with `n > 0` in it must yield at least one mutant");
      assert.equal(parsed.scored, undefined, "a real run reports a measured score, not the unscored shape");
      assert.equal(typeof parsed.mutationScore, "number");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
