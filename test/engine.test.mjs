import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { gate, dispatch, run, synthesizePrDescription } from "../src/engine.mjs";
import { checkDailyBudget } from "../src/state.mjs";

describe("src/engine.mjs", () => {
  it("gate passes clean repository verification", async () => {
    // Against a fixture, not against this repository.
    //
    // This ran `gate({ root: process.cwd() })`, so the kit gated itself and
    // the verify stage ran `npm test` — the whole suite, from inside the
    // suite. It never finished; the stage timeout was its only stopping
    // condition, so the test cost exactly one timeout every run and asserted
    // only that `ok` was a boolean, which it would have been either way.
    // Raising the default from 60s to 300s turned that into a CI failure,
    // which is how a test that verified nothing finally got noticed.
    const repo = mkdtempSync(join(tmpdir(), "jok-gate-clean-"));
    try {
      const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
      git("init", "-b", "main");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "EngineTest");
      writeFileSync(join(repo, "index.js"), "module.exports = (a, b) => a + b;\n");
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({ name: "gate-clean", scripts: { test: "node --check index.js" } }, null, 2)
      );
      mkdirSync(join(repo, ".agent"), { recursive: true });
      writeFileSync(join(repo, ".agent", "jules.yml"), 'version: 2\ntest_cmd: "node --check index.js"\nforbidden_paths: []\n');
      git("add", ".");
      git("commit", "-m", "initial commit");

      const res = await gate({ root: repo, base: "main" });
      assert.equal(res.ok, true, "a clean repository with a working oracle is approved");
      assert.ok(Array.isArray(res.phases));
      assert.ok(res.phases.some((p) => p.phase === "verify"), "the verify phase ran");
    } finally {
      try { rmSync(repo, { recursive: true, force: true }); } catch (_) {}
    }
  });

  it("dispatch generates dry-run session in dry-run mode", async () => {
    const task = { title: "Test Task", prompt: "Hello agent" };
    const session = await dispatch(task, { dryRun: true });
    assert.equal(session.id, "dry-run-session-id");
    assert.equal(session.status, "pending");
  });

  it("dry-run dispatch does not consume a daily budget slot", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "jok-dryrun-"));
    try {
      const ledgerDir = join(tmpDir, ".agent", "state");
      mkdirSync(ledgerDir, { recursive: true });

      // A dry run makes no provider call, so it must leave the budget untouched.
      // Reserving here previously exhausted the operator's 300 daily slots
      // through nothing but repeated `npm test` runs.
      const before = checkDailyBudget(tmpDir, 300).used;
      await dispatch({ title: "Dry", prompt: "No-op" }, { root: tmpDir, dryRun: true });
      const after = checkDailyBudget(tmpDir, 300).used;

      assert.equal(after, before, "dry-run must not reserve budget");
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  it("dry-run queue run leaves the task files in the queue", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "jok-dryqueue-"));
    try {
      const queueDir = join(tmpDir, ".agent", "jules-queue");
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, "TASK-01.md"), "# Task ID: TASK-01\n\nDo the thing.\n");

      const res = await run({ root: tmpDir, dryRun: true });

      assert.equal(res.processed, 1);
      assert.equal(res.results[0].dryRun, true);
      // A dry run simulates. Moving the file to completed/ meant a second
      // `--dry-run` preview found an empty queue.
      assert.equal(existsSync(join(queueDir, "TASK-01.md")), true, "dry-run must not move the task file");
      assert.equal(existsSync(join(queueDir, "completed")), false, "dry-run must not create completed/");
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  it("a real dispatch still reserves budget", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "jok-wet-"));
    try {
      mkdirSync(join(tmpDir, ".agent", "state"), { recursive: true });
      const before = checkDailyBudget(tmpDir, 300).used;
      const provider = { dispatch: async () => ({ id: "sess-1", status: "pending" }) };
      await dispatch({ title: "Wet", prompt: "Do work" }, { root: tmpDir, provider });
      const after = checkDailyBudget(tmpDir, 300).used;

      assert.equal(after, before + 1, "a live dispatch must consume exactly one slot");
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  it("synthesizePrDescription generates evidence-backed PR description body", () => {
    const prBody = synthesizePrDescription(
      { id: "sess-777", attempts: [1, 2], resumed: true },
      {
        phases: [
          { phase: "scope", ok: true },
          { phase: "payload", ok: true, bytes: 12000, limitBytes: 76800 },
          { phase: "secrets", ok: true },
        ],
      },
      {
        durationMs: 4500,
        modifiedFiles: ["src/auth.mjs"],
        knownTestFiles: ["test/auth.test.mjs"],
        testOutput: "✔ 12 tests passed",
      }
    );

    assert.ok(prBody.includes("Autonomous Agent Execution Summary") || prBody.includes("Autonomous Jules Agent Execution Evidence"));
    assert.ok(prBody.includes("`sess-777`"));
    assert.ok(prBody.includes("`2/3`"));
    assert.ok(prBody.includes("✅ Active Context Stream"));
    assert.ok(prBody.includes("✔ 12 tests passed"));
    assert.ok(prBody.includes("test/auth.test.mjs"));
  });

  it("gate executes setup -> test -> teardown lifecycle sequentially and guarantees teardown on failure", async () => {
    const { mkdtempSync, rmSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const tmpDir = mkdtempSync(join(tmpdir(), "lifecycle-test-"));
    const { execSync } = await import("node:child_process");
    try {
      execSync("git init -b main", { cwd: tmpDir, stdio: "ignore" });
      execSync('git config user.name "Test"', { cwd: tmpDir, stdio: "ignore" });
      execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: "ignore" });
      execSync('git commit --allow-empty -m "initial"', { cwd: tmpDir, stdio: "ignore" });
      const setupFile = join(tmpDir, "setup.flag");
      const testFile = join(tmpDir, "test.flag");
      const teardownFile = join(tmpDir, "teardown.flag");

      const mockConfig = {
        baseBranch: "main",
        scope: { deny: [], allow: [], protect: [] },
        limits: { diffKb: 75 },
        verify: {
          setup: `node -e "require('fs').writeFileSync('${setupFile.replace(/\\/g, "/")}', 'setup_ok')"`,
          test: `node -e "require('fs').writeFileSync('${testFile.replace(/\\/g, "/")}', 'test_ok'); process.exit(1)"`, // Fails test
          teardown: `node -e "require('fs').writeFileSync('${teardownFile.replace(/\\/g, "/")}', 'teardown_ok')"`,
          timeoutMs: 10000,
        },
      };

      const res = await gate({ root: tmpDir, config: mockConfig });
      assert.equal(res.ok, false, "Expected gate to fail due to process.exit(1)");
      assert.ok(existsSync(setupFile), "Expected setup command to execute");
      assert.ok(existsSync(testFile), "Expected test command to execute");
      assert.ok(existsSync(teardownFile), "Expected teardown command to execute unconditionally in finally block");
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });
});
