#!/usr/bin/env node

/**
 * Nightly repository maintenance and worktree pruning.
 */

import { worktreePrune } from "../src/git.mjs";

if (process.argv[1] && process.argv[1].endsWith("jules-nightly.mjs")) {
  worktreePrune();
  console.log("Nightly maintenance complete.");
  process.exit(0);
}
