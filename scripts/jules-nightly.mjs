#!/usr/bin/env node
/**
 * Framework-Agnostic Nightly Jules Maintenance & Audit Suite Runner (Node ESM)
 * Dispatches scheduled automated code health & maintenance tasks to Google Jules.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { log, logToHistory } from "./utils.mjs";

const execFileAsync = promisify(execFile);

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
  const modeLabel = dryRun ? "[DRY RUN]" : "[DISPATCHED]";
  const dateStr = new Date().toISOString().split("T")[0];
  let content = `---\ntype: nightly_jules_audit\ntimestamp: "${new Date().toISOString()}"\nstatus: "${modeLabel}"\n---\n# Nightly Jules Maintenance Suite Audit - ${dateStr}\n\nSummary of automated audit dispatches:\n\n`;

  for (const res of taskResults) {
    content += `- **${res.title}** (\`${res.id}\`): ${res.status}\n`;
  }

  const historyFile = logToHistory(`nightly-audit.md`, content, "nightly");
  log.success(`Logged nightly audit summary to: ${path.relative(process.cwd(), historyFile)}`);
}

async function dispatchTask(task, dryRun = false) {
  const title = task.title;
  const fullPrompt = task.prompt;

  log.step("🌙", `[${task.id}] Preparing task: '${title}'...`);

  if (dryRun) {
    log.dim(`   [DRY RUN] Would dispatch task '${title}' to target repository`);
    return { id: task.id, title, status: "Dry Run OK" };
  }

  const dispatchScript = path.resolve(process.cwd(), "scripts/jules-dispatch.mjs");
  if (fs.existsSync(dispatchScript)) {
    try {
      await execFileAsync("node", [dispatchScript, title, fullPrompt]);
      return { id: task.id, title, status: "Dispatched successfully" };
    } catch (error) {
      log.error(`Failed to dispatch via jules-dispatch.mjs: ${error.message}`);
      return { id: task.id, title, status: `Failed: ${error.message}` };
    }
  } else {
    log.error(`Dispatch script not found at ${dispatchScript}`);
    return { id: task.id, title, status: "Failed (Script missing)" };
  }
}

async function main() {
  log.header("Nightly Jules Maintenance & Audit Suite");

  if (isDryRun) {
    log.info("Running in DRY RUN mode. No tasks will be dispatched.");
  }

  const taskPromises = UNIVERSAL_NIGHTLY_TASKS.map((task) => dispatchTask(task, isDryRun));
  const settled = await Promise.allSettled(taskPromises);
  const results = settled.map((s, idx) =>
    s.status === "fulfilled" ? s.value : { id: UNIVERSAL_NIGHTLY_TASKS[idx].id, title: UNIVERSAL_NIGHTLY_TASKS[idx].title, status: `Failed: ${s.reason}` }
  );

  logNightlyHistory(results, isDryRun);
  const hasFailures = results.some((r) => r.status && (r.status.includes("Failed") || r.status.includes("error")));
  if (hasFailures) {
    log.error("Nightly Jules audit suite completed with task errors.");
    process.exitCode = 1;
  } else {
    log.success("Nightly Jules audit suite execution completed cleanly.");
  }
}

main().catch((err) => {
  log.error(`Unhandled error in nightly suite: ${err.message}`);
  process.exit(1);
});
