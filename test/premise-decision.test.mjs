import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { checkTaskPremise, dispatch } from "../src/engine.mjs";
import { readTelemetry } from "../src/telemetry.mjs";
import { loadConfig } from "../src/config.mjs";

const GOAL = 'node -e "process.exit(require(\'fs\').existsSync(\'feature.flag\') ? 0 : 1)"';
const GENERIC = "node --test test/legacy.test.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jok-premise-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  mkdirSync(join(root, ".agent"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".agent/state/\n");
  writeFileSync(join(root, ".agent", "config.yml"), "provider: jules\nverify:\n  test: node --test test/legacy.test.mjs\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "premise-fixture", private: true, scripts: { test: GENERIC } }));
  writeFileSync(join(root, "test", "legacy.test.mjs"), 'import { test } from "node:test"; test("legacy works", () => {});\n');
  commit(root, "baseline");
  return root;
}

function commit(root, message) {
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", message], { cwd: root });
}

function revision(root) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim();
}

function lastDecision(root) {
  return readTelemetry(root, 100).filter((entry) => entry.kind === "dispatch_decision").at(-1);
}

function fakeProvider(calls) {
  return { async dispatch(task) { calls.push(task); return { id: "mock-provider", status: "COMPLETED" }; } };
}

test("replay: a green existing suite without goal check is not proof of a new feature", async () => {
  const root = fixture();
  try {
    const result = await checkTaskPremise({ prompt: "Add feature", verifyCmd: GENERIC }, { root });
    assert.equal(result.satisfied, false);
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.reasonCode, "NO_GOAL_CHECK");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("replay: placeholder goal check cannot skip dispatch", async () => {
  const root = fixture();
  try {
    const result = await checkTaskPremise({ goalCheck: "true" }, { root });
    assert.equal(result.reasonCode, "PLACEHOLDER_GOAL_CHECK");
    assert.equal(result.satisfied, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("replay: generic verification reused as goal check is not sufficient", async () => {
  const root = fixture();
  try {
    const result = await checkTaskPremise({ verifyCmd: GENERIC, goalCheck: GENERIC }, { root });
    assert.equal(result.reasonCode, "GENERIC_VERIFY_IS_NOT_GOAL_PROOF");
    assert.equal(result.satisfied, false);
    const fromConfig = await checkTaskPremise({ goalCheck: GENERIC }, { root, config: loadConfig(root) });
    assert.equal(fromConfig.reasonCode, "GENERIC_VERIFY_IS_NOT_GOAL_PROOF");
    assert.equal(fromConfig.satisfied, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("replay: explicit goal check on a clean committed revision proves the goal", async () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "feature.flag"), "implemented\n");
    commit(root, "feature implemented");
    const result = await checkTaskPremise({ goalCheck: GOAL }, { root });
    assert.equal(result.satisfied, true);
    assert.equal(result.status, "PROVEN");
    assert.equal(result.reasonCode, "GOAL_CHECK_SATISFIED");
    assert.equal(result.evidence.revision, revision(root));
    assert.match(result.evidence.goalCheckSha256, /^[0-9a-f]{64}$/);
    assert.equal(result.evidence.exitCode, 0);
    assert.ok(!JSON.stringify(result.evidence).includes(GOAL), "telemetry must not store the goal command");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("replay: failing goal check cannot prove task already satisfied", async () => {
  const root = fixture();
  try {
    const result = await checkTaskPremise({ goalCheck: GOAL }, { root });
    assert.equal(result.satisfied, false);
    assert.equal(result.status, "NOT_PROVEN");
    assert.equal(result.reasonCode, "GOAL_CHECK_NOT_SATISFIED");
    assert.notEqual(result.evidence.exitCode, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("replay: dirty working tree cannot be attributed to the committed revision", async () => {
  const root = fixture();
  try {
    appendFileSync(join(root, "package.json"), "\n");
    const result = await checkTaskPremise({ goalCheck: GOAL }, { root });
    assert.equal(result.satisfied, false);
    assert.equal(result.reasonCode, "DIRTY_WORKTREE");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("replay: goal check that mutates the working tree cannot suppress dispatch", async () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "feature.flag"), "initial\n");
    commit(root, "feature available");
    const mutating = 'node -e "require(\'fs\').writeFileSync(\'feature.flag\', \'mutated\')"';
    const result = await checkTaskPremise({ goalCheck: mutating }, { root });
    assert.equal(result.evidence.exitCode, 0);
    assert.equal(result.satisfied, false);
    assert.equal(result.reasonCode, "GIT_STATE_CHANGED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("replay: green generic tests still dispatch and record why", async () => {
  const root = fixture();
  const calls = [];
  try {
    const result = await dispatch({ id: "generic-only", prompt: "Add feature", verifyCmd: GENERIC, checkPremise: true }, {
      root, config: loadConfig(root), provider: fakeProvider(calls), checkpoint: false,
    });
    assert.equal(result.status, "COMPLETED");
    assert.equal(calls.length, 1);
    const decision = lastDecision(root);
    assert.equal(decision.decision, "DISPATCH");
    assert.equal(decision.reasonCode, "NO_GOAL_CHECK");
    assert.equal(decision.taskId, "generic-only");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("replay: proven goal skips provider and records bounded evidence", async () => {
  const root = fixture();
  const calls = [];
  try {
    writeFileSync(join(root, "feature.flag"), "implemented\n");
    commit(root, "feature implemented");
    const result = await dispatch({ id: "proved", prompt: "Add feature", verifyCmd: GENERIC, goalCheck: GOAL, checkPremise: true }, {
      root, config: loadConfig(root), provider: fakeProvider(calls), checkpoint: false,
    });
    assert.equal(result.status, "ALREADY_SATISFIED");
    assert.equal(result.skipped, true);
    assert.equal(calls.length, 0);
    const decision = lastDecision(root);
    assert.equal(decision.decision, "SKIP");
    assert.equal(decision.reasonCode, "GOAL_CHECK_SATISFIED");
    assert.equal(decision.evidence.revision, revision(root));
    assert.equal(decision.evidence.exitCode, 0);
    assert.ok(!JSON.stringify(decision).includes(GOAL));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("replay: failed goal check dispatches and records the observed failure", async () => {
  const root = fixture();
  const calls = [];
  try {
    const result = await dispatch({ id: "needs-work", prompt: "Add feature", goalCheck: GOAL, checkPremise: true }, {
      root, config: loadConfig(root), provider: fakeProvider(calls), checkpoint: false,
    });
    assert.equal(result.status, "COMPLETED");
    assert.equal(calls.length, 1);
    const decision = lastDecision(root);
    assert.equal(decision.decision, "DISPATCH");
    assert.equal(decision.reasonCode, "GOAL_CHECK_NOT_SATISFIED");
    assert.notEqual(decision.evidence.exitCode, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("replay: dry-run never executes a potentially mutating goal check", async () => {
  const root = fixture();
  const calls = [];
  try {
    const cmd = 'node -e "require(\'fs\').writeFileSync(\'new-side-effect.txt\', \'oops\')"';
    const result = await dispatch({ prompt: "Preview task", goalCheck: cmd, checkPremise: true }, {
      root, config: loadConfig(root), provider: fakeProvider(calls), checkpoint: false, dryRun: true,
    });
    assert.equal(result.status, "COMPLETED");
    assert.equal(calls.length, 1);
    assert.equal(lastDecision(root).reasonCode, "DRY_RUN");
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf-8" });
    assert.equal(status.trim(), "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
