/**
 * Google Jules Orchestrator Kit - Node.js SDK
 *
 * Exposes core orchestrator functions for programmatically driving agent tasks,
 * security auditing, repo gating, and state operations.
 */

export { loadConfig, parseYaml, detectStack, resolveVerify, resolveRoot, normalizePath, canonicalizePath, TIER_PRESETS } from "./src/config.mjs";
export {
  shannonEntropy,
  redactSecrets,
  anonymizePii,
  matchesGlob,
  checkScope,
  scanDiff,
  checkEdgeRuntimeImports,
  checkCrossPackageImports,
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
export {
  detectPolyglotStack,
  resolveWorkspaceBoundary,
  bootstrapZeroTestRepo,
  findSubprojectRoot,
  detectCrossPackageBoundaryViolations,
  detectCircularDependencies,
} from "./src/stack-detector.mjs";
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
  scanBudgetWindow,
  getLedgerPathsInWindow,
  ROLLING_WINDOW_MS,
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
export { recordRemediation, queryRemediations } from "./src/remediation.mjs";
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

// Webhook, Silence Governor & HITL Escalation Bridge
export {
  dispatchEscalation,
  verifySignature,
  parseWebhookPayload,
  routeWebhookEvent,
  createWebhookServer,
  flushEscalationDigest,
  getEscalationDigestStatus,
  clearEscalationDigest,
  bufferEscalationIncident,
  DEFAULT_CRITICAL_REASONS,
} from "./src/webhook.mjs";

// PR Review Evidence Bundler & Dev Server Probe
export { synthesizePrDescription, probeDevServer } from "./src/engine.mjs";

// Automated TDD Red-to-Green Harness
export { scaffoldTddTest, runTddCycle, TddError } from "./src/ops/tdd-generator.mjs";

// SPORE Memory & System Learnings
export { recordLearning, loadLearnings, hydratePrompt, harvestFailure, getLearningsPath, getSystemLearningsMdPath } from "./src/memory.mjs";

// Specialist Role Resolution & DAG Queue Execution
export { resolveRolePrompt } from "./src/wizard-task.mjs";
export { executeQueueDag, resolveAffectedTests } from "./src/dag-engine.mjs";

// IDE Native MCP Scaffolder
export { scaffoldIdeConfig, IdeScaffoldError } from "./src/ops/ide-scaffold.mjs";

// Cryptographic Evidence & Test Integrity Manifests
export {
  computeFileHash,
  computeDirectoryHash,
  generateEvidenceManifest,
  writeEvidenceManifest,
  loadEvidenceManifest,
  verifyEvidenceManifest,
  generateEvidenceMarkdown,
  computeEvidenceHash,
} from "./src/evidence.mjs";

export {
  resolveDailyLimit,
  budgetStatus,
  readObservedCeiling,
  readActiveCeiling,
  recordObservedCeiling,
  isDailyQuotaRejection,
  listOpenReservations,
  releaseOpenReservations,
  resolveConcurrency,
  CEILING_FILE,
} from "./src/budget.mjs";
export { KIT_VERSION } from "./src/version.mjs";
export { VENDOR_TIERS, FALLBACK_TIER } from "./src/config.mjs";
export { tierOptions } from "./src/wizard-init.mjs";

// Statistical Flaky Ledger & Automated Healing Swarm
export {
  wilsonScoreInterval,
  computeOscillation,
  recordVerifyRun,
  readVerifyRuns,
  flakyVerdict,
  listQuarantinedTests,
  clearFlakyLedger,
  synthesizeFlakyHealingTask,
  runFlakyHealingSwarm,
} from "./src/flaky-ledger.mjs";
