import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  flakyVerdict,
  recordVerifyRun,
  readVerifyRuns,
  // eslint-disable-next-line no-unused-vars
  wilsonScoreInterval,
  // eslint-disable-next-line no-unused-vars
  computeOscillation,
} from "../src/flaky-ledger.mjs";
import { gate } from "../src/engine.mjs";

describe("Statistical Flaky Test Quarantine & Ledger", () => {
  test("Alternating P/F/P/F runs evaluate to QUARANTINED and allowRepair = false", () => {
    const runs = [
      { pass: true },
      { pass: false },
      { pass: true },
      { pass: false },
      { pass: true },
      { pass: false },
    ];
    const verdict = flakyVerdict(runs);
    assert.strictEqual(verdict.verdict, "QUARANTINED");
    assert.strictEqual(verdict.allowRepair, false);
    assert.strictEqual(verdict.n, 6);
    assert.strictEqual(verdict.fails, 3);
    assert.strictEqual(verdict.oscillation, 1.0);
  });

  test("6 consecutive failures evaluate to REPAIRABLE_REGRESSION and allowRepair = true", () => {
    const runs = [
      { pass: false },
      { pass: false },
      { pass: false },
      { pass: false },
      { pass: false },
      { pass: false },
    ];
    const verdict = flakyVerdict(runs);
    assert.strictEqual(verdict.verdict, "REPAIRABLE_REGRESSION");
    assert.strictEqual(verdict.allowRepair, true);
    assert.strictEqual(verdict.n, 6);
    assert.strictEqual(verdict.fails, 6);
  });

  test("0 failures evaluate to HEALTHY and allowRepair = true", () => {
    const runs = [true, true, true, true, true, true];
    const verdict = flakyVerdict(runs);
    assert.strictEqual(verdict.verdict, "HEALTHY");
    assert.strictEqual(verdict.allowRepair, true);
  });

  test("Fewer than 6 runs evaluate to INSUFFICIENT_DATA and allowRepair = true when mixed", () => {
    const runs = [true, false, true, false];
    const verdict = flakyVerdict(runs);
    assert.strictEqual(verdict.verdict, "INSUFFICIENT_DATA");
    assert.strictEqual(verdict.allowRepair, true);
  });

  test("Trailing 3 failures evaluate to REPAIRABLE_REGRESSION even with mixed history", () => {
    const runs = [true, false, true, false, false, false];
    const verdict = flakyVerdict(runs);
    assert.strictEqual(verdict.verdict, "REPAIRABLE_REGRESSION");
    assert.strictEqual(verdict.allowRepair, true);
  });

  test("recordVerifyRun appends to .agent/state/flaky.jsonl and readVerifyRuns reads it", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flaky-ledger-test-"));
    try {
      const entry1 = recordVerifyRun(tmpDir, "npm test", true, null, 120);
      const entry2 = recordVerifyRun(tmpDir, "npm test", false, "fp123", 150);

      assert.strictEqual(entry1.pass, true);
      assert.strictEqual(entry2.pass, false);

      const runs = readVerifyRuns(tmpDir, "npm test");
      assert.strictEqual(runs.length, 2);
      assert.strictEqual(runs[0].pass, true);
      assert.strictEqual(runs[1].pass, false);
      assert.strictEqual(runs[1].fingerprint, "fp123");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("Gate returns exit code 8 when test is quarantined", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flaky-gate-test-"));
    const opts = { cwd: tmpDir, stdio: "ignore" };

    try {
      execFileSync("git", ["init", "-b", "main"], opts);
      execFileSync("git", ["config", "user.name", "TestUser"], opts);
      execFileSync("git", ["config", "user.email", "test@example.com"], opts);

      fs.writeFileSync(path.join(tmpDir, "README.md"), "# Flaky Test Repo\n");
      execFileSync("git", ["add", "."], opts);
      execFileSync("git", ["commit", "-m", "initial commit"], opts);

      const testCmd = "node -e process.exit(1)";

      // Seed 5 alternating runs (P, F, P, F, P)
      recordVerifyRun(tmpDir, testCmd, true, null, 50);
      recordVerifyRun(tmpDir, testCmd, false, "fp1", 50);
      recordVerifyRun(tmpDir, testCmd, true, null, 50);
      recordVerifyRun(tmpDir, testCmd, false, "fp2", 50);
      recordVerifyRun(tmpDir, testCmd, true, null, 50);

      // Run gate with failing testCmd (adds 6th run: F, triggering QUARANTINED)
      const config = {
        baseBranch: "main",
        scope: { deny: [] },
        limits: { diffKb: 75 },
        verify: { test: testCmd },
      };

      const gateRes = await gate({ root: tmpDir, config, fix: true });

      assert.strictEqual(gateRes.ok, false);
      assert.strictEqual(gateRes.code, 8);
      assert.ok(gateRes.flakyVerdict);
      assert.strictEqual(gateRes.flakyVerdict.verdict, "QUARANTINED");
      assert.strictEqual(gateRes.flakyVerdict.allowRepair, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
