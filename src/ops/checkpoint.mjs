import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, lstatSync } from "node:fs";
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

function safeLstat(targetPath) {
  try {
    return lstatSync(targetPath);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
}

/**
 * Inspects tracked status paths against disk state to identify directories or entities
 * that would obstruct Git from restoring tracked files without data loss.
 *
 * @param {string} root - Repository root
 * @param {string[]} statusLines - Raw porcelain v1 status lines
 * @returns {Array<{ path: string, reason: string }>} Detected path obstructions
 */
export function findPathObstructions(root, statusLines = []) {
  const obstructions = [];
  const seenPaths = new Set();

  for (const line of statusLines) {
    const code = line.slice(0, 2);
    const rawFile = line.slice(3).trim();
    if (code === "??") continue;

    const cleanFile = rawFile.replace(/^"(.*)"$/, "$1");
    const file = cleanFile.includes(" -> ")
      ? cleanFile.split(" -> ").pop().trim().replace(/^"(.*)"$/, "$1")
      : cleanFile;

    const normalizedFile = file.replace(/\\/g, "/");
    const fullTarget = join(root, ...normalizedFile.split("/"));

    const stat = safeLstat(fullTarget);
    if (stat) {
      if (stat.isDirectory()) {
        if (!seenPaths.has(file)) {
          seenPaths.add(file);
          obstructions.push({
            path: file,
            reason: `directory on disk obstructs tracked file '${file}'`,
          });
        }
      } else if (code[0] === "D" || code[1] === "D") {
        if (!seenPaths.has(file)) {
          seenPaths.add(file);
          obstructions.push({
            path: file,
            reason: `local file or entity on disk obstructs deleted tracked file '${file}'`,
          });
        }
      }
    }

    const parts = normalizedFile.split("/").filter(Boolean);
    let currentPrefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      currentPrefix = currentPrefix ? `${currentPrefix}/${parts[i]}` : parts[i];
      const parentTarget = join(root, ...currentPrefix.split("/"));
      const parentStat = safeLstat(parentTarget);
      if (parentStat && !parentStat.isDirectory()) {
        if (!seenPaths.has(currentPrefix)) {
          seenPaths.add(currentPrefix);
          obstructions.push({
            path: currentPrefix,
            reason: `file on disk at '${currentPrefix}' obstructs tracked directory path '${file}'`,
          });
        }
      }
    }
  }

  return obstructions;
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
    headSha = git(["rev-parse", "HEAD"], { cwd: root }).trim();
  } catch (err) {
    throw new CheckpointError(`Failed to determine current HEAD commit: ${err.message}`);
  }
  if (!headSha) {
    throw new CheckpointError("Failed to determine current HEAD commit: git rev-parse returned empty SHA");
  }

  let branch = "";
  try {
    branch = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root }).trim();
  } catch (err) {
    throw new CheckpointError(`Failed to determine current branch: ${err.message}`);
  }
  if (!branch) {
    throw new CheckpointError("Failed to determine current branch: git rev-parse returned empty branch name");
  }

  let rawStatus = "";
  try {
    rawStatus = git(["status", "--porcelain=v1", "-uall"], { cwd: root, raw: true });
  } catch (err) {
    throw new CheckpointError(`Failed to inspect repository status: ${err.message}`);
  }

  const uncommittedFiles = changedFiles(root, branch, "working-tree");
  const diffContent = diffText(root, branch, "working-tree");

  const statusLines = rawStatus
    ? rawStatus
        .split(/\r?\n/)
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0)
    : [];

  const stagedFiles = [];
  const unstagedFiles = [];
  const untrackedFiles = [];
  for (const line of statusLines) {
    const code = line.slice(0, 2);
    const file = line.slice(3).trim();
    if (code === "??") {
      // Untracked internal runtime files (e.g. checkpoint files themselves) are ignored
      if (!isInternalRuntimePath(file)) {
        untrackedFiles.push(file);
      }
    } else {
      // Tracked files under any path (including .agent/) are NEVER ignored
      if (code[0] !== " ") stagedFiles.push(file);
      if (code[1] !== " ") unstagedFiles.push(file);
    }
  }

  const obstructions = findPathObstructions(root, statusLines);

  const isClean =
    stagedFiles.length === 0 &&
    unstagedFiles.length === 0 &&
    untrackedFiles.length === 0 &&
    obstructions.length === 0;

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
      obstructions: obstructions.map((o) => o.path),
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
  let currentBranch = "";
  let gitQueryError = null;
  let rawStatus = "";

  try {
    currentHeadSha = git(["rev-parse", "HEAD"], { cwd: root }).trim();
  } catch (err) {
    gitQueryError = new Error(`Failed to determine current HEAD commit: ${err.message}`);
  }

  try {
    currentBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root }).trim();
  } catch (err) {
    gitQueryError = gitQueryError || new Error(`Failed to determine current branch: ${err.message}`);
  }

  try {
    rawStatus = git(["status", "--porcelain=v1", "-uall"], { cwd: root, raw: true });
  } catch (err) {
    gitQueryError = gitQueryError || new Error(`Failed to inspect repository status: ${err.message}`);
  }

  const statusLines = (rawStatus && !gitQueryError)
    ? rawStatus
        .split(/\r?\n/)
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0)
    : [];

  const staged = [];
  const unstaged = [];
  const untracked = [];
  for (const line of statusLines) {
    const code = line.slice(0, 2);
    const file = line.slice(3).trim();
    if (code === "??") {
      if (!isInternalRuntimePath(file)) {
        untracked.push(file);
      }
    } else {
      if (code[0] !== " ") staged.push(file);
      if (code[1] !== " ") unstaged.push(file);
    }
  }

  const obstructions = (rawStatus && !gitQueryError)
    ? findPathObstructions(root, statusLines)
    : [];

  const dirty =
    Boolean(gitQueryError) ||
    staged.length > 0 ||
    unstaged.length > 0 ||
    untracked.length > 0 ||
    obstructions.length > 0;
  const refusalReasons = [];

  // Check 0: Git query failures or empty live values
  if (gitQueryError) {
    refusalReasons.push(gitQueryError.message);
  }
  if (!currentHeadSha) {
    refusalReasons.push("Cannot determine current HEAD commit (empty SHA)");
  }
  if (!currentBranch) {
    refusalReasons.push("Cannot determine current branch (empty name)");
  }

  // Check 1: Missing stored metadata
  if (!snapshot.headSha) {
    refusalReasons.push(`Checkpoint '${targetId}' is missing recorded HEAD SHA`);
  }
  if (!snapshot.branch) {
    refusalReasons.push(`Checkpoint '${targetId}' is missing recorded branch`);
  }

  // Check 2: HEAD drift (new commit or history movement)
  const headDrift = Boolean(!currentHeadSha || !snapshot.headSha || currentHeadSha !== snapshot.headSha);
  if (snapshot.headSha && currentHeadSha && currentHeadSha !== snapshot.headSha) {
    refusalReasons.push(
      `HEAD has drifted from ${snapshot.headSha.slice(0, 8)} to ${currentHeadSha.slice(0, 8)} (refusing history rewrite)`
    );
  }

  // Check 3: Branch drift
  const branchDrift = Boolean(!currentBranch || !snapshot.branch || currentBranch !== snapshot.branch);
  if (snapshot.branch && currentBranch && currentBranch !== snapshot.branch) {
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

  // Check 6: Path obstructions present on disk
  if (obstructions.length > 0) {
    for (const obs of obstructions) {
      refusalReasons.push(
        `Path obstruction detected: ${obs.reason}; refusing destructive restore to prevent data loss`
      );
    }
  }

  const alreadyAtCheckpoint = !gitQueryError && !headDrift && !branchDrift && !dirty && Boolean(snapshot.headSha);
  const canRestore =
    !gitQueryError &&
    Boolean(currentHeadSha) &&
    Boolean(currentBranch) &&
    Boolean(snapshot.headSha) &&
    Boolean(snapshot.branch) &&
    !headDrift &&
    !branchDrift &&
    isLosslessPreflight &&
    untracked.length === 0 &&
    obstructions.length === 0;

  // Check 7: Explicit authorization
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
      obstructions: obstructions.map((o) => o.path),
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
    postStatus = git(["status", "--porcelain=v1", "-uall"], { cwd: root, raw: true });
  } catch (err) {
    throw new CheckpointError(`Failed to verify repository state after restore: ${err.message}`);
  }

  const postLines = postStatus
    ? postStatus
        .split(/\r?\n/)
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0)
        .filter((l) => {
          const code = l.slice(0, 2);
          const file = l.slice(3).trim();
          return !(code === "??" && isInternalRuntimePath(file));
        })
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
