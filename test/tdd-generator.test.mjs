import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { scaffoldTddTest, runTddCycle } from "../src/ops/tdd-generator.mjs";

test("Automated TDD Red-to-Green Harness", async (t) => {
  let tmpDir;

  t.beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tdd-test-"));
    execSync("git init -b main", { cwd: tmpDir, stdio: "ignore" });
    execSync("git config user.name 'Test'", { cwd: tmpDir, stdio: "ignore" });
    execSync("git config user.email 'test@test.com'", { cwd: tmpDir, stdio: "ignore" });
  });

  t.afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("a) scaffoldTddTest creates a targeted falsifiable test file", () => {
    const res = scaffoldTddTest(
      { title: "auth-jwt-verifier", spec: "Must reject expired JWT tokens with 401 Unauthorized error" },
      { root: tmpDir }
    );

    assert.ok(existsSync(res.filePath));
    const content = readFileSync(res.filePath, "utf-8");
    assert.ok(content.includes("auth-jwt-verifier"));
    assert.ok(content.includes("Must reject expired JWT tokens"));
  });

  await t.test("b) runTddCycle verifies test fails RED and locks file in scope.deny", async () => {
    const res = await runTddCycle(
      { title: "failing-feature", spec: "Unimplemented requirement specification" },
      { root: tmpDir }
    );

    assert.equal(res.ok, true);
    assert.equal(res.step, "RED_VERIFIED");
    assert.ok(res.lockedScopeDeny.includes(res.testFile));
  });
});
