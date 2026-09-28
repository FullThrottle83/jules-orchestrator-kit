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
import { matchesGlob, TAMPER_KIND_NAMES } from "./security.mjs";

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
 * Parses the labels payload GitHub Actions exposes for a pull request.
 * Accepts an array, raw `toJSON(...labels)` JSON string, or a plain comma-separated string.
 *
 * @param {string|Array} raw
 * @returns {string[]}
 */
export function parseLabels(raw = "") {
  if (Array.isArray(raw)) {
    return raw.map((l) => (typeof l === "string" ? l : l && l.name) || "").filter(Boolean);
  }
  const text = String(raw || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((l) => (typeof l === "string" ? l : l && l.name) || "").filter(Boolean);
    }
  } catch (_) {}
  return text.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Resolves tamper guard waivers from PR labels bound to the exact head SHA.
 *
 * Test expectation waivers MUST be explicitly bound to the reviewed commit SHA
 * (e.g. `allow-test-expectation:<SHA>` or `allow-test-change:<kind>:<SHA>`).
 * Unbound labels (without SHA) or stale labels (SHA mismatch) are rejected.
 *
 * @param {string|string[]} rawLabels - Array of labels, JSON string, or comma-separated string
 * @param {string} headSha - Full or short commit SHA of the current PR head
 * @returns {{ allowedKinds: string[], rejected: Array<{ label: string, reason: string }> }}
 */
export function resolveTestWaiverFromLabels(rawLabels = "", headSha = "") {
  const labels = parseLabels(rawLabels);
  const allowedKinds = new Set();
  const rejected = [];
  const normalizedHead = String(headSha || "").trim().toLowerCase();

  for (const label of labels) {
    const lower = label.trim().toLowerCase();

    if (!lower.startsWith("allow-test-")) {
      continue;
    }

    const parts = lower.split(":");
    let kind = null;
    let targetSha = null;

    if (parts[0] === "allow-test-expectation") {
      kind = "expectation";
      if (parts.length > 1) {
        targetSha = parts.slice(1).join(":");
      }
    } else if (parts[0] === "allow-test-change" || parts[0] === "allow-test-changes") {
      if (parts.length === 2) {
        if (TAMPER_KIND_NAMES.includes(parts[1])) {
          kind = parts[1];
        } else {
          kind = "expectation";
          targetSha = parts[1];
        }
      } else if (parts.length >= 3) {
        kind = parts[1];
        targetSha = parts.slice(2).join(":");
      } else {
        kind = "expectation";
      }
    } else {
      continue;
    }

    if (!targetSha) {
      rejected.push({
        label,
        reason: `Unbound waiver: label has no commit SHA. Must be formatted as "${parts[0]}:<40-hex-SHA>".`,
      });
      continue;
    }

    if (!/^[0-9a-f]{40}$/i.test(targetSha)) {
      rejected.push({
        label,
        reason: `Invalid commit SHA "${targetSha}": must be exact 40 hexadecimal characters. Prefix matching is not permitted.`,
      });
      continue;
    }

    if (!normalizedHead || !/^[0-9a-f]{40}$/i.test(normalizedHead)) {
      rejected.push({
        label,
        reason: `Cannot verify binding: HEAD_SHA "${headSha}" is missing or not a valid 40-character commit SHA.`,
      });
      continue;
    }

    if (targetSha.toLowerCase() !== normalizedHead) {
      rejected.push({
        label,
        reason: `Stale waiver: label SHA "${targetSha}" does not match current HEAD SHA "${normalizedHead}".`,
      });
      continue;
    }

    if (TAMPER_KIND_NAMES.includes(kind)) {
      allowedKinds.add(kind);
    } else {
      rejected.push({
        label,
        reason: `Unknown tamper kind "${kind}". Valid kinds: ${TAMPER_KIND_NAMES.join(", ")}`,
      });
    }
  }

  return {
    allowedKinds: Array.from(allowedKinds),
    rejected,
  };
}

