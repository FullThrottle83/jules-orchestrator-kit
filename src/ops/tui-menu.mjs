/**
 * Terminal Navigation Hub (TUI Menu).
 * Zero-dependency interactive menu using native TTY raw mode.
 */
import { isTTY, select, input, confirm, ANSI } from "../tui.mjs";
import { KIT_VERSION } from "../version.mjs";
import { loadConfig } from "../config.mjs";
import { budgetStatus } from "../budget.mjs";
import { runDoctorChecks } from "./doctor-registry.mjs";
import { detectAvailableProviders } from "../provider-readiness.mjs";
import { runTaskCreateWizard } from "../wizard-task.mjs";
import { listWebTemplates, getWebTemplate } from "../web-templates.mjs";
import { scorePromptFalsifiability } from "../task-optimizer.mjs";
import { scanCodebaseForTodos } from "../todo-scanner.mjs";
import { gate } from "../engine.mjs";

/**
 * Launch the interactive terminal navigation hub.
 * @param {string} root - Repository root path
 * @param {object} [options]
 * @param {import("node:stream").Readable} [options.stdin]
 * @param {import("node:stream").Writable} [options.stdout]
 * @param {boolean} [options.singleAction]
 * @returns {Promise<{ ok: boolean, action?: string, headless?: boolean }>}
 */
