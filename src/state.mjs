import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveRoot } from "./config.mjs";

export function ensureDir(dirPath) {
  if (!dirPath || typeof dirPath !== "string" || dirPath.includes("\0")) {
    throw new Error("Invalid directory path provided");
  }
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

export function getQueueDir(rootOrOpts = resolveRoot()) {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  const dir = join(root, ".agent/jules-queue");
  ensureDir(dir);
  return dir;
}

export function getStateDir(rootOrOpts = resolveRoot()) {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  const dir = join(root, ".agent/state");
  ensureDir(dir);
  return dir;
}

export function getDailyLedgerPath(rootOrOpts = resolveRoot()) {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  const dateStr = new Date().toISOString().split("T")[0];
  return join(getStateDir(root), `ledger-${dateStr}.jsonl`);
}

/**
 * Appends a structured audit event to the daily session ledger.
 */
export function appendLedger(entry, rootOrOpts = resolveRoot()) {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  const filePath = getDailyLedgerPath(root);
  const payload = {
    timestamp: new Date().toISOString(),
    ...entry,
  };
  appendFileSync(filePath, JSON.stringify(payload) + "\n", "utf-8");
  return payload;
}

export function readLedger(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, "utf-8");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (_) {
    return [];
  }
}

/**
 * Enforces a daily token budget. Supports checkDailyBudget(limit) and checkDailyBudget(root, limit).
 */
export function checkDailyBudget(arg1 = resolveRoot(), arg2 = 300) {
  let root = typeof arg1 === "string" ? arg1 : resolveRoot();
  let limit = typeof arg1 === "number" ? arg1 : (typeof arg2 === "number" ? arg2 : 300);

  const filePath = getDailyLedgerPath(root);
  if (!existsSync(filePath)) {
    return { ok: true, used: 0, budget: limit, remaining: limit };
  }
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    // Count budget_reserved or valid JSON entries
    const count = lines.length;
    return {
      ok: count < limit,
      used: count,
      budget: limit,
      remaining: Math.max(0, limit - count),
    };
  } catch (_) {
    return { ok: true, used: 0, budget: limit, remaining: limit };
  }
}

export async function withBudget(fn, root = resolveRoot(), limit = 300) {
  const budget = checkDailyBudget(root, limit);
  if (!budget.ok) {
    throw new Error(`Daily budget exhausted (${budget.used}/${budget.budget} tasks executed)`);
  }
  return fn();
}

/**
 * Advisory lock file manager for agent tasks.
 */
export function getLockDir(rootOrOpts = resolveRoot()) {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  const dir = join(getStateDir(root), "locks");
  ensureDir(dir);
  return dir;
}

export function acquireLock(agentName, taskId, files = [], rootOrOpts = resolveRoot()) {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  const lockDir = getLockDir(root);
  const lockFile = join(lockDir, `${taskId}.json`);
  if (existsSync(lockFile)) {
    try {
      const existing = JSON.parse(readFileSync(lockFile, "utf-8"));
      return { ok: false, holder: existing.agent, taskId };
    } catch (_) {
      // Stale lock
    }
  }

  const payload = {
    agent: agentName,
    taskId,
    files,
    acquiredAt: new Date().toISOString(),
  };
  writeFileSync(lockFile, JSON.stringify(payload, null, 2), "utf-8");
  return { ok: true, lockFile };
}

export function releaseLock(taskId, rootOrOpts = resolveRoot()) {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  const lockDir = getLockDir(root);
  const lockFile = join(lockDir, `${taskId}.json`);
  if (existsSync(lockFile)) {
    try {
      const fs = require("node:fs");
      fs.unlinkSync(lockFile);
      return true;
    } catch (_) {}
  }
  return false;
}

export function lockStatus(rootOrOpts = resolveRoot()) {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  const lockDir = getLockDir(root);
  const locks = [];
  try {
    const files = readdirSync(lockDir);
    for (const file of files) {
      if (file.endsWith(".json")) {
        const content = readFileSync(join(lockDir, file), "utf-8");
        locks.push(JSON.parse(content));
      }
    }
  } catch (_) {}
  return locks;
}
