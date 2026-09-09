#!/usr/bin/env node

/**
 * Session status and budget status summarizer.
 *
 * categorizeTaskStatus moved to src/session-ops.mjs (P04 shim cleanup) and is
 * re-exported here for historical importers; the CLI body now runs only under
 * the entry guard, so importing this script no longer executes side effects.
 */

export { categorizeTaskStatus } from "../src/session-ops.mjs";

import { checkDailyBudget } from "../src/state.mjs";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

if (process.argv[1] && process.argv[1].endsWith("jules-status.mjs")) {
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
}
