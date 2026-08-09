import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseProcStat,
  getProcessStartTime,
  isTaskFile,
  createExecutionEnvelope,
  resolveBase,
  runCmd,
} from "../index.mjs";

describe("Edge Fixes & Critical Safeguards", () => {
  describe("a) /proc/<pid>/stat parsing robustness", () => {
    test("correctly parses starttime when process title contains spaces", () => {
      // Field 3 (state) = R (index 0 after rpar+2)
      // Field 22 (starttime) = 100200300 (index 19 after rpar+2)
      const mockStat = "12345 (jules worker task) R 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 100200300 20 21";
      const starttime = parseProcStat(mockStat);
      assert.strictEqual(starttime, "100200300", "Must extract starttime (field 22) correctly despite spaces in process title");
    });

    test("correctly parses starttime when process title contains nested parentheses and spaces", () => {
      const mockStat = "12345 (jules (worker) task) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 99887766 20 21";
      const starttime = parseProcStat(mockStat);
      assert.strictEqual(starttime, "99887766", "Must extract starttime correctly using lastIndexOf(')')");
    });

    test("getProcessStartTime handles mock stat string inputs cleanly", () => {
      const mockStat = "999 (worker process title) R 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 77665544 20 21";
      const starttime = getProcessStartTime(mockStat);
      assert.strictEqual(starttime, "77665544");
    });

    test("returns null for malformed stat strings without closing parenthesis", () => {
      assert.strictEqual(parseProcStat("invalid stat line without parens"), null);
    });
  });

  describe("b) Queue task matching & README.md filtering", () => {
    test("explicitly filters out README.md regardless of case", () => {
      assert.strictEqual(isTaskFile("README.md"), false);
      assert.strictEqual(isTaskFile("readme.md"), false);
      assert.strictEqual(isTaskFile("ReadMe.MD"), false);
      assert.strictEqual(isTaskFile(".agent/jules-queue/README.md"), false);
    });

    test("matches task files named TASK-*.md", () => {
      assert.strictEqual(isTaskFile("TASK-001-init.md"), true);
      assert.strictEqual(isTaskFile("task-subtask.md"), true);
      assert.strictEqual(isTaskFile("TASK-BUGFIX.md"), true);
    });

    test("matches files with valid envelope front-matter", () => {
      const validFmContent = "---\ntaskId: task-123\ntitle: Sample Task\n---\n# Task Description";
      assert.strictEqual(isTaskFile("custom-name.md", validFmContent), true);
    });

    test("rejects files without TASK- prefix or envelope front-matter", () => {
      const plainContent = "# Just a normal note\nNo front-matter here.";
      assert.strictEqual(isTaskFile("notes.md", plainContent), false);
      assert.strictEqual(isTaskFile("random.txt"), false);
    });
  });

  describe("c) Immutable base commit SHA resolution", () => {
    test("resolveBase returns a 40-character commit SHA", () => {
      const sha = resolveBase(process.cwd(), "HEAD");
      assert.ok(typeof sha === "string", "resolveBase must return a string");
      assert.strictEqual(sha.length, 40, "Base commit SHA must be 40 hexadecimal characters");
      assert.ok(/^[0-9a-f]{40}$/i.test(sha), "Base commit SHA must match 40-char hex pattern");
    });

    test("createExecutionEnvelope pins baseSha to exact 40-char commit SHA", () => {
      const envelope = createExecutionEnvelope(
        { id: "task-sha-test", files: ["src/state.mjs"] },
        { base: "HEAD" }
      );
      assert.ok(envelope.baseSha);
      assert.strictEqual(envelope.baseSha.length, 40);
      assert.ok(/^[0-9a-f]{40}$/i.test(envelope.baseSha), "baseSha in envelope must be a 40-char commit hash");
    });
  });

  describe("d) Process execution guardrails & error handling", () => {
    test("runCmd catches buffer limits (ENOBUFS) gracefully when ignoreError is true", () => {
      const res = runCmd(["node", "-e", "console.log('A'.repeat(200))"], {
        maxBuffer: 50,
        ignoreError: true,
      });
      assert.notStrictEqual(res.status, 0);
      assert.ok(res.stderr.includes("ENOBUFS") || res.stderr.includes("buffer"));
    });

    test("runCmd catches timeouts (ETIMEDOUT) gracefully when ignoreError is true", () => {
      const res = runCmd(["node", "-e", "setTimeout(() => {}, 5000)"], {
        timeout: 50,
        ignoreError: true,
      });
      assert.strictEqual(res.status, 124);
      assert.ok(res.stderr.includes("ETIMEDOUT") || res.stderr.includes("timed out"));
    });
  });
});
