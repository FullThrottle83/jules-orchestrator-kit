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
  ".agent/SYSTEM_LEARNINGS.md",
  ".agent/knowledge/**",
  "package.json",
  "**/package.json",
  "Cargo.toml",
  "**/Cargo.toml",
  "pyproject.toml",
  "**/pyproject.toml",
  "go.mod",
  "**/go.mod",
  "composer.json",
  "**/composer.json",
  "Makefile",
  "**/Makefile",
  "**/.npmrc",
  "**/.netrc",
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

/**
 * Reduces a repo-relative path to a canonical form for pattern matching:
 * separators normalised, duplicate slashes collapsed, `.` segments dropped,
 * `..` segments resolved, and any leading `./` or trailing `/` removed.
 *
 * Purely lexical — it never touches the filesystem, because the paths being
 * matched may not exist locally (they can come from a diff or a task envelope).
 * Leading `..` segments that would escape the repo root are preserved so the
 * caller can still recognise and reject them.
 *
 * @param {string} p
 * @returns {string}
 */
export function canonicalizePath(p) {
  const normalized = normalizePath(p).replace(/\/+/g, "/");
  if (!normalized) return "";

  const isAbsolutePosix = normalized.startsWith("/");
  const out = [];
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!isAbsolutePosix) {
        out.push("..");
      }
      continue;
    }
    out.push(segment);
  }

  return (isAbsolutePosix ? "/" : "") + out.join("/");
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

import {
  detectPolyglotStack,
  resolveWorkspaceBoundary,
  bootstrapZeroTestRepo,
  findSubprojectRoot,
  detectCrossPackageBoundaryViolations,
  detectCircularDependencies,
} from "./stack-detector.mjs";

export {
  detectPolyglotStack,
  resolveWorkspaceBoundary,
  bootstrapZeroTestRepo,
  findSubprojectRoot,
  detectCrossPackageBoundaryViolations,
  detectCircularDependencies,
};

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
    lint: userVerify.lint ?? s.fmtCmd ?? "",
    test: userVerify.test ?? s.testCmd ?? "",
    unit: userVerify.unit ?? userVerify.test ?? s.testCmd ?? "",
    fuzz: userVerify.fuzz ?? s.fuzzCmd ?? "",
    invariant: userVerify.invariant ?? s.invariantCmd ?? "",
    e2e: userVerify.e2e ?? s.e2eCmd ?? "",
    teardown: userVerify.teardown ?? s.teardownCmd ?? "",
    build: userVerify.build ?? s.buildCmd ?? "",
    policy: {
      networkAccess: userVerify.policy?.networkAccess || (s.stack === "foundry" ? "forbidden" : "allow"),
      offline: userVerify.policy?.offline ?? (s.stack === "foundry"),
    },
    stages: Array.isArray(userVerify.stages) ? userVerify.stages : null,
    server: userVerify.server ? {
      command: userVerify.server.command || "",
      url: userVerify.server.url || "http://localhost:3000",
      timeoutMs: Number(userVerify.server.timeoutMs || 15000),
    } : null,
  };
}

/**
 * The single source of truth for tier defaults. `src/wizard-init.mjs` projects
 * this into snake_case rather than keeping a second table: the two tables
 * previously disagreed (wizard wrote free=30 while the runtime assumed 15), so
 * a freshly initialised repo was budgeted against numbers no other code used.
 *
 * `dailyTasks` here is a *hint*, not a fact. Provider quotas are set by the
 * vendor and change without notice, so these numbers are only ever a starting
 * guess — see `isTierGuess()` and the learned-ceiling logic in src/state.mjs.
 * An explicit `limits.daily_tasks` in .agent/config.yml always wins.
 */
/**
 * Per-tier defaults, with the vendor's own ceiling recorded alongside them.
 *
 * `maxConcurrency` is what the plan allows; `concurrency` is what the kit will
 * start by using. They differ on purpose, for the same reason the daily count
 * is a lower bound: this ledger sees one checkout, while the account's slots
 * are also taken by the web UI, the CLI and other machines. A default sitting
 * on the ceiling would collide with every session the kit cannot see.
 *
 * The defaults used to sit at 1/2/3 against ceilings of 3/15/60 — a Pro
 * account running two workers where it could run fifteen. Raising them is the
 * single largest throughput change available; leaving headroom is what keeps
 * it from being reckless. An operator who knows their account is theirs alone
 * can state `limits.concurrency` up to the ceiling.
 *
 * Ceilings verified against the vendor's published limits page
 * (jules.google/docs/usage-limits, 2026-08-20). They are a vendor number and
 * may change without notice. The URL is written without a scheme on purpose:
 * test/egress-allowlist.test.mjs treats every host literal in shipped source
 * as a destination this kit might contact, and a citation is not one.
 */
