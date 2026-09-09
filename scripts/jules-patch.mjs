#!/usr/bin/env node

/**
 * Session patch fetching CLI entrypoint.
 *
 * fetchSessionPatch (argument validation around src/session-ops.mjs's
 * extractSessionPatch) moved to session-ops itself (P04 shim cleanup); it is
 * re-exported here for historical importers.
 */

export { fetchSessionPatch } from "../src/session-ops.mjs";

import { fetchSessionPatch } from "../src/session-ops.mjs";

if (process.argv[1] && process.argv[1].endsWith("jules-patch.mjs")) {
  const sessionId = process.argv[2];
  if (!sessionId) {
    console.error("Usage: node scripts/jules-patch.mjs <sessionId>");
    process.exit(1);
  }
  fetchSessionPatch(sessionId)
    .then((res) => {
      console.log(`Patch fetch completed for ${sessionId}: ${res.patch ? "Patch found" : "No patch"}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`Patch fetch failed: ${err.message}`);
      process.exit(1);
    });
}
