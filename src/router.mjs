import { existsSync, statSync } from "node:fs";
import { extname } from "node:path";
import { normalizePath } from "./config.mjs";
import { matchesGlob } from "./security.mjs";
import { extractPathTokens } from "./task-optimizer.mjs";
import { createProvider, createFailoverProvider, createSyntaxVerifiedProvider } from "./provider.mjs";

/**
 * Dynamic Complexity & Cost Router (Roadmap v0.33.0).
 *
 * Zero-dependency, rule-based heuristic classifier — no ML classifier, no
 * external routing service. Routes trivial tasks (typos, lockfile bumps,
 * lint fixes) to a cheap/fast provider while reserving the primary provider
 * for complex, multi-file, or safety-sensitive work. Opt-in via
 * `config.router.enabled` — disabled by default, zero behavior change for
 * existing users.
 */

export const ROUTE_TIERS = {
  FAST: "fast",
  COMPLEX: "complex",
};

export const DECLARATIVE_ASSET_EXTS = new Set([
  ".md",
  ".json",
  ".yml",
  ".yaml",
  ".css",
  ".svg",
  ".csv",
  ".txt",
  ".toml",
]);

export const MAX_FLASH_BYTES = 24000;
export const MAX_FLASH_FILES = 3;
export const MECHANICAL_PREFIXES = /^(chore|style|test|docs|ci|build)(\([^)]+\))?:\s*/i;

const TRIVIAL_SIGNALS = [
  /\btypo(s)?\b/i,
  /\brenam(e|ing|ed)\b/i,
  /\bbump(ed|ing)?\b/i,
  /\bversion bump\b/i,
  /\block ?file\b/i,
  /\bformat(ting)?\b/i,
  /\blint(ing)?\s*(fix(es)?|error)?\b/i,
  /\bwhitespace\b/i,
  /\b(update|fix)\s+comment(s)?\b/i,
  /\bdead code\b/i,
  /\bunused (import|variable)s?\b/i,
  /\breadme\b/i,
  /\btypo fix\b/i,
];

const COMPLEX_SIGNALS = [
  /\brefactor(ing)?\b/i,
  /\barchitect(ure)?\b/i,
  /\bmigrat(e|ion|ing)\b/i,
  /\bredesign\b/i,
  /\bconcurrency\b/i,
  /\brace condition\b/i,
  /\bsecurity\b/i,
  /\bauth(entication|orization)?\b/i,
  /\bschema\b/i,
  /\bbreaking change\b/i,
  /\bmulti-file\b/i,
  /\bcross-package\b/i,
  /\bdatabase\b/i,
  /\bpayment(s)?\b/i,
  /\bencrypt(ion)?\b/i,
];

// Sentinel handles security-sensitive work; the primary provider is always used.
const FORCE_COMPLEX_ROLES = new Set(["sentinel"]);
const FAST_LEANING_ROLES = new Set(["janitor", "bolt"]);
const COMPLEX_LEANING_ROLES = new Set(["overseer", "sentinel"]);

// Supplements config.scope.deny — these are never eligible for the fast tier
// regardless of user scope config, mirroring src/risk.mjs's RESTRICTED_PATH_PATTERNS.
const SENSITIVE_PATH_PATTERNS = [
  "**/auth/**",
  "**/migrations/**",
  "**/pricing/**",
  "**/secrets/**",
  "**/*.pem",
  "**/*.key",
  ".github/**",
  ".agent/config.yml",
  ".agent/jules.yml",
];

function collectReferencedPaths(task) {
  // extractPathTokens only recognises "/" as a separator, but a Windows author
  // naturally writes "src\auth\session.mjs" in a prompt. Without this the
  // sensitive-path guard below never sees the path and the task can be routed
  // to the cheap tier. targetFiles are separately normalised by normalizePath.
  const promptText = String(task.prompt || "").replace(/\\/g, "/");
  const fromPrompt = extractPathTokens(promptText);
  const explicit = Array.isArray(task.targetFiles)
    ? task.targetFiles
    : Array.isArray(task.referenced_paths)
      ? task.referenced_paths
      : [];
  return [...new Set([...fromPrompt, ...explicit])];
}

function touchesSensitivePath(paths, config) {
  const denyPatterns = [...SENSITIVE_PATH_PATTERNS, ...((config && config.scope && config.scope.deny) || [])];
  for (const rawPath of paths) {
    const p = normalizePath(rawPath);
    for (const pattern of denyPatterns) {
      if (matchesGlob(p, pattern)) return { path: p, pattern };
    }
  }
  return null;
}

/**
 * Heuristically classifies a task envelope into a FAST or COMPLEX routing tier.
 * @param {object} task - Task envelope (title, prompt, role, targetFiles, tier).
 * @param {object} config - Loaded orchestrator config (uses scope.deny, router.threshold).
 * @returns {{tier: string, score: number|null, forced: boolean, reason: string, signals?: string[]}}
 */
