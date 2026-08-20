import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getStateDir } from "./state.mjs";
import { resolveRoot, DEFAULT_CRITICAL_REASONS } from "./config.mjs";
import { redactSecrets } from "./security.mjs";

/**
 * Reasons that bypass the governor and page the operator the moment they occur.
 * Defined in config.mjs (loadConfig needs the same list); re-exported here
 * because this is the module that acts on it.
 *
 * The list is deliberately short. Anything named here is exempt from batching,
 * so a reason belongs on it only when a delayed alert would let damage widen:
 * a leaked credential keeps being valid, a violated gate keeps merging. Those
 * are safety events, and the cost of waking someone beats the cost of waiting.
 *
 * `AWAITING_USER_FEEDBACK` is deliberately NOT here, even though it is the most
 * urgent-*feeling* reason. It is the one a blocked agent raises, so on a swarm
 * of fifteen workers it is also the most frequent by a wide margin — and it is
 * the exact case the governor exists to batch. Listing it (as v0.35.0 did) made
 * every default-configured escalation critical and left the governor governing
 * nothing. Same for `OODA_REPAIR_EXHAUSTED`: the task has already stopped, so
 * nothing worsens while it sits in a digest.
 *
 * An operator who wants the old behaviour sets `notifications.critical_reasons`
 * in `.agent/config.yml` — this is a default, not a policy.
 */
export { DEFAULT_CRITICAL_REASONS };

/**
 * How many incidents one flush may carry.
 *
 * Slack truncates the summary block and Discord accepts a bounded field list,
 * so a flush of fifty would render ten and drop forty. The digest promises the
 * opposite — that a buffered incident is never lost — so a flush sends at most
 * this many and leaves the remainder buffered for the next one.
 */
export const DIGEST_BATCH_LIMIT = 10;

export function getDigestFilePath(root = resolveRoot()) {
  return join(getStateDir(root), "escalation-digest.json");
}

export function getInterruptionLedgerPath(root = resolveRoot()) {
  return join(getStateDir(root), "interruption-ledger.json");
}

export function loadEscalationDigest(root = resolveRoot()) {
  const file = getDigestFilePath(root);
  if (!existsSync(file)) return { incidents: [], createdAt: null, updatedAt: null };
  try {
    const raw = readFileSync(file, "utf-8");
    const data = JSON.parse(raw);
    return {
      incidents: Array.isArray(data.incidents) ? data.incidents : [],
      createdAt: data.createdAt || null,
      updatedAt: data.updatedAt || null,
    };
  } catch (_) {
    return { incidents: [], createdAt: null, updatedAt: null };
  }
}

