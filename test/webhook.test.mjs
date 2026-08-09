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

  it("verifySignature rejects invalid character encodings in signature header", () => {
    const payload = JSON.stringify({ action: "opened", number: 42 });
    
    // Non-hex characters in the signature block
    assert.equal(verifySignature(payload, "sha256=not-a-valid-hex-signature-at-all-xyz-123-abc-456-def-789-uvw", secret), false);
    
    // UTF-8 surrogate pairs or emojis in the signature header
    assert.equal(verifySignature(payload, "sha256=🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨", secret), false);

    // Non-string values passed as signature headers
    assert.equal(verifySignature(payload, null, secret), false);
    assert.equal(verifySignature(payload, undefined, secret), false);
    assert.equal(verifySignature(payload, 12345, secret), false);
    assert.equal(verifySignature(payload, {}, secret), false);
    assert.equal(verifySignature(payload, [], secret), false);
  });

  it("verifySignature rejects empty or missing signature headers", () => {
    const payload = JSON.stringify({ action: "opened" });
    
    // Explicit empty string
    assert.equal(verifySignature(payload, "", secret), false);
    
    // Whitespace-only string
    assert.equal(verifySignature(payload, "   ", secret), false);
    
    // Header without the expected prefix
    assert.equal(verifySignature(payload, "sha256=", secret), false);
  });

  it("parseWebhookPayload handles JSON and urlencoded forms", () => {
    const jsonBuf = Buffer.from(JSON.stringify({ zen: "Responsive is better than fast." }));
    const parsedJson = parseWebhookPayload(jsonBuf, "application/json");
    assert.equal(parsedJson.zen, "Responsive is better than fast.");

    const formBuf = Buffer.from("payload=" + encodeURIComponent(JSON.stringify({ foo: "bar" })));
    const parsedForm = parseWebhookPayload(formBuf, "application/x-www-form-urlencoded");
    assert.equal(parsedForm.foo, "bar");
  });

  it("parseWebhookPayload handles empty, missing, or whitespace-only inputs safely", () => {
    // Empty buffer
    assert.deepEqual(parseWebhookPayload(Buffer.from("")), {});
    
    // Whitespace buffer
    assert.deepEqual(parseWebhookPayload(Buffer.from("   \n\t   ")), {});

    // Null or undefined payload buffer
    assert.deepEqual(parseWebhookPayload(null), {});
    assert.deepEqual(parseWebhookPayload(undefined), {});
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

  it("routeWebhookEvent routes unhandled GitHub event types to fallback handlers safely", () => {
    let unhandledEvent = null;
    let unhandledPayload = null;
    let fallbackEvent = null;
    let fallbackPayload = null;

    const handlers = {
      onUnhandled: (event, payload) => {
        unhandledEvent = event;
        unhandledPayload = payload;
      },
      onFallback: (event, payload) => {
        fallbackEvent = event;
        fallbackPayload = payload;
      },
    };

    const testPayload = { issue: { id: 123 }, action: "created" };
    const res = routeWebhookEvent("issue_comment", testPayload, handlers);

    assert.equal(res.handled, false);
    assert.equal(res.action, "issue_comment");
    assert.equal(unhandledEvent, "issue_comment");
    assert.deepEqual(unhandledPayload, testPayload);
    assert.equal(fallbackEvent, "issue_comment");
    assert.deepEqual(fallbackPayload, testPayload);
  });

  it("routeWebhookEvent prevents crashes if fallback status handlers throw errors", () => {
    const handlers = {
      onUnhandled: () => {
        throw new Error("Simulated fallback handler failure");
      },
      onFallback: () => {
        throw new Error("Simulated fallback handler failure 2");
      },
    };

    const testPayload = { issue: { id: 123 }, action: "created" };
    
    // Calling routeWebhookEvent should not throw, verifying safe routing execution
    assert.doesNotThrow(() => {
      const res = routeWebhookEvent("issue_comment", testPayload, handlers);
      assert.equal(res.handled, false);
      assert.equal(res.action, "issue_comment");
    });
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

  it("createWebhookServer handles unhandled events via HTTP with fallback routing safely", async () => {
    let unhandledCalled = false;
    const handlers = {
      onUnhandled: (event, payload) => {
        unhandledCalled = true;
        assert.equal(event, "release");
        assert.equal(payload.action, "published");
      },
    };

    const server = createWebhookServer({ port: 0, secret, handlers, log: () => {} });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const validBody = JSON.stringify({ action: "published" });
      const validHmac = createHmac("sha256", secret).update(validBody).digest("hex");
      const res = await fetch(`http://localhost:${port}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "release",
          "X-Hub-Signature-256": `sha256=${validHmac}`,
        },
        body: validBody,
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.received, true);
      assert.equal(json.result.handled, false);
      assert.equal(json.result.action, "release");
      assert.equal(unhandledCalled, true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
