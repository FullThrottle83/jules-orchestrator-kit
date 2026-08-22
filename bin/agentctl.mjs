#!/usr/bin/env node

import { parseArgs } from "node:util";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, resolveRoot, detectStack, bootstrapZeroTestRepo } from "../src/config.mjs";
import { gate, dispatch, run, isTaskFile } from "../src/engine.mjs";
import { acquireLock, releaseLock, lockStatus, getQueueDir } from "../src/state.mjs";
import { worktreePrune } from "../src/git.mjs";
import { reapOrphanedIntents, reapStaleMutexDirs } from "../src/journal.mjs";
import { KIT_VERSION } from "../src/version.mjs";
import { budgetStatus, listOpenReservations, releaseOpenReservations, resolveConcurrency } from "../src/budget.mjs";

const args = process.argv.slice(2);
const command = args[0];

export const VERSION = KIT_VERSION;

/**
 * Render the budget line so the number is never mistaken for the vendor's own
 * counter. The ledger counts what *this checkout* dispatched; sessions started
 * from the web UI or another machine spend the same quota unseen, so a bare
 * "N / M used" invites the reader to trust a figure that cannot be complete.
 * "last 24h", not "today": the provider's allowance resets on a rolling
 * window, so a figure labelled by the calendar day would be a different number
 * from the one being enforced.
 * @param {{ used: number, limit: number, source: string, certain: boolean }} b
 */
export function formatBudgetLine(b) {
  const scope = `${b.used} / ${b.limit} used in the last 24h (this repo)`;
  if (b.source === "learned") return `${scope} — provider refused further work`;
  if (b.certain) return `${scope} — limit from ${b.source === "env" ? "JULES_DAILY_BUDGET" : "config"}`;
  return `${scope} — limit estimated from tier "${b.tier || "?"}", not enforced`;
}

export function printHelp() {
  console.log(`
🚀 agentctl v${VERSION} — Universal Agent Orchestrator & Safety Gatekeeper

Usage: agentctl <command> [options]

Commands:
  dispatch | create     Dispatch a single task to an AI agent (--role <name>, --tier fast|complex, --check-premise)
  gate | audit          Run CI security and verification gate against current branch
  queue                 Run pending task queue (--dag, --concurrency <n>)
  swarm                 Run parallel task swarm
  mcp                   Start stdio Model Context Protocol (MCP) server
  clean                 Clean stale branches, worktrees, locks, and ledgers
  lock <action>         Manage mutex locks (acquire | release | status)
  doctor                Run system diagnostics and stack resolution checks
  bootstrap             Bootstrap zero-test repository with verification oracle
  review-repair         Parse PR review comments and synthesize OODA repair tasks
  dashboard             Start local HTTP telemetry and audit dashboard
  init                  Scaffold .agent/ config and run onboarding wizard
  task create           Interactively author and scope a Jules task envelope (--template <name>, --role <name>, --tier fast|complex)
  task optimize         Linter & optimizer for Jules task prompts (--fix, --json, --web)
  task template         List and generate task templates (--list, --json)
  test-gen              Scaffold & run automated TDD Red-to-Green test cycle (--run)
  mcp init              Scaffold IDE integration config (cursor | vscode | claude | all)
  rollback              Restore git state & working tree to atomic pre-flight checkpoint
  handover              Inspect or generate Baton Pass session handover envelopes (list | show | create | prune)
  resume                Resume warm session with human response (--response "<text>")
  plan approve <id>     Approve pending plan for a Jules session (:approvePlan)
  session get <id>      Retrieve remote session status from provider API
  pr harvest            Triage, verify CI, and auto-merge low-risk agent PRs (--auto, --tier r0,r1)
  escalate              Dispatch or manage webhook escalation incidents (--flush, --status, --clear)
  flaky                 Manage Wilson-quarantined tests and dispatch healing swarm (status | heal | reset)
  status                Display queue and system status summary
  budget                Show the 24h task budget, worker slots and their provenance (reset --yes)
  scan                  Scan codebase for TODO/FIXME task candidates
  hydrate [prompt]      Prepend active system learnings and baton-pass state to a prompt
  harvest               Harvest failure traces and record/quarantine resolution rules
  learning add          Record a system learning rule into .agent/knowledge/
  evidence <action>     Manage cryptographic audit evidence (generate | verify | show)
  assert                Run declarative zero-dependency verification assertion primitives
  version               Output agentctl version

Options:
  --role, -r            Specify specialist agent role (overseer | bolt | sentinel | janitor)
  --tier                Force routing tier when router.enabled (fast | complex) — see .agent/config.yml router:
  --check-premise       Verify task goal/oracle passes locally before burning API budget
  --dag                 Execute queue tasks via DAG dependency resolution
  --dry-run, -d         Simulate action without making API calls or modifying git
  --mode, -m            Gate evaluation mode (working-tree | committed | staged)
  --repoless            Dispatch task in repoless execution mode
  --source, -s          Specify Jules repository source name
  --branch, -b          Specify target starting branch
  --json, -j            Emit machine-readable JSON output
  --json-report <path>  Write structured machine-readable JSON diagnostics report
  --help, -h            Show command help
`);
}