export function saveEscalationDigest(root = resolveRoot(), digestData = {}) {
  const file = getDigestFilePath(root);
  const data = {
    incidents: digestData.incidents || [],
    createdAt: digestData.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
  return data;
}

export function clearEscalationDigest(root = resolveRoot()) {
  const file = getDigestFilePath(root);
  if (existsSync(file)) {
    try {
      unlinkSync(file);
    } catch (_) {
      writeFileSync(file, JSON.stringify({ incidents: [], createdAt: null, updatedAt: null }), "utf-8");
    }
  }
  return { ok: true, cleared: true };
}

export function bufferEscalationIncident(incident = {}, root = resolveRoot()) {
  const current = loadEscalationDigest(root);
  const rawLogs = incident.logs || incident.error || "";
  const scrubbedLogs = rawLogs ? redactSecrets(String(rawLogs)) : "";
  const entry = {
    id: incident.sessionId || `incident-${Date.now()}`,
    sessionId: incident.sessionId || "unknown-session",
    taskId: incident.taskId || "agent-task",
    branch: incident.branch || "main",
    reason: incident.reason || "NON_CRITICAL_EVENT",
    logs: scrubbedLogs.split("\n").slice(-10).join("\n"),
    timestamp: incident.timestamp || new Date().toISOString(),
  };
  const updatedIncidents = [...current.incidents, entry];
  saveEscalationDigest(root, {
    incidents: updatedIncidents,
    createdAt: current.createdAt || new Date().toISOString(),
  });
  return {
    buffered: true,
    count: updatedIncidents.length,
    incident: entry,
  };
}

export function loadInterruptionLedger(root = resolveRoot()) {
  const file = getInterruptionLedgerPath(root);
  if (!existsSync(file)) return [];
  try {
    const raw = readFileSync(file, "utf-8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

export function recordInterruption(root = resolveRoot()) {
  const file = getInterruptionLedgerPath(root);
  const now = Date.now();
  const entries = loadInterruptionLedger(root).filter((ts) => now - ts < 3600000); // 1 hour sliding window
  entries.push(now);
  writeFileSync(file, JSON.stringify(entries), "utf-8");
  return entries.length;
}

export function countRecentInterruptions(root = resolveRoot(), windowMs = 3600000) {
  const now = Date.now();
  const entries = loadInterruptionLedger(root);
  return entries.filter((ts) => now - ts < windowMs).length;
}

export function getEscalationDigestStatus(root = resolveRoot(), config = {}) {
  const digest = loadEscalationDigest(root);
  const notifications = config.notifications || {};
  const budgetPerHour = notifications.budgetPerHour ?? 3;
  const recentInterruptions = countRecentInterruptions(root);

  return {
    pendingCount: digest.incidents.length,
    incidents: digest.incidents,
    createdAt: digest.createdAt,
    updatedAt: digest.updatedAt,
    budgetPerHour,
    recentInterruptions,
    budgetAvailable: Math.max(0, budgetPerHour - recentInterruptions),
    mode: notifications.mode || "immediate",
    threshold: notifications.threshold || 5,
  };
}

export async function flushEscalationDigest(config = {}, options = {}) {
  const root = options.root || resolveRoot();
  const digest = loadEscalationDigest(root);
  if (digest.incidents.length === 0) {
    return { flushed: false, count: 0, reason: "No pending incidents in digest" };
  }

  const notifications = config.notifications || {};
  const slackUrl = process.env.SLACK_WEBHOOK_URL || notifications.slackWebhookUrl || config.slackWebhookUrl || "";
  const discordUrl = process.env.DISCORD_WEBHOOK_URL || notifications.discordWebhookUrl || config.discordWebhookUrl || "";
  const dryRun = options.dryRun || config.dryRun || false;

  // One flush carries a bounded batch; whatever does not fit stays buffered.
  const batch = digest.incidents.slice(0, DIGEST_BATCH_LIMIT);
  const remainder = digest.incidents.slice(DIGEST_BATCH_LIMIT);
  const count = batch.length;
  const results = { flushed: true, count, pending: remainder.length, slack: false, discord: false, dryRun };

  if (dryRun) {
    // A dry run shows what *would* be sent. It must leave the buffer exactly as
    // it found it — clearing here (as v0.35.0 did) discarded real incidents in
    // exchange for a preview.
    return {
      ...results,
      payload: {
        count,
        incidents: batch,
      },
    };
  }

  if (!slackUrl && !discordUrl) {
    return { flushed: false, count, slack: false, discord: false, reason: "No webhook URL configured" };
  }

  // Format Slack digest
  if (slackUrl) {
    try {
      const summaryText = batch
        .map((inc) => `• *\`${inc.sessionId}\`* on \`${inc.branch}\` [${inc.reason}]: \`agentctl resume ${inc.sessionId}\``)
        .join("\n");

      const slackBody = {
        text: `📋 *Jules Escalation Digest* (${count} batched incident${count > 1 ? "s" : ""})`,
        blocks: [
          {
            type: "header",
            text: { type: "plain_text", text: `📋 Jules Escalation Digest (${count} incidents)` },
          },
          {
            type: "section",
            text: { type: "mrkdwn", text: summaryText.slice(0, 2500) },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text:
                  `Aggregated by Type III Silence Governor · Oldest: ${digest.createdAt || "N/A"}` +
                  (remainder.length ? ` · ${remainder.length} still buffered` : ""),
              },
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

  // Format Discord digest
  if (discordUrl) {
    try {
      const fields = batch.map((inc) => ({
        name: `Session \`${inc.sessionId}\` [${inc.reason}]`,
        value: `Branch: \`${inc.branch}\`\n\`agentctl resume ${inc.sessionId} --response "<answer>"\``,
        inline: false,
      }));

      const discordBody = {
        content: `📋 **Jules Escalation Digest** (${count} batched incident${count > 1 ? "s" : ""})`,
        embeds: [
          {
            title: `Escalation Digest (${count} incidents)`,
            color: 3447003,
            fields,
            footer: {
              text:
                `Aggregated by Type III Silence Governor · Total: ${count}` +
                (remainder.length ? ` · ${remainder.length} still buffered` : ""),
            },
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

  // Only what actually reached a webhook is dropped. A failed delivery leaves
  // the whole buffer intact so the next flush retries it rather than silently
  // eating the incidents.
  if ((results.slack || results.discord) && !options.preserve) {
    if (remainder.length) {
      saveEscalationDigest(root, { incidents: remainder, createdAt: digest.createdAt });
    } else {
      clearEscalationDigest(root);
    }
  }

  return results;
}

/**
 * Dispatches an asynchronous escalation incident payload to configured Slack and/or Discord webhooks,
 * governed by the Type III Silence Governor and interruption budget.
 * @param {object} incident - Incident details
 * @param {string} incident.sessionId
 * @param {string} [incident.taskId]
 * @param {string} [incident.branch]
 * @param {string} [incident.reason] - AWAITING_USER_FEEDBACK | OODA_REPAIR_EXHAUSTED | R3_GATE_VIOLATION
 * @param {string} [incident.logs] - Last 20 lines of compiler/test output
 * @param {boolean} [incident.critical] - Force immediate alert
 * @param {object} [config]
 * @returns {Promise<object>} Dispatch status
 */
export async function dispatchEscalation(incident = {}, config = {}) {
  const root = config.root || resolveRoot();
  const notifications = config.notifications || {};
  const mode = (notifications.mode || config.notificationMode || "immediate").toLowerCase();
  const threshold = notifications.threshold || 5;
  const budgetPerHour = notifications.budgetPerHour ?? 3;
  const criticalReasons = notifications.criticalReasons || DEFAULT_CRITICAL_REASONS;

  const reason = incident.reason || "AWAITING_USER_FEEDBACK";
  const isCritical = incident.critical === true || criticalReasons.includes(reason) || config.forceImmediate === true;

  // Non-critical governance
  if (!isCritical) {
    if (mode === "silent") {
      bufferEscalationIncident(incident, root);
      return {
        dispatched: false,
        buffered: true,
        silent: true,
        reason: "SILENT_MODE",
      };
    }

    if (mode === "digest" || mode === "threshold") {
      const bufferRes = bufferEscalationIncident(incident, root);
      if (bufferRes.count >= threshold) {
        return await flushEscalationDigest(config, { root, dryRun: config.dryRun });
      }
      return {
        dispatched: false,
        buffered: true,
        digestCount: bufferRes.count,
        reason: "BUFFERED_IN_DIGEST",
      };
    }

    // mode === "immediate" with interruption budget
    const recentCount = countRecentInterruptions(root);
    if (recentCount >= budgetPerHour) {
      const bufferRes = bufferEscalationIncident(incident, root);
      return {
        dispatched: false,
        buffered: true,
        digestCount: bufferRes.count,
        reason: "INTERRUPTION_BUDGET_EXCEEDED",
      };
    }
  }

  const slackUrl = process.env.SLACK_WEBHOOK_URL || notifications.slackWebhookUrl || config.slackWebhookUrl || "";
  const discordUrl = process.env.DISCORD_WEBHOOK_URL || notifications.discordWebhookUrl || config.discordWebhookUrl || "";

  if (!slackUrl && !discordUrl && !config.dryRun) {
    return { dispatched: false, slack: false, discord: false, reason: "No webhook URL configured" };
  }

  const sessionId = incident.sessionId || "unknown-session";
  const taskId = incident.taskId || "agent-task";
  const branch = incident.branch || "main";
  const rawLogs = incident.logs || incident.error || "No error log attached.";

  // Normalize last 20 lines of logs with secret scrubbing
  const scrubbedLogs = redactSecrets(String(rawLogs));
  const logLines = scrubbedLogs.split("\n").slice(-20).join("\n");
  const resumeCmd = `agentctl resume ${sessionId} --response "<your-answer>"`;

  const results = { dispatched: true, slack: false, discord: false };

  if (config.dryRun) {
    return {
      ...results,
      dryRun: true,
      payload: {
        sessionId,
        taskId,
        reason,
        resumeCmd,
        logLines,
      },
    };
  }

  // The budget counts interruptions, not intentions. Recording it any earlier
  // charged the operator's hourly allowance for a `--dry-run` preview or for a
  // repo with no webhook configured — an alert nobody ever received. Same
  // mistake the daily task budget made before cd26d6e; same fix.
  if (!isCritical) {
    recordInterruption(root);
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
export function createWebhookServer({ port = 8787, secret = process.env.JULES_WEBHOOK_SECRET, handlers = {}, log = console.log } = {}) {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", port, timestamp: new Date().toISOString() }));
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

