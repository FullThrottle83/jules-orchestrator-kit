/**
 * Deterministic migration of supported 0.x config and task-envelope state to
 * canonical v1 shapes (`.agent/config.yml`, `agentctl.task/v1` frontmatter).
 *
 * Closes the `agentctl migrate` CLI gap from docs/v1-surface-inventory.md / #38.
 */

import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { parseYaml, yamlScalar } from "./config.mjs";
import {
  parseTaskFrontmatter,
  serializeTaskFrontmatter,
  parseEnvelopeHeader,
} from "./envelope.mjs";
import { safeAtomicWrite } from "./fs-atomic.mjs";

/** Top-level 0.x verify command keys → nested `verify.*` fields. */
export const LEGACY_VERIFY_FIELDS = Object.freeze({
  test_cmd: "test",
  setup_cmd: "setup",
  lint_cmd: "lint",
  build_cmd: "build",
  fuzz_cmd: "fuzz",
  invariant_cmd: "invariant",
  e2e_cmd: "e2e",
  teardown_cmd: "teardown",
  timeout_ms: "timeout_ms",
});

const CANONICAL_MESSAGE = "Repository is already in canonical v1 format.";

/**
 * @param {unknown} value
 * @param {number} indent
 * @returns {string}
 */
function serializeYamlValue(value, indent = 0) {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return (
      "\n" +
      value
        .map((item) => {
          if (item !== null && typeof item === "object" && !Array.isArray(item)) {
            const entries = Object.entries(item);
            if (entries.length === 0) return `${pad}- {}`;
            const [firstKey, firstVal] = entries[0];
            const firstLine =
              typeof firstVal === "object" && firstVal !== null
                ? `${pad}- ${firstKey}:${serializeYamlValue(firstVal, indent + 2)}`
                : `${pad}- ${firstKey}: ${yamlScalar(firstVal)}`;
            const rest = entries.slice(1).map(([k, v]) => {
              if (typeof v === "object" && v !== null) {
                return `${pad}  ${k}:${serializeYamlValue(v, indent + 2)}`;
              }
              if (typeof v === "boolean" || typeof v === "number") return `${pad}  ${k}: ${v}`;
              return `${pad}  ${k}: ${yamlScalar(v)}`;
            });
            return [firstLine, ...rest].join("\n");
          }
          return `${pad}- ${yamlScalar(item)}`;
        })
        .join("\n")
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    return (
      "\n" +
      entries
        .map(([k, v]) => {
          if (v !== null && typeof v === "object") {
            const nested = serializeYamlValue(v, indent + 1);
            if (nested === "[]" || nested === "{}") return `${pad}${k}: ${nested}`;
            return `${pad}${k}:${nested}`;
          }
          if (typeof v === "boolean" || typeof v === "number") return `${pad}${k}: ${v}`;
          return `${pad}${k}: ${yamlScalar(v)}`;
        })
        .join("\n")
    );
  }
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return yamlScalar(value);
}

/**
 * Serialize a plain config object to kit-style YAML.
 * @param {Record<string, unknown>} obj
 * @param {string} [headerComment]
 * @returns {string}
 */
export function serializeConfigYaml(obj, headerComment = "# Agent Orchestrator Kit Config") {
  const lines = [headerComment];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === "object") {
      const nested = serializeYamlValue(value, 1);
      if (nested === "[]" || nested === "{}") {
        lines.push(`${key}: ${nested}`);
      } else {
        lines.push(`${key}:${nested}`);
      }
    } else if (typeof value === "boolean" || typeof value === "number") {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  return lines.join("\n").replace(/\n+$/, "") + "\n";
}

/**
 * Lift legacy top-level `*_cmd` / `timeout_ms` keys into `verify: { ... }`.
 *
 * @param {Record<string, any>} parsed
 * @returns {{ obj: Record<string, any>, changes: string[], lifted: boolean }}
 */
export function normalizeLegacyVerifyFields(parsed) {
  const obj = { ...parsed };
  const changes = [];
  const verify = { ...(obj.verify && typeof obj.verify === "object" ? obj.verify : {}) };
  let lifted = false;

  for (const [legacyKey, verifyKey] of Object.entries(LEGACY_VERIFY_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(obj, legacyKey)) continue;
    const legacyVal = obj[legacyKey];
    const existing = verify[verifyKey];
    const existingEmpty = existing === undefined || existing === null || existing === "";
    if (existingEmpty && legacyVal !== undefined && legacyVal !== null && legacyVal !== "") {
      verify[verifyKey] = legacyVal;
      changes.push(`lifted ${legacyKey} → verify.${verifyKey}`);
    } else {
      changes.push(`removed legacy ${legacyKey}`);
    }
    delete obj[legacyKey];
    lifted = true;
  }

  if (lifted) {
    obj.verify = verify;
  }

  if (obj.version === 2 || obj.version === "2") {
    obj.version = 1;
    changes.push("normalized version → 1");
    lifted = true;
  }

  return { obj, changes, lifted };
}

