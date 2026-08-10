import {
  readFileSync,
  mkdirSync,
  existsSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { redactSecrets } from "../security.mjs";

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
    title: receipt.title,
    repository: receipt.repository,
    status: receipt.status,
    appliedAt: receipt.appliedAt,
    durationMs: receipt.durationMs,
    mutationsApplied: receipt.mutationsApplied,
    effectsExecuted: receipt.effectsExecuted,
  });
  return "sha256:" + createHash("sha256").update(payload).digest("hex");
}

function redactReceiptValue(value) {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactReceiptValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactReceiptValue(child)]));
  }
  return value;
}

function assertReceiptId(receiptId) {
  if (typeof receiptId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(receiptId)) {
    throw new Error("Invalid operation receipt id");
  }
}

function writeFileAtomically(filePath, content) {
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
  assertReceiptId(receiptId);
  const appliedAt = new Date().toISOString();

  const baseReceipt = redactReceiptValue({
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
  });

  const receiptHash = computeReceiptHash(baseReceipt);
  /** @type {OperationReceipt} */
  const fullReceipt = {
    ...baseReceipt,
    receiptHash,
  };

  const targetPath = join(receiptsDir, `${receiptId}.json`);
  writeFileAtomically(targetPath, JSON.stringify(fullReceipt, null, 2));

  return fullReceipt;
}

/**
 * Load and validate an OperationReceipt from disk.
 * @param {string} root
 * @param {string} receiptIdOrPath
 * @returns {OperationReceipt}
 */
export function loadOperationReceipt(root, receiptIdOrPath) {
  const receiptsDir = resolve(root, ".agent", "receipts");
  let targetPath;
  if (typeof receiptIdOrPath !== "string" || !receiptIdOrPath) {
    throw new Error("Operation receipt id or path is required");
  }

  if (!receiptIdOrPath.endsWith(".json")) {
    assertReceiptId(receiptIdOrPath);
    targetPath = join(receiptsDir, `${receiptIdOrPath}.json`);
  } else {
    targetPath = isAbsolute(receiptIdOrPath) ? resolve(receiptIdOrPath) : resolve(root, receiptIdOrPath);
    const rel = relative(receiptsDir, targetPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error("Operation receipt path escapes the receipts directory");
    }
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
  if (receipt.receiptHash !== computeReceiptHash(receipt)) {
    throw new Error(`Invalid operation receipt hash: ${targetPath}`);
  }

  return receipt;
}
