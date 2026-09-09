#!/usr/bin/env node

/**
 * Queue processing runner: processes envelopes in .agent/jules-queue/.
 *
 * Spawned by the webhook receiver as `node scripts/jules-queue-runner.mjs`.
 * Failure classification lives in src/engine.mjs (P04 shim cleanup); the
 * re-export keeps the historical import surface for external consumers.
 */

export { classifyQueueFailure } from "../src/engine.mjs";

import { run } from "../src/engine.mjs";

if (process.argv[1] && process.argv[1].endsWith("jules-queue-runner.mjs")) {
  const root = process.env.JULES_PROJECT_ROOT || process.cwd();
  const isDry = process.env.JULES_DRY_RUN === "true" || process.env.JULES_DRY_RUN === "1";

  await run({ root, dryRun: isDry });
  console.log("Queue processing complete!");
  process.exit(0);
}
