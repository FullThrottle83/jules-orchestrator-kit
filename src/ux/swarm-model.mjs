import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

/**
 * @typedef {"idle" | "reserved" | "preparing" | "running" | "verifying" | "draining" | "failed" | "stale"} SlotState
 *
 * @typedef {Object} SwarmSlot
 * @property {string} id
 * @property {SlotState} state
 * @property {string} [taskId]
 * @property {number} [attempt]
 * @property {string} [worktree]
 * @property {string} [branch]
 * @property {number} [pid]
 * @property {string} [processStartTime]
 * @property {string} [startedAt]
 * @property {number} [durationMs]
 * @property {string[]} lockIds
 * @property {string[]} writeScope
 * @property {number} [cpuPercent]
 * @property {number} [rssBytes]
 * @property {"full" | "partial" | "unavailable"} resourceSupport
 * @property {string} [lastHeartbeat]
 * @property {string} [warning]
 */

/**
 * Check if PID is currently alive on current system.
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // EPERM means process exists but we lack permission to signal
  }
}

/**
 * Build immutable SwarmSnapshot probing active worker slots.
 * @param {string} root
 * @param {Object} [options]
 * @param {boolean} [options.sampleResources=false]
 * @returns {Promise<{ slots: SwarmSlot[], warnings: string[], revision: string }>}
 */
export async function buildSwarmSnapshot(root, _options = {}) {
  const repoRoot = resolve(root || process.cwd());
  const swarmDir = join(repoRoot, ".agent", "state", "swarm");
  const warnings = [];
  /** @type {SwarmSlot[]} */
  const slots = [];

  // Default 4 concurrency slots if no swarm config files exist
  const defaultSlotIds = ["slot-01", "slot-02", "slot-03", "slot-04"];

  if (existsSync(swarmDir)) {
    try {
      const slotFiles = readdirSync(swarmDir).filter((f) => f.startsWith("slot-") && f.endsWith(".json"));
      for (const file of slotFiles) {
        const slotPath = join(swarmDir, file);
        try {
          const content = readFileSync(slotPath, "utf-8");
          /** @type {SwarmSlot} */
          const slotData = JSON.parse(content);

          let state = slotData.state || "idle";
          let warning = slotData.warning;

          if (slotData.pid && (state === "running" || state === "verifying")) {
            if (!isPidAlive(slotData.pid)) {
              state = "stale";
              warning = `Process PID ${slotData.pid} is no longer alive`;
              warnings.push(`Slot ${slotData.id} has dead PID ${slotData.pid}`);
            }
          }

          slots.push({
            id: slotData.id || file.replace(/\.json$/, ""),
            state,
            taskId: slotData.taskId,
            attempt: slotData.attempt,
            worktree: slotData.worktree,
            branch: slotData.branch,
            pid: slotData.pid,
            processStartTime: slotData.processStartTime,
            startedAt: slotData.startedAt,
            durationMs: slotData.durationMs,
            lockIds: slotData.lockIds || [],
            writeScope: slotData.writeScope || [],
            resourceSupport: "partial",
            warning,
          });
        } catch (err) {
          warnings.push(`Failed to parse slot file ${file}: ${err.message}`);
        }
      }
    } catch (err) {
      warnings.push(`Failed to read swarm state directory: ${err.message}`);
    }
  }

  // Populate default idle slots if fewer than 4 slots exist
  if (slots.length < 4) {
    for (const defaultId of defaultSlotIds) {
      if (!slots.some((s) => s.id === defaultId)) {
        slots.push({
          id: defaultId,
          state: "idle",
          lockIds: [],
          writeScope: [],
          resourceSupport: "partial",
        });
      }
    }
  }

  slots.sort((a, b) => a.id.localeCompare(b.id));

  const revisionPayload = JSON.stringify({ slots: slots.map((s) => ({ id: s.id, state: s.state, pid: s.pid })) });
  const revision = "sha256:" + createHash("sha256").update(revisionPayload).digest("hex");

  return { slots, warnings, revision };
}

/**
 * Swarm state reducer for updating view navigation state.
 * @param {Record<string, any>} state
 * @param {import("../key-decoder.mjs").KeyEvent | { type: string, payload?: any }} event
 * @returns {Record<string, any>}
 */
export function reduceSwarmState(state, event) {
  const nextState = { ...state };
  if (!event) return nextState;

  if (typeof event === "object" && "type" in event) {
    if (event.type === "SELECT_SLOT") {
      nextState.selectedSlotId = String(event.payload || "");
    }
  }

  return nextState;
}
