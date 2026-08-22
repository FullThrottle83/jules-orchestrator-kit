import test from "node:test";
import assert from "node:assert/strict";
import { createProvider, createFailoverProvider } from "../src/provider.mjs";
import { harvestPullRequests, evaluateStatusCheckRollup, parseTierFilter, formatHarvestTable } from "../src/ops/pr-harvest.mjs";
import { checkTaskPremise, dispatch } from "../src/engine.mjs";
import { getWebTemplate, synthesizeWebEnvelope } from "../src/web-templates.mjs";
import { scorePromptFalsifiability } from "../src/task-optimizer.mjs";

test("Jules API Provider: getSession & approvePlan", async (t) => {
  await t.test("getSession returns mock state on dry-run", async () => {
    const provider = createProvider("jules");
    const res = await provider.getSession("session-12345", { dryRun: true });
    assert.equal(res.id, "session-12345");
    assert.equal(res.status, "active");
  });

  await t.test("approvePlan returns approved state on dry-run", async () => {
    const provider = createProvider("jules");
    const res = await provider.approvePlan("session-12345", { dryRun: true });
    assert.equal(res.id, "session-12345");
    assert.equal(res.status, "approved");
    assert.equal(res.approved, true);
  });

  await t.test("getSession validates session ID string", async () => {
    const provider = createProvider("jules");
    await assert.rejects(async () => {
      await provider.getSession(null, { dryRun: true });
    }, /requires a valid sessionId string/);
  });

  await t.test("approvePlan validates session ID string", async () => {
    const provider = createProvider("jules");
    await assert.rejects(async () => {
      await provider.approvePlan("", { dryRun: true });
    }, /requires a valid sessionId string/);
  });

  await t.test("createFailoverProvider propagates getSession and approvePlan", async () => {
    const failover = createFailoverProvider(["jules"]);
    const getRes = await failover.getSession("session-test-failover", { dryRun: true });
    assert.equal(getRes.id, "session-test-failover");

    const approveRes = await failover.approvePlan("session-test-failover", { dryRun: true });
    assert.equal(approveRes.id, "session-test-failover");
    assert.equal(approveRes.approved, true);
  });
});

