#!/usr/bin/env node

import { parseArgs } from "node:util";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyEnvAliases } from "../src/env-aliases.mjs";
import { selectFailureOutput } from "../src/ops/verify-output.mjs";
import { loadConfig, resolveRoot, detectStack, bootstrapZeroTestRepo } from "../src/config.mjs";
import { gate, dispatch, run, isTaskFile } from "../src/engine.mjs";
import { acquireLock, releaseLock, lockStatus, getQueueDir } from "../src/state.mjs";
import { worktreePrune } from "../src/git.mjs";
import { reapOrphanedIntents, reapStaleMutexDirs } from "../src/journal.mjs";
import { KIT_VERSION } from "../src/version.mjs";
import { budgetStatus, listOpenReservations, releaseOpenReservations, resolveConcurrency } from "../src/budget.mjs";

// Vendor-neutral env spellings are filled in before any module reads
// process.env, so `AGENT_API_KEY` works everywhere `JULES_API_KEY` does. A
// value already present under the legacy name always wins — see
// src/env-aliases.mjs.
applyEnvAliases(process.env);

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
agentctl v${VERSION} — Universal Agent Orchestrator & Safety Gatekeeper

Usage: agentctl <command> [options]

Commands:
  dispatch | create     Dispatch a single task to an AI agent (--role <name>, --tier fast|complex, --check-premise)
  check                 Run all-in-one CI security, rules, and stack verification gate
  gate | audit          Run CI security and verification gate against current branch
  mutate | mutation     Run zero-dependency diff mutation testing harness (--min-score, --max-mutants)
  coverage              Run native zero-dependency V8 diff coverage check (--min, --cmd)
  probe | stability     Run test flakiness stability probe across N repetitions (--repeat, --cmd)
  perf | event-loop     Monitor Node.js event loop delay and Big-O lag (--max-ms, --cmd)
  fix                   Auto-repair from piped terminal logs or error trace (npm test 2>&1 | agentctl fix)
  rules <action>        Audit rule token budgets or compile rule sentinels (check | compile)
  queue                 Run pending task queue (--dag, --concurrency <n>)
  swarm                 Run parallel task swarm
  mcp                   Start stdio Model Context Protocol (MCP) server
  clean                 Clean stale branches, worktrees, locks, and ledgers
  lock <action>         Manage mutex locks (acquire [--ttl <min>] [--pid <n>] | release | status)
  doctor                Run system diagnostics and stack resolution checks
  providers             List agent providers and whether this machine can reach them (--json)
  provider set <name>   Switch the active provider in .agent/config.yml
  profile               Show or set the verification profile (--list, --set <name>, --json)
  ci init               Generate a stack-aware CI gate workflow (--target github|gitlab, --force)
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
  patch <id>            Extract and test/apply git patch from a Jules session (--apply, --save)
  retry <id>            Retry failed session with automated failure-trace injection (--role)
  prune                 Batch-archive or delete stale sessions via Jules API (--age 7d, --yes)
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
  --prompt, -p          Task prompt text — dispatch, task create and task optimize
                        also accept it as a positional argument
  --prompt-file, -f     Read the prompt from a file (-f is --fix on task optimize)
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

/**
 * Resolve the prompt text a command was given, from any of the three forms.
 *
 * The commands that take a prompt each accepted a different subset: `dispatch`
 * took a flag, a file or a positional; `task create` took only `--prompt`; and
 * `task optimize` took only a positional. The form an operator learned on one
 * command then failed on the next — loudly on `task create "do the thing"`,
 * which reported a missing prompt while holding one, and silently on
 * `task optimize --prompt "..."`, which optimised an empty string.
 *
 * @param {Record<string, unknown>} values Parsed flags.
 * @param {string[]} [positionals] Remaining free arguments.
 * @returns {string} The prompt, or "" when none was supplied.
 */
function resolvePromptInput(values, positionals = []) {
  const file = values["prompt-file"] || values.file;
  if (file) {
    if (!existsSync(file)) {
      console.error(`Error: prompt file not found: ${file}`);
      process.exit(1);
    }
    return readFileSync(file, "utf-8");
  }
  if (values.prompt) return String(values.prompt);
  return positionals.join(" ").trim();
}

/**
 * Renders the outcome of a queue or swarm run and returns the exit code.
 *
 * The per-task failures used to be dropped on the floor. A run where every
 * task was rejected — no API key is the common one — still printed
 * "Processed 3 task(s)." and exited 0, so neither an operator nor a CI job
 * could tell a dispatched queue from a dead one. The failures were already in
 * the result object the whole time; only `--json` ever showed them.
 *
 * @param {{ processed?: number, results?: Array<{file?: string, ok?: boolean, status?: string, error?: string}> }} outcome
 * @returns {number} 0 when every task succeeded, 1 when any failed.
 */
function reportRunOutcome(outcome) {
  const items = Array.isArray(outcome?.results) ? outcome.results : [];
  const failed = items.filter((r) => r && r.ok === false);
  const succeeded = items.length - failed.length;

  console.log(`\nProcessed ${outcome?.processed ?? items.length} task(s): ${succeeded} ok, ${failed.length} failed.`);

  if (failed.length > 0) {
    console.error(`\n❌ ${failed.length} task(s) did not dispatch:`);
    for (const f of failed) {
      const reason = f.error || f.status || "Unknown error";
      console.error(`   - ${f.file || f.taskId || "task"}: ${reason}`);
    }
    // A failed task is left in the queue rather than moved to completed/, so
    // fixing the cause and re-running is the whole recovery procedure.
    console.error(`\n   These tasks are still queued. Fix the cause above and re-run.`);
    return 1;
  }
  if (items.some((r) => r && r.dryRun)) {
    console.log(`   Dry run — no provider call was made and nothing was dispatched.`);
  }
  return 0;
}

/**
 * Render the stage, exit code and captured output of a failed verify phase.
 *
 * VERIFY is the one gate phase whose failure the operator has to fix in their
 * own code, and it was the only one that printed nothing beyond "❌ FAIL" —
 * the command's output was captured, hashed into the evidence manifest, and
 * then discarded before anyone could read it.
 *
 * @param {{ stageId?: string, command?: string|null, exitCode?: number|null, stdout?: string, stderr?: string, diagnostics?: string[] }} failure
 */
const VERIFY_OUTPUT_TAIL_LINES = 20;

