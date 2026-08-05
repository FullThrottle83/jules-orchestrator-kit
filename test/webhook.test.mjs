import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifySignature, parseWebhookPayload, routeWebhookEvent, createWebhookServer } from "../src/webhook.mjs";

describe("src/webhook.mjs", () => {
  const secret = "test-webhook-secret-12345";

  it("verifySignature validates correct HMAC SHA-256 signatures", () => {
    const payload = JSON.stringify({ action: "opened", number: 42 });
    const hmac = createHmac("sha256", secret).update(payload).digest("hex");
    const sigHeader = `sha256=${hmac}`;

    assert.equal(verifySignature(payload, sigHeader, secret), true);
  });

  it("verifySignature rejects invalid signatures or tampered payloads", () => {
    const payload = JSON.stringify({ action: "opened", number: 42 });
    const tamperedPayload = JSON.stringify({ action: "opened", number: 999 });
    const hmac = createHmac("sha256", secret).update(payload).digest("hex");
    const sigHeader = `sha256=${hmac}`;

    assert.equal(verifySignature(tamperedPayload, sigHeader, secret), false);
    assert.equal(verifySignature(payload, "sha256=invalidhash", secret), false);
    assert.equal(verifySignature(payload, "", secret), false);
  });

  it("parseWebhookPayload handles JSON and urlencoded forms", () => {
    const jsonBuf = Buffer.from(JSON.stringify({ zen: "Responsive is better than fast." }));
    const parsedJson = parseWebhookPayload(jsonBuf, "application/json");
    assert.equal(parsedJson.zen, "Responsive is better than fast.");

    const formBuf = Buffer.from("payload=" + encodeURIComponent(JSON.stringify({ foo: "bar" })));
    const parsedForm = parseWebhookPayload(formBuf, "application/x-www-form-urlencoded");
    assert.equal(parsedForm.foo, "bar");
  });

  it("routeWebhookEvent correctly categorizes ping, pull_request, and workflow_run", () => {
    let prTriggered = false;
    let wfTriggered = false;

    const handlers = {
      onPullRequest: (details) => {
        prTriggered = true;
        assert.equal(details.action, "opened");
        assert.equal(details.prNumber, 12);
      },
      onWorkflowRun: (details) => {
        wfTriggered = true;
        assert.equal(details.action, "completed");
        assert.equal(details.conclusion, "success");
      },
    };

    const pingRes = routeWebhookEvent("ping", { zen: "Keep it simple" }, handlers);
    assert.equal(pingRes.handled, true);
    assert.equal(pingRes.action, "ping");

    const prRes = routeWebhookEvent(
      "pull_request",
      { action: "opened", number: 12, pull_request: { head: { ref: "feature-a" } } },
      handlers
    );
    assert.equal(prRes.handled, true);
    assert.equal(prTriggered, true);

    const wfRes = routeWebhookEvent(
      "workflow_run",
      { action: "completed", workflow_run: { name: "CI", conclusion: "success" } },
      handlers
    );
    assert.equal(wfRes.handled, true);
    assert.equal(wfTriggered, true);
  });

  it("createWebhookServer responds to /health and handles HTTP requests", async () => {
    const server = createWebhookServer({ port: 0, secret, log: () => {} });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      // Test GET /health
      const healthRes = await fetch(`http://localhost:${port}/health`);
      assert.equal(healthRes.status, 200);
      const healthBody = await healthRes.json();
      assert.equal(healthBody.status, "ok");

      // Test POST invalid signature
      const badRes = await fetch(`http://localhost:${port}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=invalid" },
        body: JSON.stringify({ action: "opened" }),
      });
      assert.equal(badRes.status, 401);

      // Test POST valid signature
      const validBody = JSON.stringify({ zen: "Test ping" });
      const validHmac = createHmac("sha256", secret).update(validBody).digest("hex");
      const goodRes = await fetch(`http://localhost:${port}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "ping",
          "X-Hub-Signature-256": `sha256=${validHmac}`,
        },
        body: validBody,
      });
      assert.equal(goodRes.status, 200);
      const goodJson = await goodRes.json();
      assert.equal(goodJson.received, true);
      assert.equal(goodJson.result.action, "ping");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