/**
 * Build a canonical config object from a parsed jules.yml (or mixed legacy) document.
 * @param {Record<string, any>} parsed
 * @returns {{ obj: Record<string, any>, changes: string[] }}
 */
function toCanonicalConfig(parsed) {
  const { obj: normalized, changes } = normalizeLegacyVerifyFields(parsed);
  const verify = {
    ...(normalized.verify && typeof normalized.verify === "object" ? normalized.verify : {}),
  };

  const out = {
    version: 1,
    provider: normalized.provider || "jules",
    tier: normalized.tier || "free",
    base_branch: normalized.base_branch || normalized.baseBranch || "main",
    branch_prefix: normalized.branch_prefix || normalized.branchPrefix || "agent/",
  };

  if (normalized.limits && typeof normalized.limits === "object") {
    out.limits = normalized.limits;
  }

  const verifyOut = {
    profile: verify.profile || "standard",
    scope: verify.scope || "global",
  };
  for (const key of [
    "setup",
    "test",
    "lint",
    "build",
    "typecheck",
    "fuzz",
    "invariant",
    "e2e",
    "teardown",
    "timeout_ms",
  ]) {
    if (verify[key] !== undefined && verify[key] !== null && verify[key] !== "") {
      verifyOut[key] = verify[key];
    }
  }
  if (verify.timeout_ms === undefined && verify.timeoutMs === undefined) {
    verifyOut.timeout_ms = 300000;
  } else if (verify.timeoutMs !== undefined && verify.timeout_ms === undefined) {
    verifyOut.timeout_ms = verify.timeoutMs;
  }
  if (verify.policy) verifyOut.policy = verify.policy;
  out.verify = verifyOut;

  if (Array.isArray(normalized.presets)) out.presets = normalized.presets;

  if (Array.isArray(normalized.forbidden_paths)) out.forbidden_paths = normalized.forbidden_paths;
  else if (Array.isArray(normalized.scope?.deny)) out.forbidden_paths = normalized.scope.deny;
  if (Array.isArray(normalized.allow_paths)) out.allow_paths = normalized.allow_paths;
  else if (Array.isArray(normalized.scope?.allow)) out.allow_paths = normalized.scope.allow;

  const reserved = new Set([
    "version",
    "provider",
    "tier",
    "base_branch",
    "baseBranch",
    "branch_prefix",
    "branchPrefix",
    "limits",
    "verify",
    "presets",
    "forbidden_paths",
    "allow_paths",
    "scope",
    ...Object.keys(LEGACY_VERIFY_FIELDS),
  ]);
  for (const [k, v] of Object.entries(normalized)) {
    if (reserved.has(k) || out[k] !== undefined) continue;
    out[k] = v;
  }

  changes.unshift("migrated legacy manifest shape to canonical config.yml");
  return { obj: out, changes };
}

/**
 * @param {string} content
 * @returns {{ needs: boolean, reason?: string }}
 */
export function taskNeedsMigration(content) {
  const text = String(content || "");
  if (/JULES_TASK_ENVELOPE/.test(text)) {
    return { needs: true, reason: "legacy JULES_TASK_ENVELOPE marker" };
  }
  const fm = parseTaskFrontmatter(text);
  if (!fm) return { needs: false };
  const version = fm.metadata?.version || fm.metadata?.apiVersion;
  if (version !== "agentctl.task/v1") {
    return { needs: true, reason: "missing or non-v1 version field" };
  }
  return { needs: false };
}

/**
 * Upgrade a task file body to `agentctl.task/v1` frontmatter.
 * @param {string} content
 * @returns {{ content: string, changes: string[] } | null}
 */
export function upgradeTaskContent(content) {
  const check = taskNeedsMigration(content);
  if (!check.needs) return null;

  const header = parseEnvelopeHeader(content);
  if (!header) return null;

  const fm = parseTaskFrontmatter(content);
  let body;
  const changes = [];

  if (/JULES_TASK_ENVELOPE/.test(content)) {
    changes.push("converted JULES_TASK_ENVELOPE to agentctl.task/v1 frontmatter");
    if (fm) {
      body = fm.body;
    } else {
      body = content.replace(/<!--\s*JULES_TASK_ENVELOPE:\s*{[\s\S]*?}\s*-->\s*/, "");
    }
  } else {
    changes.push("set version: agentctl.task/v1");
    body = fm ? fm.body : content;
  }

  const serialized = serializeTaskFrontmatter({
    kind: header.kind || "Task",
    version: "agentctl.task/v1",
    id: header.id || header.taskId,
    title: header.title,
    role: header.role,
    tier: header.tier,
    base_commit: header.base_commit || header.baseCommit,
    risk: header.risk,
    circuitBreaker: header.circuitBreaker,
    dependsOn: header.dependsOn,
    scope: header.scope,
    verification: header.verification,
    verifyCmd: header.verifyCmd,
    invariants: header.invariants,
    mcp_directives: header.mcp_directives,
    flags: header.flags,
  });

  const cleanedBody = String(body || "").replace(/^\r?\n/, "");
  return {
    content: `${serialized}\n${cleanedBody}`,
    changes,
  };
}

