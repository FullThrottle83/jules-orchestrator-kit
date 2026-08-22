import { spawnSync } from "node:child_process";
import { classifyRiskTier, RISK_TIERS } from "../risk.mjs";
import { checkSafetyGate } from "../../scripts/jules-merge-swarm.mjs";
import { normalizePath, loadConfig } from "../config.mjs";

/**
 * Checks if GitHub CLI statusCheckRollup indicates all CI checks are green/successful.
 *
 * An empty rollup is NOT passing. It means one of two things, and neither is
 * "verified": the repository has no CI at all — the common case for the repos
 * this kit is installed into — or the workflows are queued and have not
 * registered yet, so a harvest run seconds after the PR opens would merge ahead
 * of the checks it claims to be waiting for. Treating "no evidence" as "good
 * evidence" is the wrong default anywhere, and this value feeds the only
 * irreversible action the kit takes.
 *
 * Operators who genuinely have no CI and want the triage anyway pass
 * `--allow-no-checks`, which is a stated choice rather than a silent one.
 *
 * @param {Array<object>} checks
 * @returns {{ passing: boolean, pending: boolean, failing: boolean, noChecks: boolean, summary: string }}
 */
export function evaluateStatusCheckRollup(checks = []) {
  if (!Array.isArray(checks) || checks.length === 0) {
    return { passing: false, pending: false, failing: false, noChecks: true, summary: "NO_CHECKS" };
  }

  let failingCount = 0;
  let pendingCount = 0;
  let successCount = 0;

  for (const check of checks) {
    const status = String(check.status || check.state || "").toUpperCase();
    const conclusion = String(check.conclusion || "").toUpperCase();

    if (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED") {
      successCount++;
    } else if (
      conclusion === "FAILURE" ||
      conclusion === "TIMED_OUT" ||
      conclusion === "ACTION_REQUIRED" ||
      status === "FAILURE" ||
      status === "ERROR"
    ) {
      failingCount++;
    } else if (status === "IN_PROGRESS" || status === "QUEUED" || status === "PENDING" || !conclusion) {
      pendingCount++;
    }
  }

  const failing = failingCount > 0;
  const pending = pendingCount > 0;
  const passing = !failing && !pending;

  const summary = failing ? `FAILED (${failingCount})` : pending ? `PENDING (${pendingCount})` : `PASSING (${successCount})`;
  return { passing, pending, failing, noChecks: false, summary };
}

/**
 * Reads the changed-file list off a `gh pr list --json files` entry.
 *
 * The distinction between "this PR changes nothing" and "gh did not tell us
 * what it changes" is load-bearing: `classifyRiskTier([])` answers R0, which is
 * auto-merge eligible, so a missing or truncated `files` array used to
 * downgrade an unknown PR to the lowest risk tier. GitHub also caps the
 * per-PR file list, so a large PR can arrive complete-looking but partial.
 *
 * @param {object} pr
 * @param {number} [fileCap=100] - Page size at which the list is assumed truncated.
 * @returns {{ known: boolean, truncated: boolean, files: string[], diffLines: number }}
 */
export function readPrFiles(pr = {}, fileCap = 100) {
  if (!Array.isArray(pr.files)) {
    return { known: false, truncated: false, files: [], diffLines: 0 };
  }

  const files = pr.files.map((f) => normalizePath(typeof f === "string" ? f : f.path || ""))
    .filter(Boolean);

  // Only summed when the entries carry line counts; a PR whose files lack them
  // reports 0, and the caller must not read that as "a small diff".
  let diffLines = 0;
  let hasLineCounts = false;
  for (const f of pr.files) {
    if (f && typeof f === "object" && (Number.isFinite(f.additions) || Number.isFinite(f.deletions))) {
      hasLineCounts = true;
      diffLines += (Number(f.additions) || 0) + (Number(f.deletions) || 0);
    }
  }

  return {
    known: files.length > 0,
    truncated: pr.files.length >= fileCap,
    files,
    diffLines: hasLineCounts ? diffLines : 0,
    hasLineCounts,
  };
}

/**
 * Parses risk tier option string or array and maps shorthand names (R0, R1, R2, R3).
 * @param {string|string[]} tierOption
 * @returns {Set<string>}
 */
