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
