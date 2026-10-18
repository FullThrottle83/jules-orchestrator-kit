/**
 * Cross-platform process-tree cleanup for timed-out commands.
 *
 * Zero third-party deps. Used by `runCmd` when a spawnSync hits ETIMEDOUT so
 * orphaned workers (children / grandchildren) do not linger after the parent
 * is killed.
 *
 * Platform notes:
 * - win32: `taskkill /F /T /PID` terminates the whole tree. `detached` is NOT
 *   set on Windows spawn options in runCmd — taskkill does not need a separate
 *   process group, and detached consoles behave differently under cmd.exe.
 * - POSIX (linux/darwin): prefer `process.kill(-pid, signal)` against the
 *   process group (runCmd sets `detached: true` so the child is group leader).
 *   Also walk descendants via `pgrep -P` so cleanup still works when the child
 *   was not started in its own group.
 */

import { spawnSync } from "node:child_process";
import process from "node:process";

/**
 * @param {unknown} pid
 * @returns {number} Positive integer pid, or 0 if invalid.
 */
function normalizePid(pid) {
  const n = typeof pid === "number" ? pid : Number(pid);
  if (!Number.isInteger(n) || n <= 0) return 0;
  return n;
}

/**
 * List direct children of `pid` via `pgrep -P`. Empty on failure / none.
 * @param {number} pid
 * @returns {number[]}
 */
