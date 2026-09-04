import { test, it, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  recordLearning,
  hydratePrompt,
  harvestFailure,
  loadLearnings,
  normalizeTrigger,
  learningSignature,
  CONFIRM_AFTER,
} from "../src/memory.mjs";

describe("Agent Memory Engine", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "spore-mem-test-"));
  });

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("recordLearning saves learning and updates SYSTEM_LEARNINGS.md", () => {
    const res = recordLearning(tmpDir, {
      agent: "test-agent",
      trigger: "SSR crashes on Cloudflare Workers",
      solution: "Do not use node:fs in workerd environment.",
    });

    assert.equal(res.recorded, true);
    assert.equal(res.count, 1);

    const learnings = loadLearnings(tmpDir);
    assert.equal(learnings.length, 1);
    assert.equal(learnings[0].agent, "test-agent");

    const mdFile = join(tmpDir, ".agent", "SYSTEM_LEARNINGS.md");
    assert.equal(existsSync(mdFile), true);
    const mdContent = readFileSync(mdFile, "utf8");
    assert.match(mdContent, /SSR crashes on Cloudflare Workers/);
  });

  test("recordLearning prevents duplicate entries", () => {
    recordLearning(tmpDir, {
      trigger: "Duplicate Trigger",
      solution: "Same Solution",
    });

    const res2 = recordLearning(tmpDir, {
      trigger: "Duplicate Trigger",
      solution: "Same Solution",
    });

    assert.equal(res2.recorded, false);
    assert.equal(res2.count, 1);
  });

  test("hydratePrompt injects active system learnings block", () => {
    recordLearning(tmpDir, {
      trigger: "Authentication token leak in logs",
      solution: "Use redactSecrets before logging headers.",
    });

    const hydrated = hydratePrompt(tmpDir, "Fix auth token logging issue");
    assert.match(hydrated, /<ACTIVE_SYSTEM_LEARNINGS>/);
    assert.match(hydrated, /Use redactSecrets before logging headers/);
  });

  test("harvestFailure rejects test weakening diffs", () => {
    const diffText = `
--- a/test/auth.test.js
+++ b/test/auth.test.js
-  it("should validate JWT token", () => {
-    expect(token).toBeValid();
-  });
`;

    const res = harvestFailure(tmpDir, {
      exitCode: 4,
      diffText,
      taskId: "task-123",
    });

    assert.equal(res.status, "REJECTED");
    assert.match(res.reason, /TEST_WEAKENING/);
  });

  test("harvestFailure harvests valid failure traces", () => {
    const res = harvestFailure(tmpDir, {
      exitCode: 4,
      diffText: "+ console.log('debugging fix');",
      taskId: "task-456",
    });

    assert.equal(res.status, "HARVESTED");
    assert.match(res.candidate.trigger, /\[OODA Exit 4\]/);
  });

  test("dispatch auto-hydrates system learnings and resolves specialist roles", async () => {
    const { dispatch } = await import("../src/engine.mjs");
    const { writeFileSync, mkdirSync } = await import("node:fs");

    // Setup prompts dir with Overseer role
    const promptsDir = join(tmpDir, ".agent", "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      join(promptsDir, "Overseer.md"),
      "# Overseer Protocol - Codebase Audit Specialist\nScan physical directory tree for tech debt."
    );

    // Record a system learning
    recordLearning(tmpDir, {
      trigger: "SSR crashes on Cloudflare Workers",
      solution: "Avoid node:fs in edge runtime.",
    });

    let capturedTask = null;
    const mockProvider = {
      name: "mock",
      dispatch: async (task) => {
        capturedTask = task;
        return { id: "mock-session-123", ok: true };
      },
    };

    const config = {
      _root: tmpDir,
      provider: mockProvider,
      limits: { promptKb: 50, dailyTasks: 100 },
      verify: { test: "npm test" },
    };

    await dispatch(
      {
        title: "Audit task",
        prompt: "Check SSR crashes on Cloudflare Workers",
        role: "overseer",
      },
      { root: tmpDir, config, dryRun: true }
    );

    assert.ok(capturedTask);
    assert.match(capturedTask.prompt, /Overseer Protocol/);
    assert.match(capturedTask.prompt, /<ACTIVE_SYSTEM_LEARNINGS>/);
    assert.match(capturedTask.prompt, /Avoid node:fs in edge runtime/);
  });
});


