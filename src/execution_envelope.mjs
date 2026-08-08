import { createHash } from "node:crypto";
import { resolveRoot } from "./config.mjs";
import { resolveBase } from "./git.mjs";
import { classifyRiskTier } from "./risk.mjs";

/**
 * Generates a SHA-256 hash of the execution envelope payload.
 */
export function hashExecutionEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") return "";
  const payload = {
    id: envelope.id,
    taskId: envelope.taskId,
    baseSha: envelope.baseSha,
    configSha: envelope.configSha,
    scope: envelope.scope,
    verify: envelope.verify,
    riskTier: envelope.riskTier,
    budgetReservationId: envelope.budgetReservationId,
    capabilities: envelope.capabilities,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * Deep freezes an execution envelope to prevent modifications during OODA repair loops.
 */
export function freezeExecutionEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") return envelope;
  return Object.freeze({
    ...envelope,
    scope: Object.freeze({
      deny: Object.freeze([...(envelope.scope?.deny || [])]),
      allow: Object.freeze([...(envelope.scope?.allow || [])]),
      protect: Object.freeze([...(envelope.scope?.protect || [])]),
    }),
    verify: Object.freeze({ ...(envelope.verify || {}) }),
    capabilities: Object.freeze([...(envelope.capabilities || [])]),
  });
}

/**
 * Creates an immutable Capability-Bounded Execution Envelope (CBEE).
 */
export function createExecutionEnvelope(task = {}, opts = {}) {
  const root = opts.root || resolveRoot();
  const baseRef = opts.base || task.base || "main";
  const baseSha = resolveBase(root, baseRef);

  const taskId = task.id || opts.taskId || `task-${Date.now()}`;
  const envelopeId = `env-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  const denyPaths = opts.forbiddenPaths || task.forbiddenPaths || [".github/**", "package-lock.json", "pnpm-lock.yaml"];
  const allowPaths = opts.allowPaths || task.allowPaths || [];
  const protectPaths = opts.protectPaths || task.protectPaths || ["package.json", "tsconfig.json", "AGENTS.md"];

  const files = task.files || opts.files || [];
  const riskMeta = classifyRiskTier(files, { diffLines: opts.diffLines || 0 });

  const rawEnvelope = {
    id: envelopeId,
    taskId,
    baseRef,
    baseSha,
    configSha: createHash("sha256").update(JSON.stringify({ denyPaths, allowPaths, protectPaths })).digest("hex"),
    scope: {
      deny: denyPaths,
      allow: allowPaths,
      protect: protectPaths,
    },
    verify: {
      testCmd: opts.testCmd || task.testCmd || "npm test",
      buildCmd: opts.buildCmd || task.buildCmd || "npm run build",
    },
    riskTier: riskMeta.tier,
    budgetReservationId: opts.reservationId || null,
    capabilities: opts.capabilities || ["git:read", "git:diff", "test:run"],
    createdAt: new Date().toISOString(),
  };

  const envelopeHash = hashExecutionEnvelope(rawEnvelope);
  const fullEnvelope = { ...rawEnvelope, hash: envelopeHash };

  return freezeExecutionEnvelope(fullEnvelope);
}

/**
 * Validates that an envelope has not been tampered with.
 */
export function verifyExecutionEnvelope(envelope) {
  if (!envelope || !envelope.hash) return false;
  const expectedHash = hashExecutionEnvelope(envelope);
  return envelope.hash === expectedHash;
}
