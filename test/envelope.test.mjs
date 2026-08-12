import test from "node:test";
import assert from "node:assert/strict";
import { validateEnvelope } from "../src/envelope.mjs";

test("Task Envelope Premise & Scope Validation", async (t) => {
  await t.test("rejects empty or non-object envelope", () => {
    const res = validateEnvelope(null);
    assert.equal(res.ok, false);
    assert.equal(res.errors.length > 0, true);
  });

  await t.test("validates valid task envelope with existing files", () => {
    const env = {
      task_id: "TASK-001",
      intent: "Refactor core helpers",
      referenced_paths: ["package.json", "README.md"],
      acceptance_criteria: ["Tests pass"],
    };
    const res = validateEnvelope(env);
    assert.equal(res.ok, true);
    assert.equal(res.errors.length, 0);
  });

  await t.test("detects premise failure on nonexistent referenced path", () => {
    const env = {
      task_id: "TASK-002",
      intent: "Fix nonexistent feature",
      referenced_paths: ["non_existent_file_abc123.ts"],
      acceptance_criteria: ["Must build"],
    };
    const res = validateEnvelope(env);
    assert.equal(res.ok, false);
    assert.match(res.errors[0], /Premise failure: referenced path/);
  });

  await t.test("detects scope violation in allowed_paths", () => {
    const env = {
      task_id: "TASK-003",
      intent: "Touch restricted paths",
      allowed_paths: [".github/workflows/deploy.yml"],
      acceptance_criteria: ["Updated workflow"],
    };
    const res = validateEnvelope(env);
    assert.equal(res.ok, false);
    assert.match(res.errors[0], /Allowed paths violate protected scope/);
  });

  await t.test("validates concurrency_group in task envelope", () => {
    const validEnv = {
      intent: "Database migration task",
      concurrency_group: "db-migrations",
    };
    assert.equal(validateEnvelope(validEnv).ok, true);

    const invalidEnv = {
      intent: "Database migration task",
      concurrency_group: "",
    };
    const res = validateEnvelope(invalidEnv);
    assert.equal(res.ok, false);
    assert.match(res.errors[0], /concurrency_group must be a non-empty string/);
  });
});

