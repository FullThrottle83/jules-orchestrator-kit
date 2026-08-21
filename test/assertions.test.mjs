import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertDirSize,
  assertFileSize,
  assertFilePatterns,
  assertFileExists,
  runAssertion,
  matchesGlob,
  formatBytes,
  resolveBytesLimit,
} from "../src/assertions.mjs";

describe("Declarative Assertion Primitives (src/assertions.mjs)", () => {
  test("matchesGlob matches simple patterns and recursive globs", () => {
    assert.equal(matchesGlob("dist/server/index.js", "dist/**"), true);
    assert.equal(matchesGlob("dist/server/index.js", "dist/**/*.js"), true);
    assert.equal(matchesGlob("src/index.ts", "*.ts"), false);
    assert.equal(matchesGlob("src/index.ts", "src/*.ts"), true);
    assert.equal(matchesGlob("src/nested/deep/file.js", "src/**/*.js"), true);
    assert.equal(matchesGlob("src/nested/deep/file.txt", "src/**/*.js"), false);
  });

  test("resolveBytesLimit parses units correctly", () => {
    assert.equal(resolveBytesLimit({ maxBytes: 500 }), 500);
    assert.equal(resolveBytesLimit({ maxKb: 2 }), 2048);
    assert.equal(resolveBytesLimit({ maxMb: 1 }), 1024 * 1024);
    assert.equal(resolveBytesLimit({ maxGb: 1 }), 1024 * 1024 * 1024);
    assert.equal(resolveBytesLimit({}), null);
  });

  test("formatBytes produces readable strings", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(1024), "1 KiB");
    assert.equal(formatBytes(1024 * 1024 * 5), "5 MiB");
  });

  test("assertDirSize measures directory size and enforces limits", () => {
    const tmp = mkdtempSync(join(tmpdir(), "assert-dir-"));
    try {
      mkdirSync(join(tmp, "sub"), { recursive: true });
      writeFileSync(join(tmp, "sub", "a.js"), "console.log('hello world');\n".repeat(10));
      writeFileSync(join(tmp, "b.css"), "body { margin: 0; }\n".repeat(10));

      const resPass = assertDirSize({ path: ".", maxKb: 50 }, tmp);
      assert.equal(resPass.ok, true);
      assert.equal(resPass.fileCount, 2);
      assert.ok(resPass.measuredBytes > 0);

      const resFail = assertDirSize({ path: ".", maxBytes: 50 }, tmp);
      assert.equal(resFail.ok, false);
      assert.ok(resFail.exceededBy > 0);
      assert.ok(resFail.diagnostics[0].includes("exceeds limit"));

      // With gzip compression
      const resGzip = assertDirSize({ path: ".", maxKb: 50, gzip: true }, tmp);
      assert.equal(resGzip.ok, true);
      assert.equal(resGzip.gzip, true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("assertFileSize measures individual file size", () => {
    const tmp = mkdtempSync(join(tmpdir(), "assert-file-"));
    try {
      const file = join(tmp, "bundle.js");
      writeFileSync(file, "x".repeat(5000));

      const pass = assertFileSize({ file: "bundle.js", maxKb: 10 }, tmp);
      assert.equal(pass.ok, true);
      assert.equal(pass.measuredBytes, 5000);

      const fail = assertFileSize({ file: "bundle.js", maxBytes: 1000 }, tmp);
      assert.equal(fail.ok, false);
      assert.equal(fail.exceededBy, 4000);
      assert.ok(fail.diagnostics[0].includes("exceeds limit"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("assertFilePatterns detects banned terms and regex matches", () => {
    const tmp = mkdtempSync(join(tmpdir(), "assert-patterns-"));
    try {
      mkdirSync(join(tmp, "src"), { recursive: true });
      writeFileSync(join(tmp, "src", "clean.js"), "const x = 1;\nconst y = 2;\n");
      writeFileSync(
        join(tmp, "src", "dirty.js"),
        "const forbiddenWord = 'AI_GENERATED_SLOP';\ndebugger;\nconsole.log(forbiddenWord);\n"
      );

      const pass = assertFilePatterns(
        { targets: "src/**/*.js", patterns: ["FORBIDDEN_KEYWORD"] },
        tmp
      );
      assert.equal(pass.ok, true);
      assert.equal(pass.matchCount, 0);

      const fail = assertFilePatterns(
        { targets: "src/**/*.js", patterns: ["AI_GENERATED_SLOP", "debugger;"] },
        tmp
      );
      assert.equal(fail.ok, false);
      assert.equal(fail.matchCount, 2);
      assert.equal(fail.matches[0].file, "src/dirty.js");
      assert.equal(fail.matches[0].line, 1);
      assert.equal(fail.matches[1].line, 2);
      assert.ok(fail.diagnostics[0].includes("Forbidden pattern"));

      // Using patternsFile
      const patFile = join(tmp, "banned.json");
      writeFileSync(patFile, JSON.stringify(["debugger;"]));
      const patFileRes = assertFilePatterns(
        { targets: "src/**/*.js", patternsFile: "banned.json" },
        tmp
      );
      assert.equal(patFileRes.ok, false);
      assert.equal(patFileRes.matchCount, 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("assertFileExists checks presence and absence", () => {
    const tmp = mkdtempSync(join(tmpdir(), "assert-exists-"));
    try {
      writeFileSync(join(tmp, "present.txt"), "hello");

      const presentRes = assertFileExists({ path: "present.txt", mustExist: true }, tmp);
      assert.equal(presentRes.ok, true);

      const missingRes = assertFileExists({ path: "absent.txt", mustExist: true }, tmp);
      assert.equal(missingRes.ok, false);
      assert.ok(missingRes.diagnostics[0].includes("does not exist"));

      const absentOk = assertFileExists({ path: "absent.txt", mustExist: false }, tmp);
      assert.equal(absentOk.ok, true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("runAssertion dispatches correctly for all types", () => {
    const tmp = mkdtempSync(join(tmpdir(), "assert-dispatch-"));
    try {
      writeFileSync(join(tmp, "test.txt"), "abc");

      const resDir = runAssertion({ assert: "dir-size", path: ".", maxMb: 1 }, tmp);
      assert.equal(resDir.ok, true);
      assert.equal(resDir.status, 0);
      assert.equal(resDir.assertionType, "dir-size");

      const resFile = runAssertion({ assert: "file-size", file: "test.txt", maxBytes: 10 }, tmp);
      assert.equal(resFile.ok, true);
      assert.equal(resFile.status, 0);

      const resPatterns = runAssertion(
        { assert: "file-patterns", targets: "*.txt", patterns: ["xyz"] },
        tmp
      );
      assert.equal(resPatterns.ok, true);
      assert.equal(resPatterns.status, 0);

      const resUnknown = runAssertion({ assert: "unsupported-check" }, tmp);
      assert.equal(resUnknown.ok, false);
      assert.equal(resUnknown.status, 1);
      assert.ok(resUnknown.diagnostics[0].includes("Unknown assertion primitive"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
