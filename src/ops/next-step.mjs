import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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

  if (!env.JULES_API_KEY && !env.GEMINI_API_KEY) {
    return {
      id: "key",
      headline: "No provider API key in the environment",
      detail:
        "The key is read from the environment only — never written to config and never sent anywhere but the provider. Until it is set you can still run `agentctl gate` and `--dry-run` dispatches locally.",
      command: "export JULES_API_KEY=...",
      blocking: false,
    };
  }

  const primaryQueueDir = join(root, ".agent", "jules-queue");
  const fallbackQueueDir = join(root, ".agent", "queue");
  const queueDir = existsSync(primaryQueueDir) ? primaryQueueDir : fallbackQueueDir;
  const queued = existsSync(queueDir)
    ? readdirSync(queueDir).filter((f) => f.endsWith(".md") || f.endsWith(".json") || f.endsWith(".yml")).length
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
