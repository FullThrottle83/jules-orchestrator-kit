#!/usr/bin/env node
/**
 * Secret Scanner Evasion Audit
 * Tests 9 evasion techniques against scanDiff() from src/security.mjs
 * Uses fabricated credentials only (e.g. AKIAIOSFODNN7EXAMPLE)
 */

import { scanDiff } from "./src/security.mjs";
import {
  shannonEntropy,
  hasHighConfidenceSecret,
  hasHighEntropyToken,
  secretScanVariants,
  hasEncodedSecret,
} from "./src/secret-scanner.mjs";

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE"; // fabricated, from AWS docs
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"; // 40 chars, fabricated
const GH_TOKEN = "ghp_" + "a".repeat(36);
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const RSA_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0FakeKeyForTestingOnlyNotRealData1234567890
FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE
-----END RSA PRIVATE KEY-----`;

function b64(s) {
  return Buffer.from(s).toString("base64");
}
function hex(s) {
  return Buffer.from(s).toString("hex");
}

function makeDiffSingleFile(file, addedLinesArray, hunkStart = 1) {
  // addedLinesArray: array of strings, each will be prefixed with +
  const hunk = addedLinesArray.map((l) => `+${l}`).join("\n");
  return `--- a/${file}\n+++ b/${file}\n@@ -${hunkStart},3 +${hunkStart},${addedLinesArray.length} @@\n${hunk}\n`;
}

function makeDiffMultiFile(files) {
  // files: [{file, lines: array}]
  return files
    .map((f, idx) => {
      const hunk = f.lines.map((l) => `+${l}`).join("\n");
      const start = f.start || 1;
      return `--- a/${f.file}\n+++ b/${f.file}\n@@ -${start},1 +${start},${f.lines.length} @@\n${hunk}`;
    })
    .join("\n");
}

function testCase(name, diff, expectedDetected = true) {
  const res = scanDiff(diff);
  const detected = !res.ok;
  const status = detected ? "DETECTED" : "EVADED (not detected)";
  const passFail = detected === expectedDetected ? "✓" : "✗ UNEXPECTED";
  console.log(`\n[${name}] => ${status} ${passFail}`);
  if (res.findings.length) {
    console.log(`  Findings: ${res.findings.map((f) => `${f.type}:${f.severity}`).join(", ")}`);
    console.log(`  Desc: ${res.findings[0].description.slice(0, 250)}`);
  } else {
    console.log(`  No findings`);
  }
  return { name, diff, detected, findings: res.findings, expectedDetected };
}

const results = [];

// ------------------------------------------------------------
// a. Multi-line secrets split across diff hunks
// ------------------------------------------------------------
console.log("\n=== a. Multi-line secrets split across diff hunks ===");

// a1: Same file, two hunks, no concatenation operator - should EVADE?
const diffA1 = `--- a/src/config.js
+++ b/src/config.js
@@ -1,3 +1,3 @@
 const a = 1;
-const old = 2;
+const part1 = "AKIA";
@@ -10,3 +10,3 @@
 const b = 2;
-const old2 = 3;
+const part2 = "IOSFODNN7EXAMPLE";
`;
results.push(testCase("a1-split-no-concat-same-file", diffA1, false));

// a2: Same file, two hunks, with + concatenation but split across hunks (still separate statements, not contiguous)
const diffA2 = makeDiffSingleFile("src/config.js", [
  `const k = "AKIA" +`,
  `  "IOSFODNN7EXAMPLE";`,
]);
results.push(testCase("a2-split-with-plus-same-hunk", diffA2, true));

// a3: Split across two different files, with plus - fallback joins across files
const diffA3 = makeDiffMultiFile([
  { file: "a.js", lines: [`const k = "AKIA" +`] },
  { file: "b.js", lines: [`  "IOSFODNN7EXAMPLE";`] },
]);
results.push(testCase("a3-split-across-files-with-plus", diffA3, true));

// a4: Split without plus across files - should evade?
const diffA4 = makeDiffMultiFile([
  { file: "a.js", lines: [`const part1 = "AKIA";`] },
  { file: "b.js", lines: [`const part2 = "IOSFODNN7EXAMPLE";`] },
]);
results.push(testCase("a4-split-across-files-no-concat", diffA4, false));

// a5: Split inside a single string across two added lines without quotes closing - base64Dejoined should catch
const diffA5 = makeDiffSingleFile("src/config.js", [
  `const k = "AKIA`,
  `IOSFODNN7EXAMPLE";`,
]);
results.push(testCase("a5-split-inside-string-across-lines", diffA5, true));

