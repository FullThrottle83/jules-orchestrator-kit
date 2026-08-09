import { createHash, randomUUID } from "node:crypto";

/**
 * @typedef {import("../ux/capabilities.mjs").ActionPlan} ActionPlan
 * @typedef {import("../ux/queue-model.mjs").QueueSnapshot} QueueSnapshot
 */

/**
 * Plan task lifecycle action into an immutable ActionPlan.
 * @param {QueueSnapshot} snapshot
 * @param {Object} intent
 * @param {string} intent.kind
 * @param {string} intent.taskId
 * @param {Record<string, any>} [intent.answers]
 * @returns {Promise<ActionPlan>}
 */
export async function planTaskAction(snapshot, intent) {
  const taskId = intent.taskId;
  const task = (snapshot.tasks || []).find((t) => t.id === taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found in queue snapshot.`);
  }

  const root = snapshot.repository;
  const planId = `PLAN-TASK-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const sidecarRelPath = `.agent/jules-queue/${taskId}.state.json`;

  if (intent.kind === "retry") {
    const allowedStates = ["failed", "deferred", "quarantined", "cancelled"];
    if (!allowedStates.includes(task.state)) {
      throw new Error(`Task ${taskId} in state '${task.state}' cannot be retried.`);
    }

    const nextAttempt = task.attempt + 1;
    const sidecarContent = JSON.stringify(
      {
        schema: "agentctl/task-state-v1",
        taskId,
        revision: task.stateRevision + 1,
        state: "pending",
        attempt: nextAttempt,
        maxAttempts: task.maxAttempts,
        createdAt: task.createdAt,
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    );

    return {
      schema: "agentctl/action-plan-v1",
      id: planId,
      kind: "task.retry",
      title: `Retry task ${taskId}`,
      summary: `Reset state to pending and increment attempt count to ${nextAttempt}`,
      risk: "moderate",
      repository: root,
      createdAt: new Date().toISOString(),
      preconditions: [
        {
          kind: "file-hash",
          target: sidecarRelPath,
          expected: task.envelopeHash, // Checked prior state hash if sidecar exists
        },
      ],
      fileMutations: [
        {
          operation: "replace",
          path: sidecarRelPath,
          newContent: sidecarContent,
        },
      ],
      commandEffects: [],
      stateTransitions: [{ taskId, from: task.state, to: "pending" }],
      preview: {
        unifiedDiff: `--- a/${sidecarRelPath}\n+++ b/${sidecarRelPath}\n@@ -state @@\n- state: ${task.state}\n+ state: pending\n- attempt: ${task.attempt}\n+ attempt: ${nextAttempt}\n`,
        warnings: [],
        estimatedImpact: [`Resets ${taskId} to pending state (Attempt ${nextAttempt})`],
      },
      confirmation: {
        mode: "keypress",
        prompt: `Confirm retry of ${taskId} (Attempt ${nextAttempt})?`,
      },
      planHash: "sha256:" + createHash("sha256").update(planId).digest("hex"),
    };
  }

  if (intent.kind === "quarantine-override") {
    if (task.state !== "quarantined") {
      throw new Error(`Task ${taskId} is not in quarantined state.`);
    }

    const reason = String(intent.answers?.reason || "").trim();
    if (!reason) {
      throw new Error("Quarantine override requires a non-empty reason.");
    }

    const sidecarContent = JSON.stringify(
      {
        schema: "agentctl/task-state-v1",
        taskId,
        revision: task.stateRevision + 1,
        state: "pending",
        attempt: task.attempt,
        maxAttempts: task.maxAttempts,
        quarantineOverrideReason: reason,
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    );

    return {
      schema: "agentctl/action-plan-v1",
      id: planId,
      kind: "task.quarantine-override",
      title: `Override quarantine for ${taskId}`,
      summary: `Bypass quarantine with reason: "${reason}"`,
      risk: "high",
      repository: root,
      createdAt: new Date().toISOString(),
      preconditions: [],
      fileMutations: [
        {
          operation: "replace",
          path: sidecarRelPath,
          newContent: sidecarContent,
        },
      ],
      commandEffects: [],
      stateTransitions: [{ taskId, from: "quarantined", to: "pending" }],
      preview: {
        unifiedDiff: `--- a/${sidecarRelPath}\n+++ b/${sidecarRelPath}\n@@ -state @@\n- state: quarantined\n+ state: pending\n+ overrideReason: "${reason}"\n`,
        warnings: ["Bypassing quarantine filter requires verified operator review."],
        estimatedImpact: [`Re-enables ${taskId} for dispatch`],
      },
      confirmation: {
        mode: "typed-task-id",
        prompt: `Type '${taskId}' to confirm quarantine override:`,
        expected: taskId,
        requireReason: true,
      },
      planHash: "sha256:" + createHash("sha256").update(planId).digest("hex"),
    };
  }

  if (intent.kind === "delete-task") {
    if (task.state === "running" || task.state === "verifying") {
      throw new Error(`Task ${taskId} is currently active (${task.state}) and cannot be deleted.`);
    }

    const trashRelPath = `.agent/jules-queue/.trash/${taskId}.md`;
    return {
      schema: "agentctl/action-plan-v1",
      id: planId,
      kind: "task.delete",
      title: `Delete task ${taskId}`,
      summary: `Move task file ${task.taskFile} to trash directory`,
      risk: "moderate",
      repository: root,
      createdAt: new Date().toISOString(),
      preconditions: [],
      fileMutations: [
        {
          operation: "move",
          path: trashRelPath,
          fromPath: task.taskFile,
        },
      ],
      commandEffects: [],
      stateTransitions: [{ taskId, from: task.state, to: "cancelled" }],
      preview: {
        unifiedDiff: `--- a/${task.taskFile}\n+++ /dev/null\n`,
        warnings: [],
        estimatedImpact: [`Moves ${taskId} to trash`],
      },
      confirmation: {
        mode: "keypress",
        prompt: `Delete task ${taskId}?`,
      },
      planHash: "sha256:" + createHash("sha256").update(planId).digest("hex"),
    };
  }

  throw new Error(`Unsupported task action intent: ${intent.kind}`);
}
