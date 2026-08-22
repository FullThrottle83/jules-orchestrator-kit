import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Paths the kit writes at runtime and must never hand to its own gate.
 *
 * Without these, `agentctl init` left every ledger, evidence manifest and
 * telemetry line untracked in the working tree. The gate audits that tree, so
 * the kit's own bookkeeping showed up as a diff the agent was accused of
 * making: first as scope violations against `.agent/config.yml`, then — once
 * enough evidence files accumulated — as a CRITICAL secret verdict. A new user
 * met both before dispatching a single task.
 */
export const RUNTIME_GITIGNORE_ENTRIES = [
  ".env",
  ".agent/history/",
  ".agent/state/",
  ".agent/evidence/",
  ".agent/handovers/",
  ".agent/jules-queue/.state/",
  ".agent/jules-queue/failed/",
  ".agent/jules-queue/.processing/",
  ".agent/jules-queue/completed/",
  // A queued envelope is work-in-flight, not source. `.agent/jules-queue/**` is
  // on the gate's deny list, so tracking the envelopes means the first gate
  // after `task create` rejects the tree for the file `task create` just wrote.
  // The negation has to follow the pattern it re-includes.
  ".agent/jules-queue/*.md",
  "!.agent/jules-queue/README.md",
];

/**
 * Ensure `.gitignore` lists every runtime path in {@link RUNTIME_GITIGNORE_ENTRIES}.
 *
 * @param {string} root
 * @returns {string[]} Entries newly appended (empty when already covered).
 */
export function ensureGitignore(root) {
  const gitignorePath = join(root, ".gitignore");
  const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
  const lines = new Set(current.split("\n").map((l) => l.trim()));
  const missing = RUNTIME_GITIGNORE_ENTRIES.filter((e) => !lines.has(e));
  if (missing.length === 0) return [];

  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  appendFileSync(
    gitignorePath,
    `${prefix}\n# Jules Orchestrator runtime state & credentials\n${missing.join("\n")}\n`,
    "utf-8"
  );
  return missing;
}

/**
 * Copy every file from a directory shipped in the package into the target repo.
 *
 * @param {string} srcDir
 * @param {string} destDir
 * @param {boolean} force
 * @returns {number} Files written.
 */
function copyDir(srcDir, destDir, force) {
  if (!existsSync(srcDir) || srcDir === destDir) return 0;
  mkdirSync(destDir, { recursive: true });
  let written = 0;
  for (const file of readdirSync(srcDir)) {
    const src = join(srcDir, file);
    const dest = join(destDir, file);
    if (!existsSync(dest) || force) {
      copyFileSync(src, dest);
      written++;
    }
  }
  return written;
}

/**
 * Scaffold the repository assets the CLI's documented features depend on.
 *
 * This is the single source of truth for both entry points. `agentctl init`
 * and `jules-init` used to scaffold different things: only the latter wrote
 * AGENTS.md, the role prompts and the guardrails, while the README's quickstart
 * pointed at the former. Anyone following the quickstart got a Jules that never
 * saw the protocol and a `--role` flag with nothing to resolve against.
 *
 * Existing files are preserved unless `force` is set — re-running init is a
 * routine way to pick up new presets and must not overwrite local edits.
 *
 * @param {string} [root=process.cwd()]
 * @param {{ force?: boolean }} [options]
 * @returns {{ created: string[], gitignore: string[] }}
 */
export function scaffoldRepoAssets(root = process.cwd(), options = {}) {
  const force = Boolean(options.force);
  const created = [];

  const agentDir = join(root, ".agent");
  const queueDir = join(agentDir, "jules-queue");
  for (const d of [agentDir, queueDir, join(queueDir, "completed"), join(agentDir, "rules"), join(agentDir, "prompts"), join(agentDir, "workflows")]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }

  // AGENTS.md is how the agent learns the protocol at all, so an existing file
  // is appended to rather than replaced: repositories that already brief their
  // agents must not lose that briefing to a scaffolding step.
  const agentsFile = join(root, "AGENTS.md");
  const template = join(KIT_ROOT, "JULES_RULES_TEMPLATE.md");
  if (existsSync(template) && template !== agentsFile) {
    if (!existsSync(agentsFile) || force) {
      copyFileSync(template, agentsFile);
      created.push("AGENTS.md");
    } else if (!readFileSync(agentsFile, "utf-8").includes("<MCP_DIRECTIVE>")) {
      appendFileSync(agentsFile, `\n\n---\n\n${readFileSync(template, "utf-8")}`, "utf-8");
      created.push("AGENTS.md (appended)");
    }
  }

  if (copyDir(join(KIT_ROOT, ".agent/prompts"), join(agentDir, "prompts"), force) > 0) {
    created.push(".agent/prompts/ (Overseer, Bolt, Sentinel, Janitor)");
  }
  if (copyDir(join(KIT_ROOT, ".agent/rules"), join(agentDir, "rules"), force) > 0) {
    created.push(".agent/rules/");
  }
  if (copyDir(join(KIT_ROOT, ".agent/workflows"), join(agentDir, "workflows"), force) > 0) {
    created.push(".agent/workflows/");
  }

  // isTaskFile() skips README.md, so the queue can carry its own explanation
  // without the runner mistaking it for a task envelope.
  const queueReadme = join(queueDir, "README.md");
  if (!existsSync(queueReadme)) {
    writeFileSync(
      queueReadme,
      "# Task Queue\n\nEach `TASK-*.md` here is one queued task envelope.\n\n" +
        "- `agentctl task create` writes them\n- `agentctl queue` dispatches them\n" +
        "- Dispatched envelopes move to `completed/`; failures stay put for a re-run\n",
      "utf-8"
    );
    created.push(".agent/jules-queue/README.md");
  }

  return { created, gitignore: ensureGitignore(root) };
}
