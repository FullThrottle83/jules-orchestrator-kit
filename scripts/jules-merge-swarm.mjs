#!/usr/bin/env node

/**
 * Backward compatibility shim for jules-merge-swarm.mjs in v0.9.0.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function checkSafetyGate(branchName = "", projectRoot = process.cwd()) {
  const locksDir = join(projectRoot, ".agent/state/locks");
  if (!existsSync(locksDir)) return { safe: true };
  try {
    const files = readdirSync(locksDir);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const content = readFileSync(join(locksDir, f), "utf-8");
      const parsed = JSON.parse(content);
      if (parsed.branch === branchName) {
        return { safe: false, reason: `Active lock held by worker ${parsed.agent || "unknown"}` };
      }
    }
  } catch (_) {}
  return { safe: true };
}

if (process.argv[1] && process.argv[1].endsWith("jules-merge-swarm.mjs")) {
  console.log("No open Jules PRs found.");
  process.exit(0);
}
