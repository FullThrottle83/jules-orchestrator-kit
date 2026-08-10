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
 * @param {string} target - 'cursor' | 'vscode' | 'claude' | 'all'
 * @param {object} [options]
 * @returns {object} Summary of scaffolded files
 */
export function scaffoldIdeConfig(target = "all", options = {}) {
  const root = options.root || resolveRoot();
  const validTargets = new Set(["cursor", "vscode", "claude", "all"]);

  const normTarget = (target || "all").toLowerCase();
  if (!validTargets.has(normTarget)) {
    throw new IdeScaffoldError(`Invalid target '${target}'. Allowed targets: cursor, vscode, claude, all`);
  }

  const results = [];

  // Target: Cursor (.cursor/mcp.json)
  if (normTarget === "cursor" || normTarget === "all") {
    const cursorDir = join(root, ".cursor");
    try {
      mkdirSync(cursorDir, { recursive: true });
    } catch (_) {}

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

    writeFileSync(cursorConfigPath, JSON.stringify(updatedCursorConfig, null, 2), "utf-8");
    results.push({ target: "cursor", file: ".cursor/mcp.json", ok: true });
  }

  // Target: VS Code (.vscode/tasks.json)
  if (normTarget === "vscode" || normTarget === "all") {
    const vscodeDir = join(root, ".vscode");
    try {
      mkdirSync(vscodeDir, { recursive: true });
    } catch (_) {}

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
        command: "npx agentctl doctor",
        group: "test",
        problemMatcher: [],
      },
      {
        label: "Jules: Create Task Envelope",
        type: "shell",
        command: "npx agentctl task create",
        group: "build",
        problemMatcher: [],
      },
      {
        label: "Jules: 1-Click Rollback Checkpoint",
        type: "shell",
        command: "npx agentctl rollback --latest",
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

    writeFileSync(vscodeTasksPath, JSON.stringify(updatedVsCodeConfig, null, 2), "utf-8");
    results.push({ target: "vscode", file: ".vscode/tasks.json", ok: true });
  }

  // Target: Claude Desktop (claude_desktop_config.json snippet helper)
  if (normTarget === "claude" || normTarget === "all") {
    const agentDir = join(root, ".agent");
    try {
      mkdirSync(agentDir, { recursive: true });
    } catch (_) {}

    const snippetPath = join(agentDir, "claude_desktop_config.snippet.json");
    const claudeSnippet = {
      mcpServers: {
        "jules-orchestrator-kit": {
          command: "npx",
          args: ["-y", "jules-orchestrator-kit@latest", "mcp"],
        },
      },
    };

    writeFileSync(snippetPath, JSON.stringify(claudeSnippet, null, 2), "utf-8");
    results.push({ target: "claude", file: ".agent/claude_desktop_config.snippet.json", ok: true });
  }

  return { ok: true, target: normTarget, results };
}
