import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildQueueSnapshot, reduceQueueState } from "../src/ux/queue-model.mjs";
import { buildSwarmSnapshot, reduceSwarmState } from "../src/ux/swarm-model.mjs";
import { planTaskAction } from "../src/ops/task-actions.mjs";
import { planSwarmAction } from "../src/ops/swarm-actions.mjs";

function createTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "jules-qs-test-"));
  const queueDir = join(dir, ".agent", "jules-queue");
  const swarmDir = join(dir, ".agent", "state", "swarm");
  mkdirSync(queueDir, { recursive: true });
  mkdirSync(swarmDir, { recursive: true });
  return { dir, queueDir, swarmDir };
}

test("src/ux/queue-model.mjs", async (t) => {
  await t.test("buildQueueSnapshot aggregates task states and generates snapshot", async () => {
    const { dir, queueDir } = createTempRepo();
    try {
      const taskMd = `<!-- JULES_TASK_ENVELOPE: {"schema":"agentctl/envelope-v1","title":"Test Task 1","riskTier":"R1"} -->\n# Test Task 1\n`;
      writeFileSync(join(queueDir, "TASK-101.md"), taskMd, "utf-8");
      writeFileSync(
        join(queueDir, "TASK-101.state.json"),
        JSON.stringify({ schema: "agentctl/task-state-v1", taskId: "TASK-101", state: "running", attempt: 1, revision: 1 }),
        "utf-8"
      );

      const snapshot = await buildQueueSnapshot(dir);
      assert.equal(snapshot.schema, "agentctl/queue-snapshot-v1");
      assert.equal(snapshot.tasks.length, 1);
      assert.equal(snapshot.tasks[0].id, "TASK-101");
      assert.equal(snapshot.tasks[0].state, "running");
      assert.equal(snapshot.counts.running, 1);
      assert.ok(snapshot.revision.startsWith("sha256:"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("reduceQueueState handles navigation events", () => {
    const initial = { filter: "", selectedIndex: 0 };
    const updated = reduceQueueState(initial, { type: "SET_FILTER", payload: "webhook" });
    assert.equal(updated.filter, "webhook");
  });
});

test("src/ux/swarm-model.mjs", async (t) => {
  await t.test("buildSwarmSnapshot identifies stale slots with dead PIDs", async () => {
    const { dir, swarmDir } = createTempRepo();
    try {
      const deadPid = 9999999;
      writeFileSync(
        join(swarmDir, "slot-01.json"),
        JSON.stringify({ id: "slot-01", state: "running", taskId: "TASK-101", pid: deadPid }),
        "utf-8"
      );

      const snapshot = await buildSwarmSnapshot(dir);
      assert.equal(snapshot.slots.length >= 4, true);

      const slot01 = snapshot.slots.find((s) => s.id === "slot-01");
      assert.ok(slot01);
      assert.equal(slot01.state, "stale");
      assert.ok(slot01.warning.includes("no longer alive"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("reduceSwarmState handles slot selection", () => {
    const initial = { selectedSlotId: "slot-01" };
    const updated = reduceSwarmState(initial, { type: "SELECT_SLOT", payload: "slot-02" });
    assert.equal(updated.selectedSlotId, "slot-02");
  });
});

test("src/ops/task-actions.mjs", async (t) => {
  await t.test("planTaskAction generates task retry action plan", async () => {
    const { dir, queueDir } = createTempRepo();
    try {
      writeFileSync(
        join(queueDir, "TASK-102.md"),
        `<!-- JULES_TASK_ENVELOPE: {"title":"Failed Task"} -->\nInstruction`,
        "utf-8"
      );
      writeFileSync(
        join(queueDir, "TASK-102.state.json"),
        JSON.stringify({ schema: "agentctl/task-state-v1", taskId: "TASK-102", state: "failed", attempt: 1, maxAttempts: 3 }),
        "utf-8"
      );

      const snapshot = await buildQueueSnapshot(dir);
      const plan = await planTaskAction(snapshot, { kind: "retry", taskId: "TASK-102" });

      assert.equal(plan.schema, "agentctl/action-plan-v1");
      assert.equal(plan.kind, "task.retry");
      assert.equal(plan.risk, "moderate");
      assert.equal(plan.fileMutations.length, 1);
      assert.ok(plan.preview.unifiedDiff.includes("+ state: pending"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("planTaskAction generates quarantine override plan with typed confirmation", async () => {
    const { dir, queueDir } = createTempRepo();
    try {
      writeFileSync(
        join(queueDir, "TASK-103.md"),
        `<!-- JULES_TASK_ENVELOPE: {"title":"Quarantined Task"} -->\nInstruction`,
        "utf-8"
      );
      writeFileSync(
        join(queueDir, "TASK-103.state.json"),
        JSON.stringify({ schema: "agentctl/task-state-v1", taskId: "TASK-103", state: "quarantined", attempt: 1 }),
        "utf-8"
      );

      const snapshot = await buildQueueSnapshot(dir);
      const plan = await planTaskAction(snapshot, {
        kind: "quarantine-override",
        taskId: "TASK-103",
        answers: { reason: "Verified false positive flaky test" },
      });

      assert.equal(plan.kind, "task.quarantine-override");
      assert.equal(plan.risk, "high");
      assert.equal(plan.confirmation.mode, "typed-task-id");
      assert.equal(plan.confirmation.expected, "TASK-103");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("src/ops/swarm-actions.mjs", async (t) => {
  await t.test("planSwarmAction plans pause scheduler and prune stale slots", async () => {
    const { dir } = createTempRepo();
    try {
      const snapshot = {
        slots: [
          { id: "slot-01", state: "stale" },
          { id: "slot-02", state: "idle" },
        ],
        revision: "sha256:1234",
      };

      const pausePlan = await planSwarmAction(snapshot, { kind: "pause-scheduler" });
      assert.equal(pausePlan.kind, "pause-scheduler");
      assert.equal(pausePlan.fileMutations[0].path, ".agent/state/swarm/scheduler.json");

      const prunePlan = await planSwarmAction(snapshot, { kind: "prune-stale-slots" });
      assert.equal(prunePlan.kind, "swarm.prune-stale-slots");
      assert.equal(prunePlan.fileMutations.length, 1);
      assert.equal(prunePlan.fileMutations[0].operation, "delete");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