export async function runTuiMenu(root = process.cwd(), options = {}) {
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;

  if (!isTTY(stdin) && !options.allowHeadless) {
    stdout.write("Interactive terminal menu requires a TTY terminal. Use 'agentctl --help' for CLI commands.\n");
    return { ok: true, headless: true };
  }

  while (true) {
    stdout.write(`\n${ANSI.bold}${ANSI.cyan}🚀 agentctl v${KIT_VERSION}${ANSI.reset} — Interactive Terminal Hub\n`);
    stdout.write(`   ${ANSI.dim}Repository:${ANSI.reset} ${root}\n\n`);

    const actions = [
      { label: "🛡️  Run Safety Gate", value: "gate", description: "Audit CI security, scope & verification" },
      { label: "🔍  System Diagnostics", value: "doctor", description: "Run 13 health checks and provider checks" },
      { label: "📊  Operating Status", value: "status", description: "View daily budget, locks, pending tasks" },
      { label: "✨  Create Task Envelope", value: "task-create", description: "Interactive wizard for falsifiable tasks" },
      { label: "📋  Browse Task Templates", value: "task-template", description: "21 specialized templates: a11y, SEO, CWV..." },
      { label: "🎯  Optimize Task Prompt", value: "task-optimize", description: "Score prompt falsifiability and suggest fixes" },
      { label: "🔌  Agent Providers", value: "providers", description: "Inspect Jules, Claude, Codex, Gemini readiness" },
      { label: "🔎  Scan Codebase (TODOs)", value: "scan", description: "Find task candidates in code" },
      { label: "🌐  Start Web Dashboard", value: "dashboard", description: "Start local web UI on port 4100" },
      { label: "🚪  Exit", value: "exit", description: "Quit menu" },
    ];

    const choice = await select(actions, "Select an action:", { stdin, stdout, defaultIdx: 0 });

    if (choice === "exit") {
      stdout.write(`${ANSI.dim}Bye!${ANSI.reset}\n`);
      return { ok: true, action: "exit" };
    }

    if (choice === "gate") {
      const modeChoice = await select(
        [
          { label: "Working tree", value: "working-tree", description: "Default — evaluate uncommitted changes" },
          { label: "Staged changes", value: "staged", description: "Evaluate git staged changes only" },
          { label: "Committed changes", value: "committed", description: "Evaluate committed changes on branch" },
          { label: "Dry-run simulation", value: "dry-run", description: "Simulate gate without persisting evidence" },
        ],
        "Select gate evaluation mode:",
        { stdin, stdout, defaultIdx: 0 }
      );
      const isDry = modeChoice === "dry-run";
      const mode = isDry ? "working-tree" : modeChoice;
      stdout.write(`\nRunning Safety Gate (mode: ${mode})...\n`);
      const res = await gate({ root, mode, dryRun: isDry });
      stdout.write(`\nGate Result: ${res.ok ? `${ANSI.green}APPROVED (Exit 0)${ANSI.reset}` : `${ANSI.red}REJECTED (Exit ${res.code})${ANSI.reset}`}\n`);
      for (const p of res.phases || []) {
        const icon = p.ok ? `${ANSI.green}✅ PASS${ANSI.reset}` : `${ANSI.red}❌ FAIL${ANSI.reset}`;
        stdout.write(`  Phase [${p.phase.toUpperCase()}] : ${icon}\n`);
      }
    } else if (choice === "doctor") {
      stdout.write(`\nRunning system diagnostics...\n`);
      const rep = await runDoctorChecks({ root });
      stdout.write(`\nDiagnostics: ${rep.summary.pass} passed, ${rep.summary.warn} warning(s), ${rep.summary.fail} failure(s)\n`);
      const iconMap = { pass: `${ANSI.green}✅${ANSI.reset}`, warn: `${ANSI.yellow}⚠️${ANSI.reset}`, fail: `${ANSI.red}❌${ANSI.reset}` };
      for (const r of rep.results || []) {
        stdout.write(`  ${iconMap[r.status] || "•"} ${r.title}\n`);
        if (r.status !== "pass" || r.alwaysShowSummary) {
          stdout.write(`       ${ANSI.dim}${r.summary}${ANSI.reset}\n`);
        }
      }
    } else if (choice === "status") {
      const config = loadConfig(root);
      const b = budgetStatus(config, root);
      stdout.write(`\n📊 Status Summary:\n`);
      stdout.write(`  Root: ${root}\n`);
      stdout.write(`  Config: ${config._file || "None"}\n`);
      stdout.write(`  Daily Budget: ${b.used} / ${b.limit} tasks in last 24h\n`);
    } else if (choice === "task-create") {
      await runTaskCreateWizard(root, { interactive: true, stdin, stdout });
    } else if (choice === "task-template") {
      const templates = listWebTemplates();
      const tOptions = templates.map((t) => ({
        label: t.id.padEnd(24),
        value: t.id,
        description: `${t.category} — ${t.title}`,
      }));
      tOptions.push({ label: "← Back", value: "__back__", description: "Return to main menu" });
      const picked = await select(tOptions, "Select a task template to inspect:", { stdin, stdout });
      if (picked !== "__back__") {
        const tpl = getWebTemplate(picked);
        if (tpl) {
          stdout.write(`\n${ANSI.bold}${tpl.title}${ANSI.reset} [${tpl.category}]\n`);
          stdout.write(`Default Oracle: ${tpl.defaultOracle}\n`);
          stdout.write(`${tpl.description}\n\n`);
          const action = await select(
            [
              { label: "Create task from this template", value: "create" },
              { label: "View full template envelope", value: "view" },
              { label: "← Back to menu", value: "back" },
            ],
            "Template action:",
            { stdin, stdout }
          );
          if (action === "create") {
            await runTaskCreateWizard(root, { template: tpl.id, interactive: true, stdin, stdout });
          } else if (action === "view") {
            const { synthesizeWebEnvelope } = await import("../web-templates.mjs");
            const env = synthesizeWebEnvelope(tpl.id, { rootDir: root });
            stdout.write(`\n${env}\n\n`);
          }
        }
      }
    } else if (choice === "task-optimize") {
      const promptText = await input("Enter task prompt to score and optimize:", { stdin, stdout });
      if (promptText && promptText.trim()) {
        const analysis = scorePromptFalsifiability(promptText.trim(), { rootDir: root });
        stdout.write(`\n${ANSI.bold}Prompt Score: ${analysis.score}/100 (Grade ${analysis.grade})${ANSI.reset}\n`);
        stdout.write(`Falsifiable: ${analysis.falsifiable ? `${ANSI.green}YES${ANSI.reset}` : `${ANSI.red}NO${ANSI.reset}`}\n`);
        if (analysis.issues && analysis.issues.length > 0) {
          stdout.write(`Issues identified:\n`);
          for (const issue of analysis.issues) {
            stdout.write(`  - [${issue.type}] ${issue.message}\n`);
          }
        }
        if (analysis.suggestions && analysis.suggestions.length > 0) {
          stdout.write(`Suggestions:\n`);
          for (const s of analysis.suggestions) {
            stdout.write(`  - ${s}\n`);
          }
        }
      }
    } else if (choice === "providers") {
      const probes = detectAvailableProviders();
      stdout.write(`\n🔌 Detected Agent Providers:\n`);
      for (const p of probes) {
        const icon = p.ready ? `${ANSI.green}✅${ANSI.reset}` : `${ANSI.dim}⬜${ANSI.reset}`;
        stdout.write(`  ${icon} ${ANSI.bold}${p.name.padEnd(14)}${ANSI.reset} ${p.label}\n`);
        stdout.write(`       ${ANSI.dim}${p.reason}${ANSI.reset}\n`);
      }
    } else if (choice === "scan") {
      stdout.write(`\nScanning codebase for TODO/FIXME annotations...\n`);
      const todos = scanCodebaseForTodos(root);
      stdout.write(`Found ${todos.length} annotation(s):\n`);
      for (const item of todos.slice(0, 15)) {
        stdout.write(`  - ${item.file}:${item.line} [${item.tag}] ${item.text}\n`);
      }
      if (todos.length > 15) {
        stdout.write(`  ... and ${todos.length - 15} more.\n`);
      }
    } else if (choice === "dashboard") {
      stdout.write(`\n🌐 To start web dashboard, run:\n`);
      stdout.write(`   agentctl dashboard --port 4100\n`);
      const startNow = await confirm("Start web dashboard now?", false, { stdin, stdout });
      if (startNow) {
        const { createDashboardServer } = await import("../dashboard.mjs");
        createDashboardServer({ root, port: 4100, host: "127.0.0.1" });
        stdout.write(`Dashboard running at http://127.0.0.1:4100\nPress Ctrl+C to exit.\n`);
        return new Promise(() => {});
      }
    }

    if (options.singleAction) {
      return { ok: true, action: choice };
    }

    const again = await confirm("\nReturn to main menu?", true, { stdin, stdout });
    if (!again) {
      break;
    }
  }

  return { ok: true };
}