export const TIER_PRESETS = {
  free: {
    dailyTasks: 15,
    repairAttempts: 1,
    // The whole allowance is 15 tasks a day; there is no headroom worth
    // reserving, so the default is the ceiling.
    concurrency: 3,
    maxConcurrency: 3,
    staggerMs: 3000,
    diffKb: 50,
  },
  pro: {
    dailyTasks: 100,
    repairAttempts: 2,
    concurrency: 8,
    maxConcurrency: 15,
    staggerMs: 1500,
    diffKb: 75,
  },
  ultra: {
    dailyTasks: 300,
    repairAttempts: 3,
    concurrency: 15,
    maxConcurrency: 60,
    staggerMs: 1000,
    diffKb: 75,
  },
  // Not a vendor plan: a self-hosted/pooled profile for operators who front
  // several accounts. Defined here so `tier: enterprise` resolves to what the
  // wizard writes instead of silently collapsing onto the ultra preset. Its
  // ceiling is whatever the pool adds up to, so the kit does not claim one.
  enterprise: {
    dailyTasks: 1000,
    repairAttempts: 3,
    concurrency: 10,
    maxConcurrency: 0,
    staggerMs: 500,
    diffKb: 100,
  },
};

/** Tier names that correspond to real vendor plans, in ascending order. */
export const VENDOR_TIERS = ["free", "pro", "ultra"];

/** The tier used when a config names one that does not exist. */
export const FALLBACK_TIER = "ultra";

/**
 * Escalation reasons that bypass the Silence Governor and alert immediately.
 *
 * Kept here rather than in webhook.mjs because `loadConfig` needs it as the
 * default for `notifications.critical_reasons`, and webhook.mjs already imports
 * from this module — the reverse direction would be a cycle. Two hand-copied
 * lists were how v0.35.0 ended up with a governor that governed nothing.
 *
 * See webhook.mjs for why the list is this short.
 */
