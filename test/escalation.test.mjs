import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchEscalation } from "../src/webhook.mjs";

// Every dispatch here passes an isolated `root`. Without one, `dispatchEscalation`
// falls back to `resolveRoot()` — the checkout the suite is running in — and the
// governor reads and writes the developer's own `.agent/state/`. These tests used
// to get away with it because their reasons took the critical bypass and returned
// before touching any state; once the bypass narrowed in v0.35.2 they began
// spending the real interruption budget, and then failed when they exhausted it.
test("dispatchEscalation Formats and Dispatches Webhook Payloads to Slack and Discord", async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), "escalation-test-"));
  t.after(() => {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch (_) {}
  });

  await t.test("a) dry-run mode synthesizes structured incident payload without external HTTP request", async () => {
    const res = await dispatchEscalation(
      {
        sessionId: "sess-999",
        taskId: "task-100",
        branch: "agent/fix-auth",
        reason: "OODA_REPAIR_EXHAUSTED",
        logs: "Error: Failed assertion on line 42 in auth.test.mjs",
      },
      { root: tempRoot, dryRun: true }
    );

    assert.equal(res.dispatched, true);
    assert.equal(res.dryRun, true);
    assert.equal(res.payload.sessionId, "sess-999");
    assert.equal(res.payload.reason, "OODA_REPAIR_EXHAUSTED");
    assert.ok(res.payload.resumeCmd.includes("agentctl resume sess-999"));
  });

  await t.test("b) dispatches POST payloads to mock Slack and Discord webhook endpoints", async () => {
    let slackReceived = false;
    let discordReceived = false;

    const mockServer = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.url === "/slack") {
          slackReceived = true;
          const parsed = JSON.parse(body);
          assert.ok(parsed.text.includes("sess-888"));
        } else if (req.url === "/discord") {
          discordReceived = true;
          const parsed = JSON.parse(body);
          assert.ok(parsed.content.includes("sess-888"));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    const port = mockServer.address().port;

    try {
      const result = await dispatchEscalation(
        {
          sessionId: "sess-888",
          reason: "AWAITING_USER_FEEDBACK",
          logs: "Which auth provider should be configured?",
        },
        {
          root: tempRoot,
          slackWebhookUrl: `http://127.0.0.1:${port}/slack`,
          discordWebhookUrl: `http://127.0.0.1:${port}/discord`,
        }
      );

      assert.equal(result.dispatched, true);
      assert.equal(result.slack, true);
      assert.equal(result.discord, true);
      assert.equal(slackReceived, true);
      assert.equal(discordReceived, true);
    } finally {
      mockServer.close();
    }
  });
});
