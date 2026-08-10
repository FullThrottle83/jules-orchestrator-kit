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
  if (!secret) return false; // Fail closed if secret is not configured
  if (typeof signatureHeader !== "string") return false;
  if (!signatureHeader.startsWith("sha256=")) return false;

  const hexSignature = signatureHeader.slice(7);
  // Verify hexSignature consists strictly of 64 hex characters (0-9, a-f, A-F)
  if (!/^[0-9a-fA-F]{64}$/.test(hexSignature)) return false;

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
  if (!bodyBuf || bodyBuf.length === 0) return {};
  const str = bodyBuf.toString("utf-8").trim();
  if (!str) return {};

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(str);
    const payloadStr = params.get("payload");
    return payloadStr ? JSON.parse(payloadStr) : {};
  }
  return JSON.parse(str);
}

/**
 * Route and handle recognized GitHub event types.
 * @param {string} eventType - Value of X-GitHub-Event header
 * @param {object} payload - Parsed payload body
 * @param {object} [handlers] - Custom action callbacks
 * @returns {object} Response summary { handled: boolean, action: string, details: object }
 */
export function routeWebhookEvent(eventType, payload, handlers = {}) {
  const safePayload = payload || {};

  if (eventType === "ping") {
    return { handled: true, action: "ping", details: { zen: safePayload.zen, hookId: safePayload.hook_id } };
  }

  if (eventType === "pull_request") {
    const action = safePayload.action;
    const prNumber = safePayload.number || safePayload.pull_request?.number;
    const repo = safePayload.repository?.full_name;
    const branch = safePayload.pull_request?.head?.ref;
    const merged = safePayload.pull_request?.merged || false;

    const details = { action, prNumber, repo, branch, merged };
    if (typeof handlers.onPullRequest === "function") {
      try {
        handlers.onPullRequest(details, safePayload);
      } catch (err) {
        // Safely ignore errors from handlers
      }
    }
    return { handled: true, action: `pull_request:${action}`, details };
  }

  if (eventType === "workflow_run") {
    const action = safePayload.action;
    const name = safePayload.workflow?.name || safePayload.workflow_run?.name;
    const conclusion = safePayload.workflow_run?.conclusion;
    const repo = safePayload.repository?.full_name;

    const details = { action, name, conclusion, repo };
    if (typeof handlers.onWorkflowRun === "function") {
      try {
        handlers.onWorkflowRun(details, safePayload);
      } catch (err) {
        // Safely ignore errors from handlers
      }
    }
    return { handled: true, action: `workflow_run:${action}`, details };
  }

  // Fallback status handler for unhandled GitHub event types
  if (typeof handlers.onUnhandled === "function") {
    try {
      handlers.onUnhandled(eventType, safePayload);
    } catch (err) {
      // Safely ignore or log error from fallback handler to prevent crashing
    }
  }

  if (typeof handlers.onFallback === "function") {
    try {
      handlers.onFallback(eventType, safePayload);
    } catch (err) {
      // Safely ignore or log error from fallback handler to prevent crashing
    }
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
export function createWebhookServer({ _port = 8787, secret = process.env.JULES_WEBHOOK_SECRET, handlers = {}, log = console.log } = {}) {
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

    const MAX_BODY = 2 * 1024 * 1024; // 2MB payload cap
    const chunks = [];
    let totalSize = 0;

    req.on("data", (chunk) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload Too Large" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (totalSize > MAX_BODY) return;
      const bodyBuf = Buffer.concat(chunks);
      const sigHeader = req.headers["x-hub-signature-256"];
      const eventType = req.headers["x-github-event"];
      const contentType = req.headers["content-type"] || "application/json";

      if (!verifySignature(bodyBuf, sigHeader, secret)) {
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

/**
 * Dispatches an asynchronous escalation incident payload to configured Slack and/or Discord webhooks.
 * @param {object} incident - Incident details
 * @param {string} incident.sessionId
 * @param {string} [incident.taskId]
 * @param {string} [incident.branch]
 * @param {string} [incident.reason] - AWAITING_USER_FEEDBACK | OODA_REPAIR_EXHAUSTED | R3_GATE_VIOLATION
 * @param {string} [incident.logs] - Last 20 lines of compiler/test output
 * @param {object} [config]
 * @returns {Promise<object>} Dispatch status { dispatched: boolean, slack: boolean, discord: boolean }
 */
export async function dispatchEscalation(incident = {}, config = {}) {
  const slackUrl = process.env.SLACK_WEBHOOK_URL || config.slackWebhookUrl || "";
  const discordUrl = process.env.DISCORD_WEBHOOK_URL || config.discordWebhookUrl || "";

  if (!slackUrl && !discordUrl && !config.dryRun) {
    return { dispatched: false, slack: false, discord: false, reason: "No webhook URL configured" };
  }

  const sessionId = incident.sessionId || "unknown-session";
  const taskId = incident.taskId || "agent-task";
  const branch = incident.branch || "main";
  const reason = incident.reason || "AWAITING_USER_FEEDBACK";
  const rawLogs = incident.logs || incident.error || "No error log attached.";

  // Normalize last 20 lines of logs
  const logLines = String(rawLogs).split("\n").slice(-20).join("\n");
  const resumeCmd = `agentctl resume ${sessionId} --response "<your-answer>"`;

  const results = { dispatched: true, slack: false, discord: false };

  if (config.dryRun) {
    return {
      ...results,
      dryRun: true,
      payload: {
        sessionId,
        reason,
        resumeCmd,
        logLines,
      },
    };
  }

  // Dispatch to Slack
  if (slackUrl) {
    try {
      const slackBody = {
        text: `🚨 *Jules Agent Escalation* [${reason}]: Session ${sessionId}`,
        blocks: [
          {
            type: "header",
            text: { type: "plain_text", text: `🚨 Jules Escalation: ${reason}` },
          },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: `*Session ID:*\n\`${sessionId}\`` },
              { type: "mrkdwn", text: `*Branch:*\n\`${branch}\`` },
            ],
          },
          {
            type: "section",
            text: { type: "mrkdwn", text: `*Recent Log Output:*\n\`\`\`${logLines.slice(0, 1000)}\`\`\`` },
          },
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: `👉 *To resume session run:* \`${resumeCmd}\`` },
            ],
          },
        ],
      };

      const res = await fetch(slackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(slackBody),
      });
      results.slack = res.ok;
    } catch (_) {
      results.slack = false;
    }
  }

  // Dispatch to Discord
  if (discordUrl) {
    try {
      const discordBody = {
        content: `🚨 **Jules Agent Escalation** [${reason}] for session \`${sessionId}\``,
        embeds: [
          {
            title: `Escalation Reason: ${reason}`,
            color: 15158332, // Red
            fields: [
              { name: "Session ID", value: `\`${sessionId}\``, inline: true },
              { name: "Branch", value: `\`${branch}\``, inline: true },
              { name: "Resume Command", value: `\`${resumeCmd}\`` },
            ],
            description: `\`\`\`\n${logLines.slice(0, 1000)}\n\`\`\``,
          },
        ],
      };

      const res = await fetch(discordUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(discordBody),
      });
      results.discord = res.ok;
    } catch (_) {
      results.discord = false;
    }
  }

  return results;
}

