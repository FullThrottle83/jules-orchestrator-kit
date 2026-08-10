import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gate, dispatch, synthesizePrDescription } from "../src/engine.mjs";

describe("src/engine.mjs", () => {
  it("gate passes clean repository verification", async () => {
    const res = await gate({ root: process.cwd(), base: "main" });
    assert.equal(typeof res.ok, "boolean");
    assert.ok(Array.isArray(res.phases));
  });

  it("dispatch generates dry-run session in dry-run mode", async () => {
    const task = { title: "Test Task", prompt: "Hello agent" };
    const session = await dispatch(task, { dryRun: true });
    assert.equal(session.id, "dry-run-session-id");
    assert.equal(session.status, "pending");
  });

  it("synthesizePrDescription generates evidence-backed PR description body", () => {
    const prBody = synthesizePrDescription(
      { id: "sess-777", attempts: [1, 2], resumed: true },
      {
        phases: [
          { phase: "scope", ok: true },
          { phase: "payload", ok: true, bytes: 12000, limitBytes: 76800 },
          { phase: "secrets", ok: true },
        ],
      },
      {
        durationMs: 4500,
        modifiedFiles: ["src/auth.mjs"],
        knownTestFiles: ["test/auth.test.mjs"],
        testOutput: "✔ 12 tests passed",
      }
    );

    assert.ok(prBody.includes("## 🚀 Autonomous Jules Agent Execution Evidence"));
    assert.ok(prBody.includes("`sess-777`"));
    assert.ok(prBody.includes("`2/3`"));
    assert.ok(prBody.includes("✅ Active Context Stream"));
    assert.ok(prBody.includes("✔ 12 tests passed"));
    assert.ok(prBody.includes("test/auth.test.mjs"));
  });

  it("gate executes setup -> test -> teardown lifecycle sequentially and guarantees teardown on failure", async () => {
    const { mkdtempSync, rmSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const tmpDir = mkdtempSync(join(tmpdir(), "lifecycle-test-"));
    const { execSync } = await import("node:child_process");
    try {
      execSync("git init -b main", { cwd: tmpDir, stdio: "ignore" });
      execSync("git config user.name 'Test'", { cwd: tmpDir, stdio: "ignore" });
      execSync("git config user.email 'test@test.com'", { cwd: tmpDir, stdio: "ignore" });
      execSync("git commit --allow-empty -m 'initial'", { cwd: tmpDir, stdio: "ignore" });
      const setupFile = join(tmpDir, "setup.flag");
      const testFile = join(tmpDir, "test.flag");
      const teardownFile = join(tmpDir, "teardown.flag");

      const mockConfig = {
        baseBranch: "main",
        scope: { deny: [], allow: [], protect: [] },
        limits: { diffKb: 75 },
        verify: {
          setup: `node -e "require('fs').writeFileSync('${setupFile.replace(/\\/g, "/")}', 'setup_ok')"`,
          test: `node -e "require('fs').writeFileSync('${testFile.replace(/\\/g, "/")}', 'test_ok'); process.exit(1)"`, // Fails test
          teardown: `node -e "require('fs').writeFileSync('${teardownFile.replace(/\\/g, "/")}', 'teardown_ok')"`,
          timeoutMs: 10000,
        },
      };

      const res = await gate({ root: tmpDir, config: mockConfig });
      assert.equal(res.ok, false, "Expected gate to fail due to process.exit(1)");
      assert.ok(existsSync(setupFile), "Expected setup command to execute");
      assert.ok(existsSync(testFile), "Expected test command to execute");
      assert.ok(existsSync(teardownFile), "Expected teardown command to execute unconditionally in finally block");
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });
});
