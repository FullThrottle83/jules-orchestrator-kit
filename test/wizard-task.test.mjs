import test from "node:test";
import assert from "node:assert/strict";
import { planTaskCreate, runTaskCreateWizard } from "../src/wizard-task.mjs";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

  await t.test("planTaskCreate detects multiline secrets and blocks high-confidence credentials unconditionally", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "jules-task-multiline-secret-"));
    try {
      // Secret on line 2
      const multilinePrompt = "Line 1: Normal instruction text\nLine 2: AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      assert.throws(
        () => {
          planTaskCreate(tmpDir, { title: "Multiline Secret Task", prompt: multilinePrompt, verifyCmd: "npm test" });
        },
        /Pre-Dispatch Secret Leak Blocked/
      );

      // High confidence secret cannot be bypassed with allowSecrets: true
      assert.throws(
        () => {
          planTaskCreate(tmpDir, {
            title: "Bypass Secret Task",
            prompt: multilinePrompt,
            verifyCmd: "npm test",
            allowSecrets: true,
          });
        },
        /High-confidence credentials cannot be bypassed/
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("planTaskCreate rejects trivial verification oracles", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "jules-task-trivial-"));
    try {
      assert.throws(
        () => {
          planTaskCreate(tmpDir, { title: "Trivial Task", prompt: "Do something", verifyCmd: "true" });
        },
        /Unfalsifiable Task Rejected/
      );

      assert.throws(
        () => {
          planTaskCreate(tmpDir, { title: "Trivial Task 2", prompt: "Do something", verifyCmd: "echo ok" });
        },
        /Unfalsifiable Task Rejected/
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("runTaskCreateWizard generates task in canonical jules-queue directory with path traversal guard and JSON envelope", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "jules-task-wizard-"));
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();

    try {
      runCmd("git init", { cwd: tmpDir });
      runCmd('git config user.name "Test"', { cwd: tmpDir });
      runCmd('git config user.email "test@example.com"', { cwd: tmpDir });
      writeFileSync(join(tmpDir, "README.md"), "# Initial\n");
      runCmd("git add README.md", { cwd: tmpDir });
      runCmd('git commit -m "Initial commit"', { cwd: tmpDir });

      const res = await runTaskCreateWizard(tmpDir, {
        interactive: false,
        title: "Test Queue Task",
        prompt: "Verify task queue creation",
        verifyCmd: "npm test",
        id: "../../traversal-task",
        stdin: mockStdin,
        stdout: mockStdout,
      });

      assert.equal(res.ok, true);
      assert.ok(res.taskFile.includes(".agent/jules-queue"));
      assert.ok(existsSync(res.taskFile));

      const content = readFileSync(res.taskFile, "utf-8");
      assert.ok(content.includes("JULES_TASK_ENVELOPE"));
      assert.ok(content.includes("traversal-task"));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("planTaskCreate resolves role from .agent/prompts/ and attaches to envelope", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "jules-task-role-"));
    try {
      const promptsDir = join(tmpDir, ".agent", "prompts");
      mkdirSync(promptsDir, { recursive: true });
      writeFileSync(
        join(promptsDir, "Bolt.md"),
        "# Bolt Protocol - Micro-Performance Specialist\nOptimize hotspot performance."
      );

      const plan = planTaskCreate(tmpDir, {
        title: "Optimize JSON parsing",
        prompt: "Refactor string parsing loop",
        role: "bolt",
        dependsOn: ["TASK-01", "TASK-02"],
        verifyCmd: "npm test",
      });

      assert.equal(plan.role, "Bolt");
      assert.deepEqual(plan.dependsOn, ["TASK-01", "TASK-02"]);
      assert.ok(plan.fullPrompt.includes("Bolt Protocol"));
      assert.ok(plan.taskFileContent.includes('"role":"Bolt"'));
      assert.ok(plan.taskFileContent.includes('"dependsOn":["TASK-01","TASK-02"]'));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

