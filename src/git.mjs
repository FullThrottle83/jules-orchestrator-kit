import { execFileSync, execSync } from "node:child_process";
import { readFileSync, existsSync, statSync, lstatSync, readlinkSync } from "node:fs";
import { join, delimiter } from "node:path";
import { normalizePath, canonicalizePath } from "./config.mjs";


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
  // True when `args` came from splitting a whitespace-separated string, which
  // means no element can itself contain whitespace. See the Windows note below.
  let tokenized = false;

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
  const winShim = tokenized && process.platform === "win32";
  const winSpawn =
    !useShell && !winShim && process.platform === "win32"
      ? resolveWindowsSpawn(binary, args, opts.env || process.env)
      : null;

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
      : execFileSync(winSpawn ? winSpawn.file : binary, winSpawn ? winSpawn.args : args, {
          cwd,
          encoding: "utf-8",
          shell: winShim,
          windowsVerbatimArguments: Boolean(winSpawn && winSpawn.verbatim),
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

export function resolveBase(root = process.cwd(), baseRef = "main") {
  const isHeadRef = baseRef === "HEAD" || baseRef.startsWith("HEAD~") || baseRef.startsWith("HEAD^") || baseRef.startsWith("HEAD@");
  const candidates = isHeadRef
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

  if (!isHeadRef) {
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

        // A symlink is its target *path*, never its target's contents — that is
        // how git stores one and how `git diff` renders one. Reading through
        // the link instead pulled whatever it pointed at into the diff, so
        // `ln -s /etc/passwd notes.md` shipped that file's contents to the
        // provider as ordinary added lines under an innocent name. Emit the
        // link the way a committed symlink is emitted, and let checkScope judge
        // the target it resolves to.
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
          // The `@@` header is not decoration. Every consumer that needs to know
          // *which* line an addition is on parses it — the mutation harness and
          // the V8 diff-coverage mapper both walk hunks — so a synthetic diff
          // without one made untracked files invisible to them. Both silently
          // reported nothing to do for a brand-new file, which is precisely
          // where untested code arrives. The secret scanner never noticed
          // because it only reads `+` lines.
          untrackedDiff += `\ndiff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n`;
          untrackedDiff += `@@ -0,0 +1,${addedLines.length} @@\n`;
          untrackedDiff += addedLines.map((line) => `+${line}`).join("\n") + "\n";
        }
      } catch (_) {}
    }
    return [committed, uncommitted, untrackedDiff].filter(Boolean).join("\n");
  }
  return git(["diff", `${resolvedRef}...HEAD`], { cwd: root, raw: true });
}

/**
 * Paths git summarised as binary in this diff, with the size of what changed.
 *
 * `git diff` prints one 43-byte line for a binary file — "Binary files a/x and
 * b/x differ" — regardless of whether x grew by a byte or by half a megabyte.
 * Everything downstream reads the diff *text*, so a binary file is invisible to
 * both the payload governor and the secret scanner: a 500 KB blob measured 250
 * bytes, and a credential with a leading NUL byte was never looked at.
 *
 * Sizes come from the object git actually recorded where there is one, and from
 * the working file otherwise, so both `committed` and `working-tree` modes get a
 * real number.
 *
 * @param {string} root
 * @param {string} base
 * @param {string} mode
 * @returns {Array<{ file: string, bytes: number }>}
 */
export function parseRawDiff(root = process.cwd(), base = "main", mode = "committed") {
  const resolvedRef = resolveBase(root, base);
  const ranges =
    mode === "working-tree" || mode === "working"
      ? [[`${resolvedRef}...HEAD`], ["HEAD"]]
      : [[`${resolvedRef}...HEAD`]];

  const out = [];
  for (const range of ranges) {
    let raw = "";
    try {
      raw = git(["diff", "--raw", "--no-renames", "-z", ...range], { cwd: root, raw: true, ignoreError: true }) || "";
    } catch (_) {
      continue;
    }
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
        file,
        srcMode: parts[0] || "",
        dstMode: parts[1] || "",
        srcSha: parts[2] || "",
        dstSha: parts[3] || "",
        status: (parts[4] || "").charAt(0),
      });
    }
  }
  return out;
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
export function symlinkChanges(root = process.cwd(), base = "main", mode = "committed") {
  const SYMLINK_MODE = "120000";
  const results = [];
  const seen = new Set();

  for (const entry of parseRawDiff(root, base, mode)) {
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
      git(["-c", "core.quotePath=false", "ls-files", "-z", "--others", "--exclude-standard"], {
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

export function binaryDiffEntries(root = process.cwd(), base = "main", mode = "committed") {
  const entries = new Map();
  for (const entry of parseRawDiff(root, base, mode)) {
    if (entry.status === "D") continue;
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
    entries.set(file, Math.max(entries.get(file) || 0, bytes));
  }

  // Only the paths git itself refused to render as text are relevant; a file
  // that diffed normally is already counted in the diff text.
  const binaryPaths = new Set();
  const text = diffText(root, base, mode);
  for (const line of text.split("\n")) {
    const m = line.match(/^Binary files (?:a\/(.+) and )?(?:b\/(.+)|\/dev\/null) differ$/);
    if (m) binaryPaths.add(normalizePath(m[2] || m[1] || ""));
    const m2 = line.match(/^Binary files \/dev\/null and b\/(.+) differ$/);
    if (m2) binaryPaths.add(normalizePath(m2[1]));
  }

  return [...entries.entries()]
    .filter(([file]) => binaryPaths.has(normalizePath(file)))
    .map(([file, bytes]) => ({ file, bytes }));
}

/**
 * Total bytes this change actually carries.
 *
 * The diff text plus the real size of every binary blob it only summarised.
 * Without the second term the payload governor could be walked straight past
 * with a committed binary of any size.
 */
export function diffBytes(root = process.cwd(), base = "main", mode = "committed") {
  const text = diffText(root, base, mode);
  let bytes = Buffer.byteLength(text, "utf-8");
  try {
    for (const entry of binaryDiffEntries(root, base, mode)) bytes += entry.bytes;
  } catch (_) {
    // A payload figure that is too low is the dangerous direction, but throwing
    // here would break every gate on a repo git cannot describe. The text-only
    // number is still returned.
  }
  return bytes;
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
    if (ask(["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`])) return candidate;
  }

  const current = ask(["branch", "--show-current"]);
  if (current) return current;

  return "main";
}

export function resolveGitRemoteOrigin(root = process.cwd()) {
  try {
    const raw = git(["config", "--get", "remote.origin.url"], { cwd: root, ignoreError: true });
    return parseGitHubRepo(raw);
  } catch (_) {
    return "";
  }
}

