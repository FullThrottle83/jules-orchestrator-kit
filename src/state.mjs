import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmdirSync,
  readdirSync,
  openSync,
  writeSync,
  closeSync,
  fsyncSync,
  unlinkSync,
  lstatSync,
  statSync,
} from "node:fs";
import { join, basename, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import os, { hostname } from "node:os";
import { execFileSync } from "node:child_process";
import { resolveRoot, normalizePath } from "./config.mjs";
import { redactSecrets } from "./security.mjs";

function scrubStateValue(value) {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(scrubStateValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, scrubStateValue(child)]));
  }
  return value;
}

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
  const dir = normalizePath(root).endsWith(".agent/jules-queue") ? root : join(root, ".agent/jules-queue");
  ensureDir(dir);
  return dir;
}

export function getStateDir(rootOrOpts = resolveRoot()) {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  const dir = normalizePath(root).endsWith(".agent/state") ? root : join(root, ".agent/state");
  ensureDir(dir);
  return dir;
}

export function getDailyLedgerPath(rootOrOpts = resolveRoot()) {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  const dateStr = new Date().toISOString().split("T")[0];
  return join(getStateDir(root), `ledger-${dateStr}.jsonl`);
}

/**
 * Delete files in a ledger/state directory older than `retentionDays`.
 *
 * Moved out of the deleted scripts/utils.mjs shim; the ledger rotation policy
 * lives with the ledger.
 *
 * @param {string} stateDir
 * @param {number} [retentionDays=30]
 */
export function pruneOldLedgers(stateDir, retentionDays = 30) {
  if (!existsSync(stateDir)) return;
  const cutoff = Date.now() - retentionDays * 86400 * 1000;
  try {
    const files = readdirSync(stateDir);
    for (const f of files) {
      const full = join(stateDir, f);
      try {
        const stat = statSync(full);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          unlinkSync(full);
        }
      } catch (_) {}
    }
  } catch (_) {}
}

/**
 * How far back a task still counts against the allowance.
 *
 * The provider's daily quota resets on a rolling 24-hour window, not at
 * midnight. Counting per calendar day — which the ledger's `ledger-<date>`
 * rotation invites — is wrong in both directions: a batch dispatched at 23:00
 * stops being counted at 00:01 while the provider still refuses on it, and
 * yesterday's last hours vanish from a count that should still include them.
 *
 * The files stay day-scoped, because rotation is a storage concern. Counting
 * is not: it spans whatever files the window touches and filters on entry
 * timestamps.
 */
export const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Ledger files that can hold entries inside the rolling window, oldest first.
 *
 * One day wider than the window itself: an entry timestamped 23:59 UTC sits in
 * that day's file, and a window opening moments later still has to see it.
 *
 * @param {string} [root]
 * @param {number} [now] - Epoch ms; injectable so tests need not wait a day.
 * @param {number} [windowMs]
 * @returns {string[]}
 */
export function getLedgerPathsInWindow(root = resolveRoot(), now = Date.now(), windowMs = ROLLING_WINDOW_MS) {
  const stateDir = getStateDir(root);
  const spanDays = Math.ceil(windowMs / DAY_MS) + 1;
  const paths = [];
  for (let i = spanDays - 1; i >= 0; i--) {
    const dateStr = new Date(now - i * DAY_MS).toISOString().split("T")[0];
    const filePath = join(stateDir, `ledger-${dateStr}.jsonl`);
    if (!paths.includes(filePath) && existsSync(filePath)) paths.push(filePath);
  }
  return paths;
}

/**
 * Replay the budget events in the rolling window and report what is still spent.
 *
 * Reservations carrying a `reservationId` are matched by name. Legacy id-less
 * ones — written by older kit versions — can only be matched by position, so a
 * release without a `releasedTimestamp` consumes the oldest still-open
 * anonymous reservation. `releaseOpenReservations` records that timestamp
 * precisely so the pairing survives the window boundary: without it, an
 * anonymous release could outlive the reservation it cancelled and start
 * subtracting from a later one instead.
 *
 * Entries whose timestamp will not parse are counted. A budget event the kit
 * cannot place in time is safer treated as spent than as free.
 *
 * @param {string} [root]
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {number} [opts.windowMs]
 * @returns {{ used: number, open: { reservationId: string|null, timestamp: string, committed: boolean }[], windowStart: string }}
 */
