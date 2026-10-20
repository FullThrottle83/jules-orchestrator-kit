import { execFileSync, spawnSync } from "node:child_process";
import { killProcessTree } from "./process-tree.mjs";
import { readFileSync, existsSync, statSync, lstatSync, readlinkSync, mkdtempSync, rmSync, symlinkSync, readdirSync, mkdirSync, openSync, readSync, closeSync } from "node:fs";
import { join, delimiter, relative, dirname } from "node:path";
import { tmpdir } from "node:os";
import { normalizePath, canonicalizePath } from "./config.mjs";


export const NET_GUARD_PRELOAD_URL = new URL("./preload-net-guard.mjs", import.meta.url).href;
export const NET_GUARD_FLAG = `--import ${NET_GUARD_PRELOAD_URL}`;

/**
 * Constructs an isolated, platform-aware execution environment for verification subprocesses (P0-11).
 *
 * Untrusted candidate code or repository verification commands must NOT inherit ambient
 * host, operator, cloud, or CI credentials. This helper builds an environment starting
 * from an empty object ({}) and populating ONLY explicitly allowed execution primitives
 * required for reliable operation across Linux, macOS, and Windows.
 *
 * Scope boundary:
 * P0-11 prevents inheritance of HOME/USERPROFILE environment variables.
 * It does NOT prevent repository code from discovering an OS account home
 * directory through APIs such as os.homedir(), nor does it provide filesystem
 * sandboxing.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.ambientEnv] - Source environment to read baseline from (defaults to process.env)
 * @param {NodeJS.Platform} [opts.platform] - Platform to target (defaults to process.platform)
 * @param {boolean} [opts.netGuard] - Inject preload network guard in NODE_OPTIONS
 * @param {string} [opts.home] - Optional explicit home directory to set in HOME/USERPROFILE env vars
 * @param {Record<string, string>} [opts.extraEnv] - Trusted JOK-controlled environment variables to merge
 * @returns {Record<string, string>}
 */
export function buildVerificationEnv(opts = {}) {
  const ambient = opts.ambientEnv || process.env;
  const platform = opts.platform || process.platform;
  const isWin = platform === "win32";

  const env = {};

  function findAmbientKey(targetName) {
    const targetUpper = targetName.toUpperCase();
    for (const k of Object.keys(ambient)) {
      if (k.toUpperCase() === targetUpper && ambient[k] !== undefined) {
        return ambient[k];
      }
    }
    return undefined;
  }

  if (isWin) {
    const p = findAmbientKey("PATH");
    env.PATH = p !== undefined ? String(p) : "";
    const sr = findAmbientKey("SYSTEMROOT");
    env.SystemRoot = sr !== undefined ? String(sr) : "C:\\Windows";
    const cs = findAmbientKey("COMSPEC");
    env.ComSpec = cs !== undefined ? String(cs) : "C:\\Windows\\system32\\cmd.exe";
    const pe = findAmbientKey("PATHEXT");
    env.PATHEXT = pe !== undefined ? String(pe) : ".COM;.EXE;.BAT;.CMD";
    const wd = findAmbientKey("WINDIR");
    if (wd !== undefined) env.WINDIR = String(wd);
    const sd = findAmbientKey("SYSTEMDRIVE");
    env.SystemDrive = sd !== undefined ? String(sd) : "C:";
    const temp = findAmbientKey("TEMP");
    if (temp !== undefined) env.TEMP = String(temp);
    const tmp = findAmbientKey("TMP");
    if (tmp !== undefined) env.TMP = String(tmp);
  } else {
    if (ambient.PATH !== undefined) env.PATH = String(ambient.PATH);
    else env.PATH = "/usr/local/bin:/usr/bin:/bin";
    if (ambient.TMPDIR !== undefined) env.TMPDIR = String(ambient.TMPDIR);
    else env.TMPDIR = "/tmp";
    if (ambient.TEMP !== undefined) env.TEMP = String(ambient.TEMP);
    if (ambient.TMP !== undefined) env.TMP = String(ambient.TMP);
  }

  const lang = findAmbientKey("LANG");
  if (lang !== undefined) env.LANG = String(lang);
  const lcAll = findAmbientKey("LC_ALL");
  if (lcAll !== undefined) env.LC_ALL = String(lcAll);
  const lcCtype = findAmbientKey("LC_CTYPE");
  if (lcCtype !== undefined) env.LC_CTYPE = String(lcCtype);
  const term = findAmbientKey("TERM");
  if (term !== undefined) env.TERM = String(term);

  // Only explicitly trusted toolchain variables can cross into verification.
  // Arbitrary ambient names and provider/cloud credentials stay excluded.
  const toolchainVars = new Set([
    "JAVA_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT", "SDKROOT",
    "CARGO_HOME", "RUSTUP_HOME", "GOPATH", "GOROOT", "VIRTUAL_ENV",
  ]);
  for (const requested of Array.isArray(opts.passEnv) ? opts.passEnv : []) {
    if (typeof requested !== "string") continue;
    const key = requested.toUpperCase();
    if (!toolchainVars.has(key)) continue;
    const value = findAmbientKey(key);
    if (value !== undefined) env[key] = String(value);
  }

  env.CI = "true";
  const nodeEnv = findAmbientKey("NODE_ENV");
  if (nodeEnv !== undefined) env.NODE_ENV = String(nodeEnv);

  if (opts.netGuard) {
    env.NODE_OPTIONS = NET_GUARD_FLAG;
  }

  if (opts.home) {
    env.HOME = String(opts.home);
    if (isWin) env.USERPROFILE = String(opts.home);
  }

  if (opts.extraEnv && typeof opts.extraEnv === "object") {
    for (const [k, v] of Object.entries(opts.extraEnv)) {
      if (v !== undefined && v !== null) {
        env[k] = String(v);
      }
    }
  }

  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_CHANNEL_FD;
  delete env.PR_LABELS;
  delete env.HEAD_SHA;
  delete env.BASE_SHA;
  delete env.JULES_BASE_SHA;
  for (const k of Object.keys(env)) {
    if (
      k.startsWith("JULES_ALLOW_") ||
      k.startsWith("AGENT_ALLOW_") ||
      k.startsWith("NODE_TEST_") ||
      k.startsWith("NODE_CHANNEL_")
    ) {
      delete env[k];
    }
  }

  return env;
}

export class GateError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = "GateError";
    this.code = opts.code || 1;
  }
}

// `NAME=value` at the head of a command line: a POSIX environment prefix,
// not the name of a program.
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Checks whether an environment variable key is reserved for JOK security/control
 * and cannot be set or overridden by candidate command prefixes (P0-11).
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isReservedVerificationKey(key) {
  if (!key || typeof key !== "string") return false;
  const upper = key.toUpperCase();
  if (
    upper === "NODE_OPTIONS" ||
    upper === "CI" ||
    upper === "PR_LABELS" ||
    upper === "HEAD_SHA" ||
    upper === "BASE_SHA" ||
    upper === "JULES_BASE_SHA" ||
    upper === "HOME" ||
    upper === "USERPROFILE"
  ) {
    return true;
  }
  if (
    upper.startsWith("JULES_ALLOW_") ||
    upper.startsWith("AGENT_ALLOW_") ||
    upper.startsWith("NODE_TEST_") ||
    upper.startsWith("NODE_CHANNEL_")
  ) {
    return true;
  }
  return false;
}

