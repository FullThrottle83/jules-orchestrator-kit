import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { git, changedFiles, diffText } from "../git.mjs";
import { resolveRoot, isWindowsAbsolutePath } from "../config.mjs";

export class CheckpointError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = "CheckpointError";
    this.code = opts.code || 1;
  }
}

// Checkpoint ids are used verbatim as the snapshot filename under
// `.agent/state/checkpoints/`. An id that is not a single plain filename —
// `../…`, `C:\…`, `\\server\share`, or any value carrying a separator — would
// let a restore read (or a create write) outside that directory. Ids are
// therefore restricted to one `[A-Za-z0-9]`-led filename component, and the
// drive/UNC spellings are rejected explicitly on top of the whitelist
// (`SEC-02` / `P-01`).
const CHECKPOINT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeCheckpointId(id) {
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    isWindowsAbsolutePath(id) ||
    !CHECKPOINT_ID_RE.test(id)
  ) {
    throw new CheckpointError(
      `Invalid checkpoint session id '${id}': expected a plain filename (letters, digits, '.', '_', '-') without path separators.`
    );
  }
  return id;
}

/**
 * Ensures checkpoint storage directory exists.
 */
export function getCheckpointDir(root = resolveRoot()) {
  const dir = join(root, ".agent", "state", "checkpoints");
  try {
    mkdirSync(dir, { recursive: true });
  } catch (_) {}
  return dir;
}

/**
 * Creates an atomic pre-flight snapshot of the repository state before an agent task runs.
 * @param {string} sessionId
 * @param {object} options
 * @returns {object} Checkpoint metadata
 */
export function createCheckpoint(sessionId = `session-${Date.now()}`, options = {}) {
  const safeId = assertSafeCheckpointId(sessionId);
  const root = options.root || resolveRoot();
  const dir = getCheckpointDir(root);

  let headSha = "";
  try {
    headSha = git(["rev-parse", "HEAD"], { cwd: root, ignoreError: true }).trim();
  } catch (_) {}

  let branch = "";
  try {
    branch = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, ignoreError: true }).trim();
  } catch (_) {}

  const uncommittedFiles = changedFiles(root, branch || "main", "working-tree");
  const diffContent = diffText(root, branch || "main", "working-tree");

  const snapshot = {
    version: 1,
    id: safeId,
    timestamp: new Date().toISOString(),
    headSha,
    branch,
    uncommittedFiles,
    diffContent,
  };

  const snapshotPath = join(dir, `${safeId}.json`);
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf-8");

  // Keep last 10 checkpoints
  pruneCheckpoints(root, 10);

  return snapshot;
}

/**
 * Restores working tree and git state to a previously saved checkpoint.
 * @param {string} sessionId or '--latest'
 * @param {object} options
 * @returns {object} Restore result summary
 */
export function restoreCheckpoint(sessionId = "--latest", options = {}) {
  const root = options.root || resolveRoot();
  const dir = getCheckpointDir(root);

  let targetId = sessionId;
  if (!targetId || targetId === "--latest" || targetId === "latest") {
    const list = listCheckpoints(root);
    if (list.length === 0) {
      throw new CheckpointError("No checkpoints found to restore.");
    }
    targetId = list[0].id;
  }

  // A caller-supplied id becomes a filename here; reject anything that is not
  // a plain filename before `join` can turn it into a path escape (`P-01`).
  targetId = assertSafeCheckpointId(targetId);

  const snapshotFile = join(dir, `${targetId}.json`);
  if (!existsSync(snapshotFile)) {
    throw new CheckpointError(`Checkpoint snapshot file not found for session '${targetId}'.`);
  }

  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(snapshotFile, "utf-8"));
  } catch (err) {
    throw new CheckpointError(`Corrupted checkpoint file '${targetId}.json': ${err.message}`);
  }

  if (snapshot.headSha) {
    try {
      git(["reset", "--hard", snapshot.headSha], { cwd: root, ignoreError: true });
    } catch (err) {
      throw new CheckpointError(`Failed git reset --hard ${snapshot.headSha}: ${err.message}`);
    }
  }

  // Clean untracked files generated during session
  try {
    git(["clean", "-fd"], { cwd: root, ignoreError: true });
  } catch (_) {}

  return {
    ok: true,
    id: snapshot.id,
    headSha: snapshot.headSha,
    restoredAt: new Date().toISOString(),
  };
}

/**
 * Lists all active checkpoints ordered by timestamp descending.
 */
export function listCheckpoints(root = resolveRoot()) {
  const dir = getCheckpointDir(root);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const items = [];

  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      items.push({
        id: data.id || file.replace(/\.json$/, ""),
        timestamp: data.timestamp || new Date(statSync(filePath).mtimeMs).toISOString(),
        headSha: data.headSha || "",
        branch: data.branch || "",
        filePath,
      });
    } catch (_) {}
  }

  items.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return items;
}

/**
 * Prunes checkpoints keeping only the most recent N sessions.
 */
export function pruneCheckpoints(root = resolveRoot(), maxRetention = 10) {
  const list = listCheckpoints(root);
  if (list.length <= maxRetention) return 0;

  const toRemove = list.slice(maxRetention);
  let prunedCount = 0;

  for (const item of toRemove) {
    try {
      if (existsSync(item.filePath)) {
        rmSync(item.filePath, { force: true });
        prunedCount++;
      }
    } catch (_) {}
  }

  return prunedCount;
}
