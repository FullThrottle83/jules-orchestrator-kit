#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectCommands } from "../scripts/command-resolver.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const kitRoot = path.resolve(__dirname, "..");
const targetDir = process.cwd();

console.log("\n🚀 Initializing Google Jules Orchestration Kit...\n");
console.log(`📁 Target Directory: ${targetDir}`);

// 1. Detect Stack & Manifests
const detected = resolveProjectCommands(targetDir);
console.log(`🔍 Detected Project Type: ${detected.source}`);
if (detected.testCmd || detected.buildCmd) {
  console.log(`   - Test Command:  ${detected.testCmd || "(none)"}`);
  console.log(`   - Build Command: ${detected.buildCmd || "(none)"}`);
}

// 2. Scaffold AGENTS.md / JULES.md
const agentsFile = path.join(targetDir, "AGENTS.md");
const julesRulesSource = path.join(kitRoot, "JULES_RULES_TEMPLATE.md");

if (!fs.existsSync(agentsFile)) {
  if (fs.existsSync(julesRulesSource)) {
    fs.copyFileSync(julesRulesSource, agentsFile);
    console.log("✅ Created: AGENTS.md (from JULES_RULES_TEMPLATE.md)");
  }
} else {
  console.log("ℹ️ AGENTS.md already exists (skipped overwrite).");
}

// 3. Scaffold .agent/ structure
const agentDir = path.join(targetDir, ".agent");
const rulesDir = path.join(agentDir, "rules");
const queueDir = path.join(agentDir, "jules-queue");
const completedQueueDir = path.join(queueDir, "completed");
const workflowsDir = path.join(agentDir, "workflows");

[agentDir, rulesDir, queueDir, completedQueueDir, workflowsDir].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// Scaffold .agent/jules.yml
const yamlConfigPath = path.join(agentDir, "jules.yml");
if (!fs.existsSync(yamlConfigPath)) {
  const yamlContent = `# Google Jules Repository Configuration\n\ntest_cmd: "${detected.testCmd || "npm test"}"\nbuild_cmd: "${detected.buildCmd || "npm run build"}"\n`;
  fs.writeFileSync(yamlConfigPath, yamlContent, "utf-8");
  console.log("✅ Created: .agent/jules.yml");
}

// Scaffold .agent/rules/dynamic-guardrails.json
const dgcSource = path.join(kitRoot, ".agent/rules/dynamic-guardrails.json");
const dgcTarget = path.join(rulesDir, "dynamic-guardrails.json");
if (!fs.existsSync(dgcTarget) && fs.existsSync(dgcSource)) {
  fs.copyFileSync(dgcSource, dgcTarget);
  console.log("✅ Created: .agent/rules/dynamic-guardrails.json");
}

// Scaffold .agent/workflows/jules-review.md
const reviewSource = path.join(kitRoot, ".agent/workflows/jules-review.md");
const reviewTarget = path.join(workflowsDir, "jules-review.md");
if (!fs.existsSync(reviewTarget) && fs.existsSync(reviewSource)) {
  fs.copyFileSync(reviewSource, reviewTarget);
  console.log("✅ Created: .agent/workflows/jules-review.md");
}

// 4. Copy scripts/ directory with existence guard
const targetScriptsDir = path.join(targetDir, "scripts");
if (!fs.existsSync(targetScriptsDir)) {
  fs.mkdirSync(targetScriptsDir, { recursive: true });
}

const sourceScriptsDir = path.join(kitRoot, "scripts");
if (fs.existsSync(sourceScriptsDir)) {
  const scriptFiles = fs.readdirSync(sourceScriptsDir);
  scriptFiles.forEach((file) => {
    const srcFile = path.join(sourceScriptsDir, file);
    const destFile = path.join(targetScriptsDir, file);
    fs.copyFileSync(srcFile, destFile);
    try {
      fs.chmodSync(destFile, 0o755);
    } catch (_) {}
  });
  console.log(`✅ Copied ${scriptFiles.length} orchestration scripts to ./scripts/`);
}

console.log("\n🎉 Google Jules Orchestration Kit successfully initialized!");
console.log("\nNext Steps:");
console.log("  1. Set environment variables: JULES_REPO=\"owner/repo\"");
console.log("  2. Dispatch your first task:  node scripts/jules-dispatch.mjs \"Task Title\" \"Task prompt\"");
console.log("  3. Run pre-merge PR audit:    node scripts/jules-self-audit.mjs\n");
