#!/usr/bin/env node

import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, resolveRoot, detectStack, bootstrapZeroTestRepo } from "../src/config.mjs";
import { gate, dispatch, run, isTaskFile } from "../src/engine.mjs";
import { acquireLock, releaseLock, lockStatus, checkDailyBudget, getQueueDir, ensureDir } from "../src/state.mjs";
import { worktreePrune } from "../src/git.mjs";
import { reapOrphanedIntents, reapStaleMutexDirs } from "../src/journal.mjs";

const args = process.argv.slice(2);
const command = args[0];

function printHelp() {
  console.log(`
🚀 agentctl v0.27.1 — Universal Agent Orchestrator & Safety Gatekeeper

Usage: agentctl <command> [options]

Commands:
  dispatch              Dispatch a single task to an AI agent
  gate | audit          Run CI security and verification gate against current branch
  queue                 Run pending task queue
  swarm                 Run parallel task swarm
  mcp                   Start stdio Model Context Protocol (MCP) server
  clean                 Clean stale branches, worktrees, locks, and ledgers
  lock <action>         Manage mutex locks (acquire | release | status | cleanup)
  doctor                Run system diagnostics and stack resolution checks
  bootstrap             Bootstrap zero-test repository with verification oracle
  review-repair         Parse PR review comments and synthesize OODA repair tasks
  dashboard             Start local HTTP telemetry and audit dashboard
  init                  Scaffold .agent/ directory and config.yml
  version               Output agentctl version

Options:
  --dry-run, -d         Simulate action without making API calls or modifying git
  --json, -j            Emit machine-readable JSON output
  --help, -h            Show command help
`);
}

