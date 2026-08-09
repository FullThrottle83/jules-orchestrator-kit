import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fingerprintFailureState, repair, OODACircuitBreaker } from "../src/engine.mjs";

describe("OODA State Fingerprinting & Thrash Detection", () => {
  test("normalizes ANSI escape codes correctly", () => {
    const colored = { stderr: "\x1b[31mError\x1b[0m at file.js:42:10\nStack trace line 1" };
    const uncolored = { stderr: "Error at file.js:42:10\nStack trace line 1" };
    
    const fp1 = fingerprintFailureState(colored);
    const fp2 = fingerprintFailureState(uncolored);

    assert.strictEqual(fp1, fp2);
  });

  test("normalizes query parameters correctly", () => {
    const withQueryParams1 = { stderr: "Failed to fetch http://localhost:3000/api/users?id=123&token=abc\nError at file.js:42:10" };
    const withQueryParams2 = { stderr: "Failed to fetch http://localhost:3000/api/users?id=999&token=xyz\nError at file.js:42:10" };

    const fp1 = fingerprintFailureState(withQueryParams1);
    const fp2 = fingerprintFailureState(withQueryParams2);

    assert.strictEqual(fp1, fp2);
  });

  test("normalizes variable line and column numbers correctly", () => {
    // Test :line:col
    const err1 = { stderr: "Error at file.js:42:10" };
    const err2 = { stderr: "Error at file.js:99:88" };
    assert.strictEqual(fingerprintFailureState(err1), fingerprintFailureState(err2));

    // Test :line only
    const err3 = { stderr: "Error at file.js:50" };
    const err4 = { stderr: "Error at file.js:200" };
    assert.strictEqual(fingerprintFailureState(err3), fingerprintFailureState(err4));

    // Test "line 123" / "line 999"
    const err5 = { stderr: "Error on line 123 of script.js" };
    const err6 = { stderr: "Error on line 999 of script.js" };
    assert.strictEqual(fingerprintFailureState(err5), fingerprintFailureState(err6));

    // Test "column 45" / "col 10" / "column 99" / "col 2"
    const err7 = { stderr: "Error on line 12 col 10" };
    const err8 = { stderr: "Error on line 12 col 99" };
    assert.strictEqual(fingerprintFailureState(err7), fingerprintFailureState(err8));
  });

  test("OODACircuitBreaker resets correctly after cooldown period expiry", () => {
    const breaker = new OODACircuitBreaker({ windowSize: 3, threshold: 2, cooldownMs: 1000 });
    const fp = "abc123xyz";

    // 1. First observation (not tripped)
    let res = breaker.observe(fp);
    assert.strictEqual(res.tripped, false);

    // 2. Second observation of same fingerprint (tripped)
    res = breaker.observe(fp);
    assert.strictEqual(res.tripped, true);
    assert.strictEqual(res.reason, "OODA_THRASH_DETECTED");
    assert.strictEqual(breaker.isOpen(), true);

    // 3. Mock Date.now to simulate cooldown expiry
    const originalDateNow = Date.now;
    try {
      const startTime = Date.now();
      // Fast forward by 1500ms
      Date.now = () => startTime + 1500;

      // Circuit should now be closed (i.e. isOpen() returns false, state reset)
      assert.strictEqual(breaker.isOpen(), false);
      
      // Let's observe again - since it's reset, it should not be tripped on first observation
      res = breaker.observe(fp);
      assert.strictEqual(res.tripped, false);
    } finally {
      Date.now = originalDateNow;
    }
  });
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