// ------------------------------------------------------------
// b. Base64-encoded API keys inside template literals
// ------------------------------------------------------------
console.log("\n=== b. Base64-encoded API keys inside template literals ===");

const b64Aws = b64(AWS_KEY);
const diffB1 = makeDiffSingleFile("file.js", [`const secret = \`${b64Aws}\`;`]);
results.push(testCase("b1-b64-in-template-literal", diffB1, true));

const diffB2 = makeDiffSingleFile("file.js", [
  `const secret = \`\${"${b64Aws.slice(0, 8)}"}\${"${b64Aws.slice(8)}"}\`;`,
]);
// This uses ${"VALUE"} inside template literal which secretScanVariants collapses
results.push(testCase("b2-b64-split-in-template-expressions", diffB2, true));

const diffB3 = makeDiffSingleFile("file.js", [
  `const secret = Buffer.from("${b64Aws}", "base64").toString();`,
]);
results.push(testCase("b3-b64-wrapped-in-Buffer", diffB3, true));

// ------------------------------------------------------------
// c. Hex-encoded secrets in environment variable assignments
// ------------------------------------------------------------
console.log("\n=== c. Hex-encoded secrets in env var assignments ===");

const hexAws = hex(AWS_KEY); // 414b4941494f53464f444e4e374558414d504c45
const diffC1 = makeDiffSingleFile("file.js", [`process.env.AWS_KEY = "${hexAws}";`]);
results.push(testCase("c1-hex-encoded-aws-in-env", diffC1, true));

const diffC2 = makeDiffSingleFile("file.js", [`API_KEY="${hexAws}";`]);
results.push(testCase("c2-hex-encoded-in-api-key-env", diffC2, true));

const hexSecret = hex(AWS_SECRET);
const diffC3 = makeDiffSingleFile(".env", [`AWS_SECRET_ACCESS_KEY=${hexSecret}`]);
// This hex decodes to the 40-char secret, but pattern for aws_secret_access_key expects base64 chars directly, not hex. However hex decode variant should decode and then high-confidence?
results.push(testCase("c3-hex-encoded-aws-secret", diffC3, true));

// Generic high-entropy hex that is NOT a known pattern - should evade entropy check because hex decode produces low-entropy? Actually hex decode to high-entropy token?
const genericSecret = "SuperSecretPassword123!";
const hexGeneric = hex(genericSecret);
const diffC4 = makeDiffSingleFile("file.js", [`const data = "${hexGeneric}";`]);
// This decodes to "SuperSecretPassword123!" which is not high-confidence, but low-confidence? Using data variable avoids low-confidence trigger
results.push(testCase("c4-hex-generic-not-structured", diffC4, false));

// ------------------------------------------------------------
// d. JWT tokens with modified header casing
// ------------------------------------------------------------
console.log("\n=== d. JWT tokens with modified header casing ===");

const diffD1 = makeDiffSingleFile("file.js", [`const jwt = "${JWT}";`]);
results.push(testCase("d1-standard-jwt", diffD1, true));

// Modify header casing: EyJ instead of eyJ
const jwtEyJ = JWT.replace(/^eyJ/, "EyJ");
const diffD2 = makeDiffSingleFile("file.js", [`const jwt = "${jwtEyJ}";`]);
results.push(testCase("d2-jwt-EyJ-casing", diffD2, true)); // JWT regex bypassed, but entropy catches as HIGH_ENTROPY_TOKEN

const jwtEYJ = JWT.replace(/^eyJ/, "EYJ");
const diffD3 = makeDiffSingleFile("file.js", [`const jwt = "${jwtEYJ}";`]);
results.push(testCase("d3-jwt-EYJ-casing", diffD3, true));

