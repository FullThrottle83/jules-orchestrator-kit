#!/usr/bin/env node

/**
 * Backward compatibility shim for jules-queue-runner.mjs in v0.9.0.
 */

import { run } from "../src/engine.mjs";

export function classifyQueueFailure(err) {
  const msg = String(err?.message || err || "");
  if (msg.includes("FAILED_PRECONDITION") || msg.includes("Active Session Limit") || msg.includes("concurrency")) {
    return "concurrency_limit";
  }
  return "retriable";
}

if (process.argv[1] && process.argv[1].endsWith("jules-queue-runner.mjs")) {
  const root = process.env.JULES_PROJECT_ROOT || process.cwd();
  const isDry = process.env.JULES_DRY_RUN === "true" || process.env.JULES_DRY_RUN === "1";

  await run({ root, dryRun: isDry });
  console.log("Queue processing complete!");
  process.exit(0);
}
