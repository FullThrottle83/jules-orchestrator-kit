#!/usr/bin/env node

/**
 * jules-merge-swarm.mjs
 * 
 * Autonomous PR Merge Engine for Disjoint Swarm Tasks.
 * Discovers open PRs created by Jules (branch prefix 'jules/'), verifies CI checks pass,
 * checks for disjoint file cluster modifications (no overlapping files), and squash-merges PRs.
 * 
 * Usage:
 *   node scripts/jules-merge-swarm.mjs [--dry-run] [--admin]
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log, loadEnv } from "./utils.mjs";

loadEnv();

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const useAdmin = args.includes("--admin");

function runGhCommand(cmdArgs, ignoreError = false) {
  try {
    const output = execFileSync("gh", cmdArgs, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["pipe", "pipe", ignoreError ? "ignore" : "pipe"],
    });
    return output.trim();
  } catch (err) {
    if (ignoreError) return "";
    throw err;
  }
}

async function main() {
  log.info("🔍 Scanning open GitHub PRs for Jules swarm branches...");

  let rawPrs = "";
  try {
    rawPrs = runGhCommand([
      "pr", "list",
      "--state", "open",
      "--json", "number,title,headRefName,url,isDraft,mergeable,files,statusCheckRollup"
    ]);
  } catch (err) {
    log.error("❌ Failed to query GitHub PRs using `gh` CLI. Ensure GitHub CLI is installed and authenticated (`gh auth status`).");
    log.error(err.message);
    process.exit(1);
  }

  let prs = [];
  try {
    prs = JSON.parse(rawPrs || "[]");
  } catch (err) {
    log.error("❌ Failed to parse GitHub PR list output.");
    process.exit(1);
  }

  // Filter PRs originating from Jules worker branches (e.g. jules/*)
  const julesPrs = prs.filter((p) => p.headRefName && p.headRefName.startsWith("jules/"));

  if (julesPrs.length === 0) {
    log.info("✨ No open Jules PRs found (branches matching 'jules/*'). Nothing to merge.");
    process.exit(0);
  }

  log.info(`Found ${julesPrs.length} open Jules PR(s). Evaluating merge eligibility...`);

  const mergeableCandidates = [];
  const blockedPrs = [];

  for (const pr of julesPrs) {
    if (pr.isDraft) {
      blockedPrs.push({ pr, reason: "Draft PR" });
      continue;
    }

    if (pr.mergeable === "CONFLICTING") {
      blockedPrs.push({ pr, reason: "Git Merge Conflict" });
      continue;
    }

    // Check status check rollup if present
    const checkRollup = pr.statusCheckRollup || [];
    const states = checkRollup.map((c) => c.state || c.status || c.conclusion).filter(Boolean);
    const hasFailures = states.some((s) => ["FAILURE", "FAILED", "CANCELLED", "TIMED_OUT"].includes(String(s).toUpperCase()));
    const isPending = states.some((s) => ["PENDING", "QUEUED", "IN_PROGRESS"].includes(String(s).toUpperCase()));

    if (hasFailures) {
      blockedPrs.push({ pr, reason: "CI Check Failure" });
      continue;
    }

    if (isPending) {
      blockedPrs.push({ pr, reason: "CI Checks Pending" });
      continue;
    }

    const modifiedFiles = (pr.files || []).map((f) => f.path || f);
    mergeableCandidates.push({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      branch: pr.headRefName,
      files: modifiedFiles,
    });
  }

  log.info(`\n📊 Candidate Summary:`);
  log.info(`  - Total Open Jules PRs: ${julesPrs.length}`);
  log.info(`  - Blocked / Pending:    ${blockedPrs.length}`);
  log.info(`  - Eligible Candidates:  ${mergeableCandidates.length}\n`);

  if (blockedPrs.length > 0) {
    log.dim("Blocked / Pending PRs:");
    for (const b of blockedPrs) {
      log.dim(`  - #${b.pr.number}: ${b.pr.title} (${b.reason})`);
    }
  }

  if (mergeableCandidates.length === 0) {
    log.info("No PRs ready for automated merging at this time.");
    process.exit(0);
  }

  // Disjoint Cluster File Conflict Check across candidates
  log.info("🛡️ Checking for disjoint file cluster conflicts among candidates...");
  const mergedFileSet = new Set();
  const safeToMerge = [];
  const overlapDeferred = [];

  for (const cand of mergeableCandidates) {
    const overlapping = cand.files.filter((f) => mergedFileSet.has(f));
    if (overlapping.length > 0) {
      overlapDeferred.push({ candidate: cand, overlapping });
    } else {
      for (const f of cand.files) {
        mergedFileSet.add(f);
      }
      safeToMerge.push(cand);
    }
  }

  if (overlapDeferred.length > 0) {
    log.warn(`⚠️ Deferred ${overlapDeferred.length} PR(s) due to file overlaps with earlier candidates in the batch.`);
    for (const d of overlapDeferred) {
      log.dim(`  - #${d.candidate.number}: overlaps on ${d.overlapping.join(", ")}`);
    }
  }

  log.success(`🚀 Ready to squash-merge ${safeToMerge.length} disjoint Jules PR(s)!`);

  for (const pr of safeToMerge) {
    log.step("🔀", `[#${pr.number}] Merging: ${pr.title}`);

    if (isDryRun) {
      log.dim(`  [DRY RUN] Would run: gh pr merge ${pr.number} --squash --delete-branch ${useAdmin ? "--admin" : ""}`);
      continue;
    }

    try {
      const mergeArgs = ["pr", "merge", String(pr.number), "--squash", "--delete-branch"];
      if (useAdmin) mergeArgs.push("--admin");

      runGhCommand(mergeArgs);
      log.success(`  ✅ PR #${pr.number} successfully merged & branch deleted.`);
    } catch (err) {
      log.error(`  ❌ Failed to merge PR #${pr.number}: ${err.message}`);
    }
  }

  if (isDryRun) {
    log.info("\nDry run completed. Run without `--dry-run` to execute merges.");
  } else {
    log.success("\n🎉 Jules Swarm PR Merge Engine execution completed!");
  }
}

main().catch((err) => {
  log.error(`Fatal error in jules-merge-swarm: ${err.message}`);
  process.exit(1);
});
