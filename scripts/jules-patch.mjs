#!/usr/bin/env node

/**
 * Session patch fetching utility.
 */

import { extractSessionPatch } from "../src/session-ops.mjs";

export async function fetchSessionPatch(sessionId, options = {}) {
  if (!sessionId || typeof sessionId !== "string") {
    throw new Error("Session ID is required.");
  }
  return await extractSessionPatch(sessionId, options);
}

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
