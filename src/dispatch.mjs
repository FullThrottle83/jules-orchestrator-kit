/**
 * Task-dispatch helpers: dynamic guardrails, multimodal attachment
 * collection, static preflight checks, swarm slot partitioning, and the
 * programmatic `dispatchTask` wrapper around the engine.
 *
 * This is the home of the logic that used to live in
 * `scripts/jules-dispatch.mjs`; that file is now a deprecated CLI entry
 * point. Argv parsing stays a pure function so importing this module can
 * never consume the importer's `process.argv` (D10).
 */

import { dispatch } from "./engine.mjs";
import { loadConfig } from "./config.mjs";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Pure argv parser for the deprecated CLI shim. It used to run at module scope,
 * so merely importing the script consumed the importer's process.argv and baked
 * it into dispatchTask()'s defaults. It is now called only from the CLI entry
 * guard at the bottom of scripts/jules-dispatch.mjs.
 *
 * @param {string[]} [argv]
 * @returns {{ title: string, prompt: string, dryRun: boolean, repoless: boolean }}
 */
export function parseDispatchArgs(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  let title = "Task Dispatch";
  let prompt = "";
  const dryRun =
    process.env.JULES_DRY_RUN === "true" || process.env.JULES_DRY_RUN === "1" || args.includes("--dry-run");
  const repoless = args.includes("--repoless");

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

  return { title, prompt, dryRun, repoless };
}

/**
 * Built-in guardrail triggers, used when no project-level
 * `.agent/rules/dynamic-guardrails.json` matches (or the file is absent).
 *
 * Matching is on word boundaries: the old substring checks fired on "sector"
 * ("sec"), "breakfast" ("fast") and "keyboard" ("key"). Role labels are the
 * canonical slugs (security, performance, hygiene, database), not the legacy
 * RPG names.
 */
const BUILTIN_GUARDRAIL_TRIGGERS = [
  { pattern: /\b(auth|sec|key|token|secret)\b/i, guardrail: "security: SECRET REDACTION GUARDRAILS" },
  { pattern: /\b(perf|optimiz\w*|fast|cache|memoiz\w*)\b/i, guardrail: "performance: Performance Guidance" },
  { pattern: /\b(clean|refactor|lint|deadcode)\b/i, guardrail: "hygiene: Clean Code Guidance" },
  {
    pattern: /\b(db|database|sql\w*|schema|drizzle|postgres\w*|sqlite\w*|mysql\w*)\b/i,
    guardrail: "database: DATABASE GUARDRAILS",
  },
  { pattern: /\b(css|theme|tailwind)\b/i, guardrail: "CSS & DESIGN GUARDRAILS" },
];

/**
 * Collects the guardrail blocks relevant to a prompt: built-in canonical-role
 * triggers plus any project rules from
 * `<projectRoot>/.agent/rules/dynamic-guardrails.json` (`{ rules:
 * [{ trigger, guardrail }] }`, trigger compiled case-insensitively).
 *
 * @param {string} [promptText]
 * @param {string} [projectRoot]
 * @returns {string} Matching guardrails joined by newlines ("" when none match).
 */
export function getDynamicGuardrails(promptText = "", projectRoot = process.cwd()) {
  const text = promptText || "";
  const rules = [];
  for (const { pattern, guardrail } of BUILTIN_GUARDRAIL_TRIGGERS) {
    if (pattern.test(text)) rules.push(guardrail);
  }
  try {
    const rulesPath = join(projectRoot || process.cwd(), ".agent", "rules", "dynamic-guardrails.json");
    if (existsSync(rulesPath)) {
      const parsed = JSON.parse(readFileSync(rulesPath, "utf-8"));
      const fileRules = Array.isArray(parsed) ? parsed : parsed?.rules;
      if (Array.isArray(fileRules)) {
        for (const rule of fileRules) {
          if (!rule || typeof rule.trigger !== "string" || typeof rule.guardrail !== "string") continue;
          let trigger;
          try {
            trigger = new RegExp(rule.trigger, "i");
          } catch (_) {
            continue;
          }
          if (trigger.test(text)) rules.push(rule.guardrail);
        }
      }
    }
  } catch (_) {
    // A missing or corrupt rules file must not break dispatch; the built-ins above still apply.
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

/**
 * Real pre-flight manifest check: the project must carry a parseable
 * package.json object. Previously this returned "PASSED" unconditionally, so a
 * missing or corrupt manifest was reported as verified.
 *
 * @param {string} [projectRoot]
 * @returns {string} "PASSED", or "FAILED: <reason>".
 */
export function runPreflightStaticCheck(projectRoot = process.cwd()) {
  const root = projectRoot || process.cwd();
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) {
    return "FAILED: package.json not found";
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch (err) {
    return `FAILED: package.json is not valid JSON (${err.message})`;
  }
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
    return "FAILED: package.json must contain a JSON object";
  }
  return "PASSED";
}

/**
 * Balanced letter partition for parallel swarm slots: the 26 letters are split
 * into `total` contiguous ranges whose sizes differ by at most one
 * (N=3 → A-I, J-R, S-Z). Out-of-range slots and slots past Z (total > 26) get
 * an empty range. Totals <= 1 keep the historical "A-Z".
 *
 * @param {number|string} [slotIndex]
 * @param {number|string} [totalSlots]
 * @returns {string} e.g. "A-M", "J-R", "Z", or "".
 */
export function getAlphaRange(slotIndex = 0, totalSlots = 1) {
  const total = Number(totalSlots);
  const idx = Number(slotIndex);
  if (!Number.isFinite(total) || total <= 1) return "A-Z";
  if (!Number.isInteger(idx) || idx < 0 || idx >= total) return "";
  const base = Math.floor(26 / total);
  const extra = 26 % total;
  const count = base + (idx < extra ? 1 : 0);
  if (count <= 0) return "";
  const start = idx * base + Math.min(idx, extra);
  const end = start + count - 1;
  const first = String.fromCharCode(65 + start);
  const last = String.fromCharCode(65 + end);
  return first === last ? first : `${first}-${last}`;
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
  const isDry =
    opts.dryRun ?? (process.env.JULES_DRY_RUN === "true" || process.env.JULES_DRY_RUN === "1");
  const taskTitle = opts.title || "Task Dispatch";
  const taskPrompt = opts.prompt || "Execute task";

  if (isDry) {
    console.log(`[DRY RUN] Dispatching task: ${taskTitle}`);
    console.log(`[DRY RUN] Dispatch payload prepared successfully`);
    if (opts.repoless) {
      console.log(`[DRY RUN] Target: (repoless / serverless)`);
    }
  }
  return dispatch({ title: taskTitle, prompt: taskPrompt }, { config, dryRun: isDry });
}
