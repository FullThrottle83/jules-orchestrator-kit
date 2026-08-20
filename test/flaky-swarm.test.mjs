import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordVerifyRun,
  listQuarantinedTests,
  clearFlakyLedger,
  synthesizeFlakyHealingTask,
  runFlakyHealingSwarm,
} from "../src/flaky-ledger.mjs";
import { getQueueDir } from "../src/state.mjs";

describe("Automated Flaky Test Healing Swarm", () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "flaky-swarm-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch (_) {}
  });

  it("listQuarantinedTests accurately identifies Wilson-quarantined suites", () => {
    const cmdHealthy = "npm run test:unit";
    const cmdFlaky = "npm run test:e2e";

    // Record healthy runs (all pass)
    for (let i = 0; i < 6; i++) {
      recordVerifyRun(tempRoot, cmdHealthy, true, null, 100);
    }

    // Record oscillating runs (pass, fail, pass, fail, pass, fail)
    for (let i = 0; i < 6; i++) {
      recordVerifyRun(tempRoot, cmdFlaky, i % 2 === 0, null, 250);
    }

    const quarantined = listQuarantinedTests(tempRoot);
    assert.equal(quarantined.length, 1);
    assert.equal(quarantined[0].testCmd, cmdFlaky);
    assert.equal(quarantined[0].verdict, "QUARANTINED");
    assert.equal(quarantined[0].fails, 3);
    assert.equal(quarantined[0].passes, 3);
    assert.ok(quarantined[0].oscillation >= 0.4);
    assert.ok(quarantined[0].wilson.lower > 0);
  });

  it("synthesizeFlakyHealingTask produces rigorous anti-flakiness prompt envelope", () => {
    const item = {
      testCmd: "pytest tests/test_async.py",
      oscillation: 0.6,
      fails: 3,
      passes: 3,
      n: 6,
    };

    const task = synthesizeFlakyHealingTask(item, { role: "janitor" });

    assert.ok(task.title.includes("Heal Flaky Test"));
    assert.equal(task.role, "janitor");
    assert.ok(task.prompt.includes("pytest tests/test_async.py"));
    assert.ok(task.prompt.includes("NO TEST WEAKENING"));
    assert.ok(task.prompt.includes("Eliminate Arbitrary Sleep"));
    assert.ok(task.verifyCmd.includes("pytest tests/test_async.py && pytest tests/test_async.py"));
    assert.ok(task.fullEnvelope.includes("JULES_TASK_ENVELOPE"));
  });

  it("runFlakyHealingSwarm generates and queues healing tasks in .agent/jules-queue/", async () => {
    const cmdFlaky1 = "npm test -- auth.test.mjs";
    const cmdFlaky2 = "npm test -- webhook.test.mjs";

    // Create 2 quarantined test suites
    for (let i = 0; i < 6; i++) {
      recordVerifyRun(tempRoot, cmdFlaky1, i % 2 === 0, null, 150);
      recordVerifyRun(tempRoot, cmdFlaky2, i % 2 === 1, null, 180);
    }

    const res = await runFlakyHealingSwarm(tempRoot);

    assert.equal(res.count, 2);
    assert.equal(res.queued, true);

    const queueDir = getQueueDir(tempRoot);
    const queuedFiles = readdirSync(queueDir).filter((f) => f.endsWith(".md"));
    assert.equal(queuedFiles.length, 2);
  });

  it("runFlakyHealingSwarm supports dryRun mode without modifying queue directory", async () => {
    const cmdFlaky = "cargo test --package api";
    for (let i = 0; i < 6; i++) {
      recordVerifyRun(tempRoot, cmdFlaky, i % 2 === 0, null, 200);
    }

    const res = await runFlakyHealingSwarm(tempRoot, { dryRun: true });

    assert.equal(res.count, 1);
    assert.equal(res.dryRun, true);
    assert.equal(res.queued, false);
    assert.equal(res.tasks.length, 1);
  });

  it("clearFlakyLedger clears history for a specific command or all tests", () => {
    const cmdA = "npm run test:a";
    const cmdB = "npm run test:b";

    for (let i = 0; i < 6; i++) {
      recordVerifyRun(tempRoot, cmdA, i % 2 === 0, null, 100);
      recordVerifyRun(tempRoot, cmdB, i % 2 === 0, null, 100);
    }

    assert.equal(listQuarantinedTests(tempRoot).length, 2);

    // Clear only cmdA
    clearFlakyLedger(tempRoot, cmdA);
    const afterA = listQuarantinedTests(tempRoot);
    assert.equal(afterA.length, 1);
    assert.equal(afterA[0].testCmd, cmdB);

    // Clear all
    clearFlakyLedger(tempRoot);
    assert.equal(listQuarantinedTests(tempRoot).length, 0);
  });

  it("synthesizeFlakyHealingTask supports custom verifyCmd and string shorthand", () => {
    const task = synthesizeFlakyHealingTask("go test ./...", {
      verifyCmd: "go test ./... -count=5",
      role: "overseer",
    });

    assert.equal(task.role, "overseer");
    assert.equal(task.verifyCmd, "go test ./... -count=5");
    assert.ok(task.fullEnvelope.includes("go test ./... -count=5"));
  });

  it("runFlakyHealingSwarm returns clean message when zero quarantined tests exist", async () => {
    const res = await runFlakyHealingSwarm(tempRoot);
    assert.equal(res.count, 0);
    assert.equal(res.tasks.length, 0);
    assert.ok(res.message.includes("No quarantined"));
  });
});