export function scanBudgetWindow(root = resolveRoot(), opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : ROLLING_WINDOW_MS;
  const cutoff = now - windowMs;

  /** @type {Map<string, { reservationId: string, timestamp: string, committed: boolean, inWindow: boolean }>} */
  const byId = new Map();
  /** @type {{ reservationId: null, timestamp: string, committed: boolean, inWindow: boolean }[]} */
  const anonymous = [];

  const inWindow = (timestamp) => {
    const ts = Date.parse(timestamp || "");
    return Number.isFinite(ts) ? ts >= cutoff : true;
  };

  for (const filePath of getLedgerPathsInWindow(root, now, windowMs)) {
    let raw = "";
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch (_) {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch (_) {
        continue;
      }
      if (!entry || !entry.event) continue;
      const timestamp = entry.timestamp || "";

      if (entry.event === "budget_reserved") {
        const author = entry.author || "anonymous";
        const record = { timestamp, author, committed: false, inWindow: inWindow(timestamp) };
        if (entry.reservationId) byId.set(entry.reservationId, { reservationId: entry.reservationId, ...record });
        else anonymous.push({ reservationId: null, ...record });
      } else if (entry.event === "budget_committed") {
        // A commit does not free the slot — the task really ran — it only marks
        // the reservation as having reached the provider.
        const record = entry.reservationId ? byId.get(entry.reservationId) : null;
        if (record) record.committed = true;
      } else if (entry.event === "budget_rolled_back" || entry.event === "budget_released") {
        if (entry.reservationId) {
          byId.delete(entry.reservationId);
        } else if (entry.releasedTimestamp) {
          const idx = anonymous.findIndex((r) => r.timestamp === entry.releasedTimestamp);
          if (idx !== -1) anonymous.splice(idx, 1);
        } else {
          anonymous.shift();
        }
      }
    }
  }

  const open = [...byId.values(), ...anonymous].filter((r) => r.inWindow);
  const byUser = {};
  for (const r of open) {
    const user = r.author || "anonymous";
    if (!byUser[user]) byUser[user] = { tasks: 0, committed: 0, uncommitted: 0 };
    byUser[user].tasks++;
    if (r.committed) byUser[user].committed++;
    else byUser[user].uncommitted++;
  }

  return {
    used: open.length,
    open: open.map(({ reservationId, timestamp, author, committed }) => ({ reservationId, timestamp, author, committed })),
    byUser,
    windowStart: new Date(cutoff).toISOString(),
  };
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

  const staleMs = opts.staleMs || 2000;

  for (let i = 0; i < maxRetries; i++) {
    let acquired = false;
    try {
      mkdirSync(mutexDir);
      acquired = true;
    } catch (err) {
      if (err.code === "EEXIST") {
        try {
          if (Date.now() - statSync(mutexDir).mtimeMs > staleMs) {
            rmdirSync(mutexDir);
          }
        } catch (_) {}
        const deadline = Date.now() + retryDelayMs;
        while (Date.now() < deadline) {}
        continue;
      }
      throw err;
    }
    
    if (acquired) {
      try {
        return fn();
      } finally {
        try {
          rmdirSync(mutexDir);
        } catch (_) {}
      }
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
    const rawPayload = { timestamp, ...scrubStateValue(entry), prevHash };
    const hash = createHash("sha256").update(JSON.stringify(rawPayload)).digest("hex");
    const payload = { ...rawPayload, hash };

    if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) {
      throw new Error(`Refusing to append to symbolic link: ${filePath}`);
    }

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
 * Verifies the SHA-256 hash-chain integrity of a ledger file.
 *
 * NOTE ON TRUST BOUNDARIES:
 * Hash-chain integrity verifies structural consistency across chained entries
 * and protects against accidental corruption or naive single-line edits.
 * It does NOT provide authenticated integrity against an adversary with filesystem
 * write access who can rewrite the file and recompute the entire hash chain.
 * Authentication requires a trust anchor outside candidate control.
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

/**
 * Returns the host authority directory path for authenticated provenance storage.
 * Positioned on the trusted host machine outside the candidate repository worktree.
 */
export function getHostAuthorityDir() {
  return process.env.JULES_AUTHORITY_DIR
    ? resolve(process.env.JULES_AUTHORITY_DIR)
    : join(
        process.env.JULES_CACHE_DIR ? resolve(process.env.JULES_CACHE_DIR) : join(os.homedir(), ".cache", "jules-orchestrator-kit"),
        "authority"
      );
}

/**
 * Computes a stable host repository key from the canonical path.
 */
export function getRepoAuthorityKey(rootOrOpts = resolveRoot()) {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  const normalized = normalizePath(resolve(root));
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function readDispatchesJournal(repoAuthorityDir) {
  const p = join(repoAuthorityDir, "dispatches.json");
  if (!existsSync(p)) return {};
  try {
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeDispatchesJournal(repoAuthorityDir, journal) {
  const p = join(repoAuthorityDir, "dispatches.json");
  writeFileSync(p, JSON.stringify(journal, null, 2) + "\n", "utf-8");
}

/**
 * Records a pre-dispatch trusted baseline SHA in both:
 * 1. The Host Authority Store (outside repository worktree, providing authenticated provenance
 *    for remote sessions); and
 * 2. The repository-local daily hash-chained ledger and checkpoints (operational state for
 *    audit logging, telemetry, and rollback).
 *
 * @param {string} rootOrOpts - Repository root
 * @param {object} baseline - { baseSha, headSha, taskId, sessionId, branch, lifecycle }
 * @returns {object} Appended ledger entry
 */
export function recordDispatchBaseline(rootOrOpts = resolveRoot(), baseline = {}) {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  if (!baseline.baseSha || !/^[0-9a-f]{40}$/i.test(String(baseline.baseSha).trim())) {
    return null;
  }
  const cleanBaseSha = String(baseline.baseSha).trim();
  const lifecycle = baseline.lifecycle || "remote-session";
  const dispatchNonce = randomUUID();

  // 1. Host Authority Store (trusted host provenance outside repository worktree)
  try {
    const authorityDir = getHostAuthorityDir();
    const repoKey = getRepoAuthorityKey(root);
    const repoAuthorityDir = join(authorityDir, repoKey);
    ensureDir(repoAuthorityDir);

    const authorityRecord = {
      baseSha: cleanBaseSha,
      headSha: baseline.headSha || null,
      taskId: baseline.taskId || null,
      sessionId: baseline.sessionId || null,
      branch: baseline.branch || null,
      lifecycle,
      dispatchedAt: new Date().toISOString(),
      root: normalizePath(resolve(root)),
      dispatchNonce,
    };

    const journal = readDispatchesJournal(repoAuthorityDir);
    journal[dispatchNonce] = {
      baseSha: cleanBaseSha,
      lifecycle,
      dispatchedAt: authorityRecord.dispatchedAt,
      state: "active",
    };
    writeDispatchesJournal(repoAuthorityDir, journal);

    const authorityPath = join(repoAuthorityDir, "authority.json");
    writeFileSync(authorityPath, JSON.stringify(authorityRecord, null, 2) + "\n", "utf-8");
  } catch (_) {}

  // 2. Repository operational state (hash-chain integrity for local operational logging)
  return appendLedger(
    {
      event: "task_dispatch_baseline",
      baseSha: cleanBaseSha,
      headSha: baseline.headSha || null,
      taskId: baseline.taskId || null,
      sessionId: baseline.sessionId || null,
      branch: baseline.branch || null,
      lifecycle,
    },
    root
  );
}

/**
 * Consumes and unlinks the active host authority record before untrusted candidate code executes.
 * Marks the active dispatch nonce as consumed so candidate code running during verification
 * cannot rewrite or reuse host authority for subsequent gate invocations.
 *
 * @param {string} rootOrOpts - Repository root
 * @param {object} [opts={}]
 * @returns {boolean} True if an active authority was consumed
 */
export function consumeHostAuthority(rootOrOpts = resolveRoot(), opts = {}) {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  try {
    const authorityDir = getHostAuthorityDir();
    const repoKey = getRepoAuthorityKey(root);
    const repoAuthorityDir = join(authorityDir, repoKey);
    const authorityPath = join(repoAuthorityDir, "authority.json");

    if (existsSync(authorityPath)) {
      let record = null;
      try {
        record = JSON.parse(readFileSync(authorityPath, "utf-8"));
      } catch (_) {}

      try {
        unlinkSync(authorityPath);
      } catch (_) {}

      if (record && record.dispatchNonce) {
        const journal = readDispatchesJournal(repoAuthorityDir);
        if (journal[record.dispatchNonce]) {
          journal[record.dispatchNonce].state = "consumed";
          journal[record.dispatchNonce].consumedAt = new Date().toISOString();
        } else {
          journal[record.dispatchNonce] = {
            baseSha: record.baseSha || opts.baseSha || null,
            state: "consumed",
            consumedAt: new Date().toISOString(),
          };
        }
        writeDispatchesJournal(repoAuthorityDir, journal);
      }

      const consumedRecord = {
        baseSha: record?.baseSha || opts.baseSha || null,
        dispatchNonce: record?.dispatchNonce || null,
        consumedAt: new Date().toISOString(),
      };
      writeFileSync(join(repoAuthorityDir, "consumed.json"), JSON.stringify(consumedRecord, null, 2) + "\n", "utf-8");
      return true;
    }
  } catch (_) {}
  return false;
}

/**
 * Recovers the latest pre-dispatch trusted baseline SHA.
 *
 * Enforces strict separation between candidate-readable operational state and security authority:
 * - Security authority is established only by Host Authority (for remote-session lifecycle)
 *   or explicit operator-supplied baseline (--base-sha).
 * - Repository operational state (.agent/state/ledger, .agent/state/checkpoints) is candidate-writable
 *   and verified against Host Authority; conflicting repository state indicates tampering/forgery.
 * - Local-agent executions (local-result) execute with shell access in the user's OS domain and cannot
 *   rely on unauthenticated host storage; they fail closed requiring explicit --base-sha.
 *
 * @param {string} rootOrOpts - Repository root
 * @param {object} [opts={}]
 * @returns {{ ok: boolean, baseSha?: string, headSha?: string, source?: string, error?: string, detail?: string, forgedSha?: string }}
 */
export function recoverDispatchBaseline(rootOrOpts = resolveRoot(), opts = {}) {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  const stateDir = getStateDir(root);

  // 1. Check Host Authority Store (outside repository worktree)
  const authorityDir = getHostAuthorityDir();
  const repoKey = getRepoAuthorityKey(root);
  const repoAuthorityDir = join(authorityDir, repoKey);
  const authorityPath = join(repoAuthorityDir, "authority.json");
  const consumedPath = join(repoAuthorityDir, "consumed.json");

  let hostRecord = null;
  let authorityConsumed = false;
  let authorityForged = false;
  let forgedReason = "";

  if (existsSync(authorityPath)) {
    try {
      const raw = readFileSync(authorityPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && parsed.baseSha && /^[0-9a-f]{40}$/i.test(parsed.baseSha)) {
        const journal = readDispatchesJournal(repoAuthorityDir);
        const nonce = parsed.dispatchNonce;
        if (!nonce || !journal[nonce]) {
          authorityForged = true;
          forgedReason = "Host authority record lacks a valid unconsumed dispatch token. Forgery detected.";
          hostRecord = parsed;
        } else if (journal[nonce].state === "consumed") {
          authorityConsumed = true;
          hostRecord = parsed;
        } else if (journal[nonce].baseSha !== parsed.baseSha) {
          authorityForged = true;
          forgedReason = `Host authority record baseSha ${parsed.baseSha} conflicts with active dispatch registration ${journal[nonce].baseSha}. Forgery detected.`;
          hostRecord = parsed;
        } else {
          hostRecord = parsed;
        }
      }
    } catch (_) {}
  } else if (existsSync(consumedPath)) {
    authorityConsumed = true;
  }

  // 2. Check repository-local operational state (.agent/state)
  let repoLedgerBaseSha = null;
  let repoCheckpointBaseSha = null;
  let ledgerIntegrityFailure = null;

  if (existsSync(stateDir)) {
    try {
      const files = readdirSync(stateDir)
        .filter((f) => f.startsWith("ledger-") && f.endsWith(".jsonl"))
        .sort()
        .reverse();

      for (const file of files) {
        const fullPath = join(stateDir, file);
        const integrity = verifyLedgerIntegrity(fullPath);
        if (!integrity.ok) {
          ledgerIntegrityFailure = integrity.error;
          break;
        }

        const entries = readLedger(fullPath);
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i];
          if (entry.event === "task_dispatch_baseline" && entry.baseSha && /^[0-9a-f]{40}$/i.test(entry.baseSha)) {
            repoLedgerBaseSha = entry.baseSha;
            break;
          }
        }
        if (repoLedgerBaseSha) break;
      }
    } catch (_) {}

    const checkpointDir = join(stateDir, "checkpoints");
    if (existsSync(checkpointDir)) {
      try {
        const cpFiles = readdirSync(checkpointDir)
          .filter((f) => f.endsWith(".json"))
          .map((f) => {
            const p = join(checkpointDir, f);
            try {
              return { file: f, path: p, mtime: statSync(p).mtimeMs };
            } catch (_) {
              return null;
            }
          })
          .filter(Boolean)
          .sort((a, b) => b.mtime - a.mtime);

        for (const cp of cpFiles) {
          try {
            const data = JSON.parse(readFileSync(cp.path, "utf-8"));
            const candidateSha = data.baseSha || data.headSha;
            if (candidateSha && /^[0-9a-f]{40}$/i.test(candidateSha)) {
              repoCheckpointBaseSha = candidateSha;
              break;
            }
          } catch (_) {}
        }
      } catch (_) {}
    }
  }

  // 3. Security Decision & Cross-Validation:
  // If repository ledger suffered hash-chain corruption / torn write / naive tampering:
  if (ledgerIntegrityFailure) {
    return {
      ok: false,
      error: "LEDGER_INTEGRITY_COMPROMISED",
      detail: ledgerIntegrityFailure,
    };
  }

  if (authorityForged) {
    let originalBaseSha = null;
    try {
      if (existsSync(consumedPath)) {
        const c = JSON.parse(readFileSync(consumedPath, "utf-8"));
        originalBaseSha = c.baseSha || null;
      }
    } catch (_) {}
    return {
      ok: false,
      error: "FORGED_BASELINE_DETECTED",
      detail: forgedReason || "Host authority record lacks a valid unconsumed dispatch token. Forgery detected.",
      baseSha: originalBaseSha || null,
      forgedSha: hostRecord?.baseSha || null,
    };
  }

  if (authorityConsumed) {
    return {
      ok: false,
      error: "DISPATCH_AUTHORITY_CONSUMED",
      detail:
        "Dispatch authority was already consumed by a prior verification pass. An explicit trusted --base-sha <sha> is required for repeated or subsequent verification.",
    };
  }

  // If host authority is NOT present:
  if (!hostRecord) {
    if (repoLedgerBaseSha || repoCheckpointBaseSha) {
      return {
        ok: false,
        error: "UNAUTHENTICATED_REPOSITORY_STATE",
        detail:
          "Committed verification requires an authenticated pre-established trusted base SHA. Local repository state (.agent/state) is candidate-writable and cannot serve as an unauthenticated authority. Specify --base-sha <sha> explicitly or dispatch through a verified host authority.",
      };
    }
    return { ok: false, error: "NO_PRE_DISPATCH_BASELINE" };
  }

  // Host authority IS present.
  // Check lifecycle: Local vs Remote
  if (hostRecord.lifecycle === "local-result") {
    return {
      ok: false,
      error: "LOCAL_LIFECYCLE_REQUIRES_EXPLICIT_BASE",
      detail:
        "Committed verification of local-agent execution requires an explicit trusted --base-sha <sha>. Host storage is within the local candidate OS trust domain and cannot serve as an unauthenticated authority.",
    };
  }

  // For remote-session (Jules):
  // If repository baseline state was deleted, fail closed (cannot verify without repository operational record)
  if (opts.requireRepoState && !repoLedgerBaseSha && !repoCheckpointBaseSha) {
    return {
      ok: false,
      error: "REPO_STATE_DELETED",
      detail: "Repository baseline state is missing or was deleted.",
    };
  }

  // Check if candidate attempted to forge or overwrite repository state:
  if (repoLedgerBaseSha && repoLedgerBaseSha !== hostRecord.baseSha) {
    return {
      ok: false,
      error: "FORGED_BASELINE_DETECTED",
      detail: `Repository ledger claims forged baseline ${repoLedgerBaseSha} conflicting with authenticated host authority ${hostRecord.baseSha}.`,
      baseSha: hostRecord.baseSha,
      forgedSha: repoLedgerBaseSha,
    };
  }

  if (repoCheckpointBaseSha && repoCheckpointBaseSha !== hostRecord.baseSha) {
    return {
      ok: false,
      error: "FORGED_BASELINE_DETECTED",
      detail: `Repository checkpoint claims forged baseline ${repoCheckpointBaseSha} conflicting with authenticated host authority ${hostRecord.baseSha}.`,
      baseSha: hostRecord.baseSha,
      forgedSha: repoCheckpointBaseSha,
    };
  }

  return {
    ok: true,
    baseSha: hostRecord.baseSha,
    headSha: hostRecord.headSha || null,
    source: "host_authority",
    lifecycle: hostRecord.lifecycle,
  };
}

/**
 * Tasks still counted against the allowance, over the rolling 24-hour window.
 *
 * The name is kept for compatibility; "daily" here means the provider's day,
 * which is the last 24 hours rather than the calendar one.
 */
export function checkDailyBudget(arg1 = resolveRoot(), arg2 = 300, opts = {}) {
  let root = typeof arg1 === "string" ? arg1 : resolveRoot();
  let limit = typeof arg1 === "number" ? arg1 : typeof arg2 === "number" ? arg2 : 300;

  try {
    const scan = scanBudgetWindow(root, opts);
    return {
      ok: scan.used < limit,
      used: scan.used,
      budget: limit,
      remaining: Math.max(0, limit - scan.used),
      windowStart: scan.windowStart,
    };
  } catch (err) {
    return { ok: false, used: limit, budget: limit, remaining: 0, error: err.message };
  }
}

/**
 * Reserve one unit of the daily budget, nameably.
 *
 * @param {number} [maxSessions=300]
 * @param {string} [taskKey=""]
 * @param {string} [root] - Ledger root. Defaults to the git toplevel. Pass an
 *   explicit root to keep callers (notably tests) off the operator's real ledger.
 */
export function reserveDailyBudget(maxSessions = 300, taskKey = "", root = resolveRoot()) {
  // The id is what makes the reservation releasable. Written without one, a
  // reservation counted against the day and no rollback, commit or reconcile
  // could ever name it again — it stayed charged until the ledger rotated.
  const reservationId = `res-${Date.now()}-${randomUUID().slice(0, 8)}`;
  appendLedger({ event: "budget_reserved", reservationId, key: taskKey }, root);
  const check = checkDailyBudget(root, maxSessions);
  return { ok: check.ok, used: check.used, budget: maxSessions, reservationId };
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
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const dateStr = new Date(now).toISOString().split("T")[0];
    const filePath = join(stateDir, `ledger-${dateStr}.jsonl`);

    // The count spans the rolling window; the hash chain does not. A chain is
    // per file, so the new entry links to today's last hash even when the
    // reservations it is counted against were written yesterday.
    const used = scanBudgetWindow(root, { ...opts, now }).used;
    let prevHash = "0".repeat(64);

    if (existsSync(filePath)) {
      try {
        const raw = readFileSync(filePath, "utf-8");
        const lines = raw.split("\n").filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const entry = JSON.parse(lines[i]);
            if (entry && entry.hash) {
              prevHash = entry.hash;
              break;
            }
          } catch (_) {}
        }
      } catch (_) {}
    }

    // `enforce: false` marks a limit the kit only guessed (a tier preset rather
    // than a stated or provider-demonstrated figure). Blocking on a guess would
    // refuse work the provider would happily have accepted, so an uncertain
    // ceiling records the overrun and lets the call through to find out.
    const overLimit = used >= limit;
    if (overLimit && opts.enforce !== false) {
      throw new BudgetError(`Daily budget exhausted (${used}/${limit} tasks executed)`);
    }

    const timestamp = new Date(now).toISOString();
    const reservationId = `res-${now}-${randomUUID().slice(0, 8)}`;
    const author = opts.author || "anonymous-local";
    const rawPayload = { timestamp, event: "budget_reserved", reservationId, budget: limit, author, prevHash };
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
      remaining: Math.max(0, limit - (used + 1)),
      used: used + 1,
      softLimitExceeded: overLimit,
    };
  }, opts);
}

