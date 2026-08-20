import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getStateDir, getQueueDir, ensureDir } from "./state.mjs";
import { resolveRoot } from "./config.mjs";

/**
 * Calculates Wilson score interval for binomial proportion.
 */
export function wilsonScoreInterval(k, n, z = 1.96) {
  if (n === 0) return { lower: 0, upper: 0 };
  const p = k / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const stdErr = Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  const margin = (z * stdErr) / denominator;
  const lower = Math.max(0, center - margin);
  const upper = Math.min(1, center + margin);
  return { lower, upper };
}

/**
 * Computes oscillation rate (fraction of state transitions between consecutive runs).
 */
export function computeOscillation(runs) {
  if (!runs || runs.length <= 1) return 0;
  let transitions = 0;
  for (let i = 0; i < runs.length - 1; i++) {
    const current = typeof runs[i] === "boolean" ? runs[i] : Boolean(runs[i] && runs[i].pass);
    const next = typeof runs[i + 1] === "boolean" ? runs[i + 1] : Boolean(runs[i + 1] && runs[i + 1].pass);
    if (current !== next) {
      transitions++;
    }
  }
  return transitions / (runs.length - 1);
}

/**
 * Appends a test outcome record to .agent/state/flaky.jsonl.
 */
export function recordVerifyRun(root, testCmd, pass, fingerprint = null, durationMs = 0) {
  const stateDir = getStateDir(root);
  ensureDir(stateDir);
  const filePath = join(stateDir, "flaky.jsonl");

  const entry = {
    timestamp: new Date().toISOString(),
    testCmd: testCmd || "",
    pass: Boolean(pass),
    fingerprint: fingerprint || null,
    durationMs: Number(durationMs) || 0,
  };

  appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
  return entry;
}

/**
 * Reads test run records from .agent/state/flaky.jsonl.
 */
export function readVerifyRuns(root, testCmd = null) {
  const stateDir = getStateDir(root);
  const filePath = join(stateDir, "flaky.jsonl");

  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const runs = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (!testCmd || parsed.testCmd === testCmd) {
          runs.push(parsed);
        }
      } catch (_) {}
    }
    return runs;
  } catch (_) {
    return [];
  }
}

/**
 * Evaluates flaky test verdict using a sliding window of the last n <= 10 runs.
 */
export function flakyVerdict(runs = []) {
  const normalized = (runs || []).map((r) => {
    if (typeof r === "boolean") return { pass: r };
    if (typeof r === "number") return { pass: r === 1 };
    return { pass: Boolean(r && r.pass) };
  });

  const window = normalized.slice(-10);
  const n = window.length;
  const fails = window.filter((r) => !r.pass).length;
  const passes = n - fails;

  if (n === 0) {
    return {
      verdict: "INSUFFICIENT_DATA",
      allowRepair: true,
      n: 0,
      fails: 0,
      passes: 0,
      oscillation: 0,
    };
  }

  if (fails === 0) {
    return {
      verdict: "HEALTHY",
      allowRepair: true,
      n,
      fails,
      passes,
      oscillation: computeOscillation(window),
    };
  }

  const trailing3Fail = n >= 3 && window.slice(-3).every((r) => !r.pass);
  if (fails === n || trailing3Fail) {
    return {
      verdict: "REPAIRABLE_REGRESSION",
      allowRepair: true,
      n,
      fails,
      passes,
      oscillation: computeOscillation(window),
    };
  }

  if (n < 6) {
    return {
      verdict: "INSUFFICIENT_DATA",
      allowRepair: true,
      n,
      fails,
      passes,
      oscillation: computeOscillation(window),
    };
  }

  const oscillation = computeOscillation(window);
  const wilson = wilsonScoreInterval(fails, n, 1.96);
  const interiorWilson = wilson.lower > 0 && wilson.upper < 1;

  if (oscillation >= 0.4 && interiorWilson) {
    return {
      verdict: "QUARANTINED",
      allowRepair: false,
      n,
      fails,
      passes,
      oscillation,
      wilson,
    };
  }

  return {
    verdict: "REPAIRABLE_REGRESSION",
    allowRepair: true,
    n,
    fails,
    passes,
    oscillation,
    wilson,
  };
}

