#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import readline from "node:readline/promises";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { resolveProjectCommands } from "../scripts/command-resolver.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const kitRoot = path.resolve(__dirname, "..");
const targetDir = process.cwd();

let isHelp = false;
let isForce = false;
let isInteractive = false;

try {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", short: "h", default: false },
      force: { type: "boolean", short: "f", default: false },
      interactive: { type: "boolean", short: "i", default: false },
    },
    allowPositionals: true,
  });
  isHelp = values.help;
  isForce = values.force;
  isInteractive = values.interactive;
} catch (err) {
  isHelp = process.argv.includes("--help") || process.argv.includes("-h");
  isForce = process.argv.includes("--force") || process.argv.includes("-f");
  isInteractive = process.argv.includes("--interactive") || process.argv.includes("-i");
}

if (isHelp) {
  console.log(`
Google Jules Orchestration Kit - Init Scaffolding CLI

Usage:
  npx jules-orchestrator-kit [options]
  npx jules-init [options]

Options:
  -f, --force          Overwrite existing AGENTS.md, .agent/jules.yml, and orchestration scripts.
  -i, --interactive    Launch interactive wizard to prompt for repository and branch configuration.
  -h, --help           Show this help message.
`);
  process.exit(0);
}

console.log("\n🚀 Initializing Google Jules Orchestration Kit...\n");
console.log(`📁 Target Directory: ${targetDir}`);
if (isForce) console.log("⚠️ Force mode enabled (existing files will be overwritten).");

let answerRepoVal = "";
let answerBranchVal = "";

if (process.stdin.isTTY && (isInteractive || (!fs.existsSync(path.join(targetDir, ".agent/jules.yml")) && !process.env.CI))) {
  try {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('SIGINT', () => {
      console.log("\n🛑 Initialization aborted by user.");
      process.exit(130);
    });
    const answerRepo = await rl.question("📦 Enter target GitHub repository (e.g. owner/repo) [optional]: ");
    if (answerRepo.trim()) {
      answerRepoVal = answerRepo.trim();
      process.env.JULES_REPO = answerRepoVal;
    }
    const answerBranch = await rl.question("🌿 Enter base branch [default: main]: ");
    if (answerBranch.trim()) {
      answerBranchVal = answerBranch.trim();
      process.env.BASE_BRANCH = answerBranchVal;
    }
    rl.close();
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log("\n🛑 Initialization aborted by user.");
      process.exit(130);
    }
    console.warn("⚠️ Interactive setup prompt failed:", err.message);
  }
}

// 0. Persist wizard values to .env if provided
const envPath = path.join(targetDir, ".env");
let envAdditions = [];
if (answerRepoVal) envAdditions.push(`JULES_REPO="${answerRepoVal}"`);
if (answerBranchVal) envAdditions.push(`BASE_BRANCH="${answerBranchVal}"`);

if (envAdditions.length > 0) {
  if (fs.existsSync(envPath)) {
    const existingEnv = fs.readFileSync(envPath, "utf-8");
    const toAppend = envAdditions.filter((line) => {
      const key = line.split("=")[0];
      return !existingEnv.includes(`${key}=`);
    });
    if (toAppend.length > 0) {
      fs.appendFileSync(envPath, `\n${toAppend.join("\n")}\n`, "utf-8");
      console.log("✅ Appended interactive configuration to .env");
    }
  } else {
    fs.writeFileSync(envPath, `${envAdditions.join("\n")}\n`, "utf-8");
    console.log("✅ Created: .env with repository configuration");
  }
}

// 1. Detect Stack & Manifests
const detected = resolveProjectCommands(targetDir);
console.log(`🔍 Detected Project Type: ${detected.source}`);
if (detected.testCmd || detected.buildCmd) {
  console.log(`   - Test Command:  ${detected.testCmd || "(none)"}`);
  console.log(`   - Build Command: ${detected.buildCmd || "(none)"}`);
}

// 2-3. Scaffold AGENTS.md, .agent/ structure, role prompts, rules and workflows.
// Shared with `agentctl init` so the two entry points cannot scaffold different
// repositories — which is exactly what they used to do, with the README's
// quickstart pointing at the one that scaffolded less.
const { scaffoldRepoAssets } = await import("../src/scaffold.mjs");
const scaffolded = scaffoldRepoAssets(targetDir, { force: isForce });
for (const item of scaffolded.created) {
  console.log(`✅ Created: ${item}`);
}

const agentDir = path.join(targetDir, ".agent");

// Scaffold .agent/jules.yml
const yamlConfigPath = path.join(agentDir, "jules.yml");
if (!fs.existsSync(yamlConfigPath) || isForce) {
  const yamlContent = `# Google Jules Repository Configuration (Version 2)
version: 2
test_cmd: "${detected.testCmd || "npm test"}"
build_cmd: "${detected.buildCmd || "npm run build"}"
forbidden_paths: [".github/**", "**/.env*", "**/*.pem", "**/lock-manager*"]
`;
  fs.writeFileSync(yamlConfigPath, yamlContent, "utf-8");
  console.log("✅ Created: .agent/jules.yml");
}

// Scaffold .github/workflows/jules-audit.yml
const githubWorkflowsDir = path.join(targetDir, ".github/workflows");
const auditWfSource = path.join(kitRoot, ".github/workflows/jules-audit.yml");
const auditWfTarget = path.join(githubWorkflowsDir, "jules-audit.yml");