export function parseTierFilter(tierOption) {
  const mapShorthand = (t) => {
    const upper = String(t).toUpperCase().trim();
    if (upper === "R0" || upper === "R0_COSMETIC") return RISK_TIERS.R0;
    if (upper === "R1" || upper === "R1_ROUTINE") return RISK_TIERS.R1;
    if (upper === "R2" || upper === "R2_CONSEQUENTIAL") return RISK_TIERS.R2;
    if (upper === "R3" || upper === "R3_RESTRICTED") return RISK_TIERS.R3;
    return upper;
  };

  if (!tierOption) return new Set([RISK_TIERS.R0, RISK_TIERS.R1]);
  if (Array.isArray(tierOption)) return new Set(tierOption.map(mapShorthand));
  return new Set(
    String(tierOption)
      .split(",")
      .map(mapShorthand)
      .filter(Boolean)
  );
}

/**
 * Automated PR Harvester: Discovers open PRs, evaluates CI status, risk tiers, and safety locks,
 * and optionally merges/squashes green, low-risk changes autonomously.
 *
 * @param {string} root - Repository root path
 * @param {object} options
 * @returns {Promise<{ prs: Array<object>, harvested: Array<object>, summary: object }>}
 */
export async function harvestPullRequests(root = process.cwd(), options = {}) {
  const limit = options.limit || 50;
  const state = options.state || "open";
  const allowedTiers = parseTierFilter(options.tier);
  const isAuto = Boolean(options.auto || options.merge);
  const isDryRun = Boolean(options.dryRun);
  const allowNoChecks = Boolean(options.allowNoChecks);
  // Loaded once: the repository's own risk paths decide whether a PR is
  // auto-merge eligible, and re-reading the config per PR would be pure I/O.
  let riskConfig = options.config;
  if (!riskConfig) {
    try {
      riskConfig = loadConfig(root);
    } catch (_) {
      riskConfig = {};
    }
  }

  let rawPrs = [];
  if (typeof options.execGh === "function") {
    rawPrs = await options.execGh("pr", ["list", "--state", state, "--limit", String(limit), "--json", "number,title,headRefName,statusCheckRollup,mergeable,labels,files"]);
  } else {
    const res = spawnSync(
      "gh",
      [
        "pr",
        "list",
        "--state",
        state,
        "--limit",
        String(limit),
        "--json",
        "number,title,headRefName,statusCheckRollup,mergeable,labels,files",
      ],
      {
        cwd: root,
        encoding: "utf-8",
        timeout: 30000,
      }
    );

    if (res.error) {
      if (res.error.code === "ENOENT") {
        throw new Error("GitHub CLI (gh) not found in PATH. Install gh or use JULES_DRY_RUN=1.");
      }
      throw new Error(`Failed to list pull requests: ${res.error.message}`);
    }

    if (res.status !== 0) {
      throw new Error(`gh pr list failed (exit ${res.status}): ${(res.stderr || "").trim()}`);
    }

    try {
      rawPrs = JSON.parse(res.stdout || "[]");
    } catch (err) {
      throw new Error(`Invalid JSON output from gh pr list: ${err.message}`);
    }
  }

  const evaluatedPrs = [];
  const harvested = [];

  for (const pr of rawPrs) {
    const fileInfo = readPrFiles(pr);
    const files = fileInfo.files;
    // diffLines was never passed before, which left the 400-line R2 rule in
    // risk.mjs unreachable from the harvest path: a 5,000-line change to one
    // unremarkable file classified R1 and auto-merged.
    const risk = classifyRiskTier(files, { diffLines: fileInfo.diffLines, config: riskConfig });
    const checks = evaluateStatusCheckRollup(pr.statusCheckRollup || []);
    const gate = checkSafetyGate(pr.headRefName || "", root);
    const tierMatches = allowedTiers.has(risk.tier);
    // "UNKNOWN" means GitHub is still computing mergeability. Only "MERGEABLE"
    // is an answer; anything else is either a conflict or an absence of one.
    const isMergeable = String(pr.mergeable || "").toUpperCase() === "MERGEABLE";
    const checksUsable = checks.passing || (checks.noChecks && allowNoChecks);
    const filesUsable = fileInfo.known && !fileInfo.truncated;

    const eligible = checksUsable && filesUsable && gate.safe && tierMatches && isMergeable;
    let actionStatus = "SKIPPED";
    let actionReason = "";

    if (!filesUsable) {
      actionReason = fileInfo.truncated
        ? `Changed-file list truncated at ${files.length} entries — risk tier cannot be trusted`
        : "Changed-file list unavailable from gh — risk tier cannot be determined";
    } else if (!tierMatches) {
      actionReason = `Risk Tier ${risk.tier} excluded by filter (${Array.from(allowedTiers).join(",")})`;
    } else if (!checksUsable) {
      actionReason = checks.noChecks
        ? "No CI checks reported — pass --allow-no-checks to harvest unverified PRs"
        : `CI Checks not clean: ${checks.summary}`;
    } else if (!gate.safe) {
      actionReason = `Safety gate locked: ${gate.reason}`;
    } else if (!isMergeable) {
      actionReason = pr.mergeable ? `Not mergeable (${pr.mergeable})` : "Mergeability unknown";
    } else {
      actionStatus = "ELIGIBLE";
      actionReason = checks.noChecks ? "Ready for harvest (UNVERIFIED — no CI checks)" : "Ready for harvest";
    }

    let merged = false;
    let mergeError = null;

    if (eligible && isAuto && !isDryRun) {
      if (typeof options.mergeGh === "function") {
        const mergeRes = await options.mergeGh(pr.number);
        merged = mergeRes.ok;
        if (!merged) mergeError = mergeRes.error;
      } else {
        const mergeCmd = spawnSync("gh", ["pr", "merge", String(pr.number), "--squash", "--auto"], {
          cwd: root,
          encoding: "utf-8",
          timeout: 30000,
        });
        if (mergeCmd.status === 0) {
          merged = true;
          actionStatus = "MERGED";
          actionReason = "Auto-squashed and merged successfully";
        } else {
          mergeError = (mergeCmd.stderr || mergeCmd.stdout || "Merge failed").trim();
          actionStatus = "FAILED";
          actionReason = `Merge error: ${mergeError}`;
        }
      }

      if (merged) {
        harvested.push({
          number: pr.number,
          title: pr.title,
          headRefName: pr.headRefName,
          tier: risk.tier,
        });
      }
    }

    evaluatedPrs.push({
      number: pr.number,
      title: pr.title,
      branch: pr.headRefName,
      filesCount: files.length,
      riskTier: risk.tier,
      riskReason: risk.reason,
      diffLines: fileInfo.diffLines,
      ciStatus: checks.summary,
      ciPassing: checks.passing,
      // True when this PR was allowed through without any CI evidence. Kept on
      // the record so a report can distinguish "verified green" from "nobody
      // checked", which the ciStatus string alone no longer conveys.
      unverified: checks.noChecks && allowNoChecks,
      safetySafe: gate.safe,
      eligible,
      status: actionStatus,
      reason: actionReason,
      merged,
      mergeError,
    });
  }

  const summary = {
    total: evaluatedPrs.length,
    eligible: evaluatedPrs.filter((p) => p.eligible).length,
    merged: harvested.length,
    skipped: evaluatedPrs.filter((p) => !p.eligible).length,
    unverified: evaluatedPrs.filter((p) => p.unverified && p.eligible).length,
  };

  return {
    prs: evaluatedPrs,
    harvested,
    summary,
  };
}

