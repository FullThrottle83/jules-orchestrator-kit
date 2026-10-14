import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import * as sessionOps from "../src/session-ops.mjs";
import * as sdk from "../index.mjs";
import {
  extractSessionPatch,
  extractFilesFromPatch,
  extractFailureDiagnostics,
  applySessionPatch,
  retrySession,
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
  await t.test("parseAgeDuration and pruneSessions are removed from session-ops and root SDK exports", () => {
    assert.equal(Object.hasOwn(sessionOps, "parseAgeDuration"), false);
    assert.equal(Object.hasOwn(sessionOps, "pruneSessions"), false);
    assert.equal(typeof sessionOps.parseAgeDuration, "undefined");
    assert.equal(typeof sessionOps.pruneSessions, "undefined");
    assert.equal(Object.hasOwn(sdk, "parseAgeDuration"), false);
    assert.equal(Object.hasOwn(sdk, "pruneSessions"), false);
    assert.equal(typeof sdk.parseAgeDuration, "undefined");
    assert.equal(typeof sdk.pruneSessions, "undefined");
    assert.equal(Object.hasOwn(sessionOps, "extractSessionPatch"), true);
    assert.equal(Object.hasOwn(sessionOps, "applySessionPatch"), true);
    assert.equal(Object.hasOwn(sessionOps, "retrySession"), true);
    assert.equal(Object.hasOwn(sdk, "extractSessionPatch"), true);
    assert.equal(Object.hasOwn(sdk, "applySessionPatch"), true);
    assert.equal(Object.hasOwn(sdk, "retrySession"), true);
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

  await t.test("extractSessionPatch prefers finalized outputs[].changeSet.gitPatch.unidiffPatch over earlier activity patch", async () => {
    const finalPatch = `diff --git a/final.js b/final.js
--- a/final.js
+++ b/final.js
@@ -1 +1,2 @@
 export function final() {}
`;
    const earlierPatch = `diff --git a/earlier.js b/earlier.js
--- a/earlier.js
+++ b/earlier.js
@@ -1 +1,2 @@
 export function earlier() {}
`;

    const mockProvider = {
      async getSession(id) {
        return {
          id,
          raw: {
            outputs: [
              {
                changeSet: {
                  gitPatch: {
                    unidiffPatch: finalPatch,
                    baseCommitId: "f00ba42",
                    suggestedCommitMessage: "feat: finalize patch",
                  },
                },
              },
            ],
          },
        };
      },
      async listActivities() {
        return {
          activities: [
            {
              artifacts: [
                {
                  patch: earlierPatch,
                },
              ],
            },
          ],
        };
      },
    };

    const res = await extractSessionPatch("session-final-wins", { provider: mockProvider, root: tmpdir() });
    assert.equal(res.ok, true);
    assert.ok(res.patch.includes("export function final"));
    assert.ok(!res.patch.includes("export function earlier"));
    assert.deepEqual(res.files, ["final.js"]);
    assert.equal(res.baseCommitId, "f00ba42");
    assert.equal(res.suggestedCommitMessage, "feat: finalize patch");
  });

  await t.test("extractSessionPatch retains multi-file canonical changeset without truncation or scratch contamination", async () => {
    const twoFilePatch = `diff --git a/src/a.js b/src/a.js
--- a/src/a.js
+++ b/src/a.js
@@ -1 +1 @@
-a
+a_mod
diff --git a/src/b.js b/src/b.js
--- a/src/b.js
+++ b/src/b.js
@@ -1 +1 @@
-b
+b_mod
`;

    const mockProvider = {
      async getSession(id) {
        return {
          id,
          raw: {
            outputs: [
              {
                changeSet: {
                  gitPatch: {
                    unidiffPatch: twoFilePatch,
                  },
                },
              },
            ],
          },
        };
      },
      async listActivities() {
        return {
          activities: [
            {
              // Activity only saw a single file earlier, and produced scratch artifacts
              artifacts: [
                { path: "src/a.js", patch: "diff --git a/src/a.js b/src/a.js\n..." },
                { path: "src/a.js.orig" },
                { filename: "test/scratch.test.js" },
              ],
              changedFiles: ["src/a.js", "src/a.js.orig", "test/scratch.test.js"],
            },
          ],
        };
      },
    };

    const res = await extractSessionPatch("session-multi-file", { provider: mockProvider, root: tmpdir() });
    assert.equal(res.ok, true);
    assert.equal(res.files.length, 2);
    assert.deepEqual(res.files.sort(), ["src/a.js", "src/b.js"]);
    assert.ok(!res.files.includes("src/a.js.orig"));
    assert.ok(!res.files.includes("test/scratch.test.js"));
  });

  await t.test("extractSessionPatch preserves legacy output formats and retrieves PR from activities if absent in outputs", async () => {
    const patchDiff = `diff --git a/legacy.js b/legacy.js
--- a/legacy.js
+++ b/legacy.js
@@ -1 +1 @@
-old
+new
`;
    const mockProvider = {
      async getSession(id) {
        return {
          id,
          raw: {
            outputs: [{ patch: patchDiff }],
          },
        };
      },
      async listActivities() {
        return {
          activities: [
            {
              pullRequest: { url: "https://github.com/org/repo/pull/789", number: 789 },
            },
          ],
        };
      },
    };

    const res = await extractSessionPatch("session-legacy-formats", { provider: mockProvider, root: tmpdir() });
    assert.equal(res.ok, true);
    assert.ok(res.patch.includes("+new"));
    assert.deepEqual(res.files, ["legacy.js"]);
    assert.equal(res.pr.number, 789);
  });

  await t.test("extractFilesFromPatch parses standard, quoted, and CRLF diff headers accurately", () => {
    const diff = `diff --git a/src/normal.js b/src/normal.js\r\n` +
      `--- a/src/normal.js\r\n+++ b/src/normal.js\r\n` +
      `diff --git "a/src/with spaces.js" "b/src/with spaces.js"\n` +
      `--- "a/src/with spaces.js"\n+++ "b/src/with spaces.js"\n` +
      `diff --git a/deleted.js b//dev/null\n` +
      `--- a/deleted.js\n+++ /dev/null\n` +
      `diff --git a//dev/null b/created.js\n` +
      `--- /dev/null\n+++ b/created.js\n`;

    const files = extractFilesFromPatch(diff);
    assert.equal(files.has("src/normal.js"), true);
    assert.equal(files.has("src/with spaces.js"), true);
    assert.equal(files.has("deleted.js"), true);
    assert.equal(files.has("created.js"), true);
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

  await t.test("applySessionPatch --save succeeds without failing when patch targets an unrelated checkout", async () => {
    const repoDir = createTempGitRepo();
    try {
      const unrelatedPatch = `diff --git a/fixture-only.js b/fixture-only.js
--- a/fixture-only.js
+++ b/fixture-only.js
@@ -1 +1,2 @@
 export function fixture() {}
+export function extra() {}
`;

      const mockProvider = {
        async getSession(id) {
          return {
            id,
            raw: {
              outputs: [
                {
                  changeSet: {
                    gitPatch: {
                      unidiffPatch: unrelatedPatch,
                      baseCommitId: "deadbeefcafe",
                      suggestedCommitMessage: "chore: update fixture",
                    },
                  },
                },
              ],
            },
          };
        },
        async listActivities() {
          return { activities: [] };
        },
      };

      // Save-only mode: save is requested, apply is false
      const saveRes = await applySessionPatch("session-save-only", {
        provider: mockProvider,
        root: repoDir,
        save: "saved-patch.diff",
        apply: false,
      });

      assert.equal(saveRes.ok, true);
      assert.equal(saveRes.patchApplied, false);
      assert.equal(saveRes.checkPassed, false); // Does not cleanly apply to main checkout
      assert.equal(saveRes.baseCommitId, "deadbeefcafe");
      assert.equal(saveRes.suggestedCommitMessage, "chore: update fixture");
      assert.equal(existsSync(join(repoDir, "saved-patch.diff")), true);
      assert.equal(readFileSync(join(repoDir, "saved-patch.diff"), "utf-8"), unrelatedPatch);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  await t.test("applySessionPatch --apply fails safely when git apply --check fails", async () => {
    const repoDir = createTempGitRepo();
    try {
      const unrelatedPatch = `diff --git a/nonexistent.js b/nonexistent.js
--- a/nonexistent.js
+++ b/nonexistent.js
@@ -1 +1,2 @@
 export function none() {}
+export function fail() {}
`;

      const mockProvider = {
        async getSession(id) {
          return {
            id,
            raw: {
              outputs: [
                {
                  changeSet: {
                    gitPatch: {
                      unidiffPatch: unrelatedPatch,
                    },
                  },
                },
              ],
            },
          };
        },
        async listActivities() {
          return { activities: [] };
        },
      };

      const applyRes = await applySessionPatch("session-apply-fail", {
        provider: mockProvider,
        root: repoDir,
        apply: true,
      });

      assert.equal(applyRes.ok, false);
      assert.equal(applyRes.patchApplied, false);
      assert.equal(applyRes.checkPassed, false);
      assert.ok(applyRes.error.includes("git apply --check failed"));
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

  await t.test("agentctl prune fails closed across former flag combinations without contacting provider", () => {
    const dir = createTempGitRepo();
    try {
      const cliPath = join(process.cwd(), "bin", "agentctl.mjs");
      const preloadPath = join(dir, "preload-fetch.mjs");
      const logPath = join(dir, "http-calls.json");
      writeFileSync(
        preloadPath,
        `import { writeFileSync } from "node:fs";
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ method: init.method || "GET", url: String(url) });
  writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(calls));
  throw new Error("Network call prohibited");
};
`
      );

      for (const flagSet of [
        ["prune"],
        ["prune", "--delete"],
        ["prune", "--age", "7d", "--state", "COMPLETED", "--yes"],
      ]) {
        const proc = spawnSync(process.execPath, ["--import", pathToFileURL(preloadPath).href, cliPath, ...flagSet], {
          cwd: dir,
          env: { ...process.env, JULES_API_KEY: "fake-key-must-not-be-used" },
          encoding: "utf-8",
        });
        assert.equal(proc.status, 1);
        assert.equal(proc.stdout, "");
        assert.match(proc.stderr, /Unknown command: "prune"/);
      }
      assert.equal(existsSync(logPath), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("agentctl CLI subcommands (retry, session list, patch) respond cleanly and reject removed prune", () => {
    const cliPath = join(process.cwd(), "bin", "agentctl.mjs");

    // 1. removed prune --dry-run --json exits 1 via unknown-command handler
    assert.throws(
      () => execFileSync(process.execPath, [cliPath, "prune", "--dry-run", "--json"], { encoding: "utf-8", stdio: "pipe" }),
      (err) => err.status === 1 && /Unknown command: "prune"/.test(err.stderr)
    );

    // 2. retry --dry-run --json
    const retryRes = execFileSync(process.execPath, [cliPath, "retry", "session-dry-123", "--dry-run", "--json"], {
      encoding: "utf-8",
    });
    const retryJson = JSON.parse(retryRes);
    assert.equal(retryJson.ok, true);
    assert.equal(retryJson.originalSessionId, "session-dry-123");

    // 3. session list --dry-run --json
    const listRes = execFileSync(process.execPath, [cliPath, "session", "list", "--dry-run", "--json"], {
      encoding: "utf-8",
    });
    const listJson = JSON.parse(listRes);
    assert.equal(listJson.ok, true);
    assert.ok(Array.isArray(listJson.sessions));

    // 4. session list --dry-run (formatted text)
    const listText = execFileSync(process.execPath, [cliPath, "session", "list", "--dry-run"], {
      encoding: "utf-8",
    });
    assert.ok(listText.includes("Sessions List"));

    // 5. patch without session ID exits 1
    assert.throws(
      () => execFileSync(process.execPath, [cliPath, "patch"], { encoding: "utf-8", stdio: "pipe" }),
      (err) => err.status === 1
    );
  });
});
