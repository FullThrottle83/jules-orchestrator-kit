import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, renameSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createOperationReceipt } from "./receipts.mjs";

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

/**
 * Verify preconditions of an ActionPlan against target repository state.
 * @param {import("../ux/capabilities.mjs").ActionPlan} plan
 * @param {string} root
 */
export function verifyPreconditions(plan, root) {
  for (const cond of plan.preconditions || []) {
    if (cond.kind === "file-hash") {
      const targetPath = resolve(root, cond.target);
      const actualHash = getFileHash(targetPath);
      if (actualHash !== cond.expected) {
        throw new Error(
          `Precondition failed [file-hash]: ${cond.target} expected ${cond.expected}, received ${actualHash}`
        );
      }
    } else if (cond.kind === "lock-free") {
      const lockPath = join(root, ".agent", "state", "locks", `${cond.target}.lock`);
      if (existsSync(lockPath)) {
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
export async function applyActionPlan(plan, options) {
  const root = options.root;
  const startTime = Date.now();

  // 1. Verify Preconditions
  verifyPreconditions(plan, root);

  // 2. Prepare Intent Journaling
  const journalDir = join(root, ".agent", "state", "journal");
  if (!existsSync(journalDir)) {
    mkdirSync(journalDir, { recursive: true });
  }
  const journalPath = join(journalDir, `${plan.id}.intent.json`);
  writeFileSync(journalPath, JSON.stringify({ plan, startedAt: new Date().toISOString() }, null, 2));

  /** @type {Array<{ path: string, originalContent: string | null }>} */
  const rollbackStack = [];
  const mutationsApplied = [];
  const effectsExecuted = [];

  try {
    // 3. Apply File Mutations
    for (const mutation of plan.fileMutations || []) {
      const targetPath = resolve(root, mutation.path);
      const parentDir = dirname(targetPath);

      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }

      const existingContent = existsSync(targetPath) ? readFileSync(targetPath, "utf-8") : null;
      const hashBefore = existingContent ? "sha256:" + createHash("sha256").update(existingContent).digest("hex") : undefined;

      rollbackStack.push({ path: targetPath, originalContent: existingContent });

      if (mutation.operation === "delete") {
        if (existsSync(targetPath)) {
          unlinkSync(targetPath);
        }
        mutationsApplied.push({ path: mutation.path, operation: "delete", hashBefore });
      } else if (mutation.operation === "create" || mutation.operation === "replace") {
        const newContent = mutation.newContent ?? "";
        const tmpPath = `${targetPath}.${Date.now()}.tmp`;
        writeFileSync(tmpPath, newContent, "utf-8");
        renameSync(tmpPath, targetPath);

        const hashAfter = "sha256:" + createHash("sha256").update(newContent).digest("hex");
        mutationsApplied.push({ path: mutation.path, operation: mutation.operation, hashBefore, hashAfter });
      }
    }

    // 4. Execute Command Effects
    for (const effect of plan.commandEffects || []) {
      const execPath = effect.executable;
      const args = effect.args || [];
      const cwd = effect.cwd ? resolve(root, effect.cwd) : root;

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
      const { path, originalContent } = rollbackStack[i];
      try {
        if (originalContent === null) {
          if (existsSync(path)) unlinkSync(path);
        } else {
          writeFileSync(path, originalContent, "utf-8");
        }
      } catch {
        // Best-effort rollback
      }
    }

    if (existsSync(journalPath)) {
      unlinkSync(journalPath);
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
