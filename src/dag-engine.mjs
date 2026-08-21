import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { appendTelemetry } from "./telemetry.mjs";

/**
 * Custom error thrown when a circular dependency is detected in the DAG.
 */
export class DagCycleError extends Error {
  constructor(cyclePath) {
    const pathStr = Array.isArray(cyclePath) ? cyclePath.join(" -> ") : String(cyclePath);
    super(`Circular dependency detected: ${pathStr}`);
    this.name = "DagCycleError";
    this.cyclePath = cyclePath;
  }
}

/**
 * Wraps an async runner function with a timeout (default 15 minutes = 900,000 ms).
 * @param {Function} runner
 * @param {number} [timeoutMs=900000]
 * @returns {Promise<any>}
 */
export async function withTaskTimeout(runner, timeoutMs = 15 * 60 * 1000) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Task execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([runner(), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Zero-Dependency Task DAG Executor with cycle detection, interface fingerprinting, and execution freezing.
 */
export class DagExecutor {
  constructor({ concurrency = 4, taskTimeout = 15 * 60 * 1000 } = {}) {
    this.concurrency = concurrency;
    this.taskTimeout = taskTimeout;
    this.tasks = new Map();
    this.isExecuting = false;
  }

  /**
   * Registers a task into the DAG. Throws if called after execution has started.
   * @param {Object} task
   * @param {string} task.id
   * @param {string[]} [task.dependsOn=[]]
   * @param {string[]} [task.outputs=[]]
   * @param {Function} [task.runner]
   * @param {number} [task.timeout]
   */
  addTask({ id, dependsOn = [], outputs = [], runner, timeout }) {
    if (this.isExecuting) {
      throw new Error("Cannot add task after execution has started");
    }
    if (!id || typeof id !== "string") {
      throw new Error("Task id must be a non-empty string");
    }
    if (this.tasks.has(id)) {
      throw new Error(`Task with id '${id}' already exists`);
    }
    this.tasks.set(id, {
      id,
      dependsOn: Array.isArray(dependsOn) ? [...dependsOn] : [],
      outputs: Array.isArray(outputs) ? [...outputs] : [],
      runner: runner || (async () => {}),
      timeout,
    });
  }

  /**
   * Validates the DAG, resolves dependencies using Kahn's algorithm, and checks for cycles.
   * Throws DagCycleError if a cycle is detected.
   */
  validateDag() {
    const totalNodes = this.tasks.size;
    if (totalNodes === 0) return { executionOrder: [], dependents: new Map() };

    const inDegree = new Map();
    const dependents = new Map();

    for (const id of this.tasks.keys()) {
      inDegree.set(id, 0);
      dependents.set(id, []);
    }

    for (const [id, task] of this.tasks.entries()) {
      for (const depId of task.dependsOn) {
        if (!this.tasks.has(depId)) {
          throw new Error(`Task '${id}' depends on missing task '${depId}'`);
        }
        inDegree.set(id, inDegree.get(id) + 1);
        dependents.get(depId).push(id);
      }
    }

    const queue = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) {
        queue.push(id);
      }
    }
    queue.sort();

    const executionOrder = [];
    let processedNodes = 0;
    const currentInDegree = new Map(inDegree);

    while (queue.length > 0) {
      queue.sort();
      const node = queue.shift();
      executionOrder.push(node);
      processedNodes++;

      for (const neighbor of dependents.get(node)) {
        const newDeg = currentInDegree.get(neighbor) - 1;
        currentInDegree.set(neighbor, newDeg);
        if (newDeg === 0) {
          queue.push(neighbor);
        }
      }
    }

    if (processedNodes !== totalNodes) {
      const cyclePath = this._findCyclePath();
      throw new DagCycleError(cyclePath);
    }

    return { executionOrder, dependents };
  }

  /**
   * Finds the exact circular path sequence in the task dependency graph.
   * @private
   */
  _findCyclePath() {
    const visited = new Set();
    const stack = [];
    const stackSet = new Set();

    const dfs = (nodeId) => {
      visited.add(nodeId);
      stack.push(nodeId);
      stackSet.add(nodeId);

      const task = this.tasks.get(nodeId);
      if (task) {
        for (const depId of task.dependsOn) {
          if (!this.tasks.has(depId)) continue;
          if (!visited.has(depId)) {
            const res = dfs(depId);
            if (res) return res;
          } else if (stackSet.has(depId)) {
            const cycleStartIdx = stack.indexOf(depId);
            const rawCycle = stack.slice(cycleStartIdx);
            rawCycle.push(depId);
            return rawCycle;
          }
        }
      }

      stack.pop();
      stackSet.delete(nodeId);
      return null;
    };

    // Sort keys lexicographically for deterministic cycle path detection
    const sortedKeys = Array.from(this.tasks.keys()).sort();
    for (const id of sortedKeys) {
      if (!visited.has(id)) {
        const cycle = dfs(id);
        if (cycle) {
          return cycle.reverse();
        }
      }
    }

    return sortedKeys;
  }

  /**
   * Computes SHA-256 hash of a file path using node:crypto.
   * @private
   */
  _computeFileHash(filePath) {
    if (!existsSync(filePath)) {
      return createHash("sha256").update("").digest("hex");
    }
    const content = readFileSync(filePath);
    return createHash("sha256").update(content).digest("hex");
  }

  /**
   * Executes tasks in topological order with parallel concurrency and interface fingerprinting.
   * @param {Object} [options]
   * @param {number} [options.concurrency]
   * @param {number} [options.taskTimeout]
   * @param {string} [options.root]
   * @param {Object} [options.progressBus]
   * @param {string} [options.progressToken]
   */
  async execute({
    concurrency = this.concurrency,
    taskTimeout = this.taskTimeout,
    root,
    progressBus,
    progressToken,
  } = {}) {
    this.isExecuting = true;
    const { dependents } = this.validateDag();

    const completed = new Set();
    const running = new Set();
    const fingerprints = new Map();
    const executionHistory = [];

    const inDegree = new Map();
    for (const [id, task] of this.tasks.entries()) {
      inDegree.set(id, task.dependsOn.length);
    }

    return new Promise((resolve, reject) => {
      let isSettled = false;

      const fail = (err) => {
        if (!isSettled) {
          isSettled = true;
          reject(err);
        }
      };

      const checkAndSchedule = async () => {
        if (isSettled) return;

        if (completed.size === this.tasks.size) {
          isSettled = true;
          return resolve({ executionHistory, fingerprints });
        }

        const readyTasks = [];
        for (const [id, deg] of inDegree.entries()) {
          if (deg === 0 && !completed.has(id) && !running.has(id)) {
            readyTasks.push(id);
          }
        }

        readyTasks.sort();

        while (running.size < concurrency && readyTasks.length > 0) {
          const taskId = readyTasks.shift();
          const task = this.tasks.get(taskId);

          // Verification Gate & Interface Fingerprint Check
          try {
            for (const depId of task.dependsOn) {
              const depTask = this.tasks.get(depId);
              for (const outputFile of depTask.outputs) {
                const expectedHash = fingerprints.get(`${depId}:${outputFile}`) ?? fingerprints.get(outputFile);
                const actualHash = this._computeFileHash(outputFile);
                if (expectedHash !== actualHash) {
                  throw new Error(
                    `Interface fingerprint mismatch for output '${outputFile}' from dependency '${depId}'`
                  );
                }
              }
            }
          } catch (gateErr) {
            return fail(gateErr);
          }

          running.add(taskId);
          if (root) appendTelemetry(root, "dag_task_started", { taskId });

          (async () => {
            try {
              executionHistory.push(taskId);
              const timeoutMs = task.timeout || taskTimeout;
              await withTaskTimeout(
                () =>
                  task.runner({
                    id: task.id,
                    dependsOn: task.dependsOn,
                    outputs: task.outputs,
                    fingerprints,
                  }),
                timeoutMs
              );

              // Post-task Interface Fingerprinting (keyed by taskId:filePath and filePath alias)
              for (const outputFile of task.outputs) {
                const hash = this._computeFileHash(outputFile);
                fingerprints.set(`${taskId}:${outputFile}`, hash);
                fingerprints.set(outputFile, hash);
              }

              running.delete(taskId);
              completed.add(taskId);

              if (root) appendTelemetry(root, "dag_task_completed", { taskId });
              if (progressBus && progressToken) {
                const pct = Math.round((completed.size / this.tasks.size) * 100);
                progressBus.reportProgress(
                  progressToken,
                  pct,
                  100,
                  `Task ${taskId} completed (${completed.size}/${this.tasks.size})`
                );
              }

              for (const depNode of dependents.get(taskId)) {
                inDegree.set(depNode, inDegree.get(depNode) - 1);
              }

              checkAndSchedule();
            } catch (err) {
              running.delete(taskId);
              fail(err);
            }
          })();
        }
      };

      checkAndSchedule();
    });
  }
}

