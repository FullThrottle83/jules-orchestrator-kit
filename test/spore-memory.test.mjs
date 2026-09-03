import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordLearning, hydratePrompt, harvestFailure, loadLearnings } from "../src/memory.mjs";

describe("Agent Memory Engine", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "spore-mem-test-"));
  });

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("recordLearning saves learning and updates SYSTEM_LEARNINGS.md", () => {
    const res = recordLearning(tmpDir, {
      agent: "test-agent",
      trigger: "SSR crashes on Cloudflare Workers",
      solution: "Do not use node:fs in workerd environment.",
    });

    assert.equal(res.recorded, true);
    assert.equal(res.count, 1);

    const learnings = loadLearnings(tmpDir);
    assert.equal(learnings.length, 1);
    assert.equal(learnings[0].agent, "test-agent");

    const mdFile = join(tmpDir, ".agent", "SYSTEM_LEARNINGS.md");
    assert.equal(existsSync(mdFile), true);
    const mdContent = readFileSync(mdFile, "utf8");
    assert.match(mdContent, /SSR crashes on Cloudflare Workers/);
  });

  test("recordLearning prevents duplicate entries", () => {
    recordLearning(tmpDir, {
      trigger: "Duplicate Trigger",
      solution: "Same Solution",
    });

    const res2 = recordLearning(tmpDir, {
      trigger: "Duplicate Trigger",
      solution: "Same Solution",
    });

    assert.equal(res2.recorded, false);
    assert.equal(res2.count, 1);
  });

  test("hydratePrompt injects active system learnings block", () => {
    recordLearning(tmpDir, {
      trigger: "Authentication token leak in logs",
      solution: "Use redactSecrets before logging headers.",
    });

    const hydrated = hydratePrompt(tmpDir, "Fix auth token logging issue");
    assert.match(hydrated, /<ACTIVE_SYSTEM_LEARNINGS>/);
    assert.match(hydrated, /Use redactSecrets before logging headers/);
  });

  test("harvestFailure rejects test weakening diffs", () => {
    const diffText = `
--- a/test/auth.test.js
+++ b/test/auth.test.js
-  it("should validate JWT token", () => {
-    expect(token).toBeValid();
-  });
`;

    const res = harvestFailure(tmpDir, {
      exitCode: 4,
      diffText,
      taskId: "task-123",
    });

    assert.equal(res.status, "REJECTED");
    assert.match(res.reason, /TEST_WEAKENING/);
  });

  test("harvestFailure harvests valid failure traces", () => {
    const res = harvestFailure(tmpDir, {
      exitCode: 4,
      diffText: "+ console.log('debugging fix');",
      taskId: "task-456",
    });

    assert.equal(res.status, "HARVESTED");
    assert.match(res.candidate.trigger, /\[OODA Exit 4\]/);
  });

  test("dispatch auto-hydrates system learnings and resolves specialist roles", async () => {
    const { dispatch } = await import("../src/engine.mjs");
    const { writeFileSync, mkdirSync } = await import("node:fs");

    // Setup prompts dir with Overseer role
    const promptsDir = join(tmpDir, ".agent", "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      join(promptsDir, "Overseer.md"),
      "# Overseer Protocol - Codebase Audit Specialist\nScan physical directory tree for tech debt."
    );

    // Record a system learning
    recordLearning(tmpDir, {
      trigger: "SSR crashes on Cloudflare Workers",
      solution: "Avoid node:fs in edge runtime.",
    });

    let capturedTask = null;
    const mockProvider = {
      name: "mock",
      dispatch: async (task) => {
        capturedTask = task;
        return { id: "mock-session-123", ok: true };
      },
    };

    const config = {
      _root: tmpDir,
      provider: mockProvider,
      limits: { promptKb: 50, dailyTasks: 100 },
      verify: { test: "npm test" },
    };

    await dispatch(
      {
        title: "Audit task",
        prompt: "Check SSR crashes on Cloudflare Workers",
        role: "overseer",
      },
      { root: tmpDir, config, dryRun: true }
    );

    assert.ok(capturedTask);
    assert.match(capturedTask.prompt, /Overseer Protocol/);
    assert.match(capturedTask.prompt, /<ACTIVE_SYSTEM_LEARNINGS>/);
    assert.match(capturedTask.prompt, /Avoid node:fs in edge runtime/);
  });
});

