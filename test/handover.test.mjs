import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createHandover,
  loadHandover,
  listHandovers,
  pruneHandovers,
  formatHandoverPromptContext,
  HandoverError,
} from "../src/ops/handover.mjs";

test("Baton Pass Handover Engine", async (t) => {
  const testRoot = mkdtempSync(join(tmpdir(), "jules-handover-test-"));

  t.after(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch (_) {}
  });

  await t.test("createHandover creates atomic markdown manifest with YAML frontmatter", () => {
    const res = createHandover(testRoot, {
      sessionId: "sess-abc-123",
      status: "rolled-back",
      intent: "Refactor auth middleware to use native cookies",
      completed: ["Created session schema", "Updated cookie parser"],
      assumptions: ["Cookie parser supports SameSite=Lax"],
      landmines: ["Rate limiter breaks with mock headers", "Failing test in auth.test.mjs:42"],
      nextSteps: ["Fix header parsing in request handler", "Re-run npm test"],
      referencedPaths: ["src/auth.mjs", "test/auth.test.mjs"],
      branch: "feat/auth-v2",
      headSha: "d3b07384d113edec49eaa6238ad5ff00",
      diffSummary: "2 files changed, 24 insertions(+), 12 deletions(-)",
    });

    assert.equal(res.sessionId, "sess-abc-123");
    assert.equal(res.status, "rolled-back");
    assert.ok(existsSync(res.filePath));
    assert.match(res.filePath, /\.agent\/handovers\/\d{4}-\d{2}-\d{2}-sess-abc-123\.md$/);

    // Verify round-trip load
    const loaded = loadHandover(testRoot, "sess-abc-123");
    assert.equal(loaded.sessionId, "sess-abc-123");
    assert.equal(loaded.status, "rolled-back");
    assert.equal(loaded.branch, "feat/auth-v2");
    assert.equal(loaded.headSha, "d3b07384d113edec49eaa6238ad5ff00");
    assert.equal(loaded.intent, "Refactor auth middleware to use native cookies");
    assert.deepEqual(loaded.completed, ["Created session schema", "Updated cookie parser"]);
    assert.deepEqual(loaded.assumptions, ["Cookie parser supports SameSite=Lax"]);
    assert.deepEqual(loaded.landmines, ["Rate limiter breaks with mock headers", "Failing test in auth.test.mjs:42"]);
    assert.deepEqual(loaded.nextSteps, ["Fix header parsing in request handler", "Re-run npm test"]);
    assert.deepEqual(loaded.referencedPaths, ["src/auth.mjs", "test/auth.test.mjs"]);
  });

  await t.test("createHandover redacts high-confidence secrets in all fields", () => {
    const fakeToken = "ghp_123456789012345678901234567890123456";
    const fakeKey = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890";

    createHandover(testRoot, {
      sessionId: "sess-secret-leak",
      status: "aborted",
      intent: `Tried authenticating with token ${fakeToken}`,
      landmines: [`Got 401 error with key ${fakeKey}`],
    });

    const loaded = loadHandover(testRoot, "sess-secret-leak");
    assert.ok(!loaded.rawMarkdown.includes(fakeToken));
    assert.ok(!loaded.rawMarkdown.includes(fakeKey));
    assert.ok(loaded.rawMarkdown.includes("[REDACTED_BY_SECURITY_GATE]"));
  });

  await t.test("assertSessionId rejects path traversal attempts", () => {
    assert.throws(
      () => createHandover(testRoot, { sessionId: "../evil-session" }),
      (err) => err instanceof HandoverError && err.message.includes("Invalid handover session id")
    );

    assert.throws(
      () => loadHandover(testRoot, "../../../etc/passwd.md"),
      (err) => err instanceof HandoverError && err.message.includes("escapes")
    );
  });

  await t.test("listHandovers and pruneHandovers manage retention properly", () => {
    const listDir = mkdtempSync(join(tmpdir(), "jules-ho-prune-"));
    try {
      for (let i = 1; i <= 6; i++) {
        createHandover(listDir, {
          sessionId: `sess-item-${i}`,
          intent: `Step ${i}`,
          createdAt: new Date(Date.now() + i * 1000).toISOString(),
        }, { maxRetention: 0 }); // disable auto-prune during setup
      }

      const listBefore = listHandovers(listDir);
      assert.equal(listBefore.length, 6);
      assert.equal(listBefore[0].sessionId, "sess-item-6"); // newest first

      const pruned = pruneHandovers(listDir, 3);
      assert.equal(pruned, 3);

      const listAfter = listHandovers(listDir);
      assert.equal(listAfter.length, 3);
      assert.equal(listAfter[0].sessionId, "sess-item-6");
      assert.equal(listAfter[2].sessionId, "sess-item-4");
    } finally {
      rmSync(listDir, { recursive: true, force: true });
    }
  });

  await t.test("formatHandoverPromptContext produces high-signal context block", () => {
    const handover = {
      sessionId: "sess-999",
      status: "escalated",
      createdAt: "2026-08-21T02:00:00.000Z",
      intent: "Migrate database pool to neon-serverless",
      completed: ["Created client adapter", "Added retry logic"],
      assumptions: ["DATABASE_URL is set in environment"],
      landmines: ["WebSocket connection closes on large transaction"],
      nextSteps: ["Split transaction into batched operations"],
      referencedPaths: ["src/db.mjs"],
    };

    const ctx = formatHandoverPromptContext(handover);
    assert.match(ctx, /\[SESSION_HANDOVER_CONTEXT\]/);
    assert.match(ctx, /Previous Session: sess-999 \(Status: escalated/);
    assert.match(ctx, /Prior Intent: Migrate database pool to neon-serverless/);
    assert.match(ctx, /Completed Progress:\s+-\s+Created client adapter/);
    assert.match(ctx, /Validated Assumptions:\s+-\s+DATABASE_URL is set in environment/);
    assert.match(ctx, /Obstacles & Landmines:\s+-\s+WebSocket connection closes on large transaction/);
    assert.match(ctx, /Recommended Next Steps:\s+-\s+Split transaction into batched operations/);
    assert.match(ctx, /Referenced Files: src\/db\.mjs/);
    assert.match(ctx, /\[\/SESSION_HANDOVER_CONTEXT\]/);
  });

  await t.test("command registry registers handover command descriptor correctly", async () => {
    const { getCommandDescriptor } = await import("../src/ops/command-registry.mjs");
    const desc = getCommandDescriptor("handover");
    assert.ok(desc);
    assert.equal(desc.id, "handover");
    assert.equal(desc.category, "Operate");
    assert.ok(desc.shortcuts.includes("ho"));

    const aliasDesc = getCommandDescriptor("ho");
    assert.equal(aliasDesc?.id, "handover");
  });
});

