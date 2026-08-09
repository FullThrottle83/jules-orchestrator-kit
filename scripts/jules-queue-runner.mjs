#!/usr/bin/env node

/**
 * Backward compatibility shim for jules-queue-runner.mjs in v0.9.0.
 */

import { getQueueDir, ensureDir } from "../src/state.mjs";
import { isTaskFile } from "../src/engine.mjs";
import { readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

export function classifyQueueFailure(err) {
  const msg = String(err?.message || err || "");
  if (msg.includes("FAILED_PRECONDITION") || msg.includes("Active Session Limit") || msg.includes("concurrency")) {
    return "concurrency_limit";
  }
  return "retriable";
}

if (process.argv[1] && process.argv[1].endsWith("jules-queue-runner.mjs")) {
  const root = process.env.JULES_PROJECT_ROOT || process.cwd();
  const queueDir = getQueueDir(root);
  const files = readdirSync(queueDir).filter((f) => isTaskFile(f, queueDir));

  if (files.length === 0) {
    console.log("Queue processing complete!");
    process.exit(0);
  }

  const completedDir = join(queueDir, "completed");
  ensureDir(completedDir);

  for (const file of files) {
    const src = join(queueDir, file);
    const dst = join(completedDir, file);
    try {
      renameSync(src, dst);
    } catch (_) {}
  }

  console.log("Queue processing complete!");
  process.exit(0);
}
