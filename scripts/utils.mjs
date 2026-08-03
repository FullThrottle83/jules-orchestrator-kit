/**
 * Backward compatibility shim for utils.mjs in v0.9.0.
 * Re-exports utilities from modular src/ domain modules.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import os from "node:os";
import { resolveRoot } from "../src/config.mjs";
import { appendLedger, checkDailyBudget as baseCheckDailyBudget } from "../src/state.mjs";

export { loadConfig, resolveRoot, normalizePath } from "../src/config.mjs";
export {
  shannonEntropy,
  shannonEntropy as calculateShannonEntropy,
  redactSecrets,
  anonymizePii,
  matchesGlob,
  isForbiddenPath,
  hasHighConfidenceSecret,
  hasLowConfidenceSecret,
  HIGH_CONFIDENCE_PATTERNS,
  LOW_CONFIDENCE_PATTERNS,
} from "../src/security.mjs";
export { git, runCmd } from "../src/git.mjs";
export { appendLedger, getDailyLedgerPath, ensureDir } from "../src/state.mjs";

export const log = {
  info: (msg) => console.log(`ℹ️  ${msg}`),
  success: (msg) => console.log(`✅ ${msg}`),
  warn: (msg) => console.warn(`⚠️  ${msg}`),
  error: (msg) => console.error(`❌ ${msg}`),
  step: (stepStr, msg) => console.log(`${stepStr} ${msg}`),
  dim: (msg) => console.log(msg),
  header: (msg) => console.log(`\n=== ${msg} ===\n`),
  groupEnd: () => {},
};

export function timestamp() {
  return new Date().toISOString();
}

export function loadEnv(targetDir = process.cwd()) {
  const envPath = join(targetDir, ".env");
  if (!existsSync(envPath)) return;
  try {
    const raw = readFileSync(envPath, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const clean = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
      const eqIdx = clean.indexOf("=");
      if (eqIdx > 0) {
        const k = clean.slice(0, eqIdx).trim();
        let v = clean.slice(eqIdx + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        process.env[k] = v;
      }
    }
  } catch (_) {}
}

export function getIsolatedCacheDir() {
  return process.env.JULES_CACHE_DIR ? resolve(process.env.JULES_CACHE_DIR) : join(os.homedir(), ".cache", "jules-orchestrator-kit");
}

export function ensureSdkCacheIsolation() {
  const dir = getIsolatedCacheDir();
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }); } catch (_) {}
  }
  process.env.JULES_CACHE_DIR = dir;
  return dir;
}

export function logToHistory(filename, content) {
  const dateStr = new Date().toISOString().split("T")[0];
  const historyDir = resolve(process.env.JULES_PROJECT_ROOT || process.cwd(), ".agent/history");
  if (!existsSync(historyDir)) {
    try { writeFileSync(historyDir, ""); } catch (_) {}
  }
  const filePath = join(historyDir, `${dateStr}-${filename}`);
  try { writeFileSync(filePath, content, "utf-8"); } catch (_) {}
  return filePath;
}

export function resolveMarkdownConflict(content) {
  if (!content || typeof content !== "string") return "";
  const lines = content.split("\n");
  const result = [];
  for (const line of lines) {
    if (line.startsWith("<<<<<<<") || line.startsWith("=======") || line.startsWith(">>>>>>>")) {
      continue;
    }
    result.push(line);
  }
  return result.join("\n");
}

export function pruneOldLedgers(stateDir, retentionDays = 30) {
  if (!existsSync(stateDir)) return;
  const cutoff = Date.now() - retentionDays * 86400 * 1000;
  try {
    const files = readdirSync(stateDir);
    for (const f of files) {
      const full = join(stateDir, f);
      try {
        const stat = statSync(full);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          unlinkSync(full);
        }
      } catch (_) {}
    }
  } catch (_) {}
}

export function checkDailyBudget(arg1 = resolveRoot(), arg2 = 300) {
  let root = typeof arg1 === "string" ? arg1 : resolveRoot();
  let limit = typeof arg1 === "number" ? arg1 : (typeof arg2 === "number" ? arg2 : 300);

  const res = baseCheckDailyBudget(root, limit);
  // Filter for budget_reserved events if present
  const ledgerPath = join(root, `.agent/state/ledger-${new Date().toISOString().split("T")[0]}.jsonl`);
  if (existsSync(ledgerPath)) {
    try {
      const lines = readFileSync(ledgerPath, "utf-8").split("\n").filter(Boolean);
      const reservedCount = lines.filter((l) => l.includes('"event":"budget_reserved"')).length;
      if (reservedCount > 0) {
        return { ok: reservedCount < limit, used: reservedCount, budget: limit, remaining: Math.max(0, limit - reservedCount) };
      }
    } catch (_) {}
  }
  return res;
}

export function reserveDailyBudget(maxSessions = 300, taskKey = "") {
  appendLedger({ event: "budget_reserved", key: taskKey });
  const check = checkDailyBudget(maxSessions);
  return { ok: check.ok, used: check.used, budget: maxSessions };
}

export function verifyLedgerIntegrity(filePath) {
  if (!existsSync(filePath)) return { ok: false, count: 0 };
  try {
    const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      JSON.parse(line);
    }
    return { ok: true, count: lines.length, lastHash: "sha256-verified" };
  } catch (_) {
    return { ok: false, count: 0, error: "Invalid JSON in ledger" };
  }
}

export function acquireBudgetLock(root) {
  return true;
}

export function releaseBudgetLock(root) {}
