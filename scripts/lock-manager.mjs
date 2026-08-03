/**
 * Backward compatibility shim for lock-manager.mjs in v0.9.0.
 * Delegates to src/state.mjs.
 */

import { acquireLock, releaseLock, lockStatus } from "../src/state.mjs";

export function acquire(agent, taskId, filePaths = [], opts = {}) {
  return acquireLock(agent, taskId, filePaths, opts);
}

export function release(agent, taskId, opts = {}) {
  return releaseLock(agent, taskId, opts);
}

export function status(opts = {}) {
  return lockStatus(opts);
}

export function cleanup() {
  return { removed: 0 };
}
