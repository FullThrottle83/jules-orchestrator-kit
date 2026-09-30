#!/usr/bin/env node
/**
 * Arena Scope-Guard Bypass Audit — path-manipulation probe for the CI scope
 * guard, delivered as a standalone Node.js ESM script (zero dependencies).
 *
 * Mission: attempt to circumvent the path validation in
 * scripts/ci-scope-guard.mjs by feeding manipulated "git diff" output through
 * the same parse pipeline the guard uses, and record for every vector whether
 * checkScope() rejects the spelling or lets it through.
 *
 * Pipeline under audit (mirrors scripts/ci-scope-guard.mjs exactly):
 *
 *   raw `git diff -z --name-only <base> <head>` bytes
 *     -> raw.split("\0").map(normalizePath).filter(Boolean)   [listChangedFiles]
 *     -> checkScope(files, { protect: patterns }, { allowProtected: false })
 *     -> matchesGlob(file, pattern, { caseInsensitive: true }) [per pattern]
 *
 * `checkScope` and `matchesGlob` are imported from src/security.mjs as
 * required by the audit spec; `normalizePath` comes from src/config.mjs — the
 * same single implementation listChangedFiles itself uses — so the mocked
 * diff parsing below is byte-for-byte the production parsing.
 *
 * The protect patterns are read from the real .agent/protected-paths.json.
 * Vectors that the current (pure-ASCII) manifest cannot express — Unicode
 * NFC/NFD differences and full case folding — are additionally probed against
 * clearly-labelled synthetic patterns to document the matcher's behaviour for
 * the day a non-ASCII pattern is added.
 *
 * Every case carries a prediction (`expect`). The script exits 0 when the
 * guard behaves exactly as predicted (audit reproduced) and 1 when any outcome
 * drifts — that keeps it useful as a regression probe without pretending the
 * documented bypasses are "test failures".
 *
 * Usage:  node arena-scope-bypass-test.mjs
 *
 * This file is an audit artifact. It changes no repository file and runs no
 * write against this checkout; the only filesystem writes are throwaway
 * fixtures under os.tmpdir().
 */

import { checkScope, matchesGlob } from "./src/security.mjs";
import { normalizePath } from "./src/config.mjs";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = normalizePath(dirname(fileURLToPath(import.meta.url)));
const MANIFEST = join(ROOT, ".agent", "protected-paths.json");

/** Synthetic patterns used only where the ASCII manifest cannot express the vector. */
const SYNTHETIC_UNICODE_PROTECT = ["docs/café.md".normalize("NFC")];
const SYNTHETIC_CASE_PROTECT = ["security/Straße.md", "docs/İstanbul.md"];

/* ------------------------------------------------------------------ *
 * Load the real protected-paths manifest (read-only, never modified).
 * ------------------------------------------------------------------ */
