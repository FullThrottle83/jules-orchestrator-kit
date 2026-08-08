import { normalizePath } from "./config.mjs";
import { matchesGlob } from "./security.mjs";

export const RISK_TIERS = {
  R0: "R0_COSMETIC",     // Docs, markdown, comments, safe devDep patches
  R1: "R1_ROUTINE",      // Pure utility logic, unit tests, single package layer
  R2: "R2_CONSEQUENTIAL",// UI components, DB helpers, diff > 400 lines, bundle size impact
  R3: "R3_RESTRICTED",   // Migrations, Auth, Pricing/VAT, Protected paths (.github, configs)
};

const RESTRICTED_PATH_PATTERNS = [
  "**/drizzle/migrations/**",
  "**/migrations/**",
  "**/auth/**",
  "**/pricing/**",
  "**/vat/**",
  "**/contracts/**",
  "**/ledger/**",
  ".github/**",
  ".githooks/**",
  "wrangler.jsonc",
  "pnpm-lock.yaml",
  "package-lock.json",
];

const CONSEQUENTIAL_PATH_PATTERNS = [
  "apps/web/src/components/**",
  "packages/db/**",
  "src/engine.mjs",
  "src/security.mjs",
];

const COSMETIC_EXTENSIONS = new Set([".md", ".txt", ".jsonl", ".svg"]);

/**
 * Classifies a set of changed files and diff metadata into a Risk Tier (R0, R1, R2, R3).
 *
 * @param {string[]} files - Array of changed file paths
 * @param {Object} [opts] - Options (diffBytes, diffLines, author)
 * @returns {{ tier: string, reason: string, isAutoMergeAllowed: boolean, requiresHumanReview: boolean }}
 */
export function classifyRiskTier(files = [], opts = {}) {
  const diffLines = opts.diffLines ?? 0;

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
    for (const pat of RESTRICTED_PATH_PATTERNS) {
      if (matchesGlob(file, pat) || file.endsWith(pat)) {
        return {
          tier: RISK_TIERS.R3,
          reason: `Matches restricted security/financial path pattern '${pat}'`,
          isAutoMergeAllowed: false,
          requiresHumanReview: true,
        };
      }
    }
  }

  // 2. Check R2 (Consequential Paths or Diff Size > 400 lines)
  if (diffLines >= 400) {
    return {
      tier: RISK_TIERS.R2,
      reason: `Diff size (${diffLines} lines) exceeds R1 limit of 400 lines`,
      isAutoMergeAllowed: false,
      requiresHumanReview: true,
    };
  }

  for (const rawFile of files) {
    const file = normalizePath(rawFile);
    for (const pat of CONSEQUENTIAL_PATH_PATTERNS) {
      if (matchesGlob(file, pat)) {
        return {
          tier: RISK_TIERS.R2,
          reason: `Matches consequential component/DB path pattern '${pat}'`,
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
