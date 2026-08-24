# Cross-Platform Robustness Audit — `FullThrottle83/jules-orchestrator-kit`

Audit date: 2026-08-24
Scope: Linux, macOS (Darwin), Windows
Invariant: no existing repository files were modified. All findings below are from read-only inspection plus safe, non-persistent probe scripts.

---

## 1. Cross-Platform Failure Risk Matrix

Severity legend:
- **🔴 CRITICAL** — silent security/scope invariant break or failure that produces a false "pass" on a supported platform.
- **🟠 HIGH** — deterministic failure of a documented feature (verification, monorepo boundary, provider dispatch) on a supported platform.
- **🟡 MEDIUM** — behavior that is nondeterministic, environment-sensitive, or creates a wrong-but-loud result.
- **🟢 LOW** — cosmetic / consistency issue.

| ID | Area | File:Lines | Linux | macOS | Windows | Severity | Silent failure? |
|----|------|-----------|-------|-------|---------|----------|-----------------|
| P-01 | Path normalization — Windows drive-letter/UNC absolute paths | `src/config.mjs:77-116`; `src/security.mjs:247-284` | ✅ | ✅ | 🔴 | 🔴 Critical | Yes — `C:/x/.git/config` and `C:/../etc/passwd` are treated as repo-relative and are NOT rejected as path escapes. |
| P-02 | Case folding — deny/protect globs | `src/security.mjs:211-239`, `241-284` | ✅ | ✅ (case-insensitive APFS) | ✅ (NTFS) | 🟢 Low | No — deny/protect already fold case; the risk is confined to string-based comparisons elsewhere (P-05/P-06). |
| P-03 | Case folding — `allow` list | `src/security.mjs:235`, `265-267` | ✅ | ✅ fail-closed | ✅ fail-closed | 🟢 Low (intentional) | No — documented; a case mismatch on allow yields a violation, which is the safe direction. |
| P-04 | Scope escape detection — leading `/` only | `src/security.mjs:253-258` | ✅ | ✅ | 🔴 | 🔴 Critical | Yes — rejects `/abs`/`../` but not `C:\...`, `C:/...`, or `C:..\..\`. |
| P-05 | Case-sensitive manifest file names in monorepo detection | `src/stack-detector.mjs:268-306` (esp. `284-297`) | ✅ | 🟠 on case-insensitive APFS | 🟠 on NTFS | 🟠 High | Yes — `Package.JSON`, `Cargo.TOML`, `go.MOD`, `PyProject.TOML` are invisible to `findSubprojectRoot`, so cross-package boundary checks silently downgrade to root-level (`subproject === "."`). |
| P-06 | Case-sensitive `.git`/`node_modules` skip during tree hash | `src/evidence.mjs:57-76` (esp. `64`) | ✅ | 🟡 | 🟡 | 🟡 Medium | Yes — `.GIT/` or `.GITHUB/` (case-folding filesystems) is not skipped, so `computeDirectoryHash` can descend into `.git` and produce a different, environment-dependent tree hash. |
| P-07 | Windows `.cmd`/`.bat` shims for string verify commands | `src/git.mjs:21-119` (esp. `63-84`, `95`) | ✅ | ✅ | 🟠 with the current special case | 🟠 High | Partly. `npm test` is fixed via `shell: true` only when the command arrives as a whitespace-tokenized string. Array commands (`["npm","test"]`) still use `shell:false` and fail with ENOENT on Windows. |
| P-08 | Exec provider dispatch (Claude Code / Codex / Gemini CLI) on Windows | `src/provider.mjs:78-104`, `502-518` (esp. `512-515`) | ✅ | ✅ | 🔴 | 🔴 Critical | Yes — `spawnSync(command, args, { shell:false })` cannot spawn npm-installed `.cmd` shims (`claude`, `codex`, `gemini`); the provider returns `Provider Exec Failed: spawnSync claude ENOENT`, which the router treats as a normal dispatch failure. |
| P-09 | PowerShell `.ps1` commands | `src/git.mjs:21-119`; `src/engine.mjs:1129-1243` | n/a | n/a | 🔴 | 🔴 Critical | Yes — no code ever invokes `powershell`/`pwsh`; a `verify: { test: "./run-tests.ps1" }` or `.ps1` build command is handed to `cmd.exe`, which reports `'...' is not recognized` — a regular non-zero verify failure, not an environment diagnosis. |
| P-10 | Exit-code capture from spawned commands | `src/git.mjs:95-118`, `131-158` | ✅ | ✅ | 🟡 | 🟡 Medium | Partly. `err.status` is used for non-zero exits, but `err.status || ...` collapses `null`/`0` on the same line (`95`); a `null` status (spawn-level failure) is reported as exit `1`, indistinguishable from the command genuinely failing. |
| P-11 | Shell absence on macOS/Linux for `probeDevServer` | `src/engine.mjs:1139-1141`, `1147-1152` | ✅ | 🟡 | ✅ | 🟡 Medium | Yes — hard-codes `/bin/sh` (`1139`); macOS users who have removed/shorthanded `/bin/sh` (and some hardened Linux containers) get a silent dev-server probe failure. |
| P-12 | CRLF inflation of character budget | `src/rules-budget.mjs:47-49` | ✅ LF | 🟡 CRLF checkout | 🟡 CRLF checkout | 🟡 Medium | Yes — `content.length` counts `\r`, so a file that is 9,900 chars under LF can exceed the 10,000-char budget on CRLF, causing platform-dependent rules-budget failures. |
| P-13 | SHA-256 sentinel is line-ending sensitive | `src/rules-budget.mjs:105-118`, `140-160` | ✅ | 🟡 | 🟡 | 🟡 Medium | Yes — `compileRules` hashes raw source bytes including any `\r\n`; if compiled text is regenerated on a CRLF checkout (or transferred through a NEWLINE-normalizing channel), the same semantic rules produce a different `sha256` and `len`, yielding false `body checksum` / `length mismatch` errors. |
| P-14 | Diff payload byte counting | `src/git.mjs:246-272` | ✅ | ✅ | ✅ | 🟢 Low | No — `git diff` emits LF, and untracked files are split on `/\r?\n/` then rejoined with LF (`261`), so `diffBytes` is CRLF-safe. |
| P-15 | Symlink read during untracked-diff collection | `src/git.mjs:256-263` | 🔴 | 🔴 | 🟠 (symlink/junction privileges needed) | 🔴 Critical | Yes — `existsSync()` + `readFileSync()` follow symlinks. An untracked symlink inside the repo pointing at `/etc/passwd`, a secrets file, or `../outside` is read into the diff payload and secret scanner, even though the working-tree path is perfectly within scope. |
| P-16 | Symlink read during cross-package boundary scan | `src/stack-detector.mjs:326-331` | 🔴 | 🔴 | 🟠 | 🟠 High | Yes — `existsSync()` + `readFileSync()` follow symlinks when reading changed-file content, so cross-package boundary analysis can escape the repo and reason about files outside the workspace. |
| P-17 | Symlink skipped in tree hash (test integrity) | `src/evidence.mjs:57-76`, `41-53`, `86-131` | 🟡 | 🟡 | 🟡 | 🟡 Medium | Yes — `entry.isDirectory()`/`entry.isFile()` return false for symlinks, so `findFilesRecursively` silently omits symlinked test files; a test file replaced by a symlink drops out of the hash without a targeted diagnostic. |
| P-18 | Symlinked parent directory in atomic writes | `src/security.mjs:62-88`; `src/evidence.mjs:173-184` | 🔴 | 🔴 | 🟠 (junctions / dev-mode symlinks) | 🔴 Critical | Yes — `safeAtomicWrite` lstat-checks the final path (`68-76`) but never `realpathSync(dirname(filePath))`; `writeFileAtomically` (`173-184`) checks nothing. If `.agent/evidence` or an output dir is a symlink to a directory outside the repo, temp file + rename write outside the working tree. |
| P-19 | Repo-relative path can contain `:` (Windows ADS / `git` subtree) | `src/config.mjs:95-116`; `src/security.mjs:247-284` | ✅ | ✅ | 🟡 | 🟡 Medium | No — this is deliberate/edge; `C:` is treated as a normal segment, which is what makes P-01/P-04 escape checks miss Windows absolute paths. |

---

## 2. Detailed Breakdown of Each Platform Gap

### 2.1 Path Normalization and Case-Folding

#### P-01 / P-04 — Windows drive-letter and UNC absolute paths are not recognized as absolute (`src/config.mjs:77-116`, `src/security.mjs:247-284`)

`normalizePath` (`src/config.mjs:77-79`) only converts separators:

```js
return p.split(sep).join("/").replace(/\\/g, "/");
```

`canonicalizePath` (`src/config.mjs:95-116`) decides absolute-ness with:

```js
const isAbsolutePosix = normalized.startsWith("/");
```

It does **not** consult `node:path.isAbsolute()` / `node:path.win32.isAbsolute()`. Verification probe results:

```
"C:\\Users\\x\\..\\foo"     -> "C:/foo"            (drive letter retained, not flagged)
"C:/../etc/passwd"          -> "etc/passwd"        (drive letter silently dropped; `..` pops it)
"C:/x/.git/config"          -> "C:/x/.git/config"  (not rejected; glob ^\.git/ doesn't match)
"//server/share/.git/config"-> "/server/share/.git/config" (rejected only because leading `/` after collapse)
```

`checkScope` (`src/security.mjs:253-258`) rejects only:

```js
if (file === ".." || file.startsWith("../") || file.startsWith("/")) {
```

So on Windows a caller passing an absolute path such as `C:/x/.git/config` or `C:\Users\me\..\..\outside` gets `ok: true` with **no violations**, even though those paths are outside a repo-relative namespace. This is a silent false-positive in the Scope Guard for any Windows absolute path that reaches `checkScope` (task envelopes, provider payloads, or a future caller). Linux/macOS absolute `/...` paths are correctly rejected; that is why this only shows up on Windows.

#### P-02 — Case folding in `matchesGlob` `src/security.mjs:211-239`

Case-folding is implemented and is correct for the Scope Guard matcher:

- `deny` (`src/security.mjs:219-221`, `276-278`) and `protect` (`src/security.mjs:276-278`) call `matchesGlob(file, pat, { caseInsensitive: true })`.
- `allow` (`src/security.mjs:265-267`) deliberately stays case-sensitive (documented fail-closed).

Probe results:

```
matchesGlob(".GIT/config", ".git/**", { caseInsensitive: true }) => true
matchesGlob("PACKAGE.JSON", "package.json", {}) => false       // allow: fail-closed
matchesGlob("packages/a/Package.JSON", "**/package.json", { caseInsensitive: true }) => true
```

So `.git` vs `.GIT` and `package.json` vs `PACKAGE.JSON` **are** handled at scope-guard matching time. The gaps are not in `matchesGlob`; they are in the string comparisons elsewhere (P-05, P-06).

#### P-05 — Case-sensitive manifest detection in monorepo boundary logic (`src/stack-detector.mjs:284-297`)

`findSubprojectRoot` builds an exact-case list:

```js
const manifestFiles = ["package.json", "foundry.toml", ..., "Cargo.toml", ...];
...
const hasManifest = entries.some(
  (e) => manifestFiles.includes(e) || e.endsWith(".csproj") || e.endsWith(".fsproj")
);
```

On case-insensitive APFS / NTFS the directory entry returned by `readdirSync` carries the on-disk casing. If a repo was first populated on a case-insensitive filesystem with e.g. `Package.JSON` (very common on macOS where the file appears as `package.json` to the shell but git can record either spelling after a rename), `manifestFiles.includes("Package.JSON")` is `false`, so:

- `findSubprojectRoot` returns `.` instead of `packages/app` (`src/stack-detector.mjs:318-320`).
- `resolveWorkspaceBoundary` (`src/stack-detector.mjs:608`) treats the change as a root change.
- `detectCrossPackageBoundaryViolations` skips the package entirely (`src/stack-detector.mjs:338-340`).

Result: a package manifest that git records under a different case is silent — the monorepo boundary audit reports nothing, which is the wrong direction for a security gate.

#### P-06 — Case-sensitive skip set in `findFilesRecursively` (`src/evidence.mjs:64`)

```js
if (entry.name === ".git" || entry.name === "node_modules" || ...)
```

`.GIT`, `.Git`, `.git` are all the same directory on case-insensitive filesystems. When the recorded name is `.GIT`/`.Git`, the skip does not fire and `computeDirectoryHash` recursively hashes the repository metadata. This inflates/changes `treeHash` and `fileCount` in `src/evidence.mjs:86-131`, so evidence-manifest integrity checks can differ between a Linux checkout and a macOS/Windows checkout of the same commit.

### 2.2 Spawning and Shell Differences

#### P-07 — `.cmd`/`.bat` shims in `runCmd` (`src/git.mjs:21-119`)

The Windows shim handling is the best part of the existing code, but it is intentionally narrow:

- `src/git.mjs:46` sets `tokenized = true` only when the command came from a string split on whitespace.
- `src/git.mjs:63` `const winShim = tokenized && process.platform === "win32";`
- `src/git.mjs:80-84` passes `shell: winShim` to `execFileSync`.

Consequences:

- `"npm test"` (string) works on Windows because it is tokenized and runs through `shell: true`.
- `["npm", "test"]` (array) on Windows uses `shell: false` and fails with `spawnSync npm ENOENT`. The comment (`src/git.mjs:57-59`) acknowledges this but the failure mode survives in the public API. Any consumer that passes an array command — the documented `runCmd(command)` interface allows both — hits a silent Windows-only failure.
- A command containing shell metacharacters (`&&`, `|`, `<`, `>`, `;`, etc., detected at `src/git.mjs:39`) goes to `execSync` (`src/git.mjs:72`), which uses `cmd.exe` on Windows and `/bin/sh` on POSIX. That branch is shell-metacharacter aware but does not handle `.ps1`.

#### P-08 — Exec-provider `.cmd` shims (`src/provider.mjs:512-515`)

```js
const res = spawnSync(command, processedArgs, {
  ...
  shell: false,
  ...
});
```

`command` is resolved as `providerSpec.command.split(" ")[0]` (`src/provider.mjs:504`). The built-in exec presets are:

- `CLAUDE_PRESET` command `"claude"` (`src/provider.mjs:78`)
- `CODEX_PRESET` command `"codex"` (`src/provider.mjs:86`)
- `GEMINI_PRESET` command `"gemini"` (`src/provider.mjs:99`)

These are npm-installed CLIs. On Windows the on-disk shims are `claude.cmd`, `codex.cmd`, `gemini.cmd`. `spawnSync(..., { shell:false })` on Windows cannot launch a `.cmd` shim, so the exec provider throws `Provider Exec Failed: spawnSync claude ENOENT`. The error is caught and rethrown as a normal dispatch failure (`src/provider.mjs:517-519`), so an operator sees "provider failed" rather than "cmd shim unsupported on this platform".

#### P-09 — `.ps1` commands are never executed

There is no `powershell`/`pwsh` fallback anywhere in `src/` or `scripts/`. Any `verify`, `build`, `setup`, `teardown`, `server`, or provider command that is a PowerShell script is handed to `cmd.exe` (via `execSync`, `runCmd` `shell:true`, or `probeDevServer`'s `cmd.exe /d /s /c`, `src/engine.mjs:1140`), which fails with `'...' is not recognized as an internal or external command`. This is a Windows-specific deterministic failure with a misleading diagnostic.

#### P-10 — Exit-code reliability (`src/git.mjs:95`)

```js
const status = err.status || (isTimeout ? 124 : 1);
```

- Normal non-zero process exit → `err.status` is a number and is preserved.
- Spawn-level failure (`res.error`, ENOENT) → `err.status` can be `null`; `null` is falsy and is collapsed to `1`, so the caller cannot distinguish "command truly exited 1" from "command was never run".
- Timeout is mapped to `124` (`src/git.mjs:95`), which is not a standard Windows/Node error code but is intentional and documented.

`git()` (`src/git.mjs:131-158`) uses `execFileSync` for git, which is the right approach for `git.exe` when the executable is on PATH. On Windows, `git.exe` (not a `.cmd`) is directly spawnable, so that path is fine; the risk remains in the exec-provider and array-command paths.

#### P-11 — Hard-coded `/bin/sh` in `probeDevServer` (`src/engine.mjs:1139-1141`)

```js
const shellBin = isWin ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
```

macOS ships `/bin/sh` by default, but hardened containers/sandboxes and some macOS environments do not. There is no `process.env.SHELL` / `node:os` fallback, so `probeDevServer` can silently fail to start on those POSIX systems even though POSIX is the "supported" case.

### 2.3 Line Endings and Hash Sentinels

#### P-12 — CRLF inflates `checkRulesBudget` char count (`src/rules-budget.mjs:47-49`)

```js
const content = readFileSync(fullPath, "utf-8");
const charCount = content.length;
const lineCount = content.split("\n").length;
```

On a CRLF checkout (Windows `core.autocrlf=true`, or a macOS repo with CRLF files in `.gitattributes`), each line contributes an extra `\r` char. `content.length` therefore counts CRLF bytes as 2 characters per line. A rules file that is 9,950 chars on LF can be 10,180 chars on CRLF and trip the `10,000` budget (`src/rules-budget.mjs:25`) only on Windows/macOS-CRLF. `lineCount` is unaffected (`\r` stays at the end of each line).

#### P-13 — SHA-256 rules sentinel is raw newline sensitive (`src/rules-budget.mjs:105-160`)

`compileRules`:

```js
const body = sections.join("\n\n---\n\n");                 // line 113
const bodyLen = Buffer.byteLength(body, "utf-8");          // line 114
const sha256 = createHash("sha256").update(body).digest("hex"); // line 115
```

The `body` is built from source files read as UTF-8 (`src/rules-budget.mjs:105`). It is `.trim()`-ed at the ends (`src/rules-budget.mjs:110`), but internal CRLF is preserved. If the same rules directory is compiled on a LF checkout and then on a CRLF checkout, the same semantic content has a different `sha256`, `bodyLen`, and compiled sentinels.

`verifyRulesSentinel` (`src/rules-budget.mjs:126-165`) computes:

```js
const body = compiled.slice(bodyStart, bodyEnd).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
const actualLen = Buffer.byteLength(body, "utf-8");        // line 153
```

It re-hashes the same bytes, so it verifies internally. The practical problem is **cross-environment transport**: if the compiled sentinel is regenerated on Windows, or placed through an LLM/newline-normalizing channel, the sentinel mismatches even though the human-readable rules are identical. This is a false "tampered/truncated" failure rather than a silent pass, but it's still a cross-platform robustness defect.

#### P-14 — Diff payload byte counting is CRLF-safe (`src/git.mjs:246-272`)

`git diff` emits LF regardless of host platform. For untracked files, `diffText` reads `content` and maps `content.split(/\r?\n/)` then joins with `"\n"` (`src/git.mjs:261`), so CRLF is normalized before `diffBytes` (`src/git.mjs:270-272`) measures `Buffer.byteLength(text, "utf-8")`. **No defect here** — but the same `readFileSync` path is where the symlink traversal gap (P-15) lives, because the read happens before normalization.

### 2.4 Symlink and File Descriptor Traversal

#### P-15 — Untracked diff reads through symlinks (`src/git.mjs:256-263`)

```js
const fullPath = join(root, file);
if (existsSync(fullPath)) {
  const content = readFileSync(fullPath, "utf-8");
  ...
}
```

`existsSync` and `readFileSync` follow symbolic links. A symlink named e.g. `packages/app/src/secret.link` that points to `/etc/passwd`, a `~/.aws/credentials`, or `../outside.secret` is reported by `git ls-files --others` as an untracked path, and this code reads the **target content** into `untrackedDiff`. That content then flows through the payload governor and secret scanner, and can:

1. Include out-of-tree secrets in the gate payload (so an operator/user sees secret material in gate output).
2. Make a small symlink appear as a large diff, tripping the payload budget.
3. Provide an attacker a path to feed arbitrary out-of-tree file content into the audit feed.

This is easier to exploit on Linux/macOS, and possible on Windows only when the operator has symlink/junction rights (developer mode or admin). It is the clearest cross-platform symlink traversal in the audit surface.

#### P-16 — Cross-package boundary scan reads through symlinks (`src/stack-detector.mjs:326-331`)

```js
const fullPath = join(root, file);
if (existsSync(fullPath)) {
  try {
    content = readFileSync(fullPath, "utf-8");
  } catch (_) {}
}
```

Same follow-symlink behavior. A changed path that is a symlink can be read as external source and then regex-analysed by `detectCrossPackageBoundaryViolations` (`src/stack-detector.mjs:311-...`). On Linux/macOS this silently escapes the monorepo boundary; on Windows it needs junction/symlink privileges.

#### P-17 — Tree hash silently omits symlinked files (`src/evidence.mjs:57-76`)

`findFilesRecursively` uses `entry.isDirectory()` / `entry.isFile()` and discards everything else:

```js
if (entry.isDirectory()) { ... }
else if (entry.isFile()) { ... }
```

A `Dirent` returned by `readdirSync(dir, { withFileTypes: true })` for a symlink is neither `isDirectory()` nor `isFile()`, so symlinked test files are skipped entirely. `computeDirectoryHash` (`src/evidence.mjs:86-131`) therefore excludes them. This is not a boundary bypass in itself, but it is a blind spot in the "no test weakening" invariant (`src/engine.mjs:442-460`): a symlink pointing at a passing external test file is outside the integrity hash, and the output is a silent omission rather than a diagnostic.

#### P-18 — Atomic writes do not protect a symlinked parent directory (`src/security.mjs:62-88`, `src/evidence.mjs:173-184`)

- `safeAtomicWrite` (`src/security.mjs:62-76`) lstat-checks **only the final path**. If `filePath` is `root/.agent/evidence/manifest.json` and `.agent/evidence` is a symlink to `C:\outside` or `/tmp/outside`, the temp file is opened in `dirname(filePath)` (`src/security.mjs:78-79`) and the rename writes outside the repo.
- `evidence.mjs` `writeFileAtomically` (`src/evidence.mjs:173-184`) has no symlink guard at all: `openSync(tmpPath, "wx")` + `renameSync(tmpPath, filePath)`.

Linux/macOS make this trivial; Windows exposes junctions and (with developer mode) symlinks. The TOCTOU guard in `src/security.mjs` correctly protects the *leaf* but not the *parent chain*, which is a real working-tree boundary gap.

#### P-19 — `resolveRoot`/`execSync` shell usage is broad but not user-controlled (`src/config.mjs:117-119`, `src/budget.mjs:40`, `src/evidence.mjs:199-207`)

These use `execSync("git ...")` with the default shell. On Windows, `cmd.exe` handles `git.exe`; on POSIX `/bin/sh` handles git. There is no user-supplied string in the command, so this is not an injection risk. It is worth documenting only because it depends on the platform shell being present — the same class of concern as P-11.

---

## 3. Windows-specific and Darwin-specific Reproduction Scenarios

### 3.1 Windows-only reproductions

#### W1 — Scope Guard accepts absolute Windows paths (`P-01`, `P-04`)

```
Path: C:\Users\dev\repo\..\..\outside\secrets.txt
Invoke: checkScope(["C:\\Users\\dev\\repo\\..\\..\\outside\\secrets.txt"], scope)
Expected: violation ("Path escapes the repository root")
Actual: ok: true, violations: []
```

```
Path: C:/repo/.git/config   (case variant or Windows-style separator)
Invoke: checkScope(["C:/repo/.git/config"], { deny: [".git/**"] })
Expected: violation (forbidden)
Actual: ok: true (the regex ^\.git/.* is not anchored to the drive-qualified path)
```

This reproduces on any Windows host; it is invisible on Linux/macOS because their absolute paths start with `/` and are rejected at `src/security.mjs:257`.

#### W2 — Exec providers with npm global `.cmd` shims fail ENOENT (`P-08`)

On a Windows box:

```bash
npm install -g @google/gemini-cli
node -e "import('./src/provider.mjs').then(m=>m.createProvider('gemini-flash').dispatch({}, {dryRun:false}).catch(e=>console.log(e.message)))"
```

Observed: `Provider Exec Failed: spawnSync gemini ENOENT`. Same for `claude` (`CLAUDE_PRESET`) and `codex` (`CODEX_PRESET`). The failure has no Windows-specific hint because `spawnSync` is called with `shell:false` at `src/provider.mjs:515`.

#### W3 — Array-form verify commands fail to spawn `npm.cmd` (`P-07`)

```js
import { runCmd } from "./src/git.mjs";
runCmd(["npm", "test"], { cwd: process.cwd(), ignoreError: true });
```

On Windows this returns `status: 1` (or throws if `ignoreError` is false) with `stderr: spawnSync npm ENOENT`. The string form `runCmd("npm test", ...)` works because of `src/git.mjs:63-84`.

#### W4 — PowerShell verify commands are not recognized (`P-09`)

In `.agent/config.yml`:

```yaml
verify:
  test: "test.ps1"
```

On Windows `runCmd("test.ps1", ...)` shells the string through `cmd.exe` and returns `'test.ps1' is not recognized as an internal or external command`. There is no `powershell` fallback in `src/git.mjs` or `src/engine.mjs`.

#### W5 — Off-target atomic write through a junction/symlinked `.agent` directory (`P-18`)

```
mklink /J C:\repo\.agent\evidence C:\outside\evidence
node -e "import('./src/evidence.mjs').then(m=>m.writeEvidenceManifest('C:\\repo', {...}))"
```

`writeEvidenceManifest` (`src/evidence.mjs:228-...`) writes into `C:\outside\evidence`. `safeAtomicWrite` (`src/security.mjs:62-88`) has the same gap for any caller that passes a path under a symlinked directory.

### 3.2 Darwin-specific reproductions

#### D1 — `Package.JSON` monorepo boundary detection silently downgrades (`P-05`)

On default APFS (case-insensitive) run `git mv packages/app/package.json packages/app/Package.JSON` (or create `Package.JSON` on a case-insensitive filesystem). Then:

```js
import { findSubprojectRoot, detectCrossPackageBoundaryViolations } from "./src/stack-detector.mjs";
detectCrossPackageBoundaryViolations(["packages/app/src/index.js"], root);
```

`findSubprojectRoot` returns `.` (because `manifestFiles.includes("Package.JSON")` is false at `src/stack-detector.mjs:296`), so boundary analysis is disabled for that package. The same occurs for `Cargo.TOML`, `go.MOD`, `PyProject.TOML`, etc.

#### D2 — CRLF checkout triggers rules-budget / sentinel differences (`P-12`, `P-13`)

On macOS with `core.autocrlf=input` or a repo whose `.gitattributes` normalizes text, check out the repo and run:

```bash
node -e "import('./src/rules-budget.mjs').then(m=>console.log(m.checkRulesBudget(process.cwd())))"
```

If the checked-out `AGENTS.md`/`.agent/rules/*.md` use CRLF, `charCount` includes `\r` and can trip the `10,000`-char budget on Darwin but not on a LF Linux checkout. Compile the same tree on Linux and macOS: `compileRules().sha256` differs despite identical human content.

#### D3 — Tree hash skips symlinked tests on APFS (`P-17`)

```
ln -s ../tests/fixtures/passing.test.mjs test/secret.test.mjs
node -e "import('./src/evidence.mjs').then(m=>console.log(m.computeDirectoryHash(process.cwd(), { testOnly: true })))"
```

`findFilesRecursively` (`src/evidence.mjs:57-76`) skips `secret.test.mjs` because `Dirent.isFile()` is false for a symlink. On Linux the same behavior occurs; on Darwin default APFS the filesystem caselessness makes it easy to have created such a link without noticing.

#### D4 — `findFilesRecursively` descends into `.GIT` on case-insensitive APFS (`P-06`)

```
mkdir .GIT && touch .GIT/objects/aa/xx
node -e "import('./src/evidence.mjs').then(m=>console.log(m.computeDirectoryHash(process.cwd(), { directories:['.GIT'] })))"
```

Because the skip is `entry.name === ".git"` (exact, `src/evidence.mjs:64`), `.GIT` on a case-insensitive APFS is hashed, so `treeHash` and `fileCount` are DIFFERENT from the same repo where git recorded `.git`.

### 3.3 Linux/macOS cross-platform (also affecting macOS)

#### L1 — Symlink read into untracked diff (`P-15`)

```
echo SECRET > /tmp/secret
ln -s /tmp/secret repo/untracked-link
```

After `git add` / running `gate` with mode `working-tree`, `diffText` (`src/git.mjs:256-263`) reads `/tmp/secret` through `untracked-link` and injects it into the untracked diff payload and secret scan. Reproduces on Linux and macOS; on Windows it needs symlink/junction privileges (W5-style).

#### L2 — Symlink parent in atomic writes (`P-18`)

```
ln -s /tmp/outside repo/.agent/evidence
node -e "import('./src/evidence.mjs').then(m=>m.writeEvidenceManifest('REPO', {...}))"
```

`writeFileAtomically` writes into `/tmp/outside`. `safeAtomicWrite` behaves the same for any caller passing a path under a symlinked directory.

---

## 4. Drop-in Platform-Agnostic Patch Proposals

All proposals use Node.js built-ins from `node:path` and `node:os` (plus `node:fs` stat/realpath primitives already imported). They are intended as drop-in replacements for the specific identified gap, not rewrites.

### 4.0 Shared helpers (add once in `src/config.mjs`, re-export as needed)

```js
import { win32, posix, isAbsolute, relative, resolve, dirname, sep } from "node:path";
import { accessSync } from "node:fs";
import os from "node:os";

const isWin = () => process.platform === "win32";
const isCaseInsensitiveFs = () => process.platform === "win32" || process.platform === "darwin";

/**
 * True for both POSIX and Windows absolute paths (drive letters and UNC).
 * This is the missing piece for checkScope's traversal check.
 */
export function isAbsolutePathAnyPlatform(p) {
  if (!p || typeof p !== "string") return false;
  const posixish = p.replace(/\\/g, "/");
  return posix.isAbsolute(posixish) || win32.isAbsolute(posixish);
}

/**
 * Normalize backslashes to POSIX slashes, then resolve `..` segments WITHOUT
 * interpreting a Windows drive/UNC prefix as an ordinary path segment.
 */
export function canonicalizePath(p) {
  if (!p || typeof p !== "string") return "";
  const normalized = p.split(sep).join("/").replace(/\\/g, "/");

  // Keep a guard for Windows roots so `C:/../x` cannot collapse to `x`.
  const winRootMatch = /^([A-Za-z]:\/)/.exec(normalized);
  const unc = normalized.startsWith("//");

  // ... existing lexical collapse ...
  // Then re-attach winRootMatch[1] if the segments cannot escape above it,
  // and leave UNC strings rooted at "/share/..." so leading "/" stays rejected.
}
```

### P-01 / P-04 — Reject Windows absolute paths in `checkScope`

Replace the traversal check in `src/security.mjs:253-258`:

```js
// Before (security.mjs)
if (file === ".." || file.startsWith("../") || file.startsWith("/")) {
  violations.push({ file, reason: "Path escapes the repository root", ... });
  continue;
}

// After
if (file === ".." || file.startsWith("../") || file.startsWith("/") || isAbsolutePathAnyPlatform(file)) {
  violations.push({ file, reason: "Path escapes the repository root", rule: "deny", pattern: "<traversal>" });
  continue;
}
```

And in `src/config.mjs:canonicalizePath`, detect Windows roots with `win32.isAbsolute()` / `win32.parse()` instead of only `normalized.startsWith("/")`. `C:/` should be treated as absolute (never allowed to collapse `..` above the drive).

### P-02 / P-03 — Keep the current `matchesGlob` design, document the allow fail-closed contract

No change needed to `src/security.mjs:211-239` / `247-284`. Add a unit test that asserts:

- deny/protect ignore case on `win32` and `darwin` (`matchesGlob(".GIT/config", ".git/**", { caseInsensitive: true }) === true`),
- allow stays case-sensitive (`matchesGlob("PACKAGE.JSON", "package.json", {}) === false`).

### P-05 — Case-fold manifest names in monorepo detection

In `src/stack-detector.mjs:284-297`:

```js
const manifestLower = new Set(manifestFiles.map((f) => f.toLowerCase()));
const hasManifest = entries.some(
  (e) => manifestLower.has(e.toLowerCase()) || /\.(csproj|fsproj)$/i.test(e)
);
```

Do this on every platform; a case-insensitive FS is the common failure, and lowercasing on Linux is harmless because git already returns exact names in the common case.

### P-06 — Case-fold directory skip set in tree hashing

In `src/evidence.mjs:64`:

```js
const SKIP_DIRS = new Set([".git", "node_modules", "target", "vendor"]);
...
if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
```

And, to stay platform-agnostic, make `findFilesRecursively` explicitly handle `entry.isSymbolicLink()` (skip or reject) rather than relying on `isDirectory()`/`isFile()` being false.

### P-07 / P-08 / P-09 — One cross-platform command launcher

Introduce a single helper in `src/git.mjs` (or a new `src/exec.mjs`) that resolves `.cmd`/`.bat`/`.ps1` shims and uses the correct platform shell:

```js
import { dirname, basename, join, extname } from "node:path";
import os from "node:os";

const PATHEXT = () => (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";");

function commandCandidates(binary) {
  if (process.platform !== "win32" || extname(binary)) return [binary];
  return PATHEXT().map((ext) => `${binary}${ext}`);
}

function isPowerShell(command) {
  return /\.ps1$/i.test(command) || /powershell(\.exe)?$/i.test(command) || /pwsh(\.exe)?$/i.test(command);
}

export function resolveExecCommand(command) {
  if (process.platform !== "win32") return { binary: command, args: [], useShell: false, shellBin: null, shellArgs: null };

  if (isPowerShell(command)) {
    return {
      binary: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", command],
      useShell: false,
    };
  }

  const candidates = commandCandidates(command);
  for (const c of candidates) {
    try { accessSync(c); return { binary: c, args: [], useShell: false }; } catch (_) {}
  }
  // npm-installed .cmd shims are not discoverable by accessSync on PATH, so fall back to going through the shell on win32.
  return { binary: command, useShell: true, shellBin: process.env.ComSpec || "cmd.exe", shellArgs: ["/d", "/s", "/c"] };
}
```

Then use `shell: true`/`cmd.exe` consistently in:

- `src/git.mjs:63-84` (`runCmd`) — expand the `winShim` branch to commands resolved by `resolveExecCommand`, including `.cmd`/`.bat` from array input and `.ps1`.
- `src/provider.mjs:512-515` — execute exec providers through the resolved shell on Windows instead of `spawnSync(command, args, { shell:false })`. Prefer a no-shell `.cmd` resolution (`candidates`) to avoid double-shell quoting; fall back to `powershell -File` for ps1.
- `src/engine.mjs:1140` — derive `shellBin` from `process.env.ComSpec`/`os.platform()` plus `process.env.SHELL`:

```js
import os from "node:os";
const shellBin = isWin
  ? (process.env.ComSpec || "cmd.exe")
  : (process.env.SHELL || "/bin/sh");
```

To reduce PowerShell startup cost on every `.ps1` run, prefer `process.env.PWSH`/`os.platform()` to pick `pwsh` when present.

### P-10 — Exit-code capture normalization

In `src/git.mjs:95`:

```js
const status = Number.isInteger(err.status) && err.status !== 0
  ? err.status
  : isTimeout ? 124 : 1;
```

Also distinguish a spawn-level failure (where `err.code === "ENOENT"`) explicitly:

```js
if (err.code === "ENOENT") {
  return fail({ code: 127, message: `Command not found: ${binary}` });
}
```

`127` (command-not-found) mirrors shell convention and is distinguishable from a real `1`.

### P-11 — POSIX shell fallback

In `src/engine.mjs:1139-1141` use `os.platform()` and `process.env.SHELL`:

```js
import os from "node:os";
const isWin = process.platform === "win32";
const shellBin = isWin ? (process.env.ComSpec || "cmd.exe") : (process.env.SHELL || "/bin/sh");
```

This also makes the Darwin behavior explicit.

### P-12 / P-13 — Canonicalize line endings before counting / hashing

In `src/rules-budget.mjs`:

```js
// checkRulesBudget, line 47
const content = readFileSync(fullPath, "utf-8").replace(/\r\n?/g, "\n");
const charCount = content.length;
const lineCount = content.split("\n").length;

// compileRules, line 105
const raw = readFileSync(fullPath, "utf-8").replace(/\r\n?/g, "\n");

// verifyRulesSentinel, line 140
const body = compiled.slice(...).replace(/^\n/, "").replace(/\n$/, "")
  .replace(/\r\n?/g, "\n");
```

This makes LF and CRLF checkouts produce identical `len`, `sha256`, and `verifyRulesSentinel` results. Keep `Buffer.byteLength(body, "utf-8")` for the byte count.

### P-14 — Keep current diff normalization; add a unit guard

`diffBytes` (`src/git.mjs:270-272`) is already robust. Add a regression test that runs `diffText` over a CRLF untracked file and asserts `Buffer.byteLength(content, "utf-8")` equals the LF-normalized byte count. No code change required.

### P-15 / P-16 / P-17 — Resolve symlinks and reject reads outside the root

Add a common safe-path helper and use it in `src/git.mjs:256-263`, `src/stack-detector.mjs:326-331`, and `src/evidence.mjs:41-53`:

```js
import { realpathSync, lstatSync } from "node:fs";
import { relative, resolve, dirname } from "node:path";

function isSymlink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch (_) { return false; }
}

function realPathWithinRoot(p, root) {
  const abs = resolve(p);
  const real = realpathSync(abs);
  const rel = relative(resolve(root), real);
  const ok = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  return { ok, real };
}

function safeReadFileWithinRoot(filePath, root) {
  if (isSymlink(filePath)) return null;                   // or throw on rejectSymlinks
  const { ok, real } = realPathWithinRoot(filePath, root);
  if (!ok) return null;
  return readFileSync(real, "utf-8");
}
```

Use it:

```js
// git.mjs:258-259
const content = opts.rejectSymlinks === false ? readFileSync(fullPath, "utf-8") : safeReadFileWithinRoot(fullPath, root);
if (content === null) continue;
```

- For diff collection, reject the symlink rather than silently dropping it, since dropping an untracked file would hide a change the gate was asked to audit. Emit a scope/diagnostic entry.
- For cross-package scanning, use the same safe read.
- For `findFilesRecursively` (`src/evidence.mjs:57-76`), keep skipping symlinks but make it explicit (`if (entry.isSymbolicLink()) continue;`) so the skip is intentional and testable, and add a comment that this is the intended behavior for tree integrity.
- For `computeDirectoryHash` `options.paths` (`src/evidence.mjs:92`), use `lstatSync().isFile()` instead of `statSync().isFile()` (which follows symlinks), so an explicitly passed symlink cannot pull in out-of-tree content.

### P-18 — Guard symlinked parent directories in atomic writes

In `src/security.mjs:safeAtomicWrite` and `src/evidence.mjs:writeFileAtomically`:

```js
import { realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

function assertParentWithinRoot(filePath, root = process.cwd()) {
  const parent = dirname(filePath);
  const realParent = realpathSync(parent);
  const rel = relative(resolve(root), realParent);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`TOCTOU Guard: Refusing to write into symlinked parent ${parent} -> ${realParent}`);
  }
}
```

Call it before computing the temp filename and opening the temp file in `src/security.mjs:78-79` and `src/evidence.mjs:175-177`. For Windows reproducibility, note that junction paths resolve through `realpathSync()` the same way, so this is platform-agnostic.

### P-19 — Shell resolution helper for `execSync` git commands

`resolveRoot` (`src/config.mjs:117-119`) and the `git` provenance calls (`src/budget.mjs:40`, `src/evidence.mjs:199-207`) should use the shared `runCmd`/`git()` helper from `src/git.mjs` rather than raw `execSync` strings. That centralizes shell selection, avoids POSIX-only `/bin/sh` assumptions, and lets the same Windows `.cmd`/`git.exe` resolver serve them.

---

### Appendix A — Test surface that already validates the hard parts

- `test/security.test.mjs` exercises `matchesGlob` case folding and `checkScope`.
- `test/config.test.mjs` exercises `canonicalizePath`.
- `test/monorepo-boundary.test.mjs` exercises `detectCrossPackageBoundaryViolations`.
- `test/scaffold.test.mjs` exercises `ensureGitignore` and `scaffoldRepoAssets`.
- `test/git.test.mjs` exercises `diffText`/`diffBytes`.

No test currently covers: Windows drive/UNC absolute path rejection, exec-provider `.cmd` shims on Windows, `.ps1` execution, CRLF char-budget/sentinel equivalence, or symlink escape in untracked-diff/boundary reads. Those are the highest-value additions for the platform matrix already present in `.github/workflows/jules-audit.yml`.

### Appendix B — Priority order

1. **Immediate (security-critical):** P-01/P-04 (Windows absolute-path scope bypass), P-15 (symlink source-exfiltration into diff), P-18 (symlinked parent write), P-08 (Windows exec providers).
2. **High:** P-07, P-09, P-16.
3. **Medium:** P-05, P-06, P-10, P-11, P-12, P-13, P-17, P-19.
4. **Low/documented:** P-02, P-03, P-14.
