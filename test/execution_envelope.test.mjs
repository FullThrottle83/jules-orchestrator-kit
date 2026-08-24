import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  createExecutionEnvelope,
  verifyExecutionEnvelope,
  hashExecutionEnvelope,
} from "../src/execution-envelope.mjs";
import {
  appendLedger,
  verifyLedgerIntegrity,
  reserveBudget,
  commitBudgetReservation,
} from "../src/state.mjs";
import { classifyRiskTier, RISK_TIERS } from "../src/risk.mjs";
import { resolveBase, GateError } from "../src/git.mjs";

describe("Capability-Bounded Execution Envelope (CBEE)", () => {
  test("creates immutable envelope with verified hash", () => {
    const envelope = createExecutionEnvelope(
      { id: "task-101", files: ["src/utils.mjs"] },
      { base: "main" }
    );

    assert.ok(envelope.id);
    assert.strictEqual(envelope.taskId, "task-101");
    assert.ok(envelope.hash);
    assert.strictEqual(verifyExecutionEnvelope(envelope), true);

    // Verify Object.freeze prevents property mutation
    assert.throws(() => {
      envelope.riskTier = "R0_COSMETIC";
    }, TypeError);
  });

  test("detects tampered envelope payload", () => {
    const envelope = createExecutionEnvelope({ id: "task-102" });
    const tampered = { ...envelope, riskTier: "R3_RESTRICTED" };
    assert.strictEqual(verifyExecutionEnvelope(tampered), false);
  });

  test("hashes execution envelope deterministically", () => {
    const env1 = createExecutionEnvelope({ id: "task-103" });
    const hash1 = hashExecutionEnvelope(env1);
    const hash2 = hashExecutionEnvelope(env1);
    assert.strictEqual(hash1, hash2);
  });
});

describe("SHA-256 Hash-Chain Ledger & Atomic Budget", () => {
  test("generates valid prevHash and hash chain across ledger entries", () => {
    const testDir = join(process.cwd(), ".agent/test-state-" + Date.now());
    const dateStr = new Date().toISOString().split("T")[0];
    const ledgerFile = join(testDir, ".agent/state", `ledger-${dateStr}.jsonl`);

    try {
      const e1 = appendLedger({ event: "task_started", task: "test1" }, testDir);
      assert.strictEqual(e1.prevHash, "0".repeat(64));
      assert.ok(e1.hash);

      const e2 = appendLedger({ event: "task_completed", task: "test1" }, testDir);
      assert.strictEqual(e2.prevHash, e1.hash);
      assert.ok(e2.hash);

      const integrity = verifyLedgerIntegrity(ledgerFile);
      assert.strictEqual(integrity.ok, true);
      assert.strictEqual(integrity.count, 2);
    } finally {
      try { rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  test("reserves and commits budget transactionally", () => {
    const testDir = join(process.cwd(), ".agent/test-budget-" + Date.now());
    try {
      const reservation = reserveBudget(testDir, 300);
      assert.strictEqual(reservation.ok, true);
      assert.ok(reservation.reservationId.startsWith("res-"));

      const committed = commitBudgetReservation(testDir, reservation.reservationId);
      assert.strictEqual(committed.reservationId, reservation.reservationId);
      assert.strictEqual(committed.event, "budget_committed");
    } finally {
      try { rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
    }
  });
});

describe("Risk Tier Path Canonicalization", () => {
  test("classifies src/author.mjs as R1 Routine without substring false positive", () => {
    const res = classifyRiskTier(["src/author.mjs"]);
    assert.strictEqual(res.tier, RISK_TIERS.R1);
    assert.strictEqual(res.isAutoMergeAllowed, true);
  });

  test("classifies .github/workflows/ci.yml as R3 Restricted", () => {
    const res = classifyRiskTier([".github/workflows/ci.yml"]);
    assert.strictEqual(res.tier, RISK_TIERS.R3);
    assert.strictEqual(res.isAutoMergeAllowed, false);
  });
});

describe("Zero-Trust Base Resolution", () => {
  test("throws GateError on non-existent base branch without HEAD fallback", () => {
    assert.throws(
      () => resolveBase(process.cwd(), "non-existent-branch-xyz-99"),
      (err) => err instanceof GateError && err.code === 1
    );
  });
});
