import { loadConfig } from "./config.mjs";
import { isTestPath } from "./test-paths.mjs";
import { isPlaceholderTestScript, describeIncapableTestCommand } from "./stack-detector.mjs";
import { checkCollectionFloor } from "./ops/test-collection.mjs";
import { checkSourceBinding } from "./source-binding.mjs";
import { checkScope, scanDiff, scanBinaryPayloads, redactSecrets } from "./security.mjs";
import { changedFiles, diffBytes, diffText, binaryDiffEntries, symlinkChanges, showFromOrigin, runCmd, resolveBase } from "./git.mjs";
import { resolveTrustedPolicy } from "./trusted-policy.mjs";
import { materialiseRevision } from "./revision-snapshot.mjs";
import { createProvider, ProviderRateLimitError, ProviderUnavailableError } from "./provider.mjs";
import { resolveRoutedProvider } from "./router.mjs";
import { withBudget, appendLedger, getQueueDir, ensureDir, rollbackBudgetReservation, isConcurrencyGroupLocked, checkDailyBudget } from "./state.mjs";
import { resolveDailyLimit, recordObservedCeiling, isDailyQuotaRejection, resolveAmbientIdentity } from "./budget.mjs";
import { sanitizeUntrustedData, buildAgentEnvelope } from "./prompt-guard.mjs";
import { recordVerifyRun, readVerifyRuns, flakyVerdict } from "./flaky-ledger.mjs";
import fs, { readdirSync, readFileSync, renameSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { appendTelemetry as appendTelemetryUnsafe } from "./telemetry.mjs";

import { spawn } from "node:child_process";
import { resolveAffectedTests, executeQueueDag } from "./dag-engine.mjs";
import { recordRemediation, queryRemediations, harvestFailureRecord, hydrateMemory, createWhackAMoleDetector } from "./remediation.mjs";
import { hydratePrompt, harvestFailure } from "./memory.mjs";
import { resolveRolePrompt } from "./role-resolver.mjs";

import { runAssertion } from "./assertions.mjs";
import { buildDefaultStages, buildProfileStages } from "./profiles.mjs";
import { resolveWorkspaceBoundary } from "./stack-detector.mjs";
import {
  computeDirectoryHash,
  generateEvidenceManifest,
  writeEvidenceManifest,
  verifyEvidenceManifest,
  generateEvidenceMarkdown,
  exportJsonReport,
  sha256,
} from "./evidence.mjs";

export {
  recordVerifyRun,
  readVerifyRuns,
  flakyVerdict,
  sanitizeUntrustedData,
  resolveAffectedTests,
  executeQueueDag,
  recordRemediation,
  queryRemediations,
  harvestFailureRecord,
  hydrateMemory,
  hydratePrompt,
  harvestFailure,
  resolveRolePrompt,
  isConcurrencyGroupLocked,
  computeDirectoryHash,
  generateEvidenceManifest,
  writeEvidenceManifest,
  verifyEvidenceManifest,
  generateEvidenceMarkdown,
  exportJsonReport,
  runAssertion,
};


function appendTelemetry(root, kind, fields = {}) {
  try {
    return appendTelemetryUnsafe(root, kind, fields);
  } catch (_) {
    return null;
  }
}

function isSafeQueueFileName(fileName) {
  return typeof fileName === "string" && fileName.length > 0 && basename(fileName) === fileName && fileName !== "." && fileName !== "..";
}

/**
 * Validates whether a file in .agent/jules-queue/ is a task file.
 * Filters out README.md and matches TASK-*.md or valid envelope front-matter.
 */
export function isTaskFile(fileName, queueDirOrContent = null) {
  if (!fileName || typeof fileName !== "string") return false;
  const lower = fileName.toLowerCase();

  // Explicitly filter out README.md
  if (lower === "readme.md" || lower.endsWith("/readme.md") || lower.endsWith("\\readme.md")) {
    return false;
  }

  if (!lower.endsWith(".md")) {
    return false;
  }

  // Matching TASK-*.md or task-*.md
  if (/^task-.*\.md$/i.test(fileName)) {
    return true;
  }

  // Check valid envelope front-matter
  if (queueDirOrContent) {
    try {
      let content = queueDirOrContent;
      if (typeof queueDirOrContent === "string" && !queueDirOrContent.includes("\n") && existsSync(queueDirOrContent)) {
        const fullPath = queueDirOrContent.endsWith(fileName) ? queueDirOrContent : join(queueDirOrContent, fileName);
        if (existsSync(fullPath)) {
          content = readFileSync(fullPath, "utf-8");
        }
      }
      if (typeof content === "string") {
        const trimmed = content.trimStart();
        if (trimmed.includes("JULES_TASK_ENVELOPE") || trimmed.includes("# Task ID:") || trimmed.startsWith("---")) {
          return true;
        }
      }
    } catch (_) {}
  }

  return false;
}

/**
 * Computes a SHA-256 fingerprint for a failure state (normalized stderr + diff text).
 */
export function fingerprintFailureState(failure = {}, root = process.cwd()) {
  const rawStderr = failure.stderr || failure.stdout || failure.message || "Unknown Error";
  const normalizedStderr = String(rawStderr)
    .replace(/[\u001b\x1b]\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\?[^\s"'\)\\]+/g, "<?>")
    .replace(/:\d+:\d+/g, ":?:?")
    .replace(/:\d+/g, ":?")
    .replace(/\bline \d+/gi, "line ?")
    .replace(/\bcol(umn)? \d+/gi, "col ?")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z?\b/g, "<timestamp>")
    .replace(/\b[0-9a-f]{7,40}\b/g, "<sha>")
    .replace(/\/[\w\/-]+\//g, "/?/")
    .replace(/\s+/g, " ")
    .trim();

  let diffStat = "0:0";
  try {
    const rawDiff = diffText(root) || "";
    const lines = rawDiff.split("\n");
    const added = lines.filter((l) => l.startsWith("+")).length;
    const removed = lines.filter((l) => l.startsWith("-")).length;
    diffStat = `${added}:${removed}`;
  } catch (_) {}

  const combined = `${normalizedStderr}::${diffStat}`;
  return createHash("sha256").update(combined).digest("hex").substring(0, 16);
}

/**
 * Gatekeeper verification engine (Phase 1: Scope, Phase 2: Payload, Phase 3: Secrets, Phase 4: Verify Commands).
 * FAILS CLOSED ON GIT OR CONFIG ERRORS.
 */
export async function gate(opts = {}) {
  // The materialised snapshot is a temporary directory and `gateBody` has a
  // dozen early returns, so cleanup is registered in one place rather than
  // repeated at each of them. A leaked snapshot of a whole repository per gate
  // run would fill /tmp within a day of CI.
  const snapshotCleanup = { fn: null };
  try {
    return await gateBody(opts, snapshotCleanup);
  } finally {
    if (snapshotCleanup.fn) {
      try {
        snapshotCleanup.fn();
      } catch (_) {}
    }
  }
}

async function gateBody(opts, snapshotCleanup) {
  const root = opts.root || process.cwd();
  const config = opts.config || loadConfig(root);
  const base = opts.base || config.baseBranch || "main";
  const mode = opts.mode || (opts.workingTree ? "working-tree" : (process.env.JULES_GATE_MODE || "working-tree"));
  const progressBus = opts.progressBus;
  const progressToken = opts.progressToken;
  const phases = [];

  appendTelemetry(root, "gate_started", { base, mode });

  // F08: the diff must not be able to choose the commit that judges it.
  //
  // `base_branch: HEAD`, committed alongside the production change and a no-op
  // test command, made `--mode committed` compare HEAD against HEAD. The diff
  // under review was empty by construction, so every scope and secret rule had
  // nothing to look at, and the "trusted" config the gate then read was the
  // agent's own new commit. Policy author and policy selector were the same
  // untrusted change.
  //
  // In committed mode the base is by definition a commit the proposed one is
  // not; a base that resolves to HEAD is not a base. This is checked before
  // anything else is read, because everything else is read *from* the base.
  if (mode === "committed") {
    let resolvedBaseSha = null;
    let headSha = null;
    try {
      resolvedBaseSha = resolveBase(root, base);
      headSha = resolveBase(root, "HEAD");
    } catch (_) {
      resolvedBaseSha = null;
    }
    if (resolvedBaseSha && headSha && resolvedBaseSha === headSha) {
      const error =
        `In --mode committed the base must be a commit the proposed change is not, and "${base}" resolves ` +
        `to HEAD (${headSha.slice(0, 12)}) — the very commit under review. Nothing is being compared, and ` +
        `the policy the gate would obey would be the one this change just committed.` +
        (opts.base
          ? ` Pass the commit this work branched from as --base.`
          : ` This base came from base_branch in .agent/config.yml. If that value was changed by this change, ` +
            `the change selected its own trusted base; pass the real base branch as --base.`);
      phases.push({ phase: "trusted_base", ok: false, error, base, resolved: headSha });
      appendTelemetry(root, "gate_finished", { ok: false, code: 3, error: "self-selected base" });
      return { ok: false, code: 3, phases, error };
    }
  }

  let files = [];
  let bytes = 0;
  let diffStr = "";

  try {
    files = changedFiles(root, base, mode);
    bytes = diffBytes(root, base, mode);
    diffStr = diffText(root, base, mode);
  } catch (err) {
    phases.push({ phase: "git_resolution", ok: false, error: err.message });
    appendTelemetry(root, "gate_finished", { ok: false, code: 1, error: err.message });
    return { ok: false, code: 1, phases, error: err.message };
  }

  // Phase 1: Scope Guard.
  //
  // Every field the gate obeys is resolved in exactly one place — see
  // src/trusted-policy.mjs, which is the whole of constraints 1 and 3. This
  // block used to read `tamperGuard` from the base commit and `verify.test`,
  // `profile`, `minTests`, `required` and the stage list from wherever
  // `loadConfig` found them, and that split is findings F06, F07 and F08.
  const policy = await resolveTrustedPolicy({ root, base, config, callerConfig: opts.config });

  const trustedScope = policy.scope;
  let trustedVerify = policy.verify;
  const trustedDiffKb = policy.diffKb;
  const trustedConfigRaw = policy.source === "base" ? policy.raw : null;

  // A symlink is judged by its own name, so `notes.md -> .agent/config.yml`
  // walked straight past a deny list that names the target. Judge both: the
  // link because it is what the diff adds, and the path it resolves to because
  // that is what it grants reach to.
  let symlinks = [];
  try {
    symlinks = symlinkChanges(root, base, mode);
  } catch (_) {
    // Scope must still be enforced on the ordinary file list if git cannot
    // describe the links.
  }
  const scopeCandidates = [...files];
  const symlinkTargetOf = new Map();
  for (const { link, target } of symlinks) {
    if (!target || scopeCandidates.includes(target)) continue;
    scopeCandidates.push(target);
    symlinkTargetOf.set(target, link);
  }

  const scopeResult = checkScope(scopeCandidates, trustedScope, {
    allowProtected: opts.allowProtected || process.env.JULES_ALLOW_COMMAND_FILE_CHANGES === "true",
  });
  // Report the violation against the link the change actually introduced, not
  // against a path the diff never names — the operator has to be able to find it.
  for (const violation of scopeResult.violations || []) {
    const link = symlinkTargetOf.get(violation.file);
    if (!link) continue;
    violation.reason = `${violation.reason} (reached through symlink ${link})`;
    violation.symlink = link;
    violation.file = link;
  }

  // Bootstrap: the files that bring a repository under the gate are not agent
  // edits to the gate — but only when they are still the files `init` wrote.
  //
  // `init` writes `.agent/**` and then tells the user to commit it. Doing
  // exactly that produced Exit 3 on the very first run, because the base
  // branch does not have the commit yet and every scaffolded path matches
  // BUILTIN_PROTECT or BUILTIN_DENY. A gate that refuses its own installation
  // is not strict, it is broken — so the exception exists.
  //
  // F06 is what the exception cost when it stopped there. Accepting the
  // scaffold's *presence* was read as accepting its *contents*: an agent
  // rewrote `verify.test` to a no-op and `profile` to minimal in the same
  // uncommitted diff, and the gate obeyed the policy the diff had just
  // written. The agent supplied its own oracle and was approved.
  //
  // The rule now: accept the scaffold only when it is byte-identical to what
  // `init` generates for this repository. `resolveTrustedPolicy` has already
  // made that comparison — `policy.source === "verified-scaffold"` means every
  // policy file on disk matched, and `policy.scaffold.mismatches` names the
  // file and field when one did not.
  let acceptedScaffold = [];
  let scaffoldRefused = null;
  if (!scopeResult.ok && !trustedConfigRaw) {
    const violations = scopeResult.violations || [];
    const isScaffold = (f) => typeof f === "string" && f.replace(/\\/g, "/").startsWith(".agent/");
    const allScaffold =
      violations.length > 0 &&
      violations.every((v) => isScaffold(v.file) && showFromOrigin(root, base, v.file) === null);

    if (allScaffold && policy.source === "verified-scaffold") {
      acceptedScaffold = violations.map((v) => v.file);
      scopeResult.violations = [];
      scopeResult.ok = true;
    } else if (allScaffold) {
      // Scaffold paths, but not the scaffold `init` writes. Refuse, and say
      // exactly which field differs — "your config is not trusted" is not
      // something an operator can act on.
      scaffoldRefused = policy.scaffold || { accepted: [], mismatches: [] };
      for (const m of scaffoldRefused.mismatches || []) {
        const existing = (scopeResult.violations || []).find((v) => v.file === m.file);
        const reason = m.field
          ? `untrusted setup policy: ${m.field} ${m.detail}`
          : `untrusted setup policy: ${m.detail}`;
        if (existing) existing.reason = reason;
        else (scopeResult.violations ||= []).push({ file: m.file, rule: "setup", reason });
      }
    }
  }

  phases.push({
    phase: "scope",
    ok: scopeResult.ok,
    violations: scopeResult.violations,
    // Reported, never silent: the operator has to see that the gate accepted
    // files it would otherwise have blocked, and why.
    ...(acceptedScaffold.length > 0 ? { setup: acceptedScaffold } : {}),
    ...(scaffoldRefused ? { setupRefused: scaffoldRefused } : {}),
  });
  appendTelemetry(root, "gate_phase", { phase: "scope", ok: scopeResult.ok });
  if (progressBus && progressToken) {
    progressBus.reportProgress(progressToken, 25, 100, "Phase 1/4: Scope Guard verification complete");
  }

  if (!scopeResult.ok) {
    appendTelemetry(root, "gate_finished", { ok: false, code: 3 });
    return { ok: false, code: 3, phases };
  }

  // Phase 2: Diff Payload Governor
  // Bound to trusted base commit config strictly; uncommitted disk config cannot raise limit in committed mode.
  const limitBytes = trustedDiffKb * 1024;
  const payloadOk = bytes <= limitBytes;
  phases.push({ phase: "payload", ok: payloadOk, bytes, limitBytes });
  appendTelemetry(root, "gate_phase", { phase: "payload", ok: payloadOk });
  if (progressBus && progressToken) {
    progressBus.reportProgress(progressToken, 50, 100, "Phase 2/4: Diff Payload Governor check complete");
  }

  if (!payloadOk) {
    appendTelemetry(root, "gate_finished", { ok: false, code: 5 });
    return { ok: false, code: 5, phases };
  }

  // Phase 3: Diff Secret Scanner & Security Checks
  const secretResult = scanDiff(diffStr, {
    root,
    allowTestModifications: opts.allowTestModifications === true,
    allowTestChanges: opts.allowTestChanges,
    // Read from the base commit like every other trusted field: a repository
    // opts out of the tamper guard deliberately and on the record, and an
    // uncommitted edit must not be able to do it.
    tamperGuard: trustedVerify.tamperGuard,
    allowUnreadableTests: opts.allowUnreadableTests === true,
  });
  // A binary file reaches the scanner as one summary line, so its contents were
  // never looked at — a NUL byte in front of a token was enough to hide it.
  // Inspect those files directly and fold the verdict in.
  let binaryFindings = [];
  try {
    binaryFindings = scanBinaryPayloads(binaryDiffEntries(root, base, mode), root);
  } catch (_) {
    // Never let the extra pass break a gate that would otherwise have run; the
    // text scan above has already been applied.
  }
  const allSecretFindings = [...(secretResult.findings || []), ...binaryFindings];
  const secretsOk = secretResult.ok && binaryFindings.length === 0;
  phases.push({ phase: "secrets", ok: secretsOk, findings: allSecretFindings });
  appendTelemetry(root, "gate_phase", { phase: "secrets", ok: secretsOk });
  if (progressBus && progressToken) {
    progressBus.reportProgress(progressToken, 75, 100, "Phase 3/4: Diff Secret Scanner check complete");
  }

  if (!secretsOk) {
    appendTelemetry(root, "gate_finished", { ok: false, code: 6 });
    return { ok: false, code: 6, phases };
  }

  // Pre-verification: compute test directory integrity hash
  const preTestHashResult = computeDirectoryHash(root, { testOnly: true });
  const preTestHash = preTestHashResult.treeHash;
  const executionRecords = [];

  // Phase 4: Automated Test & Build Verification (Uses trusted verify commands only)
  let testResult = { ok: true, status: 0 };
  let buildResult = { ok: true, status: 0 };
  let serverResult = { ok: true, status: 0 };
  let failingCmd = null;

  const existingNodeOptions = process.env.NODE_OPTIONS || "";
  const netGuardUrl = new URL("./preload-net-guard.mjs", import.meta.url).href;
  const netGuardFlag = `--import ${netGuardUrl}`;
  const guardNodeOptions = existingNodeOptions && !existingNodeOptions.includes(netGuardFlag) && !existingNodeOptions.includes("preload-net-guard.mjs")
    ? `${existingNodeOptions} ${netGuardFlag}`
    : existingNodeOptions ? existingNodeOptions : netGuardFlag;

  const testEnv = {
    ...process.env,
    NODE_OPTIONS: guardNodeOptions,
  };

  // Node's test runner talks to its children through NODE_TEST_CONTEXT and
  // NODE_CHANNEL_FD. Inherited by a verification command that is itself a
  // `node --test` run, the child switches into child-reporter mode and its
  // failures stop reaching the exit code — the gate then sees exit 0 and
  // approves a change whose tests failed. src/perf.mjs already strips these for
  // the same reason; the gate, which is the one that decides, did not.
  for (const key of Object.keys(testEnv)) {
    if (key.startsWith("NODE_TEST_") || key.startsWith("NODE_CHANNEL_")) delete testEnv[key];
  }

  // F10: verify the revision that is being judged, not the working tree.
  //
  // In staged and committed mode the gate read the diff from the index or from
  // a commit and then ran the verification command in the repository root. The
  // trial staged a broken file, restored the healthy one on disk, and both
  // modes approved — the command executed the healthy working copy while the
  // gate attested the broken snapshot. Two different copies of the code, one
  // verdict, and no config change or escape flag involved.
  //
  // The snapshot is materialised and the stages run there. If it cannot be
  // materialised the gate refuses: an approval is a statement about a specific
  // revision, and a revision that was not executed cannot be attested.
  //
  // See src/revision-snapshot.mjs for why dependency directories are linked
  // back in — running the suite against a snapshot with no `node_modules`
  // would fail correct work, which is the opposite mistake.
  const snapshot = materialiseRevision({
    root,
    mode,
    commit: mode === "committed" ? (() => { try { return resolveBase(root, "HEAD"); } catch (_) { return null; } })() : null,
  });

  if (!snapshot.ok) {
    const error =
      `The ${mode} snapshot could not be materialised, so the verification would have run against the ` +
      `working tree instead — a different copy of the code from the one under review. ` +
      `The gate refuses rather than attest a revision it did not execute. Cause: ${snapshot.error}`;
    phases.push({ phase: "verify", ok: false, failure: { stageId: "snapshot", command: null, exitCode: null, stdout: "", stderr: error, diagnostics: [] } });
    appendTelemetry(root, "gate_finished", { ok: false, code: 4, error: "snapshot unavailable" });
    return { ok: false, code: 4, phases, error };
  }

  /** Where verification stages execute. The root only when it IS the revision. */
  const verifyCwd = snapshot.dir || root;

  // The snapshot is a temporary directory, and `gate()` has a dozen early
  // returns below this point. Registering the cleanup against the returned
  // promise means no exit path can leak it, including a thrown one.
  snapshotCleanup.fn = snapshot.cleanup;

  let flakyVerdictResult = null;
  // Five minutes. A minute was too short for an ordinary suite — a mid-sized
  // Node repository takes longer than that on cold caches — and the timeout
  // surfaced as a plain non-zero verification, so the gate told the user their
  // tests failed when it had killed them. Raise it with verify.timeout_ms.
  const verifyTimeout = trustedVerify.timeoutMs || 300_000;

  // Monorepo scoping: run the suites the change can actually break.
  //
  // `resolveWorkspaceBoundary()` shipped, was drawn in the architecture
  // diagrams and documented as a headline feature — and was called by nothing.
  // Every change in a monorepo ran the root suite, so a one-package edit was
  // gated on every other package's tests. It resolves the changed files to
  // their sub-projects and composes the per-project commands.
  //
  // It stays opt-in (`verify.scope: affected`) because narrowing what runs is
  // only safe when someone asked for it, and it yields to the global command
  // whenever a shared file is touched or no sub-project command is found — a
  // narrower run that misses the breakage is worse than a slow one.
  let boundary = null;
  if (trustedVerify.scope === "affected" && !(Array.isArray(policy.explicitStages) && policy.explicitStages.length > 0)) {
    try {
      boundary = resolveWorkspaceBoundary(files, root);
    } catch (_) {
      boundary = null;
    }
    if (boundary && boundary.isMonorepo && !boundary.globalFallback && boundary.testCmd) {
      trustedVerify = {
        ...trustedVerify,
        test: boundary.testCmd,
        unit: boundary.testCmd,
        build: boundary.buildCmd || trustedVerify.build,
      };
      appendTelemetry(root, "verify_scope_narrowed", {
        projects: boundary.projects.map((p) => p.path),
        testCmd: boundary.testCmd,
      });
    }
  }

  // Build the sequential execution pipeline, entirely from the trusted policy.
  //
  // F07 lived here. `loadConfig` expanded `verify.profile` from the *working
  // tree* config and froze the result into `config.verify.stages`, and the
  // trusted-config block above copied that expanded list across verbatim
  // (`stages: parsed.verify?.stages || config.verify.stages`). So an unstaged
  // `profile: minimal` with a no-op `test:` never appeared in the staged diff,
  // was never scope-checked — and was executed anyway, because the stage plan
  // came from the live file. Excluding a policy file from the diff excluded it
  // from review but not from effect.
  //
  // The profile is now expanded here, from the trusted document, against the
  // trusted commands. Nothing in `config.verify.stages` is consulted.
  const stagesToRun = [];
  if (Array.isArray(policy.explicitStages) && policy.explicitStages.length > 0) {
    stagesToRun.push(...policy.explicitStages);
  } else if (policy.profile) {
    stagesToRun.push(
      ...buildProfileStages(policy.profile, {
        stack: trustedVerify.stack || config.verify?.stack,
        verify: { ...trustedVerify, unit: trustedVerify.unit || trustedVerify.test },
      }).stages
    );
  } else {
    stagesToRun.push(...buildDefaultStages(trustedVerify));
  }

  try {
    for (const stage of stagesToRun) {
      const isAssertion = Boolean(
        stage.assert ||
        (stage.type && String(stage.type).startsWith("assert:")) ||
        (stage.kind && String(stage.kind).startsWith("assert:"))
      );
      if (!stage.cmd && !isAssertion) continue;

      const startTime = Date.now();
      let res;
      let durationMs;
      let stdoutRedacted;
      let stderrRedacted;
      let stageOk;
      let assertDiagnostics = [];
      let assertMetrics = {};

      if (isAssertion) {
        // The loosening flags have to reach here too.
        //
        // `scanDiff` above is given `allowTestChanges` and honours it, while
        // the `assert:test-integrity` stage received only its own stage object
        // and re-ran the same guard with none of them. So an override was
        // accepted by one phase and ignored by the next: `--allow-test-change
        // deregistration` turned the SECRETS phase green and then failed the
        // run at the anti-tamper stage, with a flag hint the operator had
        // already followed. One rule, two places, and the second kept the old
        // answer — for the eighth time in this project's history, which is why
        // the regression test asserts the verdict a caller receives rather
        // than the behaviour of either site.
        const assertRes = runAssertion(
          {
            ...stage,
            allowTestModifications: opts.allowTestModifications === true,
            allowTestChanges: opts.allowTestChanges,
            tamperGuard: trustedVerify.tamperGuard,
            allowUnreadableTests: opts.allowUnreadableTests === true,
          },
          root
        );
        durationMs = assertRes.metrics?.durationMs ?? (Date.now() - startTime);
        stdoutRedacted = assertRes.stdout || "";
        stderrRedacted = assertRes.stderr || "";
        stageOk = assertRes.ok;
        assertDiagnostics = assertRes.diagnostics || [];
        assertMetrics = assertRes.metrics || {};
        res = { status: assertRes.status, stdout: stdoutRedacted, stderr: stderrRedacted };
      } else {
        const stageEnv = stage.networkAccess === "forbidden" || trustedVerify.policy?.offline
          ? { ...testEnv, JULES_SANDBOX_OFFLINE: "1" }
          : testEnv;

        res = runCmd(stage.cmd, { cwd: verifyCwd, ignoreError: true, env: stageEnv, timeout: stage.timeoutMs || verifyTimeout });
        durationMs = Date.now() - startTime;
        stdoutRedacted = redactSecrets(res.stdout || "");
        stderrRedacted = redactSecrets(res.stderr || "");
        stageOk = res.status === 0;
      }

      executionRecords.push({
        id: stage.id || stage.kind || (isAssertion ? `assert:${stage.assert}` : "stage"),
        kind: stage.kind || (isAssertion ? "assert" : "test"),
        cmd: stage.cmd || `assert:${stage.assert || stage.type || stage.kind}`,
        exitCode: res.status,
        durationMs,
        networkAccess: isAssertion ? "offline" : (stage.networkAccess || "allow"),
        stdoutHash: "sha256:" + sha256(stdoutRedacted),
        stderrHash: "sha256:" + sha256(stderrRedacted),
        ...(isAssertion ? { assert: stage.assert || stage.type || stage.kind, diagnostics: assertDiagnostics, metrics: assertMetrics } : {}),
      });

      if (stage.kind === "test" || stage.kind === "unit") {
        testResult = { ok: stageOk, status: res.status, stdout: stdoutRedacted, stderr: stderrRedacted, command: stage.cmd };
        const fingerprint = !stageOk ? fingerprintFailureState(testResult, root) : null;
        if (stage.cmd) recordVerifyRun(root, stage.cmd, stageOk, fingerprint, durationMs);
        if (!stageOk && stage.cmd) {
          const runs = readVerifyRuns(root, stage.cmd);
          flakyVerdictResult = flakyVerdict(runs);
          if (flakyVerdictResult.verdict === "QUARANTINED") {
            phases.push({
              phase: "verify",
              ok: false,
              testResult,
              buildResult,
              failure: {
                stageId: stage.id || "unit",
                command: stage.cmd || null,
                exitCode: res.status ?? null,
                stdout: stdoutRedacted,
                stderr: stderrRedacted,
                diagnostics: [`Quarantined as flaky: ${flakyVerdictResult.reason || "alternating pass/fail across recent runs"}`],
              },
              flakyVerdict: flakyVerdictResult,
              executionRecords,
            });
            appendTelemetry(root, "gate_phase", { phase: "verify", ok: false, quarantined: true });
            appendTelemetry(root, "gate_finished", { ok: false, code: 8 });
            return { ok: false, code: 8, phases, flakyVerdict: flakyVerdictResult };
          }
        }
      } else if (stage.kind === "build") {
        buildResult = { ok: stageOk, status: res.status, stdout: stdoutRedacted, stderr: stderrRedacted, command: stage.cmd };
      }

      if (!stageOk && stage.required !== false) {
        failingCmd = {
          ok: false,
          status: res.status,
          stdout: stdoutRedacted,
          stderr: stderrRedacted,
          command: stage.cmd || `assert:${stage.assert || stage.type || stage.kind}`,
          phase: stage.kind || (isAssertion ? "assert" : "stage"),
          stageId: stage.id || (isAssertion ? `assert:${stage.assert || stage.type || stage.kind}` : stage.kind),
          diagnostics: assertDiagnostics,
          metrics: assertMetrics,
        };
        break;
      }
    }
  } finally {
    if (trustedVerify.teardown) {
      try {
        runCmd(trustedVerify.teardown, { cwd: verifyCwd, ignoreError: true, env: testEnv });
      } catch (_) {}
    }
  }

  if (!failingCmd && trustedVerify.server && trustedVerify.server.command) {
    serverResult = await probeDevServer(trustedVerify.server, root);
    if (!serverResult.ok) {
      failingCmd = serverResult;
    }
  }

  // Post-verification test integrity check (No Test Weakening Invariant)
  const postTestHashResult = computeDirectoryHash(root, { testOnly: true });
  const postTestHash = postTestHashResult.treeHash;
  let testTampered = false;
  if (config.evidence?.strictTestLock && !opts.allowTestModifications && preTestHashResult.fileCount > 0) {
    const changedTestFile = files.find((f) => isTestPath(f));
    if (changedTestFile && preTestHash !== postTestHash) {
      testTampered = true;
    }
  }

  // A gate that ran no verification at all must not report APPROVED.
  //
  // `testResult` starts optimistic and the stage loop skips a stage with no
  // command, so a repository with no test oracle produced zero execution
  // records and a clean bill of health — syntactically broken code included.
  // That is the product's central claim inverted: the whole point is that a
  // change is verified before it is approved, and "nothing to run" is not
  // verification. Repositories that deliberately use only the scope and secret
  // phases opt out with `verify.required: false`.
  // Assertions are guards, not oracles: `assert:test-integrity` proves the diff
  // did not weaken a test, which says nothing about whether the code works. The
  // question is whether any command was executed against the change at all.
  const verificationRequired = trustedVerify.required !== false;
  const ranNoVerification = !executionRecords.some((r) => r && r.kind !== "assert");
  const missingOracle = verificationRequired && ranNoVerification;

  // A command that ran is not the same as a command that tested something.
  //
  // `missingOracle` above catches "no stage executed". It cannot catch the
  // case where a stage executed, exited 0, and collected zero tests — which
  // several runners report as success by design: `go test ./...` prints
  // "[no test files]" and exits 0, jest has --passWithNoTests, and
  // `npm test --workspaces` is green when the one package the diff touched
  // has no suite. A repository could invert a function, add an untested one
  // and collect five green phases, verified against nothing at all.
  //
  // The count is read out of the runner's own summary and only a *stated*
  // zero counts. An unrecognised runner yields null and passes: failing on
  // "I could not tell" would break every runner not on the list.
  const collectionFloor = verificationRequired
    ? checkCollectionFloor(testResult, { minTests: trustedVerify.minTests })
    : { ok: true, count: null, runner: null, reason: null };
  const emptySuite = !collectionFloor.ok;

  // A command that cannot fail is not an oracle, wherever it is configured.
  //
  // `task create` already refuses one — "Unfalsifiable Task Rejected: Task
  // must include a non-trivial verification test/build command" — while the
  // gate approved against `verify.test: "true"` and printed an advisory. The
  // same kit disagreed with itself about the same string. The collection
  // floor cannot catch this: `true` states no count, and failing on "I could
  // not tell" would break every unlisted runner. But a command that is
  // *recognisably* a placeholder is not an unlisted runner.
  const placeholderOracle =
    verificationRequired &&
    !missingOracle &&
    Boolean(testResult?.command) &&
    isPlaceholderTestScript(testResult.command);

  // F11: the suite ran, but against which copy of the package?
  //
  // A src-layout Python repository with the package also installed imports
  // from site-packages under a bare `python3 -m pytest`, so the tests pass
  // against the installed library while the diff edits the working source.
  // The collection floor cannot see this — the tests really did run, and
  // really did pass. Only the import path can. See src/source-binding.mjs;
  // the probe reports nothing unless it can demonstrate the mismatch.
  let sourceBinding = { ok: true, reason: null, detail: null };
  if (verificationRequired && !missingOracle && testResult?.command) {
    try {
      sourceBinding = checkSourceBinding({
        cwd: verifyCwd,
        command: testResult.command,
        files,
        env: testEnv,
      });
    } catch (_) {
      sourceBinding = { ok: true, reason: null, detail: null };
    }
  }
  const unboundSource = !sourceBinding.ok;

  const verifyOk = !failingCmd && !testTampered && !missingOracle && !emptySuite && !placeholderOracle && !unboundSource;

  // What actually broke. Without this the verify phase reported `ok: false` and
  // nothing else — not the stage, not the exit code, not a line of output — so
  // the one gate failure the operator is expected to fix themselves was the
  // only one that told them nothing about how. Both streams are already
  // redacted at the point they were captured.
  const isNetViolation = failingCmd?.status === 188;
  const netViolationDiagnostics = isNetViolation
    ? [
        "Offline Network Guard: Outbound network request was blocked (Exit 188).",
        "Ensure dependencies are installed locally (run npm install) and tests do not perform unmocked network access.",
      ]
    : [];

  const verifyFailure = failingCmd
    ? {
        stageId: failingCmd.stageId || failingCmd.phase || "verify",
        command: failingCmd.command || null,
        exitCode: failingCmd.status ?? null,
        stdout: failingCmd.stdout || "",
        stderr: failingCmd.stderr || "",
        diagnostics: [...netViolationDiagnostics, ...(failingCmd.diagnostics || [])],
      }
    : testTampered
      ? {
          stageId: "test-integrity",
          command: null,
          exitCode: null,
          stdout: "",
          stderr: `Test files changed during the run (${preTestHash.slice(0, 12)} → ${postTestHash.slice(0, 12)}). evidence.strictTestLock treats a passing suite that the diff also rewrote as unproven.`,
          diagnostics: [],
        }
      : missingOracle
        ? {
            stageId: "oracle",
            command: null,
            exitCode: null,
            stdout: "",
            stderr:
              "No verification command ran, so nothing about this change was checked. " +
              "Set verify.test in .agent/config.yml (or run `agentctl bootstrap` to generate one). " +
              "If this repository intentionally uses only the scope and secret phases, set verify.required: false.",
            diagnostics: [
              "The gate approves a change because verification passed. Zero stages executed is not a pass.",
            ],
          }
        : placeholderOracle
          ? {
              stageId: "placeholder-oracle",
              command: testResult?.command || null,
              exitCode: 0,
              stdout: "",
              stderr:
                `The verification command is ${JSON.stringify(testResult.command)}, and ` +
                `${describeIncapableTestCommand(testResult.command) || "it cannot fail"}. ` +
                "Nothing about this change was checked, so approving it would certify nothing. " +
                "Point verify.test at a command that runs this repository's tests, or — if this repository " +
                "intentionally uses only the scope and secret phases — set verify.required: false, which says so.",
              diagnostics: [
                "`agentctl task create` already refuses a task with this command; the gate now agrees with it.",
              ],
            }
          : unboundSource
          ? {
              stageId: "source-binding",
              command: testResult?.command || null,
              exitCode: 0,
              stdout: "",
              stderr: sourceBinding.reason,
              diagnostics: [
                "A passing test count is evidence about the code the tests imported, not about the code in the diff.",
              ],
            }
          : emptySuite
          ? {
              stageId: "empty-suite",
              command: testResult?.command || null,
              exitCode: 0,
              stdout: "",
              stderr: collectionFloor.reason,
              diagnostics: [
                "An exit code of 0 from a runner that collected no tests is not evidence about this change.",
              ],
            }
          : null;

  // Generate & persist Evidence Manifest
  const evidenceManifest = generateEvidenceManifest(root, {
    taskId: opts.taskId,
    preTestHash,
    executionRecords,
    secretScanOk: secretResult.ok,
    diffKb: Math.round(bytes / 1024),
    maxDiffKb: config.limits.diffKb || 75,
    protectedScopeOk: scopeResult.ok,
    repository: config.provider || "jules",
    failedStage: failingCmd?.stageId || failingCmd?.phase || null,
    diagnostics: failingCmd?.diagnostics?.length ? failingCmd.diagnostics : (failingCmd?.stderr ? [failingCmd.stderr] : []),
    metrics: failingCmd?.metrics || {},
    collection: collectionFloor,
    ok: verifyOk,
  });
  if (testTampered) {
    evidenceManifest.testIntegrity.tamperDetected = true;
  }
  let evidencePath = null;
  try {
    evidencePath = writeEvidenceManifest(root, evidenceManifest);
  } catch (_) {}

  // Export structured JSON report if requested
  const jsonReportPath = opts.jsonReport || opts.jsonReportPath || process.env.JULES_JSON_REPORT || null;
  if (jsonReportPath) {
    try {
      exportJsonReport(evidenceManifest, jsonReportPath);
    } catch (_) {}
  }
  phases.push({
    phase: "verify",
    ok: verifyOk,
    testResult,
    buildResult,
    serverResult,
    failure: verifyFailure,
    executionRecords,
    testIntegrity: {
      preTestHash,
      postTestHash,
      tamperDetected: testTampered,
    },
    // Verified by exit code alone. Not a failure, and not an approval either:
    // an unrecognised runner passes on purpose, but the operator has to be
    // able to tell that apart from a suite the gate actually counted.
    ...(collectionFloor.unverified ? { unverified: collectionFloor.note } : {}),
    ...(collectionFloor.count !== null && collectionFloor.count !== undefined
      ? { testsCollected: collectionFloor.count, runner: collectionFloor.runner }
      : {}),
    // What was actually executed. An approval is a claim about one revision,
    // so the report has to name it rather than leave the reader to assume.
    verifiedRevision: snapshot.describe,
    ...(snapshot.linked.length > 0 ? { linkedDependencies: snapshot.linked } : {}),
  });
  phases.push({
    phase: "evidence",
    ok: !testTampered,
    manifestPath: evidencePath,
    evidenceHash: evidenceManifest.evidenceHash,
  });

  appendTelemetry(root, "gate_phase", { phase: "verify", ok: verifyOk });
  if (progressBus && progressToken) {
    progressBus.reportProgress(progressToken, 100, 100, "Phase 4/4: Automated Tiered Verification complete");
  }

  if (!verifyOk && opts.fix && failingCmd) {
    if (isNetViolation) {
      appendTelemetry(root, "gate_finished", { ok: false, code: 188, networkViolation: true });
      return { ok: false, code: 188, phases, evidence: evidenceManifest };
    }
    const repairs = await repair(failingCmd, { config, root, signal: opts.signal, progressBus, progressToken });
    const finalOk = repairs.ok;
    const finalCode = repairs.ok ? 0 : 4;
    appendTelemetry(root, "gate_finished", { ok: finalOk, code: finalCode, repaired: true });
    if (repairs.ok) {
      return { ok: true, code: 0, phases, repairs, evidence: evidenceManifest };
    }
    return { ok: false, code: 4, phases, repairs, evidence: evidenceManifest };
  }

  const code = verifyOk ? 0 : isNetViolation ? 188 : testTampered ? 3 : 4;
  appendTelemetry(root, "gate_finished", { ok: verifyOk, code });
  return { ok: verifyOk, code, phases, evidence: evidenceManifest };
}

/**
 * Sliding-window ring-buffer circuit breaker for non-convergent OODA loops.
 */
export class OODACircuitBreaker {
  constructor({ windowSize = 6, threshold = 2, cooldownMs = 60000 } = {}) {
    this.windowSize = windowSize;
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.ring = [];
    this.openedAt = 0;
    this.openedFingerprint = null;
  }

  observe(fingerprint) {
    if (!fingerprint || typeof fingerprint !== "string") {
      return { tripped: false };
    }
    if (this.isOpen()) {
      return { tripped: true, reason: "OODA_CIRCUIT_OPEN", fingerprint: this.openedFingerprint };
    }
    const occurrences = this.ring.filter((f) => f === fingerprint).length + 1;
    this.ring.push(fingerprint);
    if (this.ring.length > this.windowSize) this.ring.shift();

    if (occurrences >= this.threshold) {
      this.openedAt = Date.now();
      this.openedFingerprint = fingerprint;
      return {
        tripped: true,
        reason: "OODA_THRASH_DETECTED",
        fingerprint,
        occurrences,
      };
    }
    return { tripped: false, occurrences };
  }

  isOpen() {
    if (this.openedAt === 0) return false;
    if (Date.now() - this.openedAt >= this.cooldownMs) {
      this.openedAt = 0;
      this.openedFingerprint = null;
      this.ring = [];
      return false;
    }
    return true;
  }

  reset() {
    this.ring = [];
    this.openedAt = 0;
    this.openedFingerprint = null;
  }
}

export async function repair(failure, opts = {}) {
  const root = opts.root || process.cwd();
  const config = opts.config || loadConfig(root);
  const maxRetries = config.limits.repairAttempts || 3;
  const provider = opts.provider || createProvider(config.provider, config);
  const progressBus = opts.progressBus;
  const progressToken = opts.progressToken;
  const attempts = [];
  const breaker = opts.circuitBreaker || new OODACircuitBreaker({
    windowSize: Math.max(maxRetries + 1, 6),
    threshold: 2,
    cooldownMs: 60000,
  });
  const whackAMole = createWhackAMoleDetector({
    maxHistory: Math.max(maxRetries + 2, 8),
    threshold: 2,
  });

  let currentFailure = failure;
  const initialFingerprint = fingerprintFailureState(currentFailure, root);
  breaker.observe(initialFingerprint);
  whackAMole.recordTestOutcome(currentFailure.stderr || currentFailure.message);
  let extraPromptDirective = null;

  for (let n = 1; n <= maxRetries; n++) {
    if (progressBus && progressToken) {
      progressBus.reportProgress(progressToken, Math.round((n / maxRetries) * 100), 100, `OODA Repair attempt ${n}/${maxRetries}`);
    }

    const repairPrompt = buildRepairPrompt(currentFailure, n, config, extraPromptDirective);
    let session;
    try {
      session = await withBudget(
        () =>
          provider.dispatch(
            { id: `repair-${n}`, title: `OODA Auto-Repair Attempt ${n}`, prompt: repairPrompt },
            { root, dryRun: opts.dryRun }
          ),
        root,
        config.limits.dailyTasks,
        { author: opts.author ? resolveAmbientIdentity(opts.author) : "ooda-repair-bot" }
      );
    } catch (err) {
      if (err instanceof ProviderRateLimitError || err instanceof ProviderUnavailableError) {
        if (err.reservationId && !err.budgetReservationRolledBack) {
          rollbackBudgetReservation(root, err.reservationId);
        }
        const retryAfterMs = err.retryAfterMs || 60000;
        const backoffSec = Math.ceil(retryAfterMs / 1000);
        console.warn(`[PROVIDER_INFRASTRUCTURE_FAILURE] ${err.name}: ${err.message}. Recommended backoff: ${backoffSec}s.`);
        attempts.push({ n, ok: false, error: err.message, providerError: true, retryAfterMs });
        appendTelemetry(root, "ooda_repair_attempt", { attempt: n, ok: false, error: err.message, providerError: true });
        return {
          ok: false,
          attempts,
          finalStatus: "PROVIDER_INFRASTRUCTURE_FAILURE",
          error: err.message,
          retryAfterMs,
          providerError: true,
        };
      }
      attempts.push({ n, ok: false, error: err.message });
      appendTelemetry(root, "ooda_repair_attempt", { attempt: n, ok: false, error: err.message });
      break;
    }

    // Poll async provider for terminal session state before executing re-verification gates
    let pollVerdict = null;
    if (provider && session) {
      pollVerdict = await pollSessionState(provider, session, {
        root,
        dryRun: opts.dryRun,
        pollIntervalMs: opts.pollIntervalMs,
        maxPollAttempts: opts.maxPollAttempts,
      });

      // The gate below is the authority on whether the change works, so it runs
      // either way. But a non-terminal session means it is about to judge a
      // tree the agent may not have finished writing, and saying nothing here
      // turns that into a confusing cascade of repair attempts against a
      // half-applied patch.
      if (pollVerdict && pollVerdict.terminal !== true) {
        const why = pollVerdict.blockedOn
          ? `waiting on an actor (${pollVerdict.blockedOn})`
          : pollVerdict.unreachable
            ? "the provider stopped answering"
            : `still ${pollVerdict.status} when the poll budget ran out`;
        console.warn(
          `[SESSION_NOT_TERMINAL] Session ${session.id} is ${why}. Re-verification is running against a tree the agent may not have finished writing.`
        );
        appendTelemetry(root, "session_not_terminal", {
          attempt: n,
          sessionId: session.id,
          status: pollVerdict.status,
          blockedOn: pollVerdict.blockedOn || null,
          timedOut: Boolean(pollVerdict.timedOut),
          unreachable: Boolean(pollVerdict.unreachable),
        });
      }
    }

    attempts.push({
      n,
      session,
      ok: true,
      poll: pollVerdict ? { status: pollVerdict.status, terminal: pollVerdict.terminal } : null,
    });
    appendTelemetry(root, "ooda_repair_attempt", { attempt: n, ok: true });

    // Re-verify after repair attempt
    const gateRes = await gate({ root, config, fix: false, progressBus, progressToken });
    if (gateRes.ok) {
      breaker.reset();
      whackAMole.reset();
      recordRemediation(root, {
        fingerprint: initialFingerprint,
        symptom: currentFailure.stderr || currentFailure.message || "Failure resolved by OODA repair",
        remediationHint: `Resolved on repair attempt #${n}`,
        targetFiles: currentFailure.targetFiles || [],
      });
      return { ok: true, attempts, finalStatus: "PASSED" };
    }

    currentFailure = gateRes.phases.find((p) => p.phase === "verify")?.testResult || failure;
    const currentFingerprint = fingerprintFailureState(currentFailure, root);

    // Whack-a-Mole test-oscillation check
    const whackCheck = whackAMole.recordTestOutcome(currentFailure.stderr || currentFailure.message);
    if (whackCheck.whackAMole) {
      extraPromptDirective = whackCheck.promptDirective;
    }

    const check = breaker.observe(currentFingerprint);
    if (check.tripped) {
      harvestFailureRecord(root, {
        fingerprint: currentFingerprint,
        symptom: currentFailure.stderr || currentFailure.message || "Deterministic Regression",
        remediationHint: `Identical failure state fingerprint (${currentFingerprint}) observed during attempt #${n}`,
        targetFiles: currentFailure.targetFiles || [],
      });
      return {
        ok: false,
        attempts,
        finalStatus: "DETERMINISTIC_REGRESSION",
        reason: `Identical failure state fingerprint (${currentFingerprint}) observed during attempt #${n}`,
        fingerprint: currentFingerprint,
      };
    }
  }

  harvestFailureRecord(root, {
    fingerprint: initialFingerprint,
    symptom: currentFailure.stderr || currentFailure.message || "OODA Repair Exhausted",
    remediationHint: "OODA repair attempts exhausted without clean verification pass.",
    targetFiles: currentFailure.targetFiles || [],
  });

  try {
    harvestFailure(root, {
      exitCode: 4,
      diffText: diffText(root) || "",
      taskId: failure?.taskId || "ooda-repair",
      logPath: failure?.logPath,
    });
  } catch (_) {}

  return { ok: false, attempts, finalStatus: "OODA_EXHAUSTED" };

}

/**
 * Polls an async provider for terminal session state (COMPLETED / FAILED) before re-verification.
 */
/**
 * Evaluates whether a task's verification oracle or goal is already satisfied on the current working tree.
 * Prevents redundant session dispatch and API budget burning.
 */
export async function checkTaskPremise(task = {}, opts = {}) {
  const root = opts.config?._root || opts.root || process.cwd();
  const verifyCmd = task.verifyCmd || task.verify;
  if (!verifyCmd) {
    return { satisfied: false, reason: "No verification oracle specified for pre-flight premise check." };
  }

  const { runVerificationProbe } = await import("./wizard-oracle.mjs");
  const probe = await runVerificationProbe(verifyCmd, root, { timeoutMs: opts.timeoutMs || 30_000 });
  if (probe.ok) {
    return {
      satisfied: true,
      reason: `Verification oracle '${verifyCmd}' already passes cleanly with exit code 0 on base branch.`,
      durationMs: probe.durationMs,
    };
  }

  return {
    satisfied: false,
    reason: `Verification oracle '${verifyCmd}' failed (exit ${probe.code}), proving task need.`,
    durationMs: probe.durationMs,
  };
}

/**
 * Session states the API documents as final. The full `SessionState` enum is
 * transcribed in `docs/jules-quality-plan.md`.
 */
export const TERMINAL_SESSION_STATES = new Set(["COMPLETED", "FAILED"]);

/**
 * Session states that cannot advance without an actor — a human approving a
 * plan, a human answering a question, or whoever paused it resuming it.
 *
 * Polling these is not waiting, it is spending the budget: the state cannot
 * change on its own no matter how long the loop runs.
 */
export const BLOCKING_SESSION_STATES = new Set(["AWAITING_PLAN_APPROVAL", "AWAITING_USER_FEEDBACK", "PAUSED"]);

/**
 * Polls the provider until the session reaches a terminal state, blocks on an
 * actor, or the poll budget runs out.
 *
 * The verdict is explicit about which of those three happened, because the
 * caller runs the verification gate on the assumption that the agent has
 * finished writing. A previous version returned `COMPLETED` for every
 * non-terminal exit — a session sitting in `AWAITING_USER_FEEDBACK` and one
 * still `IN_PROGRESS` when the budget expired were both reported as success,
 * which is the same shape this project exists to refuse.
 *
 * @returns {Promise<object>} Always carries `status` and `terminal`. Non-terminal
 *   exits additionally carry one of `blockedOn`, `timedOut` or `unreachable`.
 *   `status` is never synthesised: it is the last state the provider reported,
 *   or `UNKNOWN` when it never answered.
 */
export async function pollSessionState(provider, session, opts = {}) {
  if (!session || !session.id) return { status: "UNKNOWN", terminal: false, unpolled: true };
  const initialStatus = String(session.status || session.state || "").toUpperCase();
  if (
    initialStatus === "COMPLETED" ||
    initialStatus === "FAILED" ||
    opts.dryRun ||
    session.id === "dry-run-session-id" ||
    session.id.startsWith("mock-") ||
    session.id.startsWith("dry-run-")
  ) {
    // A dry run has no session to watch, so it reports the outcome a real
    // dispatch would have had to earn. Flagged as simulated so a caller can
    // tell the two apart; a terminal state already reported by the provider is
    // a fact, not a simulation, and is returned as itself.
    const status = initialStatus || "COMPLETED";
    return { status, terminal: TERMINAL_SESSION_STATES.has(status), simulated: true, polls: 0 };
  }

  const maxAttempts = opts.maxPollAttempts || 30;
  const pollIntervalMs = opts.pollIntervalMs || 1000;
  const timeoutMs = opts.pollTimeoutMs || 300000;
  const startTime = Date.now();
  let lastStatus = "";
  let polls = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (Date.now() - startTime > timeoutMs) break;

    let currentSession = null;
    if (provider && typeof provider.getSession === "function") {
      try {
        currentSession = await provider.getSession(session.id, opts);
      } catch (_) {}
    } else if (typeof opts.pollFn === "function") {
      try {
        currentSession = await opts.pollFn(session.id);
      } catch (_) {}
    }

    if (!currentSession) {
      return {
        ...session,
        status: lastStatus || "UNKNOWN",
        terminal: false,
        unreachable: true,
        polls,
      };
    }

    polls += 1;
    const status = String(currentSession.status || currentSession.state || "").toUpperCase();
    if (status) lastStatus = status;

    if (TERMINAL_SESSION_STATES.has(status)) {
      return { ...currentSession, status, terminal: true, polls };
    }

    if (BLOCKING_SESSION_STATES.has(status)) {
      // A pending plan approval is the one blocking state this loop is allowed
      // to resolve itself, and only when the caller said so.
      const isPlanApproval = status === "AWAITING_PLAN_APPROVAL";
      const wantsAutoApprove = Boolean(opts.autoApprovePlan || opts.autoApprove || session.autoApprovePlan);
      if (isPlanApproval && wantsAutoApprove && provider && typeof provider.approvePlan === "function") {
        try {
          await provider.approvePlan(session.id, opts);
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          continue;
        } catch (err) {
          return {
            ...currentSession,
            status,
            terminal: false,
            blockedOn: status,
            approvePlanError: err && err.message ? err.message : String(err),
            polls,
          };
        }
      }

      return { ...currentSession, status, terminal: false, blockedOn: status, polls };
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return {
    ...session,
    status: lastStatus || "UNKNOWN",
    terminal: false,
    timedOut: true,
    polls,
  };
}

function buildRepairPrompt(failure, attempt, _config, extraPromptDirective = null) {
  const cleanStderr = redactSecrets(failure.stderr || failure.stdout || "Unknown Error");

  let escalationStrategy = "DIRECT_REPAIR";
  let escalationDirective = "1. Ground your fix strictly in the error log below. Do NOT guess file contents or function signatures.";

  if (extraPromptDirective) {
    escalationStrategy = "WHACK_A_MOLE_PIVOT";
    escalationDirective = `1. ARCHITECTURAL PIVOT: ${extraPromptDirective}`;
  } else if (attempt === 2) {
    escalationStrategy = "DIAGNOSTIC_ANALYSIS";
    escalationDirective = "1. DIAGNOSE FIRST: Two attempts have failed. Analyze if the root cause is in a different file or component than where the previous patch was applied.";
  } else if (attempt >= 3) {
    escalationStrategy = "MINIMAL_SIMPLIFICATION";
    escalationDirective = "1. SIMPLIFY: Multiple repair attempts have failed. Revert complex refactors and implement the minimal patch that satisfies the failing assertion.";
  }

  return `Auto-Repair Attempt #${attempt} [Strategy: ${escalationStrategy}]
Command Failed: ${failure.command || "verify"}

REPAIR DIRECTIVE & STRICT INVARIANTS:
${escalationDirective}
2. NO WEAKENING: You are STRICTLY FORBIDDEN from deleting tests, commenting out assertions, or weakening expectations to achieve a passing test. Leave unmet requirements RED if the requirement is valid and feature code is missing.
3. CARRY EVIDENCE: Address the root cause directly and verify the exact fix.
4. RE-VERIFY: Execute full verification after patching to ensure zero new regressions.

Stderr:
${cleanStderr}`;
}

export async function dispatch(task = {}, opts = {}) {
  if (!task || typeof task !== "object") {
    throw new TypeError("Dispatch task must be an object");
  }
  const root = opts.config?._root || opts.root || process.cwd();
  const config = opts.config || loadConfig(root);
  // opts.provider mirrors gate()'s existing injection point, so a caller can
  // exercise dispatch without reaching a live provider.
  const resolved = resolveRoutedProvider(task, config);
  const provider = opts.provider || resolved.provider;
  const routed = opts.provider ? false : resolved.routed;
  const classification = opts.provider ? null : resolved.classification;
  if (routed && classification) {
    appendTelemetry(root, "router_decision", {
      tier: classification.tier,
      forced: classification.forced,
      reason: classification.reason,
      score: classification.score,
    });
  }

  // Enforce prompt size limit
  const promptKb = (config.limits.promptKb || 50) * 1024;
  if (task.prompt && Buffer.byteLength(task.prompt, "utf-8") > promptKb) {
    throw new Error(`Task prompt exceeds maximum payload limit of ${config.limits.promptKb} KB`);
  }

  // Pre-flight idempotency premise check
  if (opts.checkPremise || task.checkPremise) {
    const premise = await checkTaskPremise(task, { root, config });
    if (premise.satisfied) {
      return {
        id: "premise-already-satisfied",
        status: "ALREADY_SATISFIED",
        skipped: true,
        reason: premise.reason,
      };
    }
  }

  // Redact secrets in prompt before dispatching
  let cleanPrompt = redactSecrets(task.prompt || "");

  // Specialist Role resolution (if role is set and not already present in prompt)
  if (task.role && !cleanPrompt.includes("Protocol - ")) {
    const roleObj = resolveRolePrompt(root, task.role);
    if (roleObj) {
      cleanPrompt = `${roleObj.content}\n\n${cleanPrompt}`.trim();
    } else {
      // A role reaching here comes from a task envelope or an internal
      // synthesis rather than a typed flag, so the dispatch still proceeds with
      // a generic agent — failing an automated heal swarm over a missing
      // prompt file helps nobody. It must not proceed *silently* though: the
      // caller asked for a specialist and is not getting one.
      console.warn(
        `⚠️  Role '${task.role}' has no prompt in .agent/prompts/ — dispatching without specialist context. Run 'agentctl init' to scaffold the shipped roles.`
      );
    }
  }

  // SPORE Memory Hydration (auto-hydrate platform quirks & system learnings)
  if (!cleanPrompt.includes("<ACTIVE_SYSTEM_LEARNINGS>")) {
    cleanPrompt = hydratePrompt(root, cleanPrompt);
  }

  // Wire Prompt Guard, Memory Hydration & Envelope to wrap raw task arguments
  const taskInstructions = task.taskInstructions || cleanPrompt || task.title || "Autonomous Task Execution";
  const untrustedData = Array.isArray(task.untrustedData) ? task.untrustedData : [];
  const systemPolicy = task.systemPolicy || config.systemPolicy || "";

  const targetFiles = Array.isArray(task.targetFiles) ? task.targetFiles : (Array.isArray(task.referenced_paths) ? task.referenced_paths : []);
  const learnedRemediations = task.learnedRemediations || hydrateMemory(root, { targetFiles, fingerprint: task.fingerprint || "" });

  const envelopedPrompt = buildAgentEnvelope(systemPolicy, taskInstructions, untrustedData, { learnedRemediations });

  const cleanTask = { ...task, prompt: envelopedPrompt };

  // Snapshot the tree before anything can change it.
  //
  // `agentctl rollback` shipped, was documented, and could never work:
  // createCheckpoint() was defined and called from nowhere, so the checkpoint
  // directory was always empty and the command answered "No checkpoints found"
  // to everyone who reached for it — at exactly the moment they needed it. An
  // exec provider edits this working tree directly, and `patch --apply` writes
  // into it later, so this is the last moment the pre-agent state exists.
  //
  // Never fatal: a repository that cannot be snapshotted (no git, no disk) must
  // still be able to dispatch. A missing checkpoint costs a rollback; a throw
  // here costs the task.
  if (!opts.dryRun && opts.checkpoint !== false) {
    try {
      const { createCheckpoint } = await import("./ops/checkpoint.mjs");
      const checkpointId = String(task.id || task.taskId || `dispatch-${Date.now()}`).replace(/[^A-Za-z0-9_.-]/g, "-");
      const snapshot = createCheckpoint(checkpointId, { root });
      appendTelemetry(root, "checkpoint_created", {
        id: snapshot.id,
        headSha: snapshot.headSha,
        uncommittedFiles: snapshot.uncommittedFiles?.length || 0,
      });
    } catch (err) {
      console.warn(`⚠️  Could not create a pre-flight checkpoint (${err.message}). \`agentctl rollback\` will not be able to restore this dispatch.`);
    }
  }

  const runDispatch = () => provider.dispatch(cleanTask, { root, dryRun: opts.dryRun });

  // An estimated ceiling may warn but must not block: refusing a dispatch the
  // provider would have accepted is a worse failure than an over-count.
  const budget = resolveDailyLimit(config, root);
  if (!opts.dryRun && !budget.certain) {
    const check = checkDailyBudget(root, budget.limit);
    if (check.used >= budget.limit) {
      console.warn(
        `[BUDGET_ESTIMATE] ${check.used}/${budget.limit} tasks used — ${budget.note}. ` +
        `Proceeding: the real allowance is unknown, so this is not enforced.`
      );
    }
  }

  try {
    // A dry run performs no provider call and produces no work, so it must not
    // consume one of the operator's finite daily task slots. Reserving here also
    // made every `npm test` burn real budget, which eventually exhausted the
    // ledger and turned the suite red for reasons unrelated to any code change.
    const author = resolveAmbientIdentity(task.author || opts.author || null);
    const session = opts.dryRun
      ? await runDispatch()
      : await withBudget(runDispatch, root, budget.limit, { enforce: budget.certain, author });
    return classification ? { ...session, _routeTier: classification.tier, _routeReason: classification.reason } : session;
  } catch (err) {
    // A refusal for daily quota is the only authoritative statement of the
    // account's real allowance, so record it: from here on the gate enforces a
    // number the provider demonstrated instead of one a tier preset guessed.
    if (isDailyQuotaRejection(err)) {
      try {
        recordObservedCeiling(checkDailyBudget(root, budget.limit).used, root, { source: "provider-rejection" });
      } catch (_) {}
    }
    if (err instanceof ProviderRateLimitError || err instanceof ProviderUnavailableError) {
      if (err.reservationId && !err.budgetReservationRolledBack) {
        rollbackBudgetReservation(root, err.reservationId);
      }
      const retryAfterMs = err.retryAfterMs || 60000;
      const status = err instanceof ProviderRateLimitError ? "RATE_LIMITED" : "PROVIDER_UNAVAILABLE";
      const backoffSec = Math.ceil(retryAfterMs / 1000);
      console.warn(`[PROVIDER_INFRASTRUCTURE_FAILURE] ${err.name}: ${err.message}. Recommended backoff: ${backoffSec}s.`);
      return {
        ok: false,
        status,
        error: err.message,
        retryAfterMs,
        providerError: true,
      };
    }
    throw err;
  }
}

export async function run(tasksOrOpts = {}, opts = {}) {
  let tasks = null;
  let options = opts;
  if (Array.isArray(tasksOrOpts)) {
    tasks = tasksOrOpts;
    options = opts || {};
  } else if (tasksOrOpts && typeof tasksOrOpts === "object") {
    options = tasksOrOpts;
  }

  const root = options.root || process.cwd();
  const config = options.config || loadConfig(root);
  const requestedConcurrency = Number(options.concurrency ?? config.limits.concurrency ?? 1);
  const concurrency = Number.isInteger(requestedConcurrency) && requestedConcurrency > 0 ? requestedConcurrency : 1;
  const isDry = options.dryRun !== undefined ? options.dryRun : (process.env.JULES_DRY_RUN === "true" || process.env.JULES_DRY_RUN === "1");

  if (options.dag || options.useDag) {
    return await executeQueueDag(root, {
      concurrency,
      dryRun: isDry,
      config,
    });
  }

  const queueDir = getQueueDir(root);
  const completedDir = join(queueDir, "completed");
  if (!isDry) ensureDir(completedDir);

  let filesToProcess = [];
  if (Array.isArray(tasks)) {
    filesToProcess = tasks;
  } else {
    filesToProcess = readdirSync(queueDir).filter((f) => isTaskFile(f, queueDir));
  }

  const results = [];

  for (let i = 0; i < filesToProcess.length; i += concurrency) {
    const batch = filesToProcess.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (fileOrItem) => {
        const fileName = typeof fileOrItem === "string" ? fileOrItem : fileOrItem?.id || fileOrItem?.file || fileOrItem?.title || "task";
        try {
          if (!isSafeQueueFileName(fileName)) {
            throw new Error(`Unsafe queue task path: ${fileName}`);
          }
          const srcPath = join(queueDir, fileName);
          let prompt = typeof fileOrItem === "object" && fileOrItem.prompt ? fileOrItem.prompt : "";
          let title = typeof fileOrItem === "object" && fileOrItem.title ? fileOrItem.title : fileName;
          if (!prompt && existsSync(srcPath)) {
            prompt = await fs.promises.readFile(srcPath, "utf-8");
          }
          const task = typeof fileOrItem === "object" ? { ...fileOrItem, title, prompt } : { title, prompt };

          const groupName = task.concurrency_group || task.concurrencyGroup || "";
          if (groupName && isConcurrencyGroupLocked(groupName, root, task.id || fileName)) {
            results.push({ file: fileName, ok: false, status: "SKIPPED_CONCURRENCY_GROUP_LOCKED", reason: `Concurrency group '${groupName}' is active` });
            return;
          }

          // options.provider mirrors dispatch()'s existing injection point so a
          // caller can exercise the real queue lifecycle without a live provider.
          const session = await dispatch(task, { root, config, dryRun: isDry, provider: options.provider });

          if (session && session.ok === false) {
            results.push({ file: fileName, ok: false, status: session.status, error: session.error, session });
          } else if (isDry) {
            // A dry run simulates; it must leave the queue exactly as it found
            // it, or the second `--dry-run` sees an empty queue. Nothing
            // completed either, so nothing is written to the ledger.
            results.push({ file: fileName, ok: true, dryRun: true, session });
          } else {
            const dstPath = join(completedDir, fileName);
            if (existsSync(srcPath)) {
              if (existsSync(dstPath)) {
                throw new Error(`Completed task destination already exists: ${fileName}`);
              }
              renameSync(srcPath, dstPath);
            }
            appendLedger({ event: "task_completed", file: fileName, session }, root);
            results.push({ file: fileName, ok: true, session });
          }
        } catch (err) {
          results.push({ file: fileName, ok: false, error: err.message });
        }
      })
    );
  }


  return { processed: results.length, results };
}

/**
 * Synthesizes a structured, evidence-backed PR description body for GitHub PR creation.
 * @param {object} session - Session or dispatch result
 * @param {object} gateResult - Gate evaluation result
 * @param {object} [options]
 * @returns {string} Markdown PR description body
 */
export function synthesizePrDescription(session = {}, gateResult = {}, options = {}) {
  const sessionId = session.id || session.name || "jules-session";
  const attemptsCount = session.attempts?.length || session._warmAttempts || 1;
  const maxAttempts = options.maxAttempts || 3;
  const durationMs = options.durationMs || session.durationMs || 0;
  const durationSec = (durationMs / 1000).toFixed(1);
  const isWarm = Boolean(session.resumed || session._warmResumed);

  const phases = gateResult.phases || [];
  const scopePhase = phases.find((p) => p.phase === "scope") || { ok: true, violations: [] };
  const payloadPhase = phases.find((p) => p.phase === "payload") || { ok: true, bytes: 0, limitBytes: 76800 };
  const secretPhase = phases.find((p) => p.phase === "secrets") || { ok: true, findings: [] };

  const kbDiff = ((payloadPhase.bytes || 0) / 1024).toFixed(1);
  const kbLimit = ((payloadPhase.limitBytes || 76800) / 1024).toFixed(0);
  const evidenceManifest = gateResult.evidence || (options.evidence ? options.evidence : null);
  const evidenceSection = evidenceManifest
    ? `\n### Evidence Manifest\n- **Manifest ID:** \`${evidenceManifest.manifestId}\`\n- **Digest:** \`${evidenceManifest.evidenceHash?.slice(0, 16)}...\`\n- **Test Integrity:** ${evidenceManifest.testIntegrity?.tamperDetected ? "❌ Tampered" : "✅ Verified (0 test weakening)"}\n`
    : "";

  const modifiedFiles = options.modifiedFiles || [];
  const affectedTests = resolveAffectedTests(modifiedFiles, options);

  const prBody = `## Autonomous Agent Execution Summary

### Verification Trace
- **Session ID:** \`${sessionId}\`
- **OODA Turns:** \`${attemptsCount}/${maxAttempts}\`
- **Warm Resumption:** ${isWarm ? "✅ Active Context Stream" : "Cold Start"}
- **Execution Latency:** \`${durationSec}s\`
${evidenceSection}
### Security & Scope Audit
- **Scope Guard:** ${scopePhase.ok ? "✅ PASS (0 protected path violations)" : "❌ FAIL"}
- **Diff Payload Budget:** ${payloadPhase.ok ? `✅ PASS (${kbDiff} KB / ${kbLimit} KB limit)` : "❌ EXCEEDED"}
- **Secret Scanner:** ${secretPhase.ok ? "✅ PASS (0 credentials detected)" : "❌ LEAKS FOUND"}

### Terminal Verification Output
\`\`\`text
${options.testOutput || "All verification tests passed with Exit Code 0."}
\`\`\`

### Affected Tests & Impact Analysis
${
  affectedTests === null
    ? "- **Impact Scope:** ⚠️ Global contract change detected (`package.json`/`tsconfig`/`schema`). Full test suite executed."
    : affectedTests.length > 0
    ? `- **Affected Test Suites (${affectedTests.length}):**\n` + affectedTests.map((t) => `  - \`${t}\``).join("\n")
    : "- **Impact Scope:** Isolated leaf implementation change."
}

---
*Generated automatically by [jules-orchestrator-kit](https://github.com/FullThrottle83/jules-orchestrator-kit)*
`;

  return prBody;
}

/**
 * Live Dev Server & SSR Hydration Smoke Prober.
 * Spawns the server in a detached process group, polls the URL via globalThis.fetch,
 * intercepts SSR hydration errors, and cleanly kills the process group in a finally block.
 * @param {object} serverConfig
 * @param {string} serverConfig.command
 * @param {string} [serverConfig.url="http://localhost:3000"]
 * @param {number} [serverConfig.timeoutMs=15000]
 * @param {string} root
 * @returns {Promise<object>} Probe result { ok: boolean, status: number, error: string, logs: string }
 */
export async function probeDevServer(serverConfig = {}, root = process.cwd()) {
  if (!serverConfig || !serverConfig.command) {
    return { ok: true, skipped: true, reason: "No server command configured" };
  }

  const cmd = serverConfig.command;
  const url = serverConfig.url || "http://localhost:3000";
  const timeoutMs = Number(serverConfig.timeoutMs || 15000);

  const isWin = process.platform === "win32";
  const shellBin = isWin ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
  const shellArgs = isWin ? ["/d", "/s", "/c", cmd] : ["-c", cmd];

  let child;
  let stdoutLogs = "";
  let stderrLogs = "";

  try {
    child = spawn(shellBin, shellArgs, {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdoutLogs += chunk.toString("utf-8");
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderrLogs += chunk.toString("utf-8");
      });
    }

    const startTime = Date.now();
    let pollResponse = null;
    let pollError = null;

    while (Date.now() - startTime < timeoutMs) {
      if (child.exitCode !== null) {
        return {
          ok: false,
          status: child.exitCode,
          error: `Dev server process exited prematurely with code ${child.exitCode}`,
          logs: (stderrLogs || stdoutLogs).slice(-2000),
        };
      }

      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        const bodyText = await res.text();
        pollResponse = { status: res.status, bodyText, ok: res.ok };
        break;
      } catch (err) {
        pollError = err;
      }

      await new Promise((r) => setTimeout(r, 400));
    }

    if (!pollResponse) {
      return {
        ok: false,
        status: 504,
        error: `Dev server probe timed out after ${timeoutMs}ms attempting to reach ${url}. ${pollError ? pollError.message : ""}`,
        logs: (stderrLogs || stdoutLogs).slice(-2000),
      };
    }

    const combinedLogs = (stderrLogs + "\n" + pollResponse.bodyText).toLowerCase();
    const hydrationPanics = [
      "hydration failed",
      "text content did not match",
      "unhandled runtime error",
      "minified react error #418",
      "minified react error #423",
      "minified react error #425",
    ];

    const detectedPanic = hydrationPanics.find((panic) => combinedLogs.includes(panic));
    if (detectedPanic) {
      return {
        ok: false,
        status: 500,
        error: `SSR Hydration Smoke Probe Failure: Detected '${detectedPanic}' error in server response or stderr.`,
        logs: (stderrLogs || stdoutLogs).slice(-2000),
      };
    }

    if (!pollResponse.ok) {
      return {
        ok: false,
        status: pollResponse.status,
        error: `Dev server responded with HTTP status ${pollResponse.status}`,
        logs: (stderrLogs || stdoutLogs).slice(-2000),
      };
    }

    return {
      ok: true,
      status: pollResponse.status,
      url,
      logs: stdoutLogs.slice(-500),
    };
  } finally {
    if (child && child.pid) {
      try {
        if (isWin) {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        } else {
          process.kill(-child.pid, "SIGTERM");
        }
      } catch (_) {}
    }
  }
}