async function main() {
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  if (command === "version" || command === "--version" || command === "-v") {
    console.log("agentctl v0.27.0");
    process.exit(0);
  }

  const root = resolveRoot();
  reapOrphanedIntents(root);
  reapStaleMutexDirs(root);
  const config = loadConfig(root);

  switch (command) {
    case "dispatch": {
      const { values } = parseArgs({
        args: args.slice(1),
        options: {
          title: { type: "string", short: "t" },
          prompt: { type: "string", short: "p" },
          "prompt-file": { type: "string", short: "f" },
          "dry-run": { type: "boolean", short: "d" },
          json: { type: "boolean", short: "j" },
        },
        allowPositionals: true,
      });

      let promptContent = values.prompt || "";
      if (values["prompt-file"] && existsSync(values["prompt-file"])) {
        promptContent = readFileSync(values["prompt-file"], "utf-8");
      }

      if (!promptContent && args[1] && !args[1].startsWith("-")) {
        promptContent = args.slice(1).join(" ");
      }

      if (!promptContent) {
        console.error("Error: --prompt or --prompt-file is required.");
        process.exit(1);
      }

      const task = {
        title: values.title || "CLI Dispatch Task",
        prompt: promptContent,
      };

      try {
        const session = await dispatch(task, { root, config, dryRun: values["dry-run"] });
        if (values.json) {
          console.log(JSON.stringify({ ok: true, session }, null, 2));
        } else {
          console.log(`\n✅ Task Dispatched Successfully!`);
          console.log(`   Session ID  : ${session.id}`);
          console.log(`   Session URL : ${session.url || "N/A"}`);
        }
        process.exit(0);
      } catch (err) {
        if (values.json) {
          console.log(JSON.stringify({ ok: false, error: err.message, code: err.code || 1 }, null, 2));
        } else {
          console.error(`❌ Dispatch Failed: ${err.message}`);
        }
        process.exit(err.code || 1);
      }
      break;
    }

    case "gate":
    case "audit": {
      const { values } = parseArgs({
        args: args.slice(1),
        options: {
          base: { type: "string", short: "b", default: config.baseBranch || "main" },
          fix: { type: "boolean" },
          "allow-protected": { type: "boolean" },
          json: { type: "boolean", short: "j" },
        },
        allowPositionals: true,
      });

      const res = await gate({
        root,
        config,
        base: values.base,
        fix: values.fix,
        allowProtected: values["allow-protected"],
      });

      if (values.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(`\n🛡️ agentctl Safety Gate Audit Results (Base: ${values.base})`);
        console.log(`-----------------------------------------------------`);
        for (const p of res.phases) {
          const status = p.ok ? "✅ PASS" : "❌ FAIL";
          console.log(`  Phase [${p.phase.toUpperCase()}] : ${status}`);
          if (p.violations) {
            p.violations.forEach((v) => console.log(`     - Violation: ${v.file} (Rule: ${v.rule})`));
          }
          if (p.findings) {
            p.findings.forEach((f) => console.log(`     - Finding: ${f.id} at line ${f.line}`));
          }
        }
        console.log(`-----------------------------------------------------`);
        console.log(`Overall Result: ${res.ok ? "APPROVED (Exit 0)" : `REJECTED (Exit ${res.code})`}\n`);
      }

      process.exit(res.code);
      break;
    }

    case "queue": {
      const queueDir = getQueueDir(root);
      const files = readdirSync(queueDir).filter((f) => isTaskFile(f, queueDir));
      console.log(` Found ${files.length} queued task(s) in .agent/queue/`);
      if (files.length > 0) {
        const tasks = files.map((f) => ({
          id: f,
          title: f.replace(/\.md$/, ""),
          prompt: readFileSync(join(queueDir, f), "utf-8"),
        }));
        const results = await run(tasks, { root, config });
        console.log(`\nProcessed ${results.length} tasks.`);
      }
      process.exit(0);
      break;
    }

    case "swarm": {
      console.log("🚀 Running Swarm Orchestrator...");
      const queueDir = getQueueDir(root);
      const files = readdirSync(queueDir).filter((f) => isTaskFile(f, queueDir));
      if (files.length === 0) {
        console.log("No pending tasks found for swarm.");
        process.exit(0);
      }
      const tasks = files.map((f) => ({
        id: f,
        title: f.replace(/\.md$/, ""),
        prompt: readFileSync(join(queueDir, f), "utf-8"),
      }));
      const results = await run(tasks, { root, config, concurrency: config.limits.concurrency || 3 });
      console.log(`Swarm completed ${results.length} tasks.`);
      process.exit(0);
      break;
    }

    case "clean": {
      console.log("🧹 Running System Cleanup...");
      worktreePrune(root);
      console.log("  ✅ Pruned stale Git worktrees.");
      process.exit(0);
      break;
    }

    case "lock": {
      const action = args[1];
      if (action === "acquire") {
        const agent = args[2] || "agent";
        const taskId = args[3] || "task-1";
        const filePaths = args.slice(4);
        const res = acquireLock(agent, taskId, filePaths, root);
        if (res.ok) {
          console.log(`✅ Acquired lock for ${taskId}`);
        } else {
          console.log(`❌ Lock conflict detected: held by ${res.holder}`);
          process.exit(1);
        }
      } else if (action === "release") {
        const taskId = args[2] || "task-1";
        const ok = releaseLock(taskId, root);
        if (ok) {
          console.log(`✅ Released lock for ${taskId}`);
        } else {
          console.log(`❌ Lock for ${taskId} not found or release failed`);
          process.exit(1);
        }
      } else {
        const locks = lockStatus(root);
        console.log(`Active Locks (${locks.length}):`, locks);
      }
      process.exit(0);
      break;
    }

    case "doctor": {
      console.log(`\n🔍 agentctl System Diagnostics (v0.25.1)`);
      console.log(`--------------------------------------------------`);
      console.log(`  Project Root     : ${root}`);
      console.log(`  Config File      : ${config._file || "None (Using defaults)"}`);
      console.log(`  Detected Stack   : ${detectStack(root).stack}`);
      console.log(`  Test Command     : ${config.verify.test || "(None)"}`);
      console.log(`  Build Command    : ${config.verify.build || "(None)"}`);
      const budget = checkDailyBudget(root, config.limits.dailyTasks);
      console.log(`  Daily Budget     : ${budget.used} / ${budget.budget} sessions used`);
      console.log(`--------------------------------------------------\n`);
      process.exit(0);
      break;
    }

    case "bootstrap": {
      const { values } = parseArgs({
        args: args.slice(1),
        options: {
          force: { type: "boolean", short: "f" },
        },
        allowPositionals: true,
      });

      const res = bootstrapZeroTestRepo(root, { force: values.force });
      if (res.bootstrapped) {
        console.log(`✅ Zero-test repo bootstrapped successfully!`);
        console.log(`   Stack detected : ${res.stack}`);
        console.log(`   Oracle TestCmd : ${res.testCmd}`);
        console.log(`   Config written : ${res.configPath}`);
      } else {
        console.log(`ℹ️ Repository already has a verification oracle (${res.testCmd}). Use --force to overwrite.`);
      }
      process.exit(0);
      break;
    }

    case "review-repair": {
      const fileArg = args[1];
      if (!fileArg || !existsSync(fileArg)) {
        console.error("Error: Please provide a valid JSON file containing PR review comments.");
        process.exit(1);
      }
      const { parseReviewComments, createReviewRepairTask } = await import("../src/review-repair.mjs");
      const raw = readFileSync(fileArg, "utf-8");
      const comments = parseReviewComments(raw);
      console.log(`✅ Parsed ${comments.length} actionable review comment(s).`);
      for (const c of comments) {
        const task = createReviewRepairTask(c);
        console.log(`   Task: ${task.title} (Author: @${c.author}, Line: ${c.line || "N/A"})`);
      }
      process.exit(0);
      break;
    }

    case "dashboard": {
      const port = Number(args[1] || 4100);
      const { startDashboardServer } = await import("../src/dashboard.mjs");
      startDashboardServer(port, root);
      break;
    }

    case "init": {
      const agentDir = join(root, ".agent");
      ensureDir(agentDir);
      const configPath = join(agentDir, "config.yml");
      if (!existsSync(configPath)) {
        writeFileSync(
          configPath,
          `version: 1
provider: jules
limits:
  diff_kb: 75
  daily_tasks: 300
branch_prefix: agent/
base_branch: main
`,
          "utf-8"
        );
        console.log(`✅ Created .agent/config.yml`);
      } else {
        console.log(`ℹ️ .agent/config.yml already exists.`);
      }
      process.exit(0);
      break;
    }

    case "mcp": {
      const { startMcpServer } = await import("../src/mcp.mjs");
      startMcpServer();
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[FATAL ERROR] ${err.message}`);
  process.exit(err.code || 1);
});
