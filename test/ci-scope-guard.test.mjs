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
  listChangedEntries,
  resolveLinkTarget,
  BYPASS_LABEL,
  LEGACY_BYPASS_LABEL,
} from "../scripts/ci-scope-guard.mjs";
import {
  checkScope,
  isProtectedWorkflowException,
  isUnwaivableForbiddenPath,
  UNWAIVABLE_DENY_PATTERNS,
} from "../src/security.mjs";
import { BUILTIN_DENY, CI_DEFINITIONS } from "../src/config.mjs";

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
    const res = evaluateScopeGuard([".github/workflows/release plan.yml"], PATTERNS);
    assert.equal(res.ok, false);

    const unicodePath = evaluateScopeGuard([".github/secrets/schlüssel.yml"], PATTERNS);
    assert.equal(unicodePath.ok, false);
  });

  await t.test("reports every violating file, not just the first", () => {
    const res = evaluateScopeGuard(["package.json", ".github/ci.yml", "src/ok.mjs"], PATTERNS);
    assert.equal(res.ok, false);
    assert.equal(res.violations.length, 2);
  });

  await t.test("canonical SHA-bound bypass label conforms to GitHub 50-character maximum name limit", () => {
    const GITHUB_LABEL_MAX_LENGTH = 50;
    const dummySha = "0123456789abcdef0123456789abcdef01234567";
    const boundLabel = `${BYPASS_LABEL}:${dummySha}`;
    assert.equal(boundLabel.length, 48);
    assert.ok(
      boundLabel.length <= GITHUB_LABEL_MAX_LENGTH,
      `Label "${boundLabel}" (${boundLabel.length} chars) exceeds GitHub limit of ${GITHUB_LABEL_MAX_LENGTH} characters`
    );

    // Document why the legacy label cannot be created with full SHA on GitHub
    const legacyBoundLabel = `${LEGACY_BYPASS_LABEL}:${dummySha}`;
    assert.equal(legacyBoundLabel.length, 62);
    assert.ok(legacyBoundLabel.length > GITHUB_LABEL_MAX_LENGTH, "legacy label with SHA exceeds provider limit");
  });

  await t.test("bypass label permits the merge but still records the matches", () => {
    const res = evaluateScopeGuard(["package.json"], PATTERNS, { labels: [BYPASS_LABEL] });
    assert.equal(res.ok, true);
    assert.equal(res.bypassed, true);
    assert.equal(res.violations.length, 1, "a waved-through violation must stay in the job log");

    const legacyRes = evaluateScopeGuard(["package.json"], PATTERNS, { labels: [LEGACY_BYPASS_LABEL] });
    assert.equal(legacyRes.ok, true);
    assert.equal(legacyRes.bypassed, true);
  });

  await t.test("an unrelated label does not bypass", () => {
    const res = evaluateScopeGuard(["package.json"], PATTERNS, { labels: ["bug", "agent"] });
    assert.equal(res.ok, false);
    assert.equal(res.bypassed, false);
  });

  await t.test("SHA-bound bypass label permits the merge when headSha matches", () => {
    const shaA = "2f5c19b111111111111111111111111111111111";
    const res = evaluateScopeGuard(["package.json"], PATTERNS, {
      labels: [`${BYPASS_LABEL}:${shaA}`],
      headSha: shaA,
    });
    assert.equal(res.ok, true);
    assert.equal(res.bypassed, true);

    const legacyRes = evaluateScopeGuard(["package.json"], PATTERNS, {
      labels: [`${LEGACY_BYPASS_LABEL}:${shaA}`],
      headSha: shaA,
    });
    assert.equal(legacyRes.ok, true);
    assert.equal(legacyRes.bypassed, true);
  });

  await t.test("stale SHA-bound bypass label rejects new headSha", () => {
    const shaA = "2f5c19b111111111111111111111111111111111";
    const shaB = "3a8d9e1222222222222222222222222222222222";
    const res = evaluateScopeGuard(["package.json"], PATTERNS, {
      labels: [`${BYPASS_LABEL}:${shaA}`],
      headSha: shaB,
    });
    assert.equal(res.ok, false);
    assert.equal(res.bypassed, false);
  });

  await t.test("two different 40-char SHAs sharing the first 7 hex digits do NOT share approval", () => {
    const shaA = "2f5c19b111111111111111111111111111111111";
    const shaB = "2f5c19b222222222222222222222222222222222";
    const res = evaluateScopeGuard(["package.json"], PATTERNS, {
      labels: [`${BYPASS_LABEL}:${shaA}`],
      headSha: shaB,
    });
    assert.equal(res.ok, false);
    assert.equal(res.bypassed, false);
  });

  await t.test("unbound bypass label is rejected when headSha is provided", () => {
    const shaA = "2f5c19b111111111111111111111111111111111";
    const res = evaluateScopeGuard(["package.json"], PATTERNS, {
      labels: [BYPASS_LABEL],
      headSha: shaA,
    });
    assert.equal(res.ok, false);
    assert.equal(res.bypassed, false);

    const legacyRes = evaluateScopeGuard(["package.json"], PATTERNS, {
      labels: [LEGACY_BYPASS_LABEL],
      headSha: shaA,
    });
    assert.equal(legacyRes.ok, false);
    assert.equal(legacyRes.bypassed, false);
  });

  await t.test("parseLabels accepts the toJSON array and a plain list", () => {
    assert.deepEqual(parseLabels('["bug","allow-p"]'), ["bug", BYPASS_LABEL]);
    assert.deepEqual(parseLabels('[{"name":"bug"}]'), ["bug"]);
    assert.deepEqual(parseLabels("bug, allow-p"), ["bug", BYPASS_LABEL]);
    assert.deepEqual(parseLabels("bug, allow-protected-paths"), ["bug", LEGACY_BYPASS_LABEL]);
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

  await t.test("checkScope allows CI workflow files when allowProtected is true, but rejects without it", () => {
    const scope = {
      deny: [...BUILTIN_DENY, "forbidden-custom/**"],
      protect: ["package.json"],
    };

    // Unapproved => rejected (exit 3)
    const unapproved = checkScope([".github/workflows/ci.yml"], scope, { allowProtected: false });
    assert.equal(unapproved.ok, false);
    assert.equal(unapproved.violations[0].rule, "deny");
    assert.equal(unapproved.violations[0].pattern, ".github/**");

    // Approved => authorized
    const approved = checkScope([".github/workflows/ci.yml"], scope, { allowProtected: true });
    assert.equal(approved.ok, true);
    assert.equal(approved.violations.length, 0);

    // Other forge definitions in CI_DEFINITIONS are also covered
    assert.ok(CI_DEFINITIONS.includes(".github/**"));
    const gitlabApproved = checkScope([".gitlab-ci.yml"], scope, { allowProtected: true });
    assert.equal(gitlabApproved.ok, true);

    // Non-CI forbidden path is NOT waivable
    const customForbidden = checkScope(["forbidden-custom/script.sh"], scope, { allowProtected: true });
    assert.equal(customForbidden.ok, false);
    assert.equal(customForbidden.violations[0].rule, "deny");
  });

  await t.test("unwaivable deny patterns can never be bypassed even when allowProtected is true", () => {
    assert.ok(Array.isArray(UNWAIVABLE_DENY_PATTERNS) && UNWAIVABLE_DENY_PATTERNS.length > 0);
    const scope = {
      deny: [...BUILTIN_DENY, "**/secrets/**", "**/lock-manager/**"],
      protect: [".github/**"],
    };

    const unwaivableCases = [
      ".env",
      ".env.local",
      "server.key",
      "cert.pem",
      "id_rsa",
      "id_ed25519",
      ".aws/credentials",
      ".ssh/id_rsa",
      "credentials.json",
      "service-account.json",
      "terraform.tfstate",
      ".github/workflows/secrets.pem",
      ".github/lock-manager/lock.json",
      "secrets/token.txt",
    ];

    for (const file of unwaivableCases) {
      const res = checkScope([file], scope, { allowProtected: true });
      assert.equal(res.ok, false, `${file} must be denied even under allowProtected: true`);
      assert.equal(res.violations[0].rule, "deny");
      assert.equal(isUnwaivableForbiddenPath(file), true, `${file} must be detected as unwaivable`);
      assert.equal(isProtectedWorkflowException(file, res.violations[0].pattern, { allowProtected: true }), false);
    }

    // Committed env template is an exception to .env deny
    assert.equal(isUnwaivableForbiddenPath(".env.example"), false);
  });

  await t.test("blocks symlinks whose target matches a protected pattern", () => {
    const res = evaluateScopeGuard(
      [
        {
          file: "src/innocent.js",
          dstMode: "120000",
          symlinkTarget: ".github/workflows/deploy.yml",
        },
      ],
      PATTERNS
    );
    assert.equal(res.ok, false);
    assert.equal(res.violations.length, 1);
    assert.equal(res.violations[0].file, "src/innocent.js");
    assert.equal(res.violations[0].target, ".github/workflows/deploy.yml");
    assert.match(res.violations[0].reason, /Symlink "src\/innocent\.js" -> "\.github\/workflows\/deploy\.yml"/);
  });

  await t.test("blocks symlinks whose target escapes repository root via traversal or absolute path", () => {
    const traversalRes = evaluateScopeGuard(
      [
        {
          file: "notes.md",
          dstMode: "120000",
          symlinkTarget: "../../etc/passwd",
        },
      ],
      PATTERNS
    );
    assert.equal(traversalRes.ok, false);
    assert.equal(traversalRes.violations[0].file, "notes.md");
    assert.match(traversalRes.violations[0].reason, /Path escapes the repository root/);

    const absRes = evaluateScopeGuard(
      [
        {
          file: "leak.txt",
          dstMode: "120000",
          symlinkTarget: "/etc/os-release",
        },
      ],
      PATTERNS
    );
    assert.equal(absRes.ok, false);
    assert.equal(absRes.violations[0].file, "leak.txt");
    assert.match(absRes.violations[0].reason, /Path escapes the repository root/);
  });

  await t.test("blocks Git submodules (mode 160000)", () => {
    const res = evaluateScopeGuard(
      [
        {
          file: "vendor/external-repo",
          dstMode: "160000",
        },
      ],
      PATTERNS
    );
    assert.equal(res.ok, false);
    assert.equal(res.violations.length, 1);
    assert.equal(res.violations[0].file, "vendor/external-repo");
    assert.equal(res.violations[0].pattern, "<submodule>");
    assert.match(res.violations[0].reason, /Git submodule \(mode 160000\) is forbidden/);
  });

  await t.test("fails closed on unreadable or empty symlink targets", () => {
    const res = evaluateScopeGuard(
      [
        {
          file: "broken-link",
          dstMode: "120000",
          symlinkUnreadable: true,
        },
      ],
      PATTERNS
    );
    assert.equal(res.ok, false);
    assert.equal(res.violations.length, 1);
    assert.equal(res.violations[0].file, "broken-link");
    assert.equal(res.violations[0].pattern, "<unreadable-symlink>");
    assert.match(res.violations[0].reason, /Unreadable or empty symlink target cannot be verified/);
  });

  await t.test("resolves relative symlink target cleanly via resolveLinkTarget", () => {
    assert.equal(resolveLinkTarget("src/sub/link.js", "../other.js"), "src/other.js");
    assert.equal(resolveLinkTarget("src/sub/link.js", "../../.github/ci.yml"), ".github/ci.yml");
    assert.equal(resolveLinkTarget("link.js", "/etc/passwd"), "/etc/passwd");
  });

  await t.test("detects and blocks committed symlinks pointing to protected files in a real git repository", () => {
    const repo = mkdtempSync(join(tmpdir(), "jules-symlink-guard-"));
    t.after(() => rmSync(repo, { recursive: true, force: true }));

    const g = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    g("init", "-q", "-b", "main");
    g("config", "user.email", "test@example.com");
    g("config", "user.name", "test");

    mkdirSync(join(repo, ".agent"), { recursive: true });
    writeFileSync(join(repo, ".agent", "protected-paths.json"), JSON.stringify({ protected: [".github/**", "package.json"] }));
    mkdirSync(join(repo, ".github"), { recursive: true });
    writeFileSync(join(repo, ".github", "ci.yml"), "name: CI\n");
    writeFileSync(join(repo, "README.md"), "base\n");
    g("add", "-A");
    g("commit", "-qm", "base");
    const baseSha = g("rev-parse", "HEAD").trim();

    // Commit a symlink under src/ pointing at protected .github/ci.yml
    mkdirSync(join(repo, "src"), { recursive: true });
    try {
      execFileSync("ln", ["-s", "../.github/ci.yml", join(repo, "src", "helper.js")]);
    } catch (_) {
      // Skip if OS/filesystem cannot create symlinks
      return;
    }

    g("add", "-A");
    g("commit", "-qm", "add symlink pointing to protected path");
    const headSha = g("rev-parse", "HEAD").trim();

    const patterns = loadProtectedPatterns({ baseSha, root: repo });
    const entries = listChangedEntries({ baseSha, headSha, root: repo });
    const files = listChangedFiles({ baseSha, headSha, root: repo });

    assert.ok(files.includes("src/helper.js"));
    const linkEntry = entries.find((e) => e.file === "src/helper.js");
    assert.ok(linkEntry);
    assert.equal(linkEntry.dstMode, "120000");
    assert.equal(linkEntry.symlinkTarget, ".github/ci.yml");

    const res = evaluateScopeGuard(entries, patterns);
    assert.equal(res.ok, false);
    assert.equal(res.violations.length, 1);
    assert.equal(res.violations[0].file, "src/helper.js");
    assert.equal(res.violations[0].target, ".github/ci.yml");
    assert.match(res.violations[0].reason, /Symlink "src\/helper\.js" -> "\.github\/ci\.yml"/);
  });
});