export function reserveBudget(rootOrOpts = resolveRoot(), limit = 300, opts = {}) {
  return reserveBudgetAtomic(rootOrOpts, limit, opts);
}

export function commitBudgetReservation(rootOrOpts = resolveRoot(), reservationId = "") {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  return appendLedger({ event: "budget_committed", reservationId }, root);
}

export function rollbackBudgetReservation(rootOrOpts = resolveRoot(), reservationId = "") {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  return appendLedger({ event: "budget_rolled_back", reservationId }, root);
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.enforce=true] - Pass false when `limit` is an estimate
 *   rather than a known allowance; the overrun is then recorded, not blocked.
 */
export async function withBudget(fn, root = resolveRoot(), limit = 300, opts = {}) {
  const reservation = reserveBudget(root, limit, opts);
  try {
    const result = await fn();
    commitBudgetReservation(root, reservation.reservationId);
    return result;
  } catch (err) {
    if (err && typeof err === "object") {
      err.reservationId = reservation.reservationId;
    }
    try {
      rollbackBudgetReservation(root, reservation.reservationId);
      if (err && typeof err === "object") err.budgetReservationRolledBack = true;
    } catch (_) {}
    try {
      appendLedger({
        event: "budget_reservation_failed",
        reservationId: reservation.reservationId,
        error: err?.message || String(err),
      }, root);
    } catch (_) {}
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
  if (process.platform === "darwin") {
    try {
      const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] });
      return out.trim() || null;
    } catch (_) {}
  }
  return null;
}

