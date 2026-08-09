import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { getStateDir, ensureDir } from "./state.mjs";

/**
 * Calculates Wilson score interval for binomial proportion.
 */
export function wilsonScoreInterval(k, n, z = 1.96) {
  if (n === 0) return { lower: 0, upper: 0 };
  const p = k / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const stdErr = Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  const margin = (z * stdErr) / denominator;
  const lower = Math.max(0, center - margin);
  const upper = Math.min(1, center + margin);
  return { lower, upper };
}

/**
 * Computes oscillation rate (fraction of state transitions between consecutive runs).
 */
export function computeOscillation(runs) {
  if (!runs || runs.length <= 1) return 0;
  let transitions = 0;
  for (let i = 0; i < runs.length - 1; i++) {
    const current = typeof runs[i] === "boolean" ? runs[i] : Boolean(runs[i] && runs[i].pass);
    const next = typeof runs[i + 1] === "boolean" ? runs[i + 1] : Boolean(runs[i + 1] && runs[i + 1].pass);
    if (current !== next) {
      transitions++;
    }
  }
  return transitions / (runs.length - 1);
}

/**
 * Appends a test outcome record to .agent/state/flaky.jsonl.
 */
export function recordVerifyRun(root, testCmd, pass, fingerprint = null, durationMs = 0) {
  const stateDir = getStateDir(root);
  ensureDir(stateDir);
  const filePath = join(stateDir, "flaky.jsonl");

  const entry = {
    timestamp: new Date().toISOString(),
    testCmd: testCmd || "",
    pass: Boolean(pass),
    fingerprint: fingerprint || null,
    durationMs: Number(durationMs) || 0,
  };

  appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
  return entry;
}

/**
 * Reads test run records from .agent/state/flaky.jsonl.
 */
export function readVerifyRuns(root, testCmd = null) {
  const stateDir = getStateDir(root);
  const filePath = join(stateDir, "flaky.jsonl");

  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const runs = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (!testCmd || parsed.testCmd === testCmd) {
          runs.push(parsed);
        }
      } catch (_) {}
    }
    return runs;
  } catch (_) {
    return [];
  }
}

export const getVerifyRuns = readVerifyRuns;

/**
 * Evaluates flaky test verdict using a sliding window of the last n <= 10 runs.
 */
export function flakyVerdict(runs = []) {
  const normalized = (runs || []).map((r) => {
    if (typeof r === "boolean") return { pass: r };
    if (typeof r === "number") return { pass: r === 1 };
    return { pass: Boolean(r && r.pass) };
  });

  const window = normalized.slice(-10);
  const n = window.length;
  const fails = window.filter((r) => !r.pass).length;
  const passes = n - fails;

  if (n === 0) {
    return {
      verdict: "INSUFFICIENT_DATA",
      allowRepair: true,
      n: 0,
      fails: 0,
      passes: 0,
      oscillation: 0,
    };
  }

  if (fails === 0) {
    return {
      verdict: "HEALTHY",
      allowRepair: true,
      n,
      fails,
      passes,
      oscillation: computeOscillation(window),
    };
  }

  const trailing3Fail = n >= 3 && window.slice(-3).every((r) => !r.pass);
  if (fails === n || trailing3Fail) {
    return {
      verdict: "REPAIRABLE_REGRESSION",
      allowRepair: true,
      n,
      fails,
      passes,
      oscillation: computeOscillation(window),
    };
  }

  if (n < 6) {
    return {
      verdict: "INSUFFICIENT_DATA",
      allowRepair: true,
      n,
      fails,
      passes,
      oscillation: computeOscillation(window),
    };
  }

  const oscillation = computeOscillation(window);
  const wilson = wilsonScoreInterval(fails, n, 1.96);
  const interiorWilson = wilson.lower > 0 && wilson.upper < 1;

  if (oscillation >= 0.4 && interiorWilson) {
    return {
      verdict: "QUARANTINED",
      allowRepair: false,
      n,
      fails,
      passes,
      oscillation,
      wilson,
    };
  }

  return {
    verdict: "REPAIRABLE_REGRESSION",
    allowRepair: true,
    n,
    fails,
    passes,
    oscillation,
    wilson,
  };
}
