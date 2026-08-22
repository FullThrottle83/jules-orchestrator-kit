import { normalizePath } from "./config.mjs";
import { matchesGlob } from "./security.mjs";

export const RISK_TIERS = {
  R0: "R0_COSMETIC",     // Docs, markdown, comments, safe devDep patches
  R1: "R1_ROUTINE",      // Pure utility logic, unit tests, single package layer
  R2: "R2_CONSEQUENTIAL",// UI components, DB helpers, diff > 400 lines, bundle size impact
  R3: "R3_RESTRICTED",   // Migrations, Auth, Protected paths (.github, secrets, lockfiles)
};

/**
 * Paths that are dangerous to change in any repository, in any language.
 *
 * The bar for membership is deliberately narrow: a pattern belongs here only if
 * an unreviewed change to it is hazardous regardless of what the project does.
 * CI definitions execute with repository credentials, lockfiles decide which
 * code is actually installed, migrations are one-way, and key material is key
 * material — none of that depends on the domain.
 *
 * Domain risk does not generalise and is not guessed at here. A billing path,
 * a tax-rate table, a pricing engine or a smart-contract directory is R3 in the
 * project that owns it and noise everywhere else, so those belong in
 * `risk.restricted` in `.agent/config.yml`. Earlier versions shipped one
 * project's domain paths (VAT and pricing directories) plus this kit's own
 * source files to every user, which meant everyone else's genuinely sensitive
 * directories fell through to R1 — auto-merge eligible.
 */
export const BUILTIN_RESTRICTED = [
  // Pipelines and hooks: execute with repository credentials.
  ".github/**",
  ".githooks/**",
  ".gitlab-ci.yml",
  ".circleci/**",
  "Jenkinsfile",
  "azure-pipelines.yml",
  // The agent's own rules of engagement.
  ".agent/rules/**",
  ".agent/config.yml",
  ".agent/jules.yml",
  ".agent/protected-paths.json",
  // Credentials and key material.
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/id_rsa*",
  "**/.npmrc",
  "**/.netrc",
  // One-way schema changes, whichever tool produced them.
  "**/migrations/**",
  "**/migrate/**",
  // Lockfiles decide which code actually runs, across every ecosystem.
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
  "Pipfile.lock",
  "gradle.lockfile",
  // Infrastructure as code: applies to live infrastructure.
  "**/*.tf",
  "**/*.tfvars",
  // Authentication and authorization logic.
  "**/auth/**",
  "**/authentication/**",
  "**/authorization/**",
];

/**
 * Paths that warrant a human read but are not restricted.
 *
 * Kept to shapes that recur across ecosystems — a component tree, a data
 * access layer, a schema definition — rather than one repository's directory
 * names. Project-specific additions go in `risk.consequential`.
 */
export const BUILTIN_CONSEQUENTIAL = [
  "**/components/**",
  "**/db/**",
  "**/database/**",
  "**/models/**",
  "**/schema/**",
  "**/schemas/**",
];

const COSMETIC_EXTENSIONS = new Set([".md", ".txt", ".jsonl", ".svg"]);

/** Diff size at which a change stops being routine regardless of where it lands. */
export const DEFAULT_R2_DIFF_LINES = 400;

/**
 * Resolves the effective pattern lists for a repository.
 *
 * Project patterns extend the builtins rather than replacing them, mirroring
 * how `normalizeScope` treats `scope.deny` — a config that narrows the risk
 * model by accident is the failure this ordering prevents.
 *
 * @param {object} [config] - A loaded config (see loadConfig) or `{ risk: {...} }`.
 * @returns {{ restricted: string[], consequential: string[], diffLines: number }}
 */
export function resolveRiskPatterns(config = {}) {
  const risk = config.risk || {};
  const asList = (v) => (Array.isArray(v) ? v.filter((p) => typeof p === "string" && p.trim()) : []);

  return {
    restricted: [...BUILTIN_RESTRICTED, ...asList(risk.restricted)],
    consequential: [...BUILTIN_CONSEQUENTIAL, ...asList(risk.consequential)],
    diffLines: Number.isFinite(Number(risk.maxRoutineDiffLines))
      ? Number(risk.maxRoutineDiffLines)
      : DEFAULT_R2_DIFF_LINES,
  };
}