const DEFAULT_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

// Windows cmd.exe quoting. `.cmd`/`.bat` shims (npm.cmd, claude.cmd, …) cannot
// be spawned by CreateProcess, so they must run through cmd.exe, and the
// command line cmd.exe sees must round-trip every argv element exactly. The
// rules below follow the C runtime's argument parser and cmd.exe's meta-char
// escaping — the same algorithm cross-spawn uses — reimplemented here so the
// kit stays dependency-free.

// Characters cmd.exe treats specially outside double quotes.
const WINDOWS_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;
// A real Windows executable, which CreateProcess can start without a shell.
const WINDOWS_NATIVE_EXE = /\.(?:com|exe)$/i;
// An npm-style cmd shim, which re-parses its own arguments and therefore needs
// its meta chars double-escaped.
const WINDOWS_CMD_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

/** Escapes cmd.exe meta characters in a command *name*. */
export function windowsEscapeCommand(command) {
  return String(command).replace(WINDOWS_META_CHARS, "^$1");
}

/**
 * Quotes a single argv element for cmd.exe.
 *
 * @param {string} arg
 * @param {boolean} [doubleEscapeMetaChars] true when the command is a cmd-shim
 *   that will re-parse its own arguments (node_modules/.bin/*.cmd).
 * @returns {string}
 */
export function windowsEscapeArgument(arg, doubleEscapeMetaChars = false) {
  let ret = String(arg);
  // Backslash runs immediately before a double quote: double the backslashes
  // and escape the quote.
  ret = ret.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  // A backslash run at the very end will sit in front of the closing quote we
  // add next: double it so it stays literal.
  ret = ret.replace(/(?=(\\+?)?)\1$/, "$1$1");
  ret = `"${ret}"`;
  ret = ret.replace(WINDOWS_META_CHARS, "^$1");
  if (doubleEscapeMetaChars) ret = ret.replace(WINDOWS_META_CHARS, "^$1");
  return ret;
}

/**
 * Resolves `binary` against PATH + PATHEXT on Windows.
 *
 * @param {string} binary
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null}
 */
function resolveWindowsCommand(binary, env) {
  const pathExt = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim()).filter(Boolean);
  const hasSeparator = /[\\/]/.test(binary) || /^[A-Za-z]:/.test(binary);

  const candidates = [];
  if (hasSeparator) {
    candidates.push(binary);
    for (const ext of pathExt) candidates.push(binary + ext);
  } else {
    const dirs = (env.PATH || "").split(delimiter).filter(Boolean);
    for (const dir of dirs) {
      for (const ext of pathExt) candidates.push(join(dir, binary + ext));
      candidates.push(join(dir, binary));
    }
  }

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch (_) {}
  }
  return null;
}

/**
 * Builds the spawn arguments that correctly execute `binary` with `args` on
 * Windows, handling the `.cmd`/`.bat` shims package managers and CLI providers
 * install. Returns null on non-Windows so callers keep spawning the binary
 * directly (`P-07`).
 *
 * @param {string} binary
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {{ file: string, args: string[], verbatim: boolean } | null}
 */
export function resolveWindowsSpawn(binary, args, env = process.env, platform = process.platform) {
  if (platform !== "win32") return null;

  const argArray = (args || []).map((a) => String(a));
  const resolved = resolveWindowsCommand(binary, env);

  // A native executable is spawned directly — its argv needs no quoting.
  if (resolved && WINDOWS_NATIVE_EXE.test(resolved)) {
    return { file: resolved, args: argArray, verbatim: false };
  }

  // Everything else (`.cmd`, `.bat`, or an unresolved name) goes through
  // cmd.exe. The `/s /c` invocation plus one outer quote pair is the shape
  // cmd.exe expects so the pre-quoted argv parses back into the same elements.
  const commandName = resolved || binary;
  const doubleEscape = WINDOWS_CMD_SHIM.test(resolved || commandName);
  const shellCommand = [windowsEscapeCommand(commandName)]
    .concat(argArray.map((a) => windowsEscapeArgument(a, doubleEscape)))
    .join(" ");

  return {
    file: (env && env.ComSpec) || "cmd.exe",
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
    verbatim: true,
  };
}

