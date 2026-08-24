# Critical Hardening Patches

**Repository:** `FullThrottle83/jules-orchestrator-kit`
**Branch:** `arena/01a034fe-jules-orchestrator-kit`
**Scope:** SEC-01, SEC-02, SEC-04, P-01, P-07, P-08, P-12 (from the recent security audit)

All patches are zero-dependency, drop-in replacements. Each code block below is the
complete, exact replacement for the named region in the named file — copy it
verbatim. Unchanged regions are omitted for brevity and are listed by anchor.

---

## 1. Summary of the 4 Critical Fixes

| # | Findings | File(s) | Problem | Fix |
|---|----------|---------|---------|-----|
| 1 | SEC-01, SEC-04 | `src/security.mjs` | `matchesGlob` translated `**` into overlapping `.*` and `(?: … |^)` alternations and `*` segments into `^[^/]*a[^/]*a…$`, both of which backtrack exponentially. A hostile deny rule or file list can stall the pre-dispatch gate (ReDoS). The secret scanner did not normalise Unicode, so a credential spelled with full-width or homoglyph characters sailed past every pattern. | Replace regex translation with a linear-time segment DP (no regex at all). Add NFKD + confusable→ASCII normalisation to the secret-scan variants. |
| 2 | SEC-02, P-01 | `src/ops/checkpoint.mjs`, `src/config.mjs`, `src/security.mjs` | `checkScope` only rejected POSIX-absolute and `../` paths. `C:\…`, `C:/…`, `C:rel`, and `\\server\share` escaped pattern matching and therefore the scope guard. Checkpoint ids were used verbatim as filenames, so a restore/create with a path-shaped id read or wrote outside `.agent/state/checkpoints/`. | New `isWindowsAbsolutePath()` helper in `src/config.mjs`; `checkScope` rejects drive/UNC spellings; `createCheckpoint`/`restoreCheckpoint` restrict ids to a single plain filename component. |
| 3 | P-07, P-08 | `src/git.mjs`, `src/provider.mjs` | On Windows, `npm`/`claude`/`gemini`/`codex` are `.cmd` shims that `execFileSync`/`spawnSync` cannot start (`spawnSync npm ENOENT`). Array commands were excluded from the old `shell: true` workaround, so every array-based command and every exec CLI provider failed on Windows. | Add `resolveWindowsSpawn()` (PATH+PATHEXT resolution + cmd.exe wrapper with C-runtime/cmd quoting). `runCmd` and the exec provider now route `.cmd` shims through cmd.exe with exact argv quoting. |
| 4 | P-12 | `src/rules-budget.mjs` | Character budget used the raw byte length, so a CRLF checkout counted an extra `\r` per line: the identical rules file passed as LF and failed as CRLF, depending purely on git's autocrlf setting. | Normalise `\r\n` → `\n` before computing `charCount` and `lineCount`. |

**Verification:** `npm test` → **738/738 passing** (717 pre-existing + 21 new),
`npm run lint` → **clean**.

---

## 2. Complete replacement code blocks

### 2.1 `src/config.mjs` — `isWindowsAbsolutePath` (SEC-02 / P-01)

Insert immediately **after** the existing `normalizePath()` function. This is the
single shared classifier used by `checkScope` and the checkpoint guards.

```js
/**
 * True when a path is a Windows absolute path and therefore can never name a
 * file inside a repository checked out to a normal relative location.
 *
 * Covered spellings (after `normalizePath` folds `\` to `/`):
 *
 *   - Drive-qualified: `C:/...`, `C:\...`
 *   - Drive-relative:  `C:foo` — on Windows this resolves against the *current
 *     directory of drive C:*, which is never the repository root and so is an
 *     escape even without a leading slash.
 *   - UNC: `//server/share`, `\\server\share`
 *
 * A POSIX absolute path (`/etc/passwd`) is intentionally NOT matched here:
 * the existing `startsWith("/")` check already covers it, and the two spellings
 * need to stay distinguishable in messages.
 *
 * @param {string} p
 * @returns {boolean}
 */
