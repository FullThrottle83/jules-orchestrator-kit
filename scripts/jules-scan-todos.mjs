#!/usr/bin/env node

/**
 * Codebase scanner for TODO and FIXME comments.
 *
 * Safety limits: only source-ish extensions are read, files larger than
 * SCAN_MAX_FILE_BYTES are skipped, buffers containing null bytes are treated
 * as binary and skipped, and paths matched by the scan root's .gitignore are
 * never descended into or read.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, extname, relative } from "node:path";

export const SCAN_ALLOWED_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".py", ".rs", ".go", ".md"]);
export const SCAN_MAX_FILE_BYTES = 1024 * 1024;

function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

function loadGitignorePatterns(dir) {
  const ignoreFile = join(dir, ".gitignore");
  if (!existsSync(ignoreFile)) return [];
  let raw;
  try {
    raw = readFileSync(ignoreFile, "utf-8");
  } catch (_) {
    return [];
  }
  const patterns = [];
  for (let line of raw.split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1).trim();
      if (!line) continue;
    }
    if (line.startsWith("/")) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    const hasSlash = line.includes("/");
    patterns.push({ negated, dirOnly, hasSlash, regex: globToRegExp(line), literal: line });
  }
  return patterns;
}

function isIgnored(relPath, isDir, patterns) {
  if (patterns.length === 0) return false;
  const base = relPath.split("/").pop();
  let ignored = false;
  for (const p of patterns) {
    // A file pattern also ignores everything beneath a matched directory.
    const candidate = p.hasSlash ? relPath : base;
    let hit = p.regex.test(candidate);
    if (!hit && p.dirOnly && (relPath === p.literal || relPath.startsWith(`${p.literal}/`))) hit = true;
    if (!hit && p.hasSlash && relPath.startsWith(`${p.literal}/`)) hit = true;
    if (hit && !(p.dirOnly && !isDir && !relPath.startsWith(`${p.literal}/`))) {
      ignored = !p.negated;
    }
  }
  return ignored;
}

export function scanCodebaseForTodos(dir = process.cwd()) {
  const todos = [];
  const patterns = loadGitignorePatterns(dir);
  function walk(current) {
    let entries = [];
    try { entries = readdirSync(current); } catch (_) { return; }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git") continue;
      const full = join(current, entry);
      try {
        const stat = statSync(full);
        const rel = relative(dir, full).split("\\").join("/");
        if (rel && isIgnored(rel, stat.isDirectory(), patterns)) continue;
        if (stat.isDirectory()) {
          walk(full);
        } else if (stat.isFile()) {
          if (!SCAN_ALLOWED_EXTENSIONS.has(extname(entry).toLowerCase())) continue;
          if (stat.size > SCAN_MAX_FILE_BYTES) continue;
          let content;
          try {
            content = readFileSync(full);
          } catch (_) {
            continue;
          }
          if (content.includes(0)) continue;
          const lines = content.toString("utf-8").split("\n");
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
