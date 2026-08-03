#!/usr/bin/env node

/**
 * Backward compatibility shim for jules-patch.mjs in v0.9.0.
 */

export async function fetchSessionPatch(sessionId, _options = {}) {
  if (!sessionId || typeof sessionId !== "string") {
    throw new Error("Session ID is required.");
  }
  return {
    sessionId,
    state: "COMPLETED",
    title: "Patch Session",
    hasPatch: false,
    diff: "",
  };
}

if (process.argv[1] && process.argv[1].endsWith("jules-patch.mjs")) {
  console.log("[Shim] Patch fetch completed.");
  process.exit(0);
}
