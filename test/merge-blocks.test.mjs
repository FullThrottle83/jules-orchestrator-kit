import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkBlocks, mergeBlocks3Way } from "../src/merge-blocks.mjs";
import { mergeVerifyChain } from "../src/merge-verify.mjs";
import { DagExecutor, withTaskTimeout } from "../src/dag-engine.mjs";

describe("Non-JSON Indentation-Block Structural Merger & Verification Chain", () => {
  it("chunkBlocks parses column-0 declaration boundaries and computes SHA-1 hashes", () => {
    const code = `export function add(a, b) {\n  return a + b;\n}\n\nconst VALUE = 42;`;
    const blocks = chunkBlocks(code, "js");
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].name, "add");
    assert.equal(blocks[0].type, "function");
    assert.equal(blocks[1].name, "VALUE");
    assert.equal(blocks[1].type, "const");
    assert.ok(typeof blocks[0].hash === "string" && blocks[0].hash.length === 40);
  });

  it("a) Disjoint function additions in JS merge cleanly and pass node --check", () => {
    const baseCode = `export function add(a, b) {\n  return a + b;\n}`;

    const oursCode = `export function add(a, b) {\n  return a + b;\n}\n\nexport function multiply(a, b) {\n  return a * b;\n}`;

    const theirsCode = `export function add(a, b) {\n  return a + b;\n}\n\nexport function subtract(a, b) {\n  return a - b;\n}`;

    const result = mergeBlocks3Way(baseCode, oursCode, theirsCode, "js");

    assert.equal(result.conflicts, 0);
    assert.ok(result.mergedText.includes("function multiply"));
    assert.ok(result.mergedText.includes("function subtract"));

    // Verify syntax via node --check
    const verification = mergeVerifyChain(result.mergedText, "test_merged.mjs");
    assert.equal(verification.ok, true, `Verification failed: ${verification.error}`);
    assert.equal(verification.tool, "node --check");
  });

  it("b) Overlapping edits produce CONFLICT_EDIT_EDIT", () => {
    const baseCode = `export function compute(x) {\n  return x * 2;\n}`;

    const oursCode = `export function compute(x) {\n  return x * 10;\n}`;

    const theirsCode = `export function compute(x) {\n  return x * 100;\n}`;

    const result = mergeBlocks3Way(baseCode, oursCode, theirsCode, "js");

    assert.equal(result.conflicts, 1);
    const hasConflictClass = result.classifications.some(
      (c) => c.type === "CONFLICT_EDIT_EDIT"
    );
    assert.ok(hasConflictClass, "Should include CONFLICT_EDIT_EDIT classification");
    assert.ok(result.mergedText.includes("<<<<<<< OURS"));
    assert.ok(result.mergedText.includes(">>>>>>> THEIRS"));
  });

  it("c) DAG execution throws if addTask() is called after execute()", async () => {
    const executor = new DagExecutor();
    executor.addTask({
      id: "task1",
      runner: async () => {},
    });

    const execPromise = executor.execute();

    assert.throws(
      () => {
        executor.addTask({
          id: "task2",
          runner: async () => {},
        });
      },
      /Cannot add task after execution has started/
    );

    await execPromise;
  });

  it("d) withTaskTimeout rejects when task exceeds specified duration", async () => {
    await assert.rejects(
      async () => {
        await withTaskTimeout(async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }, 20);
      },
      /Task execution timed out after 20ms/
    );
  });
});
