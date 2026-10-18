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
      execSync("git update-ref refs/remotes/origin/main HEAD", { cwd: tmpDir, stdio: "ignore" });
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

  it("dispatch injects role instructions idempotently without duplicating", async () => {
    let capturedPrompt = "";
    const mockProvider = {
      dispatch: async (task) => {
        capturedPrompt = task.prompt;
        return { id: "test-session", status: "completed" };
      }
    };

    const task = {
      title: "Fix bug",
      role: "debugger",
      prompt: "Investigate root cause of timeout.",
    };

    // First dispatch
    await dispatch(task, { provider: mockProvider, dryRun: false });
    const count1 = (capturedPrompt.match(/# Debugger/g) || []).length;
    assert.equal(count1, 1, "Role heading must appear exactly once");

    // Second dispatch with already-precomposed prompt
    const precomposedTask = {
      title: "Fix bug",
      role: "debugger",
      prompt: capturedPrompt,
    };
    await dispatch(precomposedTask, { provider: mockProvider, dryRun: false });
    const count2 = (capturedPrompt.match(/# Debugger/g) || []).length;
    assert.equal(count2, 1, "Precomposed prompt must not duplicate role heading");
  });

  it("dispatch enforces payload size limit on assembled final prompt", async () => {
    const mockProvider = {
      dispatch: async () => ({ id: "oversize-session" })
    };

    const task = {
      title: "Massive task",
      prompt: "A".repeat(1010), // 1010 bytes raw prompt + 20 bytes envelope = 1030 bytes > 1024
    };

    // Set limit to 1 KB (1024 bytes) - raw prompt is 1000 bytes, but envelope + headers push it over 1024 bytes
    await assert.rejects(
      async () => {
        await dispatch(task, {
          provider: mockProvider,
          dryRun: false,
          config: { limits: { promptKb: 1 }, verify: {} }
        });
      },
      /Task prompt exceeds maximum payload limit of 1 KB/
    );
  });

  it("gate in committed mode materializes target HEAD commit and catches failing test", async () => {
    const repo = mkdtempSync(join(tmpdir(), "jok-gate-committed-fail-"));
    try {
      const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
      git("init", "-b", "main");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      mkdirSync(join(repo, ".agent"), { recursive: true });
      writeFileSync(
        join(repo, ".agent", "config.yml"),
        "version: 1\nscope:\n  allow:\n    - '**'\nverify:\n  commands:\n    - node test.js\n"
      );
      writeFileSync(join(repo, "test.js"), "process.exit(0);\n");
      git("add", ".");
      git("commit", "-m", "initial clean main");

      // Switch to feature branch and introduce a failing test commit
      git("checkout", "-b", "feature");
      writeFileSync(join(repo, "test.js"), "process.exit(1);\n");
      git("add", "test.js");
      git("commit", "-m", "introduce broken test");

      // Running gate in committed mode against base main MUST fail on HEAD
      const baseSha = execFileSync("git", ["rev-parse", "main"], { cwd: repo, encoding: "utf8" }).trim();
      const res = await gate({ root: repo, mode: "committed", baseSha });
      assert.equal(res.ok, false);
      assert.equal(res.code, 4, "Must fail with exit code 4 (VERIFY phase failure)");
      const verifyPhase = res.phases.find((p) => p.phase === "verify");
      assert.ok(verifyPhase, "Must have verify phase");
      assert.equal(verifyPhase.ok, false, "Verify phase must fail");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("dispatch rejects prompts with unredacted high-confidence secrets", async () => {
    const mockToken = ["g", "h", "p", "_"].join("") + Array(36).fill("1").join("");
    const task = {
      title: "Secret Task",
      prompt: `Deploy with ${mockToken} token`,
    };
    await assert.rejects(
      async () => {
        await dispatch(task, { dryRun: true });
      },
      /Pre-Dispatch Secret Leak Blocked/
    );
  });
});

describe("dispatch base drift preflight", () => {
  function setupDriftFixture() {
    const baseDir = mkdtempSync(join(tmpdir(), "jok-drift-"));
    const originDir = join(baseDir, "origin.git");
    const workDir = join(baseDir, "work");
    const peerDir = join(baseDir, "peer");
    mkdirSync(originDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });

    execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: originDir });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workDir });
    execFileSync("git", ["config", "user.name", "DriftTest"], { cwd: workDir });
    execFileSync("git", ["remote", "add", "origin", originDir], { cwd: workDir });

    mkdirSync(join(workDir, "src"), { recursive: true });
    writeFileSync(join(workDir, "src", "target.mjs"), "export const v = 1;\n");
    writeFileSync(join(workDir, "src", "other.mjs"), "export const o = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: workDir });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: workDir });
    execFileSync("git", ["push", "-q", "-u", "origin", "main"], { cwd: workDir });

    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workDir, encoding: "utf-8" }).trim();

    execFileSync("git", ["clone", "-q", originDir, peerDir]);
    execFileSync("git", ["config", "user.email", "peer@example.com"], { cwd: peerDir });
    execFileSync("git", ["config", "user.name", "Peer"], { cwd: peerDir });

    const advanceOrigin = (relPath, content = "export const v = 2;\n") => {
      const full = join(peerDir, relPath);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
      execFileSync("git", ["add", "-A"], { cwd: peerDir });
      execFileSync("git", ["commit", "-qm", `advance ${relPath}`], { cwd: peerDir });
      execFileSync("git", ["push", "-q", "origin", "main"], { cwd: peerDir });
      return execFileSync("git", ["rev-parse", "HEAD"], { cwd: peerDir, encoding: "utf-8" }).trim();
    };

    const cleanup = () => {
      try { rmSync(baseDir, { recursive: true, force: true }); } catch (_) {}
    };

    return { baseDir, originDir, workDir, peerDir, baseSha, advanceOrigin, cleanup };
  }

  it("1. Origin moved a target file after baseSha, mode block: returns BASE_DRIFT with the file listed, provider never called", async () => {
    const f = setupDriftFixture();
    try {
      const remoteTip = f.advanceOrigin("src/target.mjs");
      let called = 0;
      const provider = { dispatch: async () => { called++; return { id: "s1", status: "pending" }; } };
      const res = await dispatch(
        { id: "T1", prompt: "Edit target", baseSha: f.baseSha, targetFiles: ["src/target.mjs"] },
        { root: f.workDir, provider, driftCheck: "block", checkpoint: false }
      );
      assert.equal(res.ok, false);
      assert.equal(res.status, "BASE_DRIFT");
      assert.deepEqual(res.drifted, ["src/target.mjs"]);
      assert.equal(res.baseSha, f.baseSha);
      assert.equal(res.remoteTip, remoteTip);
      assert.equal(called, 0);
    } finally {
      f.cleanup();
    }
  });

  it("2. Origin moved only unrelated files: dispatches normally", async () => {
    const f = setupDriftFixture();
    try {
      f.advanceOrigin("src/other.mjs");
      let called = 0;
      const provider = { dispatch: async () => { called++; return { id: "s1", status: "pending" }; } };
      const res = await dispatch(
        { id: "T2", prompt: "Edit target", baseSha: f.baseSha, targetFiles: ["src/target.mjs"], driftCheck: "block" },
        { root: f.workDir, provider, checkpoint: false }
      );
      assert.equal(res.id, "s1");
      assert.equal(called, 1);
    } finally {
      f.cleanup();
    }
  });

  it("3. Glob target (src/**) matches a changed file", async () => {
    const f = setupDriftFixture();
    try {
      f.advanceOrigin("src/nested/deep.mjs");
      let called = 0;
      const provider = { dispatch: async () => { called++; return { id: "s1", status: "pending" }; } };
      const res = await dispatch(
        { id: "T3", prompt: "Edit src", baseSha: f.baseSha, targetFiles: ["src/**"] },
        { root: f.workDir, provider, driftCheck: "block", checkpoint: false }
      );
      assert.equal(res.ok, false);
      assert.equal(res.status, "BASE_DRIFT");
      assert.deepEqual(res.drifted, ["src/nested/deep.mjs"]);
      assert.equal(called, 0);
    } finally {
      f.cleanup();
    }
  });

  it("4. Backslash path in targetFiles is normalised and still matches", async () => {
    const f = setupDriftFixture();
    try {
      f.advanceOrigin("src/target.mjs");
      let called = 0;
      const provider = { dispatch: async () => { called++; return { id: "s1", status: "pending" }; } };
      const res = await dispatch(
        { id: "T4", prompt: "Edit target", baseSha: f.baseSha, targetFiles: ["src\\target.mjs"] },
        { root: f.workDir, provider, driftCheck: "block", checkpoint: false }
      );
      assert.equal(res.ok, false);
      assert.equal(res.status, "BASE_DRIFT");
      assert.deepEqual(res.drifted, ["src/target.mjs"]);
      assert.equal(called, 0);
    } finally {
      f.cleanup();
    }
  });

  it("5. Mode warn: dispatches and emits dispatch_base_drift", async () => {
    const { readTelemetry } = await import("../src/telemetry.mjs");
    const f = setupDriftFixture();
    try {
      const remoteTip = f.advanceOrigin("src/target.mjs");
      let called = 0;
      const provider = { dispatch: async () => { called++; return { id: "s1", status: "pending" }; } };
      const res = await dispatch(
        { id: "T5", prompt: "Edit target", baseSha: f.baseSha, targetFiles: ["src/target.mjs"] },
        { root: f.workDir, provider, driftCheck: "warn", checkpoint: false }
      );
      assert.equal(res.id, "s1");
      assert.equal(called, 1);
      const events = readTelemetry(f.workDir, 50).filter((e) => e.kind === "dispatch_base_drift");
      assert.equal(events.length, 1);
      assert.equal(events[0].baseSha, f.baseSha);
      assert.equal(events[0].remoteTip, remoteTip);
      assert.deepEqual(events[0].files, ["src/target.mjs"]);
    } finally {
      f.cleanup();
    }
  });

  it("6. Mode off (default): no git fetch is run", async () => {
    const f = setupDriftFixture();
    try {
      const remoteTip = f.advanceOrigin("src/target.mjs");
      let called = 0;
      const provider = { dispatch: async () => { called++; return { id: "s1", status: "pending" }; } };
      const res = await dispatch(
        { id: "T6", prompt: "Edit target", baseSha: f.baseSha, targetFiles: ["src/target.mjs"] },
        { root: f.workDir, provider, checkpoint: false }
      );
      assert.equal(res.id, "s1");
      assert.equal(called, 1);
      const localOriginTip = execFileSync("git", ["rev-parse", "origin/main"], { cwd: f.workDir, encoding: "utf-8" }).trim();
      assert.equal(localOriginTip, f.baseSha, "origin/main must remain at baseSha when no git fetch was run");
      assert.notEqual(localOriginTip, remoteTip);
    } finally {
      f.cleanup();
    }
  });

  it("7. Fetch fails: block gives BASE_UNKNOWN, warn continues", async () => {
    const f = setupDriftFixture();
    try {
      execFileSync("git", ["remote", "set-url", "origin", join(f.baseDir, "nonexistent-origin.git")], { cwd: f.workDir });
      let called = 0;
      const provider = { dispatch: async () => { called++; return { id: "s1", status: "pending" }; } };

      const blocked = await dispatch(
        { id: "T7-block", prompt: "Edit target", baseSha: f.baseSha, targetFiles: ["src/target.mjs"] },
        { root: f.workDir, provider, driftCheck: "block", checkpoint: false }
      );
      assert.equal(blocked.ok, false);
      assert.equal(blocked.status, "BASE_UNKNOWN");
      assert.equal(called, 0);

      const warned = await dispatch(
        { id: "T7-warn", prompt: "Edit target", baseSha: f.baseSha, targetFiles: ["src/target.mjs"] },
        { root: f.workDir, provider, driftCheck: "warn", checkpoint: false }
      );
      assert.equal(warned.id, "s1");
      assert.equal(called, 1);
    } finally {
      f.cleanup();
    }
  });

  it("8. Dry run: no fetch, never blocks", async () => {
    const f = setupDriftFixture();
    try {
      f.advanceOrigin("src/target.mjs");
      let called = 0;
      const provider = { dispatch: async () => { called++; return { id: "dry-run-session-id", status: "pending" }; } };
      const res = await dispatch(
        { id: "T8", prompt: "Edit target", baseSha: f.baseSha, targetFiles: ["src/target.mjs"] },
        { root: f.workDir, provider, driftCheck: "block", dryRun: true, checkpoint: false }
      );
      assert.equal(res.id, "dry-run-session-id");
      assert.equal(called, 1);
      const localOriginTip = execFileSync("git", ["rev-parse", "origin/main"], { cwd: f.workDir, encoding: "utf-8" }).trim();
      assert.equal(localOriginTip, f.baseSha, "dry-run must not fetch origin/main");
    } finally {
      f.cleanup();
    }
  });

  it("9. Unresolvable baseSha does not throw", async () => {
    const f = setupDriftFixture();
    try {
      let called = 0;
      const provider = { dispatch: async () => { called++; return { id: "s1", status: "pending" }; } };
      const deadSha = "deadbeef".repeat(5);

      const blocked = await dispatch(
        { id: "T9-block", prompt: "Edit target", baseSha: deadSha, targetFiles: ["src/target.mjs"] },
        { root: f.workDir, provider, driftCheck: "block", checkpoint: false }
      );
      assert.equal(blocked.ok, false);
      assert.equal(blocked.status, "BASE_UNKNOWN");
      assert.equal(called, 0);

      const warned = await dispatch(
        { id: "T9-warn", prompt: "Edit target", baseSha: deadSha, targetFiles: ["src/target.mjs"] },
        { root: f.workDir, provider, driftCheck: "warn", checkpoint: false }
      );
      assert.equal(warned.id, "s1");
      assert.equal(called, 1);
    } finally {
      f.cleanup();
    }
  });
});