/**
 * Global Contract Trigger List:
 * Files matching these patterns are considered global structural contracts.
 * If ANY modified file matches these patterns, selective test execution MUST yield to full test suite execution (returns null).
 */
export const GLOBAL_CONTRACT_PATTERNS = [
  /^package(-lock)?\.json$/,
  /^pnpm-lock\.yaml$/,
  /^yarn\.lock$/,
  /^tsconfig.*\.json$/,
  /^schema\./,
  /\.d\.ts$/,
  /^\.env/,
  /^\.agent\//,
  /^Cargo\.(toml|lock)$/,
  /^go\.(mod|sum)$/,
  /^composer\.(json|lock)$/,
];

/**
 * Checks if a relative file path matches global contract triggers.
 */
export function isGlobalContractFile(filePath = "") {
  if (typeof filePath !== "string") return false;
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const baseName = normalized.split("/").pop();
  return GLOBAL_CONTRACT_PATTERNS.some((pattern) => pattern.test(normalized) || pattern.test(baseName));
}

/**
 * Resolves affected test files based on modified files and static import analysis.
 * Returns null if full test suite should be executed (due to global contract change or unknown dependency),
 * or an array of affected test file paths.
 */
export function resolveAffectedTests(modifiedFiles = [], options = {}) {
  if (!Array.isArray(modifiedFiles) || modifiedFiles.length === 0) {
    return [];
  }

  // 1. Check Global Contract Trigger List
  for (const file of modifiedFiles) {
    if (isGlobalContractFile(file)) {
      return null; // Force full test suite execution
    }
  }

  const knownTestFiles = Array.isArray(options.knownTestFiles) ? options.knownTestFiles : [];
  const testSuffixRegex = options.testSuffixRegex || /\.(test|spec)\.(m?[jt]sx?|py|rs|go)$/i;

  const affected = new Set();

  for (const file of modifiedFiles) {
    if (typeof file !== "string") continue;
    const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");

    // If the modified file itself is a test file, add it directly
    if (testSuffixRegex.test(normalized)) {
      affected.add(normalized);
      continue;
    }

    // Match known test files that import or reference this file/module
    const baseNameNoExt = normalized.split("/").pop().replace(/\.[^/.]+$/, "");
    for (const testFile of knownTestFiles) {
      if (typeof testFile !== "string") continue;
      const normTest = testFile.replace(/\\/g, "/").replace(/^\.\//, "");
      if (normTest.includes(baseNameNoExt)) {
        affected.add(normTest);
      }
    }
  }

  return affected.size > 0 ? Array.from(affected) : null;
}

/**
 * Loads tasks from the queue directory and executes them via DagExecutor.
 * Supports task files with metadata (JSON or Markdown envelopes with dependsOn).
 * @param {string} [root=process.cwd()]
 * @param {Object} [options]
 * @param {number} [options.concurrency=1]
 * @param {boolean} [options.dryRun=false]
 * @param {Function} [options.dispatchFn]
 * @param {Object} [options.config]
 * @returns {Promise<{ processed: number, results: Array<any> }>}
 */
/**
 * Decides whether a queue-directory entry is a task this runner should execute.
 *
 * The DAG runner accepts more shapes than `isTaskFile` does — `.json` and
 * `.task` envelopes as well as Markdown — but "every `.json` in the queue
 * folder" also swept up manifests (swarm run files, indexes). A manifest has no
 * `prompt`, so the whole file became the prompt and a large one blew the
 * provider payload limit. Shape decides, not the extension.
 *
 * @param {string} fileName
 * @param {string} content
 * @param {Function} isTaskFile - `isTaskFile` from engine.mjs, passed in to avoid a circular import.
 * @returns {boolean}
 */
function isDagTaskFile(fileName, content, isTaskFile) {
  if (fileName.endsWith(".task")) return true;
  if (fileName.endsWith(".md")) return isTaskFile(fileName, content);
  if (fileName.endsWith(".json")) {
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (_) {
      return false;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    // A manifest *describes* tasks; a task envelope *is* one.
    if (Array.isArray(parsed.tasks) || Array.isArray(parsed.envelopes)) return false;
    return typeof parsed.prompt === "string" && parsed.prompt.length > 0;
  }
  return false;
}

export async function executeQueueDag(root = process.cwd(), options = {}) {
  const { readdirSync, renameSync, mkdirSync } = await import("node:fs");
  const { join, basename } = await import("node:path");
  const { isTaskFile } = await import("./engine.mjs");

  const queueDir = join(root, ".agent", "jules-queue");
  const fallbackQueueDir = join(root, ".agent", "queue");
  const actualQueueDir = existsSync(queueDir) ? queueDir : (existsSync(fallbackQueueDir) ? fallbackQueueDir : queueDir);
  const completedDir = join(actualQueueDir, "completed");

  if (!existsSync(actualQueueDir)) {
    return { processed: 0, results: [] };
  }
  if (!existsSync(completedDir) && !options.dryRun) {
    try {
      mkdirSync(completedDir, { recursive: true });
    } catch (_) {}
  }

  const files = readdirSync(actualQueueDir).filter((f) => {
    if (f === "completed" || f.startsWith(".")) return false;
    return f.endsWith(".md") || f.endsWith(".json") || f.endsWith(".task");
  });

  if (files.length === 0) {
    return { processed: 0, results: [] };
  }

  const executor = new DagExecutor({ concurrency: options.concurrency || 1 });
  const taskMap = new Map();
  const results = [];

  for (const file of files) {
    if (basename(file) !== file) continue;
    const fullPath = join(actualQueueDir, file);
    const content = readFileSync(fullPath, "utf-8");
    if (!isDagTaskFile(file, content, isTaskFile)) continue;
    let taskId = file.replace(/\.(md|json|task)$/, "");
    let dependsOn = [];
    let title = taskId;
    let prompt = content;
    let role = undefined;
    let tier = undefined;

    // Check envelope header
    const match = content.match(/<!--\s*JULES_TASK_ENVELOPE:\s*({[\s\S]*?})\s*-->/);
    if (match) {
      try {
        const meta = JSON.parse(match[1]);
        if (meta.id) taskId = meta.id;
        if (meta.title) title = meta.title;
        if (meta.role) role = meta.role;
        if (meta.tier) tier = meta.tier;
        if (Array.isArray(meta.dependsOn)) dependsOn = meta.dependsOn;
        else if (typeof meta.dependsOn === "string") dependsOn = meta.dependsOn.split(",").map((s) => s.trim()).filter(Boolean);
      } catch (_) {}
    } else if (file.endsWith(".json")) {
      try {
        const parsed = JSON.parse(content);
        if (parsed.id) taskId = parsed.id;
        if (parsed.title) title = parsed.title;
        if (parsed.prompt) prompt = parsed.prompt;
        if (parsed.role) role = parsed.role;
        if (parsed.tier) tier = parsed.tier;
        if (Array.isArray(parsed.dependsOn)) dependsOn = parsed.dependsOn;
        else if (typeof parsed.dependsOn === "string") dependsOn = parsed.dependsOn.split(",").map((s) => s.trim()).filter(Boolean);
      } catch (_) {}
    }

    taskMap.set(taskId, { file, fullPath, taskId, title, prompt, role, tier, dependsOn });
  }

  // Register each task with its dependencies that are part of this queue run
  for (const [taskId, t] of taskMap.entries()) {
    const validDeps = t.dependsOn.filter((dep) => taskMap.has(dep));
    executor.addTask({
      id: taskId,
      dependsOn: validDeps,
      runner: async () => {
        const srcPath = t.fullPath;
        const taskObj = { id: t.taskId, title: t.title, prompt: t.prompt, role: t.role, tier: t.tier };
        let session;
        if (typeof options.dispatchFn === "function") {
          session = await options.dispatchFn(taskObj, { root, config: options.config, dryRun: options.dryRun });
        } else {
          const { dispatch } = await import("./engine.mjs");
          session = await dispatch(taskObj, { root, config: options.config, dryRun: options.dryRun });
        }

        if (session && session.ok === false) {
          results.push({ file: t.file, taskId: t.taskId, ok: false, status: session.status, error: session.error, session });
          throw new Error(`DAG Task '${t.taskId}' failed: ${session.error || session.status || "Unknown error"}`);
        } else {
          // A dry run simulates; it must leave the queue exactly as it found it,
          // or the second `--dry-run` sees an empty queue.
          if (!options.dryRun) {
            const dstPath = join(completedDir, t.file);
            if (existsSync(srcPath)) {
              if (!existsSync(dstPath)) {
                renameSync(srcPath, dstPath);
              }
            }
          }
          results.push({ file: t.file, taskId: t.taskId, ok: true, dryRun: Boolean(options.dryRun), session });
        }
      },
    });
  }

  await executor.execute({ concurrency: options.concurrency || 1, root });
  return { processed: results.length, results };
}

