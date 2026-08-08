import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fingerprintFailureState, repair } from "../src/engine.mjs";

describe("OODA State Fingerprinting & Thrash Detection", () => {
  test("generates consistent 16-character failure fingerprint", () => {
    const f1 = { stderr: "Error at file.js:42:10\nStack trace line 1" };
    const f2 = { stderr: "Error at file.js:99:88\nStack trace line 1" };

    const fp1 = fingerprintFailureState(f1);
    const fp2 = fingerprintFailureState(f2);

    assert.strictEqual(fp1.length, 16);
    assert.strictEqual(fp1, fp2);
  });

  test("aborts repair loop early on deterministic regression (identical state fingerprint)", async () => {
    const tmpDir = join(process.cwd(), ".agent/test-ooda-" + Date.now());
    mkdirSync(join(tmpDir, ".agent"), { recursive: true });
    writeFileSync(join(tmpDir, ".agent/jules.yml"), "test_cmd: node -e 'process.exit(1)'\nbuild_cmd: ''\n");

    const mockFailure = {
      command: "node -e 'process.exit(1)'",
      stderr: "AssertionError: expected true to be false",
      status: 1,
    };

    const mockProvider = {
      dispatch: async (task) => {
        return { id: "mock-session-1", task };
      },
    };

    try {
      const res = await repair(mockFailure, {
        root: tmpDir,
        base: "nonexistent-branch",
        dryRun: true,
        provider: mockProvider,
        config: {
          baseBranch: "nonexistent-branch",
          provider: "jules",
          verify: { test: "node -e 'process.exit(1)'", build: "" },
          limits: { repairAttempts: 3, dailyTasks: 300 },
          scope: { deny: [], allow: [], protect: [] },
        },
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.finalStatus, "DETERMINISTIC_REGRESSION");
      assert.ok(res.reason.includes("Identical failure state fingerprint"));
      assert.strictEqual(res.attempts.length, 1);
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });
});