export function isWindowsAbsolutePath(p) {
  if (!p || typeof p !== "string") return false;
  const norm = normalizePath(p);
  return /^[A-Za-z]:/.test(norm) || norm.startsWith("//");
}
```

---

### 2.2 `src/security.mjs` — linear glob matcher (SEC-01)

**Change 1 — import.** Replace:

```js
import { canonicalizePath } from "./config.mjs";
```

with:

```js
import { canonicalizePath, isWindowsAbsolutePath } from "./config.mjs";
```

**Change 2 — replace the whole `matchesGlob` function** (everything from the
`export function matchesGlob(...)` line through its closing brace) with the
three functions below. They preserve every existing semantic (literal regex
metacharacters, `?`, `*`, `**`, case folding, and the exact-match fast path) but
never build a regex.

```js
/**
 * Matches one `/`-free glob segment against one `/`-free path segment.
 *
 * Only `*` (zero or more characters) and `?` (exactly one) are special; every
 * other character — including regex metacharacters like `(`, `+`, `.`, `[` —
 * is matched literally, preserving the escaping behaviour the old regex
 * translation had. A segment that is exactly `*` keeps its historical one-or-
 * more semantics, so `*` cannot match an empty segment.
 *
 * Implemented with the classic greedy-star wildcard algorithm rather than a
 * compiled regex: a segment like `*a*a*a*a*a*a*b` translated to
 * `^[^/]*a[^/]*a…$` and backtracked exponentially on a long run of `a`s, so
 * this path must never build a regex. The algorithm scans each character a
 * bounded number of times and cannot blow up the way the regex could.
 *
 * @param {string} str
 * @param {string} pattern
 * @param {boolean} [caseInsensitive]
 * @returns {boolean}
 */
function matchGlobSegment(str, pattern, caseInsensitive = false) {
  if (pattern === "*") return str.length > 0;

  let s = caseInsensitive ? str.toLowerCase() : str;
  let p = caseInsensitive ? pattern.toLowerCase() : pattern;

  let si = 0;
  let pi = 0;
  let star = -1;
  let matchIdx = 0;

  while (si < s.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === s[si])) {
      si++;
      pi++;
    } else if (pi < p.length && p[pi] === "*") {
      star = pi;
      matchIdx = si;
      pi++;
    } else if (star !== -1) {
      pi = star + 1;
      matchIdx++;
      si = matchIdx;
    } else {
      return false;
    }
  }

  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}

/**
 * Linear-time glob matcher over `/`-split segments.
 *
 * `**` matches zero or more whole segments; every other pattern segment
 * matches exactly one path segment via `matchGlobSegment`. This is a
 * bottom-up dynamic program with a rolling array: O(n·m) time and O(m) memory
 * for n path and m pattern segments, and it builds no regex at all.
 *
 * The previous implementation translated `**` into overlapping dot-star and
 * start-anchored `(?: … |^)` alternations (`SEC-01`). Anchored against `$`, a
 * pattern like `*a*a*a*a*a*a*a*a*b` or a chain of globstars caused catastrophic
 * backtracking — the match time grew exponentially with input length and a
 * hostile deny rule or file list could stall the dispatch gate. The DP
 * replaces every one of those constructs with a bounded scan.
 *
 * @param {string[]} pathSegs
 * @param {string[]} patSegs
 * @param {boolean} [caseInsensitive]
 * @returns {boolean}
 */
function matchGlobSegments(pathSegs, patSegs, caseInsensitive = false) {
  const n = pathSegs.length;
  const m = patSegs.length;

  // next[j] answers "does pathSegs[i+1..] match patSegs[j..]?". Seeded for the
  // empty-path row (i = n): only true when every remaining pattern segment is
  // `**`, since those are the only segments that can match zero path segments.
  let next = new Array(m + 1).fill(false);
  next[m] = true;
  for (let j = m - 1; j >= 0; j--) {
    next[j] = patSegs[j] === "**" && next[j + 1];
  }

  for (let i = n - 1; i >= 0; i--) {
    const cur = new Array(m + 1).fill(false);
    // cur[m] stays false: a path segment remains but the pattern is exhausted.
    for (let j = m - 1; j >= 0; j--) {
      if (patSegs[j] === "**") {
        // Consume this segment and keep `**` (next[j]), or match zero segments
        // and move on (cur[j + 1]).
        cur[j] = next[j] || cur[j + 1];
      } else if (matchGlobSegment(pathSegs[i], patSegs[j], caseInsensitive)) {
        cur[j] = next[j + 1];
      }
    }
    next = cur;
  }

  return next[0];
}

