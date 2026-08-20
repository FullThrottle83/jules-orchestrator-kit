#!/usr/bin/env node

/**
 * Session status and budget status summarizer.
 */

import { checkDailyBudget } from "../src/state.mjs";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function categorizeTaskStatus(statusStr = "") {
  const s = String(statusStr).toUpperCase();
  if (s === "AWAITING_PLAN_APPROVAL" || s === "AWAITING_USER_FEEDBACK") {
    return "action_required";
  }
  if (s === "IN_PROGRESS" || s === "DISPATCHED") {
    return "in_progress";
  }
  if (s === "COMPLETED" || s === "FAILED") {
    return "completed";
  }
  return "unknown";
}

const isJson = process.argv.includes("--json");
const root = process.env.JULES_PROJECT_ROOT || process.cwd();
const budget = checkDailyBudget(root);

let queueItems = [];
const queueFile = join(root, ".agent/jules-queue/queue.jsonl");
if (existsSync(queueFile)) {
  try {
    const raw = readFileSync(queueFile, "utf-8");
    queueItems = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parsed = JSON.parse(line);
        return {
          ...parsed,
          Status: parsed.Status || parsed.status || "PENDING",
        };
      });
  } catch (_) {}
}

if (isJson) {
  console.log(JSON.stringify({ queue: queueItems, sessions: [], budget }));
} else {
  console.log(`[Shim] Status: Daily Budget ${budget.used}/${budget.budget} used.`);
}
