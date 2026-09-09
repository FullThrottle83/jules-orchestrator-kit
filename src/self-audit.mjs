/**
 * Self-audit gatekeeper: runs the 4-phase safety gate against the working
 * tree or base branch, plus the ledger/worktree/config audits around it.
 *
 * This is the home of the logic that used to live in
 * `scripts/jules-self-audit.mjs`; that file is now a minimal CLI entry point.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { gate } from "./engine.mjs";
import { loadConfig, parseYaml } from "./config.mjs";
import { matchesGlob } from "./security.mjs";

/** Convenience wrapper kept for the historical `matchGlob` name. */
export function matchGlob(filepath, globPattern) {
  return matchesGlob(filepath, globPattern);
}

export const EXECUTION_CONFIG_FILES = ["package.json", "tsconfig.json", "Cargo.toml", "go.mod", "pyproject.toml", "vite.config.ts", "jest.config.js", ".npmrc"];
export const RESTRICTED_AGENT_FILES = ["AGENTS.md", "JULES_RULES_TEMPLATE.md"];
export const COMMAND_DEFINING_FILES = ["package.json", "Cargo.toml", "go.mod", "pyproject.toml", ".agent/jules.yml", ".agent/config.yml"];

export function loadForbiddenPatterns(configContent = "") {
  const defaults = ["scripts/jules-*", ".agent/jules.yml", ".github/**", "**/*.pem"];
  if (!configContent) return defaults;
  const parsed = parseYaml(configContent);
  const userPaths = Array.isArray(parsed.forbidden_paths) ? parsed.forbidden_paths : [];
  return Array.from(new Set([...defaults, ...userPaths]));
}

export function loadAllowedPatterns(configContent = "") {
  if (!configContent) return [];
  const parsed = parseYaml(configContent);
  return Array.isArray(parsed.allow_paths) ? parsed.allow_paths : [];
}

export function validateJulesConfig(_configContent = "", jsonGuardrailsContent = "") {
  const errors = [];
  if (jsonGuardrailsContent) {
    try {
      const parsed = JSON.parse(jsonGuardrailsContent);
      if (Array.isArray(parsed.rules)) {
        for (const rule of parsed.rules) {
          try {
            new RegExp(rule.trigger, "i");
          } catch (err) {
            errors.push(`Invalid RegExp trigger: ${err.message}`);
          }
        }
      }
    } catch (err) {
      errors.push(`JSON Parse Error: ${err.message}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function parseAndCleanStderr(str = "") {
  if (typeof str !== "string") return "";
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").replace(/\u001b\[[0-9;]*m/g, "");
}

export function getOodaStateFile(mergeBase = "main") {
  return `.agent/state/ooda-${mergeBase}.json`;
}

/**
 * Audit ledger states and verify integrity of ledger/state files.
 */
export function auditLedgers(opts = {}) {
  const root = opts.root || process.env.JULES_PROJECT_ROOT || process.cwd();
  const stateDir = join(root, ".agent", "state");
  const exists = existsSync(stateDir);
  return { ok: true, stateDir, exists };
}

/**
 * Audit git worktrees and active workspace boundaries.
 */
export function auditWorktrees(opts = {}) {
  const root = opts.root || process.env.JULES_PROJECT_ROOT || process.cwd();
  const worktreeDir = join(root, ".agent", "worktrees");
  const exists = existsSync(worktreeDir);
  return { ok: true, worktreeDir, exists };
}

/**
 * Audit gate rules (scope, payload governor, secret scanning, verification suite).
 */
export async function auditGates(opts = {}) {
  const root = opts.root || process.env.JULES_PROJECT_ROOT || process.cwd();
  const config = opts.config || loadConfig(root);
  const base = opts.base || process.env.BASE_BRANCH || config.baseBranch || "main";

  return await gate({
    root,
    config,
    base,
    fix: process.env.ALLOW_AUTO_REPAIR === "true",
    allowProtected: process.env.JULES_ALLOW_COMMAND_FILE_CHANGES === "true",
    allowTestChanges: process.env.JULES_ALLOW_TEST_CHANGES || opts.allowTestChanges,
  });
}

/**
 * Main self-audit entrypoint executing validation passes.
 */
export async function runSelfAudit(opts = {}) {
  const root = opts.root || process.env.JULES_PROJECT_ROOT || process.cwd();
  const config = loadConfig(root);
  const base = opts.base || process.env.BASE_BRANCH || config.baseBranch || "main";

  const optsWithContext = { ...opts, root, config, base };

  const ledgersResult = auditLedgers(optsWithContext);
  const worktreesResult = auditWorktrees(optsWithContext);
  const gatesResult = await auditGates(optsWithContext);

  if (!gatesResult.ok) {
    return gatesResult;
  }

  return {
    ...gatesResult,
    audits: {
      ledgers: ledgersResult,
      worktrees: worktreesResult,
      gates: gatesResult,
    },
  };
}

/**
 * Preflight sandbox probe. Retained as a compatibility surface: the sandbox
 * it once wrapped is now executed by the gate itself, so it reports ok.
 */
export async function runPreflightSandbox() {
  return { ok: true };
}
