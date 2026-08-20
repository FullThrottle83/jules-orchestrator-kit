import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import {
  dispatchEscalation,
  flushEscalationDigest,
  getEscalationDigestStatus,
  clearEscalationDigest,
  bufferEscalationIncident,
  loadEscalationDigest,
} from "../src/webhook.mjs";

describe("Type III Silence Governor & Interruption Budgeting", () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "silence-gov-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch (_) {}
  });

  it("buffers non-critical incidents in digest mode", async () => {
    const config = {
      root: tempRoot,
      notifications: {
        mode: "digest",
        threshold: 5,
        budgetPerHour: 3,
        criticalReasons: ["R3_GATE_VIOLATION"],
      },
      dryRun: true,
    };

    const res1 = await dispatchEscalation(
      {
        sessionId: "sess-001",
        reason: "OODA_REPAIR_ATTEMPT",
        logs: "Trying attempt 1",
      },
      config
    );

    assert.equal(res1.dispatched, false);
    assert.equal(res1.buffered, true);
    assert.equal(res1.digestCount, 1);
    assert.equal(res1.reason, "BUFFERED_IN_DIGEST");

    const status = getEscalationDigestStatus(tempRoot, config);
    assert.equal(status.pendingCount, 1);
    assert.equal(status.incidents[0].sessionId, "sess-001");
  });

  it("dispatches critical incidents immediately bypassing digest mode", async () => {
    const config = {
      root: tempRoot,
      notifications: {
        mode: "digest",
        threshold: 5,
        budgetPerHour: 3,
        criticalReasons: ["R3_GATE_VIOLATION", "AWAITING_USER_FEEDBACK"],
      },
      dryRun: true,
    };

    const res = await dispatchEscalation(
      {
        sessionId: "sess-critical-1",
        reason: "R3_GATE_VIOLATION",
        logs: "Forbidden path touched: .github/workflows",
      },
      config
    );

    assert.equal(res.dispatched, true);
    assert.equal(res.dryRun, true);
    assert.equal(res.payload.sessionId, "sess-critical-1");
    assert.equal(res.payload.reason, "R3_GATE_VIOLATION");

    // Digest should remain empty because it was dispatched immediately
    const status = getEscalationDigestStatus(tempRoot, config);
    assert.equal(status.pendingCount, 0);
  });

  it("dispatches immediately if incident has critical: true", async () => {
    const config = {
      root: tempRoot,
      notifications: {
        mode: "digest",
        threshold: 10,
      },
      dryRun: true,
    };

    const res = await dispatchEscalation(
      {
        sessionId: "sess-override",
        reason: "CUSTOM_REASON",
        critical: true,
      },
      config
    );

    assert.equal(res.dispatched, true);
    assert.equal(res.payload.sessionId, "sess-override");
  });

  it("auto-flushes digest when buffer count reaches threshold", async () => {
    const config = {
      root: tempRoot,
      notifications: {
        mode: "digest",
        threshold: 3,
        criticalReasons: [],
      },
      dryRun: true,
    };

    await dispatchEscalation({ sessionId: "sess-1", reason: "REPAIR_1" }, config);
    await dispatchEscalation({ sessionId: "sess-2", reason: "REPAIR_2" }, config);

    // 3rd incident hits threshold = 3, triggering auto-flush
    const res3 = await dispatchEscalation({ sessionId: "sess-3", reason: "REPAIR_3" }, config);

    assert.equal(res3.flushed, true);
    assert.equal(res3.count, 3);
    assert.equal(res3.payload.incidents.length, 3);

    // Buffer cleared after flush
    const status = getEscalationDigestStatus(tempRoot, config);
    assert.equal(status.pendingCount, 0);
  });

  it("enforces hourly interruption budget on immediate non-critical alerts", async () => {
    const config = {
      root: tempRoot,
      notifications: {
        mode: "immediate",
        budgetPerHour: 2,
        criticalReasons: ["AWAITING_USER_FEEDBACK"],
      },
      dryRun: true,
    };

    // First 2 non-critical alerts are allowed
    const r1 = await dispatchEscalation({ sessionId: "sess-alert-1", reason: "NON_CRITICAL" }, config);
    assert.equal(r1.dispatched, true);

    const r2 = await dispatchEscalation({ sessionId: "sess-alert-2", reason: "NON_CRITICAL" }, config);
    assert.equal(r2.dispatched, true);

    // 3rd exceeds budget of 2 per hour -> demoted to digest buffer
    const r3 = await dispatchEscalation({ sessionId: "sess-alert-3", reason: "NON_CRITICAL" }, config);
    assert.equal(r3.dispatched, false);
    assert.equal(r3.buffered, true);
    assert.equal(r3.reason, "INTERRUPTION_BUDGET_EXCEEDED");

    // Critical reason STILL dispatches even if budget is exceeded
    const rCrit = await dispatchEscalation({ sessionId: "sess-crit", reason: "AWAITING_USER_FEEDBACK" }, config);
    assert.equal(rCrit.dispatched, true);
  });

  it("suppresses all non-critical notifications in silent mode", async () => {
    const config = {
      root: tempRoot,
      notifications: {
        mode: "silent",
        criticalReasons: ["R3_GATE_VIOLATION"],
      },
      dryRun: true,
    };

    const res = await dispatchEscalation({ sessionId: "sess-silent", reason: "SWARM_TASK_COMPLETE" }, config);
    assert.equal(res.dispatched, false);
    assert.equal(res.silent, true);
    assert.equal(res.reason, "SILENT_MODE");
  });

  it("flushes batched digest to Slack and Discord webhook endpoints", async () => {
    let slackReceived = false;
    let discordReceived = false;

    const mockServer = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url === "/slack-digest") {
          slackReceived = true;
          const parsed = JSON.parse(body);
          assert.ok(parsed.text.includes("Jules Escalation Digest"));
          assert.ok(parsed.blocks[1].text.text.includes("sess-a"));
          assert.ok(parsed.blocks[1].text.text.includes("sess-b"));
        } else if (req.url === "/discord-digest") {
          discordReceived = true;
          const parsed = JSON.parse(body);
          assert.ok(parsed.content.includes("Jules Escalation Digest"));
          assert.equal(parsed.embeds[0].fields.length, 2);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    const port = mockServer.address().port;

    try {
      const config = {
        root: tempRoot,
        notifications: {
          slackWebhookUrl: `http://127.0.0.1:${port}/slack-digest`,
          discordWebhookUrl: `http://127.0.0.1:${port}/discord-digest`,
        },
      };

      bufferEscalationIncident({ sessionId: "sess-a", branch: "feat-a", reason: "RETRY" }, tempRoot);
      bufferEscalationIncident({ sessionId: "sess-b", branch: "feat-b", reason: "WARN" }, tempRoot);

      const flushRes = await flushEscalationDigest(config, { root: tempRoot });
      assert.equal(flushRes.flushed, true);
      assert.equal(flushRes.count, 2);
      assert.equal(flushRes.slack, true);
      assert.equal(flushRes.discord, true);
      assert.equal(slackReceived, true);
      assert.equal(discordReceived, true);

      // Verify buffer cleared
      const st = getEscalationDigestStatus(tempRoot, config);
      assert.equal(st.pendingCount, 0);
    } finally {
      mockServer.close();
    }
  });

  it("redacts credentials and secrets from buffered incident logs", () => {
    const tokenPartA = "ghp";
    const tokenPartB = "123456789012345678901234567890123456";
    const dynamicToken = `${tokenPartA}_${tokenPartB}`;
    const rawLogs = `API error: ${dynamicToken} failed auth`;
    bufferEscalationIncident({ sessionId: "sess-sec", logs: rawLogs }, tempRoot);

    const digest = loadEscalationDigest(tempRoot);
    assert.equal(digest.incidents.length, 1);
    assert.ok(!digest.incidents[0].logs.includes(tokenPartB));
    assert.ok(digest.incidents[0].logs.includes("[REDACTED_BY_SECURITY_GATE]"));
  });

  it("clearEscalationDigest resets the digest buffer cleanly", () => {
    bufferEscalationIncident({ sessionId: "sess-1" }, tempRoot);
    bufferEscalationIncident({ sessionId: "sess-2" }, tempRoot);
    assert.equal(getEscalationDigestStatus(tempRoot).pendingCount, 2);

    clearEscalationDigest(tempRoot);
    assert.equal(getEscalationDigestStatus(tempRoot).pendingCount, 0);
  });
});
