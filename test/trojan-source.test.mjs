import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { checkTrojanSource, scanDiff } from "../src/security.mjs";

describe("Trojan Source Bidi Override Detection", () => {
  test("clean diffs return ok: true and no violations", () => {
    const cleanDiff = `+++ b/src/index.js\n@@ -1,3 +1,4 @@\n+const a = 1;`;
    const res = scanDiff(cleanDiff);
    assert.equal(res.ok, true);
    assert.equal(res.findings.length, 0);

    const tsRes = checkTrojanSource(cleanDiff);
    assert.equal(tsRes.ok, true);
    assert.equal(tsRes.violations.length, 0);
  });

  test("diffs containing U+202E or U+2066 in added code lines fail with TROJAN_SOURCE_DETECTED", () => {
    const maliciousDiff1 = `+++ b/src/index.js\n@@ -1,3 +1,4 @@\n+const str = "Hello \u202ERight-to-Left Override";`;
    const res1 = scanDiff(maliciousDiff1);
    assert.equal(res1.ok, false);
    assert.equal(res1.findings.length, 1);
    assert.equal(res1.findings[0].severity, "CRITICAL");
    assert.equal(res1.findings[0].type, "TROJAN_SOURCE_DETECTED");
    assert.equal(res1.findings[0].file, "src/index.js");

    const maliciousDiff2 = `+++ b/src/index.js\n@@ -1,3 +1,4 @@\n+const str = "Hello \u2066Left-to-Right Isolate";`;
    const res2 = scanDiff(maliciousDiff2);
    assert.equal(res2.ok, false);
    assert.equal(res2.findings.length, 1);
    assert.equal(res2.findings[0].type, "TROJAN_SOURCE_DETECTED");
  });

  test("Markdown documentation files with BiDi text are exempted in scanDiff", () => {
    const markdownDiff = `+++ b/README.md\n@@ -1,3 +1,4 @@\n+Here is some bidi text \u202E for testing`;
    const res = scanDiff(markdownDiff);
    assert.equal(res.ok, true);
    assert.equal(res.findings.length, 0);
  });
});