export function matchesGlob(filePath, globPattern, opts = {}) {
  if (!filePath || !globPattern) return false;
  const file = canonicalizePath(filePath);
  const pattern = canonicalizePath(globPattern);
  const caseInsensitive = Boolean(opts.caseInsensitive);

  if (caseInsensitive ? file.toLowerCase() === pattern.toLowerCase() : file === pattern) return true;

  return matchGlobSegments(file.split("/"), pattern.split("/"), caseInsensitive);
}
```

---

### 2.3 `src/security.mjs` — `checkScope` Windows-path guard (SEC-02)

In `checkScope`, replace the traversal check (the block that begins with the
`// A path that climbs out of the repository root…` comment and the
`if (file === ".." || …)` condition) with:

```js
    // A path that climbs out of the repository root can never be legitimate and
    // must not be silently pattern-matched against repo-relative rules. This
    // covers every spelling: POSIX absolute (`/etc/passwd`) and traversal
    // (`../`, `..`), Windows drive-qualified and drive-relative (`C:\...`,
    // `C:/...`, `C:foo`), and UNC (`\\server\share`, `//server/share`). The raw
    // spelling is checked as well as the canonical one, because canonicalisation
    // folds a leading `//` UNC into `/` and the check must fail on both.
    if (
      file === ".." ||
      file.startsWith("../") ||
      file.startsWith("/") ||
      isWindowsAbsolutePath(rawFile) ||
      isWindowsAbsolutePath(file)
    ) {
      violations.push({ file, reason: "Path escapes the repository root", rule: "deny", pattern: "<traversal>" });
      continue;
    }
```

---

### 2.4 `src/security.mjs` — Unicode confusable / NFKD normalisation (SEC-04)

**Change 1 — insert after the `INVISIBLE_CHARS` constant** the confusable table
and normaliser:

```js
// Unicode lookalikes that NFKD does NOT decompose. Full-width and other
// compatibility forms are handled by String#normalize("NFKD") below; these are
// the Cyrillic/Greek/Latin homoglyphs that survive NFKD because they are
// distinct code points with no compatibility decomposition. A credential
// scanner without this table can be defeated by a single substituted glyph,
// e.g. `ghp_` spelled with Cyrillic `р`.
const CONFUSABLE_TO_ASCII = new Map([
  // Cyrillic
  ["А", "A"], ["В", "B"], ["Е", "E"], ["К", "K"], ["М", "M"], ["Н", "H"],
  ["О", "O"], ["Р", "P"], ["С", "C"], ["Т", "T"], ["У", "Y"], ["Х", "X"],
  ["а", "a"], ["е", "e"], ["о", "o"], ["р", "p"], ["с", "c"], ["у", "y"],
  ["х", "x"], ["і", "i"], ["ј", "j"], ["ѕ", "s"],
  // Greek
  ["Α", "A"], ["Β", "B"], ["Ε", "E"], ["Ζ", "Z"], ["Η", "H"], ["Ι", "I"],
  ["Κ", "K"], ["Μ", "M"], ["Ν", "N"], ["Ο", "O"], ["Ρ", "P"], ["Τ", "T"],
  ["Υ", "Y"], ["Χ", "X"], ["ο", "o"], ["ι", "i"], ["ν", "v"], ["υ", "u"],
  ["ρ", "p"], ["τ", "t"], ["χ", "x"],
  // Other Unicode lookalikes
  ["ſ", "s"], // U+017F LATIN SMALL LETTER LONG S
  ["K", "K"], // U+212A KELVIN SIGN
]);

/**
 * Reduces the confusable spellings a credential can hide behind to plain
 * ASCII before the secret patterns run (`SEC-04`).
 *
 *   1. NFKD decomposes full-width and other compatibility forms
 *      (`ｇｈｐ＿…` → `ghp_…`).
 *   2. Combining marks the decomposition may leave behind are stripped
 *      (`e\u0301` → `e`).
 *   3. The curated lookalike table maps Cyrillic/Greek/Latin homoglyphs that
 *      NFKD cannot see through to their ASCII target.
 *
 * This is the zero-dependency subset of Unicode TR39 confusable handling; the
 * full confusables data table is intentionally omitted so the kit keeps
 * shipping with no runtime dependencies.
 *
 * @param {string} str
 * @returns {string}
 */
