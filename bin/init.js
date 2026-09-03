#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import readline from "node:readline/promises";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { resolveProjectCommands } from "../scripts/command-resolver.mjs";
import { KIT_VERSION } from "../src/version.mjs";
import { detectStack } from "../src/config.mjs";

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

console.log("\n🚀 Initializing agent orchestrator kit...\n");
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

// Scaffold the manifest pair.
//
// This entry point used to hand-roll a thinner `.agent/jules.yml` while
// `agentctl init` wrote a `.agent/config.yml` the runtime actually reads, so
// which of the two scaffolders you happened to run decided whether the
// repository had a provider, a tier and a verification profile at all. Both
// now go through `planInit`.
const { planInit } = await import("../src/wizard-init.mjs");
const initPlan = planInit(targetDir, {
  testCmd: detected.testCmd,
  buildCmd: detected.buildCmd,
  lintCmd: detected.lintCmd,
  baseBranch: answerBranchVal || process.env.BASE_BRANCH || undefined,
});

const configPath = path.join(agentDir, "config.yml");
if (!fs.existsSync(configPath) || isForce) {
  fs.writeFileSync(configPath, initPlan.configYaml, "utf-8");
  console.log(`✅ Created: .agent/config.yml (provider: ${initPlan.provider}, profile: ${initPlan.profile})`);
}

const yamlConfigPath = path.join(agentDir, "jules.yml");
if (!fs.existsSync(yamlConfigPath) || isForce) {
  fs.writeFileSync(yamlConfigPath, initPlan.julesYaml, "utf-8");
  console.log("✅ Created: .agent/jules.yml");
}

// 3b. Generate a CI gate workflow for *this* repository's stack.
//
// This used to copy the kit's own audit workflow verbatim: a nine-way Node
// matrix running `npm install`, `npm test` and a script path that exists only
// inside the kit. In a Rust, Python or Go repository it was red on the first
// push for reasons that had nothing to do with that repository's code.
const { writeCiWorkflow } = await import("../src/ci-templates.mjs");
const ciRes = writeCiWorkflow(targetDir, {
  target: "github",
  force: isForce,
  // `resolveProjectCommands` reports a human-readable source string; the CI
  // generator needs the machine-readable stack id.
  stack: detectStack(targetDir),
  config: { baseBranch: answerBranchVal || process.env.BASE_BRANCH || "main" },
  version: KIT_VERSION,
});
if (ciRes.ok && ciRes.written) {
  console.log(`✅ Generated CI gate for '${ciRes.stack}': ${ciRes.file}`);
} else if (ciRes.ok) {
  console.log(`↩️  Kept existing ${ciRes.file} (use --force to regenerate)`);
}

// 4. The kit's own scripts/ directory is NOT copied here.
//
// It used to be — twenty orchestration scripts dropped into the target repo's
// scripts/ folder, where they collided with the project's own files, aged
// independently of the installed kit, and duplicated commands that `agentctl`
// already exposes. Everything they did is reachable through the CLI, which is
// what the injected package.json entries below point at.

// 5. Optionally inject scripts into target package.json if present
const targetPkgPath = path.join(targetDir, "package.json");
if (fs.existsSync(targetPkgPath) && targetDir !== kitRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(targetPkgPath, "utf-8"));
    pkg.scripts = pkg.scripts || {};
    let updated = false;
    // Vendor-neutral names: these run `agentctl`, which dispatches to whichever
    // provider the repository selected. `jules:*` entries from an older init are
    // left in place — removing scripts a project may reference in CI is not
    // this command's business.
    const agentScripts = {
      "agent:gate": "agentctl check",
      "agent:dispatch": "agentctl dispatch",
      "agent:queue": "agentctl queue",
      "agent:create": "agentctl task create",
      "agent:status": "agentctl status",
      "agent:doctor": "agentctl doctor",
      "agent:swarm": "agentctl swarm",
      "agent:clean": "agentctl clean"
    };

    for (const [key, val] of Object.entries(agentScripts)) {
      if (!pkg.scripts[key] || isForce) {
        pkg.scripts[key] = val;
        updated = true;
      }
    }

    if (updated) {
      fs.writeFileSync(targetPkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
      console.log("✅ Added agent:* commands to package.json");
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

console.log("\n🎉 Agent orchestrator kit initialized.");

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

// The encoded manifest is a Google Jules convenience — it pastes the detected
// workspace into the Jules web UI. It is written unconditionally because it
// costs nothing and a repository can change provider later, but it is only
// *announced* when Jules is the provider this repo actually selected;
// otherwise it is one more Google-specific string in the way of someone who
// chose a different agent.
if (initPlan.provider === "jules") {
  console.log("\n🔗 Google Jules workspace manifest");
  console.log(`  👉 Paste into the Jules web UI: \x1b[36m${payloadToken}\x1b[0m`);
  console.log("  (A copy was written to .agent/JULES_WEB_SETUP.md)");
} else {
  console.log(`\n  Provider: ${initPlan.provider}. A Google Jules workspace manifest was also written to .agent/JULES_WEB_SETUP.md if you ever switch.`);
}
console.log("\nNext Steps:");
console.log("  1. Pick a provider:      agentctl providers   (jules | claude-code | codex | gemini)");
console.log("  2. Pick a gate depth:    agentctl profile --list   (minimal | standard | max)");
console.log("  3. Scaffold a task:      agentctl task create");
console.log("  4. Dispatch the queue:   agentctl queue");
console.log("  5. Run the pre-merge gate: agentctl check\n");
console.log("  Not sure? Run `agentctl` with no arguments — it reads the repo and names one step.\n");
