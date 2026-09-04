import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  parseAgeDuration,
  extractSessionPatch,
  extractFailureDiagnostics,
  applySessionPatch,
  retrySession,
  pruneSessions,
} from "../src/session-ops.mjs";

function createTempGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "jules-session-ops-test-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  writeFileSync(join(dir, "calc.js"), "export function add(a, b) { return a + b; }\n", "utf-8");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "initial commit"], { cwd: dir });
  return dir;
}

test("Jules Power-User Session Operations & Lifecycle Engine", async (t) => {
  await t.test("parseAgeDuration accurately parses human-readable duration strings", () => {
    assert.equal(parseAgeDuration("60s"), 60000);
    assert.equal(parseAgeDuration("30m"), 30 * 60 * 1000);
    assert.equal(parseAgeDuration("24h"), 24 * 60 * 60 * 1000);
    assert.equal(parseAgeDuration("7d"), 7 * 24 * 60 * 60 * 1000);
    assert.equal(parseAgeDuration("2w"), 14 * 24 * 60 * 60 * 1000);
    assert.equal(parseAgeDuration(5000), 5000);
    assert.equal(parseAgeDuration("invalid"), 0);
    assert.equal(parseAgeDuration(null), 0);
  });

  await t.test("extractSessionPatch retrieves git diff and PR details from outputs and activities", async () => {
    const samplePatch = `diff --git a/calc.js b/calc.js
--- a/calc.js
+++ b/calc.js
@@ -1 +1,2 @@
 export function add(a, b) { return a + b; }
+export function sub(a, b) { return a - b; }
`;

    const mockProvider = {
      async getSession(id) {
        return {
          id,
          raw: {
            outputs: [
              {
                gitPatch: samplePatch,
                pullRequest: { url: "https://github.com/org/repo/pull/123", number: 123 },
              },
            ],
          },
        };
      },
      async listActivities() {
        return { activities: [] };
      },
    };

    const res = await extractSessionPatch("session-123", { provider: mockProvider, root: tmpdir() });
    assert.equal(res.ok, true);
    assert.equal(res.id, "session-123");
    assert.ok(res.patch.includes("export function sub"));
    assert.equal(res.pr.number, 123);
    assert.ok(res.files.includes("calc.js"));
  });

  await t.test("extractSessionPatch extracts unidiffPatch from Jules changeSet artifact", async () => {
    const samplePatch = `diff --git a/calc.js b/calc.js
--- a/calc.js
+++ b/calc.js
@@ -1 +1,2 @@
 export function add(a, b) { return a + b; }
+export function div(a, b) { return a / b; }
`;

    const mockProvider = {
      async getSession(id) {
        return { id, raw: { outputs: [] } };
      },
      async listActivities() {
        return {
          activities: [
            {
              artifacts: [
                {
                  changeSet: {
                    gitPatch: {
                      unidiffPatch: samplePatch,
                    },
                  },
                },
              ],
            },
          ],
        };
      },
    };

    const res = await extractSessionPatch("session-456", { provider: mockProvider, root: tmpdir() });
    assert.equal(res.ok, true);
    assert.ok(res.patch.includes("export function div"));
    assert.ok(res.files.includes("calc.js"));
  });

  await t.test("applySessionPatch validates and applies patch cleanly to git working tree", async () => {
    const repoDir = createTempGitRepo();
    try {
      const samplePatch = `diff --git a/calc.js b/calc.js
--- a/calc.js
+++ b/calc.js
@@ -1 +1,2 @@
 export function add(a, b) { return a + b; }
+export function multiply(a, b) { return a * b; }
`;

      const mockProvider = {
        async getSession(id) {
          return {
            id,
            raw: {
              outputs: [{ gitPatch: samplePatch }],
            },
          };
        },
        async listActivities() {
          return { activities: [] };
        },
      };

      // 1. Dry run check
      const checkRes = await applySessionPatch("session-456", {
        provider: mockProvider,
        root: repoDir,
        apply: false,
        save: "patch.diff",
      });

      assert.equal(checkRes.ok, true);
      assert.equal(checkRes.checkPassed, true);
      assert.equal(checkRes.patchApplied, false);
      assert.equal(existsSync(join(repoDir, "patch.diff")), true);

      // 2. Real apply
      const applyRes = await applySessionPatch("session-456", {
        provider: mockProvider,
        root: repoDir,
        apply: true,
      });

      assert.equal(applyRes.ok, true);
      assert.equal(applyRes.patchApplied, true);

      const updatedContent = readFileSync(join(repoDir, "calc.js"), "utf-8");
      assert.ok(updatedContent.includes("export function multiply"));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  await t.test("retrySession extracts failure diagnostics and synthesizes OODA retry envelope", async () => {
    let capturedTask = null;

    const mockProvider = {
      async getSession(id) {
        return {
          id,
          raw: {
            title: "Fix bug #42",
            prompt: "Fix arithmetic bug in calculator",
            sourceContext: {
              source: "sources/github/org/repo",
              githubRepoContext: { startingBranch: "main" },
            },
          },
        };
      },
      async listActivities(_id) {
        return {
          activities: [
            {
              status: "FAILED",
              exitCode: 1,
              executionOutput: "FAIL: test_arithmetic failed with AssertionError: expected 4 to equal 5",
            },
          ],
        };
      },
      async dispatch(task) {
        capturedTask = task;
        return { id: "session-retry-999", status: "pending" };
      },
    };

    const res = await retrySession("session-failed-1", {
      provider: mockProvider,
      role: "sentinel",
      withFailure: true,
      root: tmpdir(),
    });

    assert.equal(res.ok, true);
    assert.equal(res.originalSessionId, "session-failed-1");
    assert.equal(res.newSession.id, "session-retry-999");
    assert.ok(capturedTask.prompt.includes("PREVIOUS_ATTEMPT_FAILURE_DIAGNOSTIC"));
    assert.ok(capturedTask.prompt.includes("FAIL: test_arithmetic failed with AssertionError"));
    assert.equal(capturedTask.role, "sentinel");
    assert.equal(capturedTask.source, "sources/github/org/repo");
  });

  await t.test("extractFailureDiagnostics reads the fields the API actually documents", () => {
    // Shaped exactly like https://jules.google/docs/api/reference/activities —
    // the previous reader looked for act.error / act.executionOutput, neither
    // of which exists in that schema, and returned nothing.
    const activities = [
      {
        id: "act1",
        originator: "system",
        description: "Session started",
      },
      {
        id: "act2",
        originator: "agent",
        description: "Running the verification command",
        artifacts: [
          {
            bashOutput: {
              command: "npm test",
              output:
                "not ok 1 - invoice totals must round to cents\n  AssertionError [ERR_ASSERTION]: expected 10.01 to equal 10.00\n    at Test.<anonymous> (test/invoice.test.mjs:41:12)\n# fail 1",
              exitCode: 1,
            },
          },
        ],
      },
      {
        id: "act3",
        originator: "system",
        description: "Session failed",
        sessionFailed: { reason: "Verification command exited non-zero" },
      },
    ];

    const diagnostics = extractFailureDiagnostics(activities);
    const text = diagnostics.map((d) => d.text).join("\n");

    assert.ok(diagnostics.length >= 2, "the failing command and the failure reason are both evidence");
    assert.equal(diagnostics[0].source, "bashOutput", "the failing command leads, it is the strongest evidence");
    assert.ok(text.includes("invoice totals must round to cents"), "the assertion message survives");
    assert.ok(text.includes("test/invoice.test.mjs:41"), "the file and line survive");
    assert.ok(text.includes("(exit code 1)"), "the exit code is stated");
    assert.ok(text.includes("$ npm test"), "the command that produced it is stated");
    assert.ok(
      diagnostics.some((d) => d.source === "sessionFailed"),
      "sessionFailed.reason is collected"
    );
    assert.ok(
      !diagnostics.some((d) => d.text === "Session started"),
      "a system activity with no evidence is not padded into the prompt"
    );
  });

  await t.test("extractFailureDiagnostics orders evidence so the cut keeps the useful part", () => {
    const activities = [
      {
        id: "a1",
        originator: "agent",
        description: "I looked around the invoice module for a while and found some things.",
      },
      {
        id: "a2",
        originator: "agent",
        artifacts: [
          { bashOutput: { command: "ls", output: "src\n", exitCode: 0 } },
          { bashOutput: { command: "npm test", output: "not ok 1 - rounding", exitCode: 1 } },
        ],
      },
    ];
    const diagnostics = extractFailureDiagnostics(activities);
    assert.equal(diagnostics[0].source, "bashOutput");
    assert.ok(diagnostics[0].text.includes("not ok 1 - rounding"));
    assert.ok(
      !diagnostics.some((d) => d.text.includes("ls\nsrc")),
      "a passing, unremarkable command is not evidence"
    );
  });

  await t.test("extractFailureDiagnostics flags a runner that exits 0 while reporting failure", () => {
    const diagnostics = extractFailureDiagnostics([
      {
        id: "a1",
        artifacts: [{ bashOutput: { command: "pytest", output: "1 failed, 12 passed", exitCode: 0 } }],
      },
    ]);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].source, "bashOutput");
    assert.match(diagnostics[0].text, /1 failed, 12 passed/);
  });

  await t.test("extractFailureDiagnostics stays quiet on a green run", () => {
    // The opposite failure matters as much: a collector that flags every
    // command buries the one that failed under a hundred passing ones.
    const green = [
      { id: "a1", artifacts: [{ bashOutput: { command: "pytest", output: "13 passed in 0.42s", exitCode: 0 } }] },
      { id: "a2", artifacts: [{ bashOutput: { command: "npm test", output: "# pass 13\n# fail 0", exitCode: 0 } }] },
      { id: "a3", artifacts: [{ bashOutput: { command: "go test ./...", output: "ok  acme/shop 0.011s", exitCode: 0 } }] },
    ];
    assert.deepEqual(extractFailureDiagnostics(green), []);
  });

  await t.test("extractFailureDiagnostics still reads the legacy field spellings", () => {
    const diagnostics = extractFailureDiagnostics([
      { status: "FAILED", exitCode: 1, executionOutput: "FAIL: test_arithmetic", error: { code: "E_ASSERT" } },
    ]);
    assert.equal(diagnostics.length, 2);
    assert.ok(diagnostics.some((d) => d.source === "legacy.executionOutput"));
    assert.ok(diagnostics.some((d) => d.source === "legacy.error"));
  });

  await t.test("extractFailureDiagnostics deduplicates repeated evidence", () => {
    const same = {
      id: "x",
      artifacts: [{ bashOutput: { command: "npm test", output: "not ok 1 - rounding", exitCode: 1 } }],
    };
    const diagnostics = extractFailureDiagnostics([same, same, same]);
    assert.equal(diagnostics.length, 1);
  });

  await t.test("extractFailureDiagnostics survives junk input", () => {
    assert.deepEqual(extractFailureDiagnostics([]), []);
    assert.deepEqual(extractFailureDiagnostics(null), []);
    assert.deepEqual(extractFailureDiagnostics([null, 7, "x", {}]), []);
    assert.deepEqual(extractFailureDiagnostics([{ artifacts: "not-an-array" }]), []);
    assert.deepEqual(extractFailureDiagnostics([{ artifacts: [{ bashOutput: {} }] }]), []);
  });

  await t.test("retrySession carries the real failure into the retry prompt", async () => {
    let capturedTask = null;
    const mockProvider = {
      async getSession(id) {
        return {
          id,
          raw: {
            title: "Fix invoice rounding",
            prompt: "Fix invoice rounding",
            state: "FAILED",
            sourceContext: {
              source: "sources/github-acme-shop",
              githubRepoContext: { startingBranch: "main" },
            },
          },
        };
      },
      async listActivities() {
        return {
          activities: [
            {
              id: "act2",
              originator: "agent",
              description: "Verification failed",
              artifacts: [
                {
                  bashOutput: {
                    command: "npm test",
                    output: "not ok 1 - invoice totals must round to cents\n  AssertionError: expected 10.01 to equal 10.00",
                    exitCode: 1,
                  },
                },
              ],
            },
          ],
        };
      },
      async dispatch(task) {
        capturedTask = task;
        return { id: "session-retry-1000" };
      },
    };

    const res = await retrySession("session-failed-2", { provider: mockProvider, root: tmpdir() });

    assert.equal(res.ok, true);
    assert.ok(res.diagnosticsFound > 0, "the session carried readable diagnostics");
    assert.deepEqual(res.diagnosticSources, ["bashOutput", "agentMessage"]);
    assert.notEqual(res.failureReason, "Previous session did not complete cleanly.");
    assert.ok(capturedTask.prompt.includes("invoice totals must round to cents"));
    assert.ok(capturedTask.prompt.includes("AssertionError: expected 10.01 to equal 10.00"));
  });

  await t.test("retrySession says so when the session carried no readable diagnostics", async () => {
    const mockProvider = {
      async getSession(id) {
        return { id, raw: { prompt: "Do the thing", title: "Do the thing" } };
      },
      async listActivities() {
        return { activities: [{ id: "a1", description: "Session started" }] };
      },
      async dispatch() {
        return { id: "session-retry-1001" };
      },
    };

    const res = await retrySession("session-empty", { provider: mockProvider, root: tmpdir() });
    assert.equal(res.diagnosticsFound, 0);
    assert.equal(res.failureReason, "Previous session did not complete cleanly.");
  });

  await t.test("pruneSessions filters by age and state, dry-runs, and archives stale sessions", async () => {
    const archivedIds = [];
    const deletedIds = [];

    const mockSessions = [
      {
        id: "s1",
        state: "COMPLETED",
        createTime: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days old
      },
      {
        id: "s2",
        state: "FAILED",
        createTime: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), // 8 days old
      },
      {
        id: "s3",
        state: "COMPLETED",
        createTime: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(), // 1 day old
      },
    ];

    const mockProvider = {
      async listSessions() {
        return { sessions: mockSessions };
      },
      async archiveSession(id) {
        archivedIds.push(id);
        return { id, archived: true };
      },
      async deleteSession(id) {
        deletedIds.push(id);
        return { id, deleted: true };
      },
    };

    // 1. Dry run with age >= 7d
    const dryRes = await pruneSessions({
      provider: mockProvider,
      age: "7d",
      dryRun: true,
      root: tmpdir(),
    });

    assert.equal(dryRes.ok, true);
    assert.equal(dryRes.matchedCount, 2); // s1 and s2
    assert.equal(dryRes.archivedCount, 0); // dry run did not archive
    assert.equal(archivedIds.length, 0);

    // 2. Real archive with age >= 7d and state=FAILED
    const realRes = await pruneSessions({
      provider: mockProvider,
      age: "7d",
      state: "FAILED",
      dryRun: false,
      root: tmpdir(),
    });

    assert.equal(realRes.ok, true);
    assert.equal(realRes.matchedCount, 1); // s2 only
    assert.equal(realRes.archivedCount, 1);
    assert.deepEqual(archivedIds, ["s2"]);
  });

  await t.test("agentctl CLI subcommands (prune, retry, patch) respond cleanly", () => {
    const cliPath = join(process.cwd(), "bin", "agentctl.mjs");

    // 1. prune --dry-run --json
    const pruneRes = execFileSync(process.execPath, [cliPath, "prune", "--dry-run", "--json"], {
      encoding: "utf-8",
    });
    const pruneJson = JSON.parse(pruneRes);
    assert.equal(pruneJson.ok, true);
    assert.equal(typeof pruneJson.matchedCount, "number");

    // 2. retry --dry-run --json
    const retryRes = execFileSync(process.execPath, [cliPath, "retry", "session-dry-123", "--dry-run", "--json"], {
      encoding: "utf-8",
    });
    const retryJson = JSON.parse(retryRes);
    assert.equal(retryJson.ok, true);
    assert.equal(retryJson.originalSessionId, "session-dry-123");
  });
});
