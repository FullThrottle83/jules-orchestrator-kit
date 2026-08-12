import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getStateDir, ensureDir } from "./state.mjs";
import { redactSecrets } from "./security.mjs";

/**
 * Appends a structured remediation pattern entry to .agent/state/remediations.jsonl
 * when an OODA repair loop successfully resolves a failure.
 *
 * @param {string} root - Project root directory
 * @param {Object} entry - Remediation payload
 * @param {string} [entry.fingerprint] - SHA-256 failure fingerprint from fingerprintFailureState()
 * @param {Array<string>} [entry.targetFiles] - Array of affected file paths
 * @param {string} [entry.symptom] - Error output or failure description
 * @param {string} [entry.remediationHint] - Actionable fix description or diff summary
 * @returns {Object} Saved remediation entry
 */
export function recordRemediation(root, entry = {}) {
  const stateDir = getStateDir(root);
  ensureDir(stateDir);
  const filePath = join(stateDir, "remediations.jsonl");

  const targetFiles = Array.isArray(entry.targetFiles)
    ? entry.targetFiles.map((f) => String(f).replace(/\\/g, "/"))
    : entry.targetFile
    ? [String(entry.targetFile).replace(/\\/g, "/")]
    : [];

  const record = {
    id: entry.id || `rem-${Date.now()}-${randomUUID().substring(0, 8)}`,
    timestamp: new Date().toISOString(),
    fingerprint: String(entry.fingerprint || "").trim(),
    targetFiles,
    symptom: redactSecrets(String(entry.symptom || "").trim()),
    remediationHint: redactSecrets(String(entry.remediationHint || "").trim()),
  };

  appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8");
  return record;
}

/**
 * Reads and queries remediation records from .agent/state/remediations.jsonl.
 * Matches by targetFiles (path token overlap) or failure fingerprint.
 *
 * @param {string} root - Project root directory
 * @param {Object} [query] - Query parameters
 * @param {Array<string>} [query.targetFiles] - Files to match against remediations
 * @param {string} [query.fingerprint] - Fingerprint to match against remediations
 * @param {number} [query.limit=5] - Maximum number of matching remediations to return
 * @returns {Array<Object>} List of matching remediation records
 */
export function queryRemediations(root, query = {}) {
  const stateDir = getStateDir(root);
  const filePath = join(stateDir, "remediations.jsonl");

  if (!existsSync(filePath)) {
    return [];
  }

  const targetFiles = (query.targetFiles || []).map((f) => String(f).replace(/\\/g, "/").toLowerCase());
  const fingerprint = String(query.fingerprint || "").trim();
  const limit = Math.max(1, Number(query.limit) || 5);

  try {
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const matches = [];

    for (let i = lines.length - 1; i >= 0; i--) {
      if (matches.length >= limit) break;
      try {
        const record = JSON.parse(lines[i]);
        if (!record || typeof record !== "object") continue;

        let isMatch = false;

        // Exact fingerprint match
        if (fingerprint && record.fingerprint === fingerprint) {
          isMatch = true;
        }

        // File path match
        if (!isMatch && targetFiles.length > 0 && Array.isArray(record.targetFiles)) {
          const recordFiles = record.targetFiles.map((f) => String(f).toLowerCase());
          for (const tf of targetFiles) {
            if (recordFiles.some((rf) => rf === tf || rf.endsWith(tf) || tf.endsWith(rf))) {
              isMatch = true;
              break;
            }
          }
        }

        // If no filter query was specified, match all records
        if (!fingerprint && targetFiles.length === 0) {
          isMatch = true;
        }

        if (isMatch) {
          matches.push(record);
        }
      } catch (_) {}
    }

    return matches;
  } catch (_) {
    return [];
  }
}

/**
 * Harvests a failure state or OODA repair outcome into remediations.jsonl.
 *
 * @param {string} root - Project root directory
 * @param {Object} details - Failure details
 * @param {string} [details.symptom] - Error message or failure trace
 * @param {string} [details.remediationHint] - Fix description or diff snippet
 * @param {Array<string>} [details.targetFiles] - Affected target files
 * @param {string} [details.fingerprint] - Optional fingerprint
 * @returns {Object|null} Harvested remediation record
 */
export function harvestFailureRecord(root, details = {}) {
  if (!details || (!details.symptom && !details.remediationHint)) {
    return null;
  }
  return recordRemediation(root, {
    symptom: details.symptom || details.error || "OODA Failure Detected",
    remediationHint: details.remediationHint || details.solution || details.diff || "Verify contract and run test suite.",
    targetFiles: details.targetFiles || details.referencedPaths || [],
    fingerprint: details.fingerprint || "",
  });
}

/**
 * Queries relevant past failure remediations and returns a formatted prompt block
 * for memory hydration.
 *
 * @param {string} root - Project root directory
 * @param {Object} [options]
 * @param {Array<string>} [options.targetFiles=[]] - Files associated with current task
 * @param {string} [options.fingerprint=""] - Failure fingerprint
 * @param {number} [options.limit=3] - Maximum memory records to hydrate
 * @returns {string} Formatted [LEARNED_REMEDIATIONS_CONTEXT] section string (or empty string if none match)
 */
export function hydrateMemory(root, options = {}) {
  const matches = queryRemediations(root, {
    targetFiles: options.targetFiles || [],
    fingerprint: options.fingerprint || "",
    limit: options.limit || 3,
  });

  if (!matches || matches.length === 0) {
    return "";
  }

  const items = matches.map((m, idx) => {
    const filesStr = Array.isArray(m.targetFiles) && m.targetFiles.length > 0 ? ` (Files: ${m.targetFiles.join(", ")})` : "";
    return `${idx + 1}. [Symptom${filesStr}]: ${m.symptom}\n   [Proven Fix]: ${m.remediationHint}`;
  });

  return `[LEARNED_REMEDIATIONS_CONTEXT]\nThe following historical failure-and-fix patterns were harvested from previous OODA runs in this repository. Avoid repeating these failure modes:\n\n${items.join("\n\n")}`;
}