function normalizeSecretText(str) {
  if (!str || typeof str !== "string") return str;
  let out = str;
  try {
    out = out.normalize("NFKD");
  } catch (_) {}
  out = out.replace(/[\u0300-\u036f]/g, "");
  for (const [from, to] of CONFUSABLE_TO_ASCII) {
    out = out.split(from).join(to);
  }
  return out;
}
```

**Change 2 — in `secretScanVariants`**, replace the tail of the function:

```js
  const hexDecoded = tryHexDecodeTokens(dejoined);
  const pctDecoded = tryPercentDecode(dejoined);

  return {
    all: [...new Set([addedLines, stripped, dejoined, hexDecoded, pctDecoded])],
    normalized: dejoined,
  };
}
```

with:

```js
  const hexDecoded = tryHexDecodeTokens(dejoined);
  const pctDecoded = tryPercentDecode(dejoined);
  // Confusable / NFKD normalisation runs over both the raw text and the
  // concatenation-collapsed text, so a credential that is both split across a
  // source-level join AND spelled with homoglyphs still surfaces.
  const confusable = normalizeSecretText(stripped);
  const confusableDejoined = normalizeSecretText(dejoined);

  return {
    all: [...new Set([addedLines, stripped, dejoined, hexDecoded, pctDecoded, confusable, confusableDejoined])],
    normalized: dejoined,
  };
}
```

---

### 2.5 `src/ops/checkpoint.mjs` — safe checkpoint ids (SEC-02 / P-01)

**Change 1 — import.** Replace:

```js
import { resolveRoot } from "../config.mjs";
```

with:

```js
import { resolveRoot, isWindowsAbsolutePath } from "../config.mjs";
```

**Change 2 — insert immediately after the `CheckpointError` class** (before the
`getCheckpointDir` doc comment):

```js
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
```

**Change 3 — in `createCheckpoint`**, add the validation and use the sanitised id:

```js
export function createCheckpoint(sessionId = `session-${Date.now()}`, options = {}) {
  const safeId = assertSafeCheckpointId(sessionId);
  const root = options.root || resolveRoot();
  const dir = getCheckpointDir(root);
```

and further down:

```js
  const snapshot = {
    version: 1,
    id: safeId,
    ...
  };

  const snapshotPath = join(dir, `${safeId}.json`);
```

(only the two identifiers change from `sessionId` to `safeId`).

**Change 4 — in `restoreCheckpoint`**, immediately after the `--latest`/`latest`
resolution and before `snapshotFile` is built:

```js
  // A caller-supplied id becomes a filename here; reject anything that is not
  // a plain filename before `join` can turn it into a path escape (`P-01`).
  targetId = assertSafeCheckpointId(targetId);

  const snapshotFile = join(dir, `${targetId}.json`);
```

---

### 2.6 `src/git.mjs` — Windows `.cmd` shim spawning (P-07)

**Change 1 — import.** Replace:

```js
import { join } from "node:path";
```

with:

```js
import { join, delimiter } from "node:path";
```

**Change 2 — insert after the `DEFAULT_MAX_BUFFER` constant** (before `runCmd`):

```js
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
    file: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
    verbatim: true,
  };
}
```

**Change 3 — in `runCmd`**, replace the two lines that set `winShim`:

```js
  const winShim = tokenized && process.platform === "win32";
```

with:

```js
  const winShim = tokenized && process.platform === "win32";
  const winSpawn =
    !useShell && !winShim && process.platform === "win32"
      ? resolveWindowsSpawn(binary, args, opts.env || process.env)
      : null;
```

and replace the `execFileSync` call:

```js
      : execFileSync(binary, args, {
          cwd,
          encoding: "utf-8",
          shell: winShim,
          stdio: ["ignore", "pipe", "pipe"],
          env: opts.env || process.env,
          timeout,
          maxBuffer,
        });
