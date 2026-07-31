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

  const patterns = [
    /gh[pusr]_[a-zA-Z0-9]{36}/g,
    /github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/g,
    /AKIA[0-9A-Z]{16}/g,
    /AIzaSy[a-zA-Z0-9_\-]{33}/g,
    /ya29\.[a-zA-Z0-9_\-]{20,}/g,
    /Bearer\s+[a-zA-Z0-9\-\._~+\/]+=*/g,
    /sk-(?:ant-api03-|proj-|svcacct-)[a-zA-Z0-9\-\_]{32,}/g,
    /xox[baprs]-[a-zA-Z0-9\-]{10,}/g,
    /eyJ[a-zA-Z0-9_\-]{10,}\.[a-zA-Z0-9_\-]{10,}\.[a-zA-Z0-9_\-]{10,}/g,
    /-----BEGIN (?:RSA|OPENSSH|EC|PRIVATE) KEY-----[\s\S]*?-----END (?:RSA|OPENSSH|EC|PRIVATE) KEY-----/g,
  ];
  for (const pat of patterns) {
    sanitized = sanitized.replace(pat, "[REDACTED_BY_SECURITY_GATE]");
  }
  return sanitized;
}

export function appendLedger(ledgerName, payload) {
  const stateDir = path.resolve(process.env.JULES_PROJECT_ROOT || process.cwd(), ".agent/state");
  ensureDir(stateDir);
  const ledgerPath = path.join(stateDir, `${ledgerName}.jsonl`);
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...payload
  }) + "\n";
  fs.appendFileSync(ledgerPath, entry, "utf-8");
  return ledgerPath;
}

export function checkDailyBudget(maxSessions = 300) {
  const dateStr = new Date().toISOString().split("T")[0];
  const stateDir = path.resolve(process.env.JULES_PROJECT_ROOT || process.cwd(), ".agent/state");
  const sessionsLedger = path.join(stateDir, "sessions.jsonl");
  
  if (!fs.existsSync(sessionsLedger)) {
    return { ok: true, used: 0, budget: maxSessions };
  }

  const content = fs.readFileSync(sessionsLedger, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  
  let usedToday = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.timestamp && entry.timestamp.startsWith(dateStr)) {
        usedToday++;
      }
    } catch (e) {
      // Ignore
    }
  }

  return { ok: usedToday < maxSessions, used: usedToday, budget: maxSessions };
}
