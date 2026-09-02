import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { runStabilityProbe } from "../src/stability.mjs";
import { assertTestStability } from "../src/assertions.mjs";

const CLI = fileURLToPath(new URL("../bin/agentctl.mjs", import.meta.url));

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "jules-stability-test-"));
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

test("Test Flakiness Stability Prober", async (t) => {
  await t.test("runStabilityProbe confirms deterministic 100% pass across multiple repetitions", () => {
    const root = tempRepo();
    try {
      writeFileSync(
        join(root, "stable.test.mjs"),
        'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("pure stable", () => { assert.equal(1 + 1, 2); });\n'
      );

      const probe = runStabilityProbe("node --test stable.test.mjs", { root, repeat: 3 });
      assert.equal(probe.ok, true);
      assert.equal(probe.passes, 3);
      assert.equal(probe.failures, 0);
      assert.equal(probe.passRate, 1.0);
      assert.equal(probe.oscillation, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("runStabilityProbe rejects non-deterministic flaky tests", () => {
    const root = tempRepo();
    try {
      // Test that fails on even run attempts using state file
      writeFileSync(
        join(root, "flaky.test.mjs"),
        `import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

test("flaky probe", () => {
  const stateFile = ".counter";
  let count = existsSync(stateFile) ? parseInt(readFileSync(stateFile, "utf-8"), 10) : 0;
  count++;
  writeFileSync(stateFile, String(count), "utf-8");
  assert.equal(count % 2 === 1, true, "Intermittent failure triggered on even attempt");
});
`
      );

      const probe = runStabilityProbe("node --test flaky.test.mjs", { root, repeat: 4, minPassRate: 1.0 });
      assert.equal(probe.ok, false);
      assert.ok(probe.failures > 0);
      assert.ok(probe.passRate < 1.0);
      assert.ok(probe.oscillation > 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("assertTestStability primitive validates pass rate", () => {
    const root = tempRepo();
    try {
      writeFileSync(
        join(root, "good.test.mjs"),
        'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("ok", () => { assert.ok(true); });\n'
      );

      const res = assertTestStability(
        { cmd: "node --test good.test.mjs", repeat: 3, minPassRate: 1.0 },
        root
      );
      assert.equal(res.ok, true);
      assert.equal(res.passes, 3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("agentctl probe CLI command outputs JSON report and exits 0 on stable suite", () => {
    const root = tempRepo();
    try {
      writeFileSync(
        join(root, "check.test.mjs"),
        'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("deterministic", () => { assert.equal("a".toUpperCase(), "A"); });\n'
      );

      const proc = spawnSync(
        process.execPath,
        [CLI, "probe", "--cmd", "node --test check.test.mjs", "--repeat", "3", "--json"],
        { cwd: root, encoding: "utf-8" }
      );

      assert.equal(proc.status, 0);
      const parsed = JSON.parse(proc.stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.passes, 3);
      assert.equal(parsed.passRate, 1.0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
