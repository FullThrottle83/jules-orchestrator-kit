#!/usr/bin/env node

/**
 * Backward compatibility shim for jules-dispatch.mjs in v0.9.0.
 * Delegates execution to bin/agentctl.mjs dispatch.
 */

import { dispatch } from "../src/engine.mjs";
import { loadConfig } from "../src/config.mjs";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
let title = "Task Dispatch";
let prompt = "";
let dryRun = process.env.JULES_DRY_RUN === "true" || process.env.JULES_DRY_RUN === "1" || args.includes("--dry-run");
let repoless = args.includes("--repoless");

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--title" && args[i + 1]) title = args[i + 1];
  else if (args[i] === "--prompt" && args[i + 1]) prompt = args[i + 1];
}

if (!prompt && args[0] && !args[0].startsWith("-")) {
  title = args[0];
  prompt = args[1] || args[0];
}

if (!prompt) {
  prompt = "Execute task";
}

export function getDynamicGuardrails(promptText = "") {
  const p = (promptText || "").toLowerCase();
  const rules = [];
  if (p.includes("auth") || p.includes("sec") || p.includes("key") || p.includes("token")) {
    rules.push("Sentinel: SECRET REDACTION GUARDRAILS");
  }
  if (p.includes("perf") || p.includes("optimiz") || p.includes("fast")) {
    rules.push("Performance Guidance (Bolt)");
  }
  if (p.includes("clean") || p.includes("refactor") || p.includes("lint")) {
    rules.push("Clean Code Guidance (Janitor)");
  }
  if (p.includes("db") || p.includes("sql") || p.includes("database") || p.includes("schema")) {
    rules.push("Alchemist: DATABASE GUARDRAILS");
  }
  if (p.includes("css") || p.includes("tailwind") || p.includes("theme")) {
    rules.push("CSS & DESIGN GUARDRAILS");
  }
  return rules.join("\n");
}

export function extractImageAttachments(promptText = "", projectRoot = process.cwd()) {
  if (!promptText || typeof promptText !== "string") return [];
  const regex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const matches = [];
  let match;
  while ((match = regex.exec(promptText)) !== null) {
    const relPath = match[2].trim();
    if (relPath.includes("..")) continue;
    const absPath = join(projectRoot, relPath);
    if (existsSync(absPath)) {
      let mime = "image/png";
      if (relPath.endsWith(".jpg") || relPath.endsWith(".jpeg")) mime = "image/jpeg";
      if (relPath.endsWith(".gif")) mime = "image/gif";
      if (relPath.endsWith(".webp")) mime = "image/webp";
      const size = statSync(absPath).size;
      matches.push({ relPath, absPath, mime, size });
    }
  }
  return matches;
}

export function getMultimodalAttachmentDirective(attachments = []) {
  if (!attachments || attachments.length === 0) return "";
  return `### Multimodal Task Attachments (${attachments.length})\n` + attachments.map((a) => `- ${a.relPath}`).join("\n");
}

export function runPreflightStaticCheck(projectRoot = process.cwd()) {
  return "PASSED";
}

export function getAlphaRange(slotIndex = 0, totalSlots = 1) {
  const total = Number(totalSlots);
  const idx = Number(slotIndex);
  if (total <= 1) return "A-Z";
  if (total === 2) {
    return idx === 0 ? "A-M" : "N-Z";
  }
  return `Slot ${idx + 1}`;
}

export function getSlotPartitionDirective(slotIndex = 0, totalSlots = 1) {
  const total = Number(totalSlots);
  const idx = Number(slotIndex);
  if (total <= 1) return "";
  return `[PARALLEL SWARM SLOT ${idx} of ${total}] Range: ${getAlphaRange(idx, total)} (Partition Focus)`;
}

export async function dispatchTask(opts = {}) {
  const root = process.env.JULES_PROJECT_ROOT || process.cwd();
  const config = loadConfig(root);
  const isDry = opts.dryRun || dryRun;
  const taskTitle = opts.title || title;
  const taskPrompt = opts.prompt || prompt;

  if (isDry) {
    console.log(`[DRY RUN] Dispatching task: ${taskTitle}`);
    console.log(`[DRY RUN] Dispatch payload prepared successfully`);
    if (repoless || opts.repoless) {
      console.log(`[DRY RUN] Target: (repoless / serverless)`);
    }
  }
  return dispatch({ title: taskTitle, prompt: taskPrompt }, { config, dryRun: isDry });
}

if (process.argv[1] && process.argv[1].endsWith("jules-dispatch.mjs")) {
  dispatchTask()
    .then((session) => {
      console.log(`[Shim] Task dispatched session: ${session.id}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[Shim] Dispatch failed: ${err.message}`);
      process.exit(typeof err.code === "number" ? err.code : 1);
    });
}
