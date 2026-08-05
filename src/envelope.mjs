import { git, resolveBase } from "./git.mjs";
import { checkScope } from "./security.mjs";
import { normalizeScope } from "./config.mjs";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Validates a Task Envelope before dispatch or during CI triage.
 * Prevents execution on fabricated premises (missing files/tests) or stale bases.
 *
 * @param {Object} envelope - Task envelope payload
 * @param {Object} [opts] - Options (root, maxBehindCommits, maxBaseAgeHours)
 * @returns {{ ok: boolean, code?: number, errors: string[], warnings: string[] }}
 */
export function validateEnvelope(envelope = {}, opts = {}) {
  const root = opts.root || process.cwd();
  const maxBehind = opts.maxBehindCommits ?? 25;
  const maxAgeHours = opts.maxBaseAgeHours ?? 24;
  const errors = [];
  const warnings = [];

  if (!envelope || typeof envelope !== "object") {
    return { ok: false, code: 1, errors: ["Envelope must be a non-null object"], warnings: [] };
  }

  // 1. Mandatory Fields
  if (!envelope.intent || typeof envelope.intent !== "string" || !envelope.intent.trim()) {
    errors.push("Envelope missing required 'intent' string.");
  }

  // 2. Base Commit & Freshness Check
  const baseCommit = envelope.base_commit || "main";
  let resolvedBase = null;
  try {
    resolvedBase = resolveBase(root, baseCommit);
  } catch (_) {
    try {
      resolvedBase = resolveBase(root, "HEAD");
    } catch (_) {
      resolvedBase = null;
    }
  }

  if (resolvedBase) {
    try {
      const behindStr = git(["rev-list", "--count", `${resolvedBase}..origin/main`], { cwd: root, ignoreError: true });
      const behindCount = parseInt(behindStr || "0", 10);
      if (!isNaN(behindCount) && behindCount > maxBehind) {
        errors.push(`Stale base commit: base is ${behindCount} commits behind origin/main (max allowed: ${maxBehind}).`);
      }

      const commitTimeStr = git(["show", "-s", "--format=%ct", resolvedBase], { cwd: root, ignoreError: true });
      const commitTimestamp = parseInt(commitTimeStr || "0", 10);
      if (commitTimestamp > 0) {
        const nowSec = Math.floor(Date.now() / 1000);
        const ageHours = (nowSec - commitTimestamp) / 3600;
        if (ageHours > maxAgeHours) {
          warnings.push(`Base commit is ${Math.round(ageHours)}h old (exceeds recommended ${maxAgeHours}h).`);
        }
      }
    } catch (_) {
      // Git commit range checks are non-blocking if origin/main is not fetched locally
    }
  }

  // 3. Premise Check: Referenced Paths Must Exist
  if (Array.isArray(envelope.referenced_paths)) {
    for (const relPath of envelope.referenced_paths) {
      if (typeof relPath !== "string") continue;
      const absPath = join(root, relPath);
      let existsInGit = false;
      if (resolvedBase) {
        const catRes = git(["cat-file", "-e", `${resolvedBase}:${relPath}`], { cwd: root, ignoreError: true });
        existsInGit = typeof catRes === "string" && catRes.trim() !== "";
      }
      const existsOnDisk = existsSync(absPath);
      if (!existsInGit && !existsOnDisk) {
        errors.push(`Premise failure: referenced path '${relPath}' does not exist at base '${baseCommit}' or on disk.`);
      }
    }
  }

  // 4. Allowed Paths & Protected Scope Check
  if (Array.isArray(envelope.allowed_paths) && envelope.allowed_paths.length > 0) {
    const scope = normalizeScope(opts.scopeConfig || {});
    const scopeCheck = checkScope(envelope.allowed_paths, scope);
    if (!scopeCheck.ok) {
      errors.push(`Allowed paths violate protected scope: ${scopeCheck.violations.map(v => `${v.file} (${v.reason})`).join(", ")}`);
    }
  }

  // 5. Acceptance Criteria
  if (envelope.acceptance_criteria !== undefined) {
    if (!Array.isArray(envelope.acceptance_criteria) || envelope.acceptance_criteria.length === 0) {
      errors.push("acceptance_criteria must be a non-empty array of strings when provided.");
    }
  }

  return {
    ok: errors.length === 0,
    code: errors.length === 0 ? 0 : 1,
    errors,
    warnings,
  };
}
