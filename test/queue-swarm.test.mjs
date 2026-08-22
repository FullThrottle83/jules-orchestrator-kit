import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

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

test("agentctl queue/swarm report per-task failures", async (t) => {
  // The failures were always present in the result object; only `--json` ever
  // rendered them. The human path printed a count and exited 0, so a queue
  // where nothing dispatched was indistinguishable from a healthy one — for an
  // operator reading the terminal and for any CI job checking the exit code.
  const cliPath = fileURLToPath(new URL("../bin/agentctl.mjs", import.meta.url));

  function repoWithQueuedTask() {
    const { dir, queueDir } = createTempRepo();
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    writeFileSync(
      join(dir, ".agent", "config.yml"),
      "version: 1\nprovider: jules\nbase_branch: main\nverify:\n  test: \"true\"\n",
      "utf-8"
    );
    writeFileSync(
      join(queueDir, "TASK-900.md"),
      "# Queued Task\n\n[TASK INSTRUCTIONS]\nDo the thing.\n\n[VERIFICATION ORACLE]\nTest/Verification Command: true\n",
      "utf-8"
    );
    return dir;
  }

  function runCli(dir, args) {
    const env = { ...process.env };
    delete env.JULES_API_KEY;
    delete env.GEMINI_API_KEY;
    const res = spawnSync("node", [cliPath, ...args], { cwd: dir, env, encoding: "utf-8" });
    return { code: res.status, out: `${res.stdout}${res.stderr}` };
  }

  for (const command of ["queue", "swarm"]) {
    await t.test(`${command} exits non-zero and names the reason`, () => {
      const dir = repoWithQueuedTask();
      try {
        const { code, out } = runCli(dir, [command]);
        assert.equal(code, 1, `${command} must not report success when no task dispatched`);
        assert.match(out, /0 ok, 1 failed/);
        assert.match(out, /TASK-900\.md/, "the failing task must be named");
        assert.match(out, /JULES_API_KEY/, "the actual cause must reach the operator");
        assert.doesNotMatch(out, /undefined/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  await t.test("a dry run still succeeds", () => {
    const dir = repoWithQueuedTask();
    try {
      const { code, out } = runCli(dir, ["queue", "--dry-run"]);
      assert.equal(code, 0);
      assert.match(out, /1 ok, 0 failed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
