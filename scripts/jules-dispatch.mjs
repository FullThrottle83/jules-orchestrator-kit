import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { resolveProjectCommands } from "./command-resolver.mjs";
import { log, logToHistory } from "./utils.mjs";

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

const taskTitle = isMainModule ? process.argv[2] : "";
const taskPromptArg = isMainModule ? process.argv[3] : "";

if (isMainModule && (!taskTitle || !taskPromptArg)) {
  log.error(
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
        const key = trimmed.slice(0, eqIdx).trim().replace(/^export\s+/, "");
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

// 0.2 Pre-Flight Secret Redaction Gate (RegEx + Env Denylist)
export function redactSecrets(text) {
  if (!text) return "";
  let sanitized = text;

  // Redact active env secrets from denylist keys (*_KEY, *_SECRET, *_TOKEN, etc.)
  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (
      envVal &&
      envVal.length >= 6 &&
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

const ASTRO_TRIGGER_RE = /\b(?:astro|components|pages|src\/.*\.astro)\b/i;
const DB_TRIGGER_RE = /\b(?:db|database|d1|postgres|drizzle|migration|schema)\b/i;

// 0.4 Dynamic Guardrails & Directive Definitions
export function getDynamicGuardrails(prompt = "") {
  const guardrails = [];
  if (ASTRO_TRIGGER_RE.test(prompt)) {
    guardrails.push("- Astro Guidance: Ensure zero client JS shipped by default. Use server islands or nano stores if state is required.");
  }
  if (DB_TRIGGER_RE.test(prompt)) {
    guardrails.push("- Database Guidance: Do not modify migrations directly without inspecting current schema constraints.");
  }
  return guardrails.length > 0 ? `## Context-Specific Guardrails\n${guardrails.join("\n")}` : "";
}

function getBaseRules(projectRoot = process.cwd()) {
  const templatePath = path.join(projectRoot, "JULES_RULES_TEMPLATE.md");
  if (fs.existsSync(templatePath)) {
    return fs.readFileSync(templatePath, "utf-8");
  }
  const agentsPath = path.join(projectRoot, "AGENTS.md");
  if (fs.existsSync(agentsPath)) {
    return fs.readFileSync(agentsPath, "utf-8");
  }
  return `## Operational Directives
- **Read Before Write**: Always inspect target files and symbol definitions before modifying code.
- **Verification**: Execute test and build verification suite and ensure 0 errors.
- **Anti-Patch Invariant**: Do NOT create out-of-band shell scripts (patch.sh, test-fix.sh) or disable assertions to force tests to pass.`;
}

// 1. Resolve prompt content and construct directive envelope
let rawPrompt = "";
let fullPrompt = "";
let historyFile = "";
let tmpPayloadFile = "";
let tmpDir = "";

const apiKey = process.env.JULES_API_KEY || process.env.GEMINI_API_KEY || "";
const repo = process.env.JULES_REPO || "";

if (isMainModule) {
  const possiblePath = path.resolve(process.cwd(), taskPromptArg);
  if (fs.existsSync(possiblePath)) {
    try {
      const verifiedPath = path.resolve(process.cwd(), possiblePath);
      if (verifiedPath.startsWith(process.cwd())) {
        const fd = fs.openSync(verifiedPath, "r");
        try {
          const stat = fs.fstatSync(fd);
          if (stat.isFile()) {
            rawPrompt = fs.readFileSync(fd, "utf-8");
          } else {
            rawPrompt = taskPromptArg;
          }
        } finally {
          fs.closeSync(fd);
        }
      } else {
        rawPrompt = taskPromptArg;
      }
    } catch (_) {
      rawPrompt = taskPromptArg;
    }
  } else {
    rawPrompt = taskPromptArg;
  }
  rawPrompt = redactSecrets(rawPrompt);

  const dynamicRules = getDynamicGuardrails(rawPrompt);
  const baseRules = getBaseRules(process.cwd());
  const envelope = `## Envelope Directives
- **Zero Hallucination:** Inspect exact symbol definitions before editing.
- **Verification:** Execute project verification suite and ensure 0 errors.
- **Anti-Patch / Zero Out-of-band Scripts:** Do NOT create workaround runner scripts (e.g. patch.sh, test-fix.sh) or disable assertions to pass tests.`;

  const { testCmd, buildCmd } = resolveProjectCommands(process.cwd());
  const verifyDirective = testCmd || buildCmd 
    ? `\n\nVERIFICATION DIRECTIVE: Execute \`${[testCmd, buildCmd].filter(Boolean).join(" && ")}\` after patching.`
    : "";

  fullPrompt = redactSecrets(`MCP DIRECTIVE: ${rawPrompt.trim()}${verifyDirective}\n\n---\n\n${envelope}\n\n---\n\n${dynamicRules ? `${dynamicRules}\n\n---\n\n` : ""}${baseRules.trim()}`);

  const dateStr = new Date().toISOString().split("T")[0];
  const slug = taskTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

  historyFile = logToHistory(
    `dispatch-${slug}.md`,
    `---\ntype: jules_dispatch\ntitle: "${taskTitle}"\ntimestamp: "${new Date().toISOString()}"\n---\n# Jules Task Dispatch: ${taskTitle}\n\n## Prompt\n${rawPrompt}\n`,
    "dispatch"
  );

  log.info(`Dispatching task to Google Jules: "${taskTitle}"...`);
  log.success(`Logged dispatch history to: ${path.relative(process.cwd(), historyFile)}`);

  const payloadHash = crypto.createHash("sha256").update(taskTitle + Date.now()).digest("hex").slice(0, 12);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jules-payload-"));
  tmpPayloadFile = path.join(tmpDir, `payload_${payloadHash}.json`);
  fs.writeFileSync(tmpPayloadFile, JSON.stringify({ repo, title: taskTitle, prompt: fullPrompt }), { mode: 0o600 });
}

function cleanupTmp() {
  try {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch (err) {
    log.warn(`⚠️ Failed to remove temporary payload directory at ${tmpDir}: ${err.message}`);
  }
}

async function executeDispatch() {
  try {
    if (process.env.JULES_DRY_RUN === "true" || process.env.JULES_DRY_RUN === "1") {
      log.dim(`[DRY RUN] Dispatch payload prepared successfully for task: "${taskTitle}".`);
      log.dim(`[DRY RUN] Target Repository: ${repo || "(default)"}`);
      log.dim(`[DRY RUN] Prompt Length: ${fullPrompt.length} chars.`);
      return;
    }

    if (apiKey && repo) {
      log.info(`Using Jules REST API for repository ${repo}...`);
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
        const apiUrl = process.env.JULES_API_URL || "https://jules.googleapis.com/v1alpha/sessions";
        res = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "X-Goog-Api-Key": apiKey,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload)
        });
      } catch (fetchErr) {
        log.warn(`⚠️ REST API request failed (network error), falling back to CLI...`, fetchErr.message);
        dispatchViaCli(repo, tmpPayloadFile, taskTitle);
        return;
      }

      if (res.status === 429) {
        log.error(`❌ Jules REST API Rate Limit Exceeded (HTTP 429). Will NOT fallback to CLI.`);
        process.exit(1);
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        log.warn(`⚠️ REST API returned HTTP ${res.status}: ${errText}, falling back to CLI...`);
        dispatchViaCli(repo, tmpPayloadFile, taskTitle);
        return;
      }

      let sessionId = "Created";
      try {
        const data = await res.json();
        const { sessionId: sId, status: responseStatus } = data;
        sessionId = sId || data.name || data.id || sessionId;
        log.success(`REST API Dispatch response: Session ${sessionId} created successfully.`);
        fs.appendFileSync(historyFile, `\n## Session\n- ID: \`${sessionId}\`\n`);
      } catch (jsonErr) {
        log.warn("⚠️ Failed to parse REST API JSON response:", jsonErr.message);
      }
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
      } catch (jsonErr) {
        log.warn(`⚠️ Failed to parse payload JSON file: ${jsonErr.message}`);
      }
    }

    const args = ["new"];
    if (targetRepo) {
      args.push("--repo", targetRepo);
    }

    log.step("💻", `Executing: jules ${args.join(" ")} (prompt passed via stdin)...`);
    execFileSync("jules", args, { input: promptToSend, stdio: ["pipe", "inherit", "inherit"] });
    log.success(`Successfully dispatched task "${title}" to Jules CLI.`);
  } catch (error) {
    log.error(`Failed to dispatch task to Jules CLI: ${error.message}`);
    process.exit(1);
  }
}

if (isMainModule) {
  executeDispatch().catch((err) => {
    log.error(`❌ Fatal unhandled rejection in dispatch: ${err.message}`);
    process.exit(1);
  });
}
