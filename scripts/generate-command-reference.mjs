#!/usr/bin/env node

/**
 * Regenerate docs/COMMAND_REFERENCE.md from the command registry.
 *
 * The registry (src/ops/command-registry.mjs) is the single source of truth
 * for command flags, usage and examples; this script renders it to Markdown
 * so the checked-in reference cannot drift from `agentctl --help` output.
 * The doc-sync gate (scripts/doc-sync-check.mjs) diffs the rendered output
 * against the file on disk and fails on any difference.
 *
 * Usage:
 *   node scripts/generate-command-reference.mjs          # write the file
 *   node scripts/generate-command-reference.mjs --check  # exit 1 if stale
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatRegistryMarkdown } from "../src/ops/command-registry.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(ROOT, "docs", "COMMAND_REFERENCE.md");

const rendered = formatRegistryMarkdown().replace(/\s+$/, "") + "\n";

if (process.argv.includes("--check")) {
  const onDisk = existsSync(TARGET) ? readFileSync(TARGET, "utf-8").replace(/\r\n/g, "\n") : null;
  const expected = rendered.replace(/\r\n/g, "\n");
  if (onDisk === expected) {
    console.log("✅ docs/COMMAND_REFERENCE.md is in sync with the command registry.");
    process.exit(0);
  }
  console.error("❌ docs/COMMAND_REFERENCE.md is stale — run: node scripts/generate-command-reference.mjs");
  process.exit(1);
}

writeFileSync(TARGET, rendered);
console.log(`✅ Wrote ${TARGET}`);
