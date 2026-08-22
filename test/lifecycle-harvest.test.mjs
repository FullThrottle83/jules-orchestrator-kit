import test from "node:test";
import assert from "node:assert/strict";
import { createProvider, createFailoverProvider } from "../src/provider.mjs";
import { harvestPullRequests, evaluateStatusCheckRollup, parseTierFilter, formatHarvestTable, readPrFiles } from "../src/ops/pr-harvest.mjs";
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
      noChecks: false,
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
      noChecks: false,
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
      noChecks: false,
      summary: "FAILED (1)",
    });

    // An empty rollup is an absence of evidence, not a pass. A repo without CI
    // and a PR whose workflows have not registered yet look identical here.
    const empty = evaluateStatusCheckRollup([]);
    assert.equal(empty.passing, false);
    assert.equal(empty.noChecks, true);
    assert.equal(empty.summary, "NO_CHECKS");
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

  await t.test("a PR with no CI checks is not merged unless allowNoChecks is set", async () => {
    const noCiPr = [
      {
        number: 201,
        title: "fix: tidy helper",
        headRefName: "jules/fix-201",
        mergeable: "MERGEABLE",
        files: [{ path: "src/helper.mjs", additions: 4, deletions: 2 }],
        statusCheckRollup: [],
      },
    ];

    const blockedMerges = [];
    const blocked = await harvestPullRequests(process.cwd(), {
      tier: "R0,R1",
      auto: true,
      execGh: async () => noCiPr,
      mergeGh: async (n) => {
        blockedMerges.push(n);
        return { ok: true };
      },
    });
    assert.equal(blocked.summary.merged, 0);
    assert.equal(blockedMerges.length, 0);
    assert.match(blocked.prs[0].reason, /--allow-no-checks/);

    const allowedMerges = [];
    const allowed = await harvestPullRequests(process.cwd(), {
      tier: "R0,R1",
      auto: true,
      allowNoChecks: true,
      execGh: async () => noCiPr,
      mergeGh: async (n) => {
        allowedMerges.push(n);
        return { ok: true };
      },
    });
    assert.equal(allowed.summary.merged, 1);
    assert.equal(allowed.summary.unverified, 1);
    assert.equal(allowed.prs[0].unverified, true);
    assert.match(formatHarvestTable(allowed), /--allow-no-checks/);
  });

  await t.test("a large diff reaches R2 instead of auto-merging as R1", async () => {
    const bigPr = [
      {
        number: 202,
        title: "refactor: sweep",
        headRefName: "jules/refactor-202",
        mergeable: "MERGEABLE",
        files: [{ path: "src/helper.mjs", additions: 3000, deletions: 2500 }],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      },
    ];

    const res = await harvestPullRequests(process.cwd(), {
      tier: "R0,R1",
      auto: true,
      execGh: async () => bigPr,
      mergeGh: async () => ({ ok: true }),
    });
    assert.equal(res.prs[0].riskTier, "R2_CONSEQUENTIAL");
    assert.equal(res.prs[0].diffLines, 5500);
    assert.equal(res.summary.merged, 0);
  });

  await t.test("an unavailable changed-file list blocks rather than classifying R0", async () => {
    const res = await harvestPullRequests(process.cwd(), {
      tier: "R0,R1",
      auto: true,
      execGh: async () => [
        {
          number: 203,
          title: "chore: unknown scope",
          headRefName: "jules/unknown-203",
          mergeable: "MERGEABLE",
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
        },
      ],
      mergeGh: async () => ({ ok: true }),
    });
    assert.equal(res.summary.merged, 0);
    assert.equal(res.prs[0].eligible, false);
    assert.match(res.prs[0].reason, /Changed-file list unavailable/);
  });

  await t.test("mergeability must be affirmative, not merely non-conflicting", async () => {
    const res = await harvestPullRequests(process.cwd(), {
      tier: "R0,R1",
      auto: true,
      execGh: async () => [
        {
          number: 204,
          title: "docs: tweak",
          headRefName: "jules/docs-204",
          mergeable: "UNKNOWN",
          files: [{ path: "docs/guide.md", additions: 1, deletions: 0 }],
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
        },
      ],
      mergeGh: async () => ({ ok: true }),
    });
    assert.equal(res.summary.merged, 0);
    assert.match(res.prs[0].reason, /Not mergeable \(UNKNOWN\)/);
  });

  await t.test("readPrFiles flags a truncated file page", () => {
    const files = Array.from({ length: 100 }, (_, i) => ({ path: `src/f${i}.mjs`, additions: 1, deletions: 0 }));
    const info = readPrFiles({ files });
    assert.equal(info.truncated, true);
    assert.equal(info.known, true);
    assert.equal(info.diffLines, 100);
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
