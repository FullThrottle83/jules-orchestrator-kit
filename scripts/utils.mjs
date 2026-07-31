import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { promisify } from "node:util";

// ANSI colors for standardizing CLI DX
const isCI = !!process.env.CI;
const noColor = (!process.stdout.isTTY && !isCI) || process.env.NO_COLOR;
const c = (color, text) => noColor ? text : `\x1b[${color}m${text}\x1b[0m`;

export const log = {
  info: (msg) => console.log(c(36, `ℹ️  ${msg}`)),
  success: (msg) => console.log(c(32, `✅ ${msg}`)),
  warn: (msg) => console.warn(c(33, `⚠️  ${msg}`)),
  error: (msg) => {
    if (isCI) console.log(`::error::${msg}`);
    console.error(c(31, `❌ ${msg}`));
  },
  step: (stepStr, msg) => console.log(`${c(90, stepStr)} ${msg}`),
  dim: (msg) => console.log(c(90, msg)),
  header: (msg) => {
    if (isCI) console.log(`::group::${msg}`);
    console.log(`\n${c("1;35", `=== ${msg} ===`)}\n`);
  },
  groupEnd: () => {
    if (isCI) console.log("::endgroup::");
  }
};

export const sleep = promisify(setTimeout);

export function ensureDir(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  } catch (error) {
    log.error(`EACCES: Insufficient permissions or failed to create directory: ${dirPath}`);
    log.error(error.message);
    process.exit(1);
  }
}

export function logToHistory(filename, content, type = "audit") {
  const dateStr = new Date().toISOString().split("T")[0];
  const historyDir = path.resolve(process.env.JULES_PROJECT_ROOT || process.cwd(), ".agent/history");
  ensureDir(historyDir);
  const filePath = path.join(historyDir, `${dateStr}-${filename}`);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

export function resolveMarkdownConflict(content) {
  if (!content || typeof content !== "string") return "";
  if (!content.includes("<<<<<<<")) return content;

  const lines = content.split("\n");
  const result = [];
  let inConflict = false;
  let headBuffer = [];
  let devBuffer = [];
  let section = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("<<<<<<<")) {
      inConflict = true;
      section = "head";
      continue;
    }
    if (line.startsWith("=======")) {
      section = "dev";
      continue;
    }
    if (line.startsWith(">>>>>>>")) {
      result.push(...headBuffer);
      result.push(...devBuffer);
      headBuffer = [];
      devBuffer = [];
      inConflict = false;
      section = null;
      continue;
    }

    if (inConflict) {
      if (section === "head") headBuffer.push(line);
      else if (section === "dev") devBuffer.push(line);
    } else {
      result.push(line);
    }
  }

  return result.join("\n");
}

export function calculateShannonEntropy(str) {
  const len = str.length;
  if (len === 0) return 0;
  const frequencies = {};
  for (let i = 0; i < len; i++) {
    frequencies[str[i]] = (frequencies[str[i]] || 0) + 1;
  }
  return Object.values(frequencies).reduce((sum, count) => {
    const p = count / len;
    return sum - p * Math.log2(p);
  }, 0);
}

export const HIGH_CONFIDENCE_PATTERNS = [
  /\bgh[pousr]_[a-zA-Z0-9]{36,}\b/g,
  /\bgithub_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bnpm_[a-zA-Z0-9]{36}\b/g,
  /\bsk_live_[0-9a-zA-Z]{24,}\b/g,
];

export const LOW_CONFIDENCE_PATTERNS = [
  /\bAIza[0-9A-Za-z_-]{30,40}\b/g,
  /\bya29\.[a-zA-Z0-9_\-]{20,}\b/g,
  /\bBearer\s+[a-zA-Z0-9\-\._~+\/]+=*/g,
  /\bsk-(?:ant-api03-|proj-|svcacct-)[a-zA-Z0-9\-\_]{32,}\b/g,
  /\bxox[baprs]-[a-zA-Z0-9\-]{10,}\b/g,
  /\beyJ[a-zA-Z0-9_\-]{10,}\.[a-zA-Z0-9_\-]{10,}\.[a-zA-Z0-9_\-]{10,}\b/g,
  /\b(?:rk|pk)_(?:live|test)_[0-9a-zA-Z]{24,}\b/g,
  /\bsk_test_[0-9a-zA-Z]{24,}\b/g,
];

