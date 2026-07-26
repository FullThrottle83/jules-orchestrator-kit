import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const taskTitle = process.argv[2];
const taskPromptArg = process.argv[3];

if (!taskTitle || !taskPromptArg) {
  console.error(
    'Usage: node scripts/jules-dispatch.mjs <task-title> <path-to-prompt.md | "raw prompt string">'
  );
  process.exit(1);
}

// 1. Resolve prompt content (file path or inline string)
let rawPrompt = "";
const possiblePath = path.resolve(process.cwd(), taskPromptArg);
if (fs.existsSync(possiblePath) && fs.statSync(possiblePath).isFile()) {
  rawPrompt = fs.readFileSync(possiblePath, "utf-8");
} else {
  rawPrompt = taskPromptArg;
}

// 2. Load Base Rules / Guardrails
const rulesPath = fs.existsSync(path.resolve(process.cwd(), "AGENTS.md"))
  ? path.resolve(process.cwd(), "AGENTS.md")
  : path.resolve(process.cwd(), "JULES.md");

const baseRules = fs.existsSync(rulesPath)
  ? fs.readFileSync(rulesPath, "utf-8")
  : "";

// Mandatory MCP & Verification Envelope
const envelope = [
  "## 🎯 MANDATORY PRE-EXECUTION DIRECTIVE",
  "1. Query official documentation/MCP tools for framework APIs before editing.",
  "2. Strictly satisfy the verification mandate before completing the session.",
  "3. Keep PR diffs minimal and targeted to the prompt instructions."
].join("\n");

const fullPrompt = `MCP DIRECTIVE: ${rawPrompt.trim()}\n\n---\n\n${envelope}\n\n---\n\n${baseRules.trim()}`;

// 3. Log Dispatch History
const dateStr = new Date().toISOString().split("T")[0];
const slug = taskTitle
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/(^-|-$)/g, "");

const historyDir = path.resolve(process.cwd(), ".agent/history");
if (!fs.existsSync(historyDir)) {
  fs.mkdirSync(historyDir, { recursive: true });
}
const historyFile = path.join(historyDir, `${dateStr}-dispatch-${slug}.md`);

const historyContent = `---
type: jules_dispatch
title: "${taskTitle}"
timestamp: "${new Date().toISOString()}"
---
# Jules Task Dispatch: ${taskTitle}

## Prompt
${rawPrompt}
`;

fs.writeFileSync(historyFile, historyContent, "utf-8");

console.log(`🚀 Dispatching task to Google Jules: "${taskTitle}"...`);
console.log(`📝 Logged dispatch history to: ${path.relative(process.cwd(), historyFile)}`);

// 4. Dispatch via REST API or CLI
const apiKey = process.env.JULES_API_KEY;
const repo = process.env.JULES_REPO;

if (apiKey && repo) {
  console.log(`🌐 Using Jules REST API for repository ${repo}...`);
  try {
    const res = execSync(
      `curl -s -X POST "https://jules.googleapis.com/v1alpha/sessions" \
        -H "Authorization: Bearer ${apiKey}" \
        -H "Content-Type: application/json" \
        -d '${JSON.stringify({
          repo: repo,
          prompt: fullPrompt,
          title: taskTitle,
        })}'`,
      { encoding: "utf-8" }
    );
    console.log(`✅ REST API Dispatch response:`, res.trim());
  } catch (error) {
    console.warn(`⚠️ REST API dispatch failed, falling back to CLI...`, error.message);
    dispatchViaCli(repo, fullPrompt, taskTitle);
  }
} else {
  dispatchViaCli(repo, fullPrompt, taskTitle);
}

function dispatchViaCli(targetRepo, promptText, title) {
  try {
    const args = ["new"];
    if (targetRepo) {
      args.push("--repo", targetRepo);
    }
    args.push(promptText);

    console.log(`💻 Executing: jules ${args.join(" ")}...`);
    execFileSync("jules", args, { stdio: "inherit" });
    console.log(`✅ Successfully dispatched task "${title}" to Jules CLI.`);
  } catch (error) {
    console.error(`❌ Failed to dispatch task to Jules CLI:`, error.message);
    process.exit(1);
  }
}
