import { loadConfig, parseYaml, normalizeScope } from "./config.mjs";
import { checkScope, scanDiff, redactSecrets } from "./security.mjs";
import { changedFiles, diffBytes, diffText, showFromOrigin, runCmd } from "./git.mjs";
import { createProvider } from "./provider.mjs";
import { withBudget, appendLedger, getQueueDir, ensureDir } from "./state.mjs";
import { readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

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
