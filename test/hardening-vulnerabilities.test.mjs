import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { checkTestTampering, scanDiff, hasHighEntropyToken, checkScope } from "../src/security.mjs";
import { gate } from "../src/engine.mjs";
import { normalizeScope, BUILTIN_PROTECT, BUILTIN_DENY } from "../src/config.mjs";

test("Vulnerabilities A-D Hardening Test Suite", async (t) => {
  // --------------------------------------------------------------------------
  // Sårbarhet A: Borttagning av assertions detekteras inte (Test Deletion Bypass)
  // --------------------------------------------------------------------------
  await t.test("A: checkTestTampering flags assertion removal as ASSERTION_REMOVAL", () => {
    const diff = [
      "diff --git a/test/auth.test.mjs b/test/auth.test.mjs",
      "--- a/test/auth.test.mjs",
      "+++ b/test/auth.test.mjs",
      "@@ -10,2 +10,1 @@",
      "-    assert.equal(token.isValid(), true);",
      "-    assert.equal(token.isExpired(), false);",
      "+    console.log(\"done\");",
    ].join("\n");

    const res = checkTestTampering(diff);
    assert.equal(res.ok, false);
    assert.equal(res.violations.length, 2);
    assert.equal(res.violations[0].type, "ASSERTION_REMOVAL");
    assert.equal(res.violations[1].type, "ASSERTION_REMOVAL");
    assert.match(res.violations[0].reason, /Assertion removed without replacement in test\/auth\.test\.mjs:10/);

    // scanDiff must also report this critical tampering finding
    const diffRes = scanDiff(diff);
    assert.equal(diffRes.ok, false);
    assert.ok(diffRes.findings.some((f) => f.type === "TEST_TAMPERING_DETECTED" && f.severity === "CRITICAL"));
  });

  await t.test("A: legitimate assertion refactoring is allowed", () => {
    const diff = [
      "diff --git a/test/auth.test.mjs b/test/auth.test.mjs",
      "--- a/test/auth.test.mjs",
      "+++ b/test/auth.test.mjs",
      "@@ -10,2 +10,2 @@",
      "-    assert.equal(token.isValid(), true);",
      "+    assert.strictEqual(token.isValid(), true);",
    ].join("\n");

    const res = checkTestTampering(diff);
    assert.equal(res.ok, true);
    assert.equal(res.violations.length, 0);
  });

  // --------------------------------------------------------------------------
  // Sårbarhet B: Diff Payload Governor kan manipuleras i --mode committed
  // --------------------------------------------------------------------------
  await t.test("B: Diff Payload Governor binds strictly to trustedConfigRaw in committed mode", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "jules-payload-vuln-"));
    try {
      execFileSync("git", ["init", "--initial-branch=main"], { cwd: tmpDir });
      execFileSync("git", ["config", "user.name", "Tester"], { cwd: tmpDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpDir });

      // Base commit on main with standard 75 KB ceiling (or default)
      writeFileSync(join(tmpDir, "README.md"), "# Test repo\n");
      execFileSync("git", ["add", "README.md"], { cwd: tmpDir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: tmpDir });

      // Create feature branch
      execFileSync("git", ["checkout", "-b", "feature/big-commit"], { cwd: tmpDir });

      // Commit an 80 KB change (exceeds default 75 KB limit)
      const bigContent = "X".repeat(80 * 1024);
      writeFileSync(join(tmpDir, "big-file.txt"), bigContent);
      execFileSync("git", ["add", "big-file.txt"], { cwd: tmpDir });
      execFileSync("git", ["commit", "-m", "add big file"], { cwd: tmpDir });

      // Adversary places uncommitted .agent/config.yml with diff_kb: 99999 on disk
      const agentDir = join(tmpDir, ".agent");
      execFileSync("mkdir", ["-p", agentDir], { cwd: tmpDir });
      writeFileSync(
        join(agentDir, "config.yml"),
        "limits:\n  diff_kb: 99999\n"
      );

      // In --mode committed, gate must reject with code 5 (Payload exceeded)
      // because uncommitted disk config is ignored; limit stays at trusted 75 KB.
      const gateRes = await gate({
        root: tmpDir,
        base: "main",
        mode: "committed",
      });

      assert.equal(gateRes.ok, false);
      assert.equal(gateRes.code, 5, "Expected Exit 5 (Diff Payload Governor limit exceeded)");
      const payloadPhase = gateRes.phases.find((p) => p.phase === "payload");
      assert.ok(payloadPhase);
      assert.equal(payloadPhase.ok, false);
      assert.equal(payloadPhase.limitBytes, 75 * 1024, "Limit must remain locked at 75 KB");
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // --------------------------------------------------------------------------
  // Sårbarhet C: Onboarding Catch-22 vid PR mot origin/main
  // --------------------------------------------------------------------------
  await t.test("C: .agent/config.yml is in BUILTIN_PROTECT and can be landed with --allow-protected", () => {
    assert.ok(BUILTIN_PROTECT.includes(".agent/config.yml"));
    assert.ok(BUILTIN_PROTECT.includes(".agent/jules.yml"));
    assert.ok(!BUILTIN_DENY.includes(".agent/config.yml"));
    assert.ok(!BUILTIN_DENY.includes(".agent/jules.yml"));

    const scope = normalizeScope({});

    // Without allowProtected: blocked with rule "protect"
    const blockedRes = checkScope([".agent/config.yml"], scope, { allowProtected: false });
    assert.equal(blockedRes.ok, false);
    assert.equal(blockedRes.violations.length, 1);
    assert.equal(blockedRes.violations[0].rule, "protect");

    // With allowProtected: allowed cleanly (onboarding PR succeeds!)
    const allowedRes = checkScope([".agent/config.yml", ".agent/jules.yml"], scope, { allowProtected: true });
    assert.equal(allowedRes.ok, true);
    assert.equal(allowedRes.violations.length, 0);
  });

  // --------------------------------------------------------------------------
  // Sårbarhet D: Shannon-entropikontroll i diffscannern (HIGH_ENTROPY_TOKEN)
  // --------------------------------------------------------------------------
  await t.test("D: scanDiff detects unstructured high-entropy secrets as HIGH_ENTROPY_TOKEN", () => {
    // 48-char random alphanumeric API token
    const randomKey = "a8F9eK2mP0xL4vQ7wR3yT1zU5iO8sD6fG2jH4kL9nB5vC3x";
    const diff = [
      "diff --git a/src/service.js b/src/service.js",
      "--- a/src/service.js",
      "+++ b/src/service.js",
      "@@ -1,3 +1,3 @@",
      `+sendPayload("${randomKey}");`,
    ].join("\n");

    const res = scanDiff(diff);
    assert.equal(res.ok, false);
    const finding = res.findings.find((f) => f.type === "HIGH_ENTROPY_TOKEN");
    assert.ok(finding, "Expected HIGH_ENTROPY_TOKEN finding");
    assert.equal(finding.severity, "HIGH");
    assert.match(finding.description, /High-entropy token detected/);
  });

  await t.test("D: scanDiff does not flag hex commit SHAs or long identifiers", () => {
    const gitSha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4";
    const longIdentifier = "createReviewRepairTaskFallbackPathExtraLongName";
    const diff = [
      "diff --git a/src/util.js b/src/util.js",
      "--- a/src/util.js",
      "+++ b/src/util.js",
      "@@ -1,3 +1,4 @@",
      `+const sha = "${gitSha}";`,
      `+function ${longIdentifier}() {}`,
    ].join("\n");

    const res = scanDiff(diff);
    assert.equal(res.ok, true);
    assert.equal(res.findings.length, 0);
  });

  await t.test("D: scanDiff does not flag URLs or lockfile SRI hashes", () => {
    const diff = [
      "diff --git a/package-lock.json b/package-lock.json",
      "--- a/package-lock.json",
      "+++ b/package-lock.json",
      "@@ -1,3 +1,3 @@",
      '+      "integrity": "sha512-cuadcxVFE8sDK6iWJbs8Sn0kOmt0wTEn1V9n5bJ6k6ZqV2a0d9pXy8L=="',
      "diff --git a/docs/links.md b/docs/links.md",
      "--- a/docs/links.md",
      "+++ b/docs/links.md",
      "@@ -1,2 +1,2 @@",
      "+[link](https://github.com/FullThrottle83/jules-orchestrator-kit/releases/tag/v1.0.0)",
    ].join("\n");

    const res = scanDiff(diff);
    assert.equal(res.ok, true);
    assert.equal(res.findings.length, 0);
  });

  await t.test("D: hasHighEntropyToken evaluates raw strings directly", () => {
    const randomKey = "a8F9eK2mP0xL4vQ7wR3yT1zU5iO8sD6fG2jH4kL9nB5vC3x";
    assert.equal(hasHighEntropyToken(`key: ${randomKey}`), true);
    assert.equal(hasHighEntropyToken("const normalCode = 123;"), false);
  });
});
