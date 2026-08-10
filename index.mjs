/**
 * Google Jules Orchestrator Kit - Node.js SDK (v0.29.1)
 *
 * Exposes core orchestrator functions for programmatically driving agent tasks,
 * security auditing, repo gating, and state operations.
 */

export { loadConfig, parseYaml, detectStack, resolveVerify, resolveRoot, normalizePath, TIER_PRESETS } from "./src/config.mjs";
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
export { git, runCmd, resolveBase, changedFiles, diffBytes, diffText } from "./src/git.mjs";
export {
  createProvider,
  createFailoverProvider,
  JULES_PRESET,
  CLAUDE_PRESET,
  CODEX_PRESET,
  MissingApiKeyError,
  ProviderRateLimitError,
  ProviderUnavailableError,
  ProviderSchemaError,
  parseRetryAfter,
} from "./src/provider.mjs";
export { detectPolyglotStack, resolveWorkspaceBoundary, bootstrapZeroTestRepo } from "./src/stack-detector.mjs";
export {
  appendLedger,
  readLedger,
  verifyLedgerIntegrity,
  reserveBudget,
  reserveBudgetAtomic,
  commitBudgetReservation,
  rollbackBudgetReservation,
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
  parseProcStat,
} from "./src/state.mjs";
export { gate, dispatch, repair, run, fingerprintFailureState, isTaskFile } from "./src/engine.mjs";
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
export { DagExecutor, DagCycleError } from "./src/dag-engine.mjs";
export { journalIntent, journalDone, reapOrphanedIntents, reapStaleMutexDirs } from "./src/journal.mjs";

// Legacy SDK shims for backward compatibility
export { resolveProjectCommands, resolveWorkspaceExecutionBoundary } from "./scripts/command-resolver.mjs";
export { runSelfAudit, runPreflightSandbox } from "./scripts/jules-self-audit.mjs";
export { scanCodebaseForTodos, runScanner } from "./scripts/jules-scan-todos.mjs";
export { getDynamicGuardrails, dispatchTask } from "./scripts/jules-dispatch.mjs";
export { classifyQueueFailure } from "./scripts/jules-queue-runner.mjs";
export { extractPrUrls, auditSessions, buildSyncManifest, pushReservationManifest } from "./scripts/utils.mjs";

// Native TUI Primitives
export { isTTY, styleText, select, multiSelect, input, confirm, secretInput, spinner, ANSI } from "./src/tui.mjs";

// Stack Oracle & Verification Probes
export { detectStackOracles, runVerificationProbe } from "./src/wizard-oracle.mjs";

// Onboarding & Presets Engine
export { planInit, loadPresets, runInitWizard, TIER_PROFILES, BUILTIN_PRESETS } from "./src/wizard-init.mjs";

// Guided Task Authoring Subsystem
export { planTaskCreate, runTaskCreateWizard, GUARDRAIL_FOOTER } from "./src/wizard-task.mjs";

// Prompt Falsifiability & Task Optimizer Engine
export { scorePromptFalsifiability, optimizeTaskPrompt, levenshteinDistance, extractPathTokens } from "./src/task-optimizer.mjs";

// Atomic Git Checkpoints & Rollback
export { createCheckpoint, restoreCheckpoint, listCheckpoints, pruneCheckpoints, CheckpointError } from "./src/ops/checkpoint.mjs";

// Webhook & HITL Escalation Bridge
export { dispatchEscalation, verifySignature, parseWebhookPayload, routeWebhookEvent, createWebhookServer } from "./src/webhook.mjs";

// PR Review Evidence Bundler
export { synthesizePrDescription } from "./src/engine.mjs";