const manifest = JSON.parse(readFileSync(MANIFEST, "utf-8"));
const PROTECT = (manifest.protected || []).filter((p) => typeof p === "string" && p);
if (PROTECT.length === 0) {
  console.error("FATAL: .agent/protected-paths.json lists no protected patterns");
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * Mock git-diff plumbing — the exact shape listChangedFiles produces.
 * ------------------------------------------------------------------ */

/**
 * Parses a raw `git diff -z --name-only` payload the way
 * scripts/ci-scope-guard.mjs listChangedFiles does (line 95):
 *   raw.split("\0").map(normalizePath).filter(Boolean)
 *
 * @param {string} raw - NUL-separated path list as git would emit it
 * @returns {string[]}
 */
function parseMockDiff(raw) {
  return raw.split("\0").map(normalizePath).filter(Boolean);
}

/**
 * Runs one mocked diff payload through the production decision function.
 *
 * @param {string} raw - NUL-separated mock diff output
 * @param {string[]} [patterns] - protect patterns (defaults to the real manifest)
 * @returns {{ files: string[], ok: boolean, violations: Array<object> }}
 */
function runGuard(raw, patterns = PROTECT) {
  const files = parseMockDiff(raw);
  const res = checkScope(files, { protect: patterns }, { allowProtected: false });
  return { files, ok: res.ok, violations: res.violations };
}

const CAUGHT = "CAUGHT";
const BYPASSED = "BYPASSED";
const SKIPPED = "SKIPPED";

/** @returns {typeof CAUGHT|typeof BYPASSED} */
function verdictOf(res) {
  return res.ok ? BYPASSED : CAUGHT;
}

/** Human-readable reason: which rule/pattern fired, or that nothing matched. */
function detailOf(res) {
  if (!res.violations || res.violations.length === 0) return "no pattern matched";
  return res.violations.map((v) => `${v.rule}:${v.pattern}`).join(", ");
}

/* ------------------------------------------------------------------ *
 * Result bookkeeping.
 * ------------------------------------------------------------------ */
const results = [];

/**
 * @param {{ vector: string, id: string, desc: string,
 *           expect: string, actual: string, detail?: string, note?: string }} row
 */
function record(row) {
  const drift = row.actual !== SKIPPED && row.actual !== row.expect;
  results.push({ ...row, drift });
}

function printRow(row) {
  const status = row.drift ? "  <== UNEXPECTED" : "";
  const detail = row.detail ? `  [${row.detail}]` : "";
  const note = row.note ? `  [${row.note}]` : "";
  console.log(
    `  ${row.id.padEnd(4)} ${row.desc.padEnd(56)} expect=${row.expect.padEnd(8)} got=${row.actual.padEnd(8)}${detail}${note}${status}`
  );
}

/* ------------------------------------------------------------------ *
 * Real-git fixture helpers (used where mock output alone cannot prove the
 * production pipeline behaviour). Every experiment runs in os.tmpdir().
 * ------------------------------------------------------------------ */
let gitAvailable = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch (_) {
  gitAvailable = false;
}

/** Runs git in cwd, stdout returned as utf-8. */
function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

const tmpDirs = [];
function makeTmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function initRepo() {
  const dir = makeTmp("arena-bypass-git-");
  git(["init", "-q"], dir);
  git(["config", "user.email", "arena-audit@example.invalid"], dir);
  git(["config", "user.name", "arena-scope-bypass-audit"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  return dir;
}

function commitAll(dir, message) {
  git(["add", "-A"], dir);
  git(["commit", "-qm", message], dir);
  return git(["rev-parse", "HEAD"], dir).trim();
}

/** The exact command scripts/ci-scope-guard.mjs line 92 runs. */
function guardDiffCmd(dir, baseSha, headSha, extra = []) {
  return git(
    ["-c", "core.quotePath=false", "diff", "-z", "--name-only", ...extra, baseSha, headSha],
    dir
  );
}

function safeRealGitCase(vector, id, desc, expect, fn) {
  if (!gitAvailable) {
    record({ vector, id, desc, expect, actual: SKIPPED, note: "git not available" });
    return;
  }
  try {
    fn();
  } catch (err) {
    record({
      vector,
      id,
      desc,
      expect,
      actual: SKIPPED,
      note: `fixture error: ${String(err.message).split("\n")[0]}`,
    });
  }
}

/* ================================================================== *
 * VECTOR A — Symlink traversal:
 * git-diff name does not match a protected pattern, link target does.
 * ================================================================== */
function vectorA() {
  console.log("\n[a] Symlink traversal (diff name != link target)");

  const linkTmp = makeTmp("arena-bypass-link-");
  const fileLink = join(linkTmp, "manifest-link.json");
  const dirLink = join(linkTmp, "guard");
  symlinkSync(join(ROOT, ".agent", "protected-paths.json"), fileLink);
  symlinkSync(join(ROOT, ".github"), dirLink);

  // a1: git reports the *symlink path* when the link entry itself changes.
  // checkScope is purely lexical (src/scope-guard.mjs has no fs import), so
  // the link name — unlike its target — matches nothing.
  const linkRel = "docs/manifest-link.json";
  const resA1 = runGuard(`${linkRel}\0src/ok.mjs`);
  const realTarget = normalizePath(relative(ROOT, realpathSync(fileLink)));
  record({
    vector: "a",
    id: "a1",
    desc: "file symlink name, target is protected manifest",
    expect: BYPASSED,
    actual: verdictOf(resA1),
    detail: detailOf(resA1),
    note: `realpath -> ${realTarget}; target-pattern matches name=${matchesGlob(linkRel, ".agent/protected-paths.json", { caseInsensitive: true })}`,
  });

  // a2: symlinked *directory* — realpath(file under link) lands inside .github/**.
  const dirLinkEntry = "guard/workflows/agent-scope-guard.yml";
  const resA2 = runGuard(`${dirLinkEntry}\0src/ok.mjs`);
  const resolvedRel = normalizePath(relative(ROOT, join(realpathSync(dirLink), "workflows", "agent-scope-guard.yml")));
  record({
    vector: "a",
    id: "a2",
    desc: "symlinked dir name hides .github/** target",
    expect: BYPASSED,
    actual: verdictOf(resA2),
    detail: detailOf(resA2),
    note: `realpath -> ${resolvedRel}; target matches=.github/**=${matchesGlob(resolvedRel, ".github/**", { caseInsensitive: true })}`,
  });

  // a3: end-to-end with real git — append THROUGH the symlink, commit, run the
  // guard's exact diff command. Git reports the real target path, so the
  // production pipeline catches it even though checkScope never resolves links.
  safeRealGitCase("a", "a3", "real git: edit through symlink, guard cmd", CAUGHT, () => {
    const repo = initRepo();
    writeFileSync(join(repo, "package.json"), '{"name":"audit"}\n');
    mkdirSync(join(repo, "docs"));
    symlinkSync("../package.json", join(repo, "docs", "link.json"));
    const base = commitAll(repo, "base with symlink");
    appendFileSync(join(repo, "docs", "link.json"), '{"throughLink":true}\n');
    const head = commitAll(repo, "edit through symlink");
    const res = runGuard(guardDiffCmd(repo, base, head));
    record({
      vector: "a",
      id: "a3",
      desc: "real git: edit through symlink, guard cmd",
      expect: CAUGHT,
      actual: verdictOf(res),
      detail: detailOf(res),
      note: `git reported: ${JSON.stringify(res.files)}`,
    });
  });
}

/* ================================================================== *
 * VECTOR B — Unicode normalisation: NFC vs NFD spellings.
 * ================================================================== */
function vectorB() {
  console.log("\n[b] Unicode normalisation (NFC / NFD decomposition)");

  const nfc = "docs/café.md".normalize("NFC");
  const nfd = "docs/café.md".normalize("NFD");

  // b1: pattern in NFC, git reports the NFD spelling (macOS/HFS+ checkouts
  // store decomposed names). Latent for the real manifest: it is pure ASCII.
  const resB1 = runGuard(`${nfd}\0src/ok.mjs`, SYNTHETIC_UNICODE_PROTECT);
  record({
    vector: "b",
    id: "b1",
    desc: "NFD path vs NFC synthetic protect pattern",
    expect: BYPASSED,
    actual: verdictOf(resB1),
    detail: detailOf(resB1),
    note: `matchesGlob(NFD, NFC)=${matchesGlob(nfd, nfc, { caseInsensitive: true })}`,
  });

  // b2: control — same synthetic pattern, NFC spelling: caught.
  const resB2 = runGuard(`${nfc}\0src/ok.mjs`, SYNTHETIC_UNICODE_PROTECT);
  record({
    vector: "b",
    id: "b2",
    desc: "control: NFC path vs NFC synthetic pattern",
    expect: CAUGHT,
    actual: verdictOf(resB2),
    detail: detailOf(resB2),
  });

  // b3: against the REAL manifest every pattern is ASCII, and NFD/NFC of an
  // ASCII string is identical — the current manifest is structurally immune.
  const asciiNfd = "package.json".normalize("NFD");
  const resB3 = runGuard(`${asciiNfd}\0src/ok.mjs`);
  record({
    vector: "b",
    id: "b3",
    desc: "real manifest: NFD of ASCII package.json",
    expect: CAUGHT,
    actual: verdictOf(resB3),
    detail: detailOf(resB3),
    note: "ASCII patterns are NFC==NFD",
  });
}

/* ================================================================== *
 * VECTOR C — Case folding: Package.JSON vs package.json.
 * ================================================================== */
function vectorC() {
  console.log("\n[c] Case folding (PACKAGE.JSON vs package.json)");

  const c1 = runGuard("PACKAGE.JSON\0src/ok.mjs");
  record({
    vector: "c",
    id: "c1",
    desc: "PACKAGE.JSON against real manifest",
    expect: CAUGHT,
    actual: verdictOf(c1),
    detail: detailOf(c1),
  });

  const c2 = runGuard(".GitHub/workflows/agent-scope-guard.yml\0src/ok.mjs");
  record({
    vector: "c",
    id: "c2",
    desc: ".GitHub/** spelling against real manifest",
    expect: CAUGHT,
    actual: verdictOf(c2),
    detail: detailOf(c2),
  });

  const c3 = runGuard("SCRIPTS\\CI-SCOPE-GUARD.MJS\0src/ok.mjs");
  record({
    vector: "c",
    id: "c3",
    desc: "case + backslash combined (SCRIPTS\\CI-...)",
    expect: CAUGHT,
    actual: verdictOf(c3),
    detail: detailOf(c3),
  });

  // c4/c5: String.prototype.toLowerCase() is *not* Unicode full case folding.
  // "ß" never becomes "SS" through toLowerCase, and "İ" (U+0130) lowercases
  // to "i" + U+0307 — neither equals its counterpart, so caseInsensitive
  // matching misses both.
  const c4 = runGuard("security/STRASSE.md\0src/ok.mjs", SYNTHETIC_CASE_PROTECT);
  record({
    vector: "c",
    id: "c4",
    desc: "STRASSE vs Straße synthetic (full case fold missing)",
    expect: BYPASSED,
    actual: verdictOf(c4),
    detail: detailOf(c4),
    note: `matchesGlob=${matchesGlob("security/STRASSE.md", "security/Straße.md", { caseInsensitive: true })}`,
  });

  const c5 = runGuard("docs/istanbul.md\0src/ok.mjs", SYNTHETIC_CASE_PROTECT);
  record({
    vector: "c",
    id: "c5",
    desc: "istanbul vs Istanbul-dot synthetic (U+0130 fold)",
    expect: BYPASSED,
    actual: verdictOf(c5),
    detail: detailOf(c5),
    note: `pattern.toLowerCase()=${"docs/İstanbul.md".toLowerCase()}`,
  });
}

/* ================================================================== *
 * VECTOR D — Path separators: backslash vs slash in glob matching.
 * ================================================================== */
function vectorD() {
  console.log("\n[d] Path separators (backslash vs slash)");

  const d1 = runGuard("scripts\\ci-scope-guard.mjs\0src/ok.mjs");
  record({
    vector: "d",
    id: "d1",
    desc: "scripts\\ci-scope-guard.mjs (exact protect)",
    expect: CAUGHT,
    actual: verdictOf(d1),
    detail: detailOf(d1),
  });

  const d2 = runGuard(".github\\workflows\\ci.yml\0src/ok.mjs");
  record({
    vector: "d",
    id: "d2",
    desc: ".github\\workflows\\ci.yml (glob protect)",
    expect: CAUGHT,
    actual: verdictOf(d2),
    detail: detailOf(d2),
  });

  const d3 = runGuard(".agent\\protected-paths.json\0src/ok.mjs");
  record({
    vector: "d",
    id: "d3",
    desc: ".agent\\protected-paths.json (manifest protect)",
    expect: CAUGHT,
    actual: verdictOf(d3),
    detail: detailOf(d3),
  });

  const d4 = runGuard("..\\.agent\\protected-paths.json\0src/ok.mjs");
  record({
    vector: "d",
    id: "d4",
    desc: "backslash traversal escape (..\\.agent\\...)",
    expect: CAUGHT,
    actual: verdictOf(d4),
    detail: detailOf(d4),
  });

  // d5: direct matchesGlob probe — canonicalizePath inside matchesGlob folds
  // backslashes on both sides before segment comparison.
  const d5 = matchesGlob("scripts\\ci-scope-guard.mjs", "scripts/ci-scope-guard.mjs", {
    caseInsensitive: true,
  });
  record({
    vector: "d",
    id: "d5",
    desc: "direct matchesGlob probe with backslash path",
    expect: CAUGHT,
    actual: d5 ? CAUGHT : BYPASSED,
    detail: `matchesGlob=${d5}`,
  });
}

/* ================================================================== *
 * VECTOR E — Dot-dot traversal: foo/../.agent/protected-paths.json.
 * ================================================================== */
function vectorE() {
  console.log("\n[e] Dot-dot traversal (foo/../.agent/...)");

  const e1 = runGuard("foo/../.agent/protected-paths.json\0src/ok.mjs");
  record({
    vector: "e",
    id: "e1",
    desc: "foo/../.agent/protected-paths.json",
    expect: CAUGHT,
    actual: verdictOf(e1),
    detail: detailOf(e1),
  });

  const e2 = runGuard("../.agent/protected-paths.json\0src/ok.mjs");
  record({
    vector: "e",
    id: "e2",
    desc: "../.agent/... escapes repo root (deny)",
    expect: CAUGHT,
    actual: verdictOf(e2),
    detail: detailOf(e2),
  });

  const e3 = runGuard(".agent/jules.yml/../../package.json\0src/ok.mjs");
  record({
    vector: "e",
    id: "e3",
    desc: "deep traversal resolving onto package.json",
    expect: CAUGHT,
    actual: verdictOf(e3),
    detail: detailOf(e3),
  });

  const e4 = runGuard("./package.json\0src/ok.mjs");
  record({
    vector: "e",
    id: "e4",
    desc: "./package.json leading-dot segment",
    expect: CAUGHT,
    actual: verdictOf(e4),
    detail: detailOf(e4),
  });

  const e5 = runGuard(".agent//protected-paths.json\0src/ok.mjs");
  record({
    vector: "e",
    id: "e5",
    desc: "double-slash .agent//protected-paths.json",
    expect: CAUGHT,
    actual: verdictOf(e5),
    detail: detailOf(e5),
  });

  // e6: canonicalises to the empty string — checkScope has no empty-path rule,
  // so it falls through every matcher as "no match". git never emits this
  // spelling, but the pure function accepts it (fail-open edge case).
  const e6 = runGuard("package.json/..\0src/ok.mjs");
  record({
    vector: "e",
    id: "e6",
    desc: "canonicalises to empty (package.json/..)",
    expect: BYPASSED,
    actual: verdictOf(e6),
    detail: detailOf(e6),
    note: "empty canonical path has no rule",
  });
}

/* ================================================================== *
 * VECTOR F — NUL-byte injection in path strings.
 * ================================================================== */
function vectorF() {
  console.log("\n[f] NUL-byte injection");

  // f1: a JS string containing NUL fed *directly* to checkScope — the shape
  // reached by non-git callers (src/envelope.mjs:106,
  // src/task-optimizer.mjs:201) that read agent-supplied JSON paths. The
  // matcher treats NUL as an ordinary character: no C-style truncation, so
  // "package.json\0.md" simply is not "package.json" and matches nothing.
  const f1 = checkScope(["package.json\u0000.md"], { protect: PROTECT }, { allowProtected: false });
  record({
    vector: "f",
    id: "f1",
    desc: "direct: package.json\\0.md (NUL inside path string)",
    expect: BYPASSED,
    actual: verdictOf(f1),
    detail: detailOf(f1),
    note: "needs a NUL-truncating consumer to exploit",
  });

  // f2: NUL injected into the raw diff *stream*. Because listChangedFiles
  // splits on NUL, injection can only create extra entries — it cannot hide a
  // protected name that follows the injected NUL.
  const f2 = runGuard("docs/ok.mjs\0package.json\0src/thing.mjs");
  record({
    vector: "f",
    id: "f2",
    desc: "raw stream: NUL before protected name",
    expect: CAUGHT,
    actual: verdictOf(f2),
    detail: detailOf(f2),
    note: `parsed ${f2.files.length} entries`,
  });

  // f3: leading/duplicate NULs produce empty tokens that filter(Boolean) drops.
  const f3 = runGuard("\0\0package.json\0");
  record({
    vector: "f",
    id: "f3",
    desc: "raw stream: leading/duplicate NUL padding",
    expect: CAUGHT,
    actual: verdictOf(f3),
    detail: detailOf(f3),
  });
}

/* ================================================================== *
 * VECTOR G — git core.quotePath exploitation: quoted / octal-escaped names.
 * ================================================================== */
function vectorG() {
  console.log("\n[g] git core.quotePath (quoted / octal-escaped names)");

  // g1: a path git wrapped in double quotes (what a non-`-z` parser would
  // receive). checkScope never unquotes, so the wrapped name misses.
  const g1 = runGuard('"package.json"\0src/ok.mjs');
  record({
    vector: "g",
    id: "g1",
    desc: 'quoted spelling "package.json"',
    expect: BYPASSED,
    actual: verdictOf(g1),
    detail: detailOf(g1),
  });

  // g2: octal-escaped UTF-8 (`core.quotePath=true`, no -z) as git emits it:
  // "docs/caf\303\251.md" — literal quotes plus octal bytes, matched against
  // the NFC synthetic pattern.
  const octal = '"docs/caf\\303\\251.md"';
  const g2 = runGuard(`${octal}\0src/ok.mjs`, SYNTHETIC_UNICODE_PROTECT);
  record({
    vector: "g",
    id: "g2",
    desc: "octal-escaped UTF-8 name vs NFC synthetic pattern",
    expect: BYPASSED,
    actual: verdictOf(g2),
    detail: detailOf(g2),
    note: `literal: ${octal}`,
  });

  // g2b: control — verbatim NFC name is caught by the same synthetic pattern.
  const g2b = runGuard("docs/café.md\0src/ok.mjs", SYNTHETIC_UNICODE_PROTECT);
  record({
    vector: "g",
    id: "g2b",
    desc: "control: verbatim NFC name vs synthetic pattern",
    expect: CAUGHT,
    actual: verdictOf(g2b),
    detail: detailOf(g2b),
  });

  // g3: end-to-end with real git — same commit range, two invocations:
  //   (a) plain `git diff --name-only` (default core.quotePath, no -z)
  //       -> git quotes/escapes -> checkScope misses (bypass).
  //   (b) the guard's exact command (-c core.quotePath=false -z)
  //       -> verbatim path -> caught.
  safeRealGitCase("g", "g3", "real git: quoted vs -z pipeline on unicode name", CAUGHT, () => {
    const repo = initRepo();
    const nfcPath = "docs/café.md".normalize("NFC");
    mkdirSync(join(repo, "docs"));
    writeFileSync(join(repo, nfcPath), "v1\n");
    const base = commitAll(repo, "base");
    appendFileSync(join(repo, nfcPath), "v2\n");
    const head = commitAll(repo, "edit");

    const naiveRaw = git(["diff", "--name-only", base, head], repo);
    const naiveFiles = naiveRaw.split("\n").map(normalizePath).filter(Boolean);
    const naiveRes = checkScope(naiveFiles, { protect: SYNTHETIC_UNICODE_PROTECT }, { allowProtected: false });
    record({
      vector: "g",
      id: "g3a",
      desc: "real git: default quotePath, no -z (quoted out)",
      expect: BYPASSED,
      actual: verdictOf(naiveRes),
      detail: detailOf(naiveRes),
      note: `git raw=${JSON.stringify(naiveRaw.trim())} parsed=${JSON.stringify(naiveFiles)}`,
    });

    const guardRes = runGuard(guardDiffCmd(repo, base, head), SYNTHETIC_UNICODE_PROTECT);
    record({
      vector: "g",
      id: "g3b",
      desc: "real git: guard command (-z, quotePath=false)",
      expect: CAUGHT,
      actual: verdictOf(guardRes),
      detail: detailOf(guardRes),
      note: `git emitted: ${JSON.stringify(guardRes.files)}`,
    });
  });
}

/* ================================================================== *
 * BONUS H — Rename-away: `git mv package.json elsewhere`.
 * Not one of the mandated vectors, but observed while building them:
 * listChangedFiles omits --no-renames, and with rename detection ON
 * `--name-only` reports ONLY the destination, so the protected source
 * name never reaches checkScope. src/git.mjs passes --no-renames for
 * exactly this reason (lines 591-622); ci-scope-guard does not.
 * ================================================================== */
function vectorH() {
  console.log("\n[h] Bonus: rename-away from a protected path (real git)");

  safeRealGitCase("h", "h1", "real git: rename-away from protected path", BYPASSED, () => {
    const repo = initRepo();
    writeFileSync(join(repo, "package.json"), '{"name":"audit"}\n');
    const base = commitAll(repo, "base");
    mkdirSync(join(repo, "docs"));
    git(["mv", "package.json", "docs/renamed.json"], repo);
    const head = commitAll(repo, "rename package.json away");

    // The guard's exact command, rename detection at git's default (on).
    const res = runGuard(guardDiffCmd(repo, base, head));
    record({
      vector: "h",
      id: "h1",
      desc: "git mv package.json -> docs/renamed.json (guard cmd)",
      expect: BYPASSED,
      actual: verdictOf(res),
      detail: detailOf(res),
      note: `git reported: ${JSON.stringify(res.files)}`,
    });

    // Control: --no-renames (as src/git.mjs uses) lists both sides.
    const resNo = runGuard(guardDiffCmd(repo, base, head, ["--no-renames"]));
    record({
      vector: "h",
      id: "h2",
      desc: "same diff with --no-renames (control)",
      expect: CAUGHT,
      actual: verdictOf(resNo),
      detail: detailOf(resNo),
      note: `git reported: ${JSON.stringify(resNo.files)}`,
    });
  });
}

/* ------------------------------------------------------------------ *
 * Runner.
 * ------------------------------------------------------------------ */
function main() {
  console.log("Scope Guard Bypass Audit — arena-scope-bypass-test.mjs");
  console.log(
    `node ${process.version}, git ${gitAvailable ? "available" : "NOT available (real-git cases will be skipped)"}`
  );
  console.log(`Protect patterns (${PROTECT.length}) from .agent/protected-paths.json:`);
  for (const p of PROTECT) console.log(`  - ${p}`);
  console.log("Synthetic (clearly-labelled, not in the manifest):");
  for (const p of [...SYNTHETIC_UNICODE_PROTECT, ...SYNTHETIC_CASE_PROTECT]) console.log(`  - ${p}`);

  vectorA();
  vectorB();
  vectorC();
  vectorD();
  vectorE();
  vectorF();
  vectorG();
  vectorH();

  console.log("\n================ RESULTS ================");
  let current = "";
  for (const row of results) {
    if (row.vector !== current) {
      current = row.vector;
      console.log(`\n[${current}]`);
    }
    printRow(row);
  }

  const caught = results.filter((r) => r.actual === CAUGHT).length;
  const bypassed = results.filter((r) => r.actual === BYPASSED).length;
  const skipped = results.filter((r) => r.actual === SKIPPED).length;
  const drift = results.filter((r) => r.drift);

  console.log("\n================ SUMMARY ================");
  console.log(
    `cases: ${results.length}   caught: ${caught}   bypassed: ${bypassed}   skipped: ${skipped}   unexpected drift: ${drift.length}`
  );
  const bypassVectors = [...new Set(results.filter((r) => r.actual === BYPASSED).map((r) => r.vector))];
  console.log(`vectors with at least one bypass: ${bypassVectors.length ? bypassVectors.sort().join(", ") : "none"}`);
  console.log("Verdict key: CAUGHT = checkScope rejected the spelling; BYPASSED = guard passed it.");
  console.log("See arena-scope-bypass-report.md for the pass/fail matrix, the exact patterns");
  console.log("that missed, and a difficulty rating per vector.");

  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
  }

  if (drift.length > 0) {
    console.error(`\nFAIL: ${drift.length} case(s) deviated from the audited prediction.`);
    process.exit(1);
  }
  console.log("\nOK: all audited outcomes reproduced as predicted.");
  process.exit(0);
}

main();