/**
 * Lists all test suites/commands currently classified as QUARANTINED in .agent/state/flaky.jsonl.
 * @param {string} [root]
 * @returns {Array<object>} Quarantined tests with oscillation & Wilson stats
 */
export function listQuarantinedTests(root = resolveRoot()) {
  const allRuns = readVerifyRuns(root);
  if (allRuns.length === 0) return [];

  // Group by testCmd
  const grouped = new Map();
  for (const run of allRuns) {
    const cmd = run.testCmd || "default";
    if (!grouped.has(cmd)) grouped.set(cmd, []);
    grouped.get(cmd).push(run);
  }

  const quarantined = [];
  for (const [testCmd, runs] of grouped.entries()) {
    const verdict = flakyVerdict(runs);
    if (verdict.verdict === "QUARANTINED") {
      const lastRun = runs[runs.length - 1];
      quarantined.push({
        testCmd,
        verdict: verdict.verdict,
        oscillation: verdict.oscillation,
        fails: verdict.fails,
        passes: verdict.passes,
        n: verdict.n,
        wilson: verdict.wilson,
        lastRunTimestamp: lastRun?.timestamp || new Date().toISOString(),
        lastDurationMs: lastRun?.durationMs || 0,
        fingerprint: lastRun?.fingerprint || null,
      });
    }
  }

  return quarantined;
}

/**
 * Clears flaky ledger entries for all tests or a specific command.
 * @param {string} [root]
 * @param {string} [testCmd]
 */
export function clearFlakyLedger(root = resolveRoot(), testCmd = null) {
  const stateDir = getStateDir(root);
  const filePath = join(stateDir, "flaky.jsonl");
  if (!existsSync(filePath)) return { ok: true, cleared: 0 };

  if (!testCmd) {
    try {
      unlinkSync(filePath);
    } catch (_) {
      writeFileSync(filePath, "", "utf-8");
    }
    return { ok: true, cleared: "all" };
  }

  const runs = readVerifyRuns(root);
  const retained = runs.filter((r) => r.testCmd !== testCmd);
  const clearedCount = runs.length - retained.length;
  writeFileSync(filePath, retained.map((r) => JSON.stringify(r)).join("\n") + (retained.length ? "\n" : ""), "utf-8");
  return { ok: true, cleared: clearedCount, remaining: retained.length };
}

/**
 * Synthesizes a specialized anti-flakiness prompt envelope for a quarantined test.
 * @param {object|string} quarantinedItem - Quarantined item object or test command string
 * @param {object} [options]
 * @returns {{ taskId: string, title: string, prompt: string, role: string, verifyCmd: string, fullEnvelope: string }}
 */