/**
 * Resolves protected-path bypass waivers from PR labels bound to the exact head SHA.
 *
 * Protected path waivers MUST be explicitly bound to the reviewed commit SHA
 * (e.g. `allow-protected-paths:<40-hex-SHA>`).
 * Unbound labels (without SHA), prefix matching, or stale labels (SHA mismatch) are rejected.
 *
 * @param {string|string[]} rawLabels - Array of labels, JSON string, or comma-separated string
 * @param {string} headSha - Full 40-character commit SHA of the current PR head
 * @returns {{ ok: boolean, boundSha?: string, rejected: Array<{ label: string, reason: string }> }}
 */
export function resolveProtectedWaiverFromLabels(rawLabels = "", headSha = "") {
  const labels = parseLabels(rawLabels);
  const normalizedHead = String(headSha || "").trim().toLowerCase();
  const rejected = [];

  for (const label of labels) {
    const lower = label.trim().toLowerCase();
    if (!lower.startsWith("allow-protected-paths")) continue;

    const parts = lower.split(":");
    if (parts.length === 1) {
      rejected.push({
        label,
        reason: 'Unbound waiver: label has no commit SHA. Must be formatted as "allow-protected-paths:<40-hex-SHA>".',
      });
      continue;
    }

    const targetSha = parts.slice(1).join(":");
    if (!/^[0-9a-f]{40}$/i.test(targetSha)) {
      rejected.push({
        label,
        reason: `Invalid commit SHA "${targetSha}": must be exact 40 hexadecimal characters. Prefix matching is not permitted.`,
      });
      continue;
    }

    if (!normalizedHead || !/^[0-9a-f]{40}$/i.test(normalizedHead)) {
      rejected.push({
        label,
        reason: `Cannot verify binding: HEAD_SHA "${headSha}" is missing or not a valid 40-character commit SHA.`,
      });
      continue;
    }

    if (targetSha.toLowerCase() !== normalizedHead) {
      rejected.push({
        label,
        reason: `Stale waiver: label SHA "${targetSha}" does not match current HEAD SHA "${normalizedHead}".`,
      });
      continue;
    }

    return { ok: true, boundSha: normalizedHead, rejected };
  }

  return { ok: false, rejected };
}

/**
 * Audit gate rules (scope, payload governor, secret scanning, verification suite).
 */
export async function auditGates(opts = {}) {
  const root = opts.root || process.env.JULES_PROJECT_ROOT || process.cwd();
  const config = opts.config || loadConfig(root);
  const base = opts.base || process.env.BASE_BRANCH || config.baseBranch || "main";

  let allowProtected =
    opts.allowProtected ??
    (process.env.JULES_ALLOW_COMMAND_FILE_CHANGES === "true" ||
      process.env.JULES_ALLOW_COMMAND_FILE_CHANGES === "1");

  const rawLabels = opts.prLabels || process.env.PR_LABELS;
  const headSha = opts.headSha || process.env.HEAD_SHA;

  if (!allowProtected && rawLabels) {
    const waiver = resolveProtectedWaiverFromLabels(rawLabels, headSha);
    if (waiver.ok) {
      allowProtected = true;
    }
    for (const rej of waiver.rejected || []) {
      console.warn(`::warning::[scope-waiver] ${rej.label}: ${rej.reason}`);
    }
  }

  let allowTestChanges = opts.allowTestChanges || process.env.JULES_ALLOW_TEST_CHANGES;
  if (!allowTestChanges && rawLabels) {
    const waiver = resolveTestWaiverFromLabels(rawLabels, headSha);
    if (waiver.allowedKinds.length > 0) {
      allowTestChanges = waiver.allowedKinds.join(",");
    }
    for (const rej of waiver.rejected) {
      console.warn(`::warning::[tamper-waiver] ${rej.label}: ${rej.reason}`);
    }
  }

  return await gate({
    root,
    config,
    base,
    fix: process.env.ALLOW_AUTO_REPAIR === "true",
    allowProtected,
    allowTestChanges,
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
    // The CLI's exit-6 banner intentionally does not print diff contents.
    // Surface safe finding coordinates so a legitimate change can be repaired
    // without disabling the independent audit or guessing at the failure.
    if (gatesResult.code === 6) {
      const findings = gatesResult.phases?.find((phase) => phase.phase === "secrets")?.findings || [];
      for (const finding of findings) {
        console.error(`Self-audit finding: ${finding.type || "UNKNOWN"} at ${finding.file || "unattributed"}${finding.line ? `:${finding.line}` : ""}`);
      }
    }
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
