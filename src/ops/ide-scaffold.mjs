import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRoot } from "../config.mjs";

export class IdeScaffoldError extends Error {
  constructor(message) {
    super(message);
    this.name = "IdeScaffoldError";
  }
}

/**
 * Scaffolds IDE integration configuration files for Cursor, VS Code, and Claude Desktop.
 *
 * These files land in directories a project may already be using (`.cursor/`,
 * `.vscode/`), and the merge logic preserves what is there — but `--dry-run`
 * was accepted by the CLI and never reached here, so the only way to find out
 * what would be touched was to let it happen.
 *
 * @param {string} target - 'cursor' | 'vscode' | 'claude' | 'all'
 * @param {object} [options]
 * @param {string} [options.root]
 * @param {boolean} [options.dryRun] - report the files without writing them
 * @returns {object} Summary of scaffolded files
 */
export function scaffoldIdeConfig(target = "all", options = {}) {
  const root = options.root || resolveRoot();
  const dryRun = Boolean(options.dryRun);
  const validTargets = new Set(["cursor", "vscode", "claude", "all"]);

  /** Write unless this is a rehearsal; the directory is only made when writing. */
  const writeUnlessRehearsing = (dir, file, contents) => {
    if (dryRun) return;
    try {
      mkdirSync(dir, { recursive: true });
    } catch (_) {}
    writeFileSync(file, contents, "utf-8");
  };

  const normTarget = (target || "all").toLowerCase();
  if (!validTargets.has(normTarget)) {
    throw new IdeScaffoldError(`Invalid target '${target}'. Allowed targets: cursor, vscode, claude, all`);
  }

  const results = [];

  // Target: Cursor (.cursor/mcp.json)
  if (normTarget === "cursor" || normTarget === "all") {
    const cursorDir = join(root, ".cursor");
    const cursorConfigPath = join(cursorDir, "mcp.json");
    let existingConfig = {};
    if (existsSync(cursorConfigPath)) {
      try {
        existingConfig = JSON.parse(readFileSync(cursorConfigPath, "utf-8"));
      } catch (_) {}
    }

    const updatedCursorConfig = {
      ...existingConfig,
      mcpServers: {
        ...(existingConfig.mcpServers || {}),
        "jules-orchestrator-kit": {
          command: "npx",
          args: ["-y", "jules-orchestrator-kit@latest", "mcp"],
        },
      },
    };

    writeUnlessRehearsing(cursorDir, cursorConfigPath, JSON.stringify(updatedCursorConfig, null, 2));
    results.push({ target: "cursor", file: ".cursor/mcp.json", ok: true });
  }

  // Target: VS Code (.vscode/tasks.json)
  if (normTarget === "vscode" || normTarget === "all") {
    const vscodeDir = join(root, ".vscode");
    const vscodeTasksPath = join(vscodeDir, "tasks.json");
    let existingConfig = { version: "2.0.0", tasks: [] };
    if (existsSync(vscodeTasksPath)) {
      try {
        existingConfig = JSON.parse(readFileSync(vscodeTasksPath, "utf-8"));
      } catch (_) {}
    }

    const defaultTasks = [
      {
        label: "Jules: Run System Doctor",
        type: "shell",
        command: "npx jules-orchestrator-kit doctor",
        group: "test",
        problemMatcher: [],
      },
      {
        label: "Jules: Create Task Envelope",
        type: "shell",
        command: "npx jules-orchestrator-kit task create",
        group: "build",
        problemMatcher: [],
      },
      {
        label: "Jules: 1-Click Rollback Checkpoint",
        type: "shell",
        command: "npx jules-orchestrator-kit rollback --latest",
        group: "none",
        problemMatcher: [],
      },
    ];

    const currentTasks = existingConfig.tasks || [];
    const updatedTasks = [...currentTasks];

    for (const newTask of defaultTasks) {
      if (!updatedTasks.some((t) => t.label === newTask.label)) {
        updatedTasks.push(newTask);
      }
    }

    const updatedVsCodeConfig = {
      ...existingConfig,
      version: existingConfig.version || "2.0.0",
      tasks: updatedTasks,
    };

    writeUnlessRehearsing(vscodeDir, vscodeTasksPath, JSON.stringify(updatedVsCodeConfig, null, 2));
    results.push({ target: "vscode", file: ".vscode/tasks.json", ok: true });
  }

  // Target: Claude Desktop (claude_desktop_config.json snippet helper)
  if (normTarget === "claude" || normTarget === "all") {
    const agentDir = join(root, ".agent");
    const snippetPath = join(agentDir, "claude_desktop_config.snippet.json");
    const claudeSnippet = {
      mcpServers: {
        "jules-orchestrator-kit": {
          command: "npx",
          args: ["-y", "jules-orchestrator-kit@latest", "mcp"],
        },
      },
    };

    writeUnlessRehearsing(agentDir, snippetPath, JSON.stringify(claudeSnippet, null, 2));
    results.push({ target: "claude", file: ".agent/claude_desktop_config.snippet.json", ok: true });
  }

  return { ok: true, target: normTarget, dryRun, results };
}
