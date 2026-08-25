/**
 * Process Group Guillotine & Subshell Teardown (Roadmap v0.44.0)
 *
 * Zero-dependency process containment primitives. Native Node built-ins only:
 * `node:child_process`, `node:process`, `node:os` — no third-party packages.
 *
 * Problem solved: a timed-out subshell (`sh -c 'server & wait'`), a Jest/Vite
 * watcher, or a dev server spawned for a smoke probe dies on SIGTERM while its
 * background grandchildren keep running — orphaned, holding ports, and
 * triggering EADDRINUSE on the next run.
 *
 * Mechanism:
 *   - `spawnProcessGroup` spawns with `detached: true`, which makes the child
 *     the leader of its own process group on POSIX (setsid) and its own
 *     console/process-tree root on Windows, so the whole subtree is
 *     addressable by one handle.
 *   - `killProcessTree` then signals the *group* (negative pid on POSIX,
 *     `taskkill /T /F` on Windows), escalates SIGTERM -> SIGKILL after a grace
 *     period for processes that ignore polite signals, and treats an
 *     already-dead group (ESRCH) as success rather than an error.
 */

import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import os from "node:os";

/** Default delay between the SIGTERM pass and the SIGKILL escalation pass. */
export const DEFAULT_KILL_GRACE_MS = 2000;

/**
 * Blocks the calling thread for `ms` milliseconds without spawning a helper
 * process. `Atomics.wait` on a shared buffer is the only dependency-free
 * synchronous sleep available on the main thread.
 *
 * @param {number} ms
 */
function sleepSync(ms) {
  if (!(ms > 0)) return;
  const end = Date.now() + ms;
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  let left = ms;
  while (left > 0) {
    Atomics.wait(view, 0, 0, left);
    left = end - Date.now();
  }
}

/**
 * Resolves the numeric pid of a process tree handle.
 *
 * @param {number | { pid?: number }} childOrPid - Either a raw pid or a
 *   ChildProcess-like object exposing `.pid`.
 * @returns {number | null}
 */
function resolvePid(childOrPid) {
  if (typeof childOrPid === "number") return Number.isInteger(childOrPid) && childOrPid > 0 ? childOrPid : null;
  if (childOrPid && typeof childOrPid === "object" && Number.isInteger(childOrPid.pid) && childOrPid.pid > 0) {
    return childOrPid.pid;
  }
  return null;
}

/**
 * Spawns a command as the leader of its own process group.
 *
 * `detached: true` is forced: it is the property that lets a later
 * `killProcessTree` reach every descendant with one signal, so a caller
 * cannot accidentally opt out of containment. `windowsHide: true` prevents a
 * console window from appearing for detached children on Windows.
 *
 * @param {string} cmd - Executable to spawn.
 * @param {string[]} args - Argument vector.
 * @param {import("node:child_process").SpawnOptions} [opts] - Passthrough
 *   spawn options (`cwd`, `env`, `stdio`, …). `detached` is overridden to
 *   `true`; `windowsHide` defaults to `true`.
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawnProcessGroup(cmd, args = [], opts = {}) {
  if (typeof cmd !== "string" || cmd.length === 0) {
    throw new TypeError("spawnProcessGroup: cmd must be a non-empty string");
  }
  if (!Array.isArray(args)) {
    throw new TypeError("spawnProcessGroup: args must be an array of strings");
  }
  return spawn(cmd, args, {
    ...opts,
    detached: true,
    windowsHide: opts.windowsHide !== undefined ? opts.windowsHide : true,
  });
}

/**
 * Terminates an entire process tree, escalating to SIGKILL after a grace
 * period so processes that ignore SIGTERM cannot survive teardown.
 *
 * POSIX: signals the negative pid (the whole process group). A group that is
 * already gone raises ESRCH, which is treated as success — cleanup must never
 * throw on already-dead processes.
 *
 * Windows: runs `taskkill /T /F /PID <pid>`, which force-kills the process
 * and every descendant. `taskkill` itself does not throw for a missing
 * process; exit code 128 ("process not found") is normalized to an
 * already-dead success.
 *
 * @param {number | { pid?: number }} childOrPid - Raw pid or ChildProcess.
 * @param {object} [opts]
 * @param {number} [opts.graceMs=2000] - Grace period between the polite
 *   signal and the SIGKILL escalation.
 * @param {NodeJS.Signals} [opts.signal="SIGTERM"] - First (polite) signal.
 * @param {NodeJS.Signals} [opts.killSignal="SIGKILL"] - Escalation signal.
 * @param {NodeJS.Platform} [opts.platform] - Platform to act as (defaults to
 *   the runtime platform; used by tests to exercise the win32 path).
 * @param {Function} [opts._spawnSync] - Internal seam: spawnSync
 *   implementation used for `taskkill` (test injection point).
 * @param {string} [opts.taskkillPath] - Internal seam: path to taskkill.
 * @returns {{ ok: boolean, method?: string, pid?: number|null, reaped?: boolean, alreadyDead?: boolean, escalated?: boolean, graceMs?: number, status?: number|null, error?: string|null, reason?: string }}
 */
export function killProcessTree(childOrPid, opts = {}) {
  const pid = resolvePid(childOrPid);
  if (pid === null) {
    return { ok: false, reason: "invalid-pid", pid: null };
  }

  const platform = opts.platform || os.platform();
  const graceMs = opts.graceMs === undefined ? DEFAULT_KILL_GRACE_MS : Math.max(0, Number(opts.graceMs) || 0);
  const signal = opts.signal || "SIGTERM";
  const killSignal = opts.killSignal || "SIGKILL";

  if (platform === "win32") {
    const runner = opts._spawnSync || spawnSync;
    const taskkillPath = opts.taskkillPath || "taskkill";
    const res = runner(taskkillPath, ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (res.error) {
      return { ok: false, method: "taskkill", pid, status: res.status ?? null, error: res.error.message || String(res.error) };
    }
    // taskkill exit 128: "ERROR: The process ... not found." — already dead.
    if (res.status === 128) {
      return { ok: true, method: "taskkill", pid, reaped: true, alreadyDead: true, status: res.status };
    }
    if (res.status !== 0) {
      return { ok: false, method: "taskkill", pid, status: res.status, error: `taskkill exited with status ${res.status}` };
    }
    return { ok: true, method: "taskkill", pid, reaped: true, status: res.status };
  }

  // POSIX: signal the negative pid so the signal reaches every member of the
  // child's process group, not just the leader.
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if (err.code === "ESRCH") {
      return { ok: true, method: "posix-group", pid, reaped: true, alreadyDead: true, graceMs };
    }
    return { ok: false, method: "posix-group", pid, error: err.message };
  }

  if (graceMs > 0) sleepSync(graceMs);

  let escalated = false;
  try {
    process.kill(-pid, killSignal);
    escalated = true;
  } catch (err) {
    // The group may have exited cleanly on the polite signal during the grace
    // period — that is the desired outcome, not an error.
    if (err.code !== "ESRCH") {
      return { ok: false, method: "posix-group", pid, error: err.message };
    }
  }

  return { ok: true, method: "posix-group", pid, reaped: true, escalated, graceMs };
}