export const DEFAULT_CRITICAL_REASONS = ["R3_GATE_VIOLATION", "SECRET_LEAK_DETECTED", "CRITICAL_FAILURE"];

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

  const rawSetup = parsed.setup_cmd ?? parsed.verify?.setup;
  const rawTest = parsed.test_cmd ?? parsed.verify?.test;
  const rawLint = parsed.lint_cmd ?? parsed.verify?.lint;
  const rawFuzz = parsed.fuzz_cmd ?? parsed.verify?.fuzz;
  const rawInvariant = parsed.invariant_cmd ?? parsed.verify?.invariant;
  const rawE2e = parsed.e2e_cmd ?? parsed.verify?.e2e;
  const rawTeardown = parsed.teardown_cmd ?? parsed.verify?.teardown;
  const rawBuild = parsed.build_cmd ?? parsed.verify?.build;
  const rawUnit = parsed.verify?.unit;
  const verifyTimeoutMs = parsed.verify?.timeoutMs ?? parsed.verify?.timeout_ms ?? 60000;
  const autoVerify = resolveVerify(root);

  const rawTier = String(process.env.JULES_TIER || parsed.tier || "ultra").toLowerCase();
  const activeTier = TIER_PRESETS[rawTier] ? rawTier : "ultra";
  const tierLimits = TIER_PRESETS[activeTier];

  const envDailyTasks = process.env.JULES_DAILY_BUDGET !== undefined && Number.isFinite(Number(process.env.JULES_DAILY_BUDGET)) ? Number(process.env.JULES_DAILY_BUDGET) : null;
  const envDiffKb = process.env.JULES_MAX_DIFF_KB !== undefined && Number.isFinite(Number(process.env.JULES_MAX_DIFF_KB)) ? Number(process.env.JULES_MAX_DIFF_KB) : null;

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
      setup: rawSetup ?? autoVerify.setup ?? "",
      lint: rawLint ?? autoVerify.lint ?? "",
      test: rawTest ?? autoVerify.test,
      unit: rawUnit ?? rawTest ?? autoVerify.unit ?? autoVerify.test,
      fuzz: rawFuzz ?? autoVerify.fuzz ?? "",
      invariant: rawInvariant ?? autoVerify.invariant ?? "",
      e2e: rawE2e ?? autoVerify.e2e ?? "",
      teardown: rawTeardown ?? autoVerify.teardown ?? "",
      build: rawBuild ?? autoVerify.build,
      stages: parsed.verify?.stages ?? autoVerify.stages ?? null,
      policy: parsed.verify?.policy ?? autoVerify.policy,
      timeoutMs: Number.isFinite(Number(verifyTimeoutMs)) ? Number(verifyTimeoutMs) : 60000,
    },
    evidence: {
      enabled: parsed.evidence?.enabled ?? true,
      strictTestLock: parsed.evidence?.strict_test_lock ?? parsed.evidence?.strictTestLock ?? true,
    },
    router: {
      enabled: parsed.router?.enabled ?? false,
      fast: parsed.router?.fast || "gemini-flash",
      complex: parsed.router?.complex || "",
      threshold: Number.isFinite(Number(parsed.router?.threshold)) ? Number(parsed.router.threshold) : 0,
    },
    notifications: {
      mode: parsed.notifications?.mode || "immediate",
      threshold: Number.isFinite(Number(parsed.notifications?.threshold)) ? Number(parsed.notifications.threshold) : 5,
      windowMs: Number.isFinite(Number(parsed.notifications?.window_ms ?? parsed.notifications?.windowMs))
        ? Number(parsed.notifications.window_ms ?? parsed.notifications.windowMs)
        : 300000,
      budgetPerHour: Number.isFinite(Number(parsed.notifications?.budget_per_hour ?? parsed.notifications?.budgetPerHour))
        ? Number(parsed.notifications.budget_per_hour ?? parsed.notifications.budgetPerHour)
        : 3,
      criticalReasons: Array.isArray(parsed.notifications?.critical_reasons)
        ? parsed.notifications.critical_reasons
        : [...DEFAULT_CRITICAL_REASONS],
      slackWebhookUrl: parsed.notifications?.slack_webhook_url || parsed.notifications?.slackWebhookUrl || "",
      discordWebhookUrl: parsed.notifications?.discord_webhook_url || parsed.notifications?.discordWebhookUrl || "",
    },
    scope: normalizeScope(parsed),
    limits: {
      ...DEFAULTS.limits,
      ...tierLimits,
      ...normalizedLimits,
      ...(envDailyTasks !== null && !isNaN(envDailyTasks) ? { dailyTasks: envDailyTasks } : {}),
      ...(envDiffKb !== null && !isNaN(envDiffKb) ? { diffKb: envDiffKb } : {}),
    },
    // Where each contested limit actually came from. The merge above flattens
    // config, env and tier into one number, after which no caller can tell a
    // figure the operator stated from one the kit guessed — and the budget gate
    // must not hard-block on a guess. See resolveDailyLimit() in src/budget.mjs.
    provenance: {
      dailyTasks:
        envDailyTasks !== null && !isNaN(envDailyTasks)
          ? "env"
          : normalizedLimits.dailyTasks !== undefined
            ? "config"
            : "tier",
      concurrency: normalizedLimits.concurrency !== undefined ? "config" : "tier",
    },
    isolation: parsed.isolation || DEFAULTS.isolation,
    runner: parsed.runner || DEFAULTS.runner,
    branchPrefix: parsed.branch_prefix || parsed.branchPrefix || DEFAULTS.branchPrefix,
    baseBranch: parsed.base_branch || parsed.baseBranch || DEFAULTS.baseBranch,
    julesApiKeys: Array.from(new Set([
      (process.env.JULES_API_KEY || "").trim(),
      ...(process.env.JULES_API_KEYS || process.env.JULES_API_KEY_SECONDARY || "").split(",").map((k) => k.trim()),
      ...(Array.isArray(parsed.jules_api_keys) ? parsed.jules_api_keys : []),
      ...(Array.isArray(parsed.julesApiKeys) ? parsed.julesApiKeys : []),
    ].filter(Boolean))),
    _root: root,
    _file: configFile || null,
  };

  return config;
}
