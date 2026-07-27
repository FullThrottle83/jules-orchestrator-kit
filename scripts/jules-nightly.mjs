#!/usr/bin/env node
/**
 * Framework-Agnostic Nightly Jules Maintenance & Audit Suite Runner (Node ESM)
 * Dispatches scheduled automated code health & maintenance tasks to Google Jules.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const isDryRun = process.argv.includes("--dry-run");

const UNIVERSAL_NIGHTLY_TASKS = [
  {
    id: "sec-review",
    title: "Nightly Security & Secret Leaks Audit",
    prompt:
      "Perform a security review of the repository. " +
      "Scan for hardcoded API keys, exposed secrets, unmasked PII in logs, " +
      "and unvalidated input parameters in public endpoints. " +
      "Safety rule: Never commit untracked files or secrets to git."
  },
  {
    id: "a11y-audit",
    title: "Nightly Accessibility & ARIA Audit",
    prompt:
      "Audit UI components for WCAG 2.2 AA accessibility standards. " +
      "Verify that form inputs have labels, interactive elements support keyboard focus, " +
      "and all images have descriptive alt text."
  },
  {
    id: "dead-code-prune",
    title: "Nightly Dead Code & Unused Exports Audit",
    prompt:
      "Audit the codebase for unused exports, dead files, and obsolete types. " +
      "Prune unused local utility functions and unreferenced internal types. " +
      "SAFETY INVARIANTS: " +
      "1. DO NOT remove package dependencies from package.json, Cargo.toml, or requirements.txt (hygiene sweeps may ADD dependencies, never REMOVE). " +
      "2. DO NOT delete or commit untracked WIP files created by developers. " +
      "3. Verify that test and build suites pass 100% cleanly before submitting PR."
  },
  {
    id: "zombie-env-audit",
    title: "Nightly Unused Environment Variable Audit",
    prompt:
      "Scan configuration files and environment variable declarations against codebase usage. " +
      "Identify unused or zombie environment variables that are declared but never referenced in source code. " +
      "Document findings and remove obsolete declarations."
  }
];

function logNightlyHistory(taskResults, dryRun = false) {
  const dateStr = new Date().toISOString().split("T")[0];
  const historyDir = path.resolve(process.cwd(), ".agent/history");
  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true });
  }
  const historyFile = path.join(historyDir, `${dateStr}-nightly-audit.md`);

  const modeLabel = dryRun ? "[DRY RUN]" : "[DISPATCHED]";
  let content = `---\ntype: nightly_jules_audit\ntimestamp: "${new Date().toISOString()}"\nstatus: "${modeLabel}"\n---\n# Nightly Jules Maintenance Suite Audit - ${dateStr}\n\nSummary of automated audit dispatches:\n\n`;

  for (const res of taskResults) {
    content += `- **${res.title}** (\`${res.id}\`): ${res.status}\n`;
  }

  fs.writeFileSync(historyFile, content, "utf-8");
  console.log(`📝 Logged nightly audit summary to: ${path.relative(process.cwd(), historyFile)}`);
}

function dispatchTask(task, dryRun = false) {
  const title = task.title;
  const fullPrompt = task.prompt;

  console.log(`\n🌙 [${task.id}] Preparing task: '${title}'...`);

  if (dryRun) {
    console.log(`   [DRY RUN] Would dispatch task '${title}' to target repository`);
    return { id: task.id, title, status: "Dry Run OK" };
  }

  const dispatchScript = path.resolve(process.cwd(), "scripts/jules-dispatch.mjs");
  if (fs.existsSync(dispatchScript)) {
    try {
      execFileSync("node", [dispatchScript, title, fullPrompt], { stdio: "inherit" });
      return { id: task.id, title, status: "Dispatched successfully" };
    } catch (error) {
      console.error(`❌ Failed to dispatch via jules-dispatch.mjs: ${error.message}`);
      return { id: task.id, title, status: `Failed: ${error.message}` };
    }
  } else {
    console.error(`❌ Dispatch script not found at ${dispatchScript}`);
    return { id: task.id, title, status: "Failed (Script missing)" };
  }
}

function main() {
  console.log("==================================================");
  console.log("🌙 Nightly Jules Maintenance & Audit Suite");
  console.log("==================================================");

  if (isDryRun) {
    console.log("🔍 Running in DRY RUN mode. No tasks will be dispatched.");
  }

  const results = [];
  for (const task of UNIVERSAL_NIGHTLY_TASKS) {
    const res = dispatchTask(task, isDryRun);
    results.push(res);
  }

  logNightlyHistory(results, isDryRun);
  console.log("\n✅ Nightly Jules audit suite execution completed cleanly.");
}

main();
