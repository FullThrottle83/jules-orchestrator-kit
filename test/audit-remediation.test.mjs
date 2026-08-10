import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createOperationReceipt, loadOperationReceipt } from "../src/ops/receipts.mjs";
import { applyActionPlan } from "../src/ops/transaction.mjs";
import { buildQueueSnapshot } from "../src/ux/queue-model.mjs";
import { planTaskAction } from "../src/ops/task-actions.mjs";
import { createKeyDecoder } from "../src/ux/key-decoder.mjs";
import { getStringWidth, clipText } from "../src/ux/layout.mjs";
import { parseUnifiedDiff } from "../src/ux/diff-viewer.mjs";

test("audit remediation regression coverage", async (t) => {
  await t.test("receipts are atomic, scrubbed, and hash-validated", () => {
    const root = mkdtempSync(join(tmpdir(), "jules-receipt-regression-"));
    try {
      const secret = ["sk", "live", "123456789012345678901234"].join("_");
      const receipt = createOperationReceipt(root, {
        receiptId: "REC-regression",
        actionPlanId: "PLAN-1",
        kind: "test",
        title: secret,
        status: "success",
        effectsExecuted: [{ executable: "node", args: [secret], exitCode: 0 }],
      });
      const files = readdirSync(join(root, ".agent/receipts"));
      assert.deepEqual(files, ["REC-regression.json"]);
      const loaded = loadOperationReceipt(root, receipt.receiptId);
      assert.equal(JSON.stringify(loaded).includes(secret), false);
      assert.throws(() => loadOperationReceipt(root, "../REC-regression.json"), /escapes the receipts directory/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("queue actions use sidecar hashes and execute move mutations", async () => {
    const root = mkdtempSync(join(tmpdir(), "jules-action-regression-"));
    try {
      const queue = join(root, ".agent", "jules-queue");
      mkdirSync(queue, { recursive: true });
      writeFileSync(join(queue, "README.md"), "queue documentation");
      writeFileSync(join(queue, "TASK-1.md"), "<!-- JULES_TASK_ENVELOPE: {\"title\":\"Task\"} -->\n");
      writeFileSync(join(queue, "TASK-1.state.json"), JSON.stringify({ state: "failed", attempt: 1, revision: 1 }));

      const snapshot = await buildQueueSnapshot(root);
      assert.deepEqual(snapshot.tasks.map((task) => task.id), ["TASK-1"]);
      assert.ok(snapshot.tasks[0].stateHash);

      const retry = await planTaskAction(snapshot, { kind: "retry", taskId: "TASK-1" });
      assert.equal(Object.isFrozen(retry), true);
      await applyActionPlan(retry, { root });
      assert.equal(JSON.parse(readFileSync(join(queue, "TASK-1.state.json"), "utf8")).state, "pending");

      const deletePlan = await planTaskAction(await buildQueueSnapshot(root), { kind: "delete-task", taskId: "TASK-1" });
      await applyActionPlan(deletePlan, { root });
      assert.equal(existsSync(join(queue, "TASK-1.md")), false);
      assert.equal(existsSync(join(queue, ".trash", "TASK-1.md")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("terminal and diff boundaries preserve UTF-8 and paths", () => {
    const decoder = createKeyDecoder();
    const emoji = Buffer.from("😀");
    assert.deepEqual(decoder.push(emoji.subarray(0, 1)), []);
    assert.equal(decoder.push(emoji.subarray(1))[0].text, "😀");
    assert.equal(getStringWidth("👩‍💻"), 2);
    assert.equal(clipText("👩‍💻abc", 4), "👩‍💻a…");

    const diff = parseUnifiedDiff("--- a/old.txt\n+++ b/new.txt\n@@ -1 +1 @@\n-a\n+b\n");
    assert.equal(diff.files[0].newPath, "new.txt");
    assert.equal(diff.files[0].hunks[0].lines.length, 2);
  });

  await t.test("transaction rejects paths outside the repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "jules-transaction-regression-"));
    try {
      await assert.rejects(
        applyActionPlan({
          id: "PLAN-path-check",
          kind: "test",
          title: "path check",
          fileMutations: [{ operation: "replace", path: "../outside.txt", newContent: "blocked" }],
        }, { root }),
        /escapes repository root/
      );
      assert.equal(existsSync(join(root, "..", "outside.txt")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
