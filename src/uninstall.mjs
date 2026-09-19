/**
 * Undo a default `agentctl init`: remove kit-owned config and the runtime
 * `.gitignore` block. Optional `--force` also removes legacy scaffold dirs.
 *
 * See docs/uninstall.md — this deliberately does not delete AGENTS.md,
 * SPEC.md, or other paths that may contain project-owned content.
 */

import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import {
  RUNTIME_GITIGNORE_HEADER,
  stripRuntimeGitignoreBlock,
} from "./scaffold.mjs";

/** Legacy scaffold directories owned by `init --force` / older 0.x releases. */
export const FORCE_REMOVE_DIRS = [
  ".agent/rules",
  ".agent/prompts",
  ".agent/workflows",
  ".agent/jules-queue",
];

/**
 * @param {string} content
 * @returns {boolean}
 */
export function looksLikeKitConfig(content) {
  const text = String(content);
  if (text.includes("Agent Orchestrator Kit Config")) return true;
  // Minimal shape init writes: a versioned manifest with a provider key.
  return /^version:\s*\d+/m.test(text) && /^provider:\s*\S+/m.test(text);
}

/**
 * @param {string} root
 * @returns {{ installed: boolean, hasConfig: boolean, hasGitignoreBlock: boolean, configPath: string|null }}
 */
export function detectKitInstallation(root) {
  const configPath = join(root, ".agent", "config.yml");
  let hasConfig = false;
  if (existsSync(configPath)) {
    try {
      hasConfig = looksLikeKitConfig(readFileSync(configPath, "utf-8"));
    } catch (_) {
      hasConfig = false;
    }
  }

  let hasGitignoreBlock = false;
  const gitignorePath = join(root, ".gitignore");
  if (existsSync(gitignorePath)) {
    try {
      hasGitignoreBlock = readFileSync(gitignorePath, "utf-8").includes(RUNTIME_GITIGNORE_HEADER);
    } catch (_) {
      hasGitignoreBlock = false;
    }
  }

  return {
    installed: hasConfig || hasGitignoreBlock,
    hasConfig,
    hasGitignoreBlock,
    configPath: hasConfig ? ".agent/config.yml" : null,
  };
}

/**
 * @param {string} root
 * @param {{ force?: boolean }} [options]
 * @returns {{
 *   ok: boolean,
 *   installed: boolean,
 *   willRemove: string[],
 *   willCleanGitignore: boolean,
 *   forceDirs: string[],
 *   error?: string,
 * }}
 */
export function planUninstall(root, options = {}) {
  const force = Boolean(options.force);
  const detection = detectKitInstallation(root);
  if (!detection.installed) {
    return {
      ok: false,
      installed: false,
      willRemove: [],
      willCleanGitignore: false,
      forceDirs: [],
      error: "No kit installation detected (missing .agent/config.yml and runtime gitignore block).",
    };
  }

  const willRemove = [];
  if (detection.hasConfig) willRemove.push(".agent/config.yml");

  const forceDirs = [];
  if (force) {
    for (const rel of FORCE_REMOVE_DIRS) {
      if (existsSync(join(root, rel))) forceDirs.push(rel);
    }
    willRemove.push(...forceDirs);
  }

  const willCleanGitignore = detection.hasGitignoreBlock;
  if (willCleanGitignore) willRemove.push(".gitignore");

  // `.agent/` itself is only removed when it would be empty after the planned
  // deletions — reported so dry-run matches real execution.
  const agentDir = join(root, ".agent");
  if (existsSync(agentDir) && wouldAgentDirBeEmpty(root, {
    removeConfig: detection.hasConfig,
    forceDirs,
  })) {
    willRemove.push(".agent");
  }

  return {
    ok: true,
    installed: true,
    willRemove: [...new Set(willRemove)],
    willCleanGitignore,
    forceDirs,
  };
}

/**
 * @param {string} root
 * @param {{ removeConfig: boolean, forceDirs: string[] }} planned
 */
function wouldAgentDirBeEmpty(root, planned) {
  const agentDir = join(root, ".agent");
  if (!existsSync(agentDir)) return false;
  let entries;
  try {
    entries = readdirSync(agentDir);
  } catch (_) {
    return false;
  }
  const removing = new Set();
  if (planned.removeConfig) removing.add("config.yml");
  for (const rel of planned.forceDirs) {
    if (rel.startsWith(".agent/")) removing.add(rel.slice(".agent/".length).split("/")[0]);
  }
  return entries.every((name) => removing.has(name));
}

/**
 * @param {string} root
 * @param {{ force?: boolean, dryRun?: boolean }} [options]
 * @returns {{
 *   ok: boolean,
 *   dryRun: boolean,
 *   installed: boolean,
 *   willRemove?: string[],
 *   removed?: string[],
 *   willCleanGitignore?: boolean,
 *   cleanedGitignore?: boolean,
 *   error?: string,
 * }}
 */
export function uninstallKit(root, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const plan = planUninstall(root, { force });
  if (!plan.ok) {
    return { ok: false, dryRun, installed: false, error: plan.error };
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      installed: true,
      willRemove: plan.willRemove,
      willCleanGitignore: plan.willCleanGitignore,
    };
  }

  const removed = [];

  const configAbs = join(root, ".agent", "config.yml");
  if (plan.willRemove.includes(".agent/config.yml") && existsSync(configAbs)) {
    rmSync(configAbs, { force: true });
    removed.push(".agent/config.yml");
  }

  for (const rel of plan.forceDirs) {
    const abs = join(root, rel);
    if (existsSync(abs)) {
      rmSync(abs, { recursive: true, force: true });
      removed.push(rel);
    }
  }

  let cleanedGitignore = false;
  const gitignorePath = join(root, ".gitignore");
  if (plan.willCleanGitignore && existsSync(gitignorePath)) {
    const current = readFileSync(gitignorePath, "utf-8");
    const { text, stripped } = stripRuntimeGitignoreBlock(current);
    if (stripped) {
      writeFileSync(gitignorePath, text, "utf-8");
      cleanedGitignore = true;
      removed.push(".gitignore");
    }
  }

  const agentDir = join(root, ".agent");
  if (existsSync(agentDir)) {
    try {
      if (readdirSync(agentDir).length === 0) {
        rmdirSync(agentDir);
        removed.push(".agent");
      }
    } catch (_) {
      // Leave the directory if it is not empty or not removable.
    }
  }

  return {
    ok: true,
    dryRun: false,
    installed: true,
    removed: [...new Set(removed)],
    cleanedGitignore,
  };
}
