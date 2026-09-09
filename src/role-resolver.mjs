import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.mjs";

/**
 * Placeholders a role prompt may use in place of a hardcoded command.
 *
 * The shipped roles used to say `npm test`, `npm run lint` and "STRICTLY
 * FORBIDDEN from adding third-party npm packages … use only Node.js built-in
 * modules". Those are this kit's own contribution rules, and `.agent/prompts/`
 * is part of the published package — so a Rust project that ran `agentctl init`
 * got a Janitor that forbade crates and a Bolt that ran `npm test` in a repo
 * with no package.json. The stack detector already knows the right commands;
 * these tokens are how a prompt asks for them instead of guessing.
 *
 * An unknown token is left as written rather than replaced with an empty
 * string: a prompt reading "run  before and after" is worse than one that
 * visibly still contains a placeholder.
 */
export const ROLE_PROMPT_TOKENS = ["VERIFY_TEST", "VERIFY_LINT", "VERIFY_BUILD", "DIFF_KB", "BASE_BRANCH"];

/**
 * Legacy and convenience aliases for the standard engineering roles.
 *
 * Strictly one-directional: every key is a non-canonical name and every
 * value is a canonical role. Provides full backward-compatibility for prior
 * command flags (--role bolt, etc.) without letting a canonical role ever
 * resolve away from its own prompt file.
 */
export const ROLE_ALIASES = Object.freeze({
  // Legacy RPG/fantasy names mapped to canonical engineering roles
  overseer: "auditor",
  bolt: "performance",
  sentinel: "security",
  janitor: "hygiene",
  spectator: "e2e",
  scribe: "docs",
  alchemist: "database",
  bulwark: "resilience",
  typist: "types",
  hunter: "debugger",

  // Common operator shortcuts
  perf: "performance",
  sec: "security",
  db: "database",
  cleanup: "hygiene",
  accessibility: "a11y",
  documentation: "docs",
  visual: "e2e",
  playwright: "e2e",
  schema: "database",
  migration: "database",
  reliability: "resilience",
  typecheck: "types",
  "type-safety": "types",
  debug: "debugger",
  "defect-fix": "debugger",
  lead: "auditor",
  coordinator: "auditor",
  test: "testing",
  "unit-test": "testing",
  "integration-test": "testing",
  qa: "testing",
  tester: "testing",
});

export const CANONICAL_ROLES = Object.freeze([
  "auditor",
  "performance",
  "security",
  "hygiene",
  "a11y",
  "docs",
  "e2e",
  "database",
  "resilience",
  "types",
  "debugger",
  "testing",
]);

/**
 * Pre-consolidation prompt filenames, canonical role -> legacy file stem.
 *
 * Deliberately NOT part of ROLE_ALIASES: the alias table answers "what did
 * the operator mean", while this map answers "what might an older checkout
 * still have on disk". Keeping the two separate is what lets ROLE_ALIASES
 * stay strictly one-directional without stranding repos scaffolded before
 * the legacy duplicates were deleted.
 */
const LEGACY_PROMPT_FILENAMES = Object.freeze({
  auditor: "overseer",
  performance: "bolt",
  security: "sentinel",
  hygiene: "janitor",
  e2e: "spectator",
  docs: "scribe",
  database: "alchemist",
  resilience: "bulwark",
  types: "typist",
  debugger: "hunter",
});

/**
 * Substitutes `{{TOKEN}}` placeholders in a role prompt from resolved config.
 *
 * @param {string} content
 * @param {object} [config] - Loaded config (see loadConfig).
 * @returns {string}
 */
export function hydrateRolePrompt(content = "", config = {}) {
  const verify = config.verify || {};
  const values = {
    VERIFY_TEST: verify.test || "the project's test command",
    VERIFY_LINT: verify.lint || verify.test || "the project's lint command",
    VERIFY_BUILD: verify.build || "the project's build command",
    DIFF_KB: String(config.limits?.diffKb || 75),
    BASE_BRANCH: config.baseBranch || "main",
  };

  return content.replace(/\{\{\s*([A-Z_]+)\s*\}\}/g, (whole, token) =>
    Object.prototype.hasOwnProperty.call(values, token) ? values[token] : whole
  );
}

/**
 * Resolves specialist agent role markdown prompt from .agent/prompts/
 * @param {string} [root=process.cwd()]
 * @param {string} [roleName=""]
 * @param {object} [opts] - `{ config }` to avoid re-reading .agent/config.yml.
 * @returns {{ role: string, path: string, content: string } | null}
 */
export function resolveRolePrompt(root = process.cwd(), roleName = "", opts = {}) {
  if (!roleName || typeof roleName !== "string") return null;
  const cleanName = roleName.trim().toLowerCase();
  const directAlias = ROLE_ALIASES[cleanName];
  const canonical = directAlias && CANONICAL_ROLES.includes(directAlias)
    ? directAlias
    : (CANONICAL_ROLES.includes(cleanName) ? cleanName : null);

  const candidates = [];
  if (canonical) {
    candidates.push(canonical);
  }
  if (!candidates.includes(cleanName)) {
    candidates.push(cleanName);
  }
  // Secondary fallback: a checkout scaffolded before consolidation may still
  // hold only the legacy filename on disk (e.g. Bolt.md). The canonical file
  // always wins when both exist; this branch just keeps old trees working.
  if (canonical && LEGACY_PROMPT_FILENAMES[canonical] && !candidates.includes(LEGACY_PROMPT_FILENAMES[canonical])) {
    candidates.push(LEGACY_PROMPT_FILENAMES[canonical]);
  }
  // Include direct alias if not yet present
  if (directAlias && !candidates.includes(directAlias)) {
    candidates.push(directAlias);
  }

  const promptsDir = join(root, ".agent", "prompts");
  if (!existsSync(promptsDir)) return null;

  try {
    const files = readdirSync(promptsDir);
    let matched = null;
    for (const cand of candidates) {
      matched = files.find(
        (f) => f.toLowerCase() === `${cand}.md` || f.toLowerCase() === cand
      );
      if (matched) break;
    }
    if (matched) {
      const fullPath = join(promptsDir, matched);
      const raw = readFileSync(fullPath, "utf-8").trim();

      let config = opts.config;
      if (!config) {
        try {
          config = loadConfig(root);
        } catch (_) {
          config = {};
        }
      }

      return {
        role: matched.replace(/\.md$/i, ""),
        path: fullPath,
        content: hydrateRolePrompt(raw, config),
      };
    }
  } catch (_) {}
  return null;
}
