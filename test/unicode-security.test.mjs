import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  checkUnicodeSecurity,
  checkTrojanSource,
  scanDiff,
  hasMixedScriptConfusable,
} from "../src/security.mjs";

function addedDiff(file, line) {
  return `+++ b/${file}\n@@ -1,3 +1,4 @@\n+${line}`;
}

describe("Unicode security detection", () => {
  test("BiDi overrides yield TROJAN_SOURCE_DETECTED", () => {
    for (const ch of ["\u202E", "\u2066", "\u202A", "\u2067"]) {
      const diff = addedDiff("src/index.js", `const s = "x${ch}y";`);
      const res = scanDiff(diff);
      assert.equal(res.ok, false, `expected fail for U+${ch.codePointAt(0).toString(16)}`);
      assert.ok(
        res.findings.some((f) => f.type === "TROJAN_SOURCE_DETECTED" && f.severity === "CRITICAL"),
        `missing TROJAN_SOURCE for U+${ch.codePointAt(0).toString(16)}`,
      );
    }

    const plain = checkUnicodeSecurity('const s = "hello\u202Eworld";');
    assert.equal(plain.ok, false);
    assert.equal(plain.violations[0].type, "TROJAN_SOURCE_DETECTED");
  });

  test("ZW joiners and spaces yield UNICODE_OBFUSCATION_DETECTED", () => {
    for (const ch of ["\u200B", "\u200C", "\u200D", "\uFEFF", "\u00AD", "\u2060", "\u034F"]) {
      const diff = addedDiff("src/auth.js", `const marker = "ab${ch}cd";`);
      const res = scanDiff(diff);
      assert.equal(res.ok, false, `expected fail for U+${ch.codePointAt(0).toString(16)}`);
      assert.ok(
        res.findings.some((f) => f.type === "UNICODE_OBFUSCATION_DETECTED" && f.severity === "CRITICAL"),
        `missing UNICODE_OBFUSCATION for U+${ch.codePointAt(0).toString(16)}`,
      );
    }
  });

  test("Hangul filler yields UNICODE_OBFUSCATION_DETECTED", () => {
    const diff = addedDiff("src/id.js", `const name = "user\u3164name";`);
    const res = scanDiff(diff);
    assert.equal(res.ok, false);
    assert.ok(res.findings.some((f) => f.type === "UNICODE_OBFUSCATION_DETECTED"));
  });

  test("Plane 14 tag yields UNICODE_OBFUSCATION_DETECTED", () => {
    const tag = "\u{E0001}";
    const diff = addedDiff("src/tag.js", `const x = "a${tag}b";`);
    const res = scanDiff(diff);
    assert.equal(res.ok, false);
    assert.ok(res.findings.some((f) => f.type === "UNICODE_OBFUSCATION_DETECTED"));

    const plain = checkUnicodeSecurity(`hidden${tag}marker`);
    assert.equal(plain.ok, false);
    assert.ok(plain.violations.some((v) => v.type === "UNICODE_OBFUSCATION_DETECTED"));
  });

  test("Mixed-script confusables in Latin tokens yield MIXED_SCRIPT_CONFUSABLE_DETECTED", () => {
    const cases = [
      "adm\u0456n", // Cyrillic і U+0456
      "p\u0430ssword", // Cyrillic а U+0430
      "g\u0440p_token", // Cyrillic р U+0440
    ];
    for (const token of cases) {
      assert.equal(hasMixedScriptConfusable(token), true, `helper miss: ${token}`);
      const diff = addedDiff("src/login.js", `const user = "${token}";`);
      const res = scanDiff(diff);
      assert.equal(res.ok, false, `scanDiff miss: ${token}`);
      assert.ok(
        res.findings.some(
          (f) => f.type === "MIXED_SCRIPT_CONFUSABLE_DETECTED" && f.severity === "CRITICAL",
        ),
        `missing MIXED_SCRIPT for ${token}`,
      );
    }
  });

  test("clean ASCII diffs pass", () => {
    const diff = addedDiff("src/index.js", "const a = 1;");
    const res = scanDiff(diff);
    assert.equal(res.ok, true);
    assert.equal(res.findings.length, 0);

    const uni = checkUnicodeSecurity(diff);
    assert.equal(uni.ok, true);
    assert.equal(uni.violations.length, 0);

    const ts = checkTrojanSource(diff);
    assert.equal(ts.ok, true);
  });

  test("legitimate international strings/comments do not false-positive", () => {
    const samples = [
      "// Lösenord är hemligt — Swedish comment",
      "// Passwort ändern — German comment",
      "// 日本語のコメントです",
      'const msg = "Привет мир";', // pure Cyrillic string
      'const msg = "Καλημέρα";', // pure Greek
      'const city = "Göteborg";',
      "const label = 'naïve café';",
    ];
    for (const line of samples) {
      assert.equal(hasMixedScriptConfusable(line), false, `FP helper: ${line}`);
      const diff = addedDiff("src/i18n.js", line);
      const res = scanDiff(diff);
      const unicodeFindings = res.findings.filter((f) =>
        [
          "TROJAN_SOURCE_DETECTED",
          "UNICODE_OBFUSCATION_DETECTED",
          "MIXED_SCRIPT_CONFUSABLE_DETECTED",
        ].includes(f.type),
      );
      assert.equal(unicodeFindings.length, 0, `FP scanDiff: ${line} -> ${JSON.stringify(res.findings)}`);
    }
  });

  test("Markdown diffs remain exempt for BiDi and obfuscation", () => {
    const markdownDiff = addedDiff(
      "README.md",
      "Here is bidi \u202E zw\u200B hangul\u3164 and adm\u0456n",
    );
    const res = scanDiff(markdownDiff);
    assert.equal(res.ok, true);
    assert.equal(res.findings.length, 0);
  });
});