/**
 * The ledger is prepended to every dispatch prompt, so it decides what the
 * agent is told is true. That makes a single unverified observation becoming
 * a permanent rule the most expensive mistake this module can make — and it
 * was making it on every OODA loop that exhausted its retry budget.
 *
 * Two mechanisms here already solve this evidence problem: `flaky-ledger`
 * wants repeated runs before calling a test flaky, and `remediation` is
 * fingerprint-keyed and short-lived. This was the one learning path that
 * skipped both.
 */
describe("Learning ledger: evidence before rules", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spore-ledger-"));
  });
  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  const harvest = (line) => {
    const logPath = join(dir, "run.log");
    writeFileSync(logPath, line);
    return harvestFailure(dir, { exitCode: 4, logPath, diffText: "+ attempted fix", taskId: "t-1" });
  };

  describe("near-duplicates collapse onto one entry", () => {
    it("normalizes away the parts that differ between two runs of one failure", () => {
      const a = normalizeTrigger("Error: connect ECONNREFUSED 127.0.0.1:54123 at /tmp/build-9a2f/src/net.js:14:9");
      const b = normalizeTrigger("Error: connect ECONNREFUSED 127.0.0.1:51877 at /tmp/build-71bc/src/net.js:22:3");
      assert.equal(a, b, "ports, temp paths and line numbers are not what makes a failure distinct");
      assert.match(a, /econnrefused/, "and the failure class must survive normalization");
    });

    it("keeps genuinely different failures apart", () => {
      assert.notEqual(
        learningSignature("OODA_HARVEST", "TypeError: undefined is not a function"),
        learningSignature("OODA_HARVEST", "Error: connect ECONNREFUSED 127.0.0.1:1")
      );
    });

    it("five occurrences of one failure produce one entry, not five", () => {
      // Measured on the previous version: five rows in learnings.json, five
      // rows in the injected table, five fabricated solutions. The trigger
      // carried 120 characters of raw log line, so exact-string dedup never
      // matched twice.
      for (let i = 0; i < 5; i++) harvest(`Error: connect ECONNREFUSED 127.0.0.1:${50000 + i}`);
      const db = loadLearnings(dir);
      assert.equal(db.length, 1, "a recurrence must update in place, not append a sibling");
      assert.equal(db[0].occurrences, 5);
      assert.ok(db[0].firstSeen && db[0].lastSeen);
    });

    it("reports a recurrence as not-new", () => {
      assert.equal(harvest("Error: boom at x.js:1:1").recorded, true);
      assert.equal(harvest("Error: boom at x.js:9:4").recorded, false);
    });
  });

  describe("one occurrence is not a rule", () => {
    it("does not inject a failure seen once", () => {
      harvest("Error: connect ECONNREFUSED 127.0.0.1:54123");
      const prompt = hydratePrompt(dir, "unrelated task");
      assert.doesNotMatch(prompt, /ACTIVE_SYSTEM_LEARNINGS/);
      assert.doesNotMatch(prompt, /RECURRING_FAILURES/);
    });

    it(`surfaces it once it has recurred ${CONFIRM_AFTER} times — as a count, never as a remedy`, () => {
      for (let i = 0; i < CONFIRM_AFTER; i++) harvest(`Error: connect ECONNREFUSED 127.0.0.1:${50000 + i}`);
      const prompt = hydratePrompt(dir, "unrelated task");
      assert.match(prompt, /RECURRING_FAILURES/);
      assert.match(prompt, new RegExp(`seen ${CONFIRM_AFTER}×`));
      assert.doesNotMatch(prompt, /WHEN: .* → THEN:/, "an observation must never be phrased as an instruction");
    });

    it("a learning somebody wrote down on purpose is a rule immediately", () => {
      // Deliberate statements are evidence of a different kind: the CLI and
      // MCP paths mean someone chose to record this, so gating them on
      // recurrence would make `agentctl learning add` do nothing visible.
      recordLearning(dir, { trigger: "SSR crashes on Cloudflare Workers", solution: "Avoid node:fs in workerd." });
      const prompt = hydratePrompt(dir, "unrelated task");
      assert.match(prompt, /ACTIVE_SYSTEM_LEARNINGS/);
      assert.match(prompt, /WHEN: .* → THEN:/);
    });
  });

  describe("harvestFailure does not invent a fix", () => {
    it("records no solution at all", () => {
      // It used to write one hardcoded sentence into `solution` on every
      // call, and `hydratePrompt` rendered it as `WHEN X → THEN <sentence>`.
      // A record of *failing* to solve something was shipped to the agent as
      // instructions for solving it.
      const res = harvest("AssertionError: expected 3 to equal 4");
      assert.equal(res.status, "HARVESTED");
      assert.equal(res.candidate.solution, undefined);
      const stored = loadLearnings(dir)[0];
      assert.ok(!stored.solution, `harvest stored a solution: ${stored.solution}`);
      assert.equal(stored.confirmed, false);
    });

    it("keeps it out of the rule table in SYSTEM_LEARNINGS.md", () => {
      harvest("AssertionError: expected 3 to equal 4");
      const md = readFileSync(join(dir, ".agent", "SYSTEM_LEARNINGS.md"), "utf8");
      const ruleTable = md.split("## Unconfirmed observations")[0];
      assert.doesNotMatch(ruleTable, /AssertionError/, "an unresolved failure is not a mandatory rule");
      assert.match(md, /Unconfirmed observations/);
    });
  });

  describe("selection and bounds", () => {
    it("the no-keyword-match fallback prefers recurrence over recency", () => {
      recordLearning(dir, { trigger: "alpha quirk", solution: "do alpha", category: "A" });
      for (let i = 0; i < 4; i++) {
        recordLearning(dir, { trigger: `alpha quirk seen again ${i}`, solution: "do alpha", category: "A" });
      }
      recordLearning(dir, { trigger: "zeta quirk", solution: "do zeta", category: "Z" });
      const prompt = hydratePrompt(dir, "nothing in common with either", { max: 1 });
      assert.match(prompt, /do alpha/, "recency alone used to pick whatever was appended last");
    });

    it("stays bounded, and keeps rules over unconfirmed observations", () => {
      for (let i = 0; i < 250; i++) harvest(`Error: distinct failure number ${i} of many`);
      recordLearning(dir, { trigger: "a real rule worth keeping", solution: "keep me" });
      const db = loadLearnings(dir);
      assert.ok(db.length <= 200, `ledger grew to ${db.length}`);
      assert.ok(db.some((l) => l.solution === "keep me"), "a confirmed rule must not be pruned before observations");
    });

    it("a ledger written before signatures existed still loads, and stays trusted", () => {
      // Dropping unlabelled entries on upgrade would silently lose knowledge
      // somebody had deliberately recorded.
      mkdirSync(join(dir, ".agent", "knowledge"), { recursive: true });
      writeFileSync(
        join(dir, ".agent", "knowledge", "learnings.json"),
        JSON.stringify([{ date: "2026-01-01", agent: "old", category: "GENERAL", trigger: "legacy quirk", solution: "legacy fix" }])
      );
      const db = loadLearnings(dir);
      assert.equal(db.length, 1);
      assert.equal(db[0].confirmed, true);
      assert.ok(db[0].signature);
      assert.match(hydratePrompt(dir, "unrelated"), /legacy fix/);
    });
  });
});
