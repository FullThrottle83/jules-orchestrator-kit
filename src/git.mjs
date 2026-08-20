import { execFileSync, execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { normalizePath } from "./config.mjs";


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
  let useShell = false;
  let shellCmd = "";

  if (Array.isArray(command)) {
    binary = command[0];
    args = command.slice(1);
  } else if (typeof command === "string") {
    const trimmed = command.trim();
    if (/[\&\|\>\<\$\"\'\n\;]/.test(trimmed)) {
      useShell = true;
      shellCmd = trimmed;
    } else {
      const tokens = trimmed.split(/\s+/).filter(Boolean);
      binary = tokens[0] || "";
      args = tokens.slice(1);
    }
  }

  if (!binary && !useShell) {
    if (opts.ignoreError) return { status: 0, stdout: "", stderr: "" };
    throw new GateError("Empty command provided");
  }

  try {
    const stdout = useShell
      ? execSync(shellCmd, {
          cwd,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
          env: opts.env || process.env,
          timeout,
          maxBuffer,
        })
      : execFileSync(binary, args, {
          cwd,
          encoding: "utf-8",
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          env: opts.env || process.env,
          timeout,
          maxBuffer,
        });

    return { status: 0, stdout: String(stdout || "").trim(), stderr: "" };
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
      throw new GateError(`Command execution timed out (ETIMEDOUT): ${useShell ? shellCmd : binary}`, { code: status });
    }
    if (isNobufs) {
      throw new GateError(`Command output buffer exceeded limit (ENOBUFS): ${useShell ? shellCmd : binary}`, { code: status });
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

export function ensureBaseFetched(root = process.cwd(), baseRef = "main") {
  try {
    execFileSync("git", ["fetch", "origin", baseRef, "--depth=100"], {
      cwd: root,
      encoding: "utf-8",
      shell: false,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch (_) {
    try {
      execFileSync("git", ["fetch", "origin", baseRef, "--unshallow"], {
        cwd: root,
        encoding: "utf-8",
        shell: false,
        stdio: ["ignore", "ignore", "ignore"],
      });
      return true;
    } catch (_) {
      return false;
    }
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

  ensureBaseFetched(root, baseRef);

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

export function changedFiles(root = process.cwd(), base = "main", mode = "committed") {
  const resolvedRef = resolveBase(root, base);
  if (mode === "working-tree" || mode === "working") {
    const committedRaw = git(["-c", "core.quotePath=false", "diff", "-z", "--name-only", `${resolvedRef}...HEAD`], { cwd: root, raw: true, ignoreError: true }) || "";
    const uncommittedRaw = git(["-c", "core.quotePath=false", "diff", "-z", "--name-only", "HEAD"], { cwd: root, raw: true, ignoreError: true }) || "";
    const untrackedRaw = git(["-c", "core.quotePath=false", "ls-files", "-z", "--others", "--exclude-standard"], { cwd: root, raw: true, ignoreError: true }) || "";

    const set = new Set([
      ...committedRaw.split("\0").map(normalizePath).filter(Boolean),
      ...uncommittedRaw.split("\0").map(normalizePath).filter(Boolean),
      ...untrackedRaw.split("\0").map(normalizePath).filter(Boolean),
    ]);
    return Array.from(set);
  } else if (mode === "staged" || mode === "index") {
    const raw = git(["-c", "core.quotePath=false", "diff", "-z", "--name-only", "--cached", resolvedRef], { cwd: root, raw: true });
    return raw.split("\0").map(normalizePath).filter(Boolean);
  } else {
    const raw = git(["-c", "core.quotePath=false", "diff", "-z", "--name-only", `${resolvedRef}...HEAD`], { cwd: root, raw: true });
    return raw.split("\0").map(normalizePath).filter(Boolean);
  }
}

export function diffText(root = process.cwd(), base = "main", mode = "committed") {
  const resolvedRef = resolveBase(root, base);
  if (mode === "working-tree" || mode === "working") {
    const committed = git(["diff", `${resolvedRef}...HEAD`], { cwd: root, raw: true, ignoreError: true }) || "";
    const uncommitted = git(["diff", "HEAD"], { cwd: root, raw: true, ignoreError: true }) || "";

    const untrackedRaw = git(["-c", "core.quotePath=false", "ls-files", "-z", "--others", "--exclude-standard"], { cwd: root, raw: true, ignoreError: true }) || "";
    const untrackedFiles = untrackedRaw.split("\0").map(normalizePath).filter(Boolean);
    let untrackedDiff = "";
    for (const file of untrackedFiles) {
      try {
        const fullPath = join(root, file);
        if (existsSync(fullPath)) {
          const content = readFileSync(fullPath, "utf-8");
          untrackedDiff += `\ndiff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n`;
          untrackedDiff += content.split("\n").map((line) => `+${line}`).join("\n") + "\n";
        }
      } catch (_) {}
    }
    return [committed, uncommitted, untrackedDiff].filter(Boolean).join("\n");
  }
  return git(["diff", `${resolvedRef}...HEAD`], { cwd: root, raw: true });
}

export function diffBytes(root = process.cwd(), base = "main", mode = "committed") {
  const text = diffText(root, base, mode);
  return Buffer.byteLength(text, "utf-8");
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


export function worktreeRemove(root = process.cwd(), targetDir = "") {
  return git(["worktree", "remove", targetDir, "--force"], { cwd: root });
}

export function worktreePrune(root = process.cwd()) {
  return git(["worktree", "prune"], { cwd: root });
}
