import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { resolveProjectCommands } from "./command-resolver.mjs";

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

const taskTitle = isMainModule ? process.argv[2] : "";
const taskPromptArg = isMainModule ? process.argv[3] : "";

if (isMainModule && (!taskTitle || !taskPromptArg)) {
  console.error(
    'Usage: node scripts/jules-dispatch.mjs <task-title> <path-to-prompt.md | "raw prompt string">'
  );
  process.exit(1);
}

// 0. Environment Variables Auto-Load (.env support without extra dependencies)
function loadEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}
loadEnv();

// 0.1 Shannon Entropy Calculator
export function calculateEntropy(str) {
  if (!str) return 0;
  const len = str.length;
  const frequencies = {};
  for (let i = 0; i < len; i++) {
    const char = str[i];
    frequencies[char] = (frequencies[char] || 0) + 1;
  }
  let entropy = 0;
  for (const char in frequencies) {
    const p = frequencies[char] / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// 0.2 Pre-Flight Secret Redaction Gate (RegEx + Shannon Entropy)
export function redactSecrets(text) {
  if (!text) return "";
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
  let sanitized = text;
  for (const pat of patterns) {
    sanitized = sanitized.replace(pat, "[REDACTED_BY_SECURITY_GATE]");
  }
  sanitized = sanitized.replace(/[a-zA-Z0-9_\-\.\:\/]{20,}/g, (token) => {
    if (token.startsWith("[REDACTED_") || token.startsWith("http://") || token.startsWith("https://")) {
      return token;
    }
    const entropy = calculateEntropy(token);
    if (entropy > 3.6) {
      return "[REDACTED_ENTROPY_KEY]";
    }
    return token;
  });
  return sanitized;
}

// 0.3 Hardened Path Traversal & Symlink Defense
export function assertPathWithinWorkspace(targetPath, workspaceRoot = process.cwd()) {
  const rootReal = fs.existsSync(workspaceRoot) ? fs.realpathSync(path.resolve(workspaceRoot)) : path.resolve(workspaceRoot);
  const resolvedTarget = path.resolve(rootReal, targetPath);
  const targetReal = fs.existsSync(resolvedTarget) ? fs.realpathSync(resolvedTarget) : resolvedTarget;
  const normalizedRoot = rootReal.replace(/\\/g, "/");
  const normalizedTarget = targetReal.replace(/\\/g, "/");
  if (!normalizedTarget.startsWith(normalizedRoot)) {
    throw new Error(`FATAL: Sandboxed directory traversal breach blocked for path: ${targetPath}`);
  }
  return targetReal;
}

// 1. Resolve prompt content (file path or inline string)
let rawPrompt = "";
let fullPrompt = "";
let historyFile = "";
let tmpPayloadFile = "";
let tmpDir = "";

if (isMainModule) {
  const possiblePath = path.resolve(process.cwd(), taskPromptArg);
  if (fs.existsSync(possiblePath) && fs.statSync(possiblePath).isFile()) {
    assertPathWithinWorkspace(possiblePath);
    rawPrompt = fs.readFileSync(possiblePath, "utf-8");
  } else {
    rawPrompt = taskPromptArg;
  }
  rawPrompt = redactSecrets(rawPrompt);

  const dynamicRules = getDynamicGuardrails(rawPrompt);
  fullPrompt = redactSecrets(`MCP DIRECTIVE: ${rawPrompt.trim()}${verifyDirective}\n\n---\n\n${envelope}\n\n---\n\n${dynamicRules ? `${dynamicRules}\n\n---\n\n` : ""}${baseRules.trim()}`);

  const dateStr = new Date().toISOString().split("T")[0];
  const slug = taskTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

  const historyDir = path.resolve(process.cwd(), ".agent/history");
  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true });
  }
  historyFile = path.join(historyDir, `${dateStr}-dispatch-${slug}.md`);
  fs.writeFileSync(historyFile, `---\ntype: jules_dispatch\ntitle: "${taskTitle}"\ntimestamp: "${new Date().toISOString()}"\n---\n# Jules Task Dispatch: ${taskTitle}\n\n## Prompt\n${rawPrompt}\n`, "utf-8");

  console.log(`🚀 Dispatching task to Google Jules: "${taskTitle}"...`);
  console.log(`📝 Logged dispatch history to: ${path.relative(process.cwd(), historyFile)}`);

  const payloadHash = crypto.createHash("sha256").update(taskTitle + Date.now()).digest("hex").slice(0, 12);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jules-payload-"));
  tmpPayloadFile = path.join(tmpDir, `payload_${payloadHash}.json`);
  const repo = process.env.JULES_REPO;
  fs.writeFileSync(tmpPayloadFile, JSON.stringify({ repo, title: taskTitle, prompt: fullPrompt }), { mode: 0o600 });
}

