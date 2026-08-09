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

  it("redactSecrets masks Base64-encoded JWT strings, Slack Bot tokens, and Multiline RSA private key blocks", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const slackToken = ["xoxb", "1234567890", "1234567890123", "abcdefghijklmnopqrstuvwx"].join("-");
    const rsaPrivateKey = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA098...\n-----END RSA PRIVATE KEY-----";

    const text = `JWT: ${jwt}\nSlack: ${slackToken}\nRSA:\n${rsaPrivateKey}`;
    const redacted = redactSecrets(text);

    assert.ok(!redacted.includes(jwt), "Should redact JWT token");
    assert.ok(!redacted.includes(slackToken), "Should redact Slack Bot token");
    assert.ok(!redacted.includes("-----BEGIN RSA PRIVATE KEY-----"), "Should redact RSA Private Key header");
    assert.ok(!redacted.includes("-----END RSA PRIVATE KEY-----"), "Should redact RSA Private Key footer");
    assert.ok(redacted.includes("[REDACTED_BY_SECURITY_GATE]"), "Should contain redact placeholder");

    // All 3 patterns should be replaced by [REDACTED_BY_SECURITY_GATE]
    const redactCount = (redacted.match(/\[REDACTED_BY_SECURITY_GATE\]/g) || []).length;
    assert.equal(redactCount, 3, "Exactly 3 secrets should be redacted");
  });

  it("scanDiff detects Base64-encoded JWT strings, Slack Bot tokens, and Multiline RSA private key blocks in added lines", () => {
    const jwtDiff = `
--- a/file.js
+++ b/file.js
@@ -1,2 +1,3 @@
 const x = 1;
+const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
`;
    const dummySlack = ["xoxb", "1234567890", "1234567890123", "abcdefghijklmnopqrstuvwx"].join("-");
    const slackDiff = `
--- a/file.js
+++ b/file.js
@@ -1,2 +1,3 @@
 const x = 1;
+const slack = "` + dummySlack + `";
`;
    const rsaDiff = `
--- a/file.js
+++ b/file.js
@@ -1,2 +1,5 @@
 const x = 1;
+const key = \`-----BEGIN RSA PRIVATE KEY-----
+MIIEowIBAAKCAQEA098...
+-----END RSA PRIVATE KEY-----\`;
`;

    const resJwt = scanDiff(jwtDiff);
    assert.equal(resJwt.ok, false, "JWT should fail scanDiff");
    assert.equal(resJwt.findings.length, 1);
    assert.equal(resJwt.findings[0].severity, "CRITICAL");
    assert.equal(resJwt.findings[0].type, "HIGH_CONFIDENCE_SECRET");

    const resSlack = scanDiff(slackDiff);
    assert.equal(resSlack.ok, false, "Slack token should fail scanDiff");
    assert.equal(resSlack.findings.length, 1);
    assert.equal(resSlack.findings[0].severity, "CRITICAL");
    assert.equal(resSlack.findings[0].type, "HIGH_CONFIDENCE_SECRET");

    const resRsa = scanDiff(rsaDiff);
    assert.equal(resRsa.ok, false, "RSA private key block should fail scanDiff");
    assert.equal(resRsa.findings.length, 1);
    assert.equal(resRsa.findings[0].severity, "CRITICAL");
    assert.equal(resRsa.findings[0].type, "HIGH_CONFIDENCE_SECRET");
  });
});