async function main() {
  if (command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  // Bare `agentctl` answers "what do I do next" rather than dumping thirty
  // commands. The help text is a reference for people who already know the
  // tool; a newcomer cannot tell which entry is step one, and guessing wrong
  // costs them a confusing failure instead of a hint.
  if (!command) {
    const { resolveNextStep, renderNextStep } = await import("../src/ops/next-step.mjs");
    const cwd = process.cwd();
    let budgetLine = "";
    let where = cwd;
    try {
      const nextRoot = resolveRoot();
      where = nextRoot;
      budgetLine = formatBudgetLine(budgetStatus(loadConfig(nextRoot), nextRoot));
    } catch (_) {
      // Outside a repository there is no root to load a config from; the
      // next step below is `git init`, which does not need one.
    }
    const next = resolveNextStep(where);
    console.log(renderNextStep({ version: VERSION, root: where, next, budgetLine: next.blocking ? "" : budgetLine }));
    process.exit(0);
  }

  if (command === "version" || command === "--version" || command === "-v") {
    console.log(`agentctl v${VERSION}`);
    process.exit(0);
  }

  // Intercept --help / -h on any subcommand (e.g. `agentctl init --help`)
  const subArgs = args.slice(1);
  if (subArgs.includes("--help") || subArgs.includes("-h")) {
    printHelp();
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
          role: { type: "string", short: "r" },
          tier: { type: "string" },
          source: { type: "string", short: "s" },
          branch: { type: "string", short: "b" },
          repoless: { type: "boolean" },
          "auto-pr": { type: "boolean" },
          "require-plan-approval": { type: "boolean" },
          "check-premise": { type: "boolean" },
          idempotent: { type: "boolean" },
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
        role: values.role,
        tier: values.tier === "fast" || values.tier === "complex" ? values.tier : undefined,
        source: values.source,
        branch: values.branch,
        repoless: values.repoless,
        autoPr: values["auto-pr"],
        requirePlanApproval: values["require-plan-approval"],
        checkPremise: values["check-premise"] || values.idempotent,
      };

      try {
        const session = await dispatch(task, {
          root,
          config,
          dryRun: values["dry-run"],
          repoless: values.repoless,
          source: values.source,
          branch: values.branch,
          checkPremise: values["check-premise"] || values.idempotent,
        });
        if (values.json) {
          console.log(JSON.stringify({ ok: true, session }, null, 2));
        } else {
          if (session.status === "ALREADY_SATISFIED" || session.skipped) {
            console.log(`\n⚡ Task Already Satisfied (skipped dispatch):`);
            console.log(`   Reason: ${session.reason || "Verification oracle already passing on base branch."}`);
          } else {
            console.log(`\n✅ Task Dispatched Successfully!`);
            console.log(`   Session ID  : ${session.id}`);
            console.log(`   Session URL : ${session.url || "N/A"}`);
            if (session._routeTier) {
              console.log(`   Router Tier : ${session._routeTier} (${session._routeReason || "n/a"})`);
            }
          }
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
          "json-report": { type: "string" },
          "dry-run": { type: "boolean", short: "d" },
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
        jsonReport: values["json-report"],
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
        if (!res.ok) {
          if (res.code === 3) {
            console.log(`💡 Remediation Hint (Exit 3 Scope Violation):`);
            console.log(`   • To allow protected files in this run, pass: agentctl gate --allow-protected`);
            console.log(`   • Or remove protected/denied paths from the diff before dispatching.\n`);
          } else if (res.code === 5) {
            console.log(`💡 Remediation Hint (Exit 5 Diff Payload Overflow):`);
            console.log(`   • Total diff exceeds ${config.limits?.diffKb || 75} KB limit.`);
            console.log(`   • Split the task into smaller atomic tasks using: agentctl task create\n`);
          } else if (res.code === 6) {
            console.log(`💡 Remediation Hint (Exit 6 Secret Leak Prevented):`);
            console.log(`   • High-entropy credential or secret detected in patch.`);
            console.log(`   • Scrub credential from source and rotate any exposed keys immediately.\n`);
          } else if (res.code === 4) {
            console.log(`💡 Remediation Hint (Exit 4 OODA Repair Exhausted):`);
            console.log(`   • Automated self-repair could not pass tests cleanly.`);
            console.log(`   • Review error fingerprints via: agentctl doctor\n`);
          }
        }
      }

      process.exit(typeof res.code === "number" ? res.code : 0);
      break;
    }

    case "assert": {
      const { runAssertion, parseYaml } = await import("../index.mjs");
      const { values } = parseArgs({
        args: args.slice(1),
        options: {
          dir: { type: "string", short: "d" },
          file: { type: "string", short: "f" },
          targets: { type: "string", short: "t" },
          patterns: { type: "string", short: "p" },
          "patterns-file": { type: "string" },
          "max-bytes": { type: "string" },
          "max-kb": { type: "string" },
          "max-mb": { type: "string" },
          gzip: { type: "boolean" },
          config: { type: "string", short: "c" },
          json: { type: "boolean", short: "j" },
          "json-report": { type: "string" },
        },
        allowPositionals: true,
      });

      let stageConfig = {};
      if (values.config && existsSync(values.config)) {
        const raw = readFileSync(values.config, "utf-8");
        stageConfig = parseYaml(raw);
      } else {
        let assertType = "dir-size";
        if (values.file) assertType = "file-size";
        else if (values.patterns || values["patterns-file"] || values.targets) assertType = "file-patterns";
        else if (values.dir) assertType = "dir-size";

        stageConfig = {
          assert: assertType,
          path: values.dir || values.file,
          targets: values.targets ? values.targets.split(",").map((s) => s.trim()) : undefined,
          patterns: values.patterns ? values.patterns.split(",").map((s) => s.trim()) : undefined,
          patternsFile: values["patterns-file"],
          maxBytes: values["max-bytes"] ? Number(values["max-bytes"]) : undefined,
          maxKb: values["max-kb"] ? Number(values["max-kb"]) : undefined,
          maxMb: values["max-mb"] ? Number(values["max-mb"]) : undefined,
          gzip: values.gzip,
        };
      }

      const result = runAssertion(stageConfig, root);
      if (values["json-report"]) {
        const { exportJsonReport, generateEvidenceManifest } = await import("../src/evidence.mjs");
        const dummyManifest = generateEvidenceManifest(root, {
          taskId: "CLI-ASSERT",
          title: "Ad-hoc Assertion",
          executionRecords: [
            {
              id: result.assertionType,
              kind: "assert",
              assert: result.assertionType,
              exitCode: result.status,
              durationMs: result.metrics?.durationMs || 0,
              diagnostics: result.diagnostics,
              metrics: result.metrics,
            },
          ],
          diagnostics: result.diagnostics,
          metrics: result.metrics,
          ok: result.ok,
        });
        exportJsonReport(dummyManifest, values["json-report"]);
      }

      if (values.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (result.ok) {
          console.log(`\n✅ Assertion [${result.assertionType}] PASSED (${result.metrics?.durationMs || 0}ms)`);
          if (result.metrics?.measuredBytes !== undefined) {
            console.log(`   Measured : ${result.metrics.measuredBytes} bytes${result.metrics.gzip ? " (gzipped)" : ""}`);
          }
        } else {
          console.error(`\n❌ Assertion [${result.assertionType}] FAILED (Exit 1)`);
          for (const d of result.diagnostics) {
            console.error(`   - ${d}`);
          }
        }
      }
      process.exit(result.status);
      break;
    }

    case "queue": {
      const { values } = parseArgs({
        args: args.slice(1),
        options: {
          dag: { type: "boolean" },
          concurrency: { type: "string", short: "c" },
          "dry-run": { type: "boolean", short: "d" },
          json: { type: "boolean", short: "j" },
        },
        allowPositionals: true,
      });

      const queueDir = getQueueDir(root);
      const files = readdirSync(queueDir).filter((f) => isTaskFile(f, queueDir));
      console.log(`Found ${files.length} queued task(s) in .agent/jules-queue/`);
      if (files.length > 0) {
        const concurrency = values.concurrency ? Number(values.concurrency) : undefined;
        const results = await run(null, {
          root,
          config,
          dag: values.dag,
          concurrency,
          dryRun: values["dry-run"],
        });
        if (values.json) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          console.log(`\nProcessed ${results.processed || results.results?.length || 0} task(s).`);
        }
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

    case "budget": {
      const action = args[1];
      const b = budgetStatus(config, root);

      if (action === "reset") {
        // The count is local-only, so an operator who knows their real usage
        // must be able to correct it. Appending `budget_released` keeps the
        // hash chain intact — the ledger is corrected forwards, never edited.
        // An unrecognised flag is refused rather than ignored. `reset` writes to
        // the ledger, and a misremembered flag — `--root`, `--force` — silently
        // dropping through to a full release is the kind of misfire that only
        // becomes visible after the count is already gone.
        const known = new Set(["--dry-run", "--yes", "-y", "--all"]);
        const unknown = args.slice(2).filter((a) => !known.has(a));
        if (unknown.length) {
          console.error(`Unrecognised option${unknown.length > 1 ? "s" : ""} for \`budget reset\`: ${unknown.join(", ")}`);
          console.error("Accepted: --dry-run, --yes/-y, --all. Nothing was released.");
          process.exit(2);
        }
        const dryRun = args.includes("--dry-run");
        const confirmed = args.includes("--yes") || args.includes("-y");
        // Committed reservations reached the provider, so releasing them makes
        // the local count understate real usage. That has to be deliberate.
        const includeCommitted = args.includes("--all");
        if (!dryRun && !confirmed) {
          const open = listOpenReservations(root);
          const committed = open.filter((r) => r.committed).length;
          const target = includeCommitted ? open.length : open.length - committed;
          console.log(`Would release ${target} open reservation(s) from the last 24 hours.`);
          if (committed > 0 && !includeCommitted) {
            console.log(`Keeping ${committed} that reached Jules — those sessions really spent quota.`);
            console.log("Add --all to release them too, if you know the count is still wrong.");
          }
          console.log("This rewrites nothing — it appends `budget_released` entries.");
          console.log("Re-run with --yes to confirm, or --dry-run for detail.");
          process.exit(0);
        }
        const res = releaseOpenReservations({ root, dryRun, includeCommitted, reason: "operator-reconcile" });
        const verb = dryRun ? "Would release" : "Released";
        console.log(`${verb} ${res.released} of ${res.open} open reservation(s) — ${res.uncommitted} never closed, ${res.committed} committed.`);
        if (res.kept > 0) {
          console.log(`Kept ${res.kept} committed reservation(s); re-run with --all to release those as well.`);
        }
        if (!dryRun) {
          const after = budgetStatus(loadConfig(root), root);
          console.log(`Daily Budget : ${formatBudgetLine(after)}`);
        }
        process.exit(0);
      }

      if (args.includes("--json")) {
        console.log(JSON.stringify({ ok: true, budget: { ...b, scope: "this-repository" } }, null, 2));
        process.exit(0);
      }

      const slots = resolveConcurrency(config);
      console.log(`Task Budget  : ${formatBudgetLine(b)}`);
      console.log(`  ${b.note}`);
      console.log(`  Window opened at ${b.windowStart} — the quota resets ${b.windowHours}h after each task,`);
      console.log("  not at midnight, so this count spans yesterday's ledger too.");
      const openNow = listOpenReservations(root);
      const committedNow = openNow.filter((r) => r.committed).length;
      console.log(`  Open reservations in the window: ${openNow.length} (${committedNow} confirmed dispatched, ${openNow.length - committedNow} never closed)`);
      console.log("");
      console.log(`Worker Slots : ${slots.concurrency} concurrent`);
      console.log(`  ${slots.note}`);
      console.log("");
      console.log("The ledger counts this checkout only — sessions started from the Jules");
      console.log("web UI or another machine spend the same quota without appearing here.");
      console.log("Use `agentctl budget reset --yes` to clear the ones that never closed,");
      console.log("or `--all` to also give back the ones that did reach Jules.");
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
      const { values } = parseArgs({
        args: args.slice(1),
        options: { json: { type: "boolean", short: "j" } },
        allowPositionals: true,
        strict: false,
      });

      // runDoctorChecks() and its seven checks existed but nothing rendered
      // them: this command printed a hand-written summary, so findings like a
      // git-tracked .env were computed, tested, and never shown to anyone.
      const { runDoctorChecks } = await import("../src/ops/doctor-registry.mjs");
      const report = await runDoctorChecks({ root });

      if (values.json) {
        console.log(JSON.stringify(report, null, 2));
        process.exit(report.summary.fail > 0 ? 1 : 0);
      }

      console.log(`\n🔍 agentctl System Diagnostics (v${VERSION})`);
      console.log(`--------------------------------------------------`);
      console.log(`  Project Root     : ${root}`);
      console.log(`  Config File      : ${config._file || "None (Using defaults)"}`);
      console.log(`  Detected Stack   : ${detectStack(root).stack}`);
      console.log(`  Test Command     : ${config.verify.test || "(None)"}`);
      console.log(`  Build Command    : ${config.verify.build || "(None)"}`);
      console.log(`  Daily Budget     : ${formatBudgetLine(budgetStatus(config, root))}`);
      console.log(`--------------------------------------------------`);

      const icon = { pass: "✅", warn: "⚠️ ", fail: "❌", skip: "⏭️ ", unknown: "❔" };
      for (const r of report.results) {
        console.log(`  ${icon[r.status] || "•"} ${r.title}`);
        if (r.status !== "pass") {
          console.log(`       ${r.summary}`);
          for (const fix of r.remediation || []) console.log(`       → ${fix.summary}`);
        }
      }

      const { pass, warn, fail } = report.summary;
      console.log(`--------------------------------------------------`);
      console.log(`  ${pass} passed, ${warn} warning(s), ${fail} failure(s)\n`);
      process.exit(fail > 0 ? 1 : 0);
      break;
    }

    case "bootstrap": {
      const { values } = parseArgs({
        args: args.slice(1),
        options: {
          force: { type: "boolean", short: "f" },
          "dry-run": { type: "boolean", short: "d" },
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
          "dry-run": { type: "boolean", short: "d" },
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
            role: { type: "string", short: "r" },
            tier: { type: "string" },
            template: { type: "string" },
            depends: { type: "string" },
            "depends-on": { type: "string" },
            "verify-cmd": { type: "string", short: "v" },
            "auto-pr": { type: "boolean" },
            "require-plan-approval": { type: "boolean" },
            repoless: { type: "boolean" },
            json: { type: "boolean", short: "j" },
            "dry-run": { type: "boolean", short: "d" },
          },
          allowPositionals: true,
        });

        const { runTaskCreateWizard } = await import("../src/wizard-task.mjs");
        const res = await runTaskCreateWizard(root, {
          title: values.title,
          prompt: values.prompt,
          role: values.role,
          tier: values.tier,
          template: values.template,
          dependsOn: values["depends-on"] || values.depends,
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
          if (res.plan.role) console.log(`   Role     : ${res.plan.role}`);
          if (res.plan.tier) console.log(`   Tier     : ${res.plan.tier} (routing override)`);
          if (res.plan.dependsOn && res.plan.dependsOn.length > 0) console.log(`   DependsOn: ${res.plan.dependsOn.join(", ")}`);
          console.log(`   Auto-PR  : ${res.plan.flags.autoPr}`);
        }
        process.exit(0);
      } else if (subCommand === "template") {
        const { values, positionals } = parseArgs({
          args: args.slice(2),
          options: {
            list: { type: "boolean", short: "l" },
            json: { type: "boolean", short: "j" },
            "verify-cmd": { type: "string", short: "v" },
            "dry-run": { type: "boolean", short: "d" },
          },
          allowPositionals: true,
        });

        const { listWebTemplates, getWebTemplate, synthesizeWebEnvelope } = await import("../src/web-templates.mjs");
        const templateName = positionals[0];

        if (values.list || !templateName) {
          const templates = listWebTemplates();
          if (values.json) {
            console.log(JSON.stringify({ ok: true, templates }, null, 2));
          } else {
            console.log(`\n📋 Available Task Templates & Envelopes`);
            console.log(`--------------------------------------------------`);
            templates.forEach((t) => {
              console.log(`  • ${t.id.padEnd(16)} [${t.category}]`);
              console.log(`    ${t.description}`);
              console.log(`    Default Oracle: ${t.defaultVerifyCmd}\n`);
            });
            console.log(`Usage: agentctl task template <id> [--json]`);
            console.log(`--------------------------------------------------\n`);
          }
          process.exit(0);
        }

        const tpl = getWebTemplate(templateName);
        if (!tpl) {
          console.error(`Error: Unknown template '${templateName}'. Run 'agentctl task template --list' to see options.`);
          process.exit(1);
        }

        const envelope = synthesizeWebEnvelope(templateName, {}, { verifyCmd: values["verify-cmd"] });
        if (values.json) {
          console.log(JSON.stringify({ ok: true, ...envelope }, null, 2));
        } else {
          console.log(envelope.fullEnvelope);
        }
        process.exit(0);
      } else if (subCommand === "optimize") {
        const { values, positionals } = parseArgs({
          args: args.slice(2),
          options: {
            fix: { type: "boolean", short: "f" },
            file: { type: "string" },
            dir: { type: "string", short: "d" },
            web: { type: "boolean", short: "w" },
            json: { type: "boolean", short: "j" },
            "verify-cmd": { type: "string", short: "v" },
            "dry-run": { type: "boolean" },
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
          const opt = optimizeTaskPrompt(promptText, { rootDir: targetDir, verifyCmd: values["verify-cmd"], web: values.web });
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
          if (analysis.webIntent && analysis.webIntent.isWeb) {
            console.log(`  Web Intent       : 🌐 YES [${analysis.webIntent.categories.join(", ")}]`);
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
        console.error(`Unknown task subcommand '${subCommand}'. Supported: agentctl task create, agentctl task optimize, agentctl task template`);
        process.exit(1);
      }
      break;
    }

    case "status": {
      const queueDir = getQueueDir(root);
      const files = existsSync(queueDir) ? readdirSync(queueDir).filter((f) => isTaskFile(f, queueDir)) : [];
      console.log(`\n📊 agentctl Status Summary (v${VERSION})`);
      console.log(`--------------------------------------------------`);
      console.log(`  Project Root     : ${root}`);
      console.log(`  Pending Tasks    : ${files.length}`);
      console.log(`  Active VFS Locks : ${lockStatus(root).length}`);
      const budget = budgetStatus(config, root);
      console.log(`  Daily Budget     : ${formatBudgetLine(budget)}`);
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
      const { createHandover } = await import("../src/ops/handover.mjs");
      const { values, positionals } = parseArgs({
        args: args.slice(1),
        options: {
          reason: { type: "string", short: "r" },
          intent: { type: "string", short: "i" },
          handover: { type: "boolean", default: true },
          json: { type: "boolean", short: "j" },
        },
        allowPositionals: true,
      });

      const targetId = positionals[0] || "--latest";
      try {
        const res = restoreCheckpoint(targetId, { root });
        let hoResult = null;
        if (values.handover !== false) {
          try {
            hoResult = createHandover(root, {
              sessionId: res.id,
              status: "rolled-back",
              intent: values.intent || "Restored working tree to pre-flight checkpoint",
              landmines: values.reason ? [values.reason] : ["Session cancelled or rolled back by operator"],
              branch: res.branch,
              headSha: res.headSha,
            });
          } catch (_) {}
        }

        if (values.json) {
          console.log(JSON.stringify({ ok: true, ...res, handover: hoResult?.filePath }, null, 2));
        } else {
          console.log(`\n✅ Git Checkpoint Restored Successfully!`);
          console.log(`   Session ID : ${res.id}`);
          console.log(`   HEAD SHA   : ${res.headSha || "N/A"}`);
          console.log(`   RestoredAt : ${res.restoredAt}`);
          if (hoResult) {
            console.log(`   Handover   : ${hoResult.filePath}`);
          }
          console.log("");
        }
        process.exit(0);
      } catch (err) {
        console.error(`❌ Rollback Failed: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case "handover": {
      const {
        createHandover,
        loadHandover,
        listHandovers,
        pruneHandovers,
        formatHandoverPromptContext,
      } = await import("../src/ops/handover.mjs");

      const subAction = args[1] || "list";
      const { values, positionals } = parseArgs({
        args: args.slice(2),
        options: {
          intent: { type: "string", short: "i" },
          status: { type: "string", short: "s", default: "aborted" },
          completed: { type: "string", short: "c" },
          assumptions: { type: "string", short: "a" },
          landmines: { type: "string", short: "l" },
          "next-steps": { type: "string", short: "n" },
          limit: { type: "string" },
          json: { type: "boolean", short: "j" },
          context: { type: "boolean" },
        },
        allowPositionals: true,
      });

      if (subAction === "list") {
        let items = listHandovers(root);
        const limitNum = parseInt(values.limit || "20", 10);
        if (!isNaN(limitNum) && limitNum > 0) {
          items = items.slice(0, limitNum);
        }
        if (values.json) {
          console.log(JSON.stringify({ ok: true, count: items.length, handovers: items }, null, 2));
        } else {
          console.log(`\n📋 Baton Pass Handover Envelopes (${items.length})`);
          console.log(`--------------------------------------------------`);
          if (items.length === 0) {
            console.log(`  (No handovers found in .agent/handovers/)`);
          } else {
            items.forEach((h, idx) => {
              console.log(`  ${idx + 1}. [${h.status.toUpperCase()}] ${h.sessionId} (${h.createdAt.substring(0, 16)})`);
              if (h.intent) console.log(`     Intent: ${h.intent.substring(0, 80)}`);
              console.log(`     File  : ${h.filePath}\n`);
            });
          }
          console.log(`--------------------------------------------------\n`);
        }
        process.exit(0);
      }

      if (subAction === "show") {
        const targetId = positionals[0];
        if (!targetId) {
          console.error("Error: Session ID or file path is required for agentctl handover show <sessionId>");
          process.exit(1);
        }
        try {
          const ho = loadHandover(root, targetId);
          if (values.context) {
            console.log(formatHandoverPromptContext(ho));
          } else if (values.json) {
            console.log(JSON.stringify({ ok: true, handover: ho }, null, 2));
          } else {
            console.log(ho.rawMarkdown);
          }
          process.exit(0);
        } catch (err) {
          console.error(`❌ Error loading handover: ${err.message}`);
          process.exit(1);
        }
      }

      if (subAction === "create") {
        const targetId = positionals[0] || `session-${Date.now()}`;
        try {
          const res = createHandover(root, {
            sessionId: targetId,
            status: values.status,
            intent: values.intent,
            completed: values.completed,
            assumptions: values.assumptions,
            landmines: values.landmines,
            nextSteps: values["next-steps"],
          });
          if (values.json) {
            console.log(JSON.stringify({ ok: true, ...res }, null, 2));
          } else {
            console.log(`\n✅ Handover Envelope Created Successfully!`);
            console.log(`   Session ID : ${res.sessionId}`);
            console.log(`   Status     : ${res.status}`);
            console.log(`   File Path  : ${res.filePath}\n`);
          }
          process.exit(0);
        } catch (err) {
          console.error(`❌ Error creating handover: ${err.message}`);
          process.exit(1);
        }
      }

      if (subAction === "prune") {
        const limitNum = parseInt(values.limit || "20", 10);
        const count = pruneHandovers(root, limitNum);
        if (values.json) {
          console.log(JSON.stringify({ ok: true, pruned: count }, null, 2));
        } else {
          console.log(`✅ Pruned ${count} old handover manifest(s).`);
        }
        process.exit(0);
      }

      console.error(`Error: Unknown handover subcommand '${subAction}'. Use list, show, create, or prune.`);
      process.exit(1);
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

    case "plan": {
      const subAction = args[1];
      if (subAction === "approve") {
        const sessionId = args[2];
        const { values, positionals } = parseArgs({
          args: args.slice(2),
          options: {
            "dry-run": { type: "boolean", short: "d" },
            json: { type: "boolean", short: "j" },
          },
          allowPositionals: true,
        });
        const targetSessionId = sessionId && !sessionId.startsWith("-") ? sessionId : positionals?.[0];
        if (!targetSessionId) {
          console.error("Error: Session ID is required for agentctl plan approve <sessionId>.");
          process.exit(1);
        }
        const { createProvider } = await import("../src/provider.mjs");
        const provider = createProvider(config.provider || "jules", config);
        try {
          const res = await provider.approvePlan(targetSessionId, { root, dryRun: values["dry-run"] });
          if (values.json) {
            console.log(JSON.stringify(res, null, 2));
          } else {
            console.log(`\n✅ Plan Approved Successfully!`);
            console.log(`   Session ID : ${res.id}`);
            console.log(`   Status     : ${res.status}\n`);
          }
          process.exit(0);
        } catch (err) {
          console.error(`❌ Plan Approval Failed: ${err.message}`);
          process.exit(1);
        }
      }
      console.error(`Error: Unknown plan subcommand '${subAction}'. Use approve.`);
      process.exit(1);
      break;
    }

    case "approve": {
      const sessionId = args[1];
      const { values, positionals } = parseArgs({
        args: args.slice(1),
        options: {
          "dry-run": { type: "boolean", short: "d" },
          json: { type: "boolean", short: "j" },
        },
        allowPositionals: true,
      });
      const targetSessionId = sessionId && !sessionId.startsWith("-") ? sessionId : positionals?.[0];
      if (!targetSessionId) {
        console.error("Error: Session ID is required for agentctl approve <sessionId>.");
        process.exit(1);
      }
      const { createProvider } = await import("../src/provider.mjs");
      const provider = createProvider(config.provider || "jules", config);
      try {
        const res = await provider.approvePlan(targetSessionId, { root, dryRun: values["dry-run"] });
        if (values.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`\n✅ Plan Approved Successfully!`);
          console.log(`   Session ID : ${res.id}`);
          console.log(`   Status     : ${res.status}\n`);
        }
        process.exit(0);
      } catch (err) {
        console.error(`❌ Plan Approval Failed: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case "session": {
      const subAction = args[1];
      if (subAction === "get" || subAction === "status") {
        const sessionId = args[2];
        const { values, positionals } = parseArgs({
          args: args.slice(2),
          options: {
            "dry-run": { type: "boolean", short: "d" },
            json: { type: "boolean", short: "j" },
          },
          allowPositionals: true,
        });
        const targetSessionId = sessionId && !sessionId.startsWith("-") ? sessionId : positionals?.[0];
        if (!targetSessionId) {
          console.error("Error: Session ID is required for agentctl session get <sessionId>.");
          process.exit(1);
        }
        const { createProvider } = await import("../src/provider.mjs");
        const provider = createProvider(config.provider || "jules", config);
        try {
          const res = await provider.getSession(targetSessionId, { root, dryRun: values["dry-run"] });
          if (values.json) {
            console.log(JSON.stringify(res, null, 2));
          } else {
            console.log(`\n📋 Remote Session Status:`);
            console.log(`   Session ID : ${res.id}`);
            console.log(`   Status     : ${res.status}\n`);
          }
          process.exit(0);
        } catch (err) {
          console.error(`❌ Session Retrieval Failed: ${err.message}`);
          process.exit(1);
        }
      }
      console.error(`Error: Unknown session subcommand '${subAction}'. Use get.`);
      process.exit(1);
      break;
    }

    case "pr": {
      const subAction = args[1];
      if (subAction === "harvest") {
        const { harvestPullRequests, formatHarvestTable } = await import("../src/ops/pr-harvest.mjs");
        const { values } = parseArgs({
          args: args.slice(2),
          options: {
            tier: { type: "string" },
            limit: { type: "string" },
            auto: { type: "boolean" },
            merge: { type: "boolean" },
            "allow-no-checks": { type: "boolean" },
            "dry-run": { type: "boolean", short: "d" },
            json: { type: "boolean", short: "j" },
          },
          allowPositionals: true,
        });

        const limit = values.limit ? parseInt(values.limit, 10) : 50;
        try {
          const res = await harvestPullRequests(root, {
            tier: values.tier,
            limit,
            auto: values.auto || values.merge,
            allowNoChecks: values["allow-no-checks"],
            dryRun: values["dry-run"],
          });

          if (values.json) {
            console.log(JSON.stringify(res, null, 2));
          } else {
            console.log(formatHarvestTable(res));
          }
          process.exit(0);
        } catch (err) {
          console.error(`❌ PR Harvest Failed: ${err.message}`);
          process.exit(1);
        }
      }
      console.error(`Error: Unknown PR subcommand '${subAction}'. Use harvest.`);
      process.exit(1);
      break;
    }

    case "escalate": {
      const {
        dispatchEscalation,
        flushEscalationDigest,
        getEscalationDigestStatus,
        clearEscalationDigest,
      } = await import("../src/webhook.mjs");

      const { values, positionals } = parseArgs({
        args: args.slice(1),
        options: {
          reason: { type: "string", short: "r", default: "AWAITING_USER_FEEDBACK" },
          branch: { type: "string", short: "b", default: config.baseBranch || "main" },
          logs: { type: "string", short: "l" },
          "log-file": { type: "string" },
          critical: { type: "boolean" },
          flush: { type: "boolean" },
          status: { type: "boolean" },
          clear: { type: "boolean" },
          "dry-run": { type: "boolean", short: "d" },
          json: { type: "boolean", short: "j" },
        },
        allowPositionals: true,
      });

      if (values.status) {
        const st = getEscalationDigestStatus(root, config);
        if (values.json) {
          console.log(JSON.stringify({ ok: true, status: st }, null, 2));
        } else {
          console.log(`\n🔇 Type III Silence Governor Status (v${VERSION})`);
          console.log(`--------------------------------------------------`);
          console.log(`  Notification Mode     : ${st.mode.toUpperCase()}`);
          console.log(`  Pending Digest Count  : ${st.pendingCount} / ${st.threshold}`);
          console.log(`  Interruption Budget   : ${st.recentInterruptions} / ${st.budgetPerHour} per hour (Available: ${st.budgetAvailable})`);
          if (st.createdAt) {
            console.log(`  Oldest Buffered Item  : ${st.createdAt}`);
          }
          if (st.incidents.length > 0) {
            console.log(`\n  Buffered Incidents (${st.incidents.length}):`);
            st.incidents.forEach((inc) => {
              console.log(`   - [${inc.reason}] Session ${inc.sessionId} (${inc.branch})`);
            });
          }
          console.log(`--------------------------------------------------\n`);
        }
        process.exit(0);
      }

      if (values.clear) {
        const res = clearEscalationDigest(root);
        if (values.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`✅ Cleared pending escalation digest buffer.`);
        }
        process.exit(0);
      }

      if (values.flush) {
        const res = await flushEscalationDigest(config, { root, dryRun: values["dry-run"] });
        if (values.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          if (res.flushed) {
            console.log(`\n📢 Flushed Escalation Digest (${res.count} incidents)`);
            console.log(`   Slack   : ${res.slack ? "✅ Delivered" : "❌ Skipped/Failed"}`);
            console.log(`   Discord : ${res.discord ? "✅ Delivered" : "❌ Skipped/Failed"}\n`);
          } else {
            console.log(`ℹ️ Nothing to flush: ${res.reason}`);
          }
        }
        process.exit(0);
      }

      const sessionId = positionals[0] || values.session;
      if (!sessionId) {
        console.error("Error: Session ID is required for agentctl escalate <sessionId> (or use --flush / --status).");
        process.exit(1);
      }

      let logContent = values.logs || "";
      if (values["log-file"] && existsSync(values["log-file"])) {
        logContent = readFileSync(values["log-file"], "utf-8");
      }

      const incident = {
        sessionId,
        branch: values.branch,
        reason: values.reason,
        logs: logContent,
        critical: values.critical,
      };

      const res = await dispatchEscalation(incident, {
        root,
        config,
        dryRun: values["dry-run"],
      });

      if (values.json) {
        console.log(JSON.stringify({ ok: true, result: res }, null, 2));
      } else {
        if (res.buffered) {
          console.log(`\n🔇 Incident buffered by Silence Governor (${res.reason})`);
          console.log(`   Session ID   : ${sessionId}`);
          console.log(`   Digest Count : ${res.digestCount || 1}`);
          console.log(`   (Use 'agentctl escalate --flush' to deliver immediately)\n`);
        } else if (res.dryRun) {
          // Nothing left the machine, so do not claim it did.
          console.log(`\n🧪 Dry run — this incident would be sent immediately:`);
          console.log(`   Session ID : ${sessionId}`);
          console.log(`   Reason     : ${values.reason}`);
          console.log(`   (No request sent, and your hourly interruption budget is untouched.)\n`);
        } else if (res.dispatched) {
          console.log(`\n🚨 Incident Escalation Dispatched!`);
          console.log(`   Session ID : ${sessionId}`);
          console.log(`   Reason     : ${values.reason}`);
          console.log(`   Slack      : ${res.slack ? "✅ Sent" : "N/A"}`);
          console.log(`   Discord    : ${res.discord ? "✅ Sent" : "N/A"}\n`);
        } else {
          console.log(`⚠️ Escalation not dispatched: ${res.reason}`);
        }
      }
      process.exit(0);
      break;
    }

    case "flaky": {
      const {
        listQuarantinedTests,
        clearFlakyLedger,
        runFlakyHealingSwarm,
        synthesizeFlakyHealingTask,
      } = await import("../src/flaky-ledger.mjs");

      const subAction = args[1] || "status";
      const { values, positionals } = parseArgs({
        args: args.slice(2),
        options: {
          dispatch: { type: "boolean" },
          role: { type: "string", short: "r", default: "janitor" },
          "test-cmd": { type: "string", short: "t" },
          "dry-run": { type: "boolean", short: "d" },
          json: { type: "boolean", short: "j" },
        },
        allowPositionals: true,
      });

      if (subAction === "status" || subAction === "list") {
        const quarantined = listQuarantinedTests(root);
        if (values.json) {
          console.log(JSON.stringify({ ok: true, quarantined, count: quarantined.length }, null, 2));
        } else {
          console.log(`\n🧪 Statistical Flaky Test Quarantine (v${VERSION})`);
          console.log(`--------------------------------------------------`);
          if (quarantined.length === 0) {
            console.log(`  ✅ Zero quarantined tests. All suites stable.`);
          } else {
            console.log(`  Found ${quarantined.length} test suite(s) quarantined (Exit Code 8):\n`);
            quarantined.forEach((q, idx) => {
              const oscPct = Math.round(q.oscillation * 100);
              console.log(`  ${idx + 1}. \`${q.testCmd}\``);
              console.log(`     Oscillation: ${oscPct}% (${q.fails} fails / ${q.passes} passes in last ${q.n} runs)`);
              console.log(`     Wilson CI  : [${q.wilson.lower.toFixed(2)}, ${q.wilson.upper.toFixed(2)}]`);
              console.log(`     Last Run   : ${q.lastRunTimestamp}\n`);
            });
            console.log(`  👉 To dispatch auto-healing swarm, run: agentctl flaky heal`);
          }
          console.log(`--------------------------------------------------\n`);
        }
        process.exit(0);
      }

      if (subAction === "heal") {
        const targetCmd = positionals[0] || values["test-cmd"];
        let res;
        if (targetCmd) {
          const taskPlan = synthesizeFlakyHealingTask({ testCmd: targetCmd }, { role: values.role });
          if (values.dispatch && !values["dry-run"]) {
            const { dispatch } = await import("../src/engine.mjs");
            try {
              const session = await dispatch(
                { title: taskPlan.title, prompt: taskPlan.prompt, role: taskPlan.role },
                { root, config }
              );
              taskPlan.session = session;
              taskPlan.dispatched = true;
            } catch (err) {
              taskPlan.dispatchError = err.message;
              taskPlan.dispatched = false;
            }
          } else if (!values["dry-run"]) {
            const { writeFileSync } = await import("node:fs");
            const queueDir = getQueueDir(root);
            const filePath = join(queueDir, `${taskPlan.taskId}.md`);
            writeFileSync(filePath, taskPlan.fullEnvelope, "utf-8");
            taskPlan.taskFile = filePath;
            taskPlan.queued = true;
          }
          res = { count: 1, tasks: [taskPlan], dryRun: values["dry-run"] };
        } else {
          res = await runFlakyHealingSwarm(root, {
            dispatch: values.dispatch,
            dryRun: values["dry-run"],
            role: values.role,
          });
        }

        if (values.json) {
          console.log(JSON.stringify({ ok: true, ...res }, null, 2));
        } else {
          if (res.count === 0) {
            console.log(`ℹ️ ${res.message || "No quarantined tests to heal."}`);
          } else {
            console.log(`\n🩹 Flaky Test Healing Swarm (${res.count} task${res.count > 1 ? "s" : ""})`);
            console.log(`--------------------------------------------------`);
            res.tasks.forEach((t) => {
              console.log(`  • ${t.title}`);
              if (t.taskFile) console.log(`    Queued: ${t.taskFile}`);
              if (t.session) console.log(`    Dispatched Session: ${t.session.id}`);
            });
            console.log(`--------------------------------------------------\n`);
          }
        }
        process.exit(0);
      }

      if (subAction === "reset" || subAction === "clear") {
        const targetCmd = positionals[0] || values["test-cmd"] || null;
        const res = clearFlakyLedger(root, targetCmd);
        if (values.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`✅ Flaky test ledger reset (${targetCmd ? `command: ${targetCmd}` : "all tests"}).`);
        }
        process.exit(0);
      }

      console.error(`Unknown flaky subaction: '${subAction}'. Supported: agentctl flaky status | heal | reset`);
      process.exit(1);
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
          "dry-run": { type: "boolean", short: "d" },
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
            "dry-run": { type: "boolean", short: "d" },
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
          "dry-run": { type: "boolean", short: "d" },
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

    case "evidence": {
      const subAction = args[1] || "show";
      const { planEvidenceGenerate, planEvidenceVerify, planEvidenceShow } = await import("../src/ops/evidence-actions.mjs");
      const { values } = parseArgs({
        args: args.slice(2),
        options: {
          output: { type: "string", short: "o" },
          manifest: { type: "string", short: "m" },
          markdown: { type: "string" },
          json: { type: "boolean", short: "j" },
          "dry-run": { type: "boolean", short: "d" },
        },
        allowPositionals: true,
      });

      if (subAction === "generate" || subAction === "create") {
        const res = planEvidenceGenerate(root, {
          output: values.output,
          markdownOutput: values.markdown,
        });
        if (values.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`\n🛡️ Cryptographic Evidence Manifest Generated!`);
          console.log(`   Manifest ID : ${res.manifest.manifestId}`);
          console.log(`   Signature   : ${res.manifest.evidenceHash}`);
          console.log(`   Location    : ${res.manifestPath}`);
          console.log(`   Test Files  : ${res.manifest.testIntegrity.testFileCount}`);
          console.log(`   Tampered    : ${res.manifest.testIntegrity.tamperDetected ? "YES (FAILED)" : "NO (VERIFIED)"}\n`);
        }
        process.exit(res.manifest.testIntegrity.tamperDetected ? 1 : 0);
      } else if (subAction === "verify" || subAction === "check") {
        const res = planEvidenceVerify(root, {
          manifest: values.manifest,
        });
        if (values.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          if (res.ok) {
            console.log(`\n✅ Evidence Verification PASSED`);
            console.log(`   Manifest ID : ${res.manifestId}`);
            console.log(`   Signature   : ${res.evidenceHash}\n`);
          } else {
            console.error(`\n❌ Evidence Verification FAILED`);
            console.error(`   Reason      : ${res.reason}`);
            if (res.details) {
              console.error(`   Details     : ${JSON.stringify(res.details)}\n`);
            }
          }
        }
        process.exit(res.ok ? 0 : 1);
      } else if (subAction === "show" || subAction === "print") {
        const res = planEvidenceShow(root, {
          manifest: values.manifest,
        });
        if (values.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          if (res.ok) {
            console.log(`\n${res.markdown}\n`);
          } else {
            console.error(`\n❌ Failed to show evidence: ${res.reason}\n`);
          }
        }
        process.exit(res.ok ? 0 : 1);
      } else {
        console.error(`Unknown evidence subaction: ${subAction}. Use generate | verify | show.`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  if (err.name === "WizardCancelledError" || err.code === 130 || (err instanceof Error && err.message?.includes("cancelled by user"))) {
    console.log(`\n🛑 ${err.message || "Operation cancelled by user."}`);
    process.exit(130);
  }
  console.error(`[FATAL ERROR] ${err.message}`);
  const exitCode = typeof err.code === "number" ? err.code : 1;
  process.exit(exitCode);
});
