import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

/**
 * @typedef {Object} OperationReceipt
 * @property {"agentctl/operation-receipt-v1"} schema
 * @property {string} receiptId
 * @property {string} actionPlanId
 * @property {string} kind
 * @property {string} title
 * @property {string} repository
 * @property {string} appliedAt
 * @property {"success" | "rolled-back" | "failed"} status
 * @property {number} durationMs
 * @property {Array<{ path: string, operation: string, hashBefore?: string, hashAfter?: string }>} mutationsApplied
 * @property {Array<{ executable: string, args: string[], exitCode: number }>} effectsExecuted
 * @property {string} receiptHash
 */

/**
 * Compute SHA-256 hash of operation receipt metadata.
 * @param {Omit<OperationReceipt, "receiptHash">} receipt
 * @returns {string}
 */
export function computeReceiptHash(receipt) {
  const payload = JSON.stringify({
    schema: receipt.schema,
    receiptId: receipt.receiptId,
    actionPlanId: receipt.actionPlanId,
    kind: receipt.kind,
    status: receipt.status,
    appliedAt: receipt.appliedAt,
    mutationsApplied: receipt.mutationsApplied,
    effectsExecuted: receipt.effectsExecuted,
  });
  return "sha256:" + createHash("sha256").update(payload).digest("hex");
}

/**
 * Create and persist an OperationReceipt atomically.
 * @param {string} root
 * @param {Omit<OperationReceipt, "schema" | "receiptId" | "appliedAt" | "receiptHash"> & { receiptId?: string }} data
 * @returns {OperationReceipt}
 */
export function createOperationReceipt(root, data) {
  const receiptsDir = join(root, ".agent", "receipts");
  if (!existsSync(receiptsDir)) {
    mkdirSync(receiptsDir, { recursive: true });
  }

  const receiptId = data.receiptId || `REC-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const appliedAt = new Date().toISOString();

  const baseReceipt = {
    schema: /** @type {const} */ ("agentctl/operation-receipt-v1"),
    receiptId,
    actionPlanId: data.actionPlanId,
    kind: data.kind,
    title: data.title,
    repository: data.repository || "local",
    appliedAt,
    status: data.status,
    durationMs: data.durationMs || 0,
    mutationsApplied: data.mutationsApplied || [],
    effectsExecuted: data.effectsExecuted || [],
  };

  const receiptHash = computeReceiptHash(baseReceipt);
  /** @type {OperationReceipt} */
  const fullReceipt = {
    ...baseReceipt,
    receiptHash,
  };

  const targetPath = join(receiptsDir, `${receiptId}.json`);
  const tmpPath = `${targetPath}.${Date.now()}.tmp`;

  writeFileSync(tmpPath, JSON.stringify(fullReceipt, null, 2), "utf-8");
  writeFileSync(targetPath, readFileSync(tmpPath));
  try {
    const { unlinkSync } = import("node:fs");
    unlinkSync(tmpPath);
  } catch {
    // Ignore tmp file cleanup error
  }

  return fullReceipt;
}

/**
 * Load and validate an OperationReceipt from disk.
 * @param {string} root
 * @param {string} receiptIdOrPath
 * @returns {OperationReceipt}
 */
export function loadOperationReceipt(root, receiptIdOrPath) {
  let targetPath = receiptIdOrPath;
  if (!targetPath.endsWith(".json")) {
    targetPath = join(root, ".agent", "receipts", `${receiptIdOrPath}.json`);
  } else if (!targetPath.startsWith("/")) {
    targetPath = resolve(root, targetPath);
  }

  if (!existsSync(targetPath)) {
    throw new Error(`Operation receipt not found: ${targetPath}`);
  }

  const content = readFileSync(targetPath, "utf-8");
  /** @type {OperationReceipt} */
  const receipt = JSON.parse(content);

  if (receipt.schema !== "agentctl/operation-receipt-v1") {
    throw new Error(`Invalid receipt schema version: ${receipt.schema}`);
  }

  return receipt;
}