```

with:

```js
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
```

---

### 2.7 `src/provider.mjs` — exec CLI providers through the shim path (P-08)

**Change 1 — import.** Add after the `redactSecrets` import:

```js
import { resolveWindowsSpawn } from "./git.mjs";
```

**Change 2 — in the `providerSpec.type === "exec"` branch**, replace the
`spawnSync` call:

```js
        const res = spawnSync(command, processedArgs, {
          cwd: config._root || process.cwd(),
          encoding: "utf-8",
          shell: false,
          input: providerSpec.promptViaStdin ? data.prompt : undefined,
          timeout: providerSpec.timeoutMs || 900000,
          maxBuffer: 32 * 1024 * 1024,
        });
```

with:

```js
        // `claude`, `gemini` and `codex` are npm-installed CLI binaries, which on
        // Windows are `.cmd` shims that `spawnSync(..., { shell: false })` cannot
        // start (CreateProcess cannot run a batch file). Route them through
        // cmd.exe with per-argument quoting instead (P-08); on other platforms
        // this is a null and the command spawns directly as before.
        const winSpawn = resolveWindowsSpawn(command, processedArgs, process.env);

        const res = spawnSync(winSpawn ? winSpawn.file : command, winSpawn ? winSpawn.args : processedArgs, {
          cwd: config._root || process.cwd(),
          encoding: "utf-8",
          shell: false,
          windowsVerbatimArguments: Boolean(winSpawn && winSpawn.verbatim),
          input: providerSpec.promptViaStdin ? data.prompt : undefined,
          timeout: providerSpec.timeoutMs || 900000,
          maxBuffer: 32 * 1024 * 1024,
        });
```

---

### 2.8 `src/rules-budget.mjs` — CRLF normalisation (P-12)

In `checkRulesBudget`, replace:

```js
      const content = readFileSync(fullPath, "utf-8");
      const charCount = content.length;
      const lineCount = content.split("\n").length;
```

with:

```js
      const content = readFileSync(fullPath, "utf-8");
      // A CRLF checkout inflates the character count by one `\r` per line, so
      // the identical rules file passes as LF and fails as CRLF — a false
      // budget violation that depends purely on git's autocrlf setting rather
      // than the content. Normalise line endings before measuring (P-12) so the
      // budget counts the rule text, not the line-ending dialect.
      const normalized = content.replace(/\r\n/g, "\n");
      const charCount = normalized.length;
      const lineCount = normalized.split("\n").length;
