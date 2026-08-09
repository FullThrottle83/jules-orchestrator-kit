/**
 * Google Jules Orchestrator Kit - Node.js SDK (v0.9.0)
 *
 * Exposes core orchestrator functions for programmatically driving agent tasks,
 * security auditing, repo gating, and state operations.
 */

export { loadConfig, detectStack, resolveVerify, resolveRoot, normalizePath, TIER_PRESETS } from "./src/config.mjs";
export {
  shannonEntropy,
  redactSecrets,
  anonymizePii,
  matchesGlob,
  checkScope,
  scanDiff,
} from "./src/security.mjs";
export { sanitizeUntrustedData, buildAgentEnvelope } from "./src/prompt-guard.mjs";
export { isolateMcpStdout, writeMcpFrame } from "./src/mcp.mjs";
export { git, runCmd, changedFiles, diffBytes, diffText } from "./src/git.mjs";
export { createProvider, JULES_PRESET, CLAUDE_PRESET, CODEX_PRESET } from "./src/provider.mjs";
export {
  appendLedger,
  readLedger,
  verifyLedgerIntegrity,
  reserveBudget,
  reserveBudgetAtomic,
  commitBudgetReservation,
  withBudget,
  checkDailyBudget,
  acquireLock,
  releaseLock,
  lockStatus,
  getLockDir,
  withVfsMutex,
  MutexTimeoutError,
  BudgetError,
  isPidAlive,
  getProcessStartTime,
} from "./src/state.mjs";
export { gate, dispatch, repair, run, fingerprintFailureState } from "./src/engine.mjs";
export { validateEnvelope } from "./src/envelope.mjs";
export {
  createExecutionEnvelope,
  verifyExecutionEnvelope,
  freezeExecutionEnvelope,
  hashExecutionEnvelope,
} from "./src/execution_envelope.mjs";
export { checkAssetIntegrity } from "./src/asset_integrity.mjs";
export { classifyRiskTier, RISK_TIERS } from "./src/risk.mjs";
export { checkRulesBudget } from "./src/rules_budget.mjs";

// Legacy SDK shims for backward compatibility
export { resolveProjectCommands, resolveWorkspaceExecutionBoundary } from "./scripts/command-resolver.mjs";
export { runSelfAudit, runPreflightSandbox } from "./scripts/jules-self-audit.mjs";
export { scanCodebaseForTodos, runScanner } from "./scripts/jules-scan-todos.mjs";
export { getDynamicGuardrails, dispatchTask } from "./scripts/jules-dispatch.mjs";
export { classifyQueueFailure } from "./scripts/jules-queue-runner.mjs";
