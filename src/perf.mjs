import { monitorEventLoopDelay } from "node:perf_hooks";
import { execSync } from "node:child_process";
import { resolveVerify } from "./config.mjs";

/**
 * Measures Node.js Event Loop delay during test execution or asynchronous workloads
 * to detect synchronous blocking, catastrophic regex backtracking, or O(n^2) starvation.
 *
 * @param {string|Function} target - Command line string to execute or async/sync function
 * @param {object} [options]
 * @param {string} [options.root=process.cwd()] - Working directory
 * @param {number} [options.maxDelayMs=50] - Maximum allowable p99/max event loop delay in milliseconds
 * @param {number} [options.resolution=10] - Sampling resolution in milliseconds (default: 10)
 * @param {number} [options.timeoutMs=60000] - Process timeout in milliseconds
 * @returns {object} { ok, maxMs, meanMs, p50Ms, p90Ms, p99Ms, minMs, thresholdMs, summary, stdout, stderr, exitCode }
 */
export function measureEventLoopDelay(target, options = {}) {
  const root = options.root || process.cwd();
  const maxDelayMs = typeof options.maxDelayMs === "number" ? options.maxDelayMs : 50;
  const resolution = options.resolution || 10;
  const timeoutMs = options.timeoutMs || 60000;

  const histogram = monitorEventLoopDelay({ resolution });
  histogram.enable();

  let exitCode = 0;
  let stdout = "";
  let stderr = "";

  const startTime = Date.now();

  try {
    if (typeof target === "function") {
      target();
    } else {
      const cmd = target || resolveVerify(root).testCmd || "npm test";
      const env = { ...process.env };
      for (const k of Object.keys(env)) {
        if (k.startsWith("NODE_TEST_") || k.startsWith("NODE_CHANNEL_")) {
          delete env[k];
        }
      }

      try {
        stdout = execSync(cmd, {
          cwd: root,
          env,
          timeout: timeoutMs,
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf-8",
        });
      } catch (err) {
        exitCode = err.status || 1;
        stdout = err.stdout ? String(err.stdout) : "";
        stderr = err.stderr ? String(err.stderr) : err.message;
      }
    }
  } finally {
    histogram.disable();
  }

  const durationMs = Date.now() - startTime;

  // Convert nanoseconds to milliseconds
  const minMs = Math.round((histogram.min / 1e6) * 100) / 100;
  const maxMs = Math.round((histogram.max / 1e6) * 100) / 100;
  const meanMs = Number.isFinite(histogram.mean) ? Math.round((histogram.mean / 1e6) * 100) / 100 : 0;
  const p50Ms = Math.round((histogram.percentile(50) / 1e6) * 100) / 100;
  const p90Ms = Math.round((histogram.percentile(90) / 1e6) * 100) / 100;
  const p99Ms = Math.round((histogram.percentile(99) / 1e6) * 100) / 100;

  // If p99 or max exceeds threshold, mark as lag violation
  const ok = exitCode === 0 && (p99Ms <= maxDelayMs || maxMs <= maxDelayMs);

  const summary = `Event Loop Delay: p99=${p99Ms}ms, max=${maxMs}ms, mean=${meanMs}ms (threshold: ${maxDelayMs}ms, duration: ${durationMs}ms)`;

  return {
    ok,
    minMs,
    maxMs,
    meanMs,
    p50Ms,
    p90Ms,
    p99Ms,
    thresholdMs: maxDelayMs,
    durationMs,
    exitCode,
    stdout,
    stderr,
    summary,
  };
}