/**
 * Checks if a PID is alive with PID-recycling start time validation on Linux and macOS.
 */
export function isPidAlive(pid, expectedStartTime = null) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err?.code !== "EPERM") return false;
  }

  if (expectedStartTime !== null && expectedStartTime !== undefined) {
    try {
      const actualStartTime = getProcessStartTime(pid);
      if (actualStartTime && String(actualStartTime) !== String(expectedStartTime)) {
        return false;
      }
    } catch (_) {
      return false;
    }
  }

  return true;
}

export const LOCK_TTL_MS = 7200000;

/**
 * The epoch-ms instant a lock record stops holding.
 *
 * Records written before leases existed carry only `acquiredAt`, so they keep
 * the two-hour window they were reaped on before.
 */
function lockExpiry(record) {
  if (!record) return 0;
  if (record.expiresAt) {
    const t = new Date(record.expiresAt).getTime();
    if (Number.isFinite(t)) return t;
  }
  if (record.acquiredAt) {
    const t = new Date(record.acquiredAt).getTime();
    if (Number.isFinite(t)) return t + LOCK_TTL_MS;
  }
  return Infinity;
}

/**
 * Is this lock still held?
 *
 * There are two kinds of holder and only one of them has a process worth
 * asking about.
 *
 * An in-process caller — the engine, the swarm — holds the lock for as long as
 * it runs, so its pid is a real witness: if it died the lock is garbage, and
 * reaping on a dead pid is what stops a crash from wedging the repo for the
 * full TTL.
 *
 * `agentctl lock acquire` is the opposite. That process writes the file and
 * exits *by design* — the agent it speaks for lives in some other process, on
 * another machine, or has not started yet. Asking whether the CLI that wrote
 * the record is alive therefore always answered "no", so the very next acquire
 * reaped the lock and handed the same files to a second agent, telling both
 * they had exclusive access. Two holders who each believe they are alone is
 * worse than no lock at all. A record written that way marks itself `leased`,
 * and then only its expiry decides.
 */
