import { loadConfig, parseYaml } from "./config.mjs";
import { checkScope, scanDiff, redactSecrets } from "./security.mjs";
import { changedFiles, diffBytes, diffText, showFromOrigin, runCmd, GateError } from "./git.mjs";
import { createProvider } from "./provider.mjs";
import { withBudget, appendLedger, getQueueDir, ensureDir } from "./state.mjs";
import { readdirSync, readFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Gatekeeper verification engine (Phase 1: Scope, Phase 2: Payload, Phase 3: Secrets, Phase 4: Verify Commands).
 * FAILS CLOSED ON GIT OR CONFIG ERRORS.
 */
export async function gate(opts = {}) {
  const root = opts.root || process.cwd();
  const config = opts.config || loadConfig(root);
  const base = opts.base || config.baseBranch || "main";
  const phases = [];

  let files = [];
  let bytes = 0;
  let diffStr = "";

  try {
    files = changedFiles(root, base);
    bytes = diffBytes(root, base);
    diffStr = diffText(root, base);
  } catch (err) {
    phases.push({ phase: "git_resolution", ok: false, error: err.message });
    return { ok: false, code: 1, phases, error: err.message };
  }

  // Phase 1: Scope Guard (Fetch trusted config strictly from origin/base)
  let trustedScope = config.scope;
  let trustedVerify = config.verify;

  const trustedConfigRaw = showFromOrigin(root, base, ".agent/config.yml") || showFromOrigin(root, base, ".agent/jules.yml");
  if (trustedConfigRaw) {
    try {
      const parsed = parseYaml(trustedConfigRaw);
      if (parsed.scope || parsed.forbidden_paths) {
        trustedScope = {
          deny: parsed.scope?.deny || parsed.forbidden_paths || config.scope.deny,
          allow: parsed.scope?.allow || parsed.allow_paths || config.scope.allow,
          protect: parsed.scope?.protect || config.scope.protect,
        };
      }
      if (parsed.verify || parsed.test_cmd || parsed.build_cmd) {
        trustedVerify = {
          test: parsed.verify?.test || parsed.test_cmd || config.verify.test,
          build: parsed.verify?.build || parsed.build_cmd || config.verify.build,
        };
      }
    } catch (_) {}
  }

  const scopeResult = checkScope(files, trustedScope, {
    allowProtected: opts.allowProtected || process.env.JULES_ALLOW_COMMAND_FILE_CHANGES === "true",
  });

  phases.push({ phase: "scope", ok: scopeResult.ok, violations: scopeResult.violations });
  if (!scopeResult.ok) {
    return { ok: false, code: 3, phases };
  }

  // Phase 2: Diff Payload Governor
  const limitBytes = (config.limits.diffKb || 75) * 1024;
  const payloadOk = bytes <= limitBytes;
  phases.push({ phase: "payload", ok: payloadOk, bytes, limitBytes });
  if (!payloadOk) {
    return { ok: false, code: 5, phases };
  }

  // Phase 3: Diff Secret Scanner
  const secretResult = scanDiff(diffStr);
  phases.push({ phase: "secrets", ok: secretResult.ok, findings: secretResult.findings });
  if (!secretResult.ok) {
    return { ok: false, code: 6, phases };
  }

  // Phase 4: Automated Test & Build Verification (Uses trusted verify commands only)
  const testCmd = trustedVerify.test;
  const buildCmd = trustedVerify.build;
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
  const cleanStderr = redactSecrets(failure.stderr || failure.stdout || "Unknown Error");
  return `Auto-Repair Attempt #${attempt}\nCommand Failed: ${failure.command || "verify"}\nStderr:\n${cleanStderr}\n\nPlease fix the issue.`;
}

export async function dispatch(task, opts = {}) {
  const root = opts.config?._root || opts.root || process.cwd();
  const config = opts.config || loadConfig(root);
  const provider = createProvider(config.provider, config);

  // Enforce prompt size limit
  const promptKb = (config.limits.promptKb || 50) * 1024;
  if (task.prompt && Buffer.byteLength(task.prompt, "utf-8") > promptKb) {
    throw new Error(`Task prompt exceeds maximum payload limit of ${config.limits.promptKb} KB`);
  }

  // Redact secrets in prompt before dispatching
  const cleanPrompt = redactSecrets(task.prompt);
  const cleanTask = { ...task, prompt: cleanPrompt };

  return withBudget(
    () => provider.dispatch(cleanTask, { root, dryRun: opts.dryRun }),
    root,
    config.limits.dailyTasks
  );
}

export async function run(opts = {}) {
  const root = opts.root || process.cwd();
  const config = opts.config || loadConfig(root);
  const concurrency = opts.concurrency || config.limits.concurrency || 1;
  const queueDir = getQueueDir(root);
  const completedDir = join(queueDir, "completed");
  ensureDir(completedDir);

  const files = readdirSync(queueDir).filter((f) => f.endsWith(".md"));
  const results = [];

  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (file) => {
        const srcPath = join(queueDir, file);
        try {
          const content = readFileSync(srcPath, "utf-8");
          const task = { title: file, prompt: content };
          const session = await dispatch(task, { root, config, dryRun: opts.dryRun });
          const dstPath = join(completedDir, file);
          renameSync(srcPath, dstPath);
          appendLedger({ event: "task_completed", file, session }, root);
          results.push({ file, ok: true, session });
        } catch (err) {
          results.push({ file, ok: false, error: err.message });
        }
      })
    );
  }

  return { processed: results.length, results };
}
