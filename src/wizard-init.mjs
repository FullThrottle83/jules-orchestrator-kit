import { existsSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseYaml, yamlScalar, TIER_PRESETS, VENDOR_TIERS, FALLBACK_TIER } from "./config.mjs";
import { suggestProvider, detectAvailableProviders } from "./provider-readiness.mjs";
import { detectDefaultBranch } from "./git.mjs";
import { resolveWorkspaceBoundary, oracleCandidates } from "./stack-detector.mjs";
import { PROFILE_NAMES, PROFILE_DESCRIPTIONS } from "./profiles.mjs";
import { detectStackOracles, runVerificationProbe } from "./wizard-oracle.mjs";
import { parseCollectedTests, producedNoOutput, looksLikeTestSuiteCommand } from "./ops/test-collection.mjs";
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
  const tierPresetLimits = TIER_PROFILES[tierName] || TIER_PROFILES[FALLBACK_TIER];

  // Preserve existing config if present — unless the caller asked for the
  // scaffold this repository would get with no `.agent/**` at all.
  //
  // `pristine` exists for the trusted-policy resolver (src/trusted-policy.mjs).
  // On a first install the only candidate policy is the uncommitted scaffold,
  // and the gate accepts it only when it is byte-identical to what `init`
  // generates. Seeding that reference from the very file being checked would
  // make the comparison vacuous: an agent's rewritten `verify.test` would be
  // read back as the expected value and match itself.
  const pristine = options.pristine === true;

  let existingConfig = {};
  const existingConfigPath = join(root, ".agent", "config.yml");
  if (!pristine && existsSync(existingConfigPath)) {
    try {
      existingConfig = parseYaml(readFileSync(existingConfigPath, "utf-8")) || {};
    } catch (_) {}
  }

  // Preserve existing jules.yml if present
  let existingJules = {};
  const existingJulesPath = join(root, ".agent", "jules.yml");
  if (!pristine && existsSync(existingJulesPath)) {
    try {
      existingJules = parseYaml(readFileSync(existingJulesPath, "utf-8")) || {};
    } catch (_) {}
  }

  const customLimits = options.limits || existingConfig.limits;
  const isCustomLimits = customLimits && Object.entries(customLimits).some(
    ([k, v]) => v !== undefined && tierPresetLimits[k] !== undefined && Number(v) !== Number(tierPresetLimits[k])
  );
  const limits = isCustomLimits ? { ...tierPresetLimits, ...customLimits } : tierPresetLimits;

  const verify = {
    test: options.testCmd || existingConfig.verify?.test || oracle.candidates.testCmd || "",
    build: options.buildCmd || existingConfig.verify?.build || oracle.candidates.buildCmd || "",
    lint: options.lintCmd || existingConfig.verify?.lint || oracle.candidates.lintCmd || "",
    typecheck: options.typecheckCmd || existingConfig.verify?.typecheck || oracle.candidates.typecheckCmd || "",
  };

  const selectedPresets = options.presets || existingConfig.presets || ["nightly-security-audit", "flaky-test-quarantine"];

  // Scaffolding `provider: jules` into a repository whose operator has no Jules
  // key — and a Claude Code or Codex CLI sitting on PATH — produced a config
  // that could never dispatch, and gave no hint that three other providers were
  // installed. Detection only fills a blank: an explicit option, and an
  // existing config, both still win.
  const provider =
    options.provider || existingConfig.provider || suggestProvider({ env: options.env || process.env });

  // How hard this repository wants its agents verified, in one word. Expanded
  // into concrete stages at load time by `loadConfig`, never frozen here, so
  // the gate list follows the stack instead of the day the repo was scaffolded.
  const requestedProfile = String(options.profile || existingConfig.verify?.profile || "standard").toLowerCase();
  const profile = PROFILE_NAMES.includes(requestedProfile) ? requestedProfile : "standard";

  // Detected, not assumed. A hardcoded `main` made the very first
  // `agentctl check` fail with an unresolvable base ref in every repository
  // whose git chose `master`, or whose team standardised on `develop`.
  const baseBranch = options.baseBranch || existingConfig.base_branch || detectDefaultBranch(root);

  // A monorepo that runs every package's suite for a one-package change is the
  // complaint the boundary resolver was written to answer, so a repository
  // detected as one starts with it on. Existing repositories keep whatever they
  // already stated; nobody's gate changes meaning because they upgraded.
  const detectedMonorepo = (() => {
    if (options.verifyScope) return options.verifyScope === "affected";
    if (existingConfig.verify?.scope) return existingConfig.verify.scope === "affected";
    try {
      return Boolean(resolveWorkspaceBoundary([], root).isMonorepo);
    } catch (_) {
      return false;
    }
  })();
  const verifyScope = detectedMonorepo ? "affected" : "global";

  const limitsBlock = isCustomLimits
    ? `\nlimits:\n  concurrency: ${limits.concurrency}\n  daily_tasks: ${limits.daily_tasks}\n  stagger_ms: ${limits.stagger_ms}\n  diff_kb: ${limits.diff_kb}\n`
    : "";

  // A generated comment must not begin with an ESLint directive keyword.
  //
  // `global`, `globals`, `exported`, `eslint`, `eslint-disable` and friends are
  // configuration when they open a comment — in any language ESLint has a
  // parser for, YAML included. This template began a line with "global runs
  // the ...", which ESLint read as `/* global runs, the, ... */`: a declaration
  // of globals named after each word of the sentence. Measured on
  // `unjs/unimport`, that produced 18 `no-unused-vars` errors quoting
  // individual English words back at the user, on a file `init` had written
  // thirty seconds earlier.
  //
  // The word is unavoidable — `global` is the name of the setting being
  // explained — so the sentence leads with the key instead.
  const configYaml = `# Agent Orchestrator Kit Config (v${KIT_VERSION})
# provider: jules | claude-code | codex | gemini-flash  (agentctl providers)
version: 1
provider: ${provider}
tier: ${tierName}
base_branch: ${baseBranch}
branch_prefix: ${existingConfig.branch_prefix || "agent/"}
${limitsBlock}
verify:
  # minimal | standard | max  — see: agentctl profile --list
  profile: ${profile}
  # scope: global runs the commands this repository declares; affected
  # resolves changed files to their sub-projects, running only those suites
  scope: ${verifyScope}
  test: ${yamlScalar(verify.test)}
  # How long a verification stage may run before the gate kills it (default
  # 300000). Raise it for a suite that legitimately takes longer.
  timeout_ms: 300000
  build: ${yamlScalar(verify.build)}
  lint: ${yamlScalar(verify.lint)}
  typecheck: ${yamlScalar(verify.typecheck)}

presets:
${selectedPresets.map((p) => `  - ${p}`).join("\n")}
`;

  // Universal defaults only. This list used to name `**/lock-manager/**` and
  // `scripts/jules-self-audit.mjs` — paths that exist in the kit's own
  // repository and in no other, so every project scaffolded by the wizard
  // inherited two rules that could never match anything it contained, and none
  // for the credentials it actually had.
  const forbiddenPaths = options.forbiddenPaths || existingJules.forbidden_paths || [
    ".github/**",
    "**/secrets/**",
    "**/*.pem",
    "**/*.key",
    "**/.env",
    "**/.env.*",
    ".agent/config.yml",
    ".agent/jules.yml",
  ];
  const allowPaths = options.allowPaths || existingJules.allow_paths || [];

  const julesYaml = `# Google Jules Repository Configuration (Version 2)
version: 2
test_cmd: ${yamlScalar(verify.test)}
build_cmd: ${yamlScalar(verify.build)}
forbidden_paths:
${forbiddenPaths.map((p) => `  - ${yamlScalar(p)}`).join("\n")}
allow_paths: ${allowPaths.length > 0 ? "\n" + allowPaths.map((p) => `  - ${yamlScalar(p)}`).join("\n") : "[]"}
`;

  return {
    stack: oracle.stack,
    tier: tierName,
    provider,
    profile,
    baseBranch,
    verifyScope,
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
/**
 * Probe the chosen test command, and take detection's next choice if it fails.
 *
 * Runs on the non-interactive path too. `--yes` means "do not ask me", not
 * "do not check" — and the user who is not watching is exactly the one who
 * cannot notice that the command written into their config does not run.
 * Before this, the probe lived inside the interactive branch, so
 * `agentctl init --yes` wrote `make test` into a repository where `make test`
 * exits 2 and `npm test` passes, and the first gate run was a hard red.
 *
 * @returns {Promise<string>} the command to save
 */
/**
 * How much a probe actually proved.
 *
 * Exit 0 is the weakest of the three answers. `pnpm -r test` on a workspace
 * whose packages declare no test script exits 0, prints nothing, and runs
 * nothing — and it was accepted here as a verified oracle, which left the
 * repository configured to approve every future change against silence.
 *
 * Choosing a command is the right moment to be strict about this: at init the
 * cost of rejecting a candidate is trying the next one, where at gate time it
 * would be a hard red on a repository that is fine.
 */
function probeVerdict(probeRes, cmd) {
  if (!probeRes.ok) return "failed";
  // Writing nothing at all is `empty`, not `silent`. The distinction is the
  // whole point: `silent` is the forgiving bucket that keeps a command the
  // guard could not read, and `pnpm -r test` landed in it because it prints
  // no output to be unreadable. So the candidate this verdict was introduced
  // to reject was the one case it waved through, and every repository
  // scaffolded on such a workspace kept it.
  // Same rule as the gate's floor, from the same predicate: a command that
  // claims to run a suite and printed nothing ran none. A static gate that
  // printed nothing did what it promised, so it keeps the forgiving verdict.
  if (looksLikeTestSuiteCommand(cmd) && producedNoOutput(probeRes.stdout, probeRes.stderr)) return "empty";
  const { count } = parseCollectedTests(probeRes.stdout, probeRes.stderr);
  if (count === null) return "silent";
  return count > 0 ? "ran" : "empty";
}

async function resolveRunnableOracle(root, testCmd, options = {}) {
  if (!testCmd) return testCmd;
  const probeSp = spinner(`Probing oracle: ${testCmd}`, options);
  const probeRes = await runVerificationProbe(testCmd, root);
  const verdict = probeVerdict(probeRes, testCmd);
  if (verdict === "ran") {
    probeSp.stop(`Oracle verified successfully (${probeRes.durationMs}ms)`);
    return testCmd;
  }
  if (verdict === "failed") {
    probeSp.fail(`Oracle verification probe failed (Exit ${probeRes.code})`);
  } else {
    probeSp.fail(
      verdict === "empty"
        ? `"${testCmd}" exited 0 but ran no tests — looking for a command that does`
        : `"${testCmd}" exited 0 without stating how many tests it ran — looking for a better one`
    );
  }

  const alternates = oracleCandidates(root, testCmd).filter((c) => c !== testCmd).slice(0, 3);
  // Two passes: prefer a command that proves it ran something, and only then
  // settle for one that merely exits 0. Falling back on the first exit-0
  // candidate would reintroduce exactly the silence this rejects.
  const settled = [];
  for (const cand of alternates) {
    const altSp = spinner(`Trying ${cand}`, options);
    const altRes = await runVerificationProbe(cand, root);
    const altVerdict = probeVerdict(altRes, cand);
    if (altVerdict === "ran") {
      altSp.stop(`${cand} runs here (${altRes.durationMs}ms) — using it instead`);
      return cand;
    }
    if (altVerdict === "silent") {
      altSp.fail(`${cand} exited 0 without stating a test count`);
      settled.push(cand);
      continue;
    }
    altSp.fail(altVerdict === "empty" ? `${cand} ran no tests` : `${cand} also failed (Exit ${altRes.code})`);
  }

  // Nothing proved it ran a suite. A command that at least starts and exits 0
  // still beats one that does not run at all, so it is used — and said out
  // loud, because the gate will only be able to check it by exit code.
  if (settled.length > 0 || verdict === "silent") {
    const chosen = verdict === "silent" ? testCmd : settled[0];
    const out = options.stdout || process.stdout;
    out.write("\n");
    out.write(`   \u26a0\ufe0f  "${chosen}" exits 0 but states no test count.\n`);
    out.write("      The gate can verify it by exit code alone, which cannot tell a\n");
    out.write("      full suite from a command that ran nothing. If this repository\n");
    out.write("      has a suite, point verify.test at it in .agent/config.yml.\n\n");
    return chosen;
  }

  // Nothing runs. Say so in terms the user can act on, rather than leaving a
  // failed spinner to scroll past and a broken command in the config.
  const out = options.stdout || process.stdout;
  out.write("\n");
  out.write("   \u26a0\ufe0f  No test command could be run in this environment.\n");
  out.write(`      Keeping "${testCmd}" \u2014 the gate will fail until it runs here.\n`);
  out.write("      Point verify.test in .agent/config.yml at a command that works,\n");
  out.write("      or, if this repository genuinely has no suite, set\n");
  out.write("      verify.required: false deliberately rather than by accident.\n\n");
  return testCmd;
}

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
  let selectedProvider = options.provider || existingConfig.provider;
  let selectedProfile = options.profile || existingConfig.verify?.profile;
  let testCmd = options.testCmd;
  let probeInteractive = null;
  let buildCmd = options.buildCmd;
  let selectedPresets = options.presets;

  if (interactive) {
    const oracle = detectStackOracles(root);
    const sp = spinner("Inspecting repository stack and verification oracles", options);
    await new Promise((resolve) => setTimeout(resolve, 300));
    sp.stop(`Detected Stack: ${oracle.stack}`);

    // Which agent, before anything about one vendor's plans.
    //
    // The wizard's first question used to be "Which plan does your Jules
    // account use?", asked of everyone — including people who came to drive
    // Claude Code or Codex and were now left guessing whether a Jules
    // subscription was a prerequisite. Ask what the repository is for first,
    // and ask the plan question only of the provider it belongs to.
    const probes = detectAvailableProviders({ env: options.env || process.env });
    const providerOptions = probes.map((pr) => ({
      label: `${pr.name}${pr.ready ? "" : "  (not available here)"}`,
      value: pr.name,
      hint: pr.ready ? pr.label : `${pr.label} — ${pr.remedy}`,
    }));
    const defaultProviderIdx = Math.max(
      0,
      providerOptions.findIndex((o) => o.value === (selectedProvider || probes.find((pr) => pr.ready)?.name))
    );
    selectedProvider = await select(providerOptions, "Which agent should run the tasks?", {
      ...options,
      defaultIdx: defaultProviderIdx,
    });

    // Only the hosted provider meters work against an account plan; asking a
    // local-CLI user about tiers is asking about something that does not exist
    // for them.
    if (selectedProvider === "jules") {
      const optionsList = tierOptions();
      const defaultTierIdx = Math.max(0, optionsList.findIndex((t) => t.value === selectedTier));
      selectedTier = await select(
        optionsList,
        "Which plan does your Jules account use? (limits are adjustable later)",
        { ...options, defaultIdx: defaultTierIdx }
      );
    }

    const profileOptions = PROFILE_NAMES.map((n) => ({
      label: n,
      value: n,
      hint: PROFILE_DESCRIPTIONS[n],
    }));
    const defaultProfileIdx = Math.max(0, profileOptions.findIndex((o) => o.value === (selectedProfile || "standard")));
    selectedProfile = await select(profileOptions, "How hard should the gate verify agent work?", {
      ...options,
      defaultIdx: defaultProfileIdx,
    });

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

    probeInteractive = await confirm("Run verification probe on test command before saving?", true, options);
  }

  // The probe runs whether or not anyone was asked: interactive users can
  // decline it, but silence from `--yes` is not a decline.
  if (probeInteractive !== false && options.probe !== false) {
    // Resolve the command the way planInit will, or there is nothing to
    // probe: on the headless path `testCmd` stays undefined until planInit
    // fills it in from detection, so the probe silently examined nothing —
    // the exact fail-open shape this project keeps finding in itself.
    const effective =
      testCmd || existingConfig.verify?.test || detectStackOracles(root)?.candidates?.testCmd || "";
    const adopted = await resolveRunnableOracle(root, effective, options);
    if (adopted) testCmd = adopted;
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
    provider: selectedProvider,
    profile: selectedProfile,
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