export function hasHighConfidenceSecret(text) {
  if (!text) return false;
  return HIGH_CONFIDENCE_PATTERNS.some((pat) => {
    pat.lastIndex = 0;
    return pat.test(text);
  });
}

export function hasLowConfidenceSecret(text) {
  if (!text) return false;
  return LOW_CONFIDENCE_PATTERNS.some((pat) => {
    pat.lastIndex = 0;
    return pat.test(text);
  });
}

export function redactSecrets(text) {
  if (!text) return "";
  let sanitized = text;

  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (
      envVal &&
      (envVal.length >= 20 || calculateShannonEntropy(envVal) > 3.6) &&
      /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH/i.test(envKey)
    ) {
      if (sanitized.includes(envVal)) {
        sanitized = sanitized.split(envVal).join("[REDACTED_ENV_SECRET]");
      }
    }
  }

  const allPatterns = [...HIGH_CONFIDENCE_PATTERNS, ...LOW_CONFIDENCE_PATTERNS];
  for (const pat of allPatterns) {
    sanitized = sanitized.replace(pat, "[REDACTED_BY_SECURITY_GATE]");
  }
  return sanitized;
}

export function getDailyLedgerPath(ledgerName = "sessions") {
  const dateStr = new Date().toISOString().split("T")[0];
  const stateDir = path.resolve(process.env.JULES_PROJECT_ROOT || process.cwd(), ".agent/state", ledgerName);
  ensureDir(stateDir);
  return path.join(stateDir, `${dateStr}.jsonl`);
}

export function appendLedger(ledgerName, payload) {
  const ledgerPath = getDailyLedgerPath(ledgerName);
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...payload
  }) + "\n";
  fs.appendFileSync(ledgerPath, entry, "utf-8");
  return ledgerPath;
}

export function checkDailyBudget(maxSessions = 300) {
  const dateStr = new Date().toISOString().split("T")[0];
  const ledgerPath = getDailyLedgerPath("sessions");
  
  if (!fs.existsSync(ledgerPath)) {
    return { ok: true, used: 0, budget: maxSessions };
  }

  const content = fs.readFileSync(ledgerPath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  
  let usedToday = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.event === "budget_reserved" || !entry.event) {
        usedToday++;
      }
    } catch (_) {}
  }

  return {
    ok: usedToday < maxSessions,
    used: usedToday,
    budget: maxSessions
  };
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {}
}

export function reserveDailyBudget(maxSessions = 300, taskKey = "") {
  const stateDir = path.resolve(process.env.JULES_PROJECT_ROOT || process.cwd(), ".agent/state");
  ensureDir(stateDir);

  const lockFile = path.join(stateDir, "budget.lock");
  let fd;
  const maxLockAttempts = 10;

  for (let attempt = 0; attempt < maxLockAttempts; attempt++) {
    try {
      try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs > 30000) {
          fs.rmSync(lockFile, { force: true });
        }
      } catch (_) {}

      fd = fs.openSync(lockFile, "wx");
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (attempt < maxLockAttempts - 1) {
        sleepSync(Math.floor(50 + Math.random() * 50));
      }
    }
  }

  if (fd === undefined) {
    return { ok: false, reason: "locked", used: null, budget: maxSessions };
  }

  try {
    const check = checkDailyBudget(maxSessions);
    if (!check.ok) {
      return check;
    }

    appendLedger("sessions", {
      event: "budget_reserved",
      task_key: taskKey,
      status: "reserved"
    });

    return {
      ok: true,
      used: check.used + 1,
      budget: maxSessions
    };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
      try {
        fs.rmSync(lockFile, { force: true });
      } catch {}
    }
  }
}
