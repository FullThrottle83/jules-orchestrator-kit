import test from "node:test";
import assert from "node:assert/strict";
import { planTaskCreate, runTaskCreateWizard } from "../src/wizard-task.mjs";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCmd } from "../src/git.mjs";
import { PassThrough } from "node:stream";

test("Guided Task Authoring Subsystem", async (t) => {
  await t.test("planTaskCreate synthesizes task envelope with guardrails and flags", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "jules-task-test-"));
    try {
      const plan = planTaskCreate(tmpDir, {
        title: "Fix Memory Leak",
        prompt: "Refactor event listener lifecycle",
        verifyCmd: "npm test",
        autoPr: true,
        requirePlanApproval: true,
      });

      assert.equal(plan.title, "Fix Memory Leak");
      assert.equal(plan.flags.autoPr, true);
      assert.equal(plan.flags.requirePlanApproval, true);
      assert.ok(plan.fullPrompt.includes("HARD CONSTRAINTS"));
      assert.ok(plan.taskFileContent.includes("Auto-PR: true"));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("planTaskCreate rejects secret leak in prompt", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "jules-task-secret-"));
    try {
      assert.throws(
        () => {
          planTaskCreate(tmpDir, {
            title: "Leaky Task",
            prompt: "Here is the key AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            verifyCmd: "npm test",
          });
        },
        /Pre-Dispatch Secret Leak Blocked/
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("planTaskCreate rejects empty prompt or missing verification oracle", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "jules-task-unfalsifiable-"));
    try {
      assert.throws(
        () => {
          planTaskCreate(tmpDir, { title: "Empty Task", prompt: "" });
        },
        /Task prompt cannot be empty/
      );

      assert.throws(
        () => {
          planTaskCreate(tmpDir, { title: "Vague Task", prompt: "Make code better", verifyCmd: "" });
        },
        /Unfalsifiable Task Rejected/
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("runTaskCreateWizard in non-TTY mode generates .agent/queue/TASK-xxx.md", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "jules-task-wizard-"));
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();

    try {
      runCmd("git init", { cwd: tmpDir });
      runCmd("git config user.name 'Test'", { cwd: tmpDir });
      runCmd("git config user.email 'test@example.com'", { cwd: tmpDir });
      writeFileSync(join(tmpDir, "README.md"), "# Initial\n");
      runCmd("git add README.md", { cwd: tmpDir });
      runCmd("git commit -m 'Initial commit'", { cwd: tmpDir });

      const res = await runTaskCreateWizard(tmpDir, {
        interactive: false,
        title: "Test Queue Task",
        prompt: "Verify task queue creation",
        verifyCmd: "node -v",
        stdin: mockStdin,
        stdout: mockStdout,
      });

      assert.equal(res.ok, true);
      assert.ok(existsSync(res.taskFile));
      const content = readFileSync(res.taskFile, "utf-8");
      assert.ok(content.includes("Test Queue Task"));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
