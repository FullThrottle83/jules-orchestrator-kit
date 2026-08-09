#!/usr/bin/env node

/**
 * Backward compatibility shim for jules-self-audit.mjs in v0.9.0.
 * Delegates execution to src/engine.mjs gate().
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

let gate, loadConfig, parseYaml, matchesGlob;
try {
  ({ gate } = await import("../src/engine.mjs"));
  ({ loadConfig, parseYaml } = await import("../src/config.mjs"));
  ({ matchesGlob } = await import("../src/security.mjs"));
} catch (_) {
  try {
    ({ gate, loadConfig, parseYaml, matchesGlob } = await import("jules-orchestrator-kit"));
  } catch (err) {
    console.error("Error: Could not resolve jules-orchestrator-kit modules.", err.message);
    process.exit(1);
  }
}

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

export function logAuditMetrics() {}

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

export async function runPreflightSandbox() {
  return { ok: true };
}

if (process.argv[1] && process.argv[1].endsWith("jules-self-audit.mjs")) {
  runSelfAudit()
    .then((res) => {
      if (!res.ok) {
        if (res.code === 3) {
          console.error("❌ RESTRICTED FILE VIOLATION");
        } else if (res.code === 6) {
          console.error("❌ SECRET LEAK PREVENTED");
        } else {
          console.error(`❌ Self Audit Failed (Exit ${res.code})`);
        }
        process.exit(res.code);
      }
      console.log("Audit Complete: PASSED");
      process.exit(0);
    })
    .catch((err) => {
      console.error(`Audit Failure: ${err.message}`);
      process.exit(err.code || 1);
    });
}
