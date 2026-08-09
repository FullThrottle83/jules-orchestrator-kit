import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

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
 * Zero-Dependency Task DAG Executor with cycle detection and interface fingerprinting.
 */
export class DagExecutor {
  constructor({ concurrency = 4 } = {}) {
    this.concurrency = concurrency;
    this.tasks = new Map();
  }

  /**
   * Registers a task into the DAG.
   * @param {Object} task
   * @param {string} task.id
   * @param {string[]} [task.dependsOn=[]]
   * @param {string[]} [task.outputs=[]]
   * @param {Function} [task.runner]
   */
  addTask({ id, dependsOn = [], outputs = [], runner }) {
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
   */
  async execute({ concurrency = this.concurrency } = {}) {
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
                const expectedHash = fingerprints.get(outputFile);
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

          (async () => {
            try {
              executionHistory.push(taskId);
              await task.runner({
                id: task.id,
                dependsOn: task.dependsOn,
                outputs: task.outputs,
                fingerprints,
              });

              // Post-task Interface Fingerprinting
              for (const outputFile of task.outputs) {
                const hash = this._computeFileHash(outputFile);
                fingerprints.set(outputFile, hash);
              }

              running.delete(taskId);
              completed.add(taskId);

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
