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
});