/**
 * True when `file` matches `pattern` as a glob or as a basename-anchored path.
 *
 * The basename form is what makes a bare `Cargo.lock` also cover
 * `crates/api/Cargo.lock`. It is anchored on a separator on purpose: a plain
 * `endsWith` (which this used to be) also matched `vendor-Cargo.lock`.
 *
 * Case is folded to match `checkScope`, which folds it for deny and protect
 * because `.GitHub/` and `.github/` are the same directory on APFS and NTFS.
 * The two surfaces disagreeing meant a change could be blocked by the gate and
 * still classified R1 by the harvester on macOS and Windows.
 */
function matchesRiskPattern(file, pattern) {
  if (matchesGlob(file, pattern, { caseInsensitive: true })) return true;
  if (pattern.includes("*") || pattern.includes("/")) return false;
  const lowerFile = file.toLowerCase();
  const lowerPat = pattern.toLowerCase();
  return lowerFile === lowerPat || lowerFile.endsWith(`/${lowerPat}`);
}

/**
 * Classifies a set of changed files and diff metadata into a Risk Tier (R0, R1, R2, R3).
 *
 * @param {string[]} files - Array of changed file paths
 * @param {Object} [opts] - Options (diffLines, config, restricted, consequential)
 * @returns {{ tier: string, reason: string, isAutoMergeAllowed: boolean, requiresHumanReview: boolean }}
 */
export function classifyRiskTier(files = [], opts = {}) {
  const diffLines = opts.diffLines ?? 0;
  const resolved = resolveRiskPatterns(opts.config || {});
  const restricted = [...resolved.restricted, ...(Array.isArray(opts.restricted) ? opts.restricted : [])];
  const consequential = [...resolved.consequential, ...(Array.isArray(opts.consequential) ? opts.consequential : [])];
  const routineLimit = opts.maxRoutineDiffLines ?? resolved.diffLines;

  if (!files || files.length === 0) {
    return {
      tier: RISK_TIERS.R0,
      reason: "No files changed",
      isAutoMergeAllowed: true,
      requiresHumanReview: false,
    };
  }

  // 1. Check R3 (Restricted Paths)
  for (const rawFile of files) {
    const file = normalizePath(rawFile);
    for (const pat of restricted) {
      if (matchesRiskPattern(file, pat)) {
        return {
          tier: RISK_TIERS.R3,
          reason: `Matches restricted path pattern '${pat}'`,
          isAutoMergeAllowed: false,
          requiresHumanReview: true,
        };
      }
    }
  }

  // 2. Check R2 (Consequential Paths or oversized diff)
  if (diffLines >= routineLimit) {
    return {
      tier: RISK_TIERS.R2,
      reason: `Diff size (${diffLines} lines) exceeds R1 limit of ${routineLimit} lines`,
      isAutoMergeAllowed: false,
      requiresHumanReview: true,
    };
  }

  for (const rawFile of files) {
    const file = normalizePath(rawFile);
    for (const pat of consequential) {
      if (matchesRiskPattern(file, pat)) {
        return {
          tier: RISK_TIERS.R2,
          reason: `Matches consequential path pattern '${pat}'`,
          isAutoMergeAllowed: false,
          requiresHumanReview: true,
        };
      }
    }
  }

  // 3. Check R0 (Purely Cosmetic files)
  const isAllCosmetic = files.every((rawFile) => {
    const file = normalizePath(rawFile);
    if (file.startsWith(".agent/history/") || file.startsWith("docs/")) return true;
    const dotIdx = file.lastIndexOf(".");
    if (dotIdx !== -1) {
      const ext = file.slice(dotIdx).toLowerCase();
      return COSMETIC_EXTENSIONS.has(ext);
    }
    return false;
  });

  if (isAllCosmetic) {
    return {
      tier: RISK_TIERS.R0,
      reason: "All changed files are markdown, documentation, or cosmetic assets",
      isAutoMergeAllowed: true,
      requiresHumanReview: false,
    };
  }

  // 4. Default R1 (Routine Logic)
  return {
    tier: RISK_TIERS.R1,
    reason: "Routine isolated package logic / unit test update within limits",
    isAutoMergeAllowed: true,
    requiresHumanReview: false,
  };
}
