import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { promisify } from "node:util";

// ANSI colors for standardizing CLI DX
export const log = {
  info: (msg) => console.log(`\x1b[36mℹ️  ${msg}\x1b[0m`),
  success: (msg) => console.log(`\x1b[32m✅ ${msg}\x1b[0m`),
  warn: (msg) => console.warn(`\x1b[33m⚠️  ${msg}\x1b[0m`),
  error: (msg) => console.error(`\x1b[31m❌ ${msg}\x1b[0m`),
  step: (stepStr, msg) => console.log(`\x1b[90m${stepStr}\x1b[0m ${msg}`),
  dim: (msg) => console.log(`\x1b[90m${msg}\x1b[0m`),
  header: (msg) => console.log(`\n\x1b[1m\x1b[35m=== ${msg} ===\x1b[0m\n`)
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
