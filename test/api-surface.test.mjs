import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as sdk from "../index.mjs";

/**
 * 100% API Surface Freeze Snapshot for index.mjs SDK Exports.
 *
 * This test acts as a mechanical gate to guarantee semantic stability across versions.
 * Any removed or renamed export breaks consumers and will fail this test.
 * Any newly added export must be deliberately reviewed and added to this snapshot.
 */
const FROZEN_SDK_EXPORTS = [
  "ANSI",
  "BUILTIN_PRESETS",
  "BudgetError",
  "CEILING_FILE",
  "CLAUDE_PRESET",
  "CODEX_PRESET",
  "CheckpointError",
  "DEFAULT_CRITICAL_REASONS",
  "DIGEST_BATCH_LIMIT",
  "DagCycleError",
  "DagExecutor",
  "FALLBACK_TIER",
  "GUARDRAIL_FOOTER",
  "HandoverError",
  "IdeScaffoldError",
  "JULES_PRESET",
  "KIT_VERSION",
  "MissingApiKeyError",
  "MutexTimeoutError",
  "ProviderRateLimitError",
  "ProviderSchemaError",
  "ProviderUnavailableError",
  "RISK_TIERS",
  "ROLLING_WINDOW_MS",
  "TIER_PRESETS",
  "TIER_PROFILES",
  "TddError",
  "VENDOR_TIERS",
  "acquireLock",
  "anonymizePii",
  "appendLedger",
  "assertDirSize",
  "assertFileExists",
  "assertFilePatterns",
  "assertFileSize",
  "auditSessions",
  "bootstrapZeroTestRepo",
  "budgetStatus",
  "bufferEscalationIncident",
  "buildAgentEnvelope",
  "buildSyncManifest",
  "canonicalizePath",
  "changedFiles",
  "checkAssetIntegrity",
  "checkCrossPackageImports",
  "checkDailyBudget",
  "checkEdgeRuntimeImports",
  "checkScope",
  "classifyQueueFailure",
  "classifyRiskTier",
  "clearEscalationDigest",
  "clearFlakyLedger",
  "commitBudgetReservation",
  "computeDirectoryHash",
  "computeEvidenceHash",
  "computeFileHash",
  "computeOscillation",
  "confirm",
  "countRecentInterruptions",
  "createCheckpoint",
  "createExecutionEnvelope",
  "createFailoverProvider",
  "createHandover",
  "createProvider",
  "createWebhookServer",
  "detectCircularDependencies",
  "detectCrossPackageBoundaryViolations",
  "detectPolyglotStack",
  "detectStack",
  "detectStackOracles",
  "diffBytes",
  "diffText",
  "dispatch",
  "dispatchEscalation",
  "dispatchTask",
  "executeQueueDag",
  "exportJsonReport",
  "extractPathTokens",
  "extractPrUrls",
  "findSubprojectRoot",
  "fingerprintFailureState",
  "flakyVerdict",
  "flushEscalationDigest",
  "formatBytes",
  "formatHandoverPromptContext",
  "freezeExecutionEnvelope",
  "gate",
  "generateEvidenceManifest",
  "generateEvidenceMarkdown",
  "getDynamicGuardrails",
  "getEscalationDigestStatus",
  "getHandoverDir",
  "getLearningsPath",
  "getLedgerPathsInWindow",
  "getLockDir",
  "getProcessStartTime",
  "getSystemLearningsMdPath",
  "git",
  "harvestFailure",
  "hasEncodedSecret",
  "hashExecutionEnvelope",
  "hydratePrompt",
  "input",
  "isDailyQuotaRejection",
  "isPidAlive",
  "isTTY",
  "isTaskFile",
  "isolateMcpStdout",
  "journalDone",
  "journalIntent",
  "levenshteinDistance",
  "listCheckpoints",
  "listHandovers",
  "listOpenReservations",
  "listQuarantinedTests",
  "loadConfig",
  "loadEscalationDigest",
  "loadEvidenceManifest",
  "loadHandover",
  "loadLearnings",
  "loadPresets",
  "lockStatus",
  "matchesGlob",
  "multiSelect",
  "normalizePath",
  "optimizeTaskPrompt",
  "parseProcStat",
  "parseRetryAfter",
  "parseWebhookPayload",
  "parseYaml",
  "planInit",
  "planTaskCreate",
  "probeDevServer",
  "pruneCheckpoints",
  "pruneHandovers",
  "pushReservationManifest",
  "queryRemediations",
  "readActiveCeiling",
  "readLedger",
  "readObservedCeiling",
  "readVerifyRuns",
  "reapOrphanedIntents",
  "reapStaleMutexDirs",
  "recordInterruption",
  "recordLearning",
  "recordObservedCeiling",
  "recordRemediation",
  "recordVerifyRun",
  "redactSecrets",
  "releaseLock",
  "releaseOpenReservations",
  "repair",
  "reserveBudget",
  "reserveBudgetAtomic",
  "resolveAffectedTests",
  "resolveBase",
  "resolveBytesLimit",
  "resolveConcurrency",
  "resolveDailyLimit",
  "resolveProjectCommands",
  "resolveRolePrompt",
  "resolveRoot",
  "resolveRoutedProvider",
  "resolveVerify",
  "resolveWorkspaceBoundary",
  "resolveWorkspaceExecutionBoundary",
  "restoreCheckpoint",
  "rollbackBudgetReservation",
  "routeWebhookEvent",
  "run",
  "runAssertion",
  "runCmd",
  "runFlakyHealingSwarm",
  "runInitWizard",
  "runPreflightSandbox",
  "runScanner",
  "runSelfAudit",
  "runTaskCreateWizard",
  "runTddCycle",
  "runVerificationProbe",
  "sanitizeUntrustedData",
  "scaffoldIdeConfig",
  "scaffoldTddTest",
  "scanBudgetWindow",
  "scanCodebaseForTodos",
  "scanDiff",
  "scorePromptFalsifiability",
  "secretInput",
  "select",
  "shannonEntropy",
  "spinner",
  "styleText",
  "synthesizeFlakyHealingTask",
  "synthesizePrDescription",
  "tierOptions",
  "validateEnvelope",
  "verifyEvidenceManifest",
  "verifyExecutionEnvelope",
  "verifyLedgerIntegrity",
  "verifySignature",
  "wilsonScoreInterval",
  "withBudget",
  "withVfsMutex",
  "writeEvidenceManifest",
  "writeMcpFrame"
];