export function classifyTaskComplexity(task = {}, config = {}) {
  const explicitTier = task.tier || task.complexity;
  if (explicitTier === ROUTE_TIERS.FAST || explicitTier === ROUTE_TIERS.COMPLEX) {
    return { tier: explicitTier, score: null, forced: true, reason: `Explicit task tier override: '${explicitTier}'` };
  }

  const paths = collectReferencedPaths(task);
  const role = String(task.role || "").toLowerCase();

  if (FORCE_COMPLEX_ROLES.has(role)) {
    return { tier: ROUTE_TIERS.COMPLEX, score: null, forced: true, reason: `Role '${role}' always routes to the primary provider` };
  }

  // 1. Declarative Asset Override: 100% declarative non-executable files bypass sensitive-path penalty
  const isAllDeclarative = paths.length > 0 && paths.every((p) => DECLARATIVE_ASSET_EXTS.has(extname(p).toLowerCase()));
  const sensitiveHit = touchesSensitivePath(paths, config);

  if (sensitiveHit && !isAllDeclarative) {
    return {
      tier: ROUTE_TIERS.COMPLEX,
      score: null,
      forced: true,
      reason: `Touches sensitive path '${sensitiveHit.path}' (matches '${sensitiveHit.pattern}')`,
    };
  }

  // 2. Context Saturation Guard: Measure target file sizes to prevent Flash truncation
  let totalBytes = 0;
  for (const file of paths) {
    if (existsSync(file)) {
      try {
        totalBytes += statSync(file).size;
      } catch (_) {}
    }
  }
  if (totalBytes > MAX_FLASH_BYTES) {
    return {
      tier: ROUTE_TIERS.COMPLEX,
      score: null,
      forced: true,
      reason: `Referenced files payload (${totalBytes} bytes) exceeds Flash context ceiling (${MAX_FLASH_BYTES} bytes)`,
    };
  }

  if (isAllDeclarative && paths.length <= MAX_FLASH_FILES) {
    return {
      tier: ROUTE_TIERS.FAST,
      score: -3,
      forced: false,
      reason: "Declarative asset override: all targeted files are non-executable formats",
      signals: ["-3 100% declarative asset files"],
    };
  }

  const text = `${task.title || ""} ${task.prompt || ""}`;
  let score = 0;
  const signals = [];

  // 3. Mechanical Intent Fast-Tracking
  if (task.title && MECHANICAL_PREFIXES.test(task.title)) {
    score -= 2;
    signals.push(`-2 mechanical commit prefix (${task.title.split(":")[0]})`);
  }

  for (const pattern of COMPLEX_SIGNALS) {
    if (pattern.test(text)) {
      score += 2;
      signals.push(`+2 complex keyword (${pattern.source})`);
    }
  }
  for (const pattern of TRIVIAL_SIGNALS) {
    if (pattern.test(text)) {
      score -= 1;
      signals.push(`-1 trivial keyword (${pattern.source})`);
    }
  }

  if (paths.length >= 4) {
    score += 3;
    signals.push(`+3 touches ${paths.length} files`);
  } else if (paths.length > 0 && paths.length <= 1) {
    score -= 1;
    signals.push(`-1 touches a single file`);
  }

  const promptLen = (task.prompt || "").length;
  if (promptLen > 1200) {
    score += 1;
    signals.push(`+1 long prompt (${promptLen} chars)`);
  } else if (promptLen > 0 && promptLen < 200) {
    score -= 1;
    signals.push(`-1 short prompt (${promptLen} chars)`);
  }

  if (COMPLEX_LEANING_ROLES.has(role)) {
    score += 1;
    signals.push(`+1 role '${role}' leans complex`);
  }
  if (FAST_LEANING_ROLES.has(role)) {
    score -= 2;
    signals.push(`-2 role '${role}' leans fast`);
  }

  const threshold = Number.isFinite(config?.router?.threshold) ? config.router.threshold : 0;
  const tier = score > threshold ? ROUTE_TIERS.COMPLEX : ROUTE_TIERS.FAST;

  return { tier, score, forced: false, threshold, signals, reason: `Heuristic score ${score} vs threshold ${threshold}` };
}

/**
 * Resolves the provider adapter to dispatch a task through, honoring
 * `config.router` (opt-in Dynamic Complexity & Cost Router). Disabled by
 * default — returns the primary provider unchanged. FAST-tier tasks are
 * wrapped in a failover cascade so a rate-limited/unavailable fast provider
 * falls through to the primary provider automatically.
 * @param {object} task
 * @param {object} config
 * @returns {{provider: object, routed: boolean, classification: object|null}}
 */
export function resolveRoutedProvider(task = {}, config = {}) {
  const routerCfg = config.router || {};
  const complexSpec = routerCfg.complex || config.provider || "jules";

  if (!routerCfg.enabled) {
    return { provider: createProvider(config.provider, config), routed: false, classification: null };
  }

  const classification = classifyTaskComplexity(task, config);

  if (classification.tier === ROUTE_TIERS.COMPLEX) {
    return { provider: createProvider(complexSpec, config), routed: true, classification };
  }

  const fastSpec = routerCfg.fast || "gemini-flash";
  const complexProvider = createProvider(complexSpec, config);
  const verifiedFastProvider = createSyntaxVerifiedProvider(createProvider(fastSpec, config), complexProvider, config);
  const provider = createFailoverProvider([verifiedFastProvider, complexProvider], config);
  return { provider, routed: true, classification };
}
