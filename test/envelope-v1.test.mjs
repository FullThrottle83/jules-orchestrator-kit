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

  await t.test("parseEnvelopeHeader, serializeTaskFrontmatter, and validateEnvelope support mcp_directives", () => {
    const v1WithMcp = `---
kind: Task
version: agentctl.task/v1
id: JULES-502
title: Astro Cloudflare Task
mcp_directives:
  - astro-docs
  - cloudflare-docs
scope:
  allow:
    - src/pages/index.astro
verification:
  commands:
    - pnpm test
---
# Uppgift
`;
    const parsed = parseEnvelopeHeader(v1WithMcp);
    assert.deepStrictEqual(parsed.mcp_directives, ["astro-docs", "cloudflare-docs"]);

    const valValid = validateEnvelope(parsed);
    assert.strictEqual(valValid.ok, true);

    const serialized = serializeTaskFrontmatter({
      kind: "Task",
      version: "agentctl.task/v1",
      id: "JULES-502",
      title: "Astro Cloudflare Task",
      mcp_directives: ["astro-docs", "cloudflare-docs"],
    });
    assert.ok(serialized.includes("mcp_directives:"));
    assert.ok(serialized.includes("  - astro-docs"));
    assert.ok(serialized.includes("  - cloudflare-docs"));

    const invalid = { ...parsed, mcp_directives: "not-an-array" };
    const valInvalid = validateEnvelope(invalid);
    assert.strictEqual(valInvalid.ok, false);
    assert.ok(valInvalid.errors.some((e) => e.includes("mcp_directives must be an array")));
  });

  await t.test("supports Taxonomy Section 10 envelope: risk lanes, circuitBreaker, and verification metadata", () => {
    const taxonomyMarkdown = `---
apiVersion: agentctl.task/v1
kind: CodingTask
metadata:
  id: fix-booking-idempotency
  title: Prevent duplicate booking submissions
intent:
  outcome: Add idempotency handling to booking mutation
scope:
  allow:
    - src/booking.ts
  deny:
    - package.json
constraints:
  - Preserve public API contract.
verification:
  commands:
    - npm test
  require_nonzero_test_count: true
  trusted_base: main
risk:
  lane: green
  require_plan_approval: false
circuitBreaker:
  max_attempts: 2
  max_diff_lines: 200
  stop_if_same_failure_repeats: true
---
# Uppgift
`;
    const parsed = parseEnvelopeHeader(taxonomyMarkdown);
    assert.strictEqual(parsed.id, "fix-booking-idempotency");
    assert.strictEqual(parsed.title, "Prevent duplicate booking submissions");
    assert.deepStrictEqual(parsed.invariants, ["Preserve public API contract."]);
    assert.strictEqual(parsed.risk.lane, "green");
    assert.strictEqual(parsed.risk.require_plan_approval, false);
    assert.strictEqual(parsed.circuitBreaker.max_attempts, 2);
    assert.strictEqual(parsed.circuitBreaker.max_diff_lines, 200);
    assert.strictEqual(parsed.verification.require_nonzero_test_count, true);
    assert.strictEqual(parsed.verification.trusted_base, "main");

    const val = validateEnvelope(parsed);
    assert.strictEqual(val.ok, true);

    const serialized = serializeTaskFrontmatter(parsed);
    assert.ok(serialized.includes("risk:"));
    assert.ok(serialized.includes("  lane: green"));
    assert.ok(serialized.includes("circuitBreaker:"));
    assert.ok(serialized.includes("  max_attempts: 2"));
    assert.ok(serialized.includes("  require_nonzero_test_count: true"));
    assert.ok(serialized.includes("  trusted_base: main"));
  });

  await t.test("enforces delegation lane rules: Red rejected, Orange warned, Amber permits protected files", () => {
    // 1. Red lane rejected
    const redEnvelope = {
      version: 1,
      id: "RED-1",
      title: "Bespoke cipher implementation",
      risk: { lane: "red" },
      verification: { commands: ["npm test"] },
    };
    const redVal = validateEnvelope(redEnvelope);
    assert.strictEqual(redVal.ok, false);
    assert.ok(redVal.errors.some((e) => e.includes("Red-lane tasks are outside")));

    // 2. Orange lane warned
    const orangeEnvelope = {
      version: 1,
      id: "ORANGE-1",
      title: "Terraform production apply",
      risk: { lane: "orange" },
      verification: { commands: ["npm test"] },
    };
    const orangeVal = validateEnvelope(orangeEnvelope);
    assert.strictEqual(orangeVal.ok, true);
    assert.ok(orangeVal.warnings.some((w) => w.includes("Orange-lane task: candidate generation only")));

    // 3. Green lane targeting protected path (e.g. package.json) is rejected
    const greenProtectedEnvelope = {
      version: 1,
      id: "GREEN-DEP",
      title: "Unreviewed dependency bump",
      risk: { lane: "green", require_plan_approval: false },
      scope: { allow: ["package.json"] },
      verification: { commands: ["npm test"] },
    };
    const greenVal = validateEnvelope(greenProtectedEnvelope);
    assert.strictEqual(greenVal.ok, false);
    assert.ok(greenVal.errors.some((e) => e.includes("requires risk.lane 'amber' and requirePlanApproval: true")));

    // 4. Amber lane targeting protected path (e.g. package.json) with requirePlanApproval: true is allowed
    const amberProtectedEnvelope = {
      version: 1,
      id: "AMBER-DEP",
      title: "Approved dependency bump",
      risk: { lane: "amber", require_plan_approval: true },
      flags: { requirePlanApproval: true },
      scope: { allow: ["package.json"] },
      verification: { commands: ["npm test"] },
    };
    const amberVal = validateEnvelope(amberProtectedEnvelope);
    assert.strictEqual(amberVal.ok, true);
    assert.strictEqual(amberVal.errors.length, 0);
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
