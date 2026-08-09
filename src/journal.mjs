import { openSync, writeSync, fsyncSync, closeSync, existsSync, readFileSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getStateDir, getProcessStartTime, isPidAlive, getLockDir } from "./state.mjs";
import { worktreeRemove, worktreePrune } from "./git.mjs";

/**
 * Appends an intent record to .agent/state/journal.jsonl before a mutating operation.
 * @param {string} root - Project root directory
 * @param {Object|string} op - Operation payload or name
 * @returns {string} opId - Unique operation identifier
 */
export function journalIntent(root, op) {
  const stateDir = getStateDir(root);
  const journalPath = join(stateDir, "journal.jsonl");

  const opObj = typeof op === "string" ? { type: op } : op || {};
  const opId = opObj.opId || `op-${randomUUID()}`;
  const pid = process.pid;
  const processStartTime = getProcessStartTime(pid);

  const record = {
    opId,
    event: "intent",
    type: opObj.type || opObj.operation || "unknown",
    targetPath: opObj.targetPath || opObj.targetDir || opObj.path || "",
    pid,
    processStartTime,
    timestamp: new Date().toISOString(),
    ...opObj,
  };

  const fd = openSync(journalPath, "a");
  try {
    writeSync(fd, JSON.stringify(record) + "\n", "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  return opId;
}

/**
 * Appends a journal_done record to .agent/state/journal.jsonl upon operation completion.
 * @param {string} root - Project root directory
 * @param {string} opId - Operation identifier returned by journalIntent
 * @returns {string|null} opId
 */
export function journalDone(root, opId) {
  if (!opId) return null;
  const stateDir = getStateDir(root);
  const journalPath = join(stateDir, "journal.jsonl");

  const record = {
    opId,
    event: "journal_done",
    timestamp: new Date().toISOString(),
  };

  const fd = openSync(journalPath, "a");
  try {
    writeSync(fd, JSON.stringify(record) + "\n", "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  return opId;
}

/**
 * Scans .agent/state/journal.jsonl for uncompleted intents belonging to dead PIDs,
 * prunes orphaned worktrees, removes stale lock files, and marks intents reaped.
 * Idempotent: Subsequent calls result in 0 additional reaps.
 * @param {string} root - Project root directory
 * @returns {{ reapedCount: number, reaped: Array<Object> }}
 */
export function reapOrphanedIntents(root) {
  const stateDir = getStateDir(root);
  const journalPath = join(stateDir, "journal.jsonl");

  if (!existsSync(journalPath)) {
    return { reapedCount: 0, reaped: [] };
  }

  let lines = [];
  try {
    const raw = readFileSync(journalPath, "utf-8");
    lines = raw.split("\n").filter(Boolean);
  } catch (_) {
    return { reapedCount: 0, reaped: [] };
  }

  const intents = new Map();
  const finishedOpIds = new Set();

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (!entry || !entry.opId) continue;
      if (entry.event === "intent") {
        intents.set(entry.opId, entry);
      } else if (entry.event === "journal_done" || entry.event === "journal_reaped") {
        finishedOpIds.add(entry.opId);
      }
    } catch (_) {
      // Ignore corrupted or partial lines
    }
  }

  const reaped = [];

  for (const [opId, intent] of intents.entries()) {
    if (finishedOpIds.has(opId)) {
      continue;
    }

    const alive = isPidAlive(intent.pid, intent.processStartTime);
    if (!alive) {
      // Owner PID is dead or recycled -> reap orphaned intent
      if (intent.targetPath) {
        try {
          worktreeRemove(root, intent.targetPath);
        } catch (_) {}
        try {
          worktreePrune(root);
        } catch (_) {}
      }

      // Clean up stale lock files associated with this PID or targetPath
      try {
        const lockDir = getLockDir(root);
        if (existsSync(lockDir)) {
          const lockFiles = readdirSync(lockDir);
          for (const file of lockFiles) {
            if (file.endsWith(".json")) {
              const lockPath = join(lockDir, file);
              try {
                const lockContent = JSON.parse(readFileSync(lockPath, "utf-8"));
                if (
                  lockContent.pid === intent.pid ||
                  (intent.targetPath && Array.isArray(lockContent.files) && lockContent.files.includes(intent.targetPath))
                ) {
                  unlinkSync(lockPath);
                }
              } catch (_) {}
            }
          }
        }
      } catch (_) {}

      // Record journal_reaped to guarantee idempotency
      const reapedRecord = {
        opId,
        event: "journal_reaped",
        reapedAt: new Date().toISOString(),
        pid: intent.pid,
      };

      try {
        const fd = openSync(journalPath, "a");
        try {
          writeSync(fd, JSON.stringify(reapedRecord) + "\n", "utf-8");
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } catch (_) {}

      reaped.push(intent);
    }
  }

  return { reapedCount: reaped.length, reaped };
}
