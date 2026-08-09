import { existsSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseYaml } from "./config.mjs";
import { detectStackOracles, runVerificationProbe } from "./wizard-oracle.mjs";
import { select, multiSelect, input, confirm, spinner, isTTY } from "./tui.mjs";

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

export const TIER_PROFILES = {
  free: {
    concurrency: 1,
    daily_tasks: 30,
    stagger_ms: 3000,
    diff_kb: 50,
  },
  pro: {
    concurrency: 3,
    daily_tasks: 300,
    stagger_ms: 1500,
    diff_kb: 75,
  },
  enterprise: {
    concurrency: 10,
    daily_tasks: 1000,
    stagger_ms: 500,
    diff_kb: 100,
  },
};

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
  const tierName = options.tier || "pro";
  const limits = TIER_PROFILES[tierName] || TIER_PROFILES.pro;

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

  const configYaml = `# Google Jules Orchestrator Kit Config (v0.29.0)
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

  if (!interactive && !options.allowDefaults && !options.tier) {
    throw new Error("Non-interactive init requires explicit options or allowDefaults: true");
  }

  let selectedTier = options.tier || "pro";
  let testCmd = options.testCmd;
  let buildCmd = options.buildCmd;
  let selectedPresets = options.presets;

  if (interactive) {
    const oracle = detectStackOracles(root);
    const sp = spinner("Inspecting repository stack and verification oracles", options);
    await new Promise((resolve) => setTimeout(resolve, 300));
    sp.stop(`Detected Stack: ${oracle.stack}`);

    selectedTier = await select(
      [
        { label: "Pro Tier (Recommended)", value: "pro", description: "3 parallel workers, 300 daily tasks, 75 KB diff limit" },
        { label: "Free / Individual Tier", value: "free", description: "1 worker, 30 daily tasks, 50 KB diff limit" },
        { label: "Custom Enterprise", value: "enterprise", description: "10 workers, 1000 daily tasks, 100 KB diff limit" },
      ],
      "Select Jules Orchestrator Usage Tier",
      options
    );

    testCmd = await input("Verification Test Command", {
      defaultValue: oracle.candidates.testCmd || "npm test",
      stdin: options.stdin,
      stdout: options.stdout,
    });

    buildCmd = await input("Verification Build Command", {
      defaultValue: oracle.candidates.buildCmd || "",
      stdin: options.stdin,
      stdout: options.stdout,
    });

    const presetOptions = BUILTIN_PRESETS.map((p) => ({
      label: p.title,
      value: p.id,
      checked: true,
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

  const plan = planInit(root, {
    tier: selectedTier,
    testCmd,
    buildCmd,
    presets: selectedPresets,
    ...options,
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