const jwtLower = JWT.replace(/^eyJ/, "eyj");
const diffD4 = makeDiffSingleFile("file.js", [`const jwt = "${jwtLower}";`]);
results.push(testCase("d4-jwt-eyj-lowercase", diffD4, true));

// With Bearer prefix, low-confidence pattern might catch even with modified casing?
const diffD5 = makeDiffSingleFile("file.js", [`Authorization: Bearer ${jwtEyJ}`]);
results.push(testCase("d5-jwt-EyJ-with-Bearer", diffD5, true));

// Check directly hasHighConfidenceSecret for JWT casing
console.log("\n  Direct hasHighConfidenceSecret checks:");
console.log(`   standard JWT: ${hasHighConfidenceSecret(JWT)}`);
console.log(`   EyJ JWT: ${hasHighConfidenceSecret(jwtEyJ)}`);
console.log(`   EYJ JWT: ${hasHighConfidenceSecret(jwtEYJ)}`);
console.log(`   eyj JWT: ${hasHighConfidenceSecret(jwtLower)}`);

// ------------------------------------------------------------
// e. AWS credentials with whitespace padding
// ------------------------------------------------------------
console.log("\n=== e. AWS credentials with whitespace padding ===");

const diffE1 = makeDiffSingleFile("file.js", [`const key = "${AWS_KEY}";`]);
results.push(testCase("e1-baseline-aws", diffE1, true));

const diffE2 = makeDiffSingleFile("file.js", [`api_key=    ${AWS_KEY}`]);
results.push(testCase("e2-aws-with-spaces-around-equals", diffE2, true));

const diffE3 = makeDiffSingleFile("file.js", [`aws_secret_access_key    =    "${AWS_SECRET}"`]);
results.push(testCase("e3-aws-secret-with-padding", diffE3, true));

const diffE4 = makeDiffSingleFile("file.js", [`api_key\t=\t"${AWS_KEY}"`]);
results.push(testCase("e4-aws-with-tabs", diffE4, true));

const diffE5 = `--- a/file.js
+++ b/file.js
@@ -1,2 +1,3 @@
 const a=1;
+api_key=
+    ${AWS_KEY}
`;
results.push(testCase("e5-aws-with-newline-between", diffE5, true));

// ------------------------------------------------------------
// f. Private keys represented as string arrays that are joined at runtime
// ------------------------------------------------------------
console.log("\n=== f. Private keys as string arrays joined at runtime ===");

const rsaLines = RSA_KEY.split("\n");
const diffF1 = makeDiffSingleFile("file.js", rsaLines.map((l) => `const key = \`${l}\`;`).slice(0, 1).concat(rsaLines.slice(1).map((l) => `${l}`)));
// Better: use helper that correctly prefixes each line of RSA key
const diffF1Proper = `--- a/file.js
+++ b/file.js
@@ -1,1 +1,5 @@
-const x=1;
+const key = \`-----BEGIN RSA PRIVATE KEY-----
+MIIEowIBAAKCAQEA0FakeKeyForTestingOnlyNotRealData1234567890
+FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE
+-----END RSA PRIVATE KEY-----\`;
`;
results.push(testCase("f1-baseline-private-key", diffF1Proper, true));

const diffF2 = makeDiffSingleFile("file.js", [
  `const parts = ["-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA0FakeKey", "-----END RSA PRIVATE KEY-----"]; const key = parts.join("\\n");`,
]);
results.push(testCase("f2-private-key-array-join-newline", diffF2, true));

const diffF3 = makeDiffSingleFile("file.js", [
  `const parts = ["-----BEGIN ", "RSA PRIVATE KEY-----\\nMIIE...", "-----END RSA PRIVATE KEY-----"]; const key = parts.join("");`,
]);
// Splitting the BEGIN marker itself
results.push(testCase("f3-private-key-split-BEGIN-marker", diffF3, false));

const diffF4 = makeDiffSingleFile("file.js", [
  `const key = ["-----BEGIN RSA PRIVATE KEY-----\\n", "MIIE...\\n", "-----END RSA PRIVATE KEY-----"].join("");`,
]);
results.push(testCase("f4-private-key-array-literal-join-empty", diffF4, true));

