#!/usr/bin/env node

/**
 * Codebase scanner for TODO and FIXME comments.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export function scanCodebaseForTodos(dir = process.cwd()) {
  const todos = [];
  function walk(current) {
    let entries = [];
    try { entries = readdirSync(current); } catch (_) { return; }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git") continue;
      const full = join(current, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (stat.isFile()) {
          const content = readFileSync(full, "utf-8");
          const lines = content.split("\n");
          lines.forEach((line, idx) => {
            if (line.includes("TODO:")) {
              todos.push({ file: full, line: idx + 1, text: line.trim(), tag: "TODO", type: "TODO", priority: "MEDIUM" });
            } else if (line.includes("FIXME:")) {
              todos.push({ file: full, line: idx + 1, text: line.trim(), tag: "FIXME", type: "FIXME", priority: "HIGH" });
            }
          });
        }
      } catch (_) {}
    }
  }
  walk(dir);
  return todos;
}

export function runScanner(dir = process.cwd()) {
  const todos = scanCodebaseForTodos(dir);
  return { todos, count: todos.length };
}

if (process.argv[1] && process.argv[1].endsWith("jules-scan-todos.mjs")) {
  console.log("[Shim] TODO Scanner complete.");
  process.exit(0);
}
