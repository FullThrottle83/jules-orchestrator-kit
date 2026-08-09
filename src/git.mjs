import { execFileSync } from "node:child_process";
import { normalizePath } from "./config.mjs";
import { journalIntent, journalDone } from "./journal.mjs";

export const NET_GUARD_PRELOAD_URL = new URL("./preload-net-guard.mjs", import.meta.url).href;
export const NET_GUARD_FLAG = `--import ${NET_GUARD_PRELOAD_URL}`;

export class GateError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = "GateError";
    this.code = opts.code || 1;
  }
}

const DEFAULT_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

export function runCmd(command, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const timeout = opts.timeout || DEFAULT_TIMEOUT;
  const maxBuffer = opts.maxBuffer || DEFAULT_MAX_BUFFER;

  let binary = "";
  let args = [];

  if (Array.isArray(command)) {
    binary = command[0];
    args = command.slice(1);
  } else if (typeof command === "string") {
    const tokens = command.trim().split(/\s+/).filter(Boolean);
    binary = tokens[0] || "";
    args = tokens.slice(1);
  }

  if (!binary) {
    if (opts.ignoreError) return { status: 0, stdout: "", stderr: "" };
    throw new GateError("Empty command provided");
  }

  try {
    const stdout = execFileSync(binary, args, {
      cwd,
      encoding: "utf-8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env || process.env,
      timeout,
      maxBuffer,
    });
    return { status: 0, stdout: stdout.trim(), stderr: "" };
  } catch (err) {
    const isTimeout = err.code === "ETIMEDOUT" || (err.signal === "SIGTERM" && err.killed);
    const isNobufs = err.code === "ENOBUFS" || (err.message && err.message.includes("maxBuffer"));

    const status = err.status || (isTimeout ? 124 : 1);
    let stdout = (err.stdout || "").toString().trim();
    let stderr = (err.stderr || err.message || "").toString().trim();

    if (isTimeout && !stderr.includes("ETIMEDOUT")) {
      stderr = `Command execution timed out after ${timeout}ms (ETIMEDOUT)${stderr ? "\n" + stderr : ""}`;
    }
    if (isNobufs && !stderr.includes("ENOBUFS")) {
      stderr = `Command output buffer exceeded limit of ${maxBuffer} bytes (ENOBUFS)${stderr ? "\n" + stderr : ""}`;
    }

    if (opts.ignoreError) {
      return { status, stdout, stderr };
    }

    if (isTimeout) {
      throw new GateError(`Command execution timed out (ETIMEDOUT): ${binary}`, { code: status });
    }
    if (isNobufs) {
      throw new GateError(`Command output buffer exceeded limit (ENOBUFS): ${binary}`, { code: status });
    }

    throw err;
  }
}

/**
 * Shell-safe git invoker using direct argument arrays (shell: false).
 */
export function git(args = [], opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const timeout = opts.timeout || DEFAULT_TIMEOUT;
  const maxBuffer = opts.maxBuffer || DEFAULT_MAX_BUFFER;
  const argArray = Array.isArray(args) ? args : String(args).split(" ").filter(Boolean);

  try {
    const stdout = execFileSync("git", argArray, {
      cwd,
      encoding: "utf-8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      maxBuffer,
    });
    return opts.raw ? stdout : stdout.trim();
  } catch (err) {
    if (opts.ignoreError) {
      return "";
    }
    const isTimeout = err.code === "ETIMEDOUT" || (err.signal === "SIGTERM" && err.killed);
    const isNobufs = err.code === "ENOBUFS" || (err.message && err.message.includes("maxBuffer"));
    const stderr = (err.stderr || err.message || "").toString().trim();

    if (isTimeout) {
      throw new GateError(`Git command timed out [git ${argArray.join(" ")}]: ETIMEDOUT`, { code: 124 });
    }
    if (isNobufs) {
      throw new GateError(`Git command output buffer exceeded limit [git ${argArray.join(" ")}]: ENOBUFS`, { code: 1 });
    }

    throw new GateError(`Git command failed [git ${argArray.join(" ")}]: ${stderr}`);
  }
}

export function resolveBase(root = process.cwd(), baseRef = "main") {
  const candidates = [`origin/${baseRef}`, `refs/remotes/origin/${baseRef}`, baseRef];
  for (const ref of candidates) {
    try {
      const res = execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        cwd: root,
        encoding: "utf-8",
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (res && res.trim()) {
        return res.trim();
      }
    } catch (_) {}
  }
  throw new GateError(
    `Cannot resolve base reference "${baseRef}". Ensure base branch is fetched (e.g., fetch-depth: 0 in CI).`,
    { code: 1 }
  );
}

export function changedFiles(root = process.cwd(), base = "main") {
  const resolvedRef = resolveBase(root, base);
  const raw = git(["-c", "core.quotePath=false", "diff", "-z", "--name-only", `${resolvedRef}...HEAD`], {
    cwd: root,
    raw: true,
  });
  return raw
    .split("\0")
    .map(normalizePath)
    .filter(Boolean);
}

export function diffBytes(root = process.cwd(), base = "main") {
  const resolvedRef = resolveBase(root, base);
  const raw = git(["diff", "--shortstat", `${resolvedRef}...HEAD`], { cwd: root });
  if (!raw) return 0;
  const diffStr = git(["diff", `${resolvedRef}...HEAD`], { cwd: root, raw: true });
  return Buffer.byteLength(diffStr, "utf-8");
}

export function diffText(root = process.cwd(), base = "main") {
  const resolvedRef = resolveBase(root, base);
  return git(["diff", `${resolvedRef}...HEAD`], { cwd: root, raw: true });
}

export function showFromOrigin(root = process.cwd(), base = "main", filePath = "") {
  const resolvedRef = resolveBase(root, base);
  const normPath = normalizePath(filePath);
  try {
    return git(["show", `${resolvedRef}:${normPath}`], { cwd: root, raw: true });
  } catch (_) {
    return null;
  }
}

export function createBranch(root = process.cwd(), branch = "") {
  const opId = journalIntent(root, { type: "create_branch", branch, targetPath: "" });
  try {
    const res = git(["branch", branch], { cwd: root });
    journalDone(root, opId);
    return res;
  } catch (err) {
    journalDone(root, opId);
    throw err;
  }
}

export function worktreeAdd(root = process.cwd(), branch = "agent/task", targetDir = "") {
  const opId = journalIntent(root, { type: "worktree_add", targetPath: targetDir, branch });
  try {
    const res = git(["worktree", "add", targetDir, "-b", branch], { cwd: root });
    journalDone(root, opId);
    return res;
  } catch (err) {
    journalDone(root, opId);
    throw err;
  }
}

export function worktreeRemove(root = process.cwd(), targetDir = "") {
  return git(["worktree", "remove", targetDir, "--force"], { cwd: root });
}

export function worktreePrune(root = process.cwd()) {
  return git(["worktree", "prune"], { cwd: root });
}