test("Automated PR Harvester: evaluateStatusCheckRollup & triage", async (t) => {
  await t.test("evaluateStatusCheckRollup handles green, pending, and failing checks", () => {
    const passingChecks = [
      { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "lint", status: "COMPLETED", conclusion: "NEUTRAL" },
      { name: "build", status: "COMPLETED", conclusion: "SKIPPED" },
    ];
    assert.deepEqual(evaluateStatusCheckRollup(passingChecks), {
      passing: true,
      pending: false,
      failing: false,
      summary: "PASSING (3)",
    });

    const pendingChecks = [
      { name: "test", status: "IN_PROGRESS", conclusion: "" },
      { name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
    ];
    assert.deepEqual(evaluateStatusCheckRollup(pendingChecks), {
      passing: false,
      pending: true,
      failing: false,
      summary: "PENDING (1)",
    });

    const failingChecks = [
      { name: "test", status: "COMPLETED", conclusion: "FAILURE" },
      { name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
    ];
    assert.deepEqual(evaluateStatusCheckRollup(failingChecks), {
      passing: false,
      pending: false,
      failing: true,
      summary: "FAILED (1)",
    });

    assert.equal(evaluateStatusCheckRollup([]).passing, true);
  });

  await t.test("parseTierFilter parses strings and arrays", () => {
    assert.deepEqual(Array.from(parseTierFilter("r0,r1")), ["R0_COSMETIC", "R1_ROUTINE"]);
    assert.deepEqual(Array.from(parseTierFilter(["r0", "r2"])), ["R0_COSMETIC", "R2_CONSEQUENTIAL"]);
    assert.deepEqual(Array.from(parseTierFilter(null)), ["R0_COSMETIC", "R1_ROUTINE"]);
  });

  await t.test("harvestPullRequests triages PRs and auto-merges eligible items", async () => {
    const mockPrs = [
      {
        number: 101,
        title: "docs: update guide",
        headRefName: "jules/docs-101",
        mergeable: "MERGEABLE",
        files: [{ path: "docs/guide.md" }],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      },
      {
        number: 102,
        title: "chore: update ci workflow",
        headRefName: "jules/ci-102",
        mergeable: "MERGEABLE",
        files: [{ path: ".github/workflows/ci.yml" }], // R3 Restricted
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      },
      {
        number: 103,
        title: "feat: broken tests",
        headRefName: "jules/feat-103",
        mergeable: "MERGEABLE",
        files: [{ path: "src/utils.mjs" }],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
      },
    ];

    const mergedList = [];
    const result = await harvestPullRequests(process.cwd(), {
      tier: "R0,R1",
      auto: true,
      execGh: async () => mockPrs,
      mergeGh: async (num) => {
        mergedList.push(num);
        return { ok: true };
      },
    });

    assert.equal(result.summary.total, 3);
    assert.equal(result.summary.eligible, 1);
    assert.equal(result.summary.merged, 1);
    assert.equal(mergedList.length, 1);
    assert.equal(mergedList[0], 101);

    const table = formatHarvestTable(result);
    assert.ok(table.includes("#101"));
    assert.ok(table.includes("docs: update guide"));
    assert.ok(table.includes("Summary: 3 total PRs · 1 eligible · 1 merged · 2 skipped"));
  });
});

test("Pre-Flight Idempotency Gate: checkTaskPremise & dispatch", async (t) => {
  await t.test("checkTaskPremise returns satisfied when verifyCmd passes cleanly", async () => {
    const task = {
      title: "Already Satisfied Task",
      verifyCmd: 'node -e "process.exit(0)"',
    };
    const res = await checkTaskPremise(task, { root: process.cwd() });
    assert.equal(res.satisfied, true);
    assert.ok(res.reason.includes("already passes cleanly"));
  });

  await t.test("checkTaskPremise returns false when verifyCmd fails", async () => {
    const task = {
      title: "Unmet Task",
      verifyCmd: 'node -e "process.exit(1)"',
    };
    const res = await checkTaskPremise(task, { root: process.cwd() });
    assert.equal(res.satisfied, false);
    assert.ok(res.reason.includes("proving task need"));
  });

  await t.test("dispatch with checkPremise skips dispatch when satisfied", async () => {
    const task = {
      title: "Already Fixed Task",
      prompt: "Fix existing bug",
      verifyCmd: 'node -e "process.exit(0)"',
      checkPremise: true,
    };
    const session = await dispatch(task, { dryRun: true, root: process.cwd() });
    assert.equal(session.status, "ALREADY_SATISFIED");
    assert.equal(session.skipped, true);
  });
});

test("Sandbox & Framework Guardrails", async (t) => {
  await t.test("agent-dead-code-audit template enforces Audit-First principle", () => {
    const tpl = getWebTemplate("agent-dead-code-audit");
    assert.ok(tpl);
    assert.equal(tpl.category, "Refactoring & Audit");

    const env = synthesizeWebEnvelope("agent-dead-code-audit", { targetScope: "src/" });
    assert.ok(env.fullEnvelope.includes("Audit-First Principle"));
    assert.ok(env.fullEnvelope.includes(".agent/reports/dead-code-audit.md"));
    assert.ok(env.fullEnvelope.includes("DO NOT delete files or exports with dynamic runtime references"));
  });

  await t.test("scorePromptFalsifiability flags playwright headless and dead-code suggestions", () => {
    const e2ePrompt = "Add Playwright visual regression test with screenshot for dashboard";
    const e2eAnalysis = scorePromptFalsifiability(e2ePrompt, { rootDir: process.cwd() });
    const hasHeadlessSuggestion = e2eAnalysis.suggestions.some((s) => s.includes("--headless"));
    assert.ok(hasHeadlessSuggestion, "Should suggest --headless for remote VM Playwright tests");

    const deadCodePrompt = "Run knip and remove unused exports and dead code in components";
    const deadCodeAnalysis = scorePromptFalsifiability(deadCodePrompt, { rootDir: process.cwd() });
    const hasAuditFirstSuggestion = deadCodeAnalysis.suggestions.some((s) => s.includes("Audit-First"));
    assert.ok(hasAuditFirstSuggestion, "Should suggest Audit-First report before deleting files");
  });

  await t.test("agent-error-paths includes standalone schema validation rule", () => {
    const env = synthesizeWebEnvelope("agent-error-paths", { targetModules: "src/actions" });
    assert.ok(env.fullEnvelope.includes("Standalone Schema & Validation Testing"));
    assert.ok(env.fullEnvelope.includes("schema.safeParse()"));
  });
});
