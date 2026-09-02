import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
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

/**
 * Creates an OODA Thrash Cycle Breaker.
 * Tracks rolling SHA-256 fingerprints of diff hunks and failure states in repair loops.
 * Trips circuit breaker if an identical patch or failure ping-pong cycle is observed.
 *
 * @param {Object} [opts]
 * @param {number} [opts.maxHistory=10] - Maximum states to retain in ring buffer
 * @param {number} [opts.threshold=2] - Number of occurrences before tripping (default: 2 -> A -> B -> A)
 * @returns {{ recordAttempt: (state: { diff?: string, symptom?: string, targetFiles?: string[] }) => { thrash: boolean, cycleLength?: number, fingerprint: string, occurrences: number, reason?: string }, getHistory: () => string[], reset: () => void }}
 */
export function createThrashDetector(opts = {}) {
  const maxHistory = opts.maxHistory || 10;
  const threshold = opts.threshold || 2;
  const history = [];

  function computeStateFingerprint(state = {}) {
    const normDiff = (state.diff || "").trim();
    const normSymptom = (state.symptom || "").trim();
    const normFiles = (state.targetFiles || []).slice().sort().join(",");
    return createHash("sha256")
      .update(`${normDiff}:::${normSymptom}:::${normFiles}`)
      .digest("hex");
  }

  function recordAttempt(state = {}) {
    const fingerprint = computeStateFingerprint(state);
    history.push(fingerprint);
    if (history.length > maxHistory) {
      history.shift();
    }

    // Check for duplicate occurrences in history
    const occurrences = history.filter((h) => h === fingerprint).length;
    if (occurrences >= threshold) {
      const firstIdx = history.indexOf(fingerprint);
      const lastIdx = history.lastIndexOf(fingerprint);
      const cycleLength = lastIdx - firstIdx;

      return {
        thrash: true,
        cycleLength,
        fingerprint,
        occurrences,
        reason: `OODA Thrash Circuit Tripped: State fingerprint ${fingerprint.slice(0, 12)} repeated ${occurrences} times across repair loop (cycle length: ${cycleLength}).`,
      };
    }

    return {
      thrash: false,
      fingerprint,
      occurrences,
    };
  }

  return {
    recordAttempt,
    getHistory: () => [...history],
    reset: () => {
      history.length = 0;
    },
  };
}

/**
 * Creates a Whack-a-Mole Test-Oscillation Detector for OODA repair loops.
 * Detects when consecutive repair turns oscillate between different failing test sets
 * (e.g. fixing Test A causes Test B to break, then fixing Test B re-breaks Test A).
 *
 * @param {Object} [opts]
 * @param {number} [opts.maxHistory=8] - Maximum test state signatures to retain
 * @param {number} [opts.threshold=2] - Number of repeating occurrences before triggering
 * @returns {{ recordTestOutcome: (failingTests: string[] | string) => { whackAMole: boolean, cycleLength?: number, oscillatingTests?: string[], occurrences: number, promptDirective?: string, reason?: string }, getHistory: () => string[], reset: () => void }}
 */
export function createWhackAMoleDetector(opts = {}) {
  const maxHistory = opts.maxHistory || 8;
  const threshold = opts.threshold || 2;
  const history = []; // Array of signature strings
  const testSets = []; // Array of string[]

  function normalizeTestSet(input) {
    if (!input) return [];
    if (Array.isArray(input)) {
      return [...new Set(input.map((s) => String(s).trim()).filter(Boolean))].sort();
    }
    const str = String(input).trim();
    return str ? [str] : [];
  }

  function recordTestOutcome(failingInput) {
    const tests = normalizeTestSet(failingInput);
    const signature = tests.join("||") || "__ALL_PASS__";

    history.push(signature);
    testSets.push(tests);

    if (history.length > maxHistory) {
      history.shift();
      testSets.shift();
    }

    if (signature === "__ALL_PASS__") {
      return {
        whackAMole: false,
        occurrences: 0,
      };
    }

    const occurrences = history.filter((h) => h === signature).length;
    if (occurrences >= threshold) {
      const firstIdx = history.indexOf(signature);
      const lastIdx = history.lastIndexOf(signature);
      const cycleLength = lastIdx - firstIdx;

      // Extract all distinct failing tests observed in the cycle window
      const cycleTests = new Set();
      for (let i = firstIdx; i <= lastIdx; i++) {
        for (const t of testSets[i]) {
          cycleTests.add(t);
        }
      }
      const oscillatingTests = [...cycleTests];

      const testSummary = oscillatingTests.length > 0 ? oscillatingTests.join(" <-> ") : "tests";
      const promptDirective = `[WHACK_A_MOLE_WARNING] You are trapped in a local optimization cycle where fixing one test breaks another (${testSummary}). Do not add more conditional edge-case band-aids. Revert recent patches and refactor the core logic cleanly.`;

      return {
        whackAMole: true,
        cycleLength,
        oscillatingTests,
        occurrences,
        promptDirective,
        reason: `Whack-a-Mole Test Oscillation Detected: Test failure signature repeated across repair turns (${testSummary}).`,
      };
    }

    return {
      whackAMole: false,
      occurrences,
    };
  }

  return {
    recordTestOutcome,
    getHistory: () => [...history],
    reset: () => {
      history.length = 0;
      testSets.length = 0;
    },
  };
}



