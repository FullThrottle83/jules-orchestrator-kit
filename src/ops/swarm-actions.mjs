import { createHash, randomUUID } from "node:crypto";

/**
 * @typedef {import("../ux/capabilities.mjs").ActionPlan} ActionPlan
 * @typedef {import("../ux/swarm-model.mjs").SwarmSlot} SwarmSlot
 */

/**
 * Plan swarm concurrency action into an immutable ActionPlan.
 * @param {{ slots: SwarmSlot[], revision: string }} snapshot
 * @param {Object} intent
 * @param {string} intent.kind
 * @param {string} [intent.slotId]
 * @param {string} [intent.taskId]
 * @param {Record<string, any>} [intent.answers]
 * @returns {Promise<ActionPlan>}
 */
export async function planSwarmAction(snapshot, intent) {
  const planId = `PLAN-SWARM-${Date.now()}-${randomUUID().slice(0, 8)}`;

  if (intent.kind === "pause-scheduler" || intent.kind === "resume-scheduler") {
    const isPause = intent.kind === "pause-scheduler";
    const schedulerRelPath = ".agent/state/swarm/scheduler.json";
    const newContent = JSON.stringify(
      {
        schema: "agentctl/swarm-scheduler-v1",
        paused: isPause,
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    );

    return {
      schema: "agentctl/action-plan-v1",
      id: planId,
      kind: intent.kind,
      title: `${isPause ? "Pause" : "Resume"} Swarm Scheduler`,
      summary: `${isPause ? "Halt dispatching new tasks to swarm slots" : "Resume task dispatching to available slots"}`,
      risk: "moderate",
      repository: "local",
      createdAt: new Date().toISOString(),
      preconditions: [],
      fileMutations: [
        {
          operation: "replace",
          path: schedulerRelPath,
          newContent,
        },
      ],
      commandEffects: [],
      stateTransitions: [],
      preview: {
        unifiedDiff: `--- a/${schedulerRelPath}\n+++ b/${schedulerRelPath}\n@@ -paused @@\n- paused: ${!isPause}\n+ paused: ${isPause}\n`,
        warnings: isPause ? ["Running tasks will complete, but no new tasks will be scheduled."] : [],
        estimatedImpact: [`Swarm scheduler state set to ${isPause ? "PAUSED" : "RUNNING"}`],
      },
      confirmation: {
        mode: "keypress",
        prompt: `Confirm ${isPause ? "pause" : "resume"} of swarm scheduler?`,
      },
      planHash: "sha256:" + createHash("sha256").update(planId).digest("hex"),
    };
  }

  if (intent.kind === "cancel-slot-task") {
    const slotId = intent.slotId;
    const slot = (snapshot.slots || []).find((s) => s.id === slotId || s.taskId === intent.taskId);
    if (!slot) {
      throw new Error(`Target slot ${slotId || intent.taskId} not found.`);
    }

    const slotRelPath = `.agent/state/swarm/${slot.id}.json`;
    const newContent = JSON.stringify(
      {
        id: slot.id,
        state: "draining",
        taskId: slot.taskId,
        cancelledAt: new Date().toISOString(),
      },
      null,
      2
    );

    return {
      schema: "agentctl/action-plan-v1",
      id: planId,
      kind: "swarm.cancel-slot-task",
      title: `Cancel active slot task ${slot.taskId || slot.id}`,
      summary: `Send cancellation signal to slot ${slot.id} (Task ${slot.taskId || "N/A"})`,
      risk: "high",
      repository: "local",
      createdAt: new Date().toISOString(),
      preconditions: [],
      fileMutations: [
        {
          operation: "replace",
          path: slotRelPath,
          newContent,
        },
      ],
      commandEffects: [],
      stateTransitions: [{ taskId: slot.taskId, from: slot.state, to: "cancelled" }],
      preview: {
        unifiedDiff: `--- a/${slotRelPath}\n+++ b/${slotRelPath}\n@@ -state @@\n- state: ${slot.state}\n+ state: draining\n`,
        warnings: ["Cancelling a running worker process will terminate its active attempt."],
        estimatedImpact: [`Cancels execution in slot ${slot.id}`],
      },
      confirmation: {
        mode: "typed-task-id",
        prompt: `Type '${slot.taskId || slot.id}' to confirm cancellation:`,
        expected: slot.taskId || slot.id,
      },
      planHash: "sha256:" + createHash("sha256").update(planId).digest("hex"),
    };
  }

  if (intent.kind === "prune-stale-slots") {
    const staleSlots = (snapshot.slots || []).filter((s) => s.state === "stale");
    if (staleSlots.length === 0) {
      throw new Error("No stale slots found to prune.");
    }

    const fileMutations = staleSlots.map((s) => ({
      operation: /** @type {const} */ ("delete"),
      path: `.agent/state/swarm/${s.id}.json`,
    }));

    return {
      schema: "agentctl/action-plan-v1",
      id: planId,
      kind: "swarm.prune-stale-slots",
      title: `Prune ${staleSlots.length} stale swarm slot(s)`,
      summary: `Remove stale slot state files for dead worker process PIDs`,
      risk: "low",
      repository: "local",
      createdAt: new Date().toISOString(),
      preconditions: [],
      fileMutations,
      commandEffects: [],
      stateTransitions: [],
      preview: {
        unifiedDiff: staleSlots.map((s) => `--- a/.agent/state/swarm/${s.id}.json\n+++ /dev/null\n`).join("\n"),
        warnings: [],
        estimatedImpact: [`Prunes ${staleSlots.length} stale slot file(s)`],
      },
      confirmation: {
        mode: "keypress",
        prompt: `Prune ${staleSlots.length} stale slot(s)?`,
      },
      planHash: "sha256:" + createHash("sha256").update(planId).digest("hex"),
    };
  }

  throw new Error(`Unsupported swarm action intent: ${intent.kind}`);
}