function printVerifyFailure(failure) {
  const exit = failure.exitCode === null || failure.exitCode === undefined ? "n/a" : failure.exitCode;
  console.log(`     - Stage: ${failure.stageId || "verify"} (exit ${exit})`);
  if (failure.command) console.log(`     - Command: ${failure.command}`);
  for (const d of failure.diagnostics || []) console.log(`     - ${d}`);

  const output = selectFailureOutput(failure);
  if (!output) return;
  const lines = output.split("\n");
  const tail = lines.slice(-VERIFY_OUTPUT_TAIL_LINES);
  console.log(`     - Output${tail.length < lines.length ? ` (last ${VERIFY_OUTPUT_TAIL_LINES} of ${lines.length} lines)` : ""}:`);
  for (const line of tail) console.log(`         ${line}`);
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

  // Resolve --help / -h on subcommands (e.g. `agentctl init --help`, `agentctl mutate --help`)
  const subArgs = args.slice(1);
  if (subArgs.includes("--help") || subArgs.includes("-h")) {
    const { getCommandDescriptor, formatCommandHelp } = await import("../src/ops/command-registry.mjs");
    const subSub = subArgs[0] && !subArgs[0].startsWith("-") ? `${command} ${subArgs[0]}` : command;
    const desc = getCommandDescriptor(subSub) || getCommandDescriptor(command);
    if (desc) {
      console.log(formatCommandHelp(desc));
      process.exit(0);
    }
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
      const { values, positionals } = parseArgs({
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
          author: { type: "string" },
          "dry-run": { type: "boolean", short: "d" },
          json: { type: "boolean", short: "j" },
        },
        allowPositionals: true,
      });

      const promptContent = resolvePromptInput(values, positionals);
      if (!promptContent) {
        console.error("Error: a prompt is required — pass it as --prompt, --prompt-file, or a positional argument.");
        process.exit(1);
      }

      // `task create --role` has always rejected a role it cannot resolve;
      // `dispatch --role` used to drop it without a word and hand the work to a
      // generic agent, so the two commands disagreed about what the same flag
      // means. An explicitly typed role is a statement of intent — failing here
      // is the only way the operator learns the prompt file is missing.
      if (values.role) {
        const { resolveRolePrompt } = await import("../src/role-resolver.mjs");
        if (!resolveRolePrompt(root, values.role, { config })) {
          console.error(
            `Error: Unknown agent role '${values.role}'. Expected matching prompt file in .agent/prompts/ (e.g. Overseer, Bolt, Sentinel, Janitor).`
          );
          console.error(`   Run 'agentctl init' to scaffold the shipped role prompts.`);
          process.exit(1);
        }
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
        author: values.author,
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
          } else if (values["dry-run"]) {
            // The dry run reached the provider adapter and stopped short of the
            // call. Printing the same "Dispatched Successfully!" banner as a
            // real dispatch made the two indistinguishable in a terminal, so a
            // rehearsal read as work in flight and the operator waited for a
            // session that was never going to exist.
            console.log(`\n🧪 Dry Run — nothing was dispatched.`);
            console.log(`   Title       : ${task.title}`);
            console.log(`   Provider    : ${session.provider || config.provider || "jules"}`);
            if (task.role) console.log(`   Role        : ${task.role}`);
            if (session._routeTier) {
              console.log(`   Router Tier : ${session._routeTier} (${session._routeReason || "n/a"})`);
            }
            console.log(`\n   Re-run without --dry-run to dispatch for real.`);
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

    case "check":
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
          // The tamper guard has always had an override — `allowTestModifications`
          // — and it was reachable only from JavaScript. So a legitimate change
          // of spec, which necessarily rewrites what a test expects, hit a
          // CRITICAL finding at exit 6 with no documented way past it. A guard
          // with no override is not a guard, it is an outage.
          //
          // This one is the blunt form and turns off all six checks. Prefer
          // `--allow-test-change <kind>`: answering one finding should not
          // silence five other checks nobody looked at.
          "allow-test-modifications": { type: "boolean" },
          "allow-test-change": { type: "string", multiple: true },
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
        allowTestModifications: values["allow-test-modifications"],
        allowTestChanges: values["allow-test-change"],
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
            p.findings.forEach((f) => console.log(`     - [${f.severity}] ${f.type}: ${f.description}`));
          }
          // `git_resolution` reports its cause in `error` and nothing else.
          // Never rendering it meant an unresolvable base branch printed a bare
          // "Phase [GIT_RESOLUTION] : ❌ FAIL" and the operator had to re-run
          // with --json to find out what the tool had objected to.
          if (!p.ok && p.error) {
            console.log(`     - Error: ${p.error}`);
          }
          if (!p.ok && p.failure) {
            printVerifyFailure(p.failure);
          }
        }
        console.log(`-----------------------------------------------------`);
        console.log(`Overall Result: ${res.ok ? "APPROVED (Exit 0)" : `REJECTED (Exit ${res.code})`}\n`);
        if (!res.ok) {
          const failedPhase = res.phases.find((p) => !p.ok)?.phase;
          // The secret scanner also carries the integrity findings, so exit 6
          // alone cannot pick the hint: a weakened assertion and a leaked key
          // arrive under the same phase and the same code.
          const secretsPhase = res.phases.find((p) => p.phase === "secrets" && !p.ok);
          const findingTypes = new Set((secretsPhase?.findings || []).map((f) => f.type));
          const INTEGRITY_TYPES = new Set([
            "TEST_TAMPERING_DETECTED",
            "EDGE_RUNTIME_VIOLATION",
            "CROSS_PACKAGE_BOUNDARY_VIOLATION",
          ]);
          const onlyIntegrityFindings =
            findingTypes.size > 0 && [...findingTypes].every((t) => INTEGRITY_TYPES.has(t));

          // Exit 3 is also what a strictTestLock tamper verdict returns, so the
          // code alone cannot pick the hint — a scope remediation for a rewritten
          // test file sends the operator to the wrong flag entirely.
          if (res.repairs) {
            // A repair loop that never reached the agent is not an exhausted
            // repair loop. Telling someone their tests could not be fixed when
            // the provider rejected the credential sends them to read test
            // output that was never produced.
            const providerFailure =
              res.repairs.finalStatus === "PROVIDER_INFRASTRUCTURE_FAILURE" ||
              (res.repairs.attempts || []).every((a) => a && a.ok === false && a.error);
            const firstError = (res.repairs.attempts || []).find((a) => a && a.error)?.error || res.repairs.error;
            if (providerFailure && firstError) {
              console.log(`💡 Remediation Hint (Exit 4 — the repair agent never ran):`);
              console.log(`   • The provider rejected the dispatch, so no repair was attempted.`);
              console.log(`   • Provider error: ${firstError}`);
              console.log(`   • Check the provider is usable: agentctl providers`);
              console.log(`   • The verification failure above is unchanged — fix it locally, or retry once the provider works.\n`);
            } else {
              console.log(`💡 Remediation Hint (Exit 4 OODA Repair Exhausted):`);
              console.log(`   • Automated self-repair could not pass tests cleanly.`);
              if (firstError) console.log(`   • Last attempt error: ${firstError}`);
              console.log(`   • Review error fingerprints via: agentctl doctor\n`);
            }
          } else if (onlyIntegrityFindings) {
            console.log(`💡 Remediation Hint (Exit ${res.code} Test Integrity Violation — no secret was found):`);
            console.log(`   • The diff weakens or removes verification rather than leaking a credential.`);
            console.log(`   • Restore the assertion the finding names. A requirement that is not met belongs`);
            console.log(`     RED with a stated reason, not silenced.`);
            console.log(`   • Nothing needs rotating: this exit code is shared with the secret scanner.\n`);
          } else if (res.flakyVerdict?.verdict === "QUARANTINED") {
            console.log(`💡 Remediation Hint (Exit 8 Flaky Test Quarantined):`);
            console.log(`   • This command has alternated between pass and fail across recent runs.`);
          } else if (res.code === 188) {
            console.log(`💡 Remediation Hint (Exit 188 Offline Network Violation / Infrastructure):`);
            console.log(`   • An unmocked network request was blocked by the preload network guard during verification.`);
            console.log(`   • Ensure dependencies are installed locally (run: npm install) and all network calls in tests are mocked.\n`);
          } else if (res.phases.find((p) => p.phase === "verify" && !p.ok)?.failure?.stageId === "oracle") {
            // Nothing exited non-zero here and --fix cannot help: there was no
            // command to run. Offering the repair loop would send an agent to
            // fix a failure that does not exist.
            console.log(`💡 Remediation Hint (Exit ${res.code} No Verification Oracle):`);
            console.log(`   • Nothing was executed against this change, so the gate cannot approve it.`);
            console.log(`   • Give it a command:   agentctl bootstrap        (generates one for this stack)`);
            console.log(`   • Or set it by hand:   verify.test in ${config._file || ".agent/config.yml"}`);
            console.log(`   • Scope- and secret-scanning only, on purpose? Set verify.required: false there.\n`);
          } else if (failedPhase === "verify" || failedPhase === "evidence") {
            console.log(`💡 Remediation Hint (Exit ${res.code} Verification Failed):`);
            console.log(`   • The stage above exited non-zero. Reproduce it locally, then re-run the gate.`);
            console.log(`   • To let agentctl attempt the repair loop itself, pass: agentctl gate --fix\n`);
          } else if (res.code === 3) {
            // The same violation has two very different causes. Right after
            // `init`, every offending path is a file the tool itself just wrote
            // and has not committed — advising --allow-protected there teaches
            // the newcomer to bypass the gate on their first run, when what
            // they need is `git commit`.
            const scopeFiles = (res.phases.find((p) => p.phase === "scope")?.violations || [])
              .map((v) => v.file)
              .filter(Boolean);
            const { partitionTracked } = await import("../src/git.mjs");
            const { tracked, untracked } = partitionTracked(root, scopeFiles);
            const allNewScaffolding =
              untracked.length > 0 &&
              tracked.length === 0 &&
              untracked.every((f) => /^(\.agent\/|AGENTS\.md$|SPEC\.md$|CONSTRAINTS\.md$|DESIGN\.md$)/.test(f));

            if (allNewScaffolding) {
              console.log(`💡 Remediation Hint (Exit ${res.code} — these are the files init just wrote):`);
              console.log(`   • The agent manifest and guardrails are gate-protected on purpose: an agent must`);
              console.log(`     not edit the rules it is governed by. Uncommitted, they read as exactly that.`);
              console.log(`   • Commit them once and the gate goes green:`);
              console.log(`       git add ${untracked.join(" ")} && git commit -m "chore: add agent config"\n`);
            } else {
              console.log(`💡 Remediation Hint (Exit ${res.code} Scope Violation):`);
              console.log(`   • To allow protected files in this run, pass: agentctl gate --allow-protected`);
              console.log(`   • Or remove protected/denied paths from the diff before dispatching.\n`);
            }
          } else if (failedPhase === "git_resolution") {
            console.log(`💡 Remediation Hint (Exit ${res.code} Base Branch Unresolvable):`);
            console.log(`   • The gate compares your work against a base branch, and this one is not reachable.`);
            console.log(`   • This repository's branches: git branch -a`);
            console.log(`   • Point the gate at the right one: agentctl check --base <branch>`);
            console.log(`   • Or record it once in .agent/config.yml as: base_branch: <branch>\n`);
          } else if (res.code === 5) {
            console.log(`💡 Remediation Hint (Exit 5 Diff Payload Overflow):`);
            console.log(`   • Total diff exceeds ${config.limits?.diffKb || 75} KB limit.`);
            console.log(`   • Split the task into smaller atomic tasks using: agentctl task create\n`);
          } else if (res.code === 6) {
            console.log(`💡 Remediation Hint (Exit 6 Secret Leak Prevented):`);
            console.log(`   • High-entropy credential or secret detected in patch.`);
            console.log(`   • Scrub credential from source and rotate any exposed keys immediately.\n`);
          }
        }
      }

      process.exit(typeof res.code === "number" ? res.code : 0);
      break;
    }

    case "mutate":
    case "mutation": {
      const { runMutationTest } = await import("../src/mutation.mjs");
      const { values } = parseArgs({
        args: args.slice(1),
        options: {
          base: { type: "string", short: "b", default: config.baseBranch || "main" },
          mode: { type: "string", short: "m", default: "working-tree" },
          "working-tree": { type: "boolean" },
          staged: { type: "boolean" },
          committed: { type: "boolean" },
          "min-score": { type: "string", default: "80" },
          "max-mutants": { type: "string", default: "20" },
          cmd: { type: "string" },
          json: { type: "boolean", short: "j" },
        },
        allowPositionals: true,
      });

      let selectedMode = values.mode || "working-tree";
      if (values.staged) selectedMode = "staged";
      if (values.committed) selectedMode = "committed";
      if (values["working-tree"]) selectedMode = "working-tree";

      // `Number(x) || default` swallows a legitimate zero: `--min-score 0`,
      // the way to run the harness for its report without a threshold, silently
      // enforced 80. Both flags already carry a parseArgs default, so the only
      // thing left to guard against is a value that is not a number at all.
      const parseNumericFlag = (raw, fallback) => {
        const n = Number(raw);
        return Number.isFinite(n) ? n : fallback;
      };
      const minScore = parseNumericFlag(values["min-score"], 80);
      const maxMutants = parseNumericFlag(values["max-mutants"], 20);
      const testCmd = values.cmd || config.verify?.test || "npm test";

      if (!values.json) {
        console.log(`\n🧬 Jules Diff Mutation Testing Harness (Base: ${values.base}, Mode: ${selectedMode})`);
        console.log(`------------------------------------------------------------------`);
        console.log(`Evaluating candidate mutants against test command: "${testCmd}"...\n`);
      }

      const report = runMutationTest({
        root,
        base: values.base,
        mode: selectedMode,
        minScore,
        maxMutants,
        testCmd,
      });

      if (values.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`Mutation Test Results:`);
        console.log(`  • Total Mutants Evaluated : ${report.totalMutants}`);
        console.log(`  • Mutants Killed (Fail)   : ${report.killedMutants} ✅`);
        console.log(`  • Mutants Survived (Pass) : ${report.survivedMutants} ${report.survivedMutants > 0 ? "⚠️" : ""}`);
        console.log(`  • Errors / Timeouts       : ${report.errorMutants}`);
        console.log(
          report.scored === false
            ? `  • Mutation Score          : n/a — ${report.reason}`
            : `  • Mutation Score          : ${report.mutationScore}% (Required: ${report.minScore}%)`
        );
        console.log(`  • Duration                : ${report.durationMs}ms\n`);

        if (report.survivors.length > 0) {
          console.log(`⚠️ Survived Mutants (Tests passed despite corrupted implementation):`);
          for (const s of report.survivors) {
            console.log(`  - [${s.mutant.mutationType}] ${s.mutant.file}:${s.mutant.line}`);
            console.log(`    Original: ${s.mutant.originalLine.trim()}`);
            console.log(`    Mutated : ${s.mutant.mutatedLine.trim()}`);
            console.log(`    Reason  : ${s.mutant.description}\n`);
          }
        }

        console.log(`------------------------------------------------------------------`);
        console.log(`Overall Result: ${report.ok ? "APPROVED (Exit 0)" : "REJECTED (Mutation score below threshold — Exit 1)"}\n`);
      }

      process.exit(report.ok ? 0 : 1);
      break;
    }

    case "coverage": {
      const { runV8Coverage, calculateDiffCoverage, diffText, resolveRoot } = await import("../index.mjs");
      const { values } = parseArgs({
        args: args.slice(1),
        options: {
          min: { type: "string", short: "m" },
          "min-coverage": { type: "string" },
          cmd: { type: "string", short: "c" },
          base: { type: "string", short: "b" },
          mode: { type: "string" },
          json: { type: "boolean", short: "j" },
        },
        allowPositionals: true,
      });

      const root = resolveRoot();
      const minCoverage = values.min ? parseFloat(values.min) : (values["min-coverage"] ? parseFloat(values["min-coverage"]) : 100);
      // `config.baseBranch` was skipped here while every other gate honoured it,
      // so `agentctl coverage` alone died on "Cannot resolve base reference
      // main" in any repository not on `main`.
      const coverageBase = values.base || config.baseBranch || "main";
      const diffStr = diffText(root, coverageBase, values.mode || "working-tree");

      const covRes = runV8Coverage(values.cmd, { root });
      const report = calculateDiffCoverage(covRes.coverageByFile, diffStr, { root, minCoverage });

      if (values.json) {
        console.log(JSON.stringify({ ...report, testPass: covRes.ok }, null, 2));
      } else {
        console.log(`\n📊 V8 Native Diff Coverage Report (Base: ${coverageBase})`);
        console.log(`------------------------------------------------------------------`);
        console.log(`  Target Min Coverage : ${report.minCoverage}%`);
        console.log(`  Achieved Coverage   : ${report.score}%`);
        console.log(`  Covered Added Lines : ${report.coveredLines} / ${report.totalLines}`);
        console.log(`  Missed Lines Count  : ${report.missedLines}`);

        if (report.missedLines > 0) {
          console.log(`\n❌ Uncovered Added Lines by File:`);
          for (const [file, lines] of Object.entries(report.missedByFile)) {
            console.log(`  - ${file}: lines ${lines.join(", ")}`);
          }
        }

        console.log(`------------------------------------------------------------------`);
        console.log(`Overall Result: ${report.ok && covRes.ok ? "APPROVED (Exit 0)" : "REJECTED (Coverage below threshold — Exit 1)"}\n`);
      }

      process.exit(report.ok && covRes.ok ? 0 : 1);
      break;
    }

    case "probe":
    case "stability": {
      const { runStabilityProbe, resolveRoot } = await import("../index.mjs");
      const { values } = parseArgs({
        args: args.slice(1),
        options: {
          repeat: { type: "string", short: "r" },
          iterations: { type: "string", short: "n" },
          min: { type: "string", short: "m" },
          "min-pass-rate": { type: "string" },
          cmd: { type: "string", short: "c" },
          json: { type: "boolean", short: "j" },
        },
        allowPositionals: true,
      });

      const root = resolveRoot();
      const repeat = values.repeat ? parseInt(values.repeat, 10) : (values.iterations ? parseInt(values.iterations, 10) : 5);
      const minPassRate = values.min ? parseFloat(values.min) : (values["min-pass-rate"] ? parseFloat(values["min-pass-rate"]) : 1.0);

      const report = runStabilityProbe(values.cmd, { root, repeat, minPassRate });

      if (values.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`\n🎲 Test Flakiness Stability Probe (${report.repeat} iterations)`);
        console.log(`------------------------------------------------------------------`);
        console.log(`  Required Pass Rate  : ${Math.round(minPassRate * 100)}%`);
        console.log(`  Observed Pass Rate  : ${Math.round(report.passRate * 100)}% (${report.passes}/${report.repeat} passed)`);
        console.log(`  Test Oscillation    : ${report.oscillation}`);
        console.log(`  Total Duration      : ${report.durationMs}ms`);

        if (report.failures > 0) {
          console.log(`\n❌ Failed Iterations:`);
          for (const r of report.runs.filter((run) => !run.pass)) {
            console.log(`  - Iteration #${r.iteration}: Exit Code ${r.exitCode} (${r.durationMs}ms)`);
          }
        }

        console.log(`------------------------------------------------------------------`);
        console.log(`Overall Result: ${report.ok ? "APPROVED (Deterministic 100% Pass — Exit 0)" : "REJECTED (Flaky / Intermittent Failures — Exit 1)"}\n`);
      }

      process.exit(report.ok ? 0 : 1);
      break;
    }

    case "perf":
    case "event-loop": {
      const { measureEventLoopDelay, resolveRoot } = await import("../index.mjs");
      const { values } = parseArgs({
        args: args.slice(1),
        options: {
          "max-ms": { type: "string", short: "m" },
          threshold: { type: "string", short: "t" },
          cmd: { type: "string", short: "c" },
          resolution: { type: "string", short: "r" },
          json: { type: "boolean", short: "j" },
        },
        allowPositionals: true,
      });

      const root = resolveRoot();
      const maxDelayMs = values["max-ms"] ? parseFloat(values["max-ms"]) : (values.threshold ? parseFloat(values.threshold) : 50);
      const resolution = values.resolution ? parseInt(values.resolution, 10) : 10;

      const report = measureEventLoopDelay(values.cmd, { root, maxDelayMs, resolution });

      if (values.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`\n⏱️ Node.js Event Loop Lag & Big-O Monitor`);
        console.log(`------------------------------------------------------------------`);
        console.log(`  Threshold Max / p99 : ${report.thresholdMs}ms`);
        console.log(`  Observed p99 Delay  : ${report.p99Ms}ms`);
        console.log(`  Observed Max Delay  : ${report.maxMs}ms`);
        console.log(`  Observed Mean Delay : ${report.meanMs}ms`);
        console.log(`  Total Test Duration : ${report.durationMs}ms`);
        console.log(`  Exit Code           : ${report.exitCode}`);
        console.log(`------------------------------------------------------------------`);
        console.log(`Overall Result: ${report.ok ? "APPROVED (Event Loop Healthy — Exit 0)" : "REJECTED (High Event Loop Lag / O(n^2) Starvation — Exit 1)"}\n`);
      }

      process.exit(report.ok ? 0 : 1);
      break;
    }

    case "fix": {
      const { repair, planTaskCreate, resolveRoot, redactSecrets } = await import("../index.mjs");
      const { values, positionals } = parseArgs({
        args: args.slice(1),
        options: {
          input: { type: "string", short: "i" },
          file: { type: "string", short: "f" },
          cmd: { type: "string", short: "c" },
          task: { type: "boolean", short: "t" },
          author: { type: "string" },
          json: { type: "boolean", short: "j" },
          "dry-run": { type: "boolean" },
        },
        allowPositionals: true,
      });

      const root = resolveRoot();
      let errorInput = "";

      if (values.file && existsSync(values.file)) {
        errorInput = readFileSync(values.file, "utf-8");
      } else if (values.input) {
        errorInput = values.input;
      } else if (positionals.slice(1).length > 0) {
        errorInput = positionals.slice(1).join(" ");
      } else if (!process.stdin.isTTY) {
        errorInput = readFileSync(0, "utf-8");
      }

      if (!errorInput.trim()) {
        console.error("❌ Error: No error log or failure input provided. Pipe stdout/stderr via `npm test 2>&1 | agentctl fix` or provide --file/--input.");
        process.exit(1);
      }

      const cleanTrace = redactSecrets(errorInput);

      if (values.task) {
        // Synthesize task envelope for queue
        const taskEnvelope = planTaskCreate(root, {
          prompt: `Fix the following test/build failure:\n\n${cleanTrace.slice(0, 4000)}`,
          title: "Automated Failure Repair",
          verifyCmd: values.cmd || "npm test",
        });

        if (values.json) {
          console.log(JSON.stringify(taskEnvelope, null, 2));
        } else {
          console.log(`\n📋 Synthesized OODA Repair Task Envelope:`);
          console.log(`  ID     : ${taskEnvelope.taskId}`);
          console.log(`  Verify : ${taskEnvelope.verifyCmd}`);
          console.log(`  Prompt : ${taskEnvelope.prompt.slice(0, 100)}...`);
        }
        process.exit(0);
      } else {
        console.log(`\n🔧 Dispatching OODA Repair Loop for captured failure trace...`);
        const repairRes = await repair(
          { stderr: cleanTrace, command: values.cmd || "verify" },
          { root, dryRun: values["dry-run"], author: values.author }
        );

        if (values.json) {
          console.log(JSON.stringify(repairRes, null, 2));
        } else {
          console.log(`------------------------------------------------------------------`);
          console.log(`Repair Status: ${repairRes.ok ? "RESOLVED (Exit 0)" : `FAILED (${repairRes.finalStatus} — Exit 1)`}`);
        }

        process.exit(repairRes.ok ? 0 : 1);
      }
      break;
    }

    case "patch": {
      const { applySessionPatch, resolveRoot } = await import("../index.mjs");
      const { values, positionals } = parseArgs({
        args: args.slice(1),
        options: {
          session: { type: "string", short: "s" },
          apply: { type: "boolean", short: "a" },
          save: { type: "string" },
          json: { type: "boolean", short: "j" },
        },
        allowPositionals: true,
      });

      const sessionId = values.session || positionals[0] || positionals[1];
      if (!sessionId) {
        console.error("❌ Error: Missing required session ID. Usage: agentctl patch <session_id> [--apply] [--save <path>]");
        process.exit(1);
      }

      const root = resolveRoot();
      const res = await applySessionPatch(sessionId, {
        root,
        apply: Boolean(values.apply),
        save: values.save,
      });

      if (values.json) {
        console.log(JSON.stringify(res, null, 2));
      } else if (!res.ok) {
        console.error(`\n❌ Failed to extract or apply patch for session ${sessionId}:`);
        console.error(`   ${res.error || "Unknown error"}\n`);
      } else {
        console.log(`\n📦 Session Git Patch (${sessionId})`);
        console.log(`------------------------------------------------------------------`);
        console.log(`  Modified Files      : ${res.files && res.files.length > 0 ? res.files.join(", ") : "None"}`);
        console.log(`  git apply --check   : ${res.checkPassed ? "✅ CLEAN PASS" : "❌ CONFLICT"}`);
        console.log(`  Applied to Disk     : ${res.patchApplied ? "✅ APPLIED" : "DRY-RUN ONLY (--apply to write)"}`);
        if (values.save) {
          console.log(`  Saved to File       : ${values.save}`);
        }
        if (!values.apply && !values.save && res.patch) {
          console.log(`\n--- Patch Content ---\n${res.patch}\n---------------------\n`);
        }
      }

      process.exit(res.ok ? 0 : 1);
      break;
    }

    case "retry": {
      const { retrySession, resolveRoot } = await import("../index.mjs");
      const { values, positionals } = parseArgs({
        args: args.slice(1),
        options: {
          session: { type: "string", short: "s" },
          role: { type: "string", short: "r" },
          title: { type: "string", short: "t" },
          "without-failure": { type: "boolean" },
          "dry-run": { type: "boolean", short: "d" },
          json: { type: "boolean", short: "j" },
        },
        allowPositionals: true,
      });

      const sessionId = values.session || positionals[0] || positionals[1];
      if (!sessionId) {
        console.error("❌ Error: Missing required session ID. Usage: agentctl retry <session_id> [--role <role>]");
        process.exit(1);
      }

      const root = resolveRoot();
      const res = await retrySession(sessionId, {
        root,
        role: values.role,
        title: values.title,
        withFailure: values["without-failure"] ? false : true,
        dryRun: Boolean(values["dry-run"]),
      });

      if (values.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(`\n🔄 Session Retry Dispatched!`);
        console.log(`------------------------------------------------------------------`);
        console.log(`  Original Session    : ${res.originalSessionId}`);
        console.log(`  New Session ID      : ${res.newSession?.id || "N/A"}`);
        console.log(`  Failure Trace Added : ${res.failureReason ? "YES" : "NO"}`);
        console.log(`------------------------------------------------------------------\n`);
      }

      process.exit(res.ok ? 0 : 1);
      break;
    }

    case "prune": {
      const { pruneSessions, resolveRoot } = await import("../index.mjs");
      const { values } = parseArgs({
        args: args.slice(1),
        options: {
          age: { type: "string", short: "a" },
          state: { type: "string", short: "s" },
          delete: { type: "boolean" },
          "dry-run": { type: "boolean", short: "d" },
          yes: { type: "boolean", short: "y" },
          json: { type: "boolean", short: "j" },
        },
        allowPositionals: true,
      });

      const root = resolveRoot();
      const dryRun = values["dry-run"] || (!values.yes && !values.delete);
      const res = await pruneSessions({
        root,
        age: values.age || "7d",
        state: values.state,
        delete: Boolean(values.delete),
        dryRun,
      });

      if (values.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(`\n🧹 Session Pruning Report (${dryRun ? "DRY RUN" : "EXECUTED"})`);
        console.log(`------------------------------------------------------------------`);
        console.log(`  Filter Age Cutoff   : ${values.age || "7d"}`);
        console.log(`  Filter Target State : ${values.state || "ALL"}`);
        console.log(`  Matched Sessions    : ${res.matchedCount}`);
        console.log(`  Archived / Deleted  : ${res.archivedCount}`);
        console.log(`------------------------------------------------------------------`);
        for (const s of res.sessions) {
          console.log(`  - [${s.action}] ${s.id} (State: ${s.state || "UNKNOWN"})`);
        }
        if (dryRun && res.matchedCount > 0) {
          console.log(`\n💡 Re-run with --yes to archive matched sessions.\n`);
        }
      }

      process.exit(0);
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
      // The DAG runner accepts `.json` and `.task` envelopes as well as
      // Markdown, and does its own discovery — but this count gated whether it
      // was ever called, using the Markdown-only filter. A queue holding only
      // JSON envelopes reported "0 queued task(s)" and did nothing, with no
      // indication that the files were there and understood.
      const queueEntries = readdirSync(queueDir);
      let files;
      if (values.dag) {
        const { isDagTaskFile } = await import("../src/dag-engine.mjs");
        files = queueEntries.filter((f) => {
          if (f === "completed" || f.startsWith(".")) return false;
          if (!/\.(md|json|task)$/.test(f)) return false;
          let content = "";
          try {
            content = readFileSync(join(queueDir, f), "utf-8");
          } catch (_) {
            return false;
          }
          return isDagTaskFile(f, content, isTaskFile);
        });
      } else {
        files = queueEntries.filter((f) => isTaskFile(f, queueDir));
      }
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
          const anyFailed = (results.results || []).some((r) => r && r.ok === false);
          process.exit(anyFailed ? 1 : 0);
        }
        process.exit(reportRunOutcome(results));
      }
      process.exit(0);
      break;
    }

    case "swarm": {
      // This case had no parseArgs at all: `--json` and `--dry-run` were
      // accepted by the shell, documented in the registry, and silently
      // discarded — so a rehearsal dispatched for real and a script asking for
      // JSON got decorated prose.
      const { values } = parseArgs({
        args: args.slice(1),
        options: {
          concurrency: { type: "string", short: "c" },
          "dry-run": { type: "boolean", short: "d" },
          json: { type: "boolean", short: "j" },
        },
        allowPositionals: true,
        strict: false,
      });

      const queueDir = getQueueDir(root);
      const files = readdirSync(queueDir).filter((f) => isTaskFile(f, queueDir));
      if (!values.json) console.log("🚀 Running Swarm Orchestrator...");
      if (files.length === 0) {
        if (values.json) {
          console.log(JSON.stringify({ ok: true, processed: 0, results: [], dryRun: Boolean(values["dry-run"]) }, null, 2));
        } else {
          console.log("No pending tasks found for swarm.");
        }
        process.exit(0);
      }
      const tasks = files.map((f) => ({
        id: f,
        title: f.replace(/\.md$/, ""),
        prompt: readFileSync(join(queueDir, f), "utf-8"),
      }));
      const results = await run(tasks, {
        root,
        config,
        concurrency: values.concurrency ? Number(values.concurrency) : config.limits.concurrency || 3,
        dryRun: values["dry-run"],
      });
      if (values.json) {
        console.log(JSON.stringify({ ok: true, dryRun: Boolean(values["dry-run"]), ...results }, null, 2));
        process.exit((results.results || []).some((r) => r && r.ok === false) ? 1 : 0);
      }
      process.exit(reportRunOutcome(results));
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

      if (args.includes("--by-user") || args.includes("-u")) {
        console.log("📊 Task Budget Attribution (Rolling 24h Window)");
        console.log(`Daily Limit : ${b.limit} Tasks | Used: ${b.used} | Remaining: ${b.remaining}\n`);
        const users = Object.entries(b.byUser || {});
        if (users.length === 0) {
          console.log("  No user activity recorded in the active 24h window.\n");
        } else {
          console.log("  Author               Tasks  Committed  Pending");
          console.log("  -------------------  -----  ---------  -------");
          for (const [user, stats] of users.sort(([, a], [, b]) => b.tasks - a.tasks)) {
            const padUser = user.padEnd(20);
            const padTasks = String(stats.tasks).padStart(5);
            const padCommitted = String(stats.committed).padStart(9);
            const padPending = String(stats.uncommitted).padStart(7);
            console.log(`  ${padUser} ${padTasks}  ${padCommitted}  ${padPending}`);
          }
          console.log("");
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
        // A lock taken from the command line outlives the command. The process
        // that runs `lock acquire` writes the record and exits; the agent it
        // speaks for is somewhere else entirely. So this is a time-bounded
        // lease, not a pid the next acquire can test for liveness — that test
        // always said "dead" and handed the same files to the next caller.
        //
        // `--pid` is the escape hatch for a caller that *does* have a durable
        // process to point at: the lock then releases itself when that process
        // dies, exactly as an in-process acquire does.
        const flagIdx = args.findIndex((a, i) => i >= 2 && a.startsWith("--"));
        const positional = flagIdx === -1 ? args.slice(2) : args.slice(2, flagIdx);
        const { values } = parseArgs({
          args: flagIdx === -1 ? [] : args.slice(flagIdx),
          options: {
            ttl: { type: "string" },
            pid: { type: "string" },
          },
          allowPositionals: false,
        });
        const agent = positional[0] || "agent";
        const taskId = positional[1] || "task-1";
        const filePaths = positional.slice(2);
        const ttlMinutes = Number(values.ttl);
        const ownerPid = Number(values.pid);
        const bindsToProcess = Number.isInteger(ownerPid) && ownerPid > 0;
        const res = acquireLock(agent, taskId, filePaths, root, {
          lease: !bindsToProcess,
          ownerPid: bindsToProcess ? ownerPid : undefined,
          ttlMs: Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes * 60_000 : undefined,
        });
        if (res.ok) {
          const held = filePaths.length ? ` (${filePaths.length} path${filePaths.length === 1 ? "" : "s"})` : "";
          const until = bindsToProcess ? `bound to pid ${ownerPid}` : `expires ${new Date(Date.now() + (Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : 120) * 60_000).toISOString()}`;
          console.log(`✅ Acquired lock for ${taskId}${held} — ${until}`);
        } else {
          const overlap = Array.isArray(res.conflictingFiles) && res.conflictingFiles.length
            ? `\n   Contested paths: ${res.conflictingFiles.join(", ")}`
            : "";
          const until = res.expiresAt ? `\n   Held until ${res.expiresAt} (or until \`agentctl lock release ${res.taskId}\`).` : "";
          console.log(`❌ Lock conflict detected: held by ${res.holder} (task ${res.taskId})${overlap}${until}`);
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
        options: {
          json: { type: "boolean", short: "j" },
          // `--probe` was advertised in the command registry and declared
          // nowhere, so `runDoctorChecks` never saw `activeProbe` and the flag
          // was silently inert.
          probe: { type: "boolean" },
        },
        allowPositionals: true,
        strict: false,
      });

      // runDoctorChecks() and its seven checks existed but nothing rendered
      // them: this command printed a hand-written summary, so findings like a
      // git-tracked .env were computed, tested, and never shown to anyone.
      const { runDoctorChecks } = await import("../src/ops/doctor-registry.mjs");
      const report = await runDoctorChecks({ root, activeProbe: Boolean(values.probe) });

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
        // A passing row normally speaks for itself. Provider readiness does
        // not: green there means "a binary was found", and read as "the
        // provider works" it sends someone into a dispatch that cannot succeed.
        // Such a row asks to be spelled out even when it passes.
        if (r.status !== "pass" || r.alwaysShowSummary) {
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

    case "provider":
    case "providers": {
      // `agentctl providers` used to tell the operator to run
      // `agentctl init --provider <name>` to switch — which restarts the whole
      // onboarding wizard, plan question included, to change one line.
      if (args[1] === "set") {
        const target = args[2];
        if (!target) {
          console.error(`❌ Usage: agentctl provider set <name>   (see: agentctl providers)`);
          process.exit(2);
        }
        const { setConfigProvider } = await import("../src/config-edit.mjs");
        const res = setConfigProvider(root, target);
        if (!res.ok) {
          console.error(`❌ ${res.error}`);
          process.exit(1);
        }
        const { probeProvider } = await import("../src/provider-readiness.mjs");
        const probe = probeProvider(target);
        console.log(`✅ Provider set to '${target}' in ${res.file}`);
        console.log(`   ${probe.ready ? "Ready" : `Not ready — ${probe.remedy}`}`);
        if (!probe.known) console.log(`   Note: '${target}' is not a built-in preset, so its readiness cannot be checked.`);
        console.log(`   The manifest is gate-protected — commit it so the next check does not read it as an agent edit.`);
        process.exit(0);
      }

      const { values } = parseArgs({
        args: args.slice(1),
        options: { json: { type: "boolean", short: "j" } },
        allowPositionals: true,
      });
      const { detectAvailableProviders, probeProvider } = await import("../src/provider-readiness.mjs");
      const probes = detectAvailableProviders();
      const active = config.provider || "jules";
      const activeProbe = probeProvider(active);

      if (values.json) {
        console.log(JSON.stringify({ active, activeReady: activeProbe.ready, providers: probes }, null, 2));
        process.exit(0);
      }

      console.log(`\n🔌 Agent providers\n`);
      for (const p of probes) {
        const marker = p.name === active ? "▸" : " ";
        console.log(`  ${marker} ${p.ready ? "✅" : "⬜"} ${p.name.padEnd(14)} ${p.label}`);
        console.log(`       ${p.reason}`);
        if (!p.ready) console.log(`       Fix: ${p.remedy}`);
      }
      if (!probes.some((p) => p.name === active)) {
        console.log(`  ▸ ⬜ ${active.padEnd(14)} ${activeProbe.label}`);
        console.log(`       ${activeProbe.reason}`);
      }
      console.log(`\n  Active: ${active} (provider: in ${config._file || ".agent/config.yml"})`);
      console.log(`  Switch: agentctl provider set <name>   ·   every gate below works with no provider at all`);
      console.log(`  Note:   for the CLI providers, "ready" means the binary is on PATH — it does not prove`);
      console.log(`          the CLI is signed in. A dispatch is the first thing that can tell you that.\n`);
      process.exit(activeProbe.ready ? 0 : 1);
      break;
    }

    case "profile": {
      const { values } = parseArgs({
        args: args.slice(1),
        options: {
          list: { type: "boolean", short: "l" },
          set: { type: "string" },
          json: { type: "boolean", short: "j" },
        },
        allowPositionals: true,
      });
      const { PROFILE_NAMES, PROFILE_DESCRIPTIONS, buildProfileStages, buildDefaultStages } = await import("../src/profiles.mjs");

      if (values.set) {
        const name = String(values.set).toLowerCase();
        if (!PROFILE_NAMES.includes(name)) {
          console.error(`❌ Unknown profile '${values.set}'. Choose one of: ${PROFILE_NAMES.join(", ")}`);
          process.exit(2);
        }
        const { setVerificationProfile } = await import("../src/config-edit.mjs");
        const res = setVerificationProfile(root, name);
        if (!res.ok) {
          console.error(`❌ ${res.error}`);
          process.exit(1);
        }
        console.log(`✅ Verification profile set to '${name}' in ${res.file}`);
        console.log(`   The manifest is gate-protected — commit it so the next check does not read it as an agent edit.`);
        process.exit(0);
      }

      if (values.list) {
        if (values.json) {
          console.log(JSON.stringify(PROFILE_NAMES.map((n) => ({ name: n, description: PROFILE_DESCRIPTIONS[n] })), null, 2));
        } else {
          console.log(`\n🎚️  Verification profiles\n`);
          for (const n of PROFILE_NAMES) console.log(`  ${n.padEnd(10)} ${PROFILE_DESCRIPTIONS[n]}`);
          console.log(`\n  Set with: agentctl profile --set max\n`);
        }
        process.exit(0);
      }

      const stack = detectStack(root).stack;
      const activeProfile = config.verify.profile || "(none — running the built-in pipeline)";
      const plan = config.verify.profile
        ? buildProfileStages(config.verify.profile, { stack, verify: config.verify })
        : { profile: null, stages: config.verify.stages || buildDefaultStages(config.verify), skipped: [] };

      if (values.json) {
        console.log(JSON.stringify({ profile: config.verify.profile, stack, stages: plan.stages, skipped: plan.skipped }, null, 2));
        process.exit(0);
      }

      console.log(`\n🎚️  Verification profile: ${activeProfile}   (stack: ${stack})\n`);
      if (plan.stages.length === 0) {
        console.log(`  No stages resolved — no verification command is configured or detectable.`);
        console.log(`  Set verify.test in .agent/config.yml, or run: agentctl bootstrap`);
      }
      for (const st of plan.stages) {
        const what = st.assert ? `assert:${st.assert}` : st.cmd;
        console.log(`  ${String(st.id).padEnd(14)} ${what}`);
      }
      for (const sk of plan.skipped) {
        console.log(`  ${String(sk.id).padEnd(14)} — skipped: ${sk.reason}`);
      }
      console.log(`\n  Change with: agentctl profile --set ${config.verify.profile === "max" ? "standard" : "max"}\n`);
      process.exit(0);
      break;
    }

    case "ci": {
      const sub = args[1];
      if (sub !== "init") {
        console.error(`❌ Unknown 'ci' action '${sub || ""}'. Usage: agentctl ci init [--target github|gitlab] [--force]`);
        process.exit(2);
      }
      const { values } = parseArgs({
        args: args.slice(2),
        options: {
          target: { type: "string", default: "github" },
          force: { type: "boolean", short: "f" },
          "dry-run": { type: "boolean", short: "d" },
          json: { type: "boolean", short: "j" },
        },
        allowPositionals: true,
      });
      const { writeCiWorkflow } = await import("../src/ci-templates.mjs");
      const res = writeCiWorkflow(root, {
        target: values.target,
        force: values.force,
        dryRun: values["dry-run"],
        config,
        version: VERSION,
        stack: detectStack(root),
      });

      if (values.json) {
        console.log(JSON.stringify(res, null, 2));
        process.exit(res.ok ? 0 : 1);
      }
      if (!res.ok) {
        console.error(`❌ ${res.error}`);
        process.exit(1);
      }
      console.log(`✅ ${res.written ? "Wrote" : "Would write"} ${res.file}`);
      console.log(`   Stack: ${res.stack} · runtime setup: ${res.setupSummary}`);
      console.log(`   The workflow runs: agentctl check --mode committed`);
      if (!res.written && !values["dry-run"]) {
        console.log(`   (unchanged — pass --force to overwrite)`);
      }
      process.exit(0);
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
          "non-interactive": { type: "boolean" },
          "no-interactive": { type: "boolean" },
          yes: { type: "boolean", short: "y" },
          tier: { type: "string", short: "t" },
          provider: { type: "string" },
          profile: { type: "string" },
          json: { type: "boolean", short: "j" },
          "dry-run": { type: "boolean", short: "d" },
          force: { type: "boolean", short: "f" },
        },
        allowPositionals: true,
      });

      const isInteractive = values.interactive !== false && !values["non-interactive"] && !values["no-interactive"] && !values.yes;

      const { runInitWizard } = await import("../src/wizard-init.mjs");
      const res = await runInitWizard(root, {
        interactive: isInteractive,
        // No `|| "pro"`: a hardcoded default here overrode both the tier picked
        // in the menu and the tier already recorded in .agent/config.yml on a
        // re-run. Undefined lets the wizard seed the menu from the existing
        // config and fall back to FALLBACK_TIER when there is nothing to seed.
        tier: values.tier,
        // Both undefined by default so the wizard can detect a provider the
        // machine can actually reach and keep the profile already in config.
        provider: values.provider,
        profile: values.profile,
        allowDefaults: true,
      });

      // The wizard writes the manifest; the assets the CLI's documented
      // features actually need — AGENTS.md, the role prompts, the guardrails,
      // the gitignore entries — used to be scaffolded only by the separate
      // `jules-init` binary that the README's quickstart never mentions.
      const { scaffoldRepoAssets } = await import("../src/scaffold.mjs");
      const scaffold = scaffoldRepoAssets(root, { force: values.force });

      if (values.json) {
        console.log(JSON.stringify({ ...res, scaffold }, null, 2));
      } else {
        console.log(`✅ Onboarding complete! Manifest generated at ${res.configPath}`);
        console.log(`   Tier: ${res.plan.tier.toUpperCase()} (${res.plan.limits.concurrency} worker(s), ${res.plan.limits.daily_tasks} daily tasks)`);
        {
          const { probeProvider } = await import("../src/provider-readiness.mjs");
          const probe = probeProvider(res.plan.provider);
          console.log(`   Provider                  : ${probe.name} ${probe.ready ? "(ready)" : `(not ready — ${probe.remedy})`}`);
          const { buildProfileStages, describeProfilePlan } = await import("../src/profiles.mjs");
          const planned = buildProfileStages(res.plan.profile, {
            stack: res.plan.stack,
            verify: { ...res.plan.verify, unit: res.plan.verify.test },
          });
          console.log(`   Verification Profile      : ${res.plan.profile} → ${describeProfilePlan(planned)}`);
        }
        if (res.plan.verify.test) {
          console.log(`   Verification Test Command : "${res.plan.verify.test}"`);
        } else {
          console.log(`   Verification Test Command : None detected (run "agentctl bootstrap" to create a test oracle)`);
        }
        console.log(`   Active Presets            : ${res.plan.presets.join(", ")}`);
        for (const item of scaffold.created) {
          console.log(`   Scaffolded                : ${item}`);
        }
        if (scaffold.gitignore.length > 0) {
          console.log(`   Ignored runtime state     : ${scaffold.gitignore.length} entries added to .gitignore`);
        }

        // `.agent/config.yml` and `.agent/jules.yml` are both on the gate's deny
        // list, by design — the agent must not edit its own rules. Leaving them
        // uncommitted meant the very first `agentctl gate` rejected the working
        // tree for files init had just written, which reads as the tool
        // catching the user cheating on step three.
        const rootContracts = ["SPEC.md", "CONSTRAINTS.md", "DESIGN.md"].filter((f) => existsSync(join(root, f)));
        const filesToAdd = [".agent", "AGENTS.md", ...rootContracts, ".gitignore"].filter((f) => existsSync(join(root, f)));
        console.log(`\n   Commit the manifest and contracts so the gate does not read them as agent edits:`);
        console.log(`     git add ${filesToAdd.join(" ")} && git commit -m "chore: add agent config"`);

        const { resolveNextStep, renderNextStep } = await import("../src/ops/next-step.mjs");
        const next = resolveNextStep(root);
        console.log(renderNextStep({ version: VERSION, root, next, budgetLine: "" }));
      }
      process.exit(0);
      break;
    }

    case "task": {
      const subCommand = args[1] || "create";
      if (subCommand === "create") {
        const { values, positionals } = parseArgs({
          args: args.slice(2),
          options: {
            title: { type: "string", short: "t" },
            prompt: { type: "string", short: "p" },
            "prompt-file": { type: "string", short: "f" },
            role: { type: "string", short: "r" },
            tier: { type: "string" },
            template: { type: "string" },
            depends: { type: "string" },
            "depends-on": { type: "string" },
            "verify-cmd": { type: "string", short: "v" },
            "auto-pr": { type: "boolean" },
            "require-plan-approval": { type: "boolean" },
            repoless: { type: "boolean" },
            interactive: { type: "boolean", short: "i" },
            "non-interactive": { type: "boolean" },
            "no-interactive": { type: "boolean" },
            yes: { type: "boolean", short: "y" },
            json: { type: "boolean", short: "j" },
            "dry-run": { type: "boolean", short: "d" },
          },
          allowPositionals: true,
        });

        const { resolveWizardInteractivity } = await import("../src/ops/cli-intent.mjs");
        const isInteractive = resolveWizardInteractivity({
          interactive: values.interactive,
          nonInteractive: values["non-interactive"] || values["no-interactive"],
          yes: values.yes,
          // A title and a prompt together state the whole task; there is
          // nothing left for the wizard to ask.
          fullySpecified: Boolean(values.title && resolvePromptInput(values, positionals)),
        });

        const { runTaskCreateWizard } = await import("../src/wizard-task.mjs");
        const res = await runTaskCreateWizard(root, {
          title: values.title,
          prompt: resolvePromptInput(values, positionals),
          role: values.role,
          tier: values.tier,
          template: values.template,
          dependsOn: values["depends-on"] || values.depends,
          verifyCmd: values["verify-cmd"],
          autoPr: values["auto-pr"],
          requirePlanApproval: values["require-plan-approval"],
          repoless: values.repoless,
          interactive: isInteractive,
          dryRun: values["dry-run"],
        });

        if (values.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(
            res.dryRun
              ? `🧪 Dry run — envelope synthesized and validated, nothing written (would be ${res.taskFile})`
              : `✅ Task synthesized & queued at ${res.taskFile}`
          );
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
            prompt: { type: "string", short: "p" },
            // No short form here: `-f` is already --fix on this subcommand, and
            // silently meaning two different things would be worse than one
            // command having a flag short of full parity. `--file` predates
            // `--prompt-file` and stays as an alias.
            "prompt-file": { type: "string" },
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
        const promptText = resolvePromptInput(values, positionals);

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
        console.log(`   - ${t.file}:${t.line} [${t.type || t.tag || "TODO"}] ${t.text}`);
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
          // Documented in the README as `rollback [sessionId | --latest]` but
          // never registered, so the documented spelling died in parseArgs
          // before restoreCheckpoint — which has always accepted it — was
          // reached. Restoring the newest checkpoint is also the no-argument
          // default, so the flag is explicit-intent sugar rather than a mode.
          latest: { type: "boolean" },
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
        const { values, positionals } = parseArgs({
          args: args.slice(2),
          options: {
            // No `default: "all"` here. parseArgs sets a default eagerly, so
            // `values.target` was always truthy and the `|| args[2]` fallback
            // below could never be reached — `agentctl mcp init cursor`, the
            // spelling --help advertises, silently scaffolded Cursor, VS Code
            // and Claude Desktop alike. The default belongs at the end of the
            // resolution chain, not at the start of it.
            target: { type: "string", short: "t" },
            json: { type: "boolean", short: "j" },
            "dry-run": { type: "boolean", short: "d" },
          },
          allowPositionals: true,
        });

        const target = values.target || positionals[0] || "all";
        try {
          const res = scaffoldIdeConfig(target, { root, dryRun: values["dry-run"] });
          if (values.json) {
            console.log(JSON.stringify(res, null, 2));
          } else {
            console.log(res.dryRun ? `\n🧪 IDE MCP Config — dry run, nothing written` : `\n🔌 IDE MCP Config Scaffolded Successfully!`);
            console.log(`   Target  : ${res.target}`);
            for (const item of res.results) {
              console.log(`   - ${item.target.toUpperCase()} : ${item.file}${res.dryRun ? " (would write)" : ""}`);
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
          // "Signature" was the wrong word and the wrong promise. There is no
          // key anywhere in this system: the value is a SHA-256 digest of the
          // manifest, so anyone who can write the file can also recompute it
          // and have `evidence verify` agree. What it proves is that the
          // manifest has not been edited *since* it was written — tamper
          // evidence, not authorship. Calling that a signature invites an
          // operator to trust it for something it cannot do.
          console.log(`\n🛡️ Evidence Manifest Generated!`);
          console.log(`   Manifest ID : ${res.manifest.manifestId}`);
          console.log(`   Digest      : ${res.manifest.evidenceHash}`);
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
            console.log(`   Digest      : ${res.evidenceHash}\n`);
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

    case "rules": {
      const subcmd = args[1] || "check";
      const { checkRulesBudget, compileRules } = await import("../src/rules-budget.mjs");

      if (subcmd === "check") {
        const { values } = parseArgs({
          args: args.slice(2),
          options: {
            json: { type: "boolean", short: "j" },
            "max-chars": { type: "string" },
            "max-lines": { type: "string" },
          },
          allowPositionals: true,
        });

        const res = checkRulesBudget(root, {
          maxChars: values["max-chars"] ? Number(values["max-chars"]) : undefined,
          maxLines: values["max-lines"] ? Number(values["max-lines"]) : undefined,
        });

        if (values.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log("\n📏 agentctl Rules Budget & Line Audit");
          console.log("-----------------------------------------------------");
          if (res.ok) {
            console.log("✅ All agent rule files are within safe character (<10,000) and line (<250) limits.");
          } else {
            console.log("❌ RULES BUDGET VIOLATIONS DETECTED:");
            for (const v of res.violations) {
              console.log(`  - ${v.path}: ${v.reason}`);
            }
            console.log("\n💡 Remediation: Trim prose rules or convert textual learnings into AST lints / assertions.");
          }
          console.log("-----------------------------------------------------\n");
        }
        process.exit(res.ok ? 0 : 1);
      } else if (subcmd === "compile") {
        const { values } = parseArgs({
          args: args.slice(2),
          options: {
            out: { type: "string", short: "o" },
            json: { type: "boolean", short: "j" },
          },
          allowPositionals: true,
        });

        const res = compileRules(root);
        if (values.out) {
          const { writeFileSync } = await import("node:fs");
          const { resolve } = await import("node:path");
          writeFileSync(resolve(root, values.out), res.compiled, "utf-8");
          if (values.json) {
            console.log(JSON.stringify({ ok: true, out: values.out, sha256: res.sha256, bodyLen: res.bodyLen, sources: res.sources }, null, 2));
          } else {
            console.log(`✅ Compiled ${res.sources.length} rule source(s) into ${values.out} (SHA-256: ${res.sha256.slice(0, 12)}..., ${res.bodyLen} bytes)`);
          }
        } else if (values.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(res.compiled);
        }
        process.exit(0);
      } else {
        console.error(`Unknown rules action: "${subcmd}". Usage: agentctl rules [check | compile]`);
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
