import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { resolveProjectCommands } from "./command-resolver.mjs";

const taskTitle = process.argv[2];
const taskPromptArg = process.argv[3];

if (!taskTitle || !taskPromptArg) {
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

// 0.1 Pre-Flight Secret Redaction Gate
function redactSecrets(text) {
  if (!text) return "";
  const patterns = [
    /gh[p|u|s|r]_[a-zA-Z0-9]{36}/g,
    /github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/g,
    /AKIA[0-9A-Z]{16}/g,
    /AIzaSy[a-zA-Z0-9_\-]{33}/g,
    /Bearer\s+[a-zA-Z0-9\-\._~+\/]+=*/g,
    /sk-(?:ant-api03-|proj-)?[a-zA-Z0-9\-\_]{32,}/g,
    /xox[baprs]-[a-zA-Z0-9\-]{10,}/g,
    /-----BEGIN (?:RSA|OPENSSH|EC|PRIVATE) KEY-----[\s\S]*?-----END (?:RSA|OPENSSH|EC|PRIVATE) KEY-----/g,
  ];
  let sanitized = text;
  for (const pat of patterns) {
    sanitized = sanitized.replace(pat, "[REDACTED_BY_SECURITY_GATE]");
  }
  return sanitized;
}

// 1. Resolve prompt content (file path or inline string)
let rawPrompt = "";
const possiblePath = path.resolve(process.cwd(), taskPromptArg);
if (fs.existsSync(possiblePath) && fs.statSync(possiblePath).isFile()) {
  rawPrompt = fs.readFileSync(possiblePath, "utf-8");
} else {
  rawPrompt = taskPromptArg;
}
rawPrompt = redactSecrets(rawPrompt);

// 2. Dynamic Guardrail Composition (DGC) from .agent/rules/dynamic-guardrails.json
function getDynamicGuardrails(promptText) {
  const guardrailsPath = path.resolve(process.cwd(), ".agent/rules/dynamic-guardrails.json");
  if (!fs.existsSync(guardrailsPath)) return "";

  try {
    const data = JSON.parse(fs.readFileSync(guardrailsPath, "utf-8"));
    if (!data.rules || !Array.isArray(data.rules)) return "";

    const active = [];
    for (const item of data.rules) {
      if (new RegExp(item.trigger, "i").test(promptText)) {
        active.push(item.guardrail);
      }
    }
    return active.join("\n\n");
  } catch (e) {
    return "";
  }
}

// 3. Dynamic Command Resolution (Language & Framework Detection)
const resolvedCmds = resolveProjectCommands(process.cwd());
const verifyDirective = resolvedCmds.testCmd || resolvedCmds.buildCmd
  ? `\n\n## 🛠️ MANDATORY VERIFICATION COMMANDS\nBefore submitting PR, you MUST execute: \`${[resolvedCmds.testCmd, resolvedCmds.buildCmd].filter(Boolean).join(" && ")}\``
  : "";

// 4. Load Base Rules / Guardrails
const rulesPath = fs.existsSync(path.resolve(process.cwd(), "AGENTS.md"))
  ? path.resolve(process.cwd(), "AGENTS.md")
  : path.resolve(process.cwd(), "JULES_RULES_TEMPLATE.md");

const baseRules = fs.existsSync(rulesPath)
  ? fs.readFileSync(rulesPath, "utf-8")
  : "";

const dynamicRules = getDynamicGuardrails(rawPrompt);

// Machine XML Directives
const envelope = `
<MCP_DIRECTIVE>
  <system_state>HEADLESS_CI_MODE</system_state>
  <strict_invariants>
    <rule>1. READ-BEFORE-WRITE (ZERO HALLUCINATION): You are FORBIDDEN from guessing internal API signatures. Before editing, use search tools or MCP doc tools to verify exact signatures.</rule>
    <rule>2. VERIFICATION LOOP: After patching code, you MUST execute the verification commands and ensure 0 errors.</rule>
    <rule>3. ABORT CONDITION: On repeated unresolvable test failures, output <status>ABORT_UNRESOLVABLE</status> and terminate.</rule>
  </strict_invariants>
</MCP_DIRECTIVE>
`.trim();

const fullPrompt = redactSecrets(`MCP DIRECTIVE: ${rawPrompt.trim()}${verifyDirective}\n\n---\n\n${envelope}\n\n---\n\n${dynamicRules ? `${dynamicRules}\n\n---\n\n` : ""}${baseRules.trim()}`);

// 5. Log Dispatch History
const dateStr = new Date().toISOString().split("T")[0];
const slug = taskTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

const historyDir = path.resolve(process.cwd(), ".agent/history");
if (!fs.existsSync(historyDir)) {
  fs.mkdirSync(historyDir, { recursive: true });
}
const historyFile = path.join(historyDir, `${dateStr}-dispatch-${slug}.md`);
fs.writeFileSync(historyFile, `---\ntype: jules_dispatch\ntitle: "${taskTitle}"\ntimestamp: "${new Date().toISOString()}"\n---\n# Jules Task Dispatch: ${taskTitle}\n\n## Prompt\n${rawPrompt}\n`, "utf-8");

console.log(`🚀 Dispatching task to Google Jules: "${taskTitle}"...`);
console.log(`📝 Logged dispatch history to: ${path.relative(process.cwd(), historyFile)}`);

// 6. Dispatch via REST API or Ephemeral Payload File (Avoid ARG_MAX shell limits)
const apiKey = process.env.JULES_API_KEY;
const repo = process.env.JULES_REPO;

const payloadHash = crypto.createHash("sha256").update(taskTitle + Date.now()).digest("hex").slice(0, 12);
const tmpPayloadFile = path.join(os.tmpdir(), `jules_payload_${payloadHash}.json`);
fs.writeFileSync(tmpPayloadFile, JSON.stringify({ repo, title: taskTitle, prompt: fullPrompt }));

async function executeDispatch() {
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
      try {
        dispatchViaCli(repo, tmpPayloadFile, taskTitle);
      } finally {
        fs.rmSync(tmpPayloadFile, { force: true });
      }
      return;
    }

    if (res.status === 429) {
      console.error(`❌ Jules REST API Rate Limit Exceeded (HTTP 429). Will NOT fallback to CLI.`);
      fs.rmSync(tmpPayloadFile, { force: true });
      process.exit(1);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn(`⚠️ REST API returned HTTP ${res.status}: ${errText}, falling back to CLI...`);
      try {
        dispatchViaCli(repo, tmpPayloadFile, taskTitle);
      } finally {
        fs.rmSync(tmpPayloadFile, { force: true });
      }
      return;
    }

    let sessionId = "Created";
    try {
      const data = await res.json();
      sessionId = data.name || data.id || sessionId;
    } catch (_) {}

    console.log(`✅ REST API Dispatch response: Session ${sessionId} created successfully.`);
    fs.appendFileSync(historyFile, `\n## Session\n- ID: \`${sessionId}\`\n`);
    fs.rmSync(tmpPayloadFile, { force: true });
  } else {
    try {
      dispatchViaCli(repo, tmpPayloadFile, taskTitle);
    } finally {
      fs.rmSync(tmpPayloadFile, { force: true });
    }
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

    args.push(promptToSend);

    console.log(`💻 Executing: jules ${args.join(" ")}...`);
    execFileSync("jules", args, { stdio: "inherit" });
    console.log(`✅ Successfully dispatched task "${title}" to Jules CLI.`);
  } catch (error) {
    console.error(`❌ Failed to dispatch task to Jules CLI:`, error.message);
    process.exit(1);
  }
}

executeDispatch();

