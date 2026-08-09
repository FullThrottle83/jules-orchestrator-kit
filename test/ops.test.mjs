import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runDoctorChecks, computeReportHash } from "../src/ops/doctor-registry.mjs";
import { planDiagnosticFixes } from "../src/ops/doctor-planner.mjs";
import { applyActionPlan, verifyPreconditions } from "../src/ops/transaction.mjs";
import { createOperationReceipt, loadOperationReceipt, computeReceiptHash } from "../src/ops/receipts.mjs";

test("src/ops/transaction.mjs verifyPreconditions", async (t) => {
  await t.test("verifyPreconditions fails when file-hash mismatches", () => {
    const tempDir = createTempDir();
    try {
      const plan = {
        preconditions: [
          {
            kind: "file-hash",
            target: "non-existent.txt",
            expected: "sha256:1234",
          },
        ],
      };
      assert.throws(() => verifyPreconditions(plan, tempDir), /Precondition failed/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test("createOperationReceipt computes hash and saves receipt", () => {
    const tempDir = createTempDir();
    try {
      const receipt = createOperationReceipt(tempDir, {
        actionPlanId: "PLAN-1",
        kind: "test",
        title: "Test Receipt",
        status: "success",
      });
      assert.ok(receipt.receiptHash.startsWith("sha256:"));
      const hash = computeReceiptHash(receipt);
      assert.equal(receipt.receiptHash, hash);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function createTempDir() {
  return mkdtempSync(join(tmpdir(), "jules-ops-test-"));
}

test("src/ops/doctor-registry.mjs", async (t) => {
  await t.test("runDoctorChecks generates valid report with hash", async () => {
    const tempDir = createTempDir();
    try {
      const report = await runDoctorChecks({ root: tempDir, activeProbe: false });
      assert.equal(report.schema, "agentctl/doctor-report-v1");
      assert.equal(typeof report.reportHash, "string");
      assert.ok(report.reportHash.startsWith("sha256:"));
      assert.ok(report.results.length >= 5);

      const expectedHash = computeReportHash(report);
      assert.equal(report.reportHash, expectedHash);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test("categorizes checks into System, Repo, Config, State, Jules", async () => {
    const tempDir = createTempDir();
    try {
      const report = await runDoctorChecks({ root: tempDir });
      const categories = new Set(report.results.map((r) => r.category));
      assert.ok(categories.has("System"));
      assert.ok(categories.has("Config"));
      assert.ok(categories.has("State"));
      assert.ok(categories.has("Jules"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

test("src/ops/doctor-planner.mjs", async (t) => {
  await t.test("planDiagnosticFixes plans safe automatic fixes", async () => {
    const tempDir = createTempDir();
    try {
      const report = await runDoctorChecks({ root: tempDir });
      const plans = await planDiagnosticFixes({
        root: tempDir,
        report,
        selectedFixIds: ["safe"],
      });

      assert.ok(plans.length >= 1);
      const createConfigPlan = plans.find((p) => p.kind === "config.create-default");
      assert.ok(createConfigPlan);
      assert.equal(createConfigPlan.schema, "agentctl/action-plan-v1");
      assert.equal(createConfigPlan.risk, "low");
      assert.ok(createConfigPlan.preview.unifiedDiff.includes("--- a/.agent/config.yml"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

test("src/ops/transaction.mjs & receipts.mjs", async (t) => {
  await t.test("applies file creation plan atomically and generates receipt", async () => {
    const tempDir = createTempDir();
    try {
      const plan = {
        schema: "agentctl/action-plan-v1",
        id: "PLAN-TEST-1",
        kind: "config.create-default",
        title: "Create test file",
        repository: tempDir,
        createdAt: new Date().toISOString(),
        preconditions: [],
        fileMutations: [
          {
            operation: "create",
            path: "test-file.txt",
            newContent: "Hello Transaction",
          },
        ],
        commandEffects: [],
      };

      const receipt = await applyActionPlan(plan, { root: tempDir });
      assert.equal(receipt.schema, "agentctl/operation-receipt-v1");
      assert.equal(receipt.status, "success");
      assert.equal(receipt.mutationsApplied.length, 1);

      const createdFile = join(tempDir, "test-file.txt");
      assert.ok(existsSync(createdFile));
      assert.equal(readFileSync(createdFile, "utf-8"), "Hello Transaction");

      // Verify saved receipt
      const loaded = loadOperationReceipt(tempDir, receipt.receiptId);
      assert.equal(loaded.receiptHash, receipt.receiptHash);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test("rolls back mutations on failure", async () => {
    const tempDir = createTempDir();
    try {
      const existingPath = join(tempDir, "existing.txt");
      writeFileSync(existingPath, "Original Content", "utf-8");

      const failingPlan = {
        schema: "agentctl/action-plan-v1",
        id: "PLAN-FAIL-1",
        kind: "test.fail",
        title: "Failing transaction test",
        repository: tempDir,
        createdAt: new Date().toISOString(),
        preconditions: [],
        fileMutations: [
          {
            operation: "replace",
            path: "existing.txt",
            newContent: "Modified Content",
          },
        ],
        commandEffects: [
          {
            executable: "non-existent-command-12345",
            args: [],
            cwd: tempDir,
            timeoutMs: 1000,
          },
        ],
      };

      await assert.rejects(
        async () => {
          await applyActionPlan(failingPlan, { root: tempDir });
        },
        /Action plan execution failed and was rolled back/
      );

      // Verify original content was restored
      assert.equal(readFileSync(existingPath, "utf-8"), "Original Content");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