const diffF5 = makeDiffSingleFile("file.js", [
  `const key = ["-----BEGIN RSA PRIVATE KEY-----", "MIIE...", "-----END RSA PRIVATE KEY-----"].join("\\n").replace("\\n", "");`,
]);
results.push(testCase("f5-private-key-array-join-with-replace", diffF5, true));

// ------------------------------------------------------------
// g. Secrets placed in diff context lines
// ------------------------------------------------------------
console.log("\n=== g. Secrets placed in diff context lines ===");

const diffG1 = `--- a/file.js
+++ b/file.js
@@ -1,3 +1,3 @@
 const x = 1;
 const token = "${AWS_KEY}";
+const y = 2;
`;
results.push(testCase("g1-secret-in-context-line", diffG1, false));

const diffG2 = `--- a/file.js
+++ b/file.js
@@ -1,4 +1,4 @@
 const a = 1;
-const old = 2;
 const secret = "${AWS_KEY}";
+const b = 3;
`;
results.push(testCase("g2-secret-in-context-between-hunks", diffG2, false));

const diffG3 = `--- a/file.js
+++ b/file.js
@@ -1,3 +1,3 @@
 const a = 1;
+const b = 2;
 const c = "${AWS_KEY}";
`;
results.push(testCase("g3-secret-in-context-after-add", diffG3, false));

// ------------------------------------------------------------
// h. Unicode escape sequences
// ------------------------------------------------------------
console.log("\n=== h. Unicode escape sequences ===");

const unicodeEscapedAWS = AWS_KEY.split("")
  .map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))
  .join("");
const diffH1 = makeDiffSingleFile("file.js", [`const k = "${unicodeEscapedAWS}";`]);
results.push(testCase("h1-unicode-escaped-AWS-key", diffH1, false));

const diffH2 = makeDiffSingleFile("file.js", [`const k = "\\u0041\\u0057\\u0053";`]);
results.push(testCase("h2-unicode-escaped-AWS-literal", diffH2, false));

const diffH3 = makeDiffSingleFile("file.js", [
  `const k = "AKIA" + "\\u0049\\u004f\\u0053\\u0046\\u004f\\u0044\\u004e\\u004e\\u0037\\u0045\\u0058\\u0041\\u004d\\u0050\\u004c\\u0045";`,
]);
// Mixed plain + unicode escape - should still evade because unicode not decoded
results.push(testCase("h3-mixed-plain-and-unicode-escape", diffH3, false));

// Direct check
console.log("\n  Direct hasHighConfidenceSecret on unicode escaped:");
console.log(`   unicodeEscapedAWS: ${hasHighConfidenceSecret(unicodeEscapedAWS)} (expected false)`);
console.log(`   decoded unicode: ${hasHighConfidenceSecret(AWS_KEY)} (expected true)`);

// ------------------------------------------------------------
// i. Shannon entropy boundary cases
// ------------------------------------------------------------
console.log("\n=== i. Shannon entropy boundary cases ===");

function entropyOf(s) {
  return shannonEntropy(s);
}

// Token with all unique chars: entropy log2(24) ~4.58 >4.5
const tokenAllUnique = "ABCDEFGHIJKLmnopqrstuvwx"; // 24 unique
console.log(`  tokenAllUnique: ${tokenAllUnique} len=${tokenAllUnique.length} entropy=${entropyOf(tokenAllUnique).toFixed(3)} hasHighEntropy=${hasHighEntropyToken(tokenAllUnique)} hasHighConf=${hasHighConfidenceSecret(tokenAllUnique)}`);
const diffI1 = makeDiffSingleFile("file.js", [`const myData = "${tokenAllUnique}";`]);
results.push(testCase("i1-entropy-all-unique-4.58", diffI1, true));

