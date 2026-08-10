import { readFileSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { execSync } from "node:child_process";

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

const DEFAULTS = {
  version: 1,
  provider: "jules",
  verify: {},
  scope: { deny: [], allow: [], protect: [] },
  limits: {
    diffKb: 75,
    promptKb: 50,
    dailyTasks: 300,
    repairAttempts: 3,
    concurrency: 1,
    staggerMs: 1500,
  },
  isolation: "none",
  runner: "local",
  branchPrefix: "agent/",
  baseBranch: "main",
};

export const BUILTIN_DENY = [
  ".git/**",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  ".agent/config.yml",
  ".agent/jules.yml",
  ".agent/jules-queue/**",
  ".github/**",
];

export const BUILTIN_PROTECT = [
  ".agent/rules/**",
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "Makefile",
];

const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function coerce(val) {
  if (!val) return "";
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  if (val === "true") return true;
  if (val === "false") return false;
  if (!isNaN(Number(val)) && val.trim() !== "") return Number(val);
  return val;
}

export function normalizePath(p) {
  if (!p || typeof p !== "string") return "";
  return p.split(sep).join("/").replace(/\\/g, "/");
}

export function resolveRoot(cwd = process.cwd()) {
  try {
    return execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (_) {
    return resolve(cwd);
  }
}

export function dedupe(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

/**
 * Single authoritative scope normalizer. Always merges BUILTIN_DENY and BUILTIN_PROTECT.
 * CRITICAL FIX FOR B1: User scope.deny will add to BUILTIN_DENY, never replace it.
 */
export function normalizeScope(parsed = {}) {
  const forbiddenPaths = Array.isArray(parsed.forbidden_paths)
    ? parsed.forbidden_paths
    : Array.isArray(parsed.scope?.deny)
    ? parsed.scope.deny
    : [];
  const allowPaths = Array.isArray(parsed.allow_paths)
    ? parsed.allow_paths
    : Array.isArray(parsed.scope?.allow)
    ? parsed.scope.allow
    : [];
  const protectPaths = Array.isArray(parsed.scope?.protect) ? parsed.scope.protect : [];

  return {
    deny: dedupe([...BUILTIN_DENY, ...forbiddenPaths]),
    allow: dedupe(allowPaths),
    protect: dedupe([...BUILTIN_PROTECT, ...protectPaths]),
  };
}

/**
 * Indent-stack zero-dependency YAML parser with prototype pollution protection.
 */
export function parseYaml(src) {
  if (!src || typeof src !== "string") return Object.create(null);
  const root = Object.create(null);
  const stack = [{ indent: -1, node: root }];
  const lines = src.split("\n");

  for (let rawLine of lines) {
    const commentIdx = rawLine.indexOf("#");
    const line = commentIdx !== -1 ? rawLine.slice(0, commentIdx) : rawLine;
    const trimmed = line.trim();
    if (!trimmed) continue;

    const indent = rawLine.length - rawLine.trimStart().length;

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const top = stack[stack.length - 1];

    if (trimmed.startsWith("- ")) {
      if (top.key && top.parent) {
        if (!Array.isArray(top.parent[top.key])) {
          top.parent[top.key] = [];
        }
        top.parent[top.key].push(coerce(trimmed.slice(2).trim()));
      } else if (Array.isArray(top.node)) {
        top.node.push(coerce(trimmed.slice(2).trim()));
      }
      continue;
    }

    const eqIdx = trimmed.indexOf(":");
    if (eqIdx > 0) {
      const rawKey = trimmed.slice(0, eqIdx).trim();
      const valStr = trimmed.slice(eqIdx + 1).trim();

      if (BLOCKED_KEYS.has(rawKey)) {
        throw new ConfigError(`Illegal prototype key "${rawKey}" detected in configuration`);
      }

      if (valStr === "") {
        const child = Object.create(null);
        top.node[rawKey] = child;
        stack.push({ indent, node: child, key: rawKey, parent: top.node });
      } else if (valStr.startsWith("[") && valStr.endsWith("]")) {
        const items = valStr
          .slice(1, -1)
          .split(",")
          .map((s) => coerce(s.trim()))
          .filter((s) => s !== "");
        top.node[rawKey] = items;
      } else {
        top.node[rawKey] = coerce(valStr);
      }
    }
  }

  return root;
}

export function detectPackageManager(root = process.cwd(), pkg = {}) {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "bun.lockb"))) return "bun";
  if (existsSync(join(root, "package-lock.json"))) return "npm";

  const pm = pkg.packageManager;
  if (typeof pm === "string") {
    if (pm.startsWith("pnpm")) return "pnpm";
    if (pm.startsWith("yarn")) return "yarn";
    if (pm.startsWith("bun")) return "bun";
    if (pm.startsWith("npm")) return "npm";
  }

  return "npm";
}

import { detectPolyglotStack, resolveWorkspaceBoundary, bootstrapZeroTestRepo } from "./stack-detector.mjs";

export { detectPolyglotStack, resolveWorkspaceBoundary, bootstrapZeroTestRepo };

