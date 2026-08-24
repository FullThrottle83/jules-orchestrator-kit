#!/usr/bin/env node

import { checkRulesBudget } from "../src/rules-budget.mjs";

const root = process.cwd();
const res = checkRulesBudget(root);

console.log("[rules-lint] Auditing character and line budgets for agent rule files...");

if (!res.ok) {
  console.error("❌ RULES BUDGET VIOLATIONS DETECTED:");
  for (const v of res.violations) {
    console.error(`  - ${v.path}: ${v.reason}`);
  }
  console.error("\nRemediation: Trim prose rules or convert textual learnings into AST lints / Vitest assertions.");
  process.exit(1);
}

console.log("✅ All agent rule files are within safe character (<10,000) and line (<250) budget limits.");
process.exit(0);
