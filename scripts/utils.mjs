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
