import { execFileSync } from "node:child_process";
import { sep } from "node:path";

export class GateError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = "GateError";
    this.code = opts.code || 1;
  }
}

function normalizePath(p) {
  if (!p || typeof p !== "string") return "";
  return p.split(sep).join("/").replace(/\\/g, "/");
}

export function runCmd(command, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  try {
    const stdout = execFileSync("sh", ["-c", command], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout: stdout.trim(), stderr: "" };
  } catch (err) {
    if (opts.ignoreError) {
      return {
        status: err.status || 1,
        stdout: (err.stdout || "").toString().trim(),
        stderr: (err.stderr || "").toString().trim(),
      };
    }
    throw err;
  }
}

/**
 * Shell-safe git invoker using direct argument arrays (shell: false).
 */
export function git(args = [], opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const argArray = Array.isArray(args) ? args : String(args).split(" ").filter(Boolean);
  try {
    const stdout = execFileSync("git", argArray, {
      cwd,
      encoding: "utf-8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return opts.raw ? stdout : stdout.trim();
  } catch (err) {
    if (opts.ignoreError) {
      return "";
    }
    const stderr = (err.stderr || err.message || "").toString().trim();
    throw new GateError(`Git command failed [git ${argArray.join(" ")}]: ${stderr}`);
  }
}

export function resolveBase(root = process.cwd(), baseRef = "main") {
  const candidates = [`origin/${baseRef}`, baseRef, `refs/remotes/origin/${baseRef}`, "HEAD"];
  for (const ref of candidates) {
    try {
      const res = execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        cwd: root,
        encoding: "utf-8",
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (res && res.trim()) {
        return ref;
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

export function worktreeAdd(root = process.cwd(), branch = "agent/task", targetDir = "") {
  return git(["worktree", "add", targetDir, "-b", branch], { cwd: root });
}

export function worktreeRemove(root = process.cwd(), targetDir = "") {
  return git(["worktree", "remove", targetDir, "--force"], { cwd: root });
}

export function worktreePrune(root = process.cwd()) {
  return git(["worktree", "prune"], { cwd: root });
}