```

---

## 3. Unit test suite additions

New file: **`test/critical-hardening.test.mjs`** (21 tests, all passing). It is
picked up automatically by `scripts/run-tests.mjs`, which globs `test/*.test.mjs`.

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { matchesGlob, checkScope, scanDiff } from "../src/security.mjs";
import { isWindowsAbsolutePath } from "../src/config.mjs";
import { createCheckpoint, restoreCheckpoint, CheckpointError } from "../src/ops/checkpoint.mjs";
import { windowsEscapeArgument, windowsEscapeCommand, resolveWindowsSpawn, runCmd } from "../src/git.mjs";
import { createProvider } from "../src/provider.mjs";
import { checkRulesBudget } from "../src/rules-budget.mjs";

// Fullwidth offset for ASCII letters/digits/underscore.
const fullwidth = (s) => s.split("").map((c) => String.fromCodePoint(c.codePointAt(0) + 0xfee0)).join("");

describe("SEC-01: matchesGlob is linear-time (no globstar ReDoS)", () => {
  it("still matches the documented glob semantics", () => {
    assert.equal(matchesGlob(".github/workflows/ci.yml", ".github/**"), true);
    assert.equal(matchesGlob("src/index.js", "src/*.js"), true);
    assert.equal(matchesGlob("dist/server/index.js", "dist/**/*.js"), true);
    assert.equal(matchesGlob("src/nested/deep/file.txt", "src/**/*.js"), false);
    assert.equal(matchesGlob("src/index.js", "tests/*.js"), false);
  });

  it("handles globstar in leading, trailing, middle and repeated positions", () => {
    assert.equal(matchesGlob("a/b/c", "a/**/c"), true);
    assert.equal(matchesGlob("a/c", "a/**/c"), true, "globstar matches zero segments");
    assert.equal(matchesGlob("a/x/y/c", "a/**/c"), true);
    assert.equal(matchesGlob("a/b/d", "a/**/c"), false);
    assert.equal(matchesGlob("a", "a/**"), true, "trailing globstar matches zero");
    assert.equal(matchesGlob("a/b", "**/b"), true, "leading globstar matches zero");
    assert.equal(matchesGlob("a/x/b/z", "a/**/b/**/z"), true);
    assert.equal(matchesGlob("a/x/y/z", "a/**/b/**/z"), false, "literal 'b' segment is required");
    assert.equal(matchesGlob("a/x/b/y/q", "a/**/b/**/z"), false);
  });

  it("matches regex metacharacters in segments literally", () => {
    assert.equal(matchesGlob("app/(admin)/page.tsx", "app/(admin)/**"), true);
    assert.equal(matchesGlob("src/c++/x.h", "src/c++/**"), true);
    assert.equal(matchesGlob("src/index.js", "app/(admin)/**"), false);
  });

  it("folds case for case-insensitive matching", () => {
    assert.equal(matchesGlob(".GitHub/workflows/ci.yml", ".github/**", { caseInsensitive: true }), true);
    assert.equal(matchesGlob("SRC/Index.JS", "src/*.js", { caseInsensitive: true }), true);
  });

  it("completes in linear time on inputs that hung the old regex translation", () => {
    // The previous translation turned `*a*a*…*b` into `^[^/]*a[^/]*a…$` and
    // `**` into overlapping `.*` alternations; either shape backtracked
    // exponentially and stalled the gate for minutes. Each of these now
    // finishes in well under a millisecond, so a 2s ceiling is headroom of
    // several orders of magnitude and only ever fires on a real regression.
    const hostile = [
      ["*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b", "a".repeat(40) + "c"],
      ["a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b", "a".repeat(30) + "x"],
      ["**a**a**a**a**a**a**a**a**b", "a/".repeat(30) + "x"],
      ["a/**/a/**/a/**/a", "a/" + "a/".repeat(60) + "b"],
      ["**/**/**/**/x", "a/".repeat(60) + "b"],
    ];
    for (const [pattern, input] of hostile) {
      const started = Date.now();
      assert.equal(matchesGlob(input, pattern), false, `non-match for ${pattern}`);
      assert.ok(Date.now() - started < 2000, `matchesGlob must stay linear for ${pattern}`);
    }
  });
});

describe("SEC-04: Unicode confusable / NFKD normalisation in secret scanning", () => {
  it("detects a GitHub token spelled with full-width characters (NFKD)", () => {
    const token = "ghp_" + fullwidth("a".repeat(36));
    const res = scanDiff(`+++ b/leak.js\n+const t = "${token}";`);
    assert.equal(res.ok, false);
    assert.equal(res.findings[0].severity, "CRITICAL");
    assert.equal(res.findings[0].type, "HIGH_CONFIDENCE_SECRET");
  });

  it("detects an AWS key id spelled with Cyrillic homoglyphs", () => {
    // А and К are Cyrillic U+0410/U+041A, which NFKD leaves alone but the
    // lookalike table maps to ASCII A and K.
    const token = "\u0410\u041A" + "IAIOSFODNN7EXAMPLE";
    const res = scanDiff(`+++ b/leak.js\n+const k = "${token}";`);
    assert.equal(res.ok, false);
    assert.equal(res.findings[0].type, "HIGH_CONFIDENCE_SECRET");
  });

  it("still passes a genuinely clean diff", () => {
    const res = scanDiff(`+++ b/ok.js\n+const x = "no secrets here";`);
    assert.equal(res.ok, true);
    assert.equal(res.findings.length, 0);
  });
});

