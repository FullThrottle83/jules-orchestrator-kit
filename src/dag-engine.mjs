import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { appendTelemetry } from "./telemetry.mjs";
import { parseEnvelopeHeader } from "./envelope.mjs";

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
export function isDagTaskFile(fileName, content, isTaskFile) {
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

export const VALID_SERIALIZE_MODES = ["dispatched", "completed", "merged"];

function extractSessionOutputs(session = {}) {
  const candidates = [];
  if (Array.isArray(session?.raw?.outputs)) candidates.push(...session.raw.outputs);
  if (Array.isArray(session?.outputs)) candidates.push(...session.outputs);
  if (session?.pullRequest) candidates.push(session.pullRequest);
  if (session?.raw?.pullRequest) candidates.push(session.raw.pullRequest);
  if (typeof session?.prUrl === "string") candidates.push(session.prUrl);
  if (typeof session?.url === "string") candidates.push(session.url);
  return candidates;
}

async function queryPrView(prUrl, root, options = {}) {
  if (typeof options.execGh === "function") {
    const res = await options.execGh("pr", ["view", prUrl, "--json", "state,mergedAt"]);
    if (typeof res === "string") return JSON.parse(res);
    return res || {};
  }
  const { spawnSync } = await import("node:child_process");
  const res = spawnSync("gh", ["pr", "view", prUrl, "--json", "state,mergedAt"], {
    cwd: root,
    encoding: "utf-8",
    timeout: 30000,
  });
  if (res.error) {
    throw new Error(`Failed to view PR ${prUrl}: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`gh pr view ${prUrl} failed (exit ${res.status}): ${(res.stderr || "").trim()}`);
  }
  return JSON.parse(res.stdout || "{}");
}

const DEFAULT_PR_POLL_INTERVAL_MS = 15000;

async function waitForPrsMerged(taskId, prUrls, root, options = {}) {
  const pollIntervalMs = Number(options.pollIntervalMs ?? options.prPollIntervalMs ?? DEFAULT_PR_POLL_INTERVAL_MS);
  const timeoutMinutes = Number(options.serializeTimeout ?? options.serializeTimeoutMinutes ?? 15);
  const timeoutMs = Number(
    options.serializeTimeoutMs ??
      (Number.isFinite(timeoutMinutes) && timeoutMinutes > 0 ? timeoutMinutes * 60 * 1000 : 15 * 60 * 1000)
  );
  const deadline = Date.now() + timeoutMs;

  const { appendLedger } = await import("./state.mjs");

  for (const prUrl of prUrls) {
    while (true) {
      const info = await queryPrView(prUrl, root, options);
      const state = String(info?.state || "").toUpperCase();
      const merged = state === "MERGED" || Boolean(info?.mergedAt);
      if (merged) {
        break;
      }
      if (state === "CLOSED") {
        appendLedger({ event: "merge_wait_done", taskId, prUrls, outcome: "PR_CLOSED_UNMERGED", prUrl }, root);
        throw new Error(`PR_CLOSED_UNMERGED: Pull request ${prUrl} for task '${taskId}' was closed without merging.`);
      }
      if (Date.now() >= deadline) {
        appendLedger({ event: "merge_wait_done", taskId, prUrls, outcome: "SERIALIZE_TIMEOUT", prUrl }, root);
        throw new Error(`SERIALIZE_TIMEOUT: Timed out waiting for pull request ${prUrl} (task '${taskId}') to merge.`);
      }
      await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))));
    }
  }

  appendLedger({ event: "merge_wait_done", taskId, prUrls, outcome: "MERGED" }, root);
}

async function scanPendingMergeWaits(root) {
  const { getLedgerPathsInWindow, readLedger } = await import("./state.mjs");
  const pending = new Map();
  let paths = [];
  try {
    paths = getLedgerPathsInWindow(root);
  } catch (_) {
    return pending;
  }
  for (const filePath of paths) {
    for (const entry of readLedger(filePath)) {
      if (!entry || !entry.event || !entry.taskId) continue;
      if (entry.event === "awaiting_merge") {
        pending.set(entry.taskId, {
          taskId: entry.taskId,
          prUrls: Array.isArray(entry.prUrls) ? entry.prUrls : [],
        });
      } else if (entry.event === "merge_wait_done") {
        pending.delete(entry.taskId);
      }
    }
  }
  return pending;
}

export async function executeQueueDag(root = process.cwd(), options = {}) {
  const serializeMode = options.serialize !== undefined && options.serialize !== null
    ? String(options.serialize).trim().toLowerCase()
    : "dispatched";
  if (!VALID_SERIALIZE_MODES.includes(serializeMode)) {
    throw new Error(
      `Invalid --serialize mode '${options.serialize}'. Valid values: ${VALID_SERIALIZE_MODES.join(", ")}`
    );
  }

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

  const timeoutMinutes = Number(options.serializeTimeout ?? options.serializeTimeoutMinutes);
  const customTimeoutMs = Number.isFinite(Number(options.serializeTimeoutMs)) && Number(options.serializeTimeoutMs) > 0
    ? Number(options.serializeTimeoutMs)
    : Number.isFinite(timeoutMinutes) && timeoutMinutes > 0
      ? timeoutMinutes * 60 * 1000
      : undefined;
  // Pass an extended taskTimeout to DagExecutor when serializeTimeout is set so DagExecutor's
  // withTaskTimeout does not pre-empt our explicit SERIALIZE_TIMEOUT error handler.
  const executorTaskTimeout = customTimeoutMs ? customTimeoutMs + 60_000 : 15 * 60 * 1000;

  const executor = new DagExecutor({
    concurrency: options.concurrency || 1,
    taskTimeout: executorTaskTimeout,
  });
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

    let targetFiles = [];

    // Check envelope header (supports agentctl.task/v1 YAML frontmatter and legacy HTML comment)
    const header = parseEnvelopeHeader(content);
    if (header) {
      if (header.id || header.taskId) taskId = header.id || header.taskId;
      if (header.title) title = header.title;
      if (header.role) role = header.role;
      if (header.tier) tier = header.tier;
      if (Array.isArray(header.targetFiles)) targetFiles = header.targetFiles;
      else if (Array.isArray(header.referenced_paths)) targetFiles = header.referenced_paths;
      else if (Array.isArray(header.allowed_paths)) targetFiles = header.allowed_paths;
      else if (header.scope && Array.isArray(header.scope.allow)) targetFiles = header.scope.allow;
      if (Array.isArray(header.dependsOn)) dependsOn = header.dependsOn;
      else if (typeof header.dependsOn === "string") dependsOn = header.dependsOn.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (file.endsWith(".json")) {
      try {
        const parsed = JSON.parse(content);
        if (parsed.id) taskId = parsed.id;
        if (parsed.title) title = parsed.title;
        if (parsed.prompt) prompt = parsed.prompt;
        if (parsed.role) role = parsed.role;
        if (parsed.tier) tier = parsed.tier;
        if (Array.isArray(parsed.targetFiles)) targetFiles = parsed.targetFiles;
        else if (Array.isArray(parsed.referenced_paths)) targetFiles = parsed.referenced_paths;
        if (Array.isArray(parsed.dependsOn)) dependsOn = parsed.dependsOn;
        else if (typeof parsed.dependsOn === "string") dependsOn = parsed.dependsOn.split(",").map((s) => s.trim()).filter(Boolean);
      } catch (_) {}
    }

    taskMap.set(taskId, { file, fullPath, taskId, title, prompt, role, tier, dependsOn, targetFiles });
  }

  // Load completed tasks so overlap-derived dependencies from already-dispatched tasks are preserved on restart
  const completedTaskMap = new Map();
  if (!options.dryRun && existsSync(completedDir)) {
    const completedFiles = readdirSync(completedDir).filter((f) => {
      if (f.startsWith(".")) return false;
      return f.endsWith(".md") || f.endsWith(".json") || f.endsWith(".task");
    });
    for (const file of completedFiles) {
      if (basename(file) !== file) continue;
      const fullPath = join(completedDir, file);
      let content = "";
      try {
        content = readFileSync(fullPath, "utf-8");
      } catch (_) {
        continue;
      }
      if (!isDagTaskFile(file, content, isTaskFile)) continue;
      let taskId = file.replace(/\.(md|json|task)$/, "");
      let targetFiles = [];
      const header = parseEnvelopeHeader(content);
      if (header) {
        if (header.id || header.taskId) taskId = header.id || header.taskId;
        if (Array.isArray(header.targetFiles)) targetFiles = header.targetFiles;
        else if (Array.isArray(header.referenced_paths)) targetFiles = header.referenced_paths;
        else if (Array.isArray(header.allowed_paths)) targetFiles = header.allowed_paths;
        else if (header.scope && Array.isArray(header.scope.allow)) targetFiles = header.scope.allow;
      } else if (file.endsWith(".json")) {
        try {
          const parsed = JSON.parse(content);
          if (parsed.id) taskId = parsed.id;
          if (Array.isArray(parsed.targetFiles)) targetFiles = parsed.targetFiles;
          else if (Array.isArray(parsed.referenced_paths)) targetFiles = parsed.referenced_paths;
        } catch (_) {}
      }
      if (!taskMap.has(taskId)) {
        completedTaskMap.set(taskId, { taskId, targetFiles });
      }
    }
  }

  const pendingMergeWaits = !options.dryRun ? await scanPendingMergeWaits(root) : new Map();

  // Seed fileToLastTaskId with completed tasks that still have an open awaiting_merge record
  const fileToLastTaskId = new Map();
  for (const [compId, compTask] of completedTaskMap.entries()) {
    if (!pendingMergeWaits.has(compId)) continue;
    for (const rawPath of compTask.targetFiles || []) {
      const norm = String(rawPath).replace(/\\/g, "/");
      fileToLastTaskId.set(norm, compId);
    }
  }

  // Auto-serialize concurrent tasks that touch overlapping target files to prevent git merge conflicts
  for (const [taskId, t] of taskMap.entries()) {
    for (const rawPath of t.targetFiles || []) {
      const norm = String(rawPath).replace(/\\/g, "/");
      if (fileToLastTaskId.has(norm)) {
        const priorTaskId = fileToLastTaskId.get(norm);
        if (priorTaskId !== taskId && !t.dependsOn.includes(priorTaskId)) {
          t.dependsOn.push(priorTaskId);
        }
      }
      fileToLastTaskId.set(norm, taskId);
    }
  }

  // Register synthetic resume nodes for dependencies that have an unfinished awaiting_merge record
  const registeredResumeIds = new Set();
  for (const t of taskMap.values()) {
    for (const dep of t.dependsOn) {
      if (!taskMap.has(dep) && pendingMergeWaits.has(dep) && !registeredResumeIds.has(dep)) {
        registeredResumeIds.add(dep);
        const waitRecord = pendingMergeWaits.get(dep);
        executor.addTask({
          id: dep,
          dependsOn: [],
          timeout: executorTaskTimeout,
          runner: async () => {
            await waitForPrsMerged(dep, waitRecord.prUrls, root, options);
          },
        });
      }
    }
  }

  // Register each task with its dependencies that are part of this queue run (or resumed merge waits)
  for (const [taskId, t] of taskMap.entries()) {
    const validDeps = t.dependsOn.filter((dep) => taskMap.has(dep) || registeredResumeIds.has(dep));
    executor.addTask({
      id: taskId,
      dependsOn: validDeps,
      timeout: executorTaskTimeout,
      runner: async () => {
        const srcPath = t.fullPath;
        const taskObj = { id: t.taskId, title: t.title, prompt: t.prompt, role: t.role, tier: t.tier };
        let session;
        let pollingProvider = options.provider || null;
        const onProviderResolved = (provider) => { pollingProvider = provider; };
        if (typeof options.dispatchFn === "function") {
          session = await options.dispatchFn(taskObj, {
            root, config: options.config, dryRun: options.dryRun, onProviderResolved,
          });
        } else {
          const { dispatch } = await import("./engine.mjs");
          session = await dispatch(taskObj, {
            root, config: options.config, dryRun: options.dryRun,
            provider: options.provider, onProviderResolved,
          });
        }

        if (session && session.ok === false) {
          results.push({ file: t.file, taskId: t.taskId, ok: false, status: session.status, error: session.error, session });
          throw new Error(`DAG Task '${t.taskId}' failed: ${session.error || session.status || "Unknown error"}`);
        }

        // Keep the existing rename into completed/ right after a successful dispatch,
        // so a restart does not dispatch task A a second time.
        if (!options.dryRun) {
          const dstPath = join(completedDir, t.file);
          if (existsSync(srcPath)) {
            if (!existsSync(dstPath)) {
              renameSync(srcPath, dstPath);
            }
          }
        }

        if (!options.dryRun && (serializeMode === "completed" || serializeMode === "merged")) {
          const { pollSessionState } = await import("./engine.mjs");
          const pollTimeoutMs = customTimeoutMs || 15 * 60 * 1000;
          const pollIntervalMs = options.pollIntervalMs ?? 5_000;
          const pollVerdict = await pollSessionState(pollingProvider, session, {
            root,
            dryRun: false,
            pollFn: options.pollFn,
            pollIntervalMs,
            maxPollAttempts: options.maxPollAttempts ?? Math.ceil(pollTimeoutMs / Math.max(1, pollIntervalMs)) + 1,
            pollTimeoutMs,
            task: taskObj,
          });

          if (pollVerdict.blockedOn) {
            throw new Error(`DAG Task '${t.taskId}' blocked on actor (${pollVerdict.blockedOn})`);
          }
          if (String(pollVerdict.status || "").toUpperCase() === "FAILED") {
            throw new Error(`DAG Task '${t.taskId}' session FAILED`);
          }
          if (!pollVerdict.terminal) {
            throw new Error(
              `DAG Task '${t.taskId}' session did not reach a terminal state (status: ${pollVerdict.status || "UNKNOWN"})`
            );
          }

          if (serializeMode === "merged") {
            const { extractPrUrls } = await import("./swarm.mjs");
            const { appendLedger } = await import("./state.mjs");
            const outputs = [
              ...extractSessionOutputs(pollVerdict),
              ...extractSessionOutputs(session),
            ];
            const prUrls = extractPrUrls(outputs);
            if (prUrls.length === 0) {
              throw new Error(`NO_PR_TO_WAIT_FOR: Task '${t.taskId}' reached terminal state with no pull request URL.`);
            }
            appendLedger({ event: "awaiting_merge", taskId: t.taskId, prUrls }, root);
            await waitForPrsMerged(t.taskId, prUrls, root, options);
          }
        }

        results.push({ file: t.file, taskId: t.taskId, ok: true, dryRun: Boolean(options.dryRun), session });
      },
    });
  }

  await executor.execute({ concurrency: options.concurrency || 1, taskTimeout: executorTaskTimeout, root });
  return { processed: results.length, results };
}


