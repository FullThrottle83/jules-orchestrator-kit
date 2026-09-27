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
function isInternalRuntimePath(file) {
  const normalized = String(file || "").replace(/\\/g, "/");
  return (
    normalized === ".agent" ||
    normalized === ".agent/" ||
    normalized.startsWith(".agent/state/") ||
    normalized === ".agent/state" ||
    normalized.startsWith(".agent/handovers/") ||
    normalized === ".agent/handovers"
  );
}

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

  let statusLines = [];
  try {
    const rawStatus = git(["status", "--porcelain=v1", "-uall"], { cwd: root, ignoreError: true });
    statusLines = rawStatus
      ? rawStatus
          .split(/\r?\n/)
          .filter((l) => l.trim().length > 0)
          .filter((l) => !isInternalRuntimePath(l.slice(3).trim()))
      : [];
  } catch (_) {}

  const stagedFiles = [];
  const unstagedFiles = [];
  const untrackedFiles = [];
  for (const line of statusLines) {
    const code = line.slice(0, 2);
    const file = line.slice(3).trim();
    if (code === "??") {
      untrackedFiles.push(file);
    } else {
      if (code[0] !== " ") stagedFiles.push(file);
      if (code[1] !== " ") unstagedFiles.push(file);
    }
  }

  const isClean = statusLines.length === 0;

  const snapshot = {
    version: 2,
    id: safeId,
    timestamp: new Date().toISOString(),
    headSha,
    branch,
    clean: isClean,
    uncommittedFiles,
    diffContent,
    preflight: {
      clean: isClean,
      staged: stagedFiles,
      unstaged: unstagedFiles,
      untracked: untrackedFiles,
    },
  };

  const snapshotPath = join(dir, `${safeId}.json`);
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf-8");

  // Keep last 10 checkpoints
  pruneCheckpoints(root, 10);

  return snapshot;
}

/**
 * Restores working tree and git state to a previously saved checkpoint.
 * Defaults to a non-destructive inspection/preflight that fails closed.
 * Destructive restoration requires explicit authorization via options.force.
 *
 * @param {string} sessionId or '--latest'
 * @param {object} options
 * @param {string} [options.root]
 * @param {boolean} [options.force=false]
 * @param {boolean} [options.checkOnly=false]
 * @returns {object} Restore result or preflight inspection summary
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

  // Inspect current repo state non-destructively
  let currentHeadSha = "";
  try {
    currentHeadSha = git(["rev-parse", "HEAD"], { cwd: root, ignoreError: true }).trim();
  } catch (_) {}

  let currentBranch = "";
  try {
    currentBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, ignoreError: true }).trim();
  } catch (_) {}

  let statusLines = [];
  try {
    const rawStatus = git(["status", "--porcelain=v1", "-uall"], { cwd: root, ignoreError: true });
    statusLines = rawStatus
      ? rawStatus
          .split(/\r?\n/)
          .filter((l) => l.trim().length > 0)
          .filter((l) => !isInternalRuntimePath(l.slice(3).trim()))
      : [];
  } catch (_) {}

  const staged = [];
  const unstaged = [];
  const untracked = [];
  for (const line of statusLines) {
    const code = line.slice(0, 2);
    const file = line.slice(3).trim();
    if (code === "??") {
      untracked.push(file);
    } else {
      if (code[0] !== " ") staged.push(file);
      if (code[1] !== " ") unstaged.push(file);
    }
  }

  const dirty = statusLines.length > 0;
  const refusalReasons = [];

  // Check 1: Missing stored HEAD SHA
  if (!snapshot.headSha) {
    refusalReasons.push(`Checkpoint '${targetId}' is missing recorded HEAD SHA`);
  }

  // Check 2: HEAD drift (new commit or history movement)
  const headDrift = Boolean(snapshot.headSha && currentHeadSha && currentHeadSha !== snapshot.headSha);
  if (headDrift) {
    refusalReasons.push(
      `HEAD has drifted from ${snapshot.headSha.slice(0, 8)} to ${currentHeadSha.slice(0, 8)} (refusing history rewrite)`
    );
  }

  // Check 3: Branch drift
  const branchDrift = Boolean(snapshot.branch && currentBranch && currentBranch !== snapshot.branch);
  if (branchDrift) {
    refusalReasons.push(
      `Branch has drifted from '${snapshot.branch}' to '${currentBranch}'`
    );
  }

  // Check 4: Checkpoint material sufficiency / legacy format
  // Legacy v1 checkpoints or snapshots created on dirty trees lack complete lossless preflight state.
  const isLosslessPreflight = Boolean(
    snapshot.version >= 2 &&
    (snapshot.clean === true || snapshot.preflight?.clean === true) &&
    (!snapshot.uncommittedFiles || snapshot.uncommittedFiles.length === 0) &&
    !snapshot.diffContent
  );
  if (!isLosslessPreflight) {
    refusalReasons.push(
      `Checkpoint '${targetId}' lacks complete lossless preflight state (fail-closed)`
    );
  }

  // Check 5: Untracked files present in working tree
  if (untracked.length > 0) {
    refusalReasons.push(
      `Untracked files are present (${untracked.slice(0, 5).join(", ")}${untracked.length > 5 ? ` and ${untracked.length - 5} more` : ""}); refusing destructive deletion of untracked work`
    );
  }

  const alreadyAtCheckpoint = !headDrift && !branchDrift && !dirty && Boolean(snapshot.headSha);
  const canRestore = !headDrift && !branchDrift && isLosslessPreflight && untracked.length === 0 && Boolean(snapshot.headSha);

  // Check 6: Explicit authorization
  const authorized = Boolean(options.force) && !options.checkOnly;
  if (!authorized) {
    refusalReasons.unshift("Destructive restore requires explicit authorization (--force)");
  }

  // If not authorized or cannot restore safely, refuse without mutating repository
  if (!authorized || !canRestore) {
    return {
      ok: false,
      status: "refused",
      id: snapshot.id,
      headSha: snapshot.headSha,
      branch: snapshot.branch,
      currentHeadSha,
      currentBranch,
      canRestore,
      alreadyAtCheckpoint,
      dirty,
      staged,
      unstaged,
      untracked,
      reason: refusalReasons.join("; "),
      reasons: refusalReasons,
    };
  }

  // Authorized and safe to restore:
  // Preconditions met:
  // - snapshot had verified clean preflight
  // - currentHeadSha === snapshot.headSha (no commits lost)
  // - currentBranch === snapshot.branch
  // - untracked.length === 0 (no untracked files will be deleted)
  // - only tracked files have modifications/staged changes
  try {
    git(["reset", "--hard", snapshot.headSha], { cwd: root });
  } catch (err) {
    throw new CheckpointError(`Failed git reset --hard ${snapshot.headSha}: ${err.message}`);
  }

  // Verify post-restore state
  let postStatus = "";
  try {
    postStatus = git(["status", "--porcelain=v1", "-uall"], { cwd: root }).trim();
  } catch (err) {
    throw new CheckpointError(`Failed to verify repository state after restore: ${err.message}`);
  }

  const postLines = postStatus
    ? postStatus
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0)
        .filter((l) => !isInternalRuntimePath(l.slice(3).trim()))
    : [];

  if (postLines.length > 0) {
    throw new CheckpointError(`Post-restore verification failed: working tree is still dirty (${postLines.join(", ")})`);
  }

  return {
    ok: true,
    status: "restored",
    id: snapshot.id,
    headSha: snapshot.headSha,
    branch: snapshot.branch,
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
