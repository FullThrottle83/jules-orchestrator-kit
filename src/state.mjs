import {
  readFileSync,
  existsSync,
  mkdirSync,
  rmdirSync,
  readdirSync,
  openSync,
  writeSync,
  closeSync,
  fsyncSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
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
  const dir = root.endsWith(".agent/state") ? root : join(root, ".agent/state");
  ensureDir(dir);
  return dir;
}

export function getDailyLedgerPath(rootOrOpts = resolveRoot()) {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  const dateStr = new Date().toISOString().split("T")[0];
  return join(getStateDir(root), `ledger-${dateStr}.jsonl`);
}

export class MutexTimeoutError extends Error {
  constructor(message = "Failed to acquire VFS mutex lock within timeout") {
    super(message);
    this.name = "MutexTimeoutError";
  }
}

/**
 * Executes a function inside a kernel-level VFS directory mutex for strict linearizability.
 * Fail-closed: Throws MutexTimeoutError if lock acquisition times out.
 */
export function withVfsMutex(mutexDir, fn, opts = {}) {
  const maxRetries = opts.maxRetries || 200;
  const retryDelayMs = opts.retryDelayMs || 10;

  for (let i = 0; i < maxRetries; i++) {
    try {
      mkdirSync(mutexDir);
      try {
        return fn();
      } finally {
        try {
          rmdirSync(mutexDir);
        } catch (_) {}
      }
    } catch (err) {
      if (err.code === "EEXIST") {
        const deadline = Date.now() + retryDelayMs;
        while (Date.now() < deadline) {}
        continue;
      }
      throw err;
    }
  }
  throw new MutexTimeoutError(`Failed to acquire VFS mutex lock at ${mutexDir} after ${maxRetries} retries`);
}

/**
 * Appends a structured audit event to the daily session ledger with SHA-256 hash-chain (VFS Mutex Linearized).
 */
export function appendLedger(entry, rootOrOpts = resolveRoot()) {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  const filePath = getDailyLedgerPath(root);
  const mutexDir = join(getStateDir(root), ".budget.mutex");

  return withVfsMutex(mutexDir, () => {
    let prevHash = "0".repeat(64);
    if (existsSync(filePath)) {
      try {
        const raw = readFileSync(filePath, "utf-8");
        const lines = raw.split("\n").filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const lastObj = JSON.parse(lines[i]);
            if (lastObj.hash) {
              prevHash = lastObj.hash;
              break;
            }
          } catch (_) {}
        }
      } catch (_) {}
    }

    const timestamp = new Date().toISOString();
    const rawPayload = { timestamp, ...entry, prevHash };
    const hash = createHash("sha256").update(JSON.stringify(rawPayload)).digest("hex");
    const payload = { ...rawPayload, hash };

    const fd = openSync(filePath, "a");
    try {
      writeSync(fd, JSON.stringify(payload) + "\n", "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    return payload;
  });
}

/**
 * Verifies the SHA-256 cryptographic hash-chain integrity of a ledger file.
 */
export function verifyLedgerIntegrity(filePath) {
  if (!filePath || !existsSync(filePath)) return { ok: false, count: 0, error: "FILE_NOT_FOUND" };
  try {
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    let expectedPrevHash = "0".repeat(64);

    for (let i = 0; i < lines.length; i++) {
      let obj;
      try {
        obj = JSON.parse(lines[i]);
      } catch (err) {
        return { ok: false, line: i + 1, error: "TORN_WRITE_CORRUPTION", detail: err.message };
      }
      if (!obj.hash || !obj.prevHash) {
        return { ok: false, line: i + 1, error: "MISSING_HASH_FIELDS" };
      }
      if (obj.prevHash !== expectedPrevHash) {
        return { ok: false, line: i + 1, error: "BROKEN_PREV_HASH", expected: expectedPrevHash, actual: obj.prevHash };
      }
      const { hash, ...rest } = obj;
      const recomputed = createHash("sha256").update(JSON.stringify(rest)).digest("hex");
      if (recomputed !== hash) {
        return { ok: false, line: i + 1, error: "CORRUPTED_ENTRY_HASH", expected: recomputed, actual: hash };
      }
      expectedPrevHash = hash;
    }
    return { ok: true, count: lines.length, lastHash: expectedPrevHash };
  } catch (err) {
    return { ok: false, count: 0, error: err.message };
  }
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
    let count = 0;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry && entry.event === "budget_reserved") {
          count++;
        }
      } catch (_) {}
    }
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

