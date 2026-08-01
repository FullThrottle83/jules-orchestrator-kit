#!/usr/bin/env node
/**
 * Jules Session Cleanup & PR Audit Utility
 * Cross-references active/completed Jules REST API sessions with GitHub PR merge status
 * to report and safely close merged or stale sessions.
 * Zero runtime dependencies.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log, loadEnv } from "./utils.mjs";

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  loadEnv();
}

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run") || process.env.JULES_DRY_RUN === "true" || process.env.JULES_DRY_RUN === "1";
const isCompact = args.includes("--compact");
const isMarkdown = args.includes("--markdown");
const shouldCloseMerged = args.includes("--close-merged");

let staleHours = 24;
const staleIdx = args.indexOf("--stale-hours");
if (staleIdx !== -1 && args[staleIdx + 1]) {
  const parsed = parseFloat(args[staleIdx + 1]);
  if (!isNaN(parsed) && parsed > 0) staleHours = parsed;
}

const apiKey = process.env.JULES_API_KEY || process.env.GEMINI_API_KEY || "";
const apiUrl = process.env.JULES_API_URL || "https://jules.googleapis.com/v1alpha/sessions";

export function checkGitHubPrMerged(prUrl) {
  if (!prUrl || typeof prUrl !== "string") return false;
  try {
    const output = execFileSync("gh", ["pr", "view", prUrl, "--json", "state,mergedAt"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const parsed = JSON.parse(output);
    return parsed.state === "MERGED" || Boolean(parsed.mergedAt);
  } catch (_) {
    return false;
  }
}

export function extractPrUrls(outputs = []) {
  const urls = [];
  if (!Array.isArray(outputs)) return urls;
  for (const item of outputs) {
    const text = typeof item === "string" ? item : JSON.stringify(item);
    const matches = text.match(/https:\/\/github\.com\/[^\/]+\/[^\/]+\/pull\/\d+/g);
    if (matches) {
      for (const m of matches) {
        if (!urls.includes(m)) urls.push(m);
      }
    }
  }
  return urls;
}

export async function fetchJulesSessions(apiKeyOverride = apiKey) {
  if (!apiKeyOverride) return [];
  try {
    const res = await fetch(apiUrl, {
      method: "GET",
      headers: {
        "X-Goog-Api-Key": apiKeyOverride,
        "Content-Type": "application/json"
      }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.sessions || data.items || [];
  } catch (_) {
    return [];
  }
}

export function auditSessions(sessions, options = {}) {
  const { staleHoursThreshold = 24 } = options;
  const now = Date.now();

  const merged = [];
  const active = [];
  const stale = [];

  for (const session of sessions) {
    const sId = session.name || session.id || "unknown";
    const title = session.title || "Untitled Session";
    const state = session.state || "UNKNOWN";
    const updatedAt = session.updateTime ? new Date(session.updateTime).getTime() : now;
    const hoursInactive = (now - updatedAt) / (1000 * 60 * 60);

    const prUrls = extractPrUrls(session.outputs || session.outputUrls || []);
    let isPrMerged = false;
    if (prUrls.length > 0) {
      isPrMerged = prUrls.every((url) => checkGitHubPrMerged(url));
    }

    const item = { id: sId, title, state, hoursInactive: Math.round(hoursInactive * 10) / 10, prUrls };

    if (isPrMerged) {
      merged.push(item);
    } else if (hoursInactive >= staleHoursThreshold && state !== "COMPLETED") {
      stale.push(item);
    } else {
      active.push(item);
    }
  }

  return { merged, active, stale };
}

export async function runCleanup() {
  if (!apiKey) {
    log.info("JULES_API_KEY is not set. Skipping Jules REST API cleanup audit.");
    return;
  }

  log.header("Jules Session Audit & Cleanup");
  log.info(`Fetching active sessions from Jules REST API...`);

  const sessions = await fetchJulesSessions(apiKey);
  if (sessions.length === 0) {
    log.info("No active or past sessions found on Jules REST API.");
    return;
  }

  const { merged, active, stale } = auditSessions(sessions, { staleHoursThreshold: staleHours });

  if (isCompact) {
    console.log(`Total: ${sessions.length} | Merged Candidates: ${merged.length} | Active: ${active.length} | Stale (> ${staleHours}h): ${stale.length}`);
    return;
  }

  if (isMarkdown) {
    console.log(`\n### Jules Session Audit Summary\n`);
    console.log(`| Category | Count |`);
    console.log(`|---|---|`);
    console.log(`| **Merged Candidates** | ${merged.length} |`);
    console.log(`| **Active / In-Progress** | ${active.length} |`);
    console.log(`| **Stale (> ${staleHours}h)** | ${stale.length} |`);
    if (merged.length > 0) {
      console.log(`\n#### Merged Sessions Ready for Cleanup\n`);
      for (const m of merged) {
        console.log(`- **${m.id}** (${m.title}) — PR: ${m.prUrls.join(", ") || "N/A"}`);
      }
    }
    return;
  }

  log.info(`Found ${sessions.length} total session(s).`);
  log.success(`Merged Cleanup Candidates: ${merged.length}`);
  log.step("ℹ️", `Active Sessions: ${active.length}`);
  if (stale.length > 0) {
    log.warn(`Stale Sessions (> ${staleHours}h inactive): ${stale.length}`);
  }

  if (merged.length > 0) {
    console.table(merged.map((m) => ({ ID: m.id, Title: m.title, State: m.state, InactiveHours: m.hoursInactive })));

    if (shouldCloseMerged && !isDryRun) {
      for (const m of merged) {
        log.step("🧹", `Deleting merged session: ${m.id}...`);
        try {
          const deleteUrl = `${apiUrl}/${m.id}`;
          await fetch(deleteUrl, { method: "DELETE", headers: { "X-Goog-Api-Key": apiKey } });
          log.success(`Deleted session ${m.id}`);
        } catch (err) {
          log.warn(`Failed to delete session ${m.id}: ${err.message}`);
        }
      }
    } else if (isDryRun) {
      log.dim(`[DRY RUN] Would delete ${merged.length} merged session(s). Use --close-merged to execute deletion.`);
    } else {
      log.info(`Run with \`--close-merged\` to delete the ${merged.length} merged session(s).`);
    }
  }
}

if (isMainModule) {
  runCleanup().catch((err) => {
    log.error(`Cleanup audit failed: ${err.message}`);
    process.exit(1);
  });
}
