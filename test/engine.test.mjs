import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gate, dispatch } from "../src/engine.mjs";

describe("src/engine.mjs", () => {
  it("gate passes clean repository verification", async () => {
    const res = await gate({ root: process.cwd(), base: "main" });
    assert.equal(typeof res.ok, "boolean");
    assert.ok(Array.isArray(res.phases));
  });

  it("dispatch generates dry-run session in dry-run mode", async () => {
    const task = { title: "Test Task", prompt: "Hello agent" };
    const session = await dispatch(task, { dryRun: true });
    assert.equal(session.id, "dry-run-session-id");
    assert.equal(session.status, "pending");
  });
});
