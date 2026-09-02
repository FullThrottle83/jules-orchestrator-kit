import { execSync } from "node:child_process";
import { resolveVerify } from "./config.mjs";
import { computeOscillation } from "./flaky-ledger.mjs";

/**
 * Executes a test command repeatedly to probe for race conditions, non-deterministic timers, or test flakiness.
 *
 * @param {string} [testCmd] - Test command to execute repeatedly
 * @param {object} [options]
 * @param {string} [options.root=process.cwd()] - Project root directory
 * @param {number} [options.repeat=5] - Number of consecutive iterations to execute
 * @param {number} [options.minPassRate=1.0] - Required minimum pass rate (0.0 - 1.0)
 * @param {number} [options.timeoutMs=30000] - Timeout per iteration in milliseconds
 * @returns {object} { ok, repeat, passes, failures, passRate, oscillation, runs, durationMs, summary }
 */
export function runStabilityProbe(testCmd, options = {}) {
  const root = options.root || process.cwd();
  const cmd = testCmd || resolveVerify(root).testCmd || "npm test";
  const repeat = typeof options.repeat === "number" && options.repeat > 0 ? options.repeat : 5;
  const minPassRate = typeof options.minPassRate === "number" ? options.minPassRate : 1.0;
  const timeoutMs = options.timeoutMs || 30000;

  const runs = [];
  let passes = 0;
  let failures = 0;
  const startTime = Date.now();

  for (let i = 1; i <= repeat; i++) {
    const runStart = Date.now();
    let pass = false;
    let exitCode = 0;
    let stdout = "";
    let stderr = "";

    try {
      const env = { ...process.env };
      for (const k of Object.keys(env)) {
        if (k.startsWith("NODE_TEST_") || k.startsWith("NODE_CHANNEL_")) {
          delete env[k];
        }
      }

      stdout = execSync(cmd, {
        cwd: root,
        env,
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      });
      pass = true;
      passes++;
    } catch (err) {
      exitCode = err.status || 1;
      stdout = err.stdout ? String(err.stdout) : "";
      stderr = err.stderr ? String(err.stderr) : err.message;
      failures++;
    }

    const duration = Date.now() - runStart;
    runs.push({
      iteration: i,
      pass,
      exitCode,
      durationMs: duration,
      stdout: stdout.slice(0, 500),
      stderr: stderr.slice(0, 500),
    });
  }

  const passRate = passes / repeat;
  const oscillation = computeOscillation(runs.map((r) => r.pass));
  const totalDuration = Date.now() - startTime;
  const ok = passRate >= minPassRate && (failures === 0 || oscillation === 0);

  return {
    ok,
    repeat,
    passes,
    failures,
    passRate: Math.round(passRate * 100) / 100,
    oscillation: Math.round(oscillation * 100) / 100,
    runs,
    durationMs: totalDuration,
    summary: `Stability Probe: ${passes}/${repeat} passed (${Math.round(passRate * 100)}% pass rate, oscillation: ${oscillation})`,
  };
}
