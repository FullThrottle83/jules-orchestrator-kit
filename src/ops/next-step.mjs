import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { isTaskFile } from "../engine.mjs";
import { probeProvider } from "../provider-readiness.mjs";

/**
 * The provider named in `.agent/config.yml`, without paying for a full
 * `loadConfig()` (which detects the stack and shells out to git).
 *
 * A bare `agentctl` invocation has to stay instant, and the only field this
 * advisor needs is one line of YAML.
 *
 * @param {string} root
 * @returns {string}
 */
function readConfiguredProvider(root) {
  for (const name of ["config.yml", "jules.yml"]) {
    const file = join(root, ".agent", name);
    if (!existsSync(file)) continue;
    try {
      const match = readFileSync(file, "utf-8").match(/^provider:\s*["']?([\w.-]+)["']?\s*$/m);
      if (match) return match[1];
    } catch (_) {
      // An unreadable config is already reported by the `init` branch above.
    }
  }
  return "jules";
}

/**
 * Work out the one thing the operator should do next.
 *
 * `agentctl --help` lists thirty commands with no indication of which is step
 * one. That list is a reference for people who already know the tool; someone
 * meeting it for the first time cannot tell `hydrate` from `harvest` from
 * `dispatch`, and the cost of guessing wrong is a confusing failure rather than
 * a hint. This walks the same preconditions the commands themselves enforce and
 * names the single next action.
 *
 * Ordered by dependency: nothing later is worth suggesting while something
 * earlier is unmet.
 *
 * @param {string} root
 * @param {object} [env=process.env]
 * @returns {{ id: string, headline: string, detail: string, command: string, blocking: boolean }}
 */
export function resolveNextStep(root, env = process.env) {
  const inGitRepo = (() => {
    try {
      return spawnSync("git", ["rev-parse", "--git-dir"], { cwd: root, stdio: "ignore" }).status === 0;
    } catch (_) {
      return false;
    }
  })();

  if (!inGitRepo) {
    return {
      id: "git",
      headline: "This directory is not a git repository",
      detail:
        "Every safety guarantee here is expressed in terms of diffs, branches and a base to compare against, so the kit has nothing to reason about without git.",
      command: "git init",
      blocking: true,
    };
  }

  const configured = existsSync(join(root, ".agent", "config.yml")) || existsSync(join(root, ".agent", "jules.yml"));
  if (!configured) {
    return {
      id: "init",
      headline: "No .agent/ configuration yet",
      detail:
        "The wizard detects your stack, proposes a verification command, and writes the scope rules the gate enforces.",
      command: "agentctl init",
      blocking: true,
    };
  }

  // Which credential (or binary) is missing depends entirely on the provider
  // the repository selected. Asking for JULES_API_KEY in a repository driving
  // `claude-code` told the operator to fix something that was never broken.
  const providerName = readConfiguredProvider(root);
  const probe = probeProvider(providerName, { env });
  if (!probe.ready) {
    return {
      id: "provider",
      headline: probe.known
        ? `Provider '${probe.name}' is not usable yet`
        : `Provider '${probe.name}' is not a built-in preset`,
      detail: `${probe.reason} Until it is resolved you can still run \`agentctl gate\` and \`--dry-run\` dispatches locally — every verification gate works with no provider at all.`,
      command: probe.remedy,
      blocking: false,
    };
  }

  const primaryQueueDir = join(root, ".agent", "jules-queue");
  const fallbackQueueDir = join(root, ".agent", "queue");
  const queueDir = existsSync(primaryQueueDir) ? primaryQueueDir : fallbackQueueDir;
  const queued = existsSync(queueDir)
    ? readdirSync(queueDir).filter((f) => isTaskFile(f, queueDir)).length
    : 0;
  if (queued > 0) {
    return {
      id: "queue",
      headline: `${queued} task(s) waiting in the queue`,
      detail: "Run them through the gate and dispatch pipeline.",
      command: "agentctl queue",
      blocking: false,
    };
  }

  return {
    id: "ready",
    headline: "Set up and ready to dispatch",
    detail: "Add --dry-run first to see the envelope without spending a task.",
    command: 'agentctl dispatch -p "your task"',
    blocking: false,
  };
}

/**
 * Render the bare-invocation greeting: state, next step, and where the full
 * command list lives for those who want it.
 *
 * @param {object} ctx
 * @param {string} ctx.version
 * @param {string} ctx.root
 * @param {{ headline: string, detail: string, command: string }} ctx.next
 * @param {string} [ctx.budgetLine]
 * @returns {string}
 */
export function renderNextStep({ version, root, next, budgetLine }) {
  const lines = [
    ``,
    `🚀 agentctl v${version}`,
    `   ${root}`,
    ``,
    `   ${next.headline}`,
    `   ${next.detail}`,
    ``,
    `   Next:  ${next.command}`,
  ];
  if (budgetLine) lines.push(``, `   Budget: ${budgetLine}`);
  lines.push(``, `   All commands: agentctl --help`, ``);
  return lines.join("\n");
}