export function synthesizeFlakyHealingTask(quarantinedItem, options = {}) {
  const item = typeof quarantinedItem === "string" ? { testCmd: quarantinedItem, oscillation: 0.5, fails: 3, passes: 3, n: 6 } : quarantinedItem;
  const testCmd = item.testCmd || "npm test";
  const oscillationPct = Math.round((item.oscillation || 0.4) * 100);
  const role = options.role || "janitor";
  const slug = String(testCmd).replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").slice(0, 20).toLowerCase();
  const taskId = options.taskId || `flaky-heal-${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  // Build verification oracle that verifies deterministic stability over multiple consecutive runs
  const verifyOracle = options.verifyCmd || `${testCmd} && ${testCmd} && ${testCmd}`;

  const prompt = `# Task: Eliminate Flaky Test Timing Oscillations & Race Conditions

## Context & Statistical Diagnosis
The test command \`${testCmd}\` has been quarantined by the Wilson-Score Statistical Flaky Guard (Exit Code 8).
- **Oscillation Rate**: ${oscillationPct}% state transitions between passes and failures
- **Total Sample Window**: ${item.n || 6} runs (${item.fails || 3} failures, ${item.passes || 3} passes)
- **Quarantine Verdict**: Statistical non-determinism detected (Wilson CI interior score).

## Root Cause Remediations Required
1. **Eliminate Arbitrary Sleep & Polling Race Conditions**:
   - Replace arbitrary timers (\`sleep()\`, \`setTimeout()\`, \`delay()\`) with deterministic condition-based assertions or event-driven completion promises.
2. **State & Resource Isolation**:
   - Ensure tests clean up global variables, open socket descriptors, temporary filesystem directories, or database handles in \`afterEach\` / teardown hooks.
   - Prevent port collisions by binding to ephemeral ports (port \`0\`) or namespaced mutexes.
3. **Mock Unreliable Boundaries**:
   - Intercept and mock non-deterministic external network calls, system clocks, and asynchronous background timers.
4. **STRICT INVARIANT: NO TEST WEAKENING**:
   - You are **strictly forbidden** from deleting failing assertions, commenting out checks, skipping test cases, or increasing broad timeouts indefinitely to force a pass.
   - The test requirements and assertions must remain 100% rigorous; only the underlying non-determinism, race conditions, or unhandled timing flaws must be fixed.

## Verification Gate
Before opening PR, the test must pass cleanly across consecutive executions without a single oscillation:
\`\`\`bash
${verifyOracle}
\`\`\``;

  const title = `Heal Flaky Test: ${testCmd.slice(0, 50)}`;

  const envelopeMetadata = {
    version: 1,
    id: taskId,
    title,
    role,
    verifyCmd: verifyOracle,
  };

  const fullEnvelope = `<!-- JULES_TASK_ENVELOPE: ${JSON.stringify(envelopeMetadata)} -->
# ${title}
# Task ID: ${taskId}

[TASK INSTRUCTIONS]
${prompt}

[VERIFICATION ORACLE]
Test/Verification Command: ${verifyOracle}
`;

  return {
    taskId,
    title,
    prompt,
    role,
    verifyCmd: verifyOracle,
    fullEnvelope,
    item,
  };
}

/**
 * Runs the Flaky Healing Swarm: scans quarantined tests, synthesizes healing envelopes,
 * and either enqueues them in .agent/jules-queue/ or dispatches them directly.
 * @param {string} [root]
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export async function runFlakyHealingSwarm(root = resolveRoot(), options = {}) {
  const quarantined = listQuarantinedTests(root);
  if (quarantined.length === 0) {
    return { count: 0, tasks: [], message: "No quarantined flaky tests detected in repository." };
  }

  const tasks = [];
  const queueDir = getQueueDir(root);

  for (const item of quarantined) {
    const taskPlan = synthesizeFlakyHealingTask(item, options);
    tasks.push(taskPlan);

    if (options.dryRun) {
      continue;
    }

    if (options.dispatch) {
      const { dispatch } = await import("./engine.mjs");
      const { loadConfig } = await import("./config.mjs");
      const config = loadConfig(root);
      try {
        const session = await dispatch(
          {
            title: taskPlan.title,
            prompt: taskPlan.prompt,
            role: taskPlan.role,
          },
          { root, config }
        );
        taskPlan.session = session;
        taskPlan.dispatched = true;
      } catch (err) {
        taskPlan.dispatchError = err.message;
        taskPlan.dispatched = false;
      }
    } else {
      const fileName = `${taskPlan.taskId}.md`;
      const filePath = join(queueDir, fileName);
      writeFileSync(filePath, taskPlan.fullEnvelope, "utf-8");
      taskPlan.taskFile = filePath;
      taskPlan.queued = true;
    }
  }

  return {
    count: tasks.length,
    tasks,
    queued: !options.dispatch && !options.dryRun,
    dispatched: Boolean(options.dispatch && !options.dryRun),
    dryRun: Boolean(options.dryRun),
  };
}
