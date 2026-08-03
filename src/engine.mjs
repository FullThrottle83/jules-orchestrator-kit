import { loadConfig } from "./config.mjs";
import { checkScope, scanDiff } from "./security.mjs";
import { changedFiles, diffBytes, diffText, runCmd } from "./git.mjs";
import { createProvider } from "./provider.mjs";
import { withBudget, appendLedger, getQueueDir, ensureDir } from "./state.mjs";
import { readdirSync, readFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Gatekeeper verification engine (Phase 1: Scope, Phase 2: Payload, Phase 3: Secrets, Phase 4: Verify Commands).
 */
export async function gate(opts = {}) {
  const root = opts.root || process.cwd();
  const config = opts.config || loadConfig(root);
  const base = opts.base || config.baseBranch || "main";
  const phases = [];

  // Phase 1: Scope Guard
  let trustedScope = config.scope;
  const configPath = join(root, ".agent/config.yml");
  const julesPath = join(root, ".agent/jules.yml");
  const targetConfig = existsSync(configPath) ? configPath : existsSync(julesPath) ? julesPath : null;

  if (targetConfig) {
    try {
      const trustedConfigStr = runCmd(`git show ${base}:${targetConfig.slice(root.length + 1).replace(/\\/g, "/")}`, {
        cwd: root,
        ignoreError: true,
      }).stdout;
      const { parseYaml } = await import("./config.mjs");
      const parsed = parseYaml(trustedConfigStr);
      if (parsed.scope || parsed.forbidden_paths) {
        trustedScope = {
          deny: parsed.scope?.deny || parsed.forbidden_paths || config.scope.deny,
          allow: parsed.scope?.allow || parsed.allow_paths || config.scope.allow,
          protect: config.scope.protect,
        };
      }
    } catch (_) {}
  }

  const files = changedFiles(root, base);
  const scopeResult = checkScope(files, trustedScope, {
    allowProtected: opts.allowProtected || process.env.JULES_ALLOW_COMMAND_FILE_CHANGES === "true",
  });

  phases.push({ phase: "scope", ok: scopeResult.ok, violations: scopeResult.violations });
  if (!scopeResult.ok) {
    return { ok: false, code: 3, phases };
  }

  // Phase 2: Diff Payload Governor
  const bytes = diffBytes(root, base);
  const limitBytes = (config.limits.diffKb || 75) * 1024;
  const payloadOk = bytes <= limitBytes;
  phases.push({ phase: "payload", ok: payloadOk, bytes, limitBytes });
  if (!payloadOk) {
    return { ok: false, code: 5, phases };
  }

  // Phase 3: Diff Secret Scanner
  const diffStr = diffText(root, base);
  const secretResult = scanDiff(diffStr);
  phases.push({ phase: "secrets", ok: secretResult.ok, findings: secretResult.findings });
  if (!secretResult.ok) {
    return { ok: false, code: 6, phases };
  }

  // Phase 4: Automated Test & Build Verification
  const testCmd = config.verify.test;
  const buildCmd = config.verify.build;
  let testResult = { ok: true, status: 0 };
  let buildResult = { ok: true, status: 0 };

  if (testCmd) {
    const res = runCmd(testCmd, { cwd: root, ignoreError: true });
    testResult = { ok: res.status === 0, status: res.status, stdout: res.stdout, stderr: res.stderr, command: testCmd };
  }

  if (testResult.ok && buildCmd) {
    const res = runCmd(buildCmd, { cwd: root, ignoreError: true });
    buildResult = { ok: res.status === 0, status: res.status, stdout: res.stdout, stderr: res.stderr, command: buildCmd };
  }

  const verifyOk = testResult.ok && buildResult.ok;
  const failingCmd = !testResult.ok ? testResult : !buildResult.ok ? buildResult : null;
  phases.push({ phase: "verify", ok: verifyOk, testResult, buildResult });

  if (!verifyOk && opts.fix) {
    const repairs = await repair(failingCmd, { config, root, signal: opts.signal });
    if (repairs.ok) {
      return { ok: true, code: 0, phases, repairs };
    }
    return { ok: false, code: 4, phases, repairs };
  }

  return { ok: verifyOk, code: verifyOk ? 0 : 4, phases };
}

export async function repair(failure, opts = {}) {
  const root = opts.root || process.cwd();
  const config = opts.config || loadConfig(root);
  const maxRetries = config.limits.repairAttempts || 3;
  const provider = createProvider(config.provider, config);
  const attempts = [];

  let currentFailure = failure;
  for (let n = 1; n <= maxRetries; n++) {
    const repairPrompt = buildRepairPrompt(currentFailure, n, config);
    let session;
    try {
      session = await withBudget(
        () =>
          provider.dispatch(
            { id: `repair-${n}`, title: `OODA Auto-Repair Attempt ${n}`, prompt: repairPrompt },
            { root, dryRun: opts.dryRun }
          ),
        root,
        config.limits.dailyTasks
      );
    } catch (err) {
      attempts.push({ n, ok: false, error: err.message });
      break;
    }

    attempts.push({ n, session, ok: true });

    // Re-verify after repair attempt
    const gateRes = await gate({ root, config, fix: false });
    if (gateRes.ok) {
      return { ok: true, attempts, finalStatus: "PASSED" };
    }
    currentFailure = gateRes.phases.find((p) => p.phase === "verify")?.testResult || failure;
  }

  return { ok: false, attempts, finalStatus: "OODA_EXHAUSTED" };
}

function buildRepairPrompt(failure, attempt, config) {
  return `Auto-Repair Attempt #${attempt}\nCommand Failed: ${failure.command || "verify"}\nStderr:\n${failure.stderr || failure.stdout || "Unknown Error"}\n\nPlease fix the issue.`;
}

export async function dispatch(task, opts = {}) {
  const root = opts.config?._root || opts.root || process.cwd();
  const config = opts.config || loadConfig(root);
  const provider = createProvider(config.provider, config);

  return withBudget(
    () => provider.dispatch(task, { root, dryRun: opts.dryRun }),
    root,
    config.limits.dailyTasks
  );
}

export async function run(opts = {}) {
  const root = opts.root || process.cwd();
  const config = opts.config || loadConfig(root);
  const queueDir = getQueueDir(root);
  const completedDir = join(queueDir, "completed");
  ensureDir(completedDir);

  const files = readdirSync(queueDir).filter((f) => f.endsWith(".md"));
  const results = [];

  for (const file of files) {
    const srcPath = join(queueDir, file);
    const content = readFileSync(srcPath, "utf-8");
    const task = { title: file, prompt: content };

    try {
      const session = await dispatch(task, { root, config, dryRun: opts.dryRun });
      const dstPath = join(completedDir, file);
      try { renameSync(srcPath, dstPath); } catch (_) {}
      appendLedger({ event: "task_completed", file, session }, root);
      results.push({ file, ok: true, session });
    } catch (err) {
      results.push({ file, ok: false, error: err.message });
    }
  }

  return { processed: results.length, results };
}