function listDirectChildren(pid) {
  try {
    const ret = spawnSync("pgrep", ["-P", String(pid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // pgrep exits 1 when there are no matches — treat as empty, not failure.
    if (ret.error || !ret.stdout) return [];
    return ret.stdout
      .split(/\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * Breadth-first collect all descendants, returned deepest-first so parents are
 * signalled after their children (reduces reparent races during cleanup).
 * @param {number} pid
 * @returns {number[]}
 */
function collectDescendants(pid) {
  const out = [];
  const queue = [pid];
  const seen = new Set([pid]);
  while (queue.length > 0) {
    const current = queue.shift();
    for (const child of listDirectChildren(current)) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out.reverse();
}

/**
 * Signal a single pid; never throws (ESRCH / EPERM / already-dead are quiet).
 * @param {number} pid
 * @param {NodeJS.Signals|number} signal
 */
function safeKill(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (err) {
    const code = err && err.code;
    if (code === "ESRCH" || code === "EPERM") return;
    // Any other failure is still swallowed: cleanup must not fail the caller.
  }
}

/**
 * Kill `pid` and its descendants.
 *
 * Never throws for missing / already-dead processes (ESRCH, taskkill exit
 * 128+, empty pgrep). Invalid pids are a no-op.
 *
 * @param {number|string} pid
 * @param {NodeJS.Signals|number} [signal="SIGTERM"]
 */
export function killProcessTree(pid, signal = "SIGTERM") {
  const n = normalizePid(pid);
  if (!n) return;

  if (process.platform === "win32") {
    try {
      // /T = tree, /F = force. Non-zero exit (e.g. 128 "not found") is fine.
      spawnSync("taskkill", ["/F", "/T", "/PID", String(n)], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // spawn failure or already gone — ignore
    }
    return;
  }

  // Snapshot the tree while parent→child links still exist. After the parent
  // dies, Linux reparents orphans to the subreaper and `pgrep -P` goes blind.
  const descendants = collectDescendants(n);

  // Process-group signal: effective when `pid` is a group leader (detached spawn).
  try {
    process.kill(-n, signal);
  } catch (err) {
    const code = err && err.code;
    if (code !== "ESRCH" && code !== "EPERM") {
      // fall through to per-pid cleanup
    }
  }

  // Belt-and-suspenders: direct-child pkill (covers callers that skip the walk).
  try {
    const sigName = typeof signal === "string" ? signal.replace(/^SIG/i, "") : String(signal);
    spawnSync("pkill", [`-${sigName}`, "-P", String(n)], {
      stdio: "ignore",
    });
  } catch {
    // pkill missing or no children — ignore
  }

  for (const childPid of descendants) {
    safeKill(childPid, signal);
  }
  safeKill(n, signal);
}

/**
 * List members of process group `pgid` via `pgrep -g`. Empty on failure / none.
 * @param {number} pgid
 * @returns {number[]}
 */
function listProcessGroupMembers(pgid) {
  try {
    const ret = spawnSync("pgrep", ["-g", String(pgid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (ret.error || !ret.stdout) return [];
    return ret.stdout
      .split(/\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch {
    return [];
  }
}

/**
 * Checks whether a single PID is alive and not a zombie (`Z` state).
 * @param {number} targetPid
 * @param {(pid: number, sig: NodeJS.Signals|number) => void} killFn
 * @param {boolean} isCustomKill
 * @param {typeof spawnSync} spawnSyncFn
 * @returns {boolean}
 */
function isPidAlive(targetPid, killFn, isCustomKill, spawnSyncFn) {
  try {
    killFn(targetPid, 0);
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
  if (isCustomKill || targetPid <= 0) {
    return true;
  }
  if (process.platform !== "win32") {
    try {
      const ret = spawnSyncFn("ps", ["-o", "state=", "-p", String(targetPid)], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (!ret.error && typeof ret.stdout === "string") {
        const st = ret.stdout.trim();
        if (!st || st.startsWith("Z")) return false;
      }
    } catch {
      // ignore ps failure and trust kill(pid, 0)
    }
  }
  return true;
}

/**
 * Terminates a process tree (`pid` and all descendants) across platforms and
 * waits for full teardown before resolving.
 *
 * - Windows (`win32`): invokes `taskkill /F /T /PID <pid>` synchronously so
 *   completion is observed before returning. Exit code 0 or 128 ("not found")
 *   is treated as clean termination.
 * - POSIX: snapshots descendants and process-group members, sends `SIGTERM` to
 *   process group `-pid` and all descendants, waits up to `gracePeriodMs` for
 *   exit, and escalates any surviving members to `SIGKILL`.
 *
 * Never throws; returns `{ ok: boolean, escalated?: boolean, error?: string }`.
 *
 * @param {number|string} pid
 * @param {object} [options]
 * @param {string} [options.platform]
 * @param {number} [options.gracePeriodMs=400]
 * @param {number} [options.pollIntervalMs=25]
 * @param {typeof spawnSync} [options.spawnSyncFn]
 * @param {(pid: number, sig: NodeJS.Signals|number) => void} [options.killFn]
 * @returns {Promise<{ ok: boolean, escalated?: boolean, error?: string }>}
 */
export async function reapProcessTree(pid, options = {}) {
  const n = normalizePid(pid);
  if (!n) return { ok: true, escalated: false };

  const platform = options.platform || process.platform;
  const gracePeriodMs = Number.isFinite(options.gracePeriodMs) && options.gracePeriodMs >= 0
    ? Number(options.gracePeriodMs)
    : 400;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs) && options.pollIntervalMs > 0
    ? Number(options.pollIntervalMs)
    : 25;
  const spawnSyncFn = options.spawnSyncFn || spawnSync;
  const isCustomKill = typeof options.killFn === "function";
  const killFn = options.killFn || ((targetPid, sig) => process.kill(targetPid, sig));

  if (platform === "win32") {
    try {
      const ret = spawnSyncFn("taskkill", ["/F", "/T", "/PID", String(n)], {
        stdio: "ignore",
        windowsHide: true,
      });
      if (ret && ret.error) {
        return { ok: false, error: ret.error.message || String(ret.error) };
      }
      // Exit code 0 = terminated; 128 (or 255) = process already exited / not found.
      if (ret && typeof ret.status === "number" && ret.status !== 0 && ret.status !== 128 && ret.status !== 255) {
        return { ok: false, error: `taskkill exited with status ${ret.status}` };
      }
      return { ok: true, escalated: false };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  const trackedPids = new Set([n]);
  const snapshotTree = () => {
    if (!isCustomKill) {
      for (const pgMember of listProcessGroupMembers(n)) {
        trackedPids.add(pgMember);
      }
      for (const knownPid of Array.from(trackedPids)) {
        for (const childPid of collectDescendants(knownPid)) {
          trackedPids.add(childPid);
        }
      }
    }
  };

  const signalAll = (sig) => {
    snapshotTree();
    try {
      killFn(-n, sig);
    } catch {
      // ESRCH / EPERM / non-leader — continue to per-PID signalling
    }
    if (!isCustomKill) {
      try {
        const sigName = typeof sig === "string" ? sig.replace(/^SIG/i, "") : String(sig);
        spawnSyncFn("pkill", [`-${sigName}`, "-P", String(n)], { stdio: "ignore" });
      } catch {
        // ignore missing pkill
      }
    }
    const ordered = Array.from(trackedPids).reverse();
    for (const targetPid of ordered) {
      try {
        killFn(targetPid, sig);
      } catch {
        // ignore ESRCH / EPERM
      }
    }
  };

  const anyAlive = () => {
    snapshotTree();
    for (const targetPid of trackedPids) {
      if (isPidAlive(targetPid, killFn, isCustomKill, spawnSyncFn)) return true;
    }
    return false;
  };

  if (!anyAlive()) {
    return { ok: true, escalated: false };
  }

  signalAll("SIGTERM");

  const graceDeadline = Date.now() + gracePeriodMs;
  while (Date.now() < graceDeadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    if (!anyAlive()) {
      return { ok: true, escalated: false };
    }
  }

  if (!anyAlive()) {
    return { ok: true, escalated: false };
  }

  signalAll("SIGKILL");

  const killDeadline = Date.now() + Math.max(gracePeriodMs, 250);
  while (Date.now() < killDeadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    if (!anyAlive()) {
      return { ok: true, escalated: true };
    }
  }

  const stillAlive = anyAlive();
  return stillAlive
    ? { ok: false, escalated: true, error: `Process tree rooted at PID ${n} did not terminate after SIGKILL` }
    : { ok: true, escalated: true };
}