export function reserveBudgetAtomic(stateDirOrRoot = resolveRoot(), limit = 300, opts = {}) {
  const root = typeof stateDirOrRoot === "string" ? stateDirOrRoot : resolveRoot();
  const stateDir = getStateDir(root);
  const mutexDir = join(stateDir, ".budget.mutex");

  return withVfsMutex(mutexDir, () => {
    const dateStr = new Date().toISOString().split("T")[0];
    const filePath = join(stateDir, `ledger-${dateStr}.jsonl`);

    let count = 0;
    let prevHash = "0".repeat(64);

    if (existsSync(filePath)) {
      try {
        const raw = readFileSync(filePath, "utf-8");
        const lines = raw.split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry && entry.event === "budget_reserved") {
              count++;
            }
            if (entry && entry.hash) {
              prevHash = entry.hash;
            }
          } catch (_) {}
        }
      } catch (_) {}
    }

    if (count >= limit) {
      throw new BudgetError(`Daily budget exhausted (${count}/${limit} tasks executed)`);
    }

    const timestamp = new Date().toISOString();
    const reservationId = `res-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const rawPayload = { timestamp, event: "budget_reserved", reservationId, budget: limit, prevHash };
    const hash = createHash("sha256").update(JSON.stringify(rawPayload)).digest("hex");
    const payload = { ...rawPayload, hash };

    const fd = openSync(filePath, "a");
    try {
      writeSync(fd, JSON.stringify(payload) + "\n", "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    return {
      ok: true,
      reservationId,
      remaining: Math.max(0, limit - (count + 1)),
      used: count + 1,
    };
  }, opts);
}

export function reserveBudget(rootOrOpts = resolveRoot(), limit = 300) {
  return reserveBudgetAtomic(rootOrOpts, limit);
}

export function commitBudgetReservation(rootOrOpts = resolveRoot(), reservationId = "") {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  return appendLedger({ event: "budget_committed", reservationId }, root);
}

export async function withBudget(fn, root = resolveRoot(), limit = 300) {
  const reservation = reserveBudget(root, limit);
  try {
    const result = await fn();
    commitBudgetReservation(root, reservation.reservationId);
    return result;
  } catch (err) {
    appendLedger({ event: "budget_reservation_failed", reservationId: reservation.reservationId, error: err.message }, root);
    throw err;
  }
}

export function getLockDir(rootOrOpts = resolveRoot()) {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  const dir = join(getStateDir(root), "locks");
  ensureDir(dir);
  return dir;
}

export function parseProcStat(stat) {
  if (typeof stat !== "string") return null;
  const rpar = stat.lastIndexOf(")");
  if (rpar === -1) return null;
  const rest = stat.slice(rpar + 2).trim().split(/\s+/);
  return rest[19] || null;
}

export function getProcessStartTime(pid) {
  if (!pid) return null;
  if (typeof pid === "string" && pid.includes(")")) {
    return parseProcStat(pid);
  }
  if (typeof pid !== "number") return null;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
      return parseProcStat(stat);
    } catch (_) {}
  }
  return null;
}

/**
 * Checks if a PID is alive with PID-recycling start time validation on Linux.
 */
export function isPidAlive(pid, expectedStartTime = null) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
  } catch (_) {
    return false;
  }

  if (expectedStartTime !== null && expectedStartTime !== undefined && process.platform === "linux") {
    try {
      const actualStartTime = getProcessStartTime(pid);
      if (!actualStartTime || String(actualStartTime) !== String(expectedStartTime)) {
        return false;
      }
    } catch (_) {
      return false;
    }
  }

  return true;
}

export function acquireLock(agentName, taskId, files = [], rootOrOpts = resolveRoot()) {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  const lockDir = getLockDir(root);
  const lockFile = join(lockDir, `${taskId}.json`);

  if (existsSync(lockFile)) {
    try {
      const existing = JSON.parse(readFileSync(lockFile, "utf-8"));
      const recordedStartTime = existing.processStartTime ?? existing.starttime ?? null;
      const isAlive = isPidAlive(existing.pid, recordedStartTime);
      const isExpired = existing.acquiredAt && Date.now() - new Date(existing.acquiredAt).getTime() > 7200000;

      if (!isAlive || isExpired) {
        try { unlinkSync(lockFile); } catch (_) {}
      } else {
        return { ok: false, holder: existing.agent, taskId, pid: existing.pid };
      }
    } catch (_) {
      try { unlinkSync(lockFile); } catch (_) {}
    }
  }

  const startTime = getProcessStartTime(process.pid);
  const payload = {
    agent: agentName,
    taskId,
    files,
    pid: process.pid,
    processStartTime: startTime,
    starttime: startTime,
    nonce: randomUUID(),
    hostname: hostname(),
    acquiredAt: new Date().toISOString(),
  };

  try {
    const fd = openSync(lockFile, "wx");
    writeSync(fd, JSON.stringify(payload, null, 2), "utf-8");
    fsyncSync(fd);
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
      unlinkSync(lockFile);
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