function cleanupTmp() {
  try {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch (_) {}
}

async function executeDispatch() {
  try {
    if (apiKey && repo) {
      console.log(`🌐 Using Jules REST API for repository ${repo}...`);
      const formattedSource = repo.startsWith("sources/") ? repo : (repo.includes("/") ? `sources/github/${repo}` : repo);
      const payload = {
        title: taskTitle,
        prompt: fullPrompt,
        sourceContext: {
          source: formattedSource,
          githubRepoContext: {
            startingBranch: process.env.BASE_BRANCH || "main"
          }
        }
      };

      let res;
      try {
        res = await fetch("https://jules.googleapis.com/v1alpha/sessions", {
          method: "POST",
          headers: {
            "X-Goog-Api-Key": apiKey,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload)
        });
      } catch (fetchErr) {
        console.warn(`⚠️ REST API request failed (network error), falling back to CLI...`, fetchErr.message);
        dispatchViaCli(repo, tmpPayloadFile, taskTitle);
        return;
      }

      if (res.status === 429) {
        console.error(`❌ Jules REST API Rate Limit Exceeded (HTTP 429). Will NOT fallback to CLI.`);
        process.exit(1);
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.warn(`⚠️ REST API returned HTTP ${res.status}: ${errText}, falling back to CLI...`);
        dispatchViaCli(repo, tmpPayloadFile, taskTitle);
        return;
      }

      let sessionId = "Created";
      try {
        const data = await res.json();
        sessionId = data.name || data.id || sessionId;
      } catch (_) {}

      console.log(`✅ REST API Dispatch response: Session ${sessionId} created successfully.`);
      fs.appendFileSync(historyFile, `\n## Session\n- ID: \`${sessionId}\`\n`);
    } else {
      dispatchViaCli(repo, tmpPayloadFile, taskTitle);
    }
  } finally {
    cleanupTmp();
  }
}


function dispatchViaCli(targetRepo, payloadFile, title) {
  try {
    let promptToSend = fullPrompt;
    if (payloadFile && fs.existsSync(payloadFile)) {
      try {
        const payloadData = JSON.parse(fs.readFileSync(payloadFile, "utf-8"));
        if (payloadData.prompt) promptToSend = payloadData.prompt;
      } catch (_) {}
    }

    const args = ["new"];
    if (targetRepo) {
      args.push("--repo", targetRepo);
    }

    console.log(`💻 Executing: jules ${args.join(" ")} (prompt passed via stdin)...`);
    execFileSync("jules", args, { input: promptToSend, stdio: ["pipe", "inherit", "inherit"] });
    console.log(`✅ Successfully dispatched task "${title}" to Jules CLI.`);
  } catch (error) {
    console.error(`❌ Failed to dispatch task to Jules CLI:`, error.message);
    process.exit(1);
  }
}


if (isMainModule) {
  executeDispatch().catch((err) => {
    console.error("❌ Fatal unhandled rejection in dispatch:", err);
    process.exit(1);
  });
}


