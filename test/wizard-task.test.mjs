import test from "node:test";
import assert from "node:assert/strict";
import { planTaskCreate, runTaskCreateWizard, buildGuardrailFooter } from "../src/wizard-task.mjs";
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
      assert.ok(res.taskFile.replace(/\\/g, "/").includes(".agent/jules-queue"));
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


test("Guardrail footer is derived from the repository's scope, not a Node literal", async (t) => {
  const nodeRepo = {
    baseBranch: "main",
    limits: { diffKb: 75 },
    scope: { protect: ["package.json", "tsconfig.json"], deny: [".github/**"] },
  };
  const rustRepo = {
    baseBranch: "trunk",
    limits: { diffKb: 50 },
    scope: { protect: ["Cargo.toml", "Makefile"], deny: [".github/**"] },
  };

  await t.test("names the stack's own manifests", () => {
    const rust = buildGuardrailFooter(rustRepo);
    assert.match(rust, /Cargo\.toml/);
    assert.ok(!rust.includes("package.json"), "a Rust repo must not be warned off package.json");
    assert.ok(!rust.includes("pnpm-lock.yaml"));

    const node = buildGuardrailFooter(nodeRepo);
    assert.match(node, /package\.json/);
    assert.ok(!node.includes("Cargo.toml"));
  });

  await t.test("honours the configured base branch and diff ceiling", () => {
    const rust = buildGuardrailFooter(rustRepo);
    assert.match(rust, /git fetch origin trunk && git rebase origin\/trunk/);
    assert.match(rust, /under 50 KB/);
  });

  // "Delete ALL temporary files (.py, .sh, ...)" told a Python project's agent
  // to delete source files.
  await t.test("does not instruct the agent to delete files by extension", () => {
    const footer = buildGuardrailFooter(nodeRepo);
    assert.ok(!/\.py\b/.test(footer), "an extension list is not a definition of 'temporary'");
    assert.match(footer, /scratch files you created/);
  });

  await t.test("caps the named paths so the footer cannot crowd out the task", () => {
    const many = { scope: { protect: Array.from({ length: 40 }, (_, i) => `pkg${i}/manifest.toml`) } };
    const footer = buildGuardrailFooter(many);
    assert.match(footer, /and 28 more/);
    assert.ok(footer.split("\n").length < 12);
  });

  await t.test("falls back to a stack-neutral line when no scope is known", () => {
    const bare = buildGuardrailFooter({});
    assert.match(bare, /build configuration, lockfiles, or CI workflow files/);
    assert.ok(!bare.includes("package.json"));
  });
});