/**
 * Autodetects verification test/build commands across 24+ polyglot tech stacks.
 */
export function detectStack(projectRoot = process.cwd()) {
  return detectPolyglotStack(projectRoot);
}

export function resolveVerify(root = process.cwd(), userVerify = {}) {
  const s = detectStack(root);
  return {
    setup: userVerify.setup ?? s.setupCmd ?? "",
    test: userVerify.test ?? s.testCmd ?? "",
    teardown: userVerify.teardown ?? s.teardownCmd ?? "",
    build: userVerify.build ?? s.buildCmd ?? "",
    server: userVerify.server ? {
      command: userVerify.server.command || "",
      url: userVerify.server.url || "http://localhost:3000",
      timeoutMs: Number(userVerify.server.timeoutMs || 15000),
    } : null,
  };
}

export const TIER_PRESETS = {
  free: {
    dailyTasks: 15,
    repairAttempts: 1,
    concurrency: 1,
    staggerMs: 3000,
    diffKb: 50,
  },
  pro: {
    dailyTasks: 100,
    repairAttempts: 2,
    concurrency: 2,
    staggerMs: 1500,
    diffKb: 75,
  },
  ultra: {
    dailyTasks: 300,
    repairAttempts: 3,
    concurrency: 3,
    staggerMs: 1000,
    diffKb: 75,
  },
};

/**
 * Loads and validates configuration from .agent/config.yml or .agent/jules.yml.
 */
export function loadConfig(root = resolveRoot(), explicitPath = null) {
  if (root === null || root === undefined) {
    root = resolveRoot();
  }
  const candidates = explicitPath
    ? [explicitPath]
    : [join(root, ".agent/config.yml"), join(root, ".agent/jules.yml")];

  const configFile = candidates.find(existsSync);
  let parsed = Object.create(null);
  if (configFile) {
    try {
      const raw = readFileSync(configFile, "utf-8");
      parsed = parseYaml(raw);
    } catch (err) {
      if (err instanceof ConfigError) throw err;
    }
  }

  const setupCmd = parsed.setup_cmd || parsed.verify?.setup || "";
  const testCmd = parsed.test_cmd || parsed.verify?.test || "";
  const teardownCmd = parsed.teardown_cmd || parsed.verify?.teardown || "";
  const buildCmd = parsed.build_cmd || parsed.verify?.build || "";
  const verifyTimeoutMs = parsed.verify?.timeoutMs ?? parsed.verify?.timeout_ms ?? 60000;
  const autoVerify = resolveVerify(root);

  const activeTier = String(process.env.JULES_TIER || parsed.tier || "ultra").toLowerCase();
  const tierLimits = TIER_PRESETS[activeTier] || TIER_PRESETS.ultra;

  const envDailyTasks = process.env.JULES_DAILY_BUDGET !== undefined ? Number(process.env.JULES_DAILY_BUDGET) : null;
  const envDiffKb = process.env.JULES_MAX_DIFF_KB !== undefined ? Number(process.env.JULES_MAX_DIFF_KB) : null;

  const parsedLimits = parsed.limits || {};
  const normalizedLimits = {
    diffKb: parsedLimits.diff_kb ?? parsedLimits.diffKb,
    promptKb: parsedLimits.prompt_kb ?? parsedLimits.promptKb,
    dailyTasks: parsedLimits.daily_tasks ?? parsedLimits.dailyTasks,
    repairAttempts: parsedLimits.repair_attempts ?? parsedLimits.repairAttempts,
    concurrency: parsedLimits.concurrency,
    staggerMs: parsedLimits.stagger_ms ?? parsedLimits.staggerMs,
  };
  for (const k of Object.keys(normalizedLimits)) {
    if (normalizedLimits[k] === undefined) delete normalizedLimits[k];
  }

  const config = {
    version: parsed.version || DEFAULTS.version,
    provider: parsed.provider || DEFAULTS.provider,
    tier: activeTier,
    verify: {
      setup: setupCmd || autoVerify.setup || "",
      test: testCmd || autoVerify.test,
      teardown: teardownCmd || autoVerify.teardown || "",
      build: buildCmd || autoVerify.build,
      timeoutMs: Number.isFinite(Number(verifyTimeoutMs)) ? Number(verifyTimeoutMs) : 60000,
    },
    scope: normalizeScope(parsed),
    limits: {
      ...DEFAULTS.limits,
      ...tierLimits,
      ...normalizedLimits,
      ...(envDailyTasks !== null && !isNaN(envDailyTasks) ? { dailyTasks: envDailyTasks } : {}),
      ...(envDiffKb !== null && !isNaN(envDiffKb) ? { diffKb: envDiffKb } : {}),
    },
    isolation: parsed.isolation || DEFAULTS.isolation,
    runner: parsed.runner || DEFAULTS.runner,
    branchPrefix: parsed.branch_prefix || parsed.branchPrefix || DEFAULTS.branchPrefix,
    baseBranch: parsed.base_branch || parsed.baseBranch || DEFAULTS.baseBranch,
    _root: root,
    _file: configFile || null,
  };

  return config;
}
