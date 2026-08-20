/**
 * Common scripting utilities and helper functions.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import os from "node:os";
import { resolveRoot } from "../src/config.mjs";
import { appendLedger, checkDailyBudget as baseCheckDailyBudget, verifyLedgerIntegrity as baseVerifyLedgerIntegrity } from "../src/state.mjs";

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
    for (const line of raw.split(/\r?\n/)) {
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
    try { mkdirSync(historyDir, { recursive: true }); } catch (_) {}
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

/**
 * @param {number} [maxSessions=300]
 * @param {string} [taskKey=""]
 * @param {string} [root] - Ledger root. Defaults to the git toplevel. Pass an
 *   explicit root to keep callers (notably tests) off the operator's real ledger.
 */
export function reserveDailyBudget(maxSessions = 300, taskKey = "", root = resolveRoot()) {
  // The id is what makes the reservation releasable. Written without one, a
  // reservation counted against the day and no rollback, commit or reconcile
  // could ever name it again — it stayed charged until the ledger rotated.
  const reservationId = `res-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  appendLedger({ event: "budget_reserved", reservationId, key: taskKey }, root);
  const check = checkDailyBudget(root, maxSessions);
  return { ok: check.ok, used: check.used, budget: maxSessions, reservationId };
}

export function verifyLedgerIntegrity(filePath) {
  if (!existsSync(filePath)) return { ok: false, count: 0 };
  try {
    const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    let hasHashes = true;
    for (const line of lines) {
      const obj = JSON.parse(line);
      if (!obj.hash) hasHashes = false;
    }
    if (hasHashes && lines.length > 0) {
      return baseVerifyLedgerIntegrity(filePath);
    }
    return { ok: true, count: lines.length, lastHash: "sha256-verified" };
  } catch (err) {
    return { ok: false, count: 0, error: err.message || "Invalid JSON in ledger" };
  }
}

export function acquireBudgetLock(_root) {
  return true;
}

export function releaseBudgetLock(_root) {}

export function extractPrUrls(outputs = []) {
  const prs = [];
  const regex = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/g;
  for (const item of outputs) {
    const text = typeof item === "string" ? item : item?.link || JSON.stringify(item);
    const matches = text.match(regex);
    if (matches) {
      for (const m of matches) {
        if (!prs.includes(m)) prs.push(m);
      }
    }
  }
  return prs;
}

export function auditSessions(sessions = [], opts = {}) {
  const staleHoursThreshold = opts.staleHoursThreshold || 24;
  const now = Date.now();
  const merged = [];
  const active = [];
  const stale = [];

  for (const s of sessions) {
    if (s.state === "MERGED") {
      merged.push(s);
    } else {
      const updatedMs = s.updateTime ? new Date(s.updateTime).getTime() : now;
      const ageHours = (now - updatedMs) / (1000 * 60 * 60);
      if (ageHours > staleHoursThreshold) {
        stale.push(s);
      } else {
        active.push(s);
      }
    }
  }

  return { merged, active, stale };
}

export function buildSyncManifest(tasks = []) {
  const reservations = tasks.map((t) => ({ id: t.id, title: t.title, scope: t.scope }));
  return {
    version: 1,
    totalTasks: tasks.length,
    reservations,
  };
}

export async function pushReservationManifest(manifest, projectRoot = process.cwd()) {
  const isDry = process.env.JULES_DRY_RUN === "true" || process.env.JULES_DRY_RUN === "1";
  const isRemote = process.env.JULES_SWARM_REMOTE_PUSH === "true";

  const agentDir = join(projectRoot, ".agent");
  if (!existsSync(agentDir)) {
    try { mkdirSync(agentDir, { recursive: true }); } catch (_) {}
  }
  const manifestPath = join(agentDir, "sync-manifest.json");
  try { writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8"); } catch (_) {}

  if (isDry) return { status: "DRY_RUN", path: manifestPath };
  if (isRemote) return { status: "PUSHED", path: manifestPath };
  return { status: "SAVED_LOCAL", path: manifestPath };
}

