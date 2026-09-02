import test from "node:test";
import assert from "node:assert/strict";
import { checkTestTampering, scanDiff } from "../src/security.mjs";
import { assertTestIntegrity } from "../src/assertions.mjs";

test("Test Assertion Anti-Tampering & Weakening Detection", async (t) => {
  await t.test("detects injected .skip() in test files", () => {
    const skipCall = "test" + ".skip";
    const diff = [
      "diff --git a/test/auth.test.mjs b/test/auth.test.mjs",
      "--- a/test/auth.test.mjs",
      "+++ b/test/auth.test.mjs",
      "@@ -10,3 +10,3 @@",
      '-test("verifies user password", () => {',
      `+${skipCall}("verifies user password", () => {`,
      "   assert.ok(true);",
      " });",
    ].join("\n");

    const res = checkTestTampering(diff);
    assert.equal(res.ok, false);
    assert.equal(res.violations.length, 1);
    assert.equal(res.violations[0].type, "TEST_SKIP_INJECTION");
    assert.match(res.violations[0].reason, /Injected test skip/);
  });

  await t.test("detects injected xit / xtest / xdescribe in test files", () => {
    const xitCall = "x" + "it";
    const diff = [
      "diff --git a/test/api.spec.js b/test/api.spec.js",
      "--- a/test/api.spec.js",
      "+++ b/test/api.spec.js",
      "@@ -5,3 +5,3 @@",
      '-it("returns 200 OK", async () => {',
      `+${xitCall}("returns 200 OK", async () => {`,
      "   expect(res.status).toBe(200);",
      " });",
    ].join("\n");

    const res = checkTestTampering(diff);
    assert.equal(res.ok, false);
    assert.ok(res.violations.some((v) => v.type === "TEST_SKIP_INJECTION"));
  });

  await t.test("detects TypeScript @ts-ignore injected into test files", () => {
    const tsIgnore = "// @" + "ts-ignore";
    const diff = [
      "diff --git a/tests/user.test.ts b/tests/user.test.ts",
      "--- a/tests/user.test.ts",
      "+++ b/tests/user.test.ts",
      "@@ -20,2 +20,3 @@",
      `+${tsIgnore}`,
      " const invalidUser: User = { id: 123 };",
    ].join("\n");

    const res = checkTestTampering(diff);
    assert.equal(res.ok, false);
    assert.ok(res.violations.some((v) => v.type === "TEST_SKIP_INJECTION"));
  });

  await t.test("detects commented-out test assertions", () => {
    const commentedAssert = "// " + "assert.strictEqual(secretDetected, true);";
    const diff = [
      "diff --git a/test/security.test.mjs b/test/security.test.mjs",
      "--- a/test/security.test.mjs",
      "+++ b/test/security.test.mjs",
      "@@ -30,3 +30,3 @@",
      "-assert.strictEqual(secretDetected, true);",
      `+${commentedAssert}`,
    ].join("\n");

    const res = checkTestTampering(diff);
    assert.equal(res.ok, false);
    assert.ok(res.violations.some((v) => v.type === "COMMENTED_ASSERTION"));
  });

  await t.test("allows legitimate new test additions and assertions", () => {
    const diff = [
      "diff --git a/test/math.test.mjs b/test/math.test.mjs",
      "--- a/test/math.test.mjs",
      "+++ b/test/math.test.mjs",
      "@@ -10,3 +10,6 @@",
      '+test("multiplies correctly", () => {',
      "+  assert.strictEqual(multiply(2, 3), 6);",
      "+});",
    ].join("\n");

    const res = checkTestTampering(diff);
    assert.equal(res.ok, true);
    assert.equal(res.violations.length, 0);
  });

  await t.test("scanDiff includes TEST_TAMPERING_DETECTED in findings", () => {
    const itSkip = "it" + ".skip";
    const diff = [
      "diff --git a/test/order.test.mjs b/test/order.test.mjs",
      "--- a/test/order.test.mjs",
      "+++ b/test/order.test.mjs",
      "@@ -1,3 +1,3 @@",
      '-it("processes checkout", () => {',
      `+${itSkip}("processes checkout", () => {`,
    ].join("\n");

    const res = scanDiff(diff);
    assert.equal(res.ok, false);
    assert.ok(res.findings.some((f) => f.type === "TEST_TAMPERING_DETECTED"));
  });

  await t.test("assertTestIntegrity returns ok: false with diagnostics on tampering diff", () => {
    const commented = "// " + "assert.ok(res.success);";
    const diff = [
      "diff --git a/test/payment.test.mjs b/test/payment.test.mjs",
      "--- a/test/payment.test.mjs",
      "+++ b/test/payment.test.mjs",
      "@@ -1,3 +1,3 @@",
      "-assert.ok(res.success);",
      `+${commented}`,
    ].join("\n");

    const res = assertTestIntegrity({ diffStr: diff });
    assert.equal(res.ok, false);
    assert.ok(res.diagnostics.length > 0);
  });

  await t.test("detects removed assertions without replacement (ASSERTION_REMOVAL)", () => {
    const diff = [
      "diff --git a/test/auth.test.mjs b/test/auth.test.mjs",
      "--- a/test/auth.test.mjs",
      "+++ b/test/auth.test.mjs",
      "@@ -10,4 +10,3 @@",
      "-    assert.equal(token.isValid(), true);",
      "-    assert.equal(token.isExpired(), false);",
      "+    console.log(\"done\");",
      "   });",
    ].join("\n");

    const res = checkTestTampering(diff);
    assert.equal(res.ok, false);
    assert.ok(res.violations.some((v) => v.type === "ASSERTION_REMOVAL"));
    assert.equal(res.violations.filter((v) => v.type === "ASSERTION_REMOVAL").length, 2);
    assert.match(res.violations[0].reason, /Assertion removed without replacement/);
  });

  await t.test("allows legitimate 1-to-1 assertion replacement/refactoring", () => {
    const diff = [
      "diff --git a/test/auth.test.mjs b/test/auth.test.mjs",
      "--- a/test/auth.test.mjs",
      "+++ b/test/auth.test.mjs",
      "@@ -10,3 +10,3 @@",
      "-    assert.equal(token.isValid(), true);",
      "+    assert.strictEqual(token.isValid(), true);",
      "   });",
    ].join("\n");

    const res = checkTestTampering(diff);
    assert.equal(res.ok, true);
    assert.equal(res.violations.length, 0);
  });

  await t.test("detects deleted test file containing assertions (+++ /dev/null)", () => {
    const diff = [
      "diff --git a/test/auth.test.mjs b/test/auth.test.mjs",
      "--- a/test/auth.test.mjs",
      "+++ /dev/null",
      "@@ -1,5 +0,0 @@",
      "-test(\"auth\", () => {",
      "-  assert.ok(token);",
      "-  expect(user).toBeDefined();",
      "-});",
    ].join("\n");

    const res = checkTestTampering(diff);
    assert.equal(res.ok, false);
    assert.ok(res.violations.some((v) => v.type === "ASSERTION_REMOVAL"));
    assert.equal(res.violations[0].file, "test/auth.test.mjs");
  });

  await t.test("allowTestModifications: true bypasses assertion removal check", () => {
    const diff = [
      "diff --git a/test/auth.test.mjs b/test/auth.test.mjs",
      "--- a/test/auth.test.mjs",
      "+++ b/test/auth.test.mjs",
      "@@ -10,3 +10,1 @@",
      "-    assert.equal(token.isValid(), true);",
      "-    assert.equal(token.isExpired(), false);",
    ].join("\n");

    const res = checkTestTampering(diff, { allowTestModifications: true });
    assert.equal(res.ok, true);
    assert.equal(res.violations.length, 0);
  });
});