function makeTokenBelowThreshold() {
  const candidates = [
    "ABCDEFGHIJKLMNOPQRSTUVWX",
    "ABCDEFGHIJKLMNOPQRSTUVAA",
    "ABCDEFGHIJKLMNOPQRSTAAAA",
    "ABCDEFGHIJABCDEFGHIJABCD",
    "ABCDABCDABCDABCDABCDABCD",
    "AAAAAAAAAAAAAAAAAAAAAAAB",
    "AbCdEfGhIjKlMnOpQrStUvWx",
    "aB3dE5gH7jK9mN2pQ4rS6tU8vW",
    "abc123abc123abc123abc123",
    "AKIAIOSFODNN7EXAMPLEAKIA",
  ];
  for (const c of candidates) {
    console.log(`  candidate ${c} entropy=${entropyOf(c).toFixed(3)} hasHighEntropy=${hasHighEntropyToken(c)}`);
  }
}
makeTokenBelowThreshold();

const tokenJustBelow = "ABCDEFGHIJKLMNOPQRSTUVWA"; // 23 unique, entropy 4.502
console.log(`  tokenJustBelow ${tokenJustBelow} entropy=${entropyOf(tokenJustBelow).toFixed(3)} hasHighEntropy=${hasHighEntropyToken(tokenJustBelow)}`);
const diffI2 = makeDiffSingleFile("file.js", [`const myData = "${tokenJustBelow}";`]);
results.push(testCase("i2-entropy-23-unique-just-above", diffI2, true));

const token22Unique = "ABCDEFGHIJKLMNOPQRSTUVAA"; // 22 unique
console.log(`  token22Unique ${token22Unique} entropy=${entropyOf(token22Unique).toFixed(3)} hasHighEntropy=${hasHighEntropyToken(token22Unique)}`);
const diffI3 = makeDiffSingleFile("file.js", [`const myData = "${token22Unique}";`]);
results.push(testCase("i3-entropy-22-unique-below-threshold", diffI3, false));

const tokenLow = "abcdabcdabcdabcdabcdabcd";
console.log(`  tokenLow ${tokenLow} entropy=${entropyOf(tokenLow).toFixed(3)} hasHighEntropy=${hasHighEntropyToken(tokenLow)}`);
const diffI4 = makeDiffSingleFile("file.js", [`const myData = "${tokenLow}";`]);
results.push(testCase("i4-entropy-low-2.0", diffI4, false));

const diffI5 = `--- a/package-lock.json
+++ b/package-lock.json
@@ -1,1 +1,1 @@
-const x=1;
+const myData = "${tokenAllUnique}";
`;
results.push(testCase("i5-high-entropy-in-lockfile-should-be-ignored", diffI5, false));

// Boundary: 24 unique vs 22 unique
const tokenBoundaryHigh = "ABCDEFGHIJKLMNOPQRSTUVWX"; // 4.585 >4.5
const tokenBoundaryLow = "ABCDEFGHIJKLMNOPQRSTUVAA"; // 4.387 <4.5
console.log(`\n  Boundary test: high ${tokenBoundaryHigh} entropy=${entropyOf(tokenBoundaryHigh).toFixed(3)} detected=${hasHighEntropyToken(tokenBoundaryHigh)}`);
console.log(`  Boundary test: low ${tokenBoundaryLow} entropy=${entropyOf(tokenBoundaryLow).toFixed(3)} detected=${hasHighEntropyToken(tokenBoundaryLow)}`);

// ------------------------------------------------------------
// Summary
// ------------------------------------------------------------
console.log("\n\n=== SUMMARY ===");
const byGroup = {};
for (const r of results) {
  const group = r.name.split("-")[0];
  if (!byGroup[group]) byGroup[group] = [];
  byGroup[group].push(r);
}
for (const [g, list] of Object.entries(byGroup)) {
  const detected = list.filter((r) => r.detected).length;
  console.log(`${g}: ${detected}/${list.length} detected`);
}

const total = results.length;
const detectedCount = results.filter((r) => r.detected).length;
console.log(`\nTotal: ${detectedCount}/${total} payloads detected`);
console.log(`Total evaded: ${total - detectedCount}/${total}`);

const evaded = results.filter((r) => !r.detected);
console.log("\nEvaded techniques (potential bypasses):");
for (const e of evaded) {
  console.log(` - ${e.name}: ${e.diff.slice(0, 150).replace(/\n/g, "\\n")}...`);
}
