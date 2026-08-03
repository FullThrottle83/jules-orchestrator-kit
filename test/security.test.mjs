import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shannonEntropy,
  redactSecrets,
  anonymizePii,
  matchesGlob,
  checkScope,
  scanDiff,
} from "../src/security.mjs";

describe("src/security.mjs", () => {
  it("shannonEntropy calculates correct value", () => {
    assert.equal(shannonEntropy(""), 0);
    assert.equal(shannonEntropy("AAAA"), 0);
    assert.ok(shannonEntropy("abcdef123456!@#$%") > 3.5);
  });

  it("redactSecrets masks GitHub tokens and AWS keys", () => {
    const text = "My key is ghp_123456789012345678901234567890123456 and secret AKIAIOSFODNN7EXAMPLE";
    const redacted = redactSecrets(text);
    assert.ok(!redacted.includes("ghp_123456789012345678901234567890123456"));
    assert.ok(!redacted.includes("AKIAIOSFODNN7EXAMPLE"));
    assert.ok(redacted.includes("[REDACTED_BY_SECURITY_GATE]"));
  });

  it("anonymizePii masks emails and IP addresses", () => {
    const text = "Contact john@example.com at 192.168.1.50";
    const anon = anonymizePii(text);
    assert.ok(!anon.includes("john@example.com"));
    assert.ok(!anon.includes("192.168.1.50"));
    assert.ok(anon.includes("[REDACTED_EMAIL]"));
    assert.ok(anon.includes("[REDACTED_IP]"));
  });

  it("matchesGlob handles wildcard patterns correctly", () => {
    assert.ok(matchesGlob(".github/workflows/ci.yml", ".github/**"));
    assert.ok(matchesGlob("src/index.js", "src/*.js"));
    assert.ok(!matchesGlob("src/index.js", "tests/*.js"));
  });

  it("checkScope flags forbidden files", () => {
    const scope = { deny: [".github/**"], allow: [], protect: ["package.json"] };
    const res = checkScope([".github/workflows/audit.yml", "src/main.js"], scope);
    assert.equal(res.ok, false);
    assert.equal(res.violations.length, 1);
    assert.equal(res.violations[0].file, ".github/workflows/audit.yml");
  });

  it("scanDiff detects high confidence secret in added lines", () => {
    const diff = `
--- a/file.js
+++ b/file.js
@@ -1,2 +1,3 @@
 const x = 1;
+const token = "ghp_123456789012345678901234567890123456";
`;
    const res = scanDiff(diff);
    assert.equal(res.ok, false);
    assert.equal(res.findings.length, 1);
  });
});
