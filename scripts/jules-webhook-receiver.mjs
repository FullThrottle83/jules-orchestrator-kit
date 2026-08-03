#!/usr/bin/env node

import { createWebhookServer } from "../src/webhook.mjs";
import { loadEnv, log, timestamp } from "./utils.mjs";
import { spawn } from "node:child_process";
import { resolveRoot } from "../src/config.mjs";

loadEnv();

const PORT = parseInt(process.env.JULES_WEBHOOK_PORT || "8787", 10);
const SECRET = process.env.JULES_WEBHOOK_SECRET || "";
const ROOT = resolveRoot();

function triggerQueueProcessing(reason) {
  log.info(`[${timestamp()}] Triggering queue runner (Reason: ${reason})...`);
  const child = spawn("node", ["scripts/jules-queue-runner.mjs"], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });

  child.on("error", (err) => {
    log.error(`Failed to launch queue runner: ${err.message}`);
  });
  child.on("exit", (code) => {
    log.info(`Queue runner exited with code ${code}`);
  });
}

const handlers = {
  onPullRequest(details) {
    log.step("🔀", `Pull Request ${details.action}: #${details.prNumber} (${details.branch}) on ${details.repo}`);
    if (["opened", "synchronize", "reopened"].includes(details.action)) {
      triggerQueueProcessing(`pull_request:${details.action}`);
    }
  },
  onWorkflowRun(details) {
    log.step("⚙️ ", `Workflow Run ${details.action}: ${details.name} -> ${details.conclusion} on ${details.repo}`);
    if (details.action === "completed") {
      triggerQueueProcessing(`workflow_run:${details.conclusion}`);
    }
  },
};

const server = createWebhookServer({
  port: PORT,
  secret: SECRET,
  handlers,
  log: (msg) => log.info(msg),
});

server.listen(PORT, () => {
  log.header(`Jules Webhook Receiver listening on port ${PORT}`);
  log.info(`Environment: Secret verification ${SECRET ? "ENABLED ✅" : "DISABLED (Dev mode) ⚠️"}`);
  log.info(`Health check endpoint: http://localhost:${PORT}/health`);
});

process.on("SIGTERM", () => {
  log.warn("SIGTERM received. Shutting down Webhook Receiver...");
  server.close(() => {
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  log.warn("SIGINT received. Shutting down Webhook Receiver...");
  server.close(() => {
    process.exit(0);
  });
});
