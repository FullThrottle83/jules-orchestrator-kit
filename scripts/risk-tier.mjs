#!/usr/bin/env node

import { changedFiles } from "../src/git.mjs";
import { classifyRiskTier } from "../src/risk.mjs";

const root = process.cwd();
const baseBranch = process.env.BASE_BRANCH || "main";

try {
  const files = changedFiles(root, baseBranch);
  const result = classifyRiskTier(files);

  console.log(`[risk-tier] Classified PR Risk Tier: ${result.tier}`);
  console.log(`[risk-tier] Reason: ${result.reason}`);
  console.log(`[risk-tier] Auto-Merge Allowed: ${result.isAutoMergeAllowed}`);
  console.log(`[risk-tier] Requires Human Review: ${result.requiresHumanReview}`);

  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_OUTPUT, `risk_tier=${result.tier}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `auto_merge=${result.isAutoMergeAllowed}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `requires_human=${result.requiresHumanReview}\n`);
  }

  process.exit(0);
} catch (err) {
  console.error(`❌ Risk tier classification failed: ${err.message}`);
  process.exit(1);
}
