import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  shannonEntropy,
  redactSecrets,
  anonymizePii,
  matchesGlob,
  checkScope,
  scanDiff,
  hasEncodedSecret,
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

  it("checkEdgeRuntimeImports flags forbidden native Node modules in Edge contexts", () => {
    const edgeDiff = `
--- a/src/api.ts
+++ b/src/api.ts
@@ -1,2 +1,3 @@
 export const runtime = 'edge';
+import fs from 'node:fs';
`;
    const res = scanDiff(edgeDiff);
    assert.equal(res.ok, false, "Edge diff with node:fs import should fail scanDiff");
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0].type, "EDGE_RUNTIME_VIOLATION");
    assert.ok(res.findings[0].description.includes("node:fs"));
  });
});

describe("secrets hidden behind a base64 encoding", () => {
  const AWS = "AKIA" + "IOSFODNN7EXAMPLE";
  const b64 = (s) => Buffer.from(s).toString("base64");

  it("finds a structured key inside an encoded value", () => {
    assert.equal(hasEncodedSecret(`token: ${b64(AWS)}`), true);
    assert.equal(hasEncodedSecret(`token: ${b64("ghp_" + "a".repeat(36))}`), true);
  });

  it("leaves data that merely looks encoded alone", () => {
    // Each of these is the right alphabet and often the right length. None of
    // them decodes to anything structured, and flagging any of them would make
    // the gate unusable on an ordinary repository.
    const benign = [
      "const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';",
      "integrity: sha512-BvQqNqLR5owYFRHZBVXBaZTsO2NUyIMMBUyzOZjNPqvNSaTz3xLLLzXOAqAg9yxCiFxLGXHIZ3rvJqvUPuLXqA==",
      `background: url(data:font/woff2;base64,${Buffer.alloc(400).fill(0x1f).toString("base64")})`,
      `const doc = "${b64("The quick brown fox jumps over the lazy dog and keeps going.")}";`,
    ];
    for (const line of benign) {
      assert.equal(hasEncodedSecret(line), false, `false positive on: ${line.slice(0, 48)}…`);
    }
  });

  it("never runs the entropy heuristics against decoded bytes", () => {
    // Decoded output is high-entropy by construction, so the low-confidence
    // patterns would fire on almost anything. Only the structured patterns are
    // safe here, and this pins that: the word "password" round-tripped through
    // base64 is not a finding, while an AWS key id is.
    assert.equal(hasEncodedSecret(b64(`password: "hunter2hunter2hunter2"`)), false);
    assert.equal(hasEncodedSecret(b64(`id = "${AWS}"`)), true);
  });

  it("does not read a wall of digests as an encoded credential", () => {
    // A digest is 64 characters of the base64 alphabet that decodes to binary.
    // Counting those against the decoder's payload budget made every lockfile
    // bump — the workflow this kit advertises as ideal — fail closed as a
    // CRITICAL leak with no credential in the diff at all. The threshold used
    // to sit at 65 tokens, so the counts here straddle it deliberately.
    const digests = (n) =>
      Array.from({ length: n }, (_, i) =>
        `+      "integrity": "sha512-${createHash("sha512").update(`pkg-${i}`).digest("base64")}",`
      ).join("\n");

    for (const n of [64, 65, 300]) {
      const res = scanDiff(`+++ b/package-lock.json\n${digests(n)}`);
      assert.equal(res.ok, true, `${n} integrity hashes must not read as a secret`);
    }

    // The budget still has to protect the thing it was there to protect: a real
    // key does not become invisible by hiding behind a wall of hashes.
    const buried = scanDiff(`+++ b/package-lock.json\n${digests(300)}\n+key: ${b64(AWS)}`);
    assert.equal(buried.ok, false, "a real key after the digests must still be found");
  });

  it("bounds the work a single oversized blob can cause", () => {
    // A checked-in binary or source map must not be decoded in full. The blob
    // is skipped, and — crucially — skipping it does not hide the real key that
    // follows, which is why the cap continues rather than breaking.
    const huge = Buffer.alloc(1024 * 1024).fill(0x5a).toString("base64");
    const started = Date.now();
    const res = scanDiff(`+bin: ${huge}\n+key: ${b64(AWS)}`);
    assert.equal(res.ok, false, "the small real key after the skipped blob must still be found");
    assert.ok(Date.now() - started < 5000, "an oversized blob must not stall the gate");
  });

  it("reports the encoding in the description so an operator can act on it", () => {
    const res = scanDiff(`+  access-key-id: ${b64(AWS)}`);
    const finding = res.findings.find((f) => f.type === "HIGH_CONFIDENCE_SECRET");
    assert.ok(finding);
    assert.equal(finding.severity, "CRITICAL");
    assert.match(finding.description, /base64-encoded/);
  });

  it("does not relabel a cleartext key as an encoded one", () => {
    const res = scanDiff(`+const k = "${AWS}";`);
    const finding = res.findings.find((f) => f.type === "HIGH_CONFIDENCE_SECRET");
    assert.doesNotMatch(finding.description, /base64-encoded/);
  });

  it("still finds a key encoded behind zero-width characters", () => {
    // The encoded check runs on the normalised text, so the evasions the
    // cleartext scanner already handles must keep working through it.
    const enc = b64(AWS);
    const split = `+const k = "${enc.slice(0, 8)}​${enc.slice(8)}";`;
    assert.equal(scanDiff(split).ok, false);
  });
});
