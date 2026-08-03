import { execSync } from "node:child_process";
import { normalizePath } from "./config.mjs";

export function git(cmd, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  try {
    return execSync(`git ${cmd}`, {
      cwd,
      encoding: "utf8",
      stdio: opts.stdio || ["ignore", "pipe", "ignore"],
      env: { ...process.env, ...opts.env },
    }).trim();
  } catch (err) {
    if (opts.ignoreError) return "";
    throw err;
  }
}

export function runCmd(cmd, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  try {
    const stdout = execSync(cmd, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
      timeout: opts.timeoutMs || 900000,
    });
    return { stdout: stdout.trim(), stderr: "", status: 0 };
  } catch (err) {
    if (opts.ignoreError) {
      return {
        stdout: err.stdout ? err.stdout.toString().trim() : "",
        stderr: err.stderr ? err.stderr.toString().trim() : err.message,
        status: err.status || 1,
      };
    }
    return {
      stdout: err.stdout ? err.stdout.toString().trim() : "",
      stderr: err.stderr ? err.stderr.toString().trim() : err.message,
      status: err.status || 1,
    };
  }
}

export function showFromOrigin(root, baseRef = "main", filePath = ".agent/config.yml") {
  try {
    return git(`show origin/${baseRef}:${filePath}`, { cwd: root });
  } catch (_) {
    return null;
  }
}

export function changedFiles(root, baseRef = "main") {
  try {
    const raw = git(`diff -z --name-only origin/${baseRef}...HEAD`, { cwd: root });
    if (!raw) return [];
    return raw.split("\0").map(normalizePath).filter(Boolean);
  } catch (_) {
    try {
      const raw = git(`diff -z --name-only ${baseRef}...HEAD`, { cwd: root });
      if (!raw) return [];
      return raw.split("\0").map(normalizePath).filter(Boolean);
    } catch (e) {
      return [];
    }
  }
}

export function diffBytes(root, baseRef = "main") {
  try {
    const diff = git(`diff origin/${baseRef}...HEAD`, { cwd: root });
    return Buffer.byteLength(diff, "utf8");
  } catch (_) {
    try {
      const diff = git(`diff ${baseRef}...HEAD`, { cwd: root });
      return Buffer.byteLength(diff, "utf8");
    } catch (e) {
      return 0;
    }
  }
}

export function diffText(root, baseRef = "main") {
  try {
    return git(`diff origin/${baseRef}...HEAD`, { cwd: root });
  } catch (_) {
    try {
      return git(`diff ${baseRef}...HEAD`, { cwd: root });
    } catch (e) {
      return "";
    }
  }
}

export function worktreeAdd(root, branch, targetDir) {
  return git(`worktree add ${targetDir} -b ${branch}`, { cwd: root });
}

export function worktreeRemove(root, targetDir) {
  return git(`worktree remove --force ${targetDir}`, { cwd: root, ignoreError: true });
}

export function worktreePrune(root) {
  return git("worktree prune", { cwd: root, ignoreError: true });
}