export function runCmd(command, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const timeout = opts.timeout || DEFAULT_TIMEOUT;
  const maxBuffer = opts.maxBuffer || DEFAULT_MAX_BUFFER;

  let binary = "";
  let args = [];
  let useShell = false;
  let shellCmd = "";
  /** @type {Record<string,string>|null} */
  let envOverlay = null;
  // True when `args` came from splitting a whitespace-separated string, which
  // means no element can itself contain whitespace. See the Windows note below.
  let tokenized = false;

  if (Array.isArray(command)) {
    binary = command[0];
    args = command.slice(1);
  } else if (typeof command === "string") {
    const trimmed = command.trim();
    if (/[\&\|\>\<\$\"\'\n\;]/.test(trimmed)) {
      // For commands containing shell metacharacters, execution is delegated to the system shell
      // (sh on POSIX, cmd.exe on Windows). The shell receives `childEnv` (opts.env || process.env).
      // Note: P0-11 isolates the initial environment variables passed into the verification process.
      // It is not a process sandbox: untrusted code executing arbitrary shell scripts can invoke its
      // own child commands or modify its own local environment. The invariant enforced here is that
      // JOK never leaks ambient operator secrets into `opts.env`, and JOK's command-prefix parsing
      // never allows candidate-controlled assignments to overwrite JOK security controls.
      useShell = true;
      shellCmd = trimmed;
    } else {
      const tokens = trimmed.split(/\s+/).filter(Boolean);

      // A POSIX command may be prefixed with environment assignments, and
      // half the Python world writes its test command exactly that way:
      // `PYTHONPATH=src python3 -m pytest`. execFileSync took the first token
      // as the program and failed with `spawnSync PYTHONPATH=src ENOENT` —
      // which the gate then reported as a failed verification, so the user
      // was told their tests broke when the command had never started.
      //
      // Peeling the assignments into the child's environment behaves the same
      // on every platform. Handing the string to a shell would not: cmd.exe
      // has no such syntax, so the Windows matrix would keep failing.
      //
      // Security contract (P0-11): Command prefixes may introduce ordinary
      // task-local compatibility variables (e.g. PYTHONPATH=src, PORT=3000),
      // but must NEVER be permitted to override JOK-owned security/control
      // variables (NODE_OPTIONS, CI, PR_LABELS, gate waivers, HOME, etc.).
      // Reserved keys are stripped from argv but ignored from envOverlay.
      while (tokens.length > 1 && ENV_ASSIGNMENT.test(tokens[0])) {
        const token = tokens.shift();
        const eq = token.indexOf("=");
        const key = token.slice(0, eq);
        const val = token.slice(eq + 1);
        if (!isReservedVerificationKey(key)) {
          if (!envOverlay) envOverlay = {};
          envOverlay[key] = val;
        }
      }

      binary = tokens[0] || "";
      args = tokens.slice(1);
      tokenized = true;
    }
  }

  // Every package-manager entry point on Windows is a `.cmd` shim, and
  // execFileSync cannot spawn one directly. `npm test` — the kit's own default
  // verify command — therefore failed with `spawnSync npm ENOENT` on every
  // Windows install, and the gate reported it as a plain non-zero verification
  // rather than as an environment problem.
  //
  // A whitespace-split string command is re-run under `shell: true`: Node
  // rebuilds the command line as `[file, ...args].join(" ")` and passes it to
  // cmd.exe verbatim. That reconstruction is normally lossy — it does not quote
  // an argument containing a space — but it is exact here, because these tokens
  // were produced by splitting on whitespace in the first place, and none of
  // them can contain a shell metacharacter (those took the execSync branch).
  //
  // An *array* command cannot use that trick: its elements may legitimately
  // contain spaces, so the same join would corrupt argv. Arrays are therefore
  // wrapped in cmd.exe with every element quoted per the C-runtime + cmd.exe
  // rules, which preserves argv exactly while still letting the shell resolve
  // the `.cmd` shim (P-07).
  const childEnv = envOverlay ? { ...(opts.env || process.env), ...envOverlay } : opts.env || process.env;

  const winShim = tokenized && process.platform === "win32";
  const winSpawn =
    !useShell && !winShim && process.platform === "win32"
      ? resolveWindowsSpawn(binary, args, childEnv)
      : null;

  if (!binary && !useShell) {
    if (opts.ignoreError) return { status: 0, stdout: "", stderr: "" };
    throw new GateError("Empty command provided");
  }

  // On POSIX, detach so the child becomes its own process-group leader. Then a
  // timed-out kill can signal the whole group (`kill(-pid)`) and reap workers
  // spawned by the command. Windows omits detached: taskkill /T walks the tree
  // without a separate group, and detached consoles behave differently under
  // cmd.exe / CreateProcess.
  const posixDetach = process.platform !== "win32";

  try {
    const ret = useShell
      ? spawnSync(shellCmd, {
          cwd,
          encoding: "utf-8",
          shell: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: childEnv,
          timeout,
          maxBuffer,
          ...(posixDetach ? { detached: true } : {}),
        })
      : spawnSync(winSpawn ? winSpawn.file : binary, winSpawn ? winSpawn.args : args, {
          cwd,
          encoding: "utf-8",
          shell: winShim,
          windowsVerbatimArguments: Boolean(winSpawn && winSpawn.verbatim),
          stdio: ["ignore", "pipe", "pipe"],
          env: childEnv,
          timeout,
          maxBuffer,
          ...(posixDetach ? { detached: true } : {}),
        });

    const isTimeout = Boolean(ret.error && (ret.error.code === "ETIMEDOUT" || (ret.signal === "SIGTERM" && ret.error.killed)));
    // Node's spawnSync timeout kills only the direct child; reap the tree so
    // background workers do not linger (ROADMAP_V1 reliability item).
    if (isTimeout && ret.pid) {
      killProcessTree(ret.pid);
    }
    const isNobufs = Boolean(ret.error && (ret.error.code === "ENOBUFS" || (ret.error.message && ret.error.message.includes("maxBuffer"))));

    const status = typeof ret.status === "number" ? ret.status : (isTimeout ? 124 : 1);
    let stdout = (ret.stdout || "").toString().trim();
    let stderr = (ret.stderr || (ret.error && ret.error.message) || "").toString().trim();

    if (isTimeout) {
      stderr =
        `Command execution timed out after ${timeout}ms (ETIMEDOUT). ` +
        `The command was killed, not failed: raise verify.timeout_ms in ` +
        `.agent/config.yml if this suite legitimately takes longer.` +
        (stderr ? "\n" + stderr : "");
    }
    if (isNobufs && !stderr.includes("ENOBUFS")) {
      stderr = `Command output buffer exceeded limit of ${maxBuffer} bytes (ENOBUFS)${stderr ? "\n" + stderr : ""}`;
    }

    if (ret.error || status !== 0) {
      if (opts.ignoreError) {
        return { status, stdout, stderr };
      }

      if (isTimeout) {
        throw new GateError(`Command execution timed out (ETIMEDOUT): ${useShell ? shellCmd : binary}`, { code: status });
      }
      if (isNobufs) {
        throw new GateError(`Command output buffer exceeded limit (ENOBUFS): ${useShell ? shellCmd : binary}`, { code: status });
      }

      const err = ret.error || new Error(`Command failed with status ${status}: ${useShell ? shellCmd : binary}`);
      err.status = status;
      err.code = status;
      err.stdout = stdout;
      err.stderr = stderr;
      throw err;
    }

    return { status: 0, stdout, stderr };
  } catch (err) {
    if (opts.ignoreError && !(err instanceof GateError)) {
      return { status: err.status || 1, stdout: (err.stdout || "").toString().trim(), stderr: (err.stderr || err.message || "").toString().trim() };
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
  if (!baseRef || typeof baseRef !== "string" || baseRef.startsWith("-") || !/^[A-Za-z0-9._/-]+$/.test(baseRef)) {
    return false;
  }
  try {
    execFileSync("git", ["fetch", "origin", "--", baseRef, "--depth=100"], {
      cwd: root,
      encoding: "utf-8",
      shell: false,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch (_) {
    try {
      execFileSync("git", ["fetch", "origin", "--", baseRef, "--unshallow"], {
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

export function resolveBase(root = process.cwd(), baseRef = "main", opts = {}) {
  if (!baseRef || typeof baseRef !== "string" || baseRef.startsWith("-")) {
    throw new GateError(
      `Cannot resolve base reference "${baseRef}". Ensure base branch is fetched (e.g., fetch-depth: 0 in CI).`,
      { code: 1 }
    );
  }
  const allowFetch = opts.allowFetch !== false;
  const isCommitSha = typeof baseRef === "string" && /^[0-9a-f]{40}$/i.test(baseRef);
  const isHeadRef = typeof baseRef === "string" && (baseRef === "HEAD" || baseRef.startsWith("HEAD~") || baseRef.startsWith("HEAD^") || baseRef.startsWith("HEAD@"));
  const candidates = isHeadRef || isCommitSha
    ? [baseRef]
    : [`origin/${baseRef}`, `refs/remotes/origin/${baseRef}`, baseRef];
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

  if (!isHeadRef && !isCommitSha && allowFetch) {
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
  }

  if (isCommitSha) {
    throw new GateError(
      `Cannot resolve base commit SHA "${baseRef}". Object does not exist locally. Fetch the required commit history before verification.`,
      { code: 1 }
    );
  }

  throw new GateError(
    `Cannot resolve base reference "${baseRef}". Ensure base branch is fetched (e.g., fetch-depth: 0 in CI).`,
    { code: 1 }
  );
}

export function getCommitSha(root = process.cwd(), ref = "HEAD") {
  if (!ref || typeof ref !== "string" || ref.startsWith("-")) return null;
  try {
    const res = execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: root,
      encoding: "utf-8",
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return res && res.trim() ? res.trim() : null;
  } catch (_) {
    return null;
  }
}

export function getCommitParent(root = process.cwd(), ref = "HEAD") {
  if (!ref || typeof ref !== "string" || ref.startsWith("-")) return null;
  try {
    const res = execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}~1^{commit}`], {
      cwd: root,
      encoding: "utf-8",
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return res && res.trim() ? res.trim() : null;
  } catch (_) {
    return null;
  }
}

export function getHeadCommit(root = process.cwd()) {
  return getCommitSha(root, "HEAD");
}

export function getHeadParent(root = process.cwd()) {
  return getCommitParent(root, "HEAD");
}

export const PINNED_DIFF_CONFIG = Object.freeze([
  "-c", "core.quotePath=false",
  "-c", "diff.external=",
]);

export const PINNED_DIFF_FLAGS = Object.freeze([
  "--text",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--no-renames",
  "--src-prefix=a/",
  "--dst-prefix=b/",
]);

export function resolveDiffRange(root = process.cwd(), base = "main", mode = "committed", head = "HEAD") {
  const targetHead = head || "HEAD";
  if (typeof targetHead !== "string" || targetHead.startsWith("-")) {
    throw new GateError(`Invalid head reference "${targetHead}".`, { code: 1 });
  }
  const allowFetch = mode !== "committed";
  const resolvedRef = resolveBase(root, base, { allowFetch });
  const headCommit = getCommitSha(root, targetHead);
  const isHeadRef = typeof base === "string" && (base === targetHead || base === "HEAD" || base.startsWith("HEAD~") || base.startsWith("HEAD^") || base.startsWith("HEAD@"));
  const isBaseAtHead = Boolean(mode === "committed" && !isHeadRef && headCommit && resolvedRef === headCommit);
  const headParent = isBaseAtHead ? getCommitParent(root, targetHead) : null;

  return Object.freeze({
    root,
    base,
    mode,
    head: targetHead,
    resolvedRef,
    headCommit,
    isHeadRef,
    isBaseAtHead,
    headParent,
  });
}

export function changedFiles(root = process.cwd(), base = "main", mode = "committed", head = "HEAD") {
  const rawEntries = parseRawDiff(root, base, mode, head);
  const files = new Set(rawEntries.map((e) => e.file).filter(Boolean));

  if (mode === "working-tree" || mode === "working") {
    const untrackedRaw = git([...PINNED_DIFF_CONFIG, "ls-files", "-z", "--others", "--exclude-standard"], { cwd: root, raw: true, ignoreError: true }) || "";
    for (const f of untrackedRaw.split("\0").map(normalizePath).filter(Boolean)) {
      files.add(f);
    }
  }

  return Array.from(files);
}

export function diffText(root = process.cwd(), base = "main", mode = "committed", head = "HEAD") {
  const range = resolveDiffRange(root, base, mode, head);

  if (mode === "working-tree" || mode === "working") {
    const committed = git([...PINNED_DIFF_CONFIG, "diff", ...PINNED_DIFF_FLAGS, `${range.resolvedRef}...${range.head}`], { cwd: root, raw: true, ignoreError: true }) || "";
    const uncommitted = git([...PINNED_DIFF_CONFIG, "diff", ...PINNED_DIFF_FLAGS, range.head], { cwd: root, raw: true, ignoreError: true }) || "";

    const untrackedRaw = git([...PINNED_DIFF_CONFIG, "ls-files", "-z", "--others", "--exclude-standard"], { cwd: root, raw: true, ignoreError: true }) || "";
    const untrackedFiles = untrackedRaw.split("\0").map(normalizePath).filter(Boolean);
    let untrackedDiff = "";
    for (const file of untrackedFiles) {
      try {
        const fullPath = join(root, file);

        let linkStat = null;
        try {
          linkStat = lstatSync(fullPath);
        } catch (_) {}
        if (linkStat && linkStat.isSymbolicLink()) {
          const target = readlinkSync(fullPath);
          untrackedDiff += `\ndiff --git a/${file} b/${file}\nnew file mode 120000\n--- /dev/null\n+++ b/${file}\n`;
          untrackedDiff += `@@ -0,0 +1 @@\n+${target}\n\\ No newline at end of file\n`;
          continue;
        }

        if (existsSync(fullPath)) {
          const content = readFileSync(fullPath, "utf-8");
          const addedLines = content.split(/\r?\n/);
          untrackedDiff += `\ndiff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n`;
          untrackedDiff += `@@ -0,0 +1,${addedLines.length} @@\n`;
          untrackedDiff += addedLines.map((line) => `+${line}`).join("\n") + "\n";
        }
      } catch (_) {}
    }
    return [committed, uncommitted, untrackedDiff].filter(Boolean).join("\n");
  } else if (mode === "staged" || mode === "index") {
    return git([...PINNED_DIFF_CONFIG, "diff", ...PINNED_DIFF_FLAGS, "--cached", range.resolvedRef], { cwd: root, raw: true });
  }

  if (range.isBaseAtHead) {
    if (range.headParent) {
      return git([...PINNED_DIFF_CONFIG, "diff", ...PINNED_DIFF_FLAGS, `${range.headParent}...${range.head}`], { cwd: root, raw: true });
    } else {
      return git([...PINNED_DIFF_CONFIG, "diff-tree", "-p", "--no-commit-id", "--root", ...PINNED_DIFF_FLAGS, range.headCommit], { cwd: root, raw: true });
    }
  }
  return git([...PINNED_DIFF_CONFIG, "diff", ...PINNED_DIFF_FLAGS, `${range.resolvedRef}...${range.head}`], { cwd: root, raw: true });
}

/**
 * Paths git summarised as binary in this diff, with the size of what changed.
 *
 * \`git diff\` prints one 43-byte line for a binary file — "Binary files a/x and
 * b/x differ" — regardless of whether x grew by a byte or by half a megabyte.
 * Everything downstream reads the diff *text*, so a binary file is invisible to
 * both the payload governor and the secret scanner: a 500 KB blob measured 250
 * bytes, and a credential with a leading NUL byte was never looked at.
 *
 * Sizes come from the object git actually recorded where there is one, and from
 * the working file otherwise, so both \`committed\` and \`working-tree\` modes get a
 * real number.
 *
 * @param {string} root
 * @param {string} base
 * @param {string} mode
 * @returns {Array<{ file: string, bytes: number }>}
 */
function parseRawDiffOutput(raw, out) {
  // `--raw -z` emits ":<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0".
  const fields = raw.split("\0").filter(Boolean);
  for (let i = 0; i < fields.length; i++) {
    const meta = fields[i];
    if (!meta.startsWith(":")) continue;
    const parts = meta.slice(1).split(/\s+/);
    const file = fields[i + 1];
    i += 1;
    if (!file) continue;
    out.push({
      file: normalizePath(file),
      srcMode: parts[0] || "",
      dstMode: parts[1] || "",
      srcSha: parts[2] || "",
      dstSha: parts[3] || "",
      status: (parts[4] || "").charAt(0),
    });
  }
}

export function parseRawDiff(root = process.cwd(), base = "main", mode = "committed", head = "HEAD") {
  const range = resolveDiffRange(root, base, mode, head);
  const out = [];

  if (mode === "working-tree" || mode === "working") {
    for (const r of [`${range.resolvedRef}...${range.head}`, range.head]) {
      let raw = "";
      try {
        raw = git([...PINNED_DIFF_CONFIG, "diff", "--raw", ...PINNED_DIFF_FLAGS, "-z", r], { cwd: root, raw: true, ignoreError: true }) || "";
      } catch (_) {
        continue;
      }
      parseRawDiffOutput(raw, out);
    }
  } else if (mode === "staged" || mode === "index") {
    const raw = git([...PINNED_DIFF_CONFIG, "diff", "--raw", ...PINNED_DIFF_FLAGS, "-z", "--cached", range.resolvedRef], { cwd: root, raw: true, ignoreError: true }) || "";
    parseRawDiffOutput(raw, out);
  } else {
    if (range.isBaseAtHead) {
      if (range.headParent) {
        const raw = git([...PINNED_DIFF_CONFIG, "diff", "--raw", ...PINNED_DIFF_FLAGS, "-z", `${range.headParent}...${range.head}`], { cwd: root, raw: true, ignoreError: true }) || "";
        parseRawDiffOutput(raw, out);
      } else {
        const raw = git([...PINNED_DIFF_CONFIG, "diff-tree", "--root", "--no-commit-id", "-r", "--raw", ...PINNED_DIFF_FLAGS, "-z", range.headCommit], { cwd: root, raw: true, ignoreError: true }) || "";
        parseRawDiffOutput(raw, out);
      }
    } else {
      const raw = git([...PINNED_DIFF_CONFIG, "diff", "--raw", ...PINNED_DIFF_FLAGS, "-z", `${range.resolvedRef}...${range.head}`], { cwd: root, raw: true, ignoreError: true }) || "";
      parseRawDiffOutput(raw, out);
    }
  }
  return out;
}

/**
 * Gitlink (mode 160000) submodule changes introduced or removed in this diff.
 */
export function gitlinkChanges(root = process.cwd(), base = "main", mode = "committed", head = "HEAD") {
  const GITLINK_MODE = "160000";
  const results = [];
  const seen = new Set();

  for (const entry of parseRawDiff(root, base, mode, head)) {
    if (entry.srcMode !== GITLINK_MODE && entry.dstMode !== GITLINK_MODE) continue;
    if (seen.has(entry.file)) continue;
    seen.add(entry.file);

    results.push({
      file: entry.file,
      srcSha: entry.srcSha,
      dstSha: entry.dstSha,
      srcMode: entry.srcMode,
      dstMode: entry.dstMode,
      status: entry.status,
    });
  }

  return results;
}

/**
 * Symlinks this change introduces, with the path each one points at.
 *
 * `checkScope` is purely lexical, by design — the paths it judges can come from
 * a diff and need not exist on disk. But that made a symlink a hole straight
 * through it: a link named `notes.md` pointing at `.agent/config.yml` is judged
 * as `notes.md`, and the protected path it resolves to is never considered.
 * Resolving here, rather than inside `checkScope`, keeps that function lexical
 * and testable while letting the gate judge both names.
 *
 * The target is resolved lexically against the link's own directory: it may
 * point outside the repository, and following it on disk would be the wrong
 * thing to do with an untrusted path.
 *
 * @param {string} root
 * @param {string} base
 * @param {string} mode
 * @returns {Array<{ link: string, target: string }>}
 */
export function symlinkChanges(root = process.cwd(), base = "main", mode = "committed", head = "HEAD") {
  const SYMLINK_MODE = "120000";
  const results = [];
  const seen = new Set();

  for (const entry of parseRawDiff(root, base, mode, head)) {
    if (entry.status === "D") continue;
    if (entry.dstMode !== SYMLINK_MODE) continue;
    if (seen.has(entry.file)) continue;
    seen.add(entry.file);

    // A symlink's blob content is its target path.
    let target = "";
    if (entry.dstSha && !/^0+$/.test(entry.dstSha)) {
      target = (git(["cat-file", "blob", entry.dstSha], { cwd: root, ignoreError: true }) || "").trim();
    }
    if (!target) {
      try {
        target = readlinkSync(join(root, entry.file));
      } catch (_) {
        continue;
      }
    }
    if (!target) continue;

    results.push({ link: entry.file, target: resolveLinkTarget(entry.file, target) });
  }

  // An untracked symlink appears in no `git diff --raw` at all, so in
  // working-tree mode — the default for `agentctl check` — the loop above sees
  // nothing. `ln -s /etc/os-release leak.txt` therefore reached checkScope as
  // the plain name `leak.txt` and passed; committing the identical link to a
  // branch and checking that was caught. The gate's answer must not depend on
  // whether the attacker ran `git add`.
  if (mode === "working-tree" || mode === "working") {
    const untrackedRaw =
      git([...PINNED_DIFF_CONFIG, "ls-files", "-z", "--others", "--exclude-standard"], {
        cwd: root,
        raw: true,
        ignoreError: true,
      }) || "";
    for (const rel of untrackedRaw.split("\0").map(normalizePath).filter(Boolean)) {
      if (seen.has(rel)) continue;
      let target = "";
      try {
        if (!lstatSync(join(root, rel)).isSymbolicLink()) continue;
        target = readlinkSync(join(root, rel));
      } catch (_) {
        continue;
      }
      if (!target) continue;
      seen.add(rel);
      results.push({ link: rel, target: resolveLinkTarget(rel, target) });
    }
  }

  return results;
}

/** Where a symlink at `link` pointing at `target` lands, as a repo-relative or absolute path. */
function resolveLinkTarget(link, target) {
  const linkDir = normalizePath(link).split("/").slice(0, -1).join("/");
  return normalizePath(target).startsWith("/")
    ? normalizePath(target)
    : canonicalizePath(linkDir ? `${linkDir}/${target}` : target);
}

function isBinaryBlobOrFile(root, dstSha, file) {
  try {
    const fullPath = join(root, file);
    if (existsSync(fullPath)) {
      const fd = openSync(fullPath, "r");
      const buf = Buffer.alloc(8192);
      const bytesRead = readSync(fd, buf, 0, 8192, 0);
      closeSync(fd);
      if (buf.subarray(0, bytesRead).includes(0)) return true;
    }
  } catch (_) {}

  if (dstSha && !/^0+$/.test(dstSha)) {
    try {
      const chunk = execFileSync("git", ["cat-file", "-p", dstSha], {
        cwd: root,
        encoding: "buffer",
        maxBuffer: 8192,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (chunk.includes(0)) return true;
    } catch (err) {
      if (err.stdout && Buffer.isBuffer(err.stdout) && err.stdout.includes(0)) {
        return true;
      }
    }
  }

  return false;
}

export function binaryDiffEntries(root = process.cwd(), base = "main", mode = "committed", head = "HEAD") {
  const entries = new Map();
  for (const entry of parseRawDiff(root, base, mode, head)) {
    if (entry.status === "D") continue;
    if (entry.dstMode === "120000" || entry.dstMode === "160000") continue;
    const { file, dstSha } = entry;

    let bytes = 0;
    if (dstSha && !/^0+$/.test(dstSha)) {
      const size = git(["cat-file", "-s", dstSha], { cwd: root, ignoreError: true });
      bytes = Number(size) || 0;
    }
    // An unstaged change has an all-zero destination sha; the working file is
    // the only place its size exists.
    if (!bytes) {
      try {
        bytes = statSync(join(root, file)).size;
      } catch (_) {
        bytes = 0;
      }
    }
    // Keep the largest observation: the same path can appear in both ranges.
    entries.set(file, { bytes: Math.max(entries.get(file)?.bytes || 0, bytes), dstSha });
  }

  const binaryPaths = new Set();
  for (const [file, info] of entries) {
    if (isBinaryBlobOrFile(root, info.dstSha, file)) {
      binaryPaths.add(normalizePath(file));
    }
  }

  const text = diffText(root, base, mode, head);
  for (const line of text.split("\n")) {
    const m = line.match(/^Binary files (?:a\/(.+) and )?(?:b\/(.+)|\/dev\/null) differ$/);
    if (m) binaryPaths.add(normalizePath(m[2] || m[1] || ""));
    const m2 = line.match(/^Binary files \/dev\/null and b\/(.+) differ$/);
    if (m2) binaryPaths.add(normalizePath(m2[1] || ""));
  }

  return [...entries.entries()]
    .filter(([file]) => binaryPaths.has(normalizePath(file)))
    .map(([file, info]) => ({ file, bytes: info.bytes }));
}

/**
 * Size of the full rendered diff used by the payload governor.
 *
 * PINNED_DIFF_FLAGS forces --text, including binary file contents instead of
 * Git's short "Binary files differ" summary. Adding binary blob sizes again
 * double-counts the same payload (JOK-009).
 */
export function diffBytes(root = process.cwd(), base = "main", mode = "committed", head = "HEAD") {
  return Buffer.byteLength(diffText(root, base, mode, head), "utf-8");
}

export function showFromOrigin(root = process.cwd(), base = "main", filePath = "") {
  try {
    const resolvedRef = resolveBase(root, base, { allowFetch: false });
    const normPath = normalizePath(filePath);
    return git(["show", `${resolvedRef}:${normPath}`], { cwd: root, raw: true });
  } catch (_) {
    return null;
  }
}


export function worktreeRemove(root = process.cwd(), targetDir = "") {
  if (!targetDir || typeof targetDir !== "string" || targetDir.startsWith("-")) return "";
  return git(["worktree", "remove", "--force", "--", targetDir], { cwd: root });
}

export function worktreePrune(root = process.cwd()) {
  return git(["worktree", "prune"], { cwd: root });
}

export const WORKSPACE_DEP_NAMES = ["node_modules", ".venv", "venv", "target", ".pytest_cache"];
const SCAN_SKIP_DIRS = new Set([".git", "dist", "build", ".agent", ".turbo", ".next", ".cache", ...WORKSPACE_DEP_NAMES]);

/**
 * Discover root and workspace subpackage dependency directories so they can be symlinked into snapshots.
 * Supports monorepos (packages/*, apps/*, etc.) and pnpm symlink structures.
 *
 * @param {string} [root=process.cwd()]
 * @returns {string[]}
 */
export function findWorkspaceDependencyDirs(root = process.cwd()) {
  const depDirs = [];

  // 1. Root dependencies
  for (const dep of WORKSPACE_DEP_NAMES) {
    if (existsSync(join(root, dep))) {
      depDirs.push(dep);
    }
  }

  // 2. Monorepo subpackage dependencies (scan up to depth 3)
  function scan(dir, depth) {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }

    for (const entry of entries) {
      let isDir = entry.isDirectory();
      if (!isDir && entry.isSymbolicLink()) {
        try {
          isDir = statSync(join(dir, entry.name)).isDirectory();
        } catch (_) {}
      }
      if (!isDir) continue;
      const name = entry.name;
      if (WORKSPACE_DEP_NAMES.includes(name)) {
        depDirs.push(relative(root, join(dir, name)).replace(/\\/g, "/"));
        continue;
      }
      if (SCAN_SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      scan(join(dir, name), depth + 1);
    }
  }

  scan(root, 1);
  return [...new Set(depDirs)];
}

/**
 * Materialize the revision under review into an isolated execution directory (F10).
 *
 * In working-tree mode, verification executes against the live tree (`root`).
 * In staged or committed mode, the verification command must execute against the
 * snapshot being judged, rather than the working copy — attesting a revision
 * you did not execute is the failure this tool exists to refuse.
 *
 * @param {string} root - repository root
 * @param {string} mode - "working-tree" | "staged" | "committed"
 * @param {string} [targetRef="HEAD"] - commit reference for committed mode
 * @returns {{ cwd: string, cleanup: () => void, mode: string }}
 */
export function materializeSnapshot(root = process.cwd(), mode = "working-tree", targetRef = "HEAD") {
  if (mode === "working-tree" || mode === "working") {
    return {
      cwd: root,
      cleanup: () => {},
      mode,
    };
  }

  const prefix = `jules-${mode}-snapshot-`;
  const tmpDir = mkdtempSync(join(tmpdir(), prefix));
  let worktreeAdded = false;

  try {
    if (mode === "staged" || mode === "index") {
      execFileSync("git", ["-c", "core.quotePath=false", "checkout-index", "--all", `--prefix=${tmpDir}/`], {
        cwd: root,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else {
      // committed mode
      const safeRef = targetRef || "HEAD";
      if (typeof safeRef !== "string" || safeRef.startsWith("-")) {
        throw new Error(`Invalid target ref "${safeRef}".`);
      }
      try {
        execFileSync("git", ["worktree", "add", "--detach", tmpDir, safeRef], {
          cwd: root,
          stdio: ["ignore", "pipe", "pipe"],
        });
        worktreeAdded = true;
      } catch (_) {
        // Fallback: git archive piped to tar when worktree cannot be created (e.g. read-only .git)
        try {
          const tar = execFileSync("git", ["archive", safeRef], {
            cwd: root,
            maxBuffer: 50 * 1024 * 1024,
          });
          execFileSync("tar", ["-x", "-C", tmpDir], { input: tar, stdio: ["pipe", "ignore", "pipe"] });
        } catch (tarErr) {
          throw new Error(`Failed to extract snapshot for ${safeRef}: ${tarErr.message}`);
        }
      }
    }

    // Preserve local runtime dependencies in snapshot so offline/sandboxed verification can run (including monorepos & pnpm):
    const depDirs = findWorkspaceDependencyDirs(root);
    for (const relDep of depDirs) {
      const srcDep = join(root, relDep);
      const dstDep = join(tmpDir, relDep);
      if (existsSync(srcDep) && !existsSync(dstDep)) {
        try {
          mkdirSync(dirname(dstDep), { recursive: true });
          symlinkSync(srcDep, dstDep, "junction");
        } catch (_) {}
      }
    }

    const cleanup = () => {
      if (worktreeAdded) {
        try {
          execFileSync("git", ["worktree", "remove", "--force", tmpDir], {
            cwd: root,
            stdio: ["ignore", "ignore", "ignore"],
          });
        } catch (_) {}
      }
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch (_) {}
    };

    return {
      cwd: tmpDir,
      cleanup,
      mode,
    };
  } catch (err) {
    if (worktreeAdded) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", tmpDir], {
          cwd: root,
          stdio: ["ignore", "ignore", "ignore"],
        });
      } catch (_) {}
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
    throw new GateError(`Failed to materialize ${mode} snapshot for verification: ${err.message}`, { code: 1 });
  }
}

/**
 * Extract 'owner/repo' from a git remote URL if it points to GitHub.
 * Handles SSH (git@github.com:owner/repo.git), HTTPS (https://github.com/owner/repo.git),
 * protocol prefixes (ssh://, git://) and URL-embedded credentials.
 * @param {string} remoteUrl
 * @returns {string} 'owner/repo' or '' if invalid/not GitHub
 */
export function parseGitHubRepo(remoteUrl) {
  if (!remoteUrl || typeof remoteUrl !== "string") return "";
  const trimmed = remoteUrl.trim();

  // Match git@github.com:owner/repo(.git)
  const sshMatch = trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }

  // Match https://github.com/owner/repo(.git), http, ssh://, git://
  try {
    const urlObj = new URL(trimmed.startsWith("git@") ? `ssh://${trimmed}` : trimmed);
    if (urlObj.hostname.toLowerCase() === "github.com") {
      const parts = urlObj.pathname.replace(/^\/+/, "").replace(/\.git$/i, "").split("/");
      if (parts.length >= 2 && parts[0] && parts[1]) {
        return `${parts[0]}/${parts[1]}`;
      }
    }
  } catch (_) {}

  return "";
}

/**
 * Attempt to resolve 'owner/repo' from the local repository's git remote origin.
 * @param {string} [root=process.cwd()]
 * @returns {string}
 */
/**
 * Work out which branch this repository actually treats as its base.
 *
 * `main` was hardcoded as the scaffolded default, which is wrong the moment
 * `git init` picks `master` (still the default on many installed gits) or the
 * project standardised on `develop`. The failure was not graceful: the first
 * `agentctl check` could not resolve the base ref and rejected with exit 1.
 *
 * Resolution order, strongest evidence first:
 *   1. `origin/HEAD` — the remote states its own default branch.
 *   2. A local `main`, then `master` — the conventional names, preferred over
 *      the checked-out branch so running `init` from a feature branch does not
 *      record that feature branch as the base for everything after.
 *   3. The current branch — covers a fresh `git init` with no commits, where
 *      HEAD points at an unborn branch that `--show-current` still names.
 *   4. `main`, when there is no git information at all to go on.
 *
 * @param {string} [root=process.cwd()]
 * @returns {string}
 */
/**
 * Split a list of repo-relative paths into the ones git already tracks and the
 * ones it does not.
 *
 * Used to tell an onboarding mistake apart from an agent overstepping. Both
 * arrive as the same exit-3 scope violation on the same protected paths, but
 * "the files `init` just wrote are not committed yet" and "something edited the
 * rules it is governed by" need opposite advice, and the operator who has just
 * met the tool gets the wrong half if the two are not distinguished.
 *
 * @param {string} root
 * @param {string[]} files - repo-relative paths
 * @returns {{ tracked: string[], untracked: string[] }}
 */
export function partitionTracked(root = process.cwd(), files = []) {
  const list = files.filter((f) => typeof f === "string" && f && !f.startsWith("-"));
  if (list.length === 0) return { tracked: [], untracked: [] };
  let out = "";
  try {
    out = git(["ls-files", "--", ...list], { cwd: root, ignoreError: true }) || "";
  } catch (_) {
    // Without an answer, claim nothing is tracked-or-not: callers fall back to
    // the generic advice rather than to a guess.
    return { tracked: [], untracked: [] };
  }
  const tracked = new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
  return {
    tracked: list.filter((f) => tracked.has(f)),
    untracked: list.filter((f) => !tracked.has(f)),
  };
}

// Root-level package-manager manifests a just-run `npm install` (or equivalent)
// writes while onboarding a cold-start repository. `npm init -y` creates a
// brand-new package.json; `npm install` adds/updates the lockfile. The scope
// rules legitimately `protect` these — but a tool's *own* install step must not
// brick the first interaction a newcomer has with it. The two helpers below
// give callers a way to tell "fresh onboarding artifact" (untracked) apart from
// "a dependency change the maintainer actually shipped" (tracked+modified), so
// the gate keeps its teeth while task creation and the init commit hint stop
// tripping over scaffolding the installer just laid down.
const ONBOARDING_ROOT_ARTIFACTS = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
];

export const DEPENDENCY_DIR_PATTERNS = [
  "node_modules/",
  ".venv/",
  "venv/",
  "target/",
  ".pytest_cache/",
];

/**
 * True if path is inside a dependency directory (e.g. node_modules, .venv, target).
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function isDependencyPath(filePath = "") {
  const norm = String(filePath).replace(/\\/g, "/");
  return DEPENDENCY_DIR_PATTERNS.some(
    (dep) => norm.startsWith(dep) || norm.includes("/" + dep)
  );
}

/**
 * Among the given repo-relative paths, which are *untracked* root-level
 * package-manager artifacts or untracked dependency files — i.e. manifests a
 * fresh `npm init -y`/install just created rather than files the maintainer
 * committed and an agent then rewrote?
 *
 * The scope rules flag a brand-new package.json as `protect`, which is the
 * right call for the gate. But a task-create preflight that rejects a brand-new
 * repository because its own onboarding just produced package.json is a cold
 * start deadlock: the user has not committed anything yet, so they cannot make
 * the preflight pass without guessing the secret incantation. Similarly,
 * untracked dependency packages in node_modules/ or virtualenvs must not abort
 * preflight. Modified *tracked* lockfiles are deliberately NOT returned here —
 * those stay protected as supply-chain tampering.
 *
 * @param {string} root
 * @param {string[]} files repo-relative paths (as reported by a scope phase)
 * @returns {string[]}
 */
export function untrackedOnboardingArtifacts(root = process.cwd(), files = []) {
  const { untracked } = partitionTracked(root, files);
  if (untracked.length === 0) return [];
  return untracked.filter((f) => ONBOARDING_ROOT_ARTIFACTS.includes(f) || isDependencyPath(f));
}

/**
 * Root-level package-manager artifacts a `git add` in this repo would actually
 * stage *right now* — present on disk and not gitignored — for a commit hint.
 *
 * A cold-start repo has these as brand-new untracked files; an existing repo
 * that just ran `npm install -D` may have a modified (tracked) package.json
 * plus a new lockfile. Gitignored lockfiles (a repo that chooses not to track
 * them) are excluded, so the suggested `git add …` never errors on a path git
 * refuses to add.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function addableOnboardingArtifacts(root = process.cwd()) {
  let porcelain = "";
  try {
    // `--untracked-files=all` so a lone new file appears verbatim, not as a
    // collapsed `dir/` entry that would not match a root manifest name.
    porcelain = git(["status", "--porcelain", "--untracked-files=all"], { cwd: root, ignoreError: true }) || "";
  } catch (_) {
    return [];
  }
  const changed = new Set();
  for (const line of porcelain.split("\n")) {
    // Porcelain v1: two status chars, one space, then the path.
    const path = line.length > 3 ? line.slice(3) : "";
    if (path && !path.startsWith('"')) changed.add(path);
  }
  return ONBOARDING_ROOT_ARTIFACTS.filter((a) => changed.has(a) && existsSync(join(root, a)));
}

export function detectDefaultBranch(root = process.cwd()) {
  // `git()` returns trimmed stdout, and "" for a non-zero exit under
  // ignoreError — there is no status field to read.
  const ask = (args) => {
    try {
      return git(args, { cwd: root, ignoreError: true }) || "";
    } catch (_) {
      return "";
    }
  };

  const remoteHead = ask(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead.startsWith("origin/")) {
    const name = remoteHead.slice("origin/".length).trim();
    if (name) return name;
  }

  for (const candidate of ["main", "master"]) {
    if (
      ask(["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`]) ||
      ask(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${candidate}`])
    ) {
      return candidate;
    }
  }

  const current = ask(["branch", "--show-current"]);
  if (current) return current;

  return "main";
}

/**
 * Resolves a trusted default base reference for the deterministic gatekeeper.
 *
 * Strict trust anchor precedence:
 * 1. Explicit remote default: `refs/remotes/origin/HEAD` (e.g. origin/main, origin/trunk, origin/develop).
 * 2. Conventional primary branch names with defensible trust semantics: `main`, `master`, `trunk`.
 *    (Checks both `refs/remotes/origin/<candidate>` and `refs/heads/<candidate>`).
 *
 * Security Invariants:
 * - Does NOT guess `develop` as a default branch merely because it exists locally.
 * - Does NOT fall back to the currently checked-out branch (`branch --show-current`).
 * - A candidate/feature branch is NEVER a trust anchor merely because it is checked out.
 * - Returns `null` if no trustworthy default branch can be established.
 *
 * @param {string} [root]
 * @returns {string | null}
 */
export function resolveTrustedBaseRef(root = process.cwd()) {
  const ask = (args) => {
    try {
      return git(args, { cwd: root, ignoreError: true }) || "";
    } catch (_) {
      return "";
    }
  };

  // 1. Prefer refs/remotes/origin/HEAD when available
  const remoteHead = ask(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).trim();
  if (remoteHead.startsWith("origin/")) {
    const name = remoteHead.slice("origin/".length).trim();
    if (name) return name;
  }
  if (remoteHead.startsWith("refs/remotes/origin/")) {
    const name = remoteHead.slice("refs/remotes/origin/".length).trim();
    if (name) return name;
  }

  // 2. Conventional remote refs only (refs/remotes/origin/{main,master,trunk})
  for (const candidate of ["main", "master", "trunk"]) {
    if (ask(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${candidate}`])) {
      return candidate;
    }
  }

  return null;
}

export function resolveGitRemoteOrigin(root = process.cwd()) {
  try {
    const raw = git(["config", "--get", "remote.origin.url"], { cwd: root, ignoreError: true });
    return parseGitHubRepo(raw);
  } catch (_) {
    return "";
  }
}

/**
 * Default globs for generated, bundled, and lockfile paths that exhaust the diff budget.
 */
export const DEFAULT_GENERATED_GLOBS = [
  "dist/**",
  "**/dist/**",
  "**/*.map",
  "**/*-lock.yaml",
  "**/*-lock.json",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/Cargo.lock",
  "**/generated/**",
];

const REGEXP_SPECIAL = ".+?^${}()|[]\\";

/**
 * Convert a glob with * and ** into an anchored RegExp.
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob = "") {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (REGEXP_SPECIAL.includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

/**
 * Filter out per-file sections whose target path matches any ignore glob from a unified git diff.
 * Returns the filtered diff text and the array of excluded file paths.
 * If filtering would remove all file sections, the original diff is preserved.
 *
 * @param {string} diff - Unified git diff
 * @param {string[]} [ignoreGlobs=DEFAULT_GENERATED_GLOBS] - List of glob patterns
 * @returns {{ diff: string, excludedPaths: string[] }}
 */
export function filterDiffByPaths(diff = "", ignoreGlobs = DEFAULT_GENERATED_GLOBS) {
  if (!diff || typeof diff !== "string" || !ignoreGlobs || ignoreGlobs.length === 0) {
    return { diff: diff || "", excludedPaths: [] };
  }

  const matchers = ignoreGlobs.map(globToRegExp);
  const sections = diff.split(/(?=^diff --git )/m);
  const kept = [];
  const excludedPaths = [];
  let fileSectionsCount = 0;

  for (const section of sections) {
    if (!section.startsWith("diff --git ")) {
      if (section.length > 0) kept.push(section);
      continue;
    }

    fileSectionsCount++;
    const match = section.match(/^diff --git a\/.*? b\/(.+)$/m);
    let path = match ? match[1].trim() : undefined;
    if (path) {
      path = path.replace(/^["']|["']$/g, "");
    }

    if (path && matchers.some((re) => re.test(path))) {
      excludedPaths.push(path);
      continue;
    }
    kept.push(section);
  }

  if (fileSectionsCount > 0 && excludedPaths.length === fileSectionsCount) {
    return { diff, excludedPaths: [] };
  }

  return { diff: kept.join(""), excludedPaths };
}

/**
 * Compute byte length of diff after pruning generated files and lockfiles.
 */
export function prunedDiffBytes(root = process.cwd(), base = "main", mode = "committed", ignoreGlobs = DEFAULT_GENERATED_GLOBS) {
  const text = diffText(root, base, mode);
  const filtered = filterDiffByPaths(text, ignoreGlobs);
  return Buffer.byteLength(filtered.diff, "utf-8");
}

