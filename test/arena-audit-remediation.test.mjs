import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { hasEncodedSecret, scanDiff, checkTestTampering } from "../src/security.mjs";
import { gate } from "../src/engine.mjs";
import { resolveBase } from "../src/git.mjs";
import { planInit } from "../src/wizard-init.mjs";

test("Arena Audit Remediation Suite", async (t) => {
  // 1. Secret Smuggling via line-wrapped Base64
  await t.test("1. Base64 line-wrapped chunk stitching detects multiline encoded RSA keys", () => {
    const rsaKey = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA0Y123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL",
      "MNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
      "OPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO",
      "PQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN01",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");

    const singleLineB64 = Buffer.from(rsaKey).toString("base64");
    assert.equal(hasEncodedSecret(singleLineB64), true, "Single-line base64 RSA key must be detected");

    // Standard 64-character line-wrapped base64 (RFC 4648 / standard PEM base64 format)
    const wrappedB64 = singleLineB64.match(/.{1,64}/g).join("\n");
    assert.notEqual(wrappedB64, singleLineB64, "Sanity check: wrapped string has newlines");

    assert.equal(
      hasEncodedSecret(wrappedB64),
      true,
      "Line-wrapped base64 RSA key must be detected by hasEncodedSecret"
    );

    // Verify through scanDiff on a git diff
    const diffWithWrappedB64 = [
      "diff --git a/credentials.json b/credentials.json",
      "index 1111111..2222222 100644",
      "--- a/credentials.json",
      "+++ b/credentials.json",
      "@@ -1,1 +1,6 @@",
      ...wrappedB64.split("\n").map((line) => `+  "${line}"`),
    ].join("\n");

    const diffResult = scanDiff(diffWithWrappedB64);
    assert.equal(diffResult.ok, false, "Diff with wrapped base64 secret must be rejected");
    assert.ok(
      diffResult.findings.some(
        (f) => f.type === "HIGH_CONFIDENCE_SECRET" && f.severity === "CRITICAL"
      ),
      "Diff must report CRITICAL HIGH_CONFIDENCE_SECRET for wrapped base64"
    );
  });

  // 2. Assertion Weakening / Vacuous Assertions
  await t.test("2. Vacuous assertions tamper guard detects assertion weakening", () => {
    const makeDiff = (assertionLine) => [
      "diff --git a/test/auth.test.mjs b/test/auth.test.mjs",
      "index 1111111..2222222 100644",
      "--- a/test/auth.test.mjs",
      "+++ b/test/auth.test.mjs",
      "@@ -10,3 +10,3 @@",
      "-    assert.equal(token.isValid(), true);",
      `+    ${assertionLine}`,
    ].join("\n");

    const vacuousCases = [
      "assert.ok(true);",
      "assert(true);",
      "assert.equal(1, 1);",
      "assert.strictEqual(true, true);",
      "assert.deepEqual('xyz', 'xyz');",
      "expect(true).toBe(true);",
      "expect(1).toEqual(1);",
      "expect(true).toBeTruthy();",
      "expect(false).toBeFalsy();",
      "assert.isTrue(true);",
    ];

    for (const testCase of vacuousCases) {
      const diff = makeDiff(testCase);
      const tamperRes = checkTestTampering(diff);
      assert.equal(
        tamperRes.ok,
        false,
        `Expected tampering violation for vacuous assertion: ${testCase}`
      );
      assert.ok(
        tamperRes.violations.some((v) => v.type === "VACUOUS_ASSERTION"),
        `Expected VACUOUS_ASSERTION type for: ${testCase}`
      );

      const diffRes = scanDiff(diff);
      assert.equal(diffRes.ok, false, `scanDiff should fail on vacuous assertion: ${testCase}`);
      assert.ok(
        diffRes.findings.some((f) => f.type === "TEST_TAMPERING_DETECTED" && f.severity === "CRITICAL"),
        `scanDiff must classify vacuous assertion tampering as CRITICAL: ${testCase}`
      );
      assert.ok(
        diffRes.findings.some((f) => f.description.includes("Vacuous")),
        `scanDiff must include Vacuous in finding description: ${testCase}`
      );
    }

    // Legitimate assertions must still pass
    const legitimateCases = [
      "assert.equal(result.status, 200);",
      "assert.ok(isValidUser(user));",
      "expect(response.body).toEqual({ id: 1 });",
    ];

    for (const legCase of legitimateCases) {
      const diff = makeDiff(legCase);
      const tamperRes = checkTestTampering(diff);
      assert.equal(tamperRes.ok, true, `Legitimate assertion should pass: ${legCase}`);
    }
  });

  // 3. Exit 188 classification: offline network guard vs test regression
  await t.test("3. Gate classifies exit code 188 as network violation and skips OODA repair", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "jules-exit188-test-"));
    try {
      // Create minimal git repository
      execFileSync("git", ["init", "--initial-branch=main"], { cwd: tmpDir });
      execFileSync("git", ["config", "user.name", "Tester"], { cwd: tmpDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpDir });

      mkdirSync(join(tmpDir, ".agent"), { recursive: true });
      writeFileSync(
        join(tmpDir, ".agent", "config.yml"),
        "version: 1\ntier: free\nprovider: jules\nverify:\n  test: node -e \"process.exit(188)\"\n"
      );
      writeFileSync(join(tmpDir, "index.js"), "console.log('hello');\n");
      execFileSync("git", ["add", "."], { cwd: tmpDir });
      execFileSync("git", ["commit", "-m", "initial commit"], { cwd: tmpDir });

      // Run gate with fix: true
      const gateRes = await gate({
        root: tmpDir,
        base: "HEAD",
        mode: "working-tree",
        fix: true,
      });

      assert.equal(gateRes.ok, false, "Gate must fail on exit 188");
      assert.equal(gateRes.code, 188, "Gate must return exit code 188, NOT 4");

      const verifyPhase = gateRes.phases.find((p) => p.phase === "verify");
      assert.ok(verifyPhase, "Verify phase must be present");
      assert.ok(
        verifyPhase.failure.diagnostics.some((d) =>
          d.includes("Offline Network Guard") && d.includes("Exit 188")
        ),
        "Failure diagnostics must explain network violation and advise npm install"
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 4. Git --base HEAD resolution
  await t.test("4. resolveBase correctly resolves local HEAD without remote prefixing", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "jules-githead-test-"));
    try {
      execFileSync("git", ["init", "--initial-branch=main"], { cwd: tmpDir });
      execFileSync("git", ["config", "user.name", "Tester"], { cwd: tmpDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpDir });

      writeFileSync(join(tmpDir, "file1.txt"), "first commit\n");
      execFileSync("git", ["add", "."], { cwd: tmpDir });
      execFileSync("git", ["commit", "-m", "commit 1"], { cwd: tmpDir });
      const commit1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf-8" }).trim();

      writeFileSync(join(tmpDir, "file2.txt"), "second commit\n");
      execFileSync("git", ["add", "."], { cwd: tmpDir });
      execFileSync("git", ["commit", "-m", "commit 2"], { cwd: tmpDir });
      const commit2 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf-8" }).trim();

      assert.notEqual(commit1, commit2);

      // resolveBase with HEAD must resolve to current HEAD commit2
      const resolvedHead = resolveBase(tmpDir, "HEAD");
      assert.equal(resolvedHead, commit2, "resolveBase HEAD must return latest local commit");

      // resolveBase with HEAD~1 must resolve to commit1
      const resolvedHeadPrev = resolveBase(tmpDir, "HEAD~1");
      assert.equal(resolvedHeadPrev, commit1, "resolveBase HEAD~1 must return parent commit");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 5. Config limits omission & jules.yml v2 preservation
  await t.test("5. planInit omits redundant limits and preserves jules.yml v2 manifests", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "jules-limits-test-"));
    try {
      // A: When limits match default tier preset, limits: block should be omitted from configYaml
      const planDefault = planInit(tmpDir, { tier: "free", testCmd: "npm test" });
      assert.equal(planDefault.tier, "free");
      assert.ok(
        !planDefault.configYaml.includes("limits:"),
        "Redundant limits: block must be omitted when identical to tier defaults"
      );
      assert.ok(
        planDefault.julesYaml.includes("version: 2"),
        "jules.yml must be generated with version: 2"
      );
      assert.ok(
        planDefault.julesYaml.includes("forbidden_paths:"),
        "jules.yml must contain forbidden_paths"
      );

      // B: When custom limits are explicitly passed, limits: block is preserved
      const planCustom = planInit(tmpDir, {
        tier: "free",
        testCmd: "npm test",
        limits: { daily_tasks: 999 },
      });
      assert.ok(
        planCustom.configYaml.includes("limits:"),
        "Custom limits: block must be included when customized"
      );
      assert.ok(
        planCustom.configYaml.includes("daily_tasks: 999"),
        "Custom limit value must be present in configYaml"
      );

      // C: Preserve existing forbidden_paths in .agent/jules.yml
      const agentDir = join(tmpDir, ".agent");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, "jules.yml"),
        "version: 2\ntest_cmd: \"npm test\"\nforbidden_paths:\n  - \"custom/protected/**\"\nallow_paths: []\n"
      );

      const planPreserved = planInit(tmpDir, { tier: "pro", testCmd: "npm test" });
      assert.ok(
        planPreserved.julesYaml.includes('"custom/protected/**"'),
        "Existing forbidden_paths in jules.yml must be preserved"
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
