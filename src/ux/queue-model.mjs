import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseEnvelopeHeader } from "../envelope.mjs";
import { isPidAlive } from "../state.mjs";

/**
 * @typedef {"pending" | "dispatching" | "remote-queued" | "planning" | "awaiting-plan-approval" | "awaiting-user-feedback" | "running" | "output-ready" | "verifying" | "deferred" | "quarantined" | "failed" | "completed" | "cancelled"} TaskState
 *
 * @typedef {Object} QueueTaskSummary
 * @property {string} id
 * @property {string} title
 * @property {TaskState} state
 * @property {string} riskTier
 * @property {number} attempt
 * @property {number} maxAttempts
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {number} durationMs
 * @property {string} [source]
 * @property {string} [startingBranch]
 * @property {boolean} autoPr
 * @property {boolean} requirePlanApproval
 * @property {string} [verifyCmd]
 * @property {string} [slotId]
 * @property {number} [pid]
 * @property {string} [worktree]
 * @property {string} [errorSummary]
 * @property {string} envelopeHash
 * @property {string | null} stateHash
 * @property {number} stateRevision
 * @property {string} taskFile
 */

function isQueueTaskFile(fileName, content = "") {
  if (!fileName || fileName.toLowerCase() === "readme.md" || !fileName.toLowerCase().endsWith(".md")) {
    return false;
  }
  if (/^task-.*\.md$/i.test(fileName)) return true;
  return Boolean(parseEnvelopeHeader(content) || content.includes("# Task ID:"));
}

/**
 * @typedef {Object} QueueSnapshot
 * @property {"agentctl/queue-snapshot-v1"} schema
 * @property {string} repository
 * @property {string} generatedAt
 * @property {string} revision
 * @property {Record<TaskState, number>} counts
 * @property {QueueTaskSummary[]} tasks
 * @property {string[]} warnings
 */

/**
 * Build immutable QueueSnapshot by reading canonical .agent/jules-queue/ tasks and sidecars.
 * @param {string} root
 * @param {Object} [options]
 * @param {boolean} [options.includeCompleted=true]
 * @param {number} [options.limit=100]
 * @returns {Promise<QueueSnapshot>}
 */
export async function buildQueueSnapshot(root, options = {}) {
  const repoRoot = resolve(root || process.cwd());
  const queueDir = join(repoRoot, ".agent", "jules-queue");
  const warnings = [];
  const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 100;
  const includeCompleted = options.includeCompleted !== false;
  /** @type {QueueTaskSummary[]} */
  const tasks = [];

  const counts = {
    pending: 0,
    dispatching: 0,
    "remote-queued": 0,
    planning: 0,
    "awaiting-plan-approval": 0,
    "awaiting-user-feedback": 0,
    running: 0,
    "output-ready": 0,
    verifying: 0,
    deferred: 0,
    quarantined: 0,
    failed: 0,
    completed: 0,
    cancelled: 0,
  };

  if (!existsSync(queueDir)) {
    warnings.push("Canonical queue directory .agent/jules-queue does not exist.");
  } else {
    try {
      const files = readdirSync(queueDir).filter((f) => f.toLowerCase().endsWith(".md"));
      for (const file of files) {
        const taskId = file.replace(/\.md$/, "");
        const taskPath = join(queueDir, file);
        const statePath = join(queueDir, `${taskId}.state.json`);

        try {
          const content = readFileSync(taskPath, "utf-8");
          if (!isQueueTaskFile(file, content)) continue;
          const envelope = parseEnvelopeHeader(content) || {};
          const envelopeHash = "sha256:" + createHash("sha256").update(content).digest("hex");

          let sidecar = {};
          let stateHash = null;
          if (existsSync(statePath)) {
            try {
              const stateContent = readFileSync(statePath, "utf-8");
              stateHash = "sha256:" + createHash("sha256").update(stateContent).digest("hex");
              sidecar = JSON.parse(stateContent);
            } catch {
              warnings.push(`Malformed sidecar file for task ${taskId}`);
            }
          }

          const knownStates = new Set([
            "pending", "dispatching", "remote-queued", "planning", "awaiting-plan-approval",
            "awaiting-user-feedback", "running", "output-ready", "verifying", "deferred",
            "quarantined", "failed", "completed", "cancelled",
          ]);
          let state = knownStates.has(sidecar.state) ? sidecar.state : "pending";
          if (sidecar.state && state === "pending" && sidecar.state !== "pending") {
            warnings.push(`Unknown state '${sidecar.state}' for task ${taskId}; treating it as pending`);
          }
          if ((state === "running" || state === "verifying") && sidecar.pid !== undefined && !isPidAlive(sidecar.pid)) {
            state = "failed";
            warnings.push(`Task ${taskId} references dead PID ${sidecar.pid}; treating it as failed`);
          }
          counts[state] = (counts[state] || 0) + 1;

          if (!includeCompleted && (state === "completed" || state === "cancelled")) {
            continue;
          }

          tasks.push({
            id: taskId,
            title: envelope.title || taskId,
            state,
            riskTier: envelope.riskTier || "R1",
            attempt: sidecar.attempt ?? 0,
            maxAttempts: sidecar.maxAttempts ?? envelope.maxAttempts ?? 3,
            createdAt: sidecar.createdAt || envelope.createdAt || new Date().toISOString(),
            updatedAt: sidecar.updatedAt || new Date().toISOString(),
            durationMs: sidecar.durationMs ?? 0,
            source: envelope.source,
            startingBranch: envelope.startingBranch,
            autoPr: Boolean(envelope.autoPr),
            requirePlanApproval: Boolean(envelope.requirePlanApproval),
            verifyCmd: envelope.verifyCmd,
            slotId: sidecar.slotId,
            pid: sidecar.pid,
            worktree: sidecar.worktree,
            errorSummary: sidecar.errorSummary,
            envelopeHash,
            stateHash,
            stateRevision: sidecar.revision ?? 1,
            taskFile: `.agent/jules-queue/${file}`,
          });
        } catch (err) {
          warnings.push(`Failed to read task ${taskId}: ${err.message}`);
        }
      }
    } catch (err) {
      warnings.push(`Failed to list queue directory: ${err.message}`);
    }
  }

  // Sort tasks by updatedAt descending
  tasks.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const generatedAt = new Date().toISOString();
  const revisionPayload = JSON.stringify({ repository: repoRoot, generatedAt, counts, taskCount: tasks.length });
  const revision = "sha256:" + createHash("sha256").update(revisionPayload).digest("hex");

  return {
    schema: "agentctl/queue-snapshot-v1",
    repository: repoRoot,
    generatedAt,
    revision,
    counts,
    tasks: tasks.slice(0, limit),
    warnings,
  };
}

/**
 * Queue state reducer for updating view navigation state.
 * @param {Record<string, any>} state
 * @param {import("../key-decoder.mjs").KeyEvent | { type: string, payload?: any }} event
 * @returns {Record<string, any>}
 */
export function reduceQueueState(state, event) {
  const nextState = { ...state };
  if (!event) return nextState;

  if (typeof event === "object" && "type" in event) {
    if (event.type === "SET_FILTER") {
      nextState.filter = String(event.payload || "");
      nextState.selectedIndex = 0;
    } else if (event.type === "SELECT_TASK") {
      nextState.selectedTaskId = String(event.payload || "");
    }
  }

  return nextState;
}
