#!/usr/bin/env node

import { git, resolveBase } from "../src/git.mjs";

const root = process.cwd();
const maxBehind = parseInt(process.env.STALE_BASE_MAX_COMMITS || "25", 10);
const baseBranch = process.env.BASE_BRANCH || "main";

try {
  const resolvedBase = resolveBase(root, baseBranch);
  const behindStr = git(["rev-list", "--count", `${resolvedBase}..HEAD`], { cwd: root, ignoreError: true });
  const behindCount = parseInt(behindStr || "0", 10);

  console.log(`[stale-base-check] Branch HEAD is ${behindCount} commits behind ${resolvedBase} (max allowed: ${maxBehind}).`);

  if (!isNaN(behindCount) && behindCount > maxBehind) {
    console.error(`❌ STALE BASE GATE FAIL: PR branch is ${behindCount} commits behind ${resolvedBase}. Rebase onto latest ${baseBranch} before merging.`);
    process.exit(1);
  }

  console.log("✅ Stale-base predicate check passed.");
  process.exit(0);
} catch (err) {
  console.error(`❌ STALE BASE GATE FAIL: Could not resolve base branch "${baseBranch}": ${err.message}`);
  process.exit(1);
}