export function isLockLive(record) {
  if (!record) return false;
  if (Date.now() >= lockExpiry(record)) return false;
  if (record.leased === true) return true;
  return isPidAlive(record.pid, record.processStartTime ?? record.starttime ?? null);
}

function assertSafeTaskId(taskId) {
  if (typeof taskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId) || basename(taskId) !== taskId) {
    throw new Error("Invalid task id for lock path");
  }
}

export function acquireLock(agentName, taskId, files = [], rootOrOpts = resolveRoot(), opts = {}) {
  assertSafeTaskId(taskId);
  const root = typeof rootOrOpts === "string" ? rootOrOpts : (rootOrOpts?.root || resolveRoot());
  const branch = (typeof rootOrOpts === "object" && rootOrOpts?.branch) || opts?.branch || process.env.JULES_BRANCH || process.env.BRANCH_NAME || "";
  const lockDir = getLockDir(root);
  return withVfsMutex(join(lockDir, ".acquire.mutex"), () => {
    const lockFile = join(lockDir, `${taskId}.json`);

    if (existsSync(lockFile)) {
    try {
      const existing = JSON.parse(readFileSync(lockFile, "utf-8"));
      if (isLockLive(existing)) {
        return {
          ok: false,
          holder: existing.agent,
          taskId,
          pid: existing.pid,
          expiresAt: existing.expiresAt || null,
        };
      }
      try { unlinkSync(lockFile); } catch (_) {}
    } catch (_) {
      try { unlinkSync(lockFile); } catch (_) {}
    }
  }

  // The lock file is named after the task, so `existsSync(lockFile)` above only
  // ever asked "is this same task already running?". The `files` argument — the
  // whole point of the call — was stored as metadata and never compared against
  // anything, so two agents could hold locks on the same file at the same time
  // and each be told it had exclusive access. Check the paths, not just the id.
  const requested = new Set(
    (Array.isArray(files) ? files : [])
      .filter((f) => typeof f === "string" && f)
      .map((f) => normalizePath(f))
  );
  if (requested.size > 0) {
    for (const held of lockStatus(root)) {
      if (!held || held.taskId === taskId) continue;

      const overlap = (Array.isArray(held.files) ? held.files : [])
        .map((f) => normalizePath(f))
        .filter((f) => requested.has(f));
      if (overlap.length > 0) {
        if (!isLockLive(held)) {
          if (held.taskId) {
            try { unlinkSync(join(lockDir, `${held.taskId}.json`)); } catch (_) {}
          }
          continue;
        }
        return {
          ok: false,
          holder: held.agent,
          taskId: held.taskId,
          pid: held.pid,
          expiresAt: held.expiresAt || null,
          conflictingFiles: overlap,
        };
      }
    }
  }

  // `leased` says the holder is not this process. A caller that will stay
  // alive for the duration (the engine, the swarm) leaves it off and gets pid
  // liveness; a one-shot CLI sets it and gets a plain time-bounded lease. See
  // isLockLive.
  const leased = opts?.lease === true;
  const ownerPid = Number.isInteger(opts?.ownerPid) && opts.ownerPid > 0 ? opts.ownerPid : process.pid;
  const ttlMs = Number.isFinite(opts?.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : LOCK_TTL_MS;
  const startTime = getProcessStartTime(ownerPid);
  const acquiredAt = new Date();
  const concurrencyGroup = String(opts?.concurrencyGroup || opts?.concurrency_group || "").trim();
  const payload = {
    agent: agentName,
    taskId,
    branch,
    files,
    concurrencyGroup,
    pid: ownerPid,
    processStartTime: startTime,
    starttime: startTime,
    leased,
    nonce: randomUUID(),
    hostname: hostname(),
    acquiredAt: acquiredAt.toISOString(),
    expiresAt: new Date(acquiredAt.getTime() + ttlMs).toISOString(),
  };

  let fd;
  try {
    fd = openSync(lockFile, "wx");
    writeSync(fd, JSON.stringify(payload, null, 2), "utf-8");
    fsyncSync(fd);
    return { ok: true, lockFile };
  } catch (err) {
    if (err.code === "EEXIST") {
      try {
        const existing = JSON.parse(readFileSync(lockFile, "utf-8"));
        return { ok: false, holder: existing.agent, taskId };
      } catch (_) {
        // Corrupted or 0-byte existing file: unlink so the task does not stay wedged.
        try { unlinkSync(lockFile); } catch (_) {}
        return { ok: false, holder: "unknown", taskId };
      }
    }
    try { unlinkSync(lockFile); } catch (_) {}
    throw err;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch (_) {}
    }
  }
  });
}

