#!/usr/bin/env node

/**
 * Backward compatibility shim for jules-nightly.mjs in v0.9.0.
 */

import { worktreePrune } from "../src/git.mjs";

if (process.argv[1] && process.argv[1].endsWith("jules-nightly.mjs")) {
  worktreePrune();
  console.log("[Shim] Nightly maintenance complete.");
  process.exit(0);
}
