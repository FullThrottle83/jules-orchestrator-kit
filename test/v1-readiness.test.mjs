import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { run } from "../src/engine.mjs";
import { validateEnvelope } from "../src/envelope.mjs";
import { appendTelemetry, verifyTelemetryIntegrity } from "../src/telemetry.mjs";

function createTmpGitRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jules-v1-test-git-"));
  const opts = { cwd: tmpDir, stdio: "ignore" };

  execFileSync("git", ["init", "-b", "main"], opts);
  execFileSync("git", ["config", "user.name", "V1Test"], opts);
  execFileSync("git", ["config", "user.email", "v1test@example.com"], opts);

  fs.writeFileSync(path.join(tmpDir, "README.md"), "# V1 Test Repo\n");
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "v1-test-repo", scripts: { test: "echo pass" } }, null, 2));

  const agentDir = path.join(tmpDir, ".agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "jules.yml"), 'version: 2\ntest_cmd: "echo pass"\n');

  execFileSync("git", ["add", "."], opts);
  execFileSync("git", ["commit", "-m", "initial commit"], opts);

  return tmpDir;
}

describe("v1.0.0 System Readiness & Resilience", () => {
  it("a) Queue runner actually dispatches task before completing", async () => {
    const tmpDir = createTmpGitRepo();
    try {
      const queueDir = path.join(tmpDir, ".agent/jules-queue");
      fs.mkdirSync(queueDir, { recursive: true });
      const taskFile = path.join(queueDir, "TASK-001-v1-readiness.md");
      fs.writeFileSync(taskFile, "# V1 Readiness Task\n\nTask content.");

      const completedFile = path.join(queueDir, "completed/TASK-001-v1-readiness.md");

      // A dry run previews the dispatch and nothing more. This assertion used
      // to read the other way round, which is how the queue quietly drained
      // itself on `--dry-run`.
      const preview = await run({ root: tmpDir, dryRun: true });
      assert.equal(preview.processed, 1);
      assert.equal(preview.results.length, 1);
      assert.equal(preview.results[0].ok, true);
      assert.equal(preview.results[0].session.status, "pending");
      assert.ok(fs.existsSync(taskFile), "Dry run must leave the task file in the queue");
      assert.equal(fs.existsSync(completedFile), false, "Dry run must not populate completed/");

      // A real run against an injected provider does move it.
      const provider = { dispatch: async () => ({ id: "sess-v1", status: "pending" }) };
      const result = await run({ root: tmpDir, provider });
      assert.equal(result.processed, 1);
      assert.equal(result.results[0].ok, true);
      assert.ok(fs.existsSync(completedFile), "Task file must be moved to completed/");
      assert.equal(fs.existsSync(taskFile), false, "Original task file must be removed from queue root");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("b) git cat-file premise check correctly validates committed paths absent from working directory", () => {
    const tmpDir = createTmpGitRepo();
    try {
      // Commit a file to Git base commit
      const committedFile = "src/committed_feature.js";
      const fullPath = path.join(tmpDir, committedFile);
      fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
      fs.writeFileSync(fullPath, "console.log('committed');\n");

      const opts = { cwd: tmpDir, stdio: "ignore" };
      execFileSync("git", ["add", "."], opts);
      execFileSync("git", ["commit", "-m", "add committed feature"], opts);

      // Now remove the file from working directory disk (without committing deletion)
      fs.unlinkSync(fullPath);
      assert.equal(fs.existsSync(fullPath), false, "File removed from working directory disk");

      // Validate envelope referencing the path that exists in Git cat-file but absent on disk
      const envelope = {
        intent: "Refactor committed feature",
        base_commit: "HEAD",
        referenced_paths: [committedFile],
      };

      const res = validateEnvelope(envelope, { root: tmpDir });
      assert.equal(res.ok, true, `Premise check failed unexpectedly: ${res.errors.join(", ")}`);
      assert.equal(res.errors.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("c) Telemetry head desync self-heals without breaking SHA-256 chain integrity", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jules-telemetry-desync-test-"));
    try {
      const dateStr = new Date().toISOString().split("T")[0];
      const stateDir = path.join(tmpDir, ".agent/state");
      fs.mkdirSync(stateDir, { recursive: true });

      // Append initial telemetry events
      appendTelemetry(tmpDir, "event1", { detail: "first" });
      appendTelemetry(tmpDir, "event2", { detail: "second" });

      const initialVer = verifyTelemetryIntegrity(tmpDir);
      assert.equal(initialVer.ok, true);
      assert.equal(initialVer.count, 2);

      // Intentionally desync .head file (overwrite with genesis hash or stale data)
      const headFile = path.join(stateDir, `telemetry-${dateStr}.head`);
      fs.writeFileSync(
        headFile,
        JSON.stringify({ v: 1, hash: "0".repeat(64), segment: 0, ts: new Date().toISOString() }),
        "utf-8"
      );

      // Append new event after crash/desync
      appendTelemetry(tmpDir, "event3", { detail: "third" });

      // Verification must pass with zero broken chain errors
      const healedVer = verifyTelemetryIntegrity(tmpDir);
      assert.equal(healedVer.ok, true, `Telemetry integrity failed: ${JSON.stringify(healedVer)}`);
      assert.equal(healedVer.count, 3);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