/**
 * Formats PR harvest results into a human-readable CLI terminal table.
 * @param {object} harvestResult
 * @returns {string}
 */
export function formatHarvestTable(harvestResult) {
  const { prs, summary } = harvestResult;
  if (!prs || prs.length === 0) {
    return "No open pull requests found for harvest.";
  }

  const lines = [];
  lines.push("🌾 Pull Request Harvest & Triage Report");
  lines.push("═".repeat(80));
  lines.push(
    `${"PR #".padEnd(8)} | ${"Tier".padEnd(6)} | ${"CI Checks".padEnd(16)} | ${"Status".padEnd(10)} | ${"Title"}`
  );
  lines.push("-".repeat(80));

  for (const pr of prs) {
    const prNum = `#${pr.number}`.padEnd(8);
    const tier = pr.riskTier.padEnd(6);
    const ci = pr.ciStatus.slice(0, 16).padEnd(16);
    const status = pr.status.padEnd(10);
    const title = pr.title.length > 32 ? `${pr.title.slice(0, 29)}...` : pr.title;
    lines.push(`${prNum} | ${tier} | ${ci} | ${status} | ${title}`);
    if (pr.reason && pr.status !== "MERGED" && pr.status !== "ELIGIBLE") {
      lines.push(`         └─ Reason: ${pr.reason}`);
    }
  }

  lines.push("═".repeat(80));
  lines.push(
    `Summary: ${summary.total} total PRs · ${summary.eligible} eligible · ${summary.merged} merged · ${summary.skipped} skipped`
  );
  if (summary.unverified > 0) {
    lines.push(
      `⚠️  ${summary.unverified} of the eligible PRs carry no CI checks and were admitted by --allow-no-checks.`
    );
  }

  return lines.join("\n");
}
