import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkBlocks, mergeBlocks3Way, deepMergeJson, resolveJsonConflict, resolveMarkdownConflict } from "../src/merge-blocks.mjs";
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

  it("e) deepMergeJson and resolveJsonConflict recursively merge disjoint keys and deduplicate arrays", () => {
    const head = {
      name: "jules-kit",
      version: "1.1.0",
      features: ["auth", "dispatch"],
      settings: { timeout: 5000, retry: true },
    };

    const dev = {
      name: "jules-kit",
      version: "1.0.0",
      features: ["dispatch", "telemetry"],
      settings: { retry: false, concurrency: 4 },
      author: "Operator",
    };

    const merged = deepMergeJson(head, dev);
    assert.equal(merged.name, "jules-kit");
    assert.equal(merged.version, "1.1.0"); // head wins scalar conflict
    assert.equal(merged.author, "Operator");
    assert.deepEqual(merged.features, ["auth", "dispatch", "telemetry"]);
    assert.equal(merged.settings.timeout, 5000);
    assert.equal(merged.settings.retry, true); // head wins scalar conflict
    assert.equal(merged.settings.concurrency, 4);

    // Conflict marker string resolution
    const conflictString = `<<<<<<< OURS\n${JSON.stringify(head, null, 2)}\n=======\n${JSON.stringify(dev, null, 2)}\n>>>>>>> THEIRS`;
    const resolvedStr = resolveJsonConflict(conflictString);
    const parsed = JSON.parse(resolvedStr);
    assert.equal(parsed.author, "Operator");
    assert.deepEqual(parsed.features, ["auth", "dispatch", "telemetry"]);
  });

  it("f) resolveMarkdownConflict preserves unique log and changelog entries from concurrent swarms", () => {
    const conflictDoc = `# Changelog

<<<<<<< OURS
- feat: add prompt sanitization guardrail
- fix: normalize cross-platform paths
=======
- feat: add multi-token pool rotation
- fix: normalize cross-platform paths
>>>>>>> THEIRS

## Prior Art`;

    const resolved = resolveMarkdownConflict(conflictDoc);
    assert.ok(!resolved.includes("<<<<<<<"));
    assert.ok(!resolved.includes("======="));
    assert.ok(!resolved.includes(">>>>>>>"));
    assert.ok(resolved.includes("- feat: add prompt sanitization guardrail"));
    assert.ok(resolved.includes("- feat: add multi-token pool rotation"));
    assert.ok(resolved.includes("- fix: normalize cross-platform paths"));
    // Verify deduplication: "normalize cross-platform paths" appears only once
    const matches = resolved.match(/- fix: normalize cross-platform paths/g);
    assert.equal(matches.length, 1);
  });
});
