import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseYamlSubset,
  parseTaskFrontmatter,
  serializeTaskFrontmatter,
  parseEnvelopeHeader,
  validateEnvelope,
} from "../src/envelope.mjs";

test("agentctl.task/v1 Frontmatter Specification & Parser", async (t) => {
  const sampleV1Markdown = `---
kind: Task
version: agentctl.task/v1
id: JULES-501
title: Fix authentication session edge cases
role: security
tier: fast
base_commit: main
dependsOn:
  - JULES-500
scope:
  allow:
    - src/engine.mjs
    - src/envelope.mjs
  deny:
    - .agent/protected-paths.json
verification:
  commands:
    - npm test -- auth.test.mjs
    - npm run lint
invariants:
  - Do not modify files outside scope.allow.
  - Preserve public API contract.
flags:
  autoPr: true
  requirePlanApproval: false
  repoless: false
---
# Uppgift
Fix the token expiration handler in auth controller.

## Verifiering
1. npm test
`;

  await t.test("parseYamlSubset correctly handles nested objects and arrays", () => {
    const yaml = `
id: TEST-1
scope:
  allow:
    - file1.js
    - file2.js
  deny:
    - protected.json
verification:
  commands:
    - npm test
flags:
  autoPr: true
`;
    const parsed = parseYamlSubset(yaml);
    assert.strictEqual(parsed.id, "TEST-1");
    assert.deepStrictEqual(parsed.scope.allow, ["file1.js", "file2.js"]);
    assert.deepStrictEqual(parsed.scope.deny, ["protected.json"]);
    assert.deepStrictEqual(parsed.verification.commands, ["npm test"]);
    assert.strictEqual(parsed.flags.autoPr, true);
  });

  await t.test("parseTaskFrontmatter parses envelope and separates markdown body", () => {
    const parsed = parseTaskFrontmatter(sampleV1Markdown);
    assert.ok(parsed, "Expected parsed frontmatter object");
    assert.strictEqual(parsed.metadata.kind, "Task");
    assert.strictEqual(parsed.metadata.version, "agentctl.task/v1");
    assert.strictEqual(parsed.metadata.id, "JULES-501");
    assert.strictEqual(parsed.metadata.title, "Fix authentication session edge cases");
    assert.strictEqual(parsed.metadata.role, "security");
    assert.strictEqual(parsed.metadata.tier, "fast");
    assert.strictEqual(parsed.metadata.base_commit, "main");
    assert.deepStrictEqual(parsed.metadata.dependsOn, ["JULES-500"]);
    assert.deepStrictEqual(parsed.metadata.scope.allow, ["src/engine.mjs", "src/envelope.mjs"]);
    assert.deepStrictEqual(parsed.metadata.scope.deny, [".agent/protected-paths.json"]);
    assert.deepStrictEqual(parsed.metadata.verification.commands, [
      "npm test -- auth.test.mjs",
      "npm run lint",
    ]);
    assert.strictEqual(parsed.metadata.flags.autoPr, true);
    assert.strictEqual(parsed.metadata.flags.requirePlanApproval, false);
    assert.ok(parsed.body.includes("# Uppgift"));
    assert.ok(parsed.body.includes("Fix the token expiration handler"));
  });

  await t.test("parseEnvelopeHeader resolves metadata from agentctl.task/v1 frontmatter", () => {
    const meta = parseEnvelopeHeader(sampleV1Markdown);
    assert.ok(meta);
    assert.strictEqual(meta.kind, "Task");
    assert.strictEqual(meta.id, "JULES-501");
    assert.strictEqual(meta.title, "Fix authentication session edge cases");
    assert.strictEqual(meta.role, "security");
    assert.strictEqual(meta.tier, "fast");
    assert.strictEqual(meta.verifyCmd, "npm test -- auth.test.mjs");
    assert.deepStrictEqual(meta.targetFiles, ["src/engine.mjs", "src/envelope.mjs"]);
    assert.deepStrictEqual(meta.allowed_paths, ["src/engine.mjs", "src/envelope.mjs"]);
    assert.deepStrictEqual(meta.forbiddenPaths, [".agent/protected-paths.json"]);
    assert.deepStrictEqual(meta.dependsOn, ["JULES-500"]);
    assert.strictEqual(meta.flags.autoPr, true);
    assert.strictEqual(meta.flags.requirePlanApproval, false);
  });

  await t.test("serializeTaskFrontmatter produces round-trippable frontmatter", () => {
    const originalMeta = {
      kind: "Task",
      version: "agentctl.task/v1",
      id: "JULES-999",
      title: "Round-trip Test Task",
      role: "performance",
      tier: "fast",
      baseCommit: "main",
      dependsOn: ["DEP-1", "DEP-2"],
      scope: {
        allow: ["src/engine.mjs", "src/envelope.mjs"],
        deny: ["package.json"],
      },
      verification: {
        commands: ["npm test", "npm run lint"],
      },
      invariants: ["Do not delete tests"],
      flags: {
        autoPr: false,
        requirePlanApproval: true,
      },
    };

    const frontmatterString = serializeTaskFrontmatter(originalMeta);
    const roundTrip = parseTaskFrontmatter(`${frontmatterString}\n# Task Content`);
    assert.ok(roundTrip);
    assert.strictEqual(roundTrip.metadata.id, originalMeta.id);
    assert.strictEqual(roundTrip.metadata.title, originalMeta.title);
    assert.strictEqual(roundTrip.metadata.role, originalMeta.role);
    assert.strictEqual(roundTrip.metadata.tier, originalMeta.tier);
    assert.strictEqual(roundTrip.metadata.base_commit, originalMeta.baseCommit);
    assert.deepStrictEqual(roundTrip.metadata.dependsOn, originalMeta.dependsOn);
    assert.deepStrictEqual(roundTrip.metadata.scope.allow, originalMeta.scope.allow);
    assert.deepStrictEqual(roundTrip.metadata.scope.deny, originalMeta.scope.deny);
    assert.deepStrictEqual(roundTrip.metadata.verification.commands, originalMeta.verification.commands);
    assert.deepStrictEqual(roundTrip.metadata.invariants, originalMeta.invariants);
    assert.strictEqual(roundTrip.metadata.flags.autoPr, false);
    assert.strictEqual(roundTrip.metadata.flags.requirePlanApproval, true);
  });

  await t.test("validateEnvelope accepts valid agentctl.task/v1 metadata", () => {
    const meta = parseEnvelopeHeader(sampleV1Markdown);
    const res = validateEnvelope(meta);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.errors.length, 0);
  });

  await t.test("validateEnvelope detects scope violation in task frontmatter scope.allow", () => {
    const invalidScopeMarkdown = `---
kind: Task
version: agentctl.task/v1
id: JULES-FAIL-SCOPE
title: Illegally modify workflow
scope:
  allow:
    - .github/workflows/deploy.yml
verification:
  commands:
    - npm test
---
Modify workflow
`;
    const meta = parseEnvelopeHeader(invalidScopeMarkdown);
    const res = validateEnvelope(meta);
    assert.strictEqual(res.ok, false);
    assert.match(res.errors[0], /Allowed paths violate protected scope/);
  });

  await t.test("scripts/validate-envelope.mjs CLI validates .md task files with frontmatter", () => {
    const tmp = mkdtempSync(join(tmpdir(), "validate-envelope-test-"));
    try {
      const taskPath = join(tmp, "TASK-VALID.md");
      writeFileSync(taskPath, sampleV1Markdown, "utf-8");

      const stdout = execFileSync(
        "node",
        ["scripts/validate-envelope.mjs", taskPath],
        { encoding: "utf-8" }
      );
      assert.ok(stdout.includes("Task envelope validated successfully"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await t.test("dag-engine recognizes dependsOn and scope.allow targetFiles from agentctl.task/v1 queue files", async () => {
    const { executeQueueDag } = await import("../src/dag-engine.mjs");
    const tmp = mkdtempSync(join(tmpdir(), "dag-v1-test-"));
    try {
      const { mkdirSync } = await import("node:fs");
      const queueDir = join(tmp, ".agent", "jules-queue");
      mkdirSync(queueDir, { recursive: true });

      const task1Content = `---
kind: Task
version: agentctl.task/v1
id: TASK-V1-A
title: First Task
scope:
  allow:
    - file1.js
---
# First`;

      const task2Content = `---
kind: Task
version: agentctl.task/v1
id: TASK-V1-B
title: Dependent Task
dependsOn:
  - TASK-V1-A
scope:
  allow:
    - file2.js
---
# Second`;

      writeFileSync(join(queueDir, "TASK-V1-A.md"), task1Content);
      writeFileSync(join(queueDir, "TASK-V1-B.md"), task2Content);

      const executionOrder = [];
      const runner = async (task) => {
        executionOrder.push(task.title || task.prompt);
        return { ok: true };
      };

      const res = await executeQueueDag(tmp, {
        dispatchFn: runner,
        concurrency: 2,
      });
      assert.strictEqual(res.processed, 2);
      assert.deepStrictEqual(executionOrder, ["First Task", "Dependent Task"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