if (fs.existsSync(auditWfSource)) {
  if (!fs.existsSync(githubWorkflowsDir)) {
    fs.mkdirSync(githubWorkflowsDir, { recursive: true });
  }
  if (!fs.existsSync(auditWfTarget) || isForce) {
    fs.copyFileSync(auditWfSource, auditWfTarget);
    console.log("✅ Added GitHub Actions workflow: .github/workflows/jules-audit.yml");
  }
}

// 4. Copy scripts/ directory with PER-FILE existence guard
const targetScriptsDir = path.join(targetDir, "scripts");
if (!fs.existsSync(targetScriptsDir)) {
  fs.mkdirSync(targetScriptsDir, { recursive: true });
}

const sourceScriptsDir = path.join(kitRoot, "scripts");
let copiedCount = 0;
let skippedCount = 0;

if (fs.existsSync(sourceScriptsDir)) {
  const scriptFiles = fs.readdirSync(sourceScriptsDir);
  const excludeFiles = new Set(["release.mjs"]);
  scriptFiles.forEach((file) => {
    if (excludeFiles.has(file)) return;
    const srcFile = path.join(sourceScriptsDir, file);
    const destFile = path.join(targetScriptsDir, file);
    if (!fs.existsSync(destFile) || isForce) {
      fs.copyFileSync(srcFile, destFile);
      try {
        fs.chmodSync(destFile, 0o755);
      } catch (err) {
        console.warn(`⚠️ Could not set executable permissions on ${file}:`, err.message);
      }
      copiedCount++;
    } else {
      skippedCount++;
    }
  });
  console.log(`✅ Copied ${copiedCount} orchestration scripts to ./scripts/ (${skippedCount} skipped, use --force to overwrite)`);
}

// 5. Optionally inject scripts into target package.json if present
const targetPkgPath = path.join(targetDir, "package.json");
if (fs.existsSync(targetPkgPath) && targetDir !== kitRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(targetPkgPath, "utf-8"));
    pkg.scripts = pkg.scripts || {};
    let updated = false;
    const julesScripts = {
      "jules:dispatch": "agentctl dispatch",
      "jules:queue": "agentctl queue",
      "jules:create": "agentctl task create",
      "jules:status": "agentctl status",
      "jules:audit": "agentctl gate",
      "jules:scan": "agentctl scan",
      "jules:swarm": "agentctl swarm",
      "jules:nightly": "agentctl clean"
    };

    for (const [key, val] of Object.entries(julesScripts)) {
      if (!pkg.scripts[key] || isForce) {
        pkg.scripts[key] = val;
        updated = true;
      }
    }

    if (updated) {
      fs.writeFileSync(targetPkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
      console.log("✅ Added Jules commands to package.json");
    }
  } catch (err) {
    console.warn("⚠️ Failed to inject helper scripts into target package.json:", err.message);
  }
}

// 5b. The .gitignore entries are written by scaffoldRepoAssets above, so the
// two entry points cannot disagree about which runtime paths stay untracked.
if (scaffolded.gitignore.length > 0) {
  console.log(`✅ Added ${scaffolded.gitignore.length} runtime state entries to .gitignore`);
}

console.log("\n🎉 Google Jules Orchestration Kit successfully initialized!");

// 6. Generate Encoded Workspace Manifest (JULES_WEB_SETUP.md)
const agentState = {
  v: 1,
  schema: "jules.init/v1",
  generatedAt: new Date().toISOString(),
  repo: {
    name: answerRepoVal || process.env.JULES_REPO || "unknown/repo",
    branch: answerBranchVal || process.env.BASE_BRANCH || "main"
  },
  workspace: {
    testCmd: detected.testCmd || "",
    buildCmd: detected.buildCmd || "",
    source: detected.source || "unknown"
  }
};

const canonicalJson = JSON.stringify(agentState);
const hash = crypto.createHash("sha256").update(canonicalJson, "utf8").digest("hex");
const compressed = zlib.brotliCompressSync(Buffer.from(canonicalJson, "utf8"));
const payloadToken = `JULES1.${hash}.${compressed.toString("base64url")}`;

const setupMdContent = `# Google Jules Encoded Workspace Manifest

> **Generated**: ${agentState.generatedAt}
> **Workspace Manifest Code**: \`${payloadToken}\`

## 🔗 Official Setup & Documentation
1. Documentation & Guide: https://jules.google
2. Workspace Manifest Code:
\`\`\`
${payloadToken}
\`\`\`

## 🔧 Detected Configuration
* Test Command: \`${agentState.workspace.testCmd}\`
* Build Command: \`${agentState.workspace.buildCmd}\`
* Source: \`${agentState.workspace.source}\`
`;

fs.writeFileSync(path.join(targetDir, ".agent", "JULES_WEB_SETUP.md"), setupMdContent, "utf-8");

console.log("\n🔗 Google Jules Setup Complete");
console.log("  Your local agent configurations are ready.");
console.log(`  👉 Encoded Workspace Manifest: \x1b[36m${payloadToken}\x1b[0m`);
console.log("\n  (A backup was written to .agent/JULES_WEB_SETUP.md)");
console.log("\nNext Steps:");
console.log("  1. See official documentation at https://jules.google");
console.log("  2. Set environment variables: JULES_REPO=\"owner/repo\"");
console.log("  3. Scaffold a new task: npm run jules:create \"My Feature\"");
console.log("  4. Dispatch the queue:  npm run jules:queue");
console.log("  5. Run pre-merge audit: npm run jules:audit\n");
