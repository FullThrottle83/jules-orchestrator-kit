import {
  readFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  renameSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createOperationReceipt } from "./receipts.mjs";
import { withVfsMutex } from "../state.mjs";

/**
 * @typedef {import("../ux/capabilities.mjs").TerminalSessionOptions} TerminalSessionOptions
 */

/**
 * Calculate file SHA-256 hash.
 * @param {string} filePath
 * @returns {string | null}
 */
function getFileHash(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const data = readFileSync(filePath);
    return "sha256:" + createHash("sha256").update(data).digest("hex");
  } catch {
    return null;
  }
}

function resolveWithinRoot(root, candidate, label) {
  if (typeof candidate !== "string" || !candidate || candidate.includes("\0")) {
    throw new Error(`Invalid ${label} path`);
  }
  const targetPath = resolve(root, candidate);
  const rel = relative(resolve(root), targetPath);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`${label} path escapes repository root: ${candidate}`);
  }
  return targetPath;
}

function atomicWriteFile(filePath, content) {
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(tmpPath, "wx", 0o600);
    writeSync(fd, content, "utf-8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, filePath);
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch (_) {}
    }
    try { unlinkSync(tmpPath); } catch (_) {}
    throw err;
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason || new Error("Action plan application aborted");
  }
}

/**
 * Verify preconditions of an ActionPlan against target repository state.
 * @param {import("../ux/capabilities.mjs").ActionPlan} plan
 * @param {string} root
 */
export function verifyPreconditions(plan, root) {
  for (const cond of plan.preconditions || []) {
    if (cond.kind === "file-hash") {
      const targetPath = resolveWithinRoot(root, cond.target, "Precondition target");
      const actualHash = getFileHash(targetPath);
      if (actualHash !== cond.expected) {
        throw new Error(
          `Precondition failed [file-hash]: ${cond.target} expected ${cond.expected}, received ${actualHash}`
        );
      }
    } else if (cond.kind === "lock-free") {
      const lockTarget = String(cond.target || "");
      const lockBase = resolveWithinRoot(root, join(".agent", "state", "locks", lockTarget), "Lock target");
      const lockPaths = [`${lockBase}.json`, `${lockBase}.lock`];
      if (lockPaths.some((lockPath) => existsSync(lockPath))) {
        throw new Error(`Precondition failed [lock-free]: Lock ${cond.target} is active.`);
      }
    }
  }
}

/**
 * Execute an ActionPlan within a transactional boundaries (atomic apply + rollback).
 * @param {any} plan
 * @param {Object} options
 * @param {string} options.root
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<import("./receipts.mjs").OperationReceipt>}
 */
export async function applyActionPlan(plan, options = {}) {
  const root = resolve(options.root || process.cwd());
  const mutexDir = join(root, ".agent", "state", ".action-plan.mutex");
  mkdirSync(dirname(mutexDir), { recursive: true });
  return withVfsMutex(mutexDir, () => applyActionPlanLocked(plan, { ...options, root }));
}

