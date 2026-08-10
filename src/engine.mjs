import { loadConfig, parseYaml, normalizeScope } from "./config.mjs";
import { checkScope, scanDiff, redactSecrets } from "./security.mjs";
import { changedFiles, diffBytes, diffText, showFromOrigin, runCmd } from "./git.mjs";
import { createProvider, ProviderRateLimitError, ProviderUnavailableError } from "./provider.mjs";
import { withBudget, appendLedger, getQueueDir, ensureDir, rollbackBudgetReservation } from "./state.mjs";
import { sanitizeUntrustedData, buildAgentEnvelope } from "./prompt-guard.mjs";
import { recordVerifyRun, readVerifyRuns, flakyVerdict } from "./flaky-ledger.mjs";
import fs, { readdirSync, readFileSync, renameSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { appendTelemetry as appendTelemetryUnsafe } from "./telemetry.mjs";

export { recordVerifyRun, readVerifyRuns, flakyVerdict, sanitizeUntrustedData };

function appendTelemetry(root, kind, fields = {}) {
  try {
    return appendTelemetryUnsafe(root, kind, fields);
  } catch (_) {
    return null;
  }
}

function isSafeQueueFileName(fileName) {
  return typeof fileName === "string" && fileName.length > 0 && basename(fileName) === fileName && fileName !== "." && fileName !== "..";
}

/**
 * Validates whether a file in .agent/jules-queue/ is a task file.
 * Filters out README.md and matches TASK-*.md or valid envelope front-matter.
 */
export function isTaskFile(fileName, queueDirOrContent = null) {
  if (!fileName || typeof fileName !== "string") return false;
  const lower = fileName.toLowerCase();

  // Explicitly filter out README.md
  if (lower === "readme.md" || lower.endsWith("/readme.md") || lower.endsWith("\\readme.md")) {
    return false;
  }

  if (!lower.endsWith(".md")) {
    return false;
  }

  // Matching TASK-*.md or task-*.md
  if (/^task-.*\.md$/i.test(fileName)) {
    return true;
  }

  // Check valid envelope front-matter
  if (queueDirOrContent) {
    try {
      let content = queueDirOrContent;
      if (typeof queueDirOrContent === "string" && !queueDirOrContent.includes("\n") && existsSync(queueDirOrContent)) {
        const fullPath = queueDirOrContent.endsWith(fileName) ? queueDirOrContent : join(queueDirOrContent, fileName);
        if (existsSync(fullPath)) {
          content = readFileSync(fullPath, "utf-8");
        }
      }
      if (typeof content === "string") {
        const trimmed = content.trimStart();
        if (trimmed.includes("JULES_TASK_ENVELOPE") || trimmed.includes("# Task ID:") || trimmed.startsWith("---")) {
          return true;
        }
      }
    } catch (_) {}
  }

  return false;
}

/**
 * Computes a SHA-256 fingerprint for a failure state (normalized stderr + diff text).
 */
export function fingerprintFailureState(failure = {}, root = process.cwd()) {
  const rawStderr = failure.stderr || failure.stdout || failure.message || "Unknown Error";
  const normalizedStderr = String(rawStderr)
    .replace(/[\u001b\x1b]\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\?[^\s"'\)\\]+/g, "<?>")
    .replace(/:\d+:\d+/g, ":?:?")
    .replace(/:\d+/g, ":?")
    .replace(/\bline \d+/gi, "line ?")
    .replace(/\bcol(umn)? \d+/gi, "col ?")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z?\b/g, "<timestamp>")
    .replace(/\b[0-9a-f]{7,40}\b/g, "<sha>")
    .replace(/\/[\w\/-]+\//g, "/?/")
    .replace(/\s+/g, " ")
    .trim();

  let diffStat = "0:0";
  try {
    const rawDiff = diffText(root) || "";
    const lines = rawDiff.split("\n");
    const added = lines.filter((l) => l.startsWith("+")).length;
    const removed = lines.filter((l) => l.startsWith("-")).length;
    diffStat = `${added}:${removed}`;
  } catch (_) {}

  const combined = `${normalizedStderr}::${diffStat}`;
  return createHash("sha256").update(combined).digest("hex").substring(0, 16);
}

/**
 * Gatekeeper verification engine (Phase 1: Scope, Phase 2: Payload, Phase 3: Secrets, Phase 4: Verify Commands).
 * FAILS CLOSED ON GIT OR CONFIG ERRORS.
 */
export async function gate(opts = {}) {
  const root = opts.root || process.cwd();
  const config = opts.config || loadConfig(root);
  const base = opts.base || config.baseBranch || "main";
  const mode = opts.mode || (opts.workingTree ? "working-tree" : (process.env.JULES_GATE_MODE || "working-tree"));
  const progressBus = opts.progressBus;
  const progressToken = opts.progressToken;
  const phases = [];

  appendTelemetry(root, "gate_started", { base, mode });

  let files = [];
  let bytes = 0;
  let diffStr = "";

  try {
    files = changedFiles(root, base, mode);
    bytes = diffBytes(root, base, mode);
    diffStr = diffText(root, base, mode);
  } catch (err) {
    phases.push({ phase: "git_resolution", ok: false, error: err.message });
    appendTelemetry(root, "gate_finished", { ok: false, code: 1, error: err.message });
    return { ok: false, code: 1, phases, error: err.message };
  }

  // Phase 1: Scope Guard (Fetch trusted config strictly from origin/base using single normalizeScope)
  let trustedScope = config.scope;
  let trustedVerify = config.verify;

  const trustedConfigRaw = showFromOrigin(root, base, ".agent/config.yml") || showFromOrigin(root, base, ".agent/jules.yml");
  if (trustedConfigRaw) {
    try {
      const parsed = parseYaml(trustedConfigRaw);
      // CRITICAL B1 FIX: normalizeScope ensures BUILTIN_DENY is ALWAYS merged with user deny rules
      trustedScope = normalizeScope(parsed);
      if (parsed.verify || parsed.test_cmd || parsed.build_cmd) {
        trustedVerify = {
          test: parsed.verify?.test || parsed.test_cmd || config.verify.test,
          build: parsed.verify?.build || parsed.build_cmd || config.verify.build,
        };
      }
    } catch (_) {}
  } else {
    // CRITICAL H-c FIX: Fall back strictly to normalizeScope({}) (built-ins only), never HEAD config
    trustedScope = normalizeScope({});
  }

  const scopeResult = checkScope(files, trustedScope, {
    allowProtected: opts.allowProtected || process.env.JULES_ALLOW_COMMAND_FILE_CHANGES === "true",
  });

  phases.push({ phase: "scope", ok: scopeResult.ok, violations: scopeResult.violations });
  appendTelemetry(root, "gate_phase", { phase: "scope", ok: scopeResult.ok });
  if (progressBus && progressToken) {
    progressBus.reportProgress(progressToken, 25, 100, "Phase 1/4: Scope Guard verification complete");
  }

  if (!scopeResult.ok) {
    appendTelemetry(root, "gate_finished", { ok: false, code: 3 });
    return { ok: false, code: 3, phases };
  }

  // Phase 2: Diff Payload Governor
  const limitBytes = (config.limits.diffKb || 75) * 1024;
  const payloadOk = bytes <= limitBytes;
  phases.push({ phase: "payload", ok: payloadOk, bytes, limitBytes });
  appendTelemetry(root, "gate_phase", { phase: "payload", ok: payloadOk });
  if (progressBus && progressToken) {
    progressBus.reportProgress(progressToken, 50, 100, "Phase 2/4: Diff Payload Governor check complete");
  }

  if (!payloadOk) {
    appendTelemetry(root, "gate_finished", { ok: false, code: 5 });
    return { ok: false, code: 5, phases };
  }

  // Phase 3: Diff Secret Scanner
  const secretResult = scanDiff(diffStr);
  phases.push({ phase: "secrets", ok: secretResult.ok, findings: secretResult.findings });
  appendTelemetry(root, "gate_phase", { phase: "secrets", ok: secretResult.ok });
  if (progressBus && progressToken) {
    progressBus.reportProgress(progressToken, 75, 100, "Phase 3/4: Diff Secret Scanner check complete");
  }

  if (!secretResult.ok) {
    appendTelemetry(root, "gate_finished", { ok: false, code: 6 });
    return { ok: false, code: 6, phases };
  }

  // Phase 4: Automated Test & Build Verification (Uses trusted verify commands only)
  const testCmd = trustedVerify.test;
  const buildCmd = trustedVerify.build;
  let testResult = { ok: true, status: 0 };
  let buildResult = { ok: true, status: 0 };

  const existingNodeOptions = process.env.NODE_OPTIONS || "";
  const netGuardUrl = new URL("./preload-net-guard.mjs", import.meta.url).href;
  const netGuardFlag = `--import ${netGuardUrl}`;
  const guardNodeOptions = existingNodeOptions && !existingNodeOptions.includes(netGuardFlag) && !existingNodeOptions.includes("preload-net-guard.mjs")
    ? `${existingNodeOptions} ${netGuardFlag}`
    : existingNodeOptions ? existingNodeOptions : netGuardFlag;

  const testEnv = {
    ...process.env,
    NODE_OPTIONS: guardNodeOptions,
  };

  let flakyVerdictResult = null;

  if (testCmd) {
    const startTime = Date.now();
    const res = runCmd(testCmd, { cwd: root, ignoreError: true, env: testEnv });
    const durationMs = Date.now() - startTime;
    testResult = {
      ok: res.status === 0,
      status: res.status,
      stdout: redactSecrets(res.stdout || ""),
      stderr: redactSecrets(res.stderr || ""),
      command: testCmd,
    };

    const fingerprint = !testResult.ok ? fingerprintFailureState(testResult, root) : null;
    recordVerifyRun(root, testCmd, testResult.ok, fingerprint, durationMs);

    if (!testResult.ok) {
      const runs = readVerifyRuns(root, testCmd);
      flakyVerdictResult = flakyVerdict(runs);
      if (flakyVerdictResult.verdict === "QUARANTINED") {
        phases.push({ phase: "verify", ok: false, testResult, buildResult, flakyVerdict: flakyVerdictResult });
        appendTelemetry(root, "gate_phase", { phase: "verify", ok: false, quarantined: true });
        appendTelemetry(root, "gate_finished", { ok: false, code: 8 });
        return { ok: false, code: 8, phases, flakyVerdict: flakyVerdictResult };
      }
    }
  }

  if (testResult.ok && buildCmd) {
    const res = runCmd(buildCmd, { cwd: root, ignoreError: true, env: testEnv });
    buildResult = {
      ok: res.status === 0,
      status: res.status,
      stdout: redactSecrets(res.stdout || ""),
      stderr: redactSecrets(res.stderr || ""),
      command: buildCmd,
    };
  }

  const verifyOk = testResult.ok && buildResult.ok;
  const failingCmd = !testResult.ok ? testResult : !buildResult.ok ? buildResult : null;
  phases.push({ phase: "verify", ok: verifyOk, testResult, buildResult });
  appendTelemetry(root, "gate_phase", { phase: "verify", ok: verifyOk });
  if (progressBus && progressToken) {
    progressBus.reportProgress(progressToken, 100, 100, "Phase 4/4: Automated Test & Build Verification complete");
  }

  if (!verifyOk && opts.fix) {
    const repairs = await repair(failingCmd, { config, root, signal: opts.signal, progressBus, progressToken });
    const finalOk = repairs.ok;
    const finalCode = repairs.ok ? 0 : 4;
    appendTelemetry(root, "gate_finished", { ok: finalOk, code: finalCode, repaired: true });
    if (repairs.ok) {
      return { ok: true, code: 0, phases, repairs };
    }
    return { ok: false, code: 4, phases, repairs };
  }

  const code = verifyOk ? 0 : 4;
  appendTelemetry(root, "gate_finished", { ok: verifyOk, code });
  return { ok: verifyOk, code, phases };
}

/**
 * Sliding-window ring-buffer circuit breaker for non-convergent OODA loops.
 */
export class OODACircuitBreaker {
  constructor({ windowSize = 6, threshold = 2, cooldownMs = 60000 } = {}) {
    this.windowSize = windowSize;
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.ring = [];
    this.openedAt = 0;
    this.openedFingerprint = null;
  }

  observe(fingerprint) {
    if (!fingerprint || typeof fingerprint !== "string") {
      return { tripped: false };
    }
    if (this.isOpen()) {
      return { tripped: true, reason: "OODA_CIRCUIT_OPEN", fingerprint: this.openedFingerprint };
    }
    const occurrences = this.ring.filter((f) => f === fingerprint).length + 1;
    this.ring.push(fingerprint);
    if (this.ring.length > this.windowSize) this.ring.shift();

    if (occurrences >= this.threshold) {
      this.openedAt = Date.now();
      this.openedFingerprint = fingerprint;
      return {
        tripped: true,
        reason: "OODA_THRASH_DETECTED",
        fingerprint,
        occurrences,
      };
    }
    return { tripped: false, occurrences };
  }

  isOpen() {
    if (this.openedAt === 0) return false;
    if (Date.now() - this.openedAt >= this.cooldownMs) {
      this.openedAt = 0;
      this.openedFingerprint = null;
      this.ring = [];
      return false;
    }
    return true;
  }

  reset() {
    this.ring = [];
    this.openedAt = 0;
    this.openedFingerprint = null;
  }
}

export async function repair(failure, opts = {}) {
  const root = opts.root || process.cwd();
  const config = opts.config || loadConfig(root);
  const maxRetries = config.limits.repairAttempts || 3;
  const provider = opts.provider || createProvider(config.provider, config);
  const progressBus = opts.progressBus;
  const progressToken = opts.progressToken;
  const attempts = [];
  const breaker = opts.circuitBreaker || new OODACircuitBreaker({
    windowSize: Math.max(maxRetries + 1, 6),
    threshold: 2,
    cooldownMs: 60000,
  });

  let currentFailure = failure;
  const initialFingerprint = fingerprintFailureState(currentFailure, root);
  breaker.observe(initialFingerprint);

  for (let n = 1; n <= maxRetries; n++) {
    if (progressBus && progressToken) {
      progressBus.reportProgress(progressToken, Math.round((n / maxRetries) * 100), 100, `OODA Repair attempt ${n}/${maxRetries}`);
    }

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
      if (err instanceof ProviderRateLimitError || err instanceof ProviderUnavailableError) {
        if (err.reservationId && !err.budgetReservationRolledBack) {
          rollbackBudgetReservation(root, err.reservationId);
        }
        const retryAfterMs = err.retryAfterMs || 60000;
        const backoffSec = Math.ceil(retryAfterMs / 1000);
        console.warn(`[PROVIDER_INFRASTRUCTURE_FAILURE] ${err.name}: ${err.message}. Recommended backoff: ${backoffSec}s.`);
        attempts.push({ n, ok: false, error: err.message, providerError: true, retryAfterMs });
        appendTelemetry(root, "ooda_repair_attempt", { attempt: n, ok: false, error: err.message, providerError: true });
        return {
          ok: false,
          attempts,
          finalStatus: "PROVIDER_INFRASTRUCTURE_FAILURE",
          error: err.message,
          retryAfterMs,
          providerError: true,
        };
      }
      attempts.push({ n, ok: false, error: err.message });
      appendTelemetry(root, "ooda_repair_attempt", { attempt: n, ok: false, error: err.message });
      break;
    }

    attempts.push({ n, session, ok: true });
    appendTelemetry(root, "ooda_repair_attempt", { attempt: n, ok: true });

    // Poll async provider for terminal session state before executing re-verification gates
    if (provider && session) {
      await pollSessionState(provider, session, {
        root,
        dryRun: opts.dryRun,
        pollIntervalMs: opts.pollIntervalMs,
        maxPollAttempts: opts.maxPollAttempts,
      });
    }

    // Re-verify after repair attempt
    const gateRes = await gate({ root, config, fix: false, progressBus, progressToken });
    if (gateRes.ok) {
      breaker.reset();
      return { ok: true, attempts, finalStatus: "PASSED" };
    }

    currentFailure = gateRes.phases.find((p) => p.phase === "verify")?.testResult || failure;
    const currentFingerprint = fingerprintFailureState(currentFailure, root);

    const check = breaker.observe(currentFingerprint);
    if (check.tripped) {
      return {
        ok: false,
        attempts,
        finalStatus: "DETERMINISTIC_REGRESSION",
        reason: `Identical failure state fingerprint (${currentFingerprint}) observed during attempt #${n}`,
        fingerprint: currentFingerprint,
      };
    }
  }

  return { ok: false, attempts, finalStatus: "OODA_EXHAUSTED" };
}

/**
 * Polls an async provider for terminal session state (COMPLETED / FAILED) before re-verification.
 */
export async function pollSessionState(provider, session, opts = {}) {
  if (!session || !session.id) return { status: "COMPLETED" };
  const initialStatus = String(session.status || session.state || "").toUpperCase();
  if (initialStatus === "COMPLETED" || initialStatus === "FAILED" || opts.dryRun || session.id === "dry-run-session-id") {
    return { status: initialStatus || "COMPLETED" };
  }

  const maxAttempts = opts.maxPollAttempts || 30;
  const pollIntervalMs = opts.pollIntervalMs || 1000;
  const timeoutMs = opts.pollTimeoutMs || 300000;
  const startTime = Date.now();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (Date.now() - startTime > timeoutMs) break;

    let currentSession = null;
    if (provider && typeof provider.getSession === "function") {
      try {
        currentSession = await provider.getSession(session.id, opts);
      } catch (_) {}
    } else if (typeof opts.pollFn === "function") {
      try {
        currentSession = await opts.pollFn(session.id);
      } catch (_) {}
    }

    if (currentSession) {
      const status = String(currentSession.status || currentSession.state || "").toUpperCase();
      if (status === "COMPLETED" || status === "FAILED") {
        return { ...currentSession, status };
      }
    } else {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return { ...session, status: String(session.status || "COMPLETED").toUpperCase() };
}

function buildRepairPrompt(failure, attempt, _config) {
  const cleanStderr = redactSecrets(failure.stderr || failure.stdout || "Unknown Error");

  let escalationStrategy = "DIRECT_REPAIR";
  let escalationDirective = "1. Ground your fix strictly in the error log below. Do NOT guess file contents or function signatures.";

  if (attempt === 2) {
    escalationStrategy = "DIAGNOSTIC_ANALYSIS";
    escalationDirective = "1. DIAGNOSE FIRST: Two attempts have failed. Analyze if the root cause is in a different file or component than where the previous patch was applied.";
  } else if (attempt >= 3) {
    escalationStrategy = "MINIMAL_SIMPLIFICATION";
    escalationDirective = "1. SIMPLIFY: Multiple repair attempts have failed. Revert complex refactors and implement the minimal patch that satisfies the failing assertion.";
  }

  return `Auto-Repair Attempt #${attempt} [Strategy: ${escalationStrategy}]
Command Failed: ${failure.command || "verify"}

REPAIR DIRECTIVE & STRICT INVARIANTS:
${escalationDirective}
2. NO WEAKENING: You are STRICTLY FORBIDDEN from deleting tests, commenting out assertions, or weakening expectations to achieve a passing test. Leave unmet requirements RED if the requirement is valid and feature code is missing.
3. CARRY EVIDENCE: Address the root cause directly and verify the exact fix.
4. RE-VERIFY: Execute full verification after patching to ensure zero new regressions.

Stderr:
${cleanStderr}`;
}

export async function dispatch(task = {}, opts = {}) {
  if (!task || typeof task !== "object") {
    throw new TypeError("Dispatch task must be an object");
  }
  const root = opts.config?._root || opts.root || process.cwd();
  const config = opts.config || loadConfig(root);
  const provider = createProvider(config.provider, config);

  // Enforce prompt size limit
  const promptKb = (config.limits.promptKb || 50) * 1024;
  if (task.prompt && Buffer.byteLength(task.prompt, "utf-8") > promptKb) {
    throw new Error(`Task prompt exceeds maximum payload limit of ${config.limits.promptKb} KB`);
  }

  // Redact secrets in prompt before dispatching
  const cleanPrompt = redactSecrets(task.prompt || "");

  // Wire Prompt Guard & Envelope to wrap raw task arguments
  const taskInstructions = task.taskInstructions || cleanPrompt || task.title || "Autonomous Task Execution";
  const untrustedData = Array.isArray(task.untrustedData) ? task.untrustedData : [];
  const systemPolicy = task.systemPolicy || config.systemPolicy || "";
  const envelopedPrompt = buildAgentEnvelope(systemPolicy, taskInstructions, untrustedData);

  const cleanTask = { ...task, prompt: envelopedPrompt };

  try {
    return await withBudget(
      () => provider.dispatch(cleanTask, { root, dryRun: opts.dryRun }),
      root,
      config.limits.dailyTasks
    );
  } catch (err) {
    if (err instanceof ProviderRateLimitError || err instanceof ProviderUnavailableError) {
      if (err.reservationId && !err.budgetReservationRolledBack) {
        rollbackBudgetReservation(root, err.reservationId);
      }
      const retryAfterMs = err.retryAfterMs || 60000;
      const status = err instanceof ProviderRateLimitError ? "RATE_LIMITED" : "PROVIDER_UNAVAILABLE";
      const backoffSec = Math.ceil(retryAfterMs / 1000);
      console.warn(`[PROVIDER_INFRASTRUCTURE_FAILURE] ${err.name}: ${err.message}. Recommended backoff: ${backoffSec}s.`);
      return {
        ok: false,
        status,
        error: err.message,
        retryAfterMs,
        providerError: true,
      };
    }
    throw err;
  }
}

export async function run(tasksOrOpts = {}, opts = {}) {
  let tasks = null;
  let options = opts;
  if (Array.isArray(tasksOrOpts)) {
    tasks = tasksOrOpts;
    options = opts || {};
  } else if (tasksOrOpts && typeof tasksOrOpts === "object") {
    options = tasksOrOpts;
  }

  const root = options.root || process.cwd();
  const config = options.config || loadConfig(root);
  const requestedConcurrency = Number(options.concurrency ?? config.limits.concurrency ?? 1);
  const concurrency = Number.isInteger(requestedConcurrency) && requestedConcurrency > 0 ? requestedConcurrency : 1;
  const isDry = options.dryRun !== undefined ? options.dryRun : (process.env.JULES_DRY_RUN === "true" || process.env.JULES_DRY_RUN === "1");
  const queueDir = getQueueDir(root);
  const completedDir = join(queueDir, "completed");
  ensureDir(completedDir);

  let filesToProcess = [];
  if (Array.isArray(tasks)) {
    filesToProcess = tasks;
  } else {
    filesToProcess = readdirSync(queueDir).filter((f) => isTaskFile(f, queueDir));
  }

  const results = [];

  for (let i = 0; i < filesToProcess.length; i += concurrency) {
    const batch = filesToProcess.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (fileOrItem) => {
        const fileName = typeof fileOrItem === "string" ? fileOrItem : fileOrItem?.id || fileOrItem?.file || fileOrItem?.title || "task";
        try {
          if (!isSafeQueueFileName(fileName)) {
            throw new Error(`Unsafe queue task path: ${fileName}`);
          }
          const srcPath = join(queueDir, fileName);
          let prompt = typeof fileOrItem === "object" && fileOrItem.prompt ? fileOrItem.prompt : "";
          let title = typeof fileOrItem === "object" && fileOrItem.title ? fileOrItem.title : fileName;
          if (!prompt && existsSync(srcPath)) {
            prompt = await fs.promises.readFile(srcPath, "utf-8");
          }
          const task = typeof fileOrItem === "object" ? { ...fileOrItem, title, prompt } : { title, prompt };
          const session = await dispatch(task, { root, config, dryRun: isDry });

          if (session && session.ok === false) {
            results.push({ file: fileName, ok: false, status: session.status, error: session.error, session });
          } else {
            const dstPath = join(completedDir, fileName);
            if (existsSync(srcPath)) {
              if (existsSync(dstPath)) {
                throw new Error(`Completed task destination already exists: ${fileName}`);
              }
              renameSync(srcPath, dstPath);
            }
            appendLedger({ event: "task_completed", file: fileName, session }, root);
            results.push({ file: fileName, ok: true, session });
          }
        } catch (err) {
          results.push({ file: fileName, ok: false, error: err.message });
        }
      })
    );
  }

  return { processed: results.length, results };
}
