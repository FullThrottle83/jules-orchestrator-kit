import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { measureEventLoopDelay } from "../src/perf.mjs";
import { assertEventLoopLag } from "../src/assertions.mjs";

const CLI = fileURLToPath(new URL("../bin/agentctl.mjs", import.meta.url));

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "jules-perf-test-"));
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

test("Node.js Event Loop Delay & Big-O Lag Monitor", async (t) => {
  await t.test("measureEventLoopDelay measures healthy non-blocking execution", () => {
    const res = measureEventLoopDelay(() => {
      let sum = 0;
      for (let i = 0; i < 1000; i++) sum += i;
      return sum;
    }, { maxDelayMs: 50 });

    assert.equal(res.ok, true);
    assert.ok(typeof res.p99Ms === "number");
    assert.ok(typeof res.maxMs === "number");
    assert.ok(res.p99Ms <= 50);
  });

  await t.test("measureEventLoopDelay runs CLI test commands and captures metrics", () => {
    const root = tempRepo();
    try {
      writeFileSync(
        join(root, "math.test.mjs"),
        'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("fast math", () => { assert.equal(2 * 2, 4); });\n'
      );

      const res = measureEventLoopDelay("node --test math.test.mjs", { root, maxDelayMs: 100 });
      assert.equal(res.ok, true);
      assert.equal(res.exitCode, 0);
      assert.ok(res.summary.includes("Event Loop Delay"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("assertEventLoopLag primitive passes for fast execution", () => {
    const root = tempRepo();
    try {
      writeFileSync(
        join(root, "fast.test.mjs"),
        'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("fast", () => { assert.ok(true); });\n'
      );

      const res = assertEventLoopLag({ cmd: "node --test fast.test.mjs", maxDelayMs: 100 }, root);
      assert.equal(res.ok, true);
      assert.ok(res.p99Ms <= 100);
      assert.equal(res.diagnostics.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("agentctl perf CLI outputs JSON metrics and exits 0", () => {
    const root = tempRepo();
    try {
      writeFileSync(
        join(root, "quick.test.mjs"),
        'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("quick", () => { assert.equal(1, 1); });\n'
      );

      const proc = spawnSync(
        process.execPath,
        [CLI, "perf", "--cmd", "node --test quick.test.mjs", "--max-ms", "100", "--json"],
        { cwd: root, encoding: "utf-8" }
      );

      assert.equal(proc.status, 0);
      const parsed = JSON.parse(proc.stdout);
      assert.equal(parsed.ok, true);
      assert.ok(typeof parsed.p99Ms === "number");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
