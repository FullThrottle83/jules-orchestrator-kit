#!/usr/bin/env node

import { parseArgs } from "node:util";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, resolveRoot, detectStack, bootstrapZeroTestRepo } from "../src/config.mjs";
import { gate, dispatch, run, isTaskFile } from "../src/engine.mjs";
import { acquireLock, releaseLock, lockStatus, checkDailyBudget, getQueueDir } from "../src/state.mjs";
import { worktreePrune } from "../src/git.mjs";
import { reapOrphanedIntents, reapStaleMutexDirs } from "../src/journal.mjs";

const args = process.argv.slice(2);
const command = args[0];

function printHelp() {
  console.log(`
🚀 agentctl v0.32.0 — Universal Agent Orchestrator & Safety Gatekeeper

Usage: agentctl <command> [options]

Commands:
  dispatch | create     Dispatch a single task to an AI agent
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
  init                  Scaffold .agent/ config and run onboarding wizard
  task create           Interactively author and scope a Jules task envelope
  task optimize         Linter & optimizer for Jules task prompts (--fix, --json)
  test-gen              Scaffold & run automated TDD Red-to-Green test cycle (--run)
  mcp init              Scaffold IDE integration config (cursor | vscode | claude | all)
  rollback              Restore git state & working tree to atomic pre-flight checkpoint
  resume                Resume warm session with human response (--response "<text>")
  status                Display queue and system status summary
  scan                  Scan codebase for TODO/FIXME task candidates
  hydrate [prompt]      Prepend active system learnings and baton-pass state to a prompt
  harvest               Harvest failure traces and record/quarantine resolution rules
  learning add          Record a system learning rule into .agent/knowledge/
  version               Output agentctl version

Options:
  --dry-run, -d         Simulate action without making API calls or modifying git
  --mode, -m            Gate evaluation mode (working-tree | committed | staged)
  --repoless            Dispatch task in repoless execution mode
  --source, -s          Specify Jules repository source name
  --branch, -b          Specify target starting branch
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
    console.log("agentctl v0.32.0");
    process.exit(0);
  }

  const root = resolveRoot();
  reapOrphanedIntents(root);
  reapStaleMutexDirs(root);
  const config = loadConfig(root);

  switch (command) {
    case "dispatch":
    case "create": {
      const { values } = parseArgs({
        args: args.slice(1),
        options: {
          title: { type: "string", short: "t" },
          prompt: { type: "string", short: "p" },
          "prompt-file": { type: "string", short: "f" },
          source: { type: "string", short: "s" },
          branch: { type: "string", short: "b" },
          repoless: { type: "boolean" },
          "auto-pr": { type: "boolean" },
          "require-plan-approval": { type: "boolean" },
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
        source: values.source,
        branch: values.branch,
        repoless: values.repoless,
        autoPr: values["auto-pr"],
        requirePlanApproval: values["require-plan-approval"],
      };

      try {
        const session = await dispatch(task, {
          root,
          config,
          dryRun: values["dry-run"],
          repoless: values.repoless,
          source: values.source,
          branch: values.branch,
        });
        if (values.json) {
          console.log(JSON.stringify({ ok: true, session }, null, 2));
        } else {
          console.log(`\n✅ Task Dispatched Successfully!`);
          console.log(`   Session ID  : ${session.id}`);
          console.log(`   Session URL : ${session.url || "N/A"}`);
        }
        process.exit(0);
      } catch (err) {
        const exitCode = typeof err.code === "number" ? err.code : 1;
        if (values.json) {
          console.log(JSON.stringify({ ok: false, error: err.message, code: exitCode }, null, 2));
        } else {
          console.error(`❌ Dispatch Failed: ${err.message}`);
        }
        process.exit(exitCode);
      }
      break;
    }

    case "gate":
    case "audit": {
      const { values } = parseArgs({
        args: args.slice(1),
        options: {
          base: { type: "string", short: "b", default: config.baseBranch || "main" },
          mode: { type: "string", short: "m", default: "working-tree" },
          "working-tree": { type: "boolean" },
          staged: { type: "boolean" },
          committed: { type: "boolean" },
          fix: { type: "boolean" },
          "allow-protected": { type: "boolean" },
          json: { type: "boolean", short: "j" },
        },
        allowPositionals: true,
      });

      let selectedMode = values.mode || "working-tree";
      if (values.staged) selectedMode = "staged";
      if (values.committed) selectedMode = "committed";
      if (values["working-tree"]) selectedMode = "working-tree";

      const res = await gate({
        root,
        config,
        base: values.base,
        mode: selectedMode,
        fix: values.fix,
        allowProtected: values["allow-protected"],
      });

      if (values.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(`\n🛡️ agentctl Safety Gate Audit Results (Base: ${values.base}, Mode: ${selectedMode})`);
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

      process.exit(typeof res.code === "number" ? res.code : 0);
      break;
    }

    case "queue": {
      const queueDir = getQueueDir(root);
      const files = readdirSync(queueDir).filter((f) => isTaskFile(f, queueDir));
      console.log(`Found ${files.length} queued task(s) in .agent/queue/`);
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
      console.log(`\n🔍 agentctl System Diagnostics (v0.29.1)`);
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
      const { values } = parseArgs({
        args: args.slice(1),
        options: {
          interactive: { type: "boolean", short: "i" },
          tier: { type: "string", short: "t" },
          json: { type: "boolean", short: "j" },
        },
        allowPositionals: true,
      });

      const { runInitWizard } = await import("../src/wizard-init.mjs");
      const res = await runInitWizard(root, {
        interactive: values.interactive !== false,
        tier: values.tier || "pro",
      });

      if (values.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(`✅ Onboarding complete! Manifest generated at ${res.configPath}`);
        console.log(`   Tier: ${res.plan.tier.toUpperCase()} (${res.plan.limits.concurrency} worker(s), ${res.plan.limits.daily_tasks} daily tasks)`);
        console.log(`   Verification Test Command : "${res.plan.verify.test}"`);
        console.log(`   Active Presets            : ${res.plan.presets.join(", ")}`);
      }
      process.exit(0);
      break;
    }

    case "task": {
      const subCommand = args[1] || "create";
      if (subCommand === "create") {
        const { values } = parseArgs({
          args: args.slice(2),
          options: {
            title: { type: "string", short: "t" },
            prompt: { type: "string", short: "p" },
            "verify-cmd": { type: "string", short: "v" },
            "auto-pr": { type: "boolean" },
            "require-plan-approval": { type: "boolean" },
            repoless: { type: "boolean" },
            json: { type: "boolean", short: "j" },
          },
          allowPositionals: true,
        });

        const { runTaskCreateWizard } = await import("../src/wizard-task.mjs");
        const res = await runTaskCreateWizard(root, {
          title: values.title,
          prompt: values.prompt,
          verifyCmd: values["verify-cmd"],
          autoPr: values["auto-pr"],
          requirePlanApproval: values["require-plan-approval"],
          repoless: values.repoless,
        });

        if (values.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`✅ Task synthesized & queued at ${res.taskFile}`);
          console.log(`   Task ID  : ${res.plan.taskId}`);
          console.log(`   Title    : ${res.plan.title}`);
          console.log(`   Auto-PR  : ${res.plan.flags.autoPr}`);
        }
        process.exit(0);
      } else if (subCommand === "optimize") {
        const { values, positionals } = parseArgs({
          args: args.slice(2),
          options: {
            fix: { type: "boolean", short: "f" },
            file: { type: "string" },
            dir: { type: "string", short: "d" },
            json: { type: "boolean", short: "j" },
            "verify-cmd": { type: "string", short: "v" },
          },
          allowPositionals: true,
        });

        const { scorePromptFalsifiability, optimizeTaskPrompt } = await import("../src/task-optimizer.mjs");
        const targetDir = values.dir ? resolve(values.dir) : root;
        let promptText = positionals.join(" ");

        if (values.file) {
          if (existsSync(values.file)) {
            promptText = readFileSync(values.file, "utf-8");
          } else {
            console.error(`Error: File '${values.file}' does not exist.`);
            process.exit(1);
          }
        }

        if (values.fix) {
          const opt = optimizeTaskPrompt(promptText, { rootDir: targetDir, verifyCmd: values["verify-cmd"] });
          if (values.json) {
            console.log(JSON.stringify(opt, null, 2));
          } else {
            console.log(opt.optimizedPrompt);
          }
          process.exit(0);
        }

        const analysis = scorePromptFalsifiability(promptText, { rootDir: targetDir, verifyCmd: values["verify-cmd"] });
        if (values.json) {
          console.log(JSON.stringify(analysis, null, 2));
        } else {
          console.log(`\n🎯 Task Prompt Falsifiability Analysis`);
          console.log(`--------------------------------------------------`);
          console.log(`  Score / Grade    : ${analysis.score} / 100 (${analysis.grade})`);
          console.log(`  Falsifiable      : ${analysis.isFalsifiable ? "✅ YES" : "❌ NO"}`);
          if (analysis.oracle.command) {
            console.log(`  Oracle Command   : "${analysis.oracle.command}" (${analysis.oracle.autoDetected ? "Auto-detected" : "User-supplied"})`);
          }
          if (analysis.issues.length > 0) {
            console.log(`\n  Issues Identified (${analysis.issues.length}):`);
            analysis.issues.forEach((i) => console.log(`   - [${i.type}] ${i.message} (-${i.penalty} pts)`));
          }
          if (analysis.suggestions.length > 0) {
            console.log(`\n  Suggestions for Improvement:`);
            analysis.suggestions.forEach((s) => console.log(`   - ${s}`));
          }
          console.log(`--------------------------------------------------\n`);
        }
        process.exit(analysis.isFalsifiable ? 0 : 1);
      } else {
        console.error(`Unknown task subcommand '${subCommand}'. Supported: agentctl task create, agentctl task optimize`);
        process.exit(1);
      }
      break;
    }

    case "status": {
      const queueDir = getQueueDir(root);
      const files = existsSync(queueDir) ? readdirSync(queueDir).filter((f) => isTaskFile(f, queueDir)) : [];
      console.log(`\n📊 agentctl Status Summary (v0.29.1)`);
      console.log(`--------------------------------------------------`);
      console.log(`  Project Root     : ${root}`);
      console.log(`  Pending Tasks    : ${files.length}`);
      console.log(`  Active VFS Locks : ${lockStatus(root).length}`);
      const budget = checkDailyBudget(root, config.limits.dailyTasks);
      console.log(`  Daily Budget     : ${budget.used} / ${budget.budget} used`);
      console.log(`--------------------------------------------------\n`);
      process.exit(0);
      break;
    }

    case "scan": {
      const { scanCodebaseForTodos } = await import("../scripts/jules-scan-todos.mjs");
      const todos = scanCodebaseForTodos(root);
      console.log(`\n🔍 Scanned ${todos.length} TODO/FIXME annotation(s).`);
      for (const t of todos.slice(0, 10)) {
        console.log(`   - ${t.file}:${t.line} [${t.type}] ${t.text}`);
      }
      if (todos.length > 10) {
        console.log(`   ... and ${todos.length - 10} more.`);
      }
      process.exit(0);
      break;
    }

    case "rollback": {
      const { restoreCheckpoint } = await import("../src/ops/checkpoint.mjs");
      const targetId = args[1] || "--latest";
      try {
        const res = restoreCheckpoint(targetId, { root });
        console.log(`\n✅ Git Checkpoint Restored Successfully!`);
        console.log(`   Session ID : ${res.id}`);
        console.log(`   HEAD SHA   : ${res.headSha || "N/A"}`);
        console.log(`   RestoredAt : ${res.restoredAt}\n`);
        process.exit(0);
      } catch (err) {
        console.error(`❌ Rollback Failed: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case "resume": {
      const { createProvider } = await import("../src/provider.mjs");
      const sessionId = args[1];
      const { values } = parseArgs({
        args: args.slice(1),
        options: {
          response: { type: "string", short: "r" },
          "dry-run": { type: "boolean", short: "d" },
          json: { type: "boolean", short: "j" },
        },
        allowPositionals: true,
      });

      if (!sessionId || sessionId.startsWith("-")) {
        console.error("Error: Session ID is required for agentctl resume <sessionId>.");
        process.exit(1);
      }

      const responseText = values.response || args.slice(2).join(" ");
      if (!responseText) {
        console.error("Error: --response text is required to resume warm session.");
        process.exit(1);
      }

      const provider = createProvider(config.provider || "jules", config);
      try {
        const res = await provider.resume(sessionId, responseText, { root, dryRun: values["dry-run"] });
        if (values.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`\n✅ Warm Session Resumed Successfully!`);
          console.log(`   Session ID : ${res.id}`);
          console.log(`   Status     : ${res.status}\n`);
        }
        process.exit(0);
      } catch (err) {
        console.error(`❌ Resume Failed: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case "test-gen": {
      const { scaffoldTddTest, runTddCycle } = await import("../src/ops/tdd-generator.mjs");
      const { values } = parseArgs({
        args: args.slice(1),
        options: {
          title: { type: "string", short: "t" },
          spec: { type: "string", short: "s" },
          run: { type: "boolean", short: "r" },
          json: { type: "boolean", short: "j" },
        },
        allowPositionals: true,
      });

      const title = values.title || args[1] || "feature-spec";
      const specText = values.spec || args.slice(2).join(" ") || "TDD requirement specification.";

      try {
        if (values.run) {
          const res = await runTddCycle({ title, spec: specText }, { root });
          if (values.json) {
            console.log(JSON.stringify(res, null, 2));
          } else {
            console.log(`\n🔴 TDD RED Check Verified!`);
            console.log(`   Test File   : ${res.testFile}`);
            console.log(`   Scope Lock  : Locked into scope.deny`);
            console.log(`   Status      : Ready for green implementation dispatch\n`);
          }
        } else {
          const scaffold = scaffoldTddTest({ title, spec: specText }, { root });
          if (values.json) {
            console.log(JSON.stringify(scaffold, null, 2));
          } else {
            console.log(`\n🧪 TDD Test Scaffolded Successfully!`);
            console.log(`   File Path : ${scaffold.relativePath}`);
            console.log(`   Command   : ${scaffold.testCmd}\n`);
          }
        }
        process.exit(0);
      } catch (err) {
        console.error(`❌ TDD Generation Failed: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case "mcp": {
      const subAction = args[1];
      if (subAction === "init") {
        const { scaffoldIdeConfig } = await import("../src/ops/ide-scaffold.mjs");
        const { values } = parseArgs({
          args: args.slice(2),
          options: {
            target: { type: "string", short: "t", default: "all" },
            json: { type: "boolean", short: "j" },
          },
          allowPositionals: true,
        });

        const target = values.target || args[2] || "all";
        try {
          const res = scaffoldIdeConfig(target, { root });
          if (values.json) {
            console.log(JSON.stringify(res, null, 2));
          } else {
            console.log(`\n🔌 IDE MCP Config Scaffolded Successfully!`);
            console.log(`   Target  : ${res.target}`);
            for (const item of res.results) {
              console.log(`   - ${item.target.toUpperCase()} : ${item.file}`);
            }
            console.log("");
          }
          process.exit(0);
        } catch (err) {
          console.error(`❌ IDE MCP Scaffold Failed: ${err.message}`);
          process.exit(1);
        }
      }

      const { startMcpServer } = await import("../src/mcp.mjs");
      startMcpServer();
      break;
    }

    case "hydrate": {
      const { hydratePrompt } = await import("../src/memory.mjs");
      const promptInput = args.slice(1).join(" ") || "";
      const result = hydratePrompt(root, promptInput);
      console.log(result);
      process.exit(0);
    }

    case "harvest": {
      const { harvestFailure } = await import("../src/memory.mjs");
      const { values } = parseArgs({
        args: args.slice(1),
        options: {
          "exit-code": { type: "string" },
          log: { type: "string" },
          diff: { type: "string" },
          task: { type: "string" },
          agent: { type: "string" },
          json: { type: "boolean", short: "j" },
        },
        allowPositionals: true,
      });

      const exitCode = parseInt(values["exit-code"] || "4", 10);
      const logPath = values.log || "";
      const diffText = values.diff || "";
      const taskId = values.task || "unknown";
      const agent = values.agent || "jules";

      const res = harvestFailure(root, { exitCode, logPath, diffText, taskId, agent });
      if (values.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        if (res.status === "HARVESTED") {
          console.log(`🌾 Harvested failure candidate: ${res.candidate.trigger}`);
          console.log(`   Solution: ${res.candidate.solution}`);
        } else {
          console.log(`⚠️ Harvest rejected: ${res.reason}`);
        }
      }
      process.exit(0);
    }

    case "learning": {
      const subcmd = args[1];
      if (subcmd === "add") {
        const { recordLearning } = await import("../src/memory.mjs");
        const trigger = args[2];
        const solution = args[3];
        if (!trigger || !solution) {
          console.error('Usage: agentctl learning add "<trigger/symptom>" "<solution>"');
          process.exit(1);
        }
        const res = recordLearning(root, { trigger, solution });
        console.log(`✅ System learning recorded. Total learnings: ${res.count}`);
        process.exit(0);
      }
      console.error('Usage: agentctl learning add "<trigger/symptom>" "<solution>"');
      process.exit(1);
    }

    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[FATAL ERROR] ${err.message}`);
  const exitCode = typeof err.code === "number" ? err.code : 1;
  process.exit(exitCode);
});
