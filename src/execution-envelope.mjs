import { createHash } from "node:crypto";
import { resolveRoot, loadConfig } from "./config.mjs";
import { resolveBase } from "./git.mjs";
import { classifyRiskTier } from "./risk.mjs";
import { queryRemediations } from "./remediation.mjs";

/**
 * Generates a SHA-256 hash of the execution envelope payload.
 */
export function hashExecutionEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") return "";
  const rawPayload = {
    id: envelope.id,
    taskId: envelope.taskId,
    baseRef: envelope.baseRef,
    baseSha: envelope.baseSha,
    configSha: envelope.configSha,
    scope: envelope.scope,
    verify: envelope.verify,
    riskTier: envelope.riskTier,
    budgetReservationId: envelope.budgetReservationId,
    capabilities: envelope.capabilities,
    remediations: envelope.remediations || [],
    createdAt: envelope.createdAt,
  };
  const sortedKeys = Object.keys(rawPayload).sort();
  const canonicalPayload = {};
  for (const k of sortedKeys) {
    if (rawPayload[k] !== undefined) {
      canonicalPayload[k] = rawPayload[k];
    }
  }
  return createHash("sha256").update(JSON.stringify(canonicalPayload)).digest("hex");
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
    remediations: Object.freeze([...(envelope.remediations || [])]),
  });
}

/**
 * Creates an immutable Capability-Bounded Execution Envelope (CBEE) with pre-flight remediation hydration.
 */
export function createExecutionEnvelope(task = {}, opts = {}) {
  const root = opts.root || resolveRoot();
  const baseRef = opts.base || task.base || "main";
  const baseSha = resolveBase(root, baseRef);

  const taskId = task.id || opts.taskId || `task-${Date.now()}`;
  const envelopeId = `env-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  // The repository's own resolved scope and verification commands, not a set of
  // Node literals. `loadConfig` merges BUILTIN_DENY/BUILTIN_PROTECT (which are
  // already polyglot — Cargo.toml, go.mod, pyproject.toml, composer.json) with
  // whatever `.agent/config.yml` adds, and `resolveVerify` runs the stack
  // detector. Hardcoding `npm test` here meant the envelope handed a Rust or
  // Python repo a command that could not run, in the very structure whose job
  // is to be the authoritative record of what the agent was allowed to do.
  let config = opts.config;
  if (!config) {
    try {
      config = loadConfig(root);
    } catch (_) {
      config = {};
    }
  }

  const denyPaths = opts.forbiddenPaths || task.forbiddenPaths || config.scope?.deny || [];
  const allowPaths = opts.allowPaths || task.allowPaths || config.scope?.allow || [];
  const protectPaths = opts.protectPaths || task.protectPaths || config.scope?.protect || [];

  const files = task.files || opts.files || [];
  const riskMeta = classifyRiskTier(files, { diffLines: opts.diffLines || 0, config });

  const taskFingerprint = task.fingerprint || opts.fingerprint || null;
  const remediations = queryRemediations(root, { targetFiles: files, fingerprint: taskFingerprint, limit: 3 });

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
      testCmd: opts.testCmd || task.testCmd || config.verify?.test || "",
      buildCmd: opts.buildCmd || task.buildCmd || config.verify?.build || "",
    },
    riskTier: riskMeta.tier,
    budgetReservationId: opts.reservationId || null,
    capabilities: opts.capabilities || ["git:read", "git:diff", "test:run"],
    remediations,
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