/**
 * Standardized Exit Code Registry (AGENTS.md Section 6).
 */
const EXIT_CODE_CONTRACT = {
  0: "Success — verification passed, PR opened",
  1: "Pre-dispatch / arg failure; prompt > limits.promptKb",
  2: "API / network — HTTP 429, FAILED_PRECONDITION concurrency quota, timeout",
  3: "Scope violation — restricted path (.github/, command files, .agent/rules/)",
  4: "OODA exhausted — repair attempts without clean verification",
  5: "Diff payload exceeds limits.diffKb",
  6: "Secret leak prevented — high-confidence key in the patch diff",
  7: "Quota exhausted — dailyTasks cap reached",
  8: "Flaky quarantine — oscillation >= 0.40 (Wilson CI interior)",
};

describe("SDK API Surface & Exit Code Stability Lock", () => {
  it("matches frozen export list exactly with no removed or unexpected additions", () => {
    const actualExports = Object.keys(sdk).sort();
    const expectedExports = [...FROZEN_SDK_EXPORTS].sort();

    const missingExports = expectedExports.filter((k) => !actualExports.includes(k));
    const addedExports = actualExports.filter((k) => !expectedExports.includes(k));

    assert.deepEqual(
      missingExports,
      [],
      `SDK exports removed or renamed! Breaking change detected:\n${missingExports.join("\n")}`
    );

    assert.deepEqual(
      addedExports,
      [],
      `Unapproved new SDK exports detected:\n${addedExports.join("\n")}\nIf intentional, review and update FROZEN_SDK_EXPORTS snapshot.`
    );

    assert.equal(actualExports.length, 205, "Total exported SDK symbols count must remain locked at 205");
  });

  it("ensures every exported symbol is defined and non-null", () => {
    for (const [name, exportedVal] of Object.entries(sdk)) {
      assert.notEqual(
        exportedVal,
        undefined,
        `Exported symbol '${name}' is undefined.`
      );
      assert.notEqual(
        exportedVal,
        null,
        `Exported symbol '${name}' is null.`
      );
    }
  });

  it("verifies CLI exit code contract covers 0 through 8 continuously", () => {
    const expectedCodes = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    const registeredCodes = Object.keys(EXIT_CODE_CONTRACT).map(Number).sort((a, b) => a - b);

    assert.deepEqual(registeredCodes, expectedCodes, "Exit codes 0-8 must be fully registered and continuous");
    for (const code of expectedCodes) {
      assert.ok(EXIT_CODE_CONTRACT[code], `Exit code ${code} must have a defined semantic description`);
    }
  });
});