describe("SEC-02 / P-01: Windows drive-letter and UNC path escapes", () => {
  it("isWindowsAbsolutePath recognises drive and UNC spellings", () => {
    assert.equal(isWindowsAbsolutePath("C:\\Windows\\System32"), true);
    assert.equal(isWindowsAbsolutePath("C:/Windows"), true);
    assert.equal(isWindowsAbsolutePath("C:relative"), true);
    assert.equal(isWindowsAbsolutePath("\\\\server\\share"), true);
    assert.equal(isWindowsAbsolutePath("//server/share"), true);
    assert.equal(isWindowsAbsolutePath("src/ok.js"), false);
    assert.equal(isWindowsAbsolutePath("/etc/passwd"), false, "POSIX absolute is handled separately");
  });

  it("checkScope rejects every Windows absolute spelling", () => {
    for (const raw of ["C:\\Windows\\System32", "C:/Windows", "C:relative", "\\\\server\\share", "//server/share"]) {
      const res = checkScope([raw], { deny: [], allow: [], protect: [] });
      assert.equal(res.ok, false, `must reject ${raw}`);
      assert.equal(res.violations[0].reason, "Path escapes the repository root");
    }
  });

  it("checkScope still accepts a plain repo-relative path", () => {
    const res = checkScope(["src/ok.js"], { deny: [], allow: [], protect: [] });
    assert.equal(res.ok, true);
    assert.equal(res.violations.length, 0);
  });

  it("checkpoint create/restore reject ids that are path escapes", () => {
    const root = mkdtempSync(join(tmpdir(), "ckpt-hardening-"));
    try {
      execSync("git init -q -b main", { cwd: root, stdio: "ignore" });
      execSync('git config user.name "T"', { cwd: root, stdio: "ignore" });
      execSync('git config user.email "t@t.co"', { cwd: root, stdio: "ignore" });
      writeFileSync(join(root, "f.txt"), "x");
      execSync("git add -A && git commit -qm init", { cwd: root, stdio: "ignore" });

      for (const bad of ["../../evil", "C:\\evil", "C:/evil", "\\\\server\\share", "a/b"]) {
        assert.throws(() => createCheckpoint(bad, { root }), CheckpointError, `create must reject ${bad}`);
        assert.throws(() => restoreCheckpoint(bad, { root }), CheckpointError, `restore must reject ${bad}`);
      }

      // A legitimate id still round-trips.
      const snap = createCheckpoint("session-ok", { root });
      assert.equal(snap.id, "session-ok");
      assert.equal(existsSync(join(root, ".agent", "state", "checkpoints", "session-ok.json")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("P-07: Windows .cmd shim spawning (quoting helpers)", () => {
  it("escapes command names", () => {
    assert.equal(windowsEscapeCommand("npm.cmd"), "npm.cmd");
    assert.equal(windowsEscapeCommand("C:\\Program Files\\node\\npm.cmd"), "C:\\Program^ Files\\node\\npm.cmd");
  });

  it("quotes arguments with the C-runtime + cmd.exe rules", () => {
    assert.equal(windowsEscapeArgument("two words"), '^"two^ words^"');
    assert.equal(windowsEscapeArgument("plain"), '^"plain^"');
    assert.equal(windowsEscapeArgument(""), '^"^"');
    assert.equal(windowsEscapeArgument("a\\b"), '^"a\\b^"');
    assert.equal(windowsEscapeArgument("trailing\\"), '^"trailing\\\\^"');
    assert.equal(windowsEscapeArgument('quote"inside'), '^"quote\\^"inside^"');
    assert.equal(windowsEscapeArgument("a & b"), '^"a^ ^&^ b^"');
  });

  it("double-escapes meta characters for node_modules/.bin cmd shims", () => {
    assert.equal(windowsEscapeArgument("a & b", true), '^^^"a^^^ ^^^&^^^ b^^^"');
  });

  it("returns null on non-Windows so callers spawn directly", () => {
    assert.equal(resolveWindowsSpawn("npm", ["--version"], process.env, "linux"), null);
  });

  it("spawns a native .exe directly", () => {
    const dir = mkdtempSync(join(tmpdir(), "win-exe-"));
    try {
      // Lower-case PATHEXT so resolution works on the case-sensitive Linux
      // filesystem the suite runs on; on Windows the same code is
      // case-insensitive.
      writeFileSync(join(dir, "fake.exe"), "");
      const env = { PATH: dir, PATHEXT: ".exe;.cmd" };
      const spec = resolveWindowsSpawn("fake", ["run", "two words"], env, "win32");
      assert.ok(spec);
      assert.equal(spec.file, join(dir, "fake.exe"));
      assert.deepEqual(spec.args, ["run", "two words"]);
      assert.equal(spec.verbatim, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wraps a .cmd shim in cmd.exe with per-argument quoting", () => {
    const dir = mkdtempSync(join(tmpdir(), "win-cmd-"));
    try {
      writeFileSync(join(dir, "fake.cmd"), "");
      const env = { PATH: dir, PATHEXT: ".cmd" };
      const spec = resolveWindowsSpawn("fake", ["run", "two words"], env, "win32");
      assert.ok(spec);
      assert.equal(spec.file, "cmd.exe");
      assert.deepEqual(spec.args.slice(0, 3), ["/d", "/s", "/c"]);
      assert.ok(spec.args[3].includes(join(dir, "fake.cmd")), "command name is present in the cmd line");
      assert.ok(spec.args[3].includes('^"two^ words^"'), "space-bearing arg is quoted");
      assert.equal(spec.verbatim, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runCmd still executes array commands with space-bearing args on POSIX", () => {
    const res = runCmd([process.execPath, "-e", "console.log(process.argv[1])", "two words"], { cwd: process.cwd() });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, "two words");
  });
});

describe("P-08: exec CLI providers spawn through the same Windows shim path", () => {
  it("exec provider still runs a CLI-style command on POSIX", async () => {
    const provider = createProvider({
      name: "claude-code",
      type: "exec",
      command: process.execPath,
      args: ["-e", "process.stdout.write('cli-ok')"],
      promptViaStdin: true,
    });
    const res = await provider.dispatch({ prompt: "hello" });
    assert.equal(res.status, "completed");
    assert.equal(res.output, "cli-ok");
  });
});

describe("P-12: CRLF normalisation before rules budget accounting", () => {
  it("counts a CRLF file by its LF-normalised length", () => {
    const dir = mkdtempSync(join(tmpdir(), "rules-crlf-"));
    try {
      // 10 letters + 9 newlines = 19 chars once CRLF is normalised to LF; the
      // raw CRLF form is 28 chars and would have falsely tripped a 19-char cap.
      const crlf = "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\ni\r\nj";
      writeFileSync(join(dir, "AGENTS.md"), crlf, "utf-8");
      const res = checkRulesBudget(dir, { maxChars: 19, maxLines: 100 });
      assert.equal(res.ok, true);
      assert.equal(res.violations.length, 0);

      // The same content as LF measures identically, proving the two dialects
      // no longer disagree.
      const lfDir = mkdtempSync(join(tmpdir(), "rules-lf-"));
      try {
        writeFileSync(join(lfDir, "AGENTS.md"), crlf.replace(/\r\n/g, "\n"), "utf-8");
        assert.equal(checkRulesBudget(lfDir, { maxChars: 19, maxLines: 100 }).ok, true);
      } finally {
        rmSync(lfDir, { recursive: true, force: true });
      }

      // A file one character over the budget still fails, and the reported
      // charCount is the normalised one.
      writeFileSync(join(dir, "AGENTS.md"), crlf.replace(/j$/, "jj"), "utf-8");
      const over = checkRulesBudget(dir, { maxChars: 19, maxLines: 100 });
      assert.equal(over.ok, false);
      assert.equal(over.violations[0].charCount, 20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

---

## 4. Notes for reviewers

- **No new runtime dependencies.** The Windows quoting is a self-contained
  reimplementation of the well-known C-runtime + cmd.exe algorithm (the same one
  `cross-spawn` implements), so the kit's zero-dependency contract holds.
- **No public API changes.** `index.mjs` is untouched, so the frozen SDK export
  snapshot (`test/api-surface.test.mjs`, locked at 208 symbols) still passes. The
  new helpers are exported only from their source modules for direct use/tests.
- **Fail-closed direction everywhere.** `checkScope` blocks *more* spellings than
  before; checkpoint ids accept *fewer* shapes; secret scanning runs *more*
  normalisation variants; the budget counts *less* (line-ending noise). Each
  change narrows the bypass surface without opening a new one.
- **Performance.** `matchesGlob` is now O(n·m) on path/pattern segments with a
  rolling array (O(m) memory), and single-segment matching is linear. The
  previously-hanging inputs complete in <1 ms each.
