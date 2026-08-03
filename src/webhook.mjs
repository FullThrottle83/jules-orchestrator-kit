import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

/**
 * Verify GitHub webhook HMAC SHA-256 signature against request payload.
 * @param {Buffer|string} payload - Raw request body
 * @param {string} signatureHeader - Value of X-Hub-Signature-256 header
 * @param {string} secret - Configured webhook secret
 * @returns {boolean} True if signature matches
 */
export function verifySignature(payload, signatureHeader, secret) {
  if (!secret) return true; // If no secret is configured, skip verification (development mode)
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;

  const hmac = createHmac("sha256", secret);
  const bodyBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf-8");
  const digest = `sha256=${hmac.update(bodyBuf).digest("hex")}`;

  const sigBuf = Buffer.from(signatureHeader, "utf-8");
  const digestBuf = Buffer.from(digest, "utf-8");

  if (sigBuf.length !== digestBuf.length) return false;
  return timingSafeEqual(sigBuf, digestBuf);
}

/**
 * Parse incoming webhook body buffer into a JS object.
 * @param {Buffer} bodyBuf 
 * @param {string} contentType 
 * @returns {object} Parsed JSON payload
 */
export function parseWebhookPayload(bodyBuf, contentType = "application/json") {
  const str = bodyBuf.toString("utf-8");
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(str);
    const payloadStr = params.get("payload");
    return payloadStr ? JSON.parse(payloadStr) : {};
  }
  return str ? JSON.parse(str) : {};
}

/**
 * Route and handle recognized GitHub event types.
 * @param {string} eventType - Value of X-GitHub-Event header
 * @param {object} payload - Parsed payload body
 * @param {object} [handlers] - Custom action callbacks
 * @returns {object} Response summary { handled: boolean, action: string, details: object }
 */
export function routeWebhookEvent(eventType, payload, handlers = {}) {
  if (eventType === "ping") {
    return { handled: true, action: "ping", details: { zen: payload.zen, hookId: payload.hook_id } };
  }

  if (eventType === "pull_request") {
    const action = payload.action;
    const prNumber = payload.number || payload.pull_request?.number;
    const repo = payload.repository?.full_name;
    const branch = payload.pull_request?.head?.ref;
    const merged = payload.pull_request?.merged || false;

    const details = { action, prNumber, repo, branch, merged };
    if (typeof handlers.onPullRequest === "function") {
      handlers.onPullRequest(details, payload);
    }
    return { handled: true, action: `pull_request:${action}`, details };
  }

  if (eventType === "workflow_run") {
    const action = payload.action;
    const name = payload.workflow?.name || payload.workflow_run?.name;
    const conclusion = payload.workflow_run?.conclusion;
    const repo = payload.repository?.full_name;

    const details = { action, name, conclusion, repo };
    if (typeof handlers.onWorkflowRun === "function") {
      handlers.onWorkflowRun(details, payload);
    }
    return { handled: true, action: `workflow_run:${action}`, details };
  }

  return { handled: false, action: eventType, details: {} };
}

/**
 * Create zero-dependency HTTP Webhook Server.
 * @param {object} config
 * @param {number} [config.port=8787]
 * @param {string} [config.secret]
 * @param {object} [config.handlers]
 * @param {function} [config.log]
 * @returns {import("node:http").Server}
 */
export function createWebhookServer({ port = 8787, secret = process.env.JULES_WEBHOOK_SECRET, handlers = {}, log = console.log } = {}) {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method Not Allowed" }));
      return;
    }

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const bodyBuf = Buffer.concat(chunks);
      const sigHeader = req.headers["x-hub-signature-256"];
      const eventType = req.headers["x-github-event"];
      const contentType = req.headers["content-type"] || "application/json";

      if (secret && !verifySignature(bodyBuf, sigHeader, secret)) {
        log(`[Webhook] Invalid signature received from ${req.socket.remoteAddress}`);
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid signature" }));
        return;
      }

      try {
        const payload = parseWebhookPayload(bodyBuf, contentType);
        const result = routeWebhookEvent(eventType, payload, handlers);

        log(`[Webhook] Event: ${eventType} (${result.action}) handled=${result.handled}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received: true, result }));
      } catch (err) {
        log(`[Webhook] Error parsing payload: ${err.message}`);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Malformed payload" }));
      }
    });
  });

  return server;
}
