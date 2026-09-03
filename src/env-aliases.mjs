/**
 * Vendor-neutral spellings for every environment variable the kit reads.
 *
 * Every knob in this codebase is spelled `JULES_*`, which is accurate for the
 * provider it was written against and wrong for every other one: a repository
 * driving `claude-code` or `codex` still had to export `JULES_SWARM_CONCURRENCY`
 * to set worker slots, and `JULES_API_KEY` to set a key that never goes to
 * Jules. Renaming the variables outright would break every existing checkout
 * and CI job, so both spellings are supported and this table is the only place
 * that has to know they are the same knob.
 *
 * Direction is deliberate: `AGENT_*` is the name to document, `JULES_*` is the
 * name the code reads, and the alias fills the second from the first. A
 * `JULES_*` value already in the environment always wins, so adding an
 * `AGENT_*` export can never change the behaviour of a working setup.
 *
 * @type {Record<string, string>}
 */
export const ENV_ALIASES = {
  AGENT_API_KEY: "JULES_API_KEY",
  AGENT_API_KEYS: "JULES_API_KEYS",
  AGENT_API_KEY_SECONDARY: "JULES_API_KEY_SECONDARY",
  AGENT_API_URL: "JULES_API_URL",
  AGENT_REPO: "JULES_REPO",
  AGENT_PROJECT_ID: "JULES_PROJECT_ID",
  AGENT_PROJECT_ROOT: "JULES_PROJECT_ROOT",
  AGENT_TIER: "JULES_TIER",
  AGENT_DAILY_BUDGET: "JULES_DAILY_BUDGET",
  AGENT_MAX_DIFF_KB: "JULES_MAX_DIFF_KB",
  AGENT_DRY_RUN: "JULES_DRY_RUN",
  AGENT_REPOLESS: "JULES_REPOLESS",
  AGENT_SWARM_CONCURRENCY: "JULES_SWARM_CONCURRENCY",
  AGENT_SWARM_STAGGER_MS: "JULES_SWARM_STAGGER_MS",
  AGENT_PACE_MS: "JULES_PACE_MS",
  AGENT_SLOT_INDEX: "JULES_SLOT_INDEX",
  AGENT_SLOT_TOTAL: "JULES_SLOT_TOTAL",
  AGENT_USE_WORKTREES: "JULES_USE_WORKTREES",
  AGENT_ALLOW_COMMAND_FILE_CHANGES: "JULES_ALLOW_COMMAND_FILE_CHANGES",
  AGENT_ALLOW_AGENT_RULE_CHANGES: "JULES_ALLOW_AGENT_RULE_CHANGES",
};

/**
 * Fill the legacy `JULES_*` variables from their `AGENT_*` equivalents.
 *
 * Mutates the passed environment object in place — that is the point: every
 * downstream module reads `process.env` directly, and rewriting hundreds of
 * call sites to consult an alias table would be a far larger change with far
 * more places to get it wrong. Called once at process entry.
 *
 * An empty-string alias is treated as unset, matching how the rest of the kit
 * reads keys (`(process.env.X || "").trim()`), so `AGENT_API_KEY=` in a .env
 * file does not shadow a real `JULES_API_KEY`.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string[]} canonical names that were populated from an alias
 */
export function applyEnvAliases(env = process.env) {
  const applied = [];
  for (const [alias, canonical] of Object.entries(ENV_ALIASES)) {
    const aliasValue = env[alias];
    if (aliasValue === undefined || String(aliasValue).trim() === "") continue;
    const existing = env[canonical];
    if (existing !== undefined && String(existing).trim() !== "") continue;
    env[canonical] = aliasValue;
    applied.push(canonical);
  }
  return applied;
}

/**
 * Both spellings of one knob, for help text and diagnostics that should name
 * the vendor-neutral variable first.
 *
 * @param {string} canonical - a `JULES_*` name
 * @returns {{ canonical: string, alias: string|null }}
 */
export function describeEnvVar(canonical) {
  const alias = Object.entries(ENV_ALIASES).find(([, c]) => c === canonical)?.[0] || null;
  return { canonical, alias };
}
