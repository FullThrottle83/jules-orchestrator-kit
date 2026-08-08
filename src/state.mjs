import {
  readFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  openSync,
  writeSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
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
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const obj = JSON.parse(line);
        return Object.freeze(obj);
      });
  } catch (_) {
    return [];
  }
}

/**
 * Enforces a daily token budget.
 */
export function checkDailyBudget(arg1 = resolveRoot(), arg2 = 300) {
  let root = typeof arg1 === "string" ? arg1 : resolveRoot();
  let limit = typeof arg1 === "number" ? arg1 : typeof arg2 === "number" ? arg2 : 300;

  const filePath = getDailyLedgerPath(root);
  if (!existsSync(filePath)) {
    return { ok: true, used: 0, budget: limit, remaining: limit };
  }
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
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

export class BudgetError extends Error {
  constructor(message) {
    super(message);
    this.name = "BudgetError";
    this.code = 7;
  }
}

export async function withBudget(fn, root = resolveRoot(), limit = 300) {
  const budget = checkDailyBudget(root, limit);
  if (!budget.ok) {
    throw new BudgetError(`Daily budget exhausted (${budget.used}/${budget.budget} tasks executed)`);
  }
  return fn();
}

/**
 * Atomic Advisory Lock File Manager with PID Vitality Check & Stale Lock Reaper (CWE-367 Fix).
 */
export function getLockDir(rootOrOpts = resolveRoot()) {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  const dir = join(getStateDir(root), "locks");
  ensureDir(dir);
  return dir;
}

export function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

export function acquireLock(agentName, taskId, files = [], rootOrOpts = resolveRoot()) {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  const lockDir = getLockDir(root);
  const lockFile = join(lockDir, `${taskId}.json`);

  // Stale Lock Reaper Check
  if (existsSync(lockFile)) {
    try {
      const existing = JSON.parse(readFileSync(lockFile, "utf-8"));
      const isAlive = isPidAlive(existing.pid);
      const isExpired = existing.acquiredAt && Date.now() - new Date(existing.acquiredAt).getTime() > 7200000;

      if (!isAlive || isExpired) {
        // Dead or expired holder; safely reap lock
        try { unlinkSync(lockFile); } catch (_) {}
      } else {
        return { ok: false, holder: existing.agent, taskId, pid: existing.pid };
      }
    } catch (_) {
      try { unlinkSync(lockFile); } catch (_) {}
    }
  }

  const payload = {
    agent: agentName,
    taskId,
    files,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };

  // Atomic file creation via 'wx' flag (Fixes TOCTOU Race Condition)
  try {
    const fd = openSync(lockFile, "wx");
    writeSync(fd, JSON.stringify(payload, null, 2), "utf-8");
    closeSync(fd);
    return { ok: true, lockFile };
  } catch (err) {
    if (err.code === "EEXIST") {
      try {
        const existing = JSON.parse(readFileSync(lockFile, "utf-8"));
        return { ok: false, holder: existing.agent, taskId };
      } catch (_) {
        return { ok: false, holder: "unknown", taskId };
      }
    }
    throw err;
  }
}

export function releaseLock(taskId, rootOrOpts = resolveRoot()) {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  const lockDir = getLockDir(root);
  const lockFile = join(lockDir, `${taskId}.json`);

  if (existsSync(lockFile)) {
    try {
      unlinkSync(lockFile); // CRITICAL FIX: Fixed ESM unlinkSync (removed legacy require("node:fs"))
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
        try {
          const content = readFileSync(join(lockDir, file), "utf-8");
          locks.push(Object.freeze(JSON.parse(content)));
        } catch (_) {}
      }
    }
  } catch (_) {}
  return locks;
}
