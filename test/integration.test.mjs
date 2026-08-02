import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";

function createTmpGitRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jules-integration-git-"));
  const opts = { cwd: tmpDir, stdio: "ignore" };
  
  execFileSync("git", ["init", "-b", "main"], opts);
  execFileSync("git", ["config", "user.name", "IntegrationTest"], opts);
  execFileSync("git", ["config", "user.email", "test@example.com"], opts);

  // Initial commit
  fs.writeFileSync(path.join(tmpDir, "README.md"), "# Test Repo\n");
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "test-repo", scripts: { test: "echo pass" } }, null, 2));
  
  const agentDir = path.join(tmpDir, ".agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "jules.yml"), "version: 2\ntest_cmd: \"echo pass\"\nforbidden_paths: [\".github/**\", \"**/*.pem\", \"**/lock-manager*\"]\n");
  
  execFileSync("git", ["add", "."], opts);
  execFileSync("git", ["commit", "-m", "initial commit"], opts);

  return tmpDir;
}

const scriptsDir = path.resolve(process.cwd(), "scripts");

describe("Integration Test Harness: End-to-End Execution", () => {

  test("jules-status.mjs executes cleanly on empty and populated queues", () => {
    const repoDir = createTmpGitRepo();
    try {
      const statusScript = path.join(scriptsDir, "jules-status.mjs");
      
      // Empty queue JSON test
      const outJson = execFileSync("node", [statusScript, "--json"], { cwd: repoDir, encoding: "utf-8" });
      const parsed = JSON.parse(outJson);
      assert.ok(Array.isArray(parsed.queue));
      assert.equal(parsed.queue.length, 0);

      // Populate mock queue log
      const queueDir = path.join(repoDir, ".agent/jules-queue");
      fs.mkdirSync(queueDir, { recursive: true });
      fs.writeFileSync(
        path.join(queueDir, "queue.jsonl"),
        JSON.stringify({ file: "TASK-001-test.md", status: "DISPATCHED", timestamp: new Date().toISOString() }) + "\n"
      );

      const outPopulated = execFileSync("node", [statusScript, "--json"], { cwd: repoDir, encoding: "utf-8" });
      const parsedPop = JSON.parse(outPopulated);
      assert.equal(parsedPop.queue.length, 1);
      assert.equal(parsedPop.queue[0].Status, "DISPATCHED");
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("jules-dispatch.mjs dry-run mode executes without remote calls", () => {
    const repoDir = createTmpGitRepo();
    try {
      const dispatchScript = path.join(scriptsDir, "jules-dispatch.mjs");
      const env = { ...process.env, JULES_DRY_RUN: "true", JULES_PROJECT_ROOT: repoDir };
      
      const out = execFileSync("node", [dispatchScript, "Dry Run Feature Task", "Build something cool"], {
        cwd: repoDir,
        env,
        encoding: "utf-8"
      });

      assert.ok(out.includes("DRY RUN"));
      assert.ok(out.includes("Dry Run Feature Task"));
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("jules-self-audit.mjs passes on clean commits", () => {
    const repoDir = createTmpGitRepo();
    try {
      // Create a feature branch with a valid change
      execFileSync("git", ["checkout", "-b", "jules/test-feature"], { cwd: repoDir, stdio: "ignore" });
      fs.writeFileSync(path.join(repoDir, "feature.js"), "console.log('hello world');\n");
      execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "add feature"], { cwd: repoDir, stdio: "ignore" });

      const auditScript = path.join(scriptsDir, "jules-self-audit.mjs");
      const env = { ...process.env, BASE_BRANCH: "main", CI: "true", JULES_PROJECT_ROOT: repoDir };

      const out = execFileSync("node", [auditScript], { cwd: repoDir, env, encoding: "utf-8" });
      assert.ok(out.includes("PASSED") || out.includes("Audit Complete"));
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("jules-self-audit.mjs catches restricted file violations (exit code 3)", () => {
    const repoDir = createTmpGitRepo();
    try {
      execFileSync("git", ["checkout", "-b", "jules/restricted-test"], { cwd: repoDir, stdio: "ignore" });
      
      // Modify a forbidden path (.github/workflow.yml)
      const ghDir = path.join(repoDir, ".github");
      fs.mkdirSync(ghDir, { recursive: true });
      fs.writeFileSync(path.join(ghDir, "ci.yml"), "name: CI\n");
      execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "modify github workflow"], { cwd: repoDir, stdio: "ignore" });

      const auditScript = path.join(scriptsDir, "jules-self-audit.mjs");
      const env = { ...process.env, BASE_BRANCH: "main", CI: "true", JULES_PROJECT_ROOT: repoDir };

      try {
        execFileSync("node", [auditScript], { cwd: repoDir, env, encoding: "utf-8", stdio: "pipe" });
        assert.fail("Should have failed with exit code 3 for restricted file violation");
      } catch (err) {
        assert.equal(err.status, 3, "Exit code should be 3 for RESTRICTED FILE VIOLATION");
        assert.ok(String(err.stderr || err.stdout || "").includes("RESTRICTED FILE VIOLATION"));
      }
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("jules-self-audit.mjs catches secret leak attempts (exit code 6)", () => {
    const repoDir = createTmpGitRepo();
    try {
      execFileSync("git", ["checkout", "-b", "jules/secret-test"], { cwd: repoDir, stdio: "ignore" });
      
      // Add a high-confidence secret token (GitHub Personal Access Token format)
      fs.writeFileSync(path.join(repoDir, "config.js"), 'const token = "ghp_' + 'A'.repeat(36) + '";\n');
      execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "add secret config"], { cwd: repoDir, stdio: "ignore" });

      const auditScript = path.join(scriptsDir, "jules-self-audit.mjs");
      const env = { ...process.env, BASE_BRANCH: "main", CI: "true", JULES_PROJECT_ROOT: repoDir };

      try {
        execFileSync("node", [auditScript], { cwd: repoDir, env, encoding: "utf-8", stdio: "pipe" });
        assert.fail("Should have failed with exit code 6 for secret leak");
      } catch (err) {
        assert.equal(err.status, 6, "Exit code should be 6 for SECRET LEAK PREVENTED");
        assert.ok(String(err.stderr || err.stdout || "").includes("SECRET LEAK PREVENTED"));
      }
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("jules-queue-runner.mjs processes tasks in queue directory", async () => {
    const repoDir = createTmpGitRepo();
    try {
      const queueDir = path.join(repoDir, ".agent/jules-queue");
      fs.mkdirSync(queueDir, { recursive: true });

      // Create a valid task file
      const taskFile = path.join(queueDir, "TASK-001-hello.md");
      fs.writeFileSync(taskFile, "# Hello World Task\n\nPlease implement hello world.");

      const runnerScript = path.join(scriptsDir, "jules-queue-runner.mjs");
      const env = { ...process.env, JULES_DRY_RUN: "true", JULES_PROJECT_ROOT: repoDir };

      const out = execFileSync("node", [runnerScript], { cwd: repoDir, env, encoding: "utf-8" });
      assert.ok(out.includes("Queue processing complete!"));

      // Verify task moved to completed
      const completedFile = path.join(queueDir, "completed/TASK-001-hello.md");
      assert.ok(fs.existsSync(completedFile), "Task file should be moved to completed/");
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
