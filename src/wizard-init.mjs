import { existsSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseYaml, TIER_PRESETS, VENDOR_TIERS, FALLBACK_TIER } from "./config.mjs";
import { detectStackOracles, runVerificationProbe } from "./wizard-oracle.mjs";
import { select, multiSelect, input, confirm, spinner, isTTY } from "./tui.mjs";
import { KIT_VERSION } from "./version.mjs";

/**
 * Write a file atomically using a temporary file and atomic rename.
 * @param {string} filePath
 * @param {string} content
 */
function writeAtomic(filePath, content) {
  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const fd = openSync(tmpPath, "w");
  try {
    writeFileSync(fd, content, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, filePath);
}

/**
 * Snake_case projection of {@link TIER_PRESETS} for the YAML the wizard writes.
 * Derived rather than declared: as a second literal table it drifted out of sync
 * with the runtime and scaffolded configs with limits nothing else agreed on.
 */
export const TIER_PROFILES = Object.fromEntries(
  Object.entries(TIER_PRESETS).map(([name, p]) => [
    name,
    {
      concurrency: p.concurrency,
      daily_tasks: p.dailyTasks,
      stagger_ms: p.staggerMs,
      diff_kb: p.diffKb,
    },
  ])
);

const TIER_LABELS = {
  free: "Free",
  pro: "Pro",
  ultra: "Ultra",
  enterprise: "Custom / self-hosted pool",
};

/**
 * Build the tier menu from {@link TIER_PRESETS} so the prompt text cannot drift
 * from the limits actually written. The hardcoded descriptions it replaces
 * advertised numbers no tier had, and omitted `ultra` entirely.
 *
 * No option is marked "recommended": picking a plan the account does not have
 * is precisely how the budget ends up guarding the wrong ceiling.
 * @returns {Array<{ label: string, value: string, description: string }>}
 */
export function tierOptions() {
  const order = [...VENDOR_TIERS, ...Object.keys(TIER_PRESETS).filter((t) => !VENDOR_TIERS.includes(t))];
  return order.map((name) => {
    const p = TIER_PRESETS[name];
    const worker = p.concurrency === 1 ? "worker" : "workers";
    // The ceiling is shown next to the default so the number the wizard writes
    // reads as a starting point rather than as the plan's limit.
    const slots = p.maxConcurrency > p.concurrency
      ? `${p.concurrency} ${worker} (plan allows ${p.maxConcurrency})`
      : `${p.concurrency} ${worker}`;
    return {
      label: TIER_LABELS[name] || name,
      value: name,
      description: `${slots}, ~${p.dailyTasks} daily tasks, ${p.diffKb} KB diff limit`,
    };
  });
}

export const BUILTIN_PRESETS = [
  {
    id: "nightly-security-audit",
    title: "Nightly Security & Vulnerability Audit",
    description: "Scans codebase for hardcoded secrets, TODO annotations, and outdated dependencies.",
    cron: "0 2 * * *",
  },
  {
    id: "flaky-test-quarantine",
    title: "Statistical Flaky Test Quarantine",
    description: "Monitors test execution stability via Wilson score interval and isolates flaky tests.",
    cron: "*/30 * * * *",
  },
  {
    id: "multi-agent-refactor-swarm",
    title: "Multi-Agent Parallel Refactor Swarm",
    description: "Splits refactoring tasks across isolated workspace file boundaries.",
    cron: "manual",
  },
  {
    id: "doc-sync-sentinel",
    title: "AGENTS.md & API Doc Sync Sentinel",
    description: "Validates documentation integrity against actual exported symbol signatures.",
    cron: "0 9 * * 1",
  },
];

/**
 * Generate a deterministic onboarding plan for repository configuration.
 * @param {string} [root=process.cwd()]
 * @param {object} [options]
 * @returns {{
 *   stack: string,
 *   tier: string,
 *   verify: { test: string, build: string, lint: string, typecheck: string },
 *   limits: { concurrency: number, daily_tasks: number, stagger_ms: number, diff_kb: number },
 *   presets: Array<string>,
 *   configYaml: string,
 *   julesYaml: string
 * }}
 */
export function planInit(root = process.cwd(), options = {}) {
  const oracle = detectStackOracles(root);
  // Scaffolding `pro` for a caller who never stated a plan hands a free account
  // a 100-task budget and 8 concurrent workers it does not have. The same
  // reasoning makes FALLBACK_TIER conservative in loadConfig(); the wizard has
  // to agree with it or the manifest guards a ceiling the runtime does not.
  const tierName = options.tier || FALLBACK_TIER;
  // An unrecognised name resolves the same way loadConfig() resolves it, so the
  // scaffolded limits always match what the runtime will later enforce.
  const limits = TIER_PROFILES[tierName] || TIER_PROFILES[FALLBACK_TIER];

  // Preserve existing config if present
  let existingConfig = {};
  const existingConfigPath = join(root, ".agent", "config.yml");
  if (existsSync(existingConfigPath)) {
    try {
      existingConfig = parseYaml(readFileSync(existingConfigPath, "utf-8")) || {};
    } catch (_) {}
  }

  const verify = {
    test: options.testCmd || existingConfig.verify?.test || oracle.candidates.testCmd || "",
    build: options.buildCmd || existingConfig.verify?.build || oracle.candidates.buildCmd || "",
    lint: options.lintCmd || existingConfig.verify?.lint || oracle.candidates.lintCmd || "",
    typecheck: options.typecheckCmd || existingConfig.verify?.typecheck || oracle.candidates.typecheckCmd || "",
  };

  const selectedPresets = options.presets || existingConfig.presets || ["nightly-security-audit", "flaky-test-quarantine"];

  const configYaml = `# Google Jules Orchestrator Kit Config (v${KIT_VERSION})
version: 1
provider: ${existingConfig.provider || "jules"}
tier: ${tierName}
base_branch: ${options.baseBranch || existingConfig.base_branch || "main"}
branch_prefix: ${existingConfig.branch_prefix || "agent/"}

limits:
  concurrency: ${limits.concurrency}
  daily_tasks: ${limits.daily_tasks}
  stagger_ms: ${limits.stagger_ms}
  diff_kb: ${limits.diff_kb}

verify:
  test: "${verify.test}"
  build: "${verify.build}"
  lint: "${verify.lint}"
  typecheck: "${verify.typecheck}"

presets:
${selectedPresets.map((p) => `  - ${p}`).join("\n")}
`;

  const julesYaml = `# Google Jules Agent Compatibility Manifest
version: 1
test_cmd: "${verify.test}"
build_cmd: "${verify.build}"
`;

  return {
    stack: oracle.stack,
    tier: tierName,
    verify,
    limits,
    presets: selectedPresets,
    configYaml,
    julesYaml,
  };
}

/**
 * Load declarative presets from .agent/presets/*.yml or fallback to built-ins.
 * @param {string} [root=process.cwd()]
 * @returns {Array<{ id: string, title: string, description: string, cron: string }>}
 */
export function loadPresets(root = process.cwd()) {
  const presetsDir = join(root, ".agent", "presets");
  const presets = [...BUILTIN_PRESETS];

  if (existsSync(presetsDir)) {
    try {
      const files = readdirSync(presetsDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
      files.forEach((f) => {
        try {
          const content = readFileSync(join(presetsDir, f), "utf-8");
          const parsed = parseYaml(content);
          if (parsed && parsed.id && parsed.title) {
            presets.push({
              id: parsed.id,
              title: parsed.title,
              description: parsed.description || "",
              cron: parsed.cron || "manual",
            });
          }
        } catch (_) {}
      });
    } catch (_) {}
  }

  return presets;
}

/**
 * Run interactive or headless onboarding wizard.
 * @param {string} [root=process.cwd()]
 * @param {object} [options]
 * @returns {Promise<{ ok: boolean, configPath: string, plan: object }>}
 */
export async function runInitWizard(root = process.cwd(), options = {}) {
  const interactive = options.interactive !== false && isTTY(options.stdin || process.stdin);

  // Preserve existing config if present
  let existingConfig = {};
  const existingConfigPath = join(root, ".agent", "config.yml");
  if (existsSync(existingConfigPath)) {
    try {
      existingConfig = parseYaml(readFileSync(existingConfigPath, "utf-8")) || {};
    } catch (_) {}
  }

  if (!interactive && !options.allowDefaults && !options.tier && !existingConfig.tier) {
    throw new Error("Non-interactive init requires explicit options or allowDefaults: true");
  }

  let selectedTier = options.tier || existingConfig.tier || FALLBACK_TIER;
  let testCmd = options.testCmd;
  let buildCmd = options.buildCmd;
  let selectedPresets = options.presets;

  if (interactive) {
    const oracle = detectStackOracles(root);
    const sp = spinner("Inspecting repository stack and verification oracles", options);
    await new Promise((resolve) => setTimeout(resolve, 300));
    sp.stop(`Detected Stack: ${oracle.stack}`);

    const optionsList = tierOptions();
    const defaultTierIdx = Math.max(0, optionsList.findIndex((t) => t.value === selectedTier));

    selectedTier = await select(
      optionsList,
      "Which plan does your Jules account use? (limits are adjustable later)",
      { ...options, defaultIdx: defaultTierIdx }
    );

    testCmd = await input("Verification Test Command", {
      defaultValue: testCmd || existingConfig.verify?.test || oracle.candidates.testCmd || "npm test",
      stdin: options.stdin,
      stdout: options.stdout,
    });

    buildCmd = await input("Verification Build Command", {
      defaultValue: buildCmd || existingConfig.verify?.build || oracle.candidates.buildCmd || "",
      stdin: options.stdin,
      stdout: options.stdout,
    });

    const defaultPresetSet = new Set(
      selectedPresets || existingConfig.presets || BUILTIN_PRESETS.map((p) => p.id)
    );

    const presetOptions = BUILTIN_PRESETS.map((p) => ({
      label: p.title,
      value: p.id,
      checked: defaultPresetSet.has(p.id),
      description: p.description,
    }));

    selectedPresets = await multiSelect(presetOptions, "Select Autonomous Workflows to Enable", options);

    const shouldProbe = await confirm("Run verification probe on test command before saving?", true, options);
    if (shouldProbe && testCmd) {
      const probeSp = spinner(`Probing oracle: ${testCmd}`, options);
      const probeRes = await runVerificationProbe(testCmd, root);
      if (probeRes.ok) {
        probeSp.stop(`Oracle verified successfully (${probeRes.durationMs}ms)`);
      } else {
        probeSp.fail(`Oracle verification probe failed (Exit ${probeRes.code})`);
      }
    }
  }

  // `...options` first, for the same reason as in wizard-task.mjs: spreading it
  // last let a caller-supplied `tier` overwrite the plan the user picked from
  // the menu, so selecting Free or Ultra silently wrote whatever the CLI had
  // passed. `selectedTier` is seeded from `options.tier`, so an explicit
  // `--tier` still wins — it just wins by seeding the menu instead of by
  // discarding the answer.
  const plan = planInit(root, {
    ...options,
    tier: selectedTier,
    testCmd,
    buildCmd,
    presets: selectedPresets,
  });

  // Atomic write plan
  const agentDir = join(root, ".agent");
  if (!existsSync(agentDir)) {
    mkdirSync(agentDir, { recursive: true });
  }

  const configPath = join(agentDir, "config.yml");
  const julesPath = join(agentDir, "jules.yml");

  writeAtomic(configPath, plan.configYaml);
  writeAtomic(julesPath, plan.julesYaml);

  return {
    ok: true,
    configPath,
    plan,
  };
}