/**
 * Plan migrations without writing disk.
 *
 * @param {string} root
 * @param {object} [_options]
 * @returns {{
 *   ok: boolean,
 *   migrated: Array<{ type: string, path: string, changes: string[], from?: string, content?: string, remove?: string[] }>,
 *   warnings: string[],
 *   message?: string,
 * }}
 */
export function planMigration(root, _options = {}) {
  const migrated = [];
  const warnings = [];

  const agentDir = join(root, ".agent");
  const configPath = join(agentDir, "config.yml");
  const julesPath = join(agentDir, "jules.yml");
  const hasConfig = existsSync(configPath);
  const hasJules = existsSync(julesPath);

  if (hasJules && hasConfig) {
    warnings.push(
      "Both .agent/jules.yml and .agent/config.yml exist; leaving jules.yml in place (will not overwrite config.yml). Remove .agent/jules.yml manually after confirming config.yml is authoritative."
    );
  }

  if (hasJules && !hasConfig) {
    let raw = "";
    try {
      raw = readFileSync(julesPath, "utf-8");
    } catch (err) {
      warnings.push(`Could not read .agent/jules.yml: ${err.message}`);
    }
    if (raw) {
      const parsed = parseYaml(raw) || {};
      const { obj, changes } = toCanonicalConfig(parsed);
      const content = serializeConfigYaml(
        obj,
        "# Agent Orchestrator Kit Config (migrated from .agent/jules.yml)"
      );
      migrated.push({
        type: "config",
        path: ".agent/config.yml",
        from: ".agent/jules.yml",
        changes: [
          "rename .agent/jules.yml → .agent/config.yml",
          ...changes.filter((c) => !c.startsWith("migrated legacy")),
          "remove .agent/jules.yml",
        ],
        content,
        remove: [".agent/jules.yml"],
      });
    }
  }

  if (hasConfig) {
    let raw = "";
    try {
      raw = readFileSync(configPath, "utf-8");
    } catch (err) {
      warnings.push(`Could not read .agent/config.yml: ${err.message}`);
    }
    if (raw) {
      const parsed = parseYaml(raw) || {};
      const { obj, changes, lifted } = normalizeLegacyVerifyFields(parsed);
      if (lifted && changes.length > 0) {
        const content = serializeConfigYaml(
          obj,
          "# Agent Orchestrator Kit Config (legacy verify fields normalized)"
        );
        migrated.push({
          type: "config",
          path: ".agent/config.yml",
          changes,
          content,
        });
      }
    }
  }

  const queueDir = join(agentDir, "jules-queue");
  if (existsSync(queueDir)) {
    let entries = [];
    try {
      entries = readdirSync(queueDir);
    } catch (_) {
      entries = [];
    }
    for (const name of entries.sort()) {
      if (!name.endsWith(".md") || name === "README.md") continue;
      const rel = `.agent/jules-queue/${name}`;
      const abs = join(queueDir, name);
      let raw = "";
      try {
        raw = readFileSync(abs, "utf-8");
      } catch (err) {
        warnings.push(`Could not read ${rel}: ${err.message}`);
        continue;
      }
      const upgraded = upgradeTaskContent(raw);
      if (upgraded) {
        migrated.push({
          type: "task",
          path: rel,
          changes: upgraded.changes,
          content: upgraded.content,
        });
      }
    }
  }

  if (migrated.length === 0 && warnings.length === 0) {
    return { ok: true, migrated: [], warnings: [], message: CANONICAL_MESSAGE };
  }

  return { ok: true, migrated, warnings };
}

/**
 * Apply a migration plan to disk (or return the plan when `dryRun` is set).
 *
 * @param {string} root
 * @param {{ dryRun?: boolean }} [options]
 * @returns {{
 *   ok: boolean,
 *   dryRun: boolean,
 *   migrated: Array<{ type: string, path: string, changes: string[] }>,
 *   warnings: string[],
 *   message?: string,
 * }}
 */
export function executeMigration(root, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const plan = planMigration(root, options);

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      migrated: plan.migrated.map(({ type, path, changes }) => ({ type, path, changes })),
      warnings: plan.warnings,
      ...(plan.message ? { message: plan.message } : {}),
    };
  }

  if (plan.migrated.length === 0) {
    return {
      ok: true,
      dryRun: false,
      migrated: [],
      warnings: plan.warnings,
      ...(plan.message || plan.warnings.length === 0
        ? { message: plan.message || CANONICAL_MESSAGE }
        : {}),
    };
  }

  const applied = [];
  for (const item of plan.migrated) {
    const abs = join(root, item.path);
    if (item.content !== undefined) {
      mkdirSync(dirname(abs), { recursive: true });
      safeAtomicWrite(abs, item.content);
    }
    if (Array.isArray(item.remove)) {
      for (const rel of item.remove) {
        const removeAbs = join(root, rel);
        if (existsSync(removeAbs)) rmSync(removeAbs, { force: true });
      }
    }
    applied.push({ type: item.type, path: item.path, changes: item.changes });
  }

  return {
    ok: true,
    dryRun: false,
    migrated: applied,
    warnings: plan.warnings,
  };
}
