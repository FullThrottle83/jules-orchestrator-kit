import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { runStabilityProbe } from "../src/stability.mjs";
import { assertTestStability } from "../src/assertions.mjs";
import { listQuarantinedTests, readVerifyRuns } from "../src/flaky-ledger.mjs";

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
        'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("ok", () => { assert.equal(2 + 2, 4); });\n'
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

  await t.test("runStabilityProbe records per-run outcomes into flaky ledger by default", () => {
    const root = tempRepo();
    try {
      writeFileSync(
        join(root, "check.test.mjs"),
        'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("ok", () => { const sum = 1 + 2; assert.equal(sum, 3); });\n'
      );

      const probe = runStabilityProbe("node --test check.test.mjs", { root, repeat: 3 });
      assert.equal(probe.ok, true);
      const runs = readVerifyRuns(root, "node --test check.test.mjs");
      assert.equal(runs.length, 3);
      assert.ok(runs.every((r) => r.pass === true));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("agentctl probe connects oscillating tests to flaky quarantine ledger and listQuarantinedTests", () => {
    const root = tempRepo();
    try {
      writeFileSync(
        join(root, "flaky.test.mjs"),
        `import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

test("flaky test", () => {
  const file = ".osc_counter";
  let count = existsSync(file) ? parseInt(readFileSync(file, "utf-8"), 10) : 0;
  count++;
  writeFileSync(file, String(count), "utf-8");
  assert.equal(count % 2 === 1, true, "Oscillating failure on even count");
});
`
      );

      const proc = spawnSync(
        process.execPath,
        [CLI, "probe", "--cmd", "node --test flaky.test.mjs", "--repeat", "6", "--json"],
        { cwd: root, encoding: "utf-8" }
      );

      assert.equal(proc.status, 1);
      const quarantined = listQuarantinedTests(root);
      assert.equal(quarantined.length, 1);
      assert.equal(quarantined[0].testCmd, "node --test flaky.test.mjs");
      assert.equal(quarantined[0].verdict, "QUARANTINED");
      assert.ok(quarantined[0].oscillation >= 0.4);

      // Verify CLI flaky status outputs the quarantine
      const statusProc = spawnSync(
        process.execPath,
        [CLI, "flaky", "status", "--json"],
        { cwd: root, encoding: "utf-8" }
      );
      assert.equal(statusProc.status, 0);
      const statusParsed = JSON.parse(statusProc.stdout);
      assert.equal(statusParsed.count, 1);
      assert.equal(statusParsed.quarantined[0].testCmd, "node --test flaky.test.mjs");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("agentctl probe --no-record skips writing to flaky ledger", () => {
    const root = tempRepo();
    try {
      writeFileSync(
        join(root, "check.test.mjs"),
        'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("deterministic", () => { const msg = "hello".toUpperCase(); assert.equal(msg, "HELLO"); });\n'
      );

      const proc = spawnSync(
        process.execPath,
        [CLI, "probe", "--cmd", "node --test check.test.mjs", "--repeat", "3", "--no-record", "--json"],
        { cwd: root, encoding: "utf-8" }
      );

      assert.equal(proc.status, 0);
      const runs = readVerifyRuns(root);
      assert.equal(runs.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
