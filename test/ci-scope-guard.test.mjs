import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  evaluateScopeGuard,
  parseLabels,
  loadProtectedPatterns,
  listChangedFiles,
  BYPASS_LABEL,
} from "../scripts/ci-scope-guard.mjs";

const PATTERNS = [
  "package.json",
  "pnpm-lock.yaml",
  ".github/**",
  ".agent/jules.yml",
  ".agent/protected-paths.json",
];

test("CI Agent Scope Guard", async (t) => {
  await t.test("passes when no protected path is touched", () => {
    const res = evaluateScopeGuard(["src/index.mjs", "README.md"], PATTERNS);
    assert.equal(res.ok, true);
    assert.equal(res.violations.length, 0);
  });

  await t.test("blocks a workflow edit through the ** pattern", () => {
    const res = evaluateScopeGuard([".github/workflows/publish.yml"], PATTERNS);
    assert.equal(res.ok, false);
    assert.equal(res.violations.length, 1);
    assert.equal(res.violations[0].file, ".github/workflows/publish.yml");
  });

  await t.test("blocks an exact-path match", () => {
    const res = evaluateScopeGuard(["package.json"], PATTERNS);
    assert.equal(res.ok, false);
  });

  // The bash predecessor built a case-sensitive regex while the local gate
  // deliberately folds case, so `.GitHub/` passed CI and failed locally.
  await t.test("folds case, matching the local gate on APFS/NTFS checkouts", () => {
    const res = evaluateScopeGuard([".GitHub/workflows/publish.yml"], PATTERNS);
    assert.equal(res.ok, false);
  });

  // `for FILE in $MODIFIED_FILES` word-split these into tokens that matched
  // nothing, which let a protected file through on its spelling alone.
  await t.test("matches paths containing spaces and non-ASCII characters", () => {
    const res = evaluateScopeGuard([".github/workflows/min plan.yml"], PATTERNS);
    assert.equal(res.ok, false);

    const nordic = evaluateScopeGuard([".github/säkerhet/nyckel.yml"], PATTERNS);
    assert.equal(nordic.ok, false);
  });

  await t.test("reports every violating file, not just the first", () => {
    const res = evaluateScopeGuard(["package.json", ".github/ci.yml", "src/ok.mjs"], PATTERNS);
    assert.equal(res.ok, false);
    assert.equal(res.violations.length, 2);
  });

  await t.test("bypass label permits the merge but still records the matches", () => {
    const res = evaluateScopeGuard(["package.json"], PATTERNS, { labels: [BYPASS_LABEL] });
    assert.equal(res.ok, true);
    assert.equal(res.bypassed, true);
    assert.equal(res.violations.length, 1, "a waved-through violation must stay in the job log");
  });

  await t.test("an unrelated label does not bypass", () => {
    const res = evaluateScopeGuard(["package.json"], PATTERNS, { labels: ["bug", "agent"] });
    assert.equal(res.ok, false);
    assert.equal(res.bypassed, false);
  });

  await t.test("parseLabels accepts the toJSON array and a plain list", () => {
    assert.deepEqual(parseLabels('["bug","allow-protected-paths"]'), ["bug", BYPASS_LABEL]);
    assert.deepEqual(parseLabels('[{"name":"bug"}]'), ["bug"]);
    assert.deepEqual(parseLabels("bug, allow-protected-paths"), ["bug", BYPASS_LABEL]);
    assert.deepEqual(parseLabels(""), []);
  });

  await t.test("reads the manifest from the base commit and diffs against it", () => {
    const repo = mkdtempSync(join(tmpdir(), "jules-scope-guard-"));
    t.after(() => rmSync(repo, { recursive: true, force: true }));

    const g = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    g("init", "-q", "-b", "main");
    g("config", "user.email", "test@example.com");
    g("config", "user.name", "test");

    mkdirSync(join(repo, ".agent"), { recursive: true });
    writeFileSync(join(repo, ".agent", "protected-paths.json"), JSON.stringify({ protected: [".github/**", "package.json"] }));
    writeFileSync(join(repo, "README.md"), "base\n");
    g("add", "-A");
    g("commit", "-qm", "base");
    const baseSha = g("rev-parse", "HEAD").trim();

    // The head commit both edits a protected file and deletes the manifest that
    // protects it — the exact move reading from the head would have allowed.
    mkdirSync(join(repo, ".github"), { recursive: true });
    writeFileSync(join(repo, ".github", "ci.yml"), "on: push\n");
    writeFileSync(join(repo, "src file.mjs"), "export default 1;\n");
    rmSync(join(repo, ".agent", "protected-paths.json"));
    g("add", "-A");
    g("commit", "-qm", "head");
    const headSha = g("rev-parse", "HEAD").trim();

    const patterns = loadProtectedPatterns({ baseSha, root: repo });
    assert.deepEqual(patterns, [".github/**", "package.json"]);

    const files = listChangedFiles({ baseSha, headSha, root: repo });
    assert.ok(files.includes(".github/ci.yml"));
    assert.ok(files.includes("src file.mjs"), "a path with a space must survive as one entry");

    const res = evaluateScopeGuard(files, patterns);
    assert.equal(res.ok, false);
    assert.ok(res.violations.some((v) => v.file === ".github/ci.yml"));
  });

  await t.test("fails closed when the manifest cannot be read", () => {
    const repo = mkdtempSync(join(tmpdir(), "jules-scope-guard-empty-"));
    t.after(() => rmSync(repo, { recursive: true, force: true }));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, stdio: "ignore" });

    assert.throws(
      () => loadProtectedPatterns({ baseSha: "HEAD", root: repo }),
      /Unable to read \.agent\/protected-paths\.json/
    );
  });
});