export function releaseLock(taskId, rootOrOpts = resolveRoot()) {
  try {
    assertSafeTaskId(taskId);
  } catch (_) {
    return false;
  }
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

export function lockStatus(rootOrOpts = resolveRoot(), opts = {}) {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : (rootOrOpts?.root || resolveRoot());
  const activeOnly = opts?.activeOnly === true;
  const lockDir = getLockDir(root);
  const locks = [];
  try {
    const files = readdirSync(lockDir);
    for (const file of files) {
      if (file.endsWith(".json")) {
        try {
          const content = readFileSync(join(lockDir, file), "utf-8");
          const record = JSON.parse(content);
          const live = isLockLive(record);
          if (activeOnly && !live) continue;
          locks.push(Object.freeze({ ...record, live }));
        } catch (_) {}
      }
    }
  } catch (_) {}
  return locks;
}

/**
 * Checks if a specific concurrency group is currently locked by an active task session.
 *
 * @param {string} groupName - Concurrency group name
 * @param {string|Object} [rootOrOpts=resolveRoot()] - Project root path or options
 * @param {string} [excludeTaskId=""] - Optional task ID to exclude from check
 * @returns {boolean} True if group is active/locked
 */
export function isConcurrencyGroupLocked(groupName, rootOrOpts = resolveRoot(), excludeTaskId = "") {
  if (!groupName || typeof groupName !== "string" || !groupName.trim()) {
    return false;
  }
  const targetGroup = groupName.trim().toLowerCase();
  const locks = lockStatus(rootOrOpts);
  for (const lock of locks) {
    if (excludeTaskId && lock.taskId === excludeTaskId) continue;
    if (!isLockLive(lock)) continue;
    const lockGroup = String(lock.concurrencyGroup || lock.concurrency_group || "").trim().toLowerCase();
    if (lockGroup === targetGroup) {
      return true;
    }
  }
  return false;
}

/**
 * Scans .agent/state/locks/ for stale, expired, or corrupted lock records.
 *
 * Supported queue/process model:
 * - Leased locks: reaped if Date.now() >= lockExpiry(record).
 * - Process-bound locks: reaped if owner PID is dead (or recycled with different start time).
 * - Corrupted files: 0-byte or unparseable JSON files reaped immediately.
 * - Live locks: left completely untouched.
 *
 * @param {string|Object} [rootOrOpts=resolveRoot()]
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun=false] - When true, reports stale locks without deleting them.
 * @returns {{ reapedCount: number, reaped: Array<{ file: string, taskId: string, agent: string, pid: number|null, reason: "corrupted"|"expired"|"dead-pid" }> }}
 */
export function reapStaleLocks(rootOrOpts = resolveRoot(), { dryRun = false } = {}) {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : (rootOrOpts?.root || resolveRoot());
  const lockDir = getLockDir(root);

  if (!existsSync(lockDir)) {
    return { reapedCount: 0, reaped: [] };
  }

  const reaped = [];
  let files = [];
  try {
    files = readdirSync(lockDir);
  } catch (_) {
    return { reapedCount: 0, reaped: [] };
  }

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const lockPath = join(lockDir, file);
    let record = null;
    let corrupted = false;

    try {
      const content = readFileSync(lockPath, "utf-8");
      if (!content || !content.trim()) {
        corrupted = true;
      } else {
        record = JSON.parse(content);
      }
    } catch (_) {
      corrupted = true;
    }

    let shouldReap = false;
    let reason = "";

    if (corrupted) {
      shouldReap = true;
      reason = "corrupted";
    } else if (!isLockLive(record)) {
      shouldReap = true;
      if (record.leased === true) {
        reason = "expired";
      } else if (record.expiresAt && Date.now() >= lockExpiry(record)) {
        reason = "expired";
      } else {
        reason = "dead-pid";
      }
    }

    if (shouldReap) {
      if (!dryRun) {
        try {
          unlinkSync(lockPath);
        } catch (_) {}
      }
      reaped.push({
        file,
        taskId: record?.taskId || file.replace(/\.json$/, ""),
        agent: record?.agent || "unknown",
        pid: record?.pid ?? null,
        reason,
      });
    }
  }

  return { reapedCount: reaped.length, reaped };
}



