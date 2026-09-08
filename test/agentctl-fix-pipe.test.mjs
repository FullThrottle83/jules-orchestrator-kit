import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";

const CLI = fileURLToPath(new URL("../bin/agentctl.mjs", import.meta.url));

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "jules-fix-pipe-test-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "test-pkg",
      version: "1.0.0",
      type: "module",
      scripts: { test: "node --test" },
    })
  );
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

test("CLI Stdin Stream Pipeline (agentctl fix)", async (t) => {
  await t.test("agentctl fix --task synthesizes OODA repair task envelope from piped stdin", () => {
    const root = tempRepo();
    try {
      const errorLog = [
        "TypeError: Cannot read properties of undefined (reading 'token')",
        "    at authenticate (src/auth.mjs:24:18)",
        "    at TestContext.<anonymous> (test/auth.test.mjs:12:5)",
      ].join("\n");

      const proc = spawnSync(
        process.execPath,
        [CLI, "fix", "--task", "--json"],
        {
          cwd: root,
          input: errorLog,
          encoding: "utf-8",
        }
      );

      assert.equal(proc.status, 0);
      const parsed = JSON.parse(proc.stdout);
      assert.ok(parsed.taskId);
      assert.ok(parsed.prompt.includes("authenticate"));
      assert.ok(parsed.verifyCmd);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("agentctl fix --file reads error log from disk and creates task", () => {
    const root = tempRepo();
    try {
      const logPath = join(root, "error.log");
      writeFileSync(logPath, "AssertionError: expected true but got false\n    at test/calc.test.mjs:5:10\n");

      const proc = spawnSync(
        process.execPath,
        [CLI, "fix", "--file", logPath, "--task", "--json"],
        {
          cwd: root,
          encoding: "utf-8",
        }
      );

      assert.equal(proc.status, 0);
      const parsed = JSON.parse(proc.stdout);
      assert.ok(parsed.taskId);
      assert.ok(parsed.prompt.includes("AssertionError"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("agentctl fix rejects empty stdin without arguments", () => {
    const root = tempRepo();
    try {
      const proc = spawnSync(
        process.execPath,
        [CLI, "fix"],
        {
          cwd: root,
          input: "   ",
          encoding: "utf-8",
        }
      );

      assert.equal(proc.status, 1);
      assert.ok(proc.stderr.includes("No error log or failure input provided"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("agentctl fix --task handles stack traces with file:// URIs without false-positive secret block", () => {
    const root = tempRepo();
    try {
      const stackTrace = [
        "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
        "+ actual - expected",
        "",
        "+ 5",
        "- 4",
        "    at TestContext.<anonymous> (file:///tmp/jules-breadth-eval/test/calculator.test.js:6:10)",
        "    at Test.runInAsyncScope (node:async_hooks:206:9)",
      ].join("\n");

      const proc = spawnSync(
        process.execPath,
        [CLI, "fix", "--task", "--json"],
        {
          cwd: root,
          input: stackTrace,
          encoding: "utf-8",
        }
      );

      assert.equal(proc.status, 0);
      const parsed = JSON.parse(proc.stdout);
      assert.ok(parsed.taskId);
      assert.ok(parsed.prompt.includes("calculator.test.js"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("agentctl fix --task reads streamed stdin pipe asynchronously without EAGAIN", async () => {
    const root = tempRepo();
    try {
      const { spawn } = await import("node:child_process");
      const child = spawn(
        process.execPath,
        [CLI, "fix", "--task", "--json"],
        {
          cwd: root,
          stdio: ["pipe", "pipe", "pipe"],
        }
      );

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });

      // Stream data in chunks to simulate active writer
      child.stdin.write("AssertionError: value mismatch\n");
      await new Promise((r) => setTimeout(r, 10));
      child.stdin.write("    at verify (src/index.mjs:10:5)\n");
      child.stdin.end();

      const exitCode = await new Promise((resolve) => {
        child.on("close", resolve);
      });

      assert.equal(exitCode, 0, `stderr: ${stderr}`);
      const parsed = JSON.parse(stdout);
      assert.ok(parsed.taskId);
      assert.ok(parsed.prompt.includes("value mismatch"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
