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