async function applyActionPlanLocked(plan, options) {
  const root = options.root;
  const startTime = Date.now();
  throwIfAborted(options.signal);

  // 1. Verify Preconditions
  verifyPreconditions(plan, root);

  // 2. Prepare Intent Journaling
  if (!plan || typeof plan.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(plan.id)) {
    throw new Error("Invalid action plan id");
  }
  const journalDir = join(root, ".agent", "state", "journal");
  if (!existsSync(journalDir)) {
    mkdirSync(journalDir, { recursive: true });
  }
  const journalPath = join(journalDir, `${plan.id}.intent.json`);
  atomicWriteFile(journalPath, JSON.stringify({ plan, startedAt: new Date().toISOString() }, null, 2));

  /** @type {Array<{ path: string, originalContent: string | null, operation?: string, fromPath?: string, sourceContent?: string }>} */
  const rollbackStack = [];
  const mutationsApplied = [];
  const effectsExecuted = [];

  try {
    // 3. Apply File Mutations
    for (const mutation of plan.fileMutations || []) {
      throwIfAborted(options.signal);
      const targetPath = resolveWithinRoot(root, mutation.path, "Mutation target");

      if (mutation.operation === "move") {
        const sourcePath = resolveWithinRoot(root, mutation.fromPath, "Move source");
        if (sourcePath === targetPath) {
          throw new Error(`Move source and target are identical: ${mutation.path}`);
        }
        if (!existsSync(sourcePath)) {
          throw new Error(`Move source does not exist: ${mutation.fromPath}`);
        }
        if (existsSync(targetPath)) {
          throw new Error(`Move target already exists: ${mutation.path}`);
        }
        const sourceContent = readFileSync(sourcePath, "utf-8");
        const sourceHash = "sha256:" + createHash("sha256").update(sourceContent).digest("hex");
        mkdirSync(dirname(targetPath), { recursive: true });
        rollbackStack.push({
          path: targetPath,
          originalContent: null,
          operation: "move",
          fromPath: sourcePath,
          sourceContent,
        });
        renameSync(sourcePath, targetPath);
        mutationsApplied.push({ path: mutation.path, operation: "move", hashBefore: sourceHash });
        continue;
      }

      if (!["delete", "create", "replace"].includes(mutation.operation)) {
        throw new Error(`Unsupported file mutation operation: ${mutation.operation}`);
      }

      const parentDir = dirname(targetPath);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }

      const existingContent = existsSync(targetPath) ? readFileSync(targetPath, "utf-8") : null;
      const hashBefore = existingContent !== null
        ? "sha256:" + createHash("sha256").update(existingContent).digest("hex")
        : undefined;

      if (mutation.operation === "create" && existingContent !== null) {
        throw new Error(`Create target already exists: ${mutation.path}`);
      }
      rollbackStack.push({ path: targetPath, originalContent: existingContent, operation: mutation.operation });

      if (mutation.operation === "delete") {
        if (existsSync(targetPath)) {
          unlinkSync(targetPath);
        }
        mutationsApplied.push({ path: mutation.path, operation: "delete", hashBefore });
      } else {
        const newContent = mutation.newContent ?? "";
        atomicWriteFile(targetPath, newContent);

        const hashAfter = "sha256:" + createHash("sha256").update(newContent).digest("hex");
        mutationsApplied.push({ path: mutation.path, operation: mutation.operation, hashBefore, hashAfter });
      }
    }

    // 4. Execute Command Effects
    for (const effect of plan.commandEffects || []) {
      throwIfAborted(options.signal);
      const execPath = effect.executable;
      const args = Array.isArray(effect.args) ? effect.args : [];
      const cwd = effect.cwd ? resolveWithinRoot(root, effect.cwd, "Command working directory") : root;

      try {
        execFileSync(execPath, args, {
          cwd,
          timeout: effect.timeoutMs || 30000,
          env: process.env,
        });
        effectsExecuted.push({ executable: execPath, args, exitCode: 0 });
      } catch (err) {
        const exitCode = typeof err.status === "number" ? err.status : 1;
        effectsExecuted.push({ executable: execPath, args, exitCode });
        throw new Error(`Command effect failed (${execPath} ${args.join(" ")}): exit code ${exitCode}`);
      }
    }

    // 5. Clean up Journal & Record Success Receipt
    if (existsSync(journalPath)) {
      unlinkSync(journalPath);
    }

    const receipt = createOperationReceipt(root, {
      actionPlanId: plan.id,
      kind: plan.kind,
      title: plan.title,
      repository: plan.repository || "local",
      status: "success",
      durationMs: Date.now() - startTime,
      mutationsApplied,
      effectsExecuted,
    });

    return receipt;
  } catch (err) {
    // Execute Rollback Stack in reverse order
    for (let i = rollbackStack.length - 1; i >= 0; i--) {
      const mutation = rollbackStack[i];
      try {
        if (mutation.operation === "move") {
          if (existsSync(mutation.path) && !existsSync(mutation.fromPath)) {
            renameSync(mutation.path, mutation.fromPath);
          }
        } else if (mutation.originalContent === null) {
          if (existsSync(mutation.path)) unlinkSync(mutation.path);
        } else {
          atomicWriteFile(mutation.path, mutation.originalContent);
        }
      } catch {
        // Best-effort rollback
      }
    }

    if (existsSync(journalPath)) {
      try { unlinkSync(journalPath); } catch (_) {}
    }

    const failedReceipt = createOperationReceipt(root, {
      actionPlanId: plan.id,
      kind: plan.kind,
      title: plan.title,
      repository: plan.repository || "local",
      status: "rolled-back",
      durationMs: Date.now() - startTime,
      mutationsApplied,
      effectsExecuted,
    });

    throw new Error(`Action plan execution failed and was rolled back: ${err.message}. Receipt: ${failedReceipt.receiptId}`);
  }
}
