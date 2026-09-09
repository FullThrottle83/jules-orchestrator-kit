#!/usr/bin/env node

/**
 * Swarm merge CLI entrypoint.
 *
 * The merge engine (3-way structural merge, git merge-file isolation,
 * safety gate) lives in src/merge-swarm.mjs (P04 shim cleanup). The
 * re-export below preserves the historical `scripts/jules-merge-swarm.mjs`
 * import surface for external consumers.
 */

export * from "../src/merge-swarm.mjs";

import { EXIT, checkSafetyGate } from "../src/merge-swarm.mjs";

if (process.argv[1] && process.argv[1].endsWith("jules-merge-swarm.mjs")) {
  const branchName = process.argv[2] || "";
  const gateResult = checkSafetyGate(branchName);
  if (!gateResult.safe) {
    console.error(`[merge-swarm] Safety gate check failed: ${gateResult.reason}`);
    process.exit(EXIT.R3_RESTRICTED);
  }

  console.log("No open Jules PRs found.");
  process.exit(EXIT.SUCCESS);
}
