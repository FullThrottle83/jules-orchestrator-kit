#!/usr/bin/env node
/**
 * Suggested Tasks Scanner for Google Jules
 * Scans codebase for TODO, FIXME, HACK, and OPTIMIZE comments, ranks them by priority,
 * and generates a tasks JSON file formatted for jules-swarm or jules-dispatch.
 * Zero external dependencies.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log, ensureDir } from "./utils.mjs";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".agent/history",
  ".agent/worktrees",
  ".agent/jules-queue/.processing",
  ".agent/jules-queue/completed",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "test",
  "scripts/jules-scan-todos.mjs"
]);

const IGNORE_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".pdf",
  ".zip", ".tar", ".gz", ".7z", ".mp4", ".webm", ".mp3", ".wav",
  ".lock", ".map", ".bin", ".exe"
]);

const TAG_REGEX = /(?:(?:\/\/|\/\*|\*|#|<!--)\s*|\b)(FIXME|HACK|TODO|OPTIMIZE):?\s*(.+)$/;

export function scanCodebaseForTodos(rootDir = process.cwd(), options = {}) {
  const tasks = [];
  const maxTasks = options.maxTasks || 100;

  function walk(currentDir) {
    if (tasks.length >= maxTasks) return;
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (_) {
      return;
    }

    for (const entry of entries) {
      if (tasks.length >= maxTasks) break;
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(rootDir, fullPath).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        const baseName = entry.name;
        if (IGNORE_DIRS.has(baseName) || IGNORE_DIRS.has(relPath) || baseName.startsWith(".")) {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (IGNORE_EXTS.has(ext) || IGNORE_DIRS.has(relPath)) continue;

        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          const lines = content.split("\n");
          for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const line = lines[lineIdx];
            // Ignore false positives from regex definitions or scanner string literals
            if (/TAG_REGEX|tasks\.some|log\.info\("Zero TODO|\/FIXME comments/i.test(line)) {
              continue;
            }
            const match = line.match(TAG_REGEX);
            if (match) {
              const tag = match[1].toUpperCase();
              const text = match[2].trim();
              const priority = (tag === "FIXME" || tag === "HACK") ? "HIGH" : "MEDIUM";
              const taskId = `task-${tag.toLowerCase()}-${tasks.length + 1}`;

              tasks.push({
                id: taskId,
                title: `${tag} in ${path.basename(relPath)}: ${text.slice(0, 50)}`,
                priority,
                prompt: `Resolve ${tag} comment in \`${relPath}\` at line ${lineIdx + 1}.\n\nComment: ${text}\n\nFile Context:\n\`\`\`\nLine ${lineIdx + 1}: ${line.trim()}\n\`\`\``,
                file: relPath,
                line: lineIdx + 1,
                tag
              });

              if (tasks.length >= maxTasks) break;
            }
          }
        } catch (_) {
          // Skip unreadable files
        }
      }
    }
  }

  walk(rootDir);
  return tasks;
}

export function runScanner() {
  const args = process.argv.slice(2);
  const isJson = args.includes("--json");

  let outputPath = path.resolve(process.cwd(), ".agent/jules-queue/suggested-tasks.json");
  const outIdx = args.indexOf("--output");
  if (outIdx !== -1 && args[outIdx + 1]) {
    outputPath = path.resolve(process.cwd(), args[outIdx + 1]);
  }

  log.header("Suggested Tasks Scanner");
  log.info(`Scanning codebase for TODO, FIXME, HACK, and OPTIMIZE comments...`);

  const tasks = scanCodebaseForTodos(process.cwd());

  if (isJson) {
    console.log(JSON.stringify(tasks, null, 2));
    return;
  }

  log.success(`Scanned and found ${tasks.length} suggested task(s).`);

  if (tasks.length === 0) {
    log.info("Zero TODO/FIXME comments found in codebase!");
    return;
  }

  ensureDir(path.dirname(outputPath));
  fs.writeFileSync(outputPath, JSON.stringify(tasks, null, 2), "utf-8");

  log.success(`Generated suggested tasks file: ${path.relative(process.cwd(), outputPath)}`);
  log.info(`Run \`npx jules-swarm ${path.relative(process.cwd(), outputPath)}\` to execute all tasks in parallel.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runScanner();
}
