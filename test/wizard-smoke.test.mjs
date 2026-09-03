import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { runInitWizard, TIER_PROFILES } from "../src/wizard-init.mjs";
import { runTaskCreateWizard } from "../src/wizard-task.mjs";

/**
 * The unit tests around the TUI primitives all passed while `agentctl init`
 * was completely unusable: the first prompt succeeded, then the second one
 * crashed on a stream the first had already torn down. Nothing exercised the
 * real wizard end to end, so nothing noticed.
 *
 * This drives the actual `runInitWizard` — the function the CLI calls — over a
 * fake TTY, reacting to what it prints rather than to fixed delays. A real pty
 * would be closer to the truth, but Node has no built-in one and the kit ships
 * zero runtime dependencies, so this runs identically on Linux, macOS and
 * Windows instead of skipping on the platform that broke last.
 */

/** Attach an expect/send script to a fake-TTY pair. */
function drive(stdin, stdout, script) {
  let buf = "";
  let idx = 0;
  const sent = [];
  stdout.on("data", (chunk) => {
    buf += chunk.toString();
    if (idx >= script.length) return;
    const step = script[idx];
    if (!buf.includes(step.expect)) return;
    idx += 1;
    buf = "";
    sent.push(step.expect);
    // Let the prompt finish attaching its listener before answering it.
    setTimeout(() => stdin.write(step.send), 20);
  });
  return { sent, remaining: () => script.length - idx };
}

test("Interactive Init Wizard Smoke Test", async (t) => {
  let root;

  t.beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jules-wizard-smoke-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "smoke-fixture", version: "1.0.0" }));
  });

  t.afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  await t.test("drives every prompt of `agentctl init` and writes a config", async () => {
    const stdin = new PassThrough();
    stdin.isTTY = true;
    stdin.setRawMode = () => {};
    const stdout = new PassThrough();

    const driver = drive(stdin, stdout, [
      // Provider select: confirm the default. An empty PATH below makes that
      // default deterministic — no agent CLI is reachable, so the menu opens on
      // the hosted provider, which is the only one that asks about a plan.
      { expect: "Which agent should run the tasks?", send: "\r" },
      // Plan select: arrow down once, then confirm.
      { expect: "Which plan does your Jules account use?", send: "\u001b[B\r" },
      // Verification profile: confirm the default (standard).
      { expect: "How hard should the gate verify agent work?", send: "\r" },
      { expect: "Verification Test Command", send: "pytest -q\n" },
      { expect: "Verification Build Command", send: "\n" },
      { expect: "Select Autonomous Workflows", send: "\r" },
      // Decline the probe: answering yes would execute the test command above.
      { expect: "Run verification probe", send: "n\n" },
    ]);

    const res = await runInitWizard(root, { stdin, stdout, env: { PATH: "" } });

    assert.equal(driver.remaining(), 0, `wizard never reached: ${driver.sent.length} of 7 prompts seen`);
    assert.equal(res.ok, true);
    assert.ok(existsSync(res.configPath), "wizard must write .agent/config.yml");

    const config = readFileSync(res.configPath, "utf-8");
    assert.match(config, /pytest -q/, "the answered test command must reach the config");
    // With nothing to seed from, the menu opens on `free`; one arrow-down lands
    // on `pro`. Asserting the moved-to value is what makes the keypress
    // meaningful — accepting the default would pass whether or not the escape
    // sequence was decoded.
    assert.match(config, /tier:\s*["']?pro/, "arrow-down must actually move the selection");
    assert.match(config, /provider: jules/, "the answered provider must reach the config");
    assert.match(config, /profile: standard/, "so must the answered verification profile");

    // The regression that shipped to a real user: the first prompt tore down
    // stdin, so every prompt after it failed with an ABORT_ERR.
    assert.equal(stdin.destroyed, false, "stdin must survive the whole wizard");
  });

  await t.test("stays headless and writes no config when stdin is not a TTY", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();

    await assert.rejects(
      () => runInitWizard(root, { stdin, stdout }),
      /Non-interactive init requires explicit options/
    );
    assert.equal(existsSync(join(root, ".agent", "config.yml")), false);
  });

  await t.test("keeps the selected plan when the caller passes an undefined tier", async () => {
    // The shape `bin/agentctl.mjs` actually sends: parseArgs puts every declared
    // flag on the object, so an unpassed `--tier` arrives as a present key with
    // an undefined value. Spread last, it replaced the menu selection.
    const stdin = new PassThrough();
    stdin.isTTY = true;
    stdin.setRawMode = () => {};
    const stdout = new PassThrough();

    const driver = drive(stdin, stdout, [
      // The hosted provider is the default with no agent CLI on PATH, and is
      // the only one the plan question is asked of.
      { expect: "Which agent should run the tasks?", send: "\r" },
      { expect: "Which plan does your Jules account use?", send: "\u001b[B\u001b[B\r" },
      { expect: "How hard should the gate verify agent work?", send: "\r" },
      { expect: "Verification Test Command", send: "go test ./...\n" },
      { expect: "Verification Build Command", send: "\n" },
      { expect: "Select Autonomous Workflows", send: "\r" },
      { expect: "Run verification probe", send: "n\n" },
    ]);

    const res = await runInitWizard(root, {
      interactive: true,
      tier: undefined,
      allowDefaults: true,
      env: { PATH: "" },
      stdin,
      stdout,
    });

    assert.equal(driver.remaining(), 0);
    assert.equal(res.plan.tier, "ultra", "two arrow-downs from `free` must land on `ultra`");
    assert.match(readFileSync(res.configPath, "utf-8"), /tier:\s*["']?ultra/);
  });

  await t.test("an explicit tier seeds the menu instead of discarding the answer", async () => {
    const stdin = new PassThrough();
    stdin.isTTY = true;
    stdin.setRawMode = () => {};
    const stdout = new PassThrough();

    const driver = drive(stdin, stdout, [
      { expect: "Which agent should run the tasks?", send: "\r" },
      // Accept the highlighted entry, which `--tier ultra` should have moved.
      { expect: "Which plan does your Jules account use?", send: "\r" },
      { expect: "How hard should the gate verify agent work?", send: "\r" },
      { expect: "Verification Test Command", send: "cargo test\n" },
      { expect: "Verification Build Command", send: "\n" },
      { expect: "Select Autonomous Workflows", send: "\r" },
      { expect: "Run verification probe", send: "n\n" },
    ]);

    const res = await runInitWizard(root, {
      interactive: true,
      tier: "ultra",
      allowDefaults: true,
      env: { PATH: "" },
      stdin,
      stdout,
    });

    assert.equal(driver.remaining(), 0);
    assert.equal(res.plan.tier, "ultra");
    assert.equal(res.plan.limits.daily_tasks, TIER_PROFILES.ultra.daily_tasks);
  });
});

test("Interactive Task Create Wizard Smoke Test", async (t) => {
  let root;

  t.beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jules-task-smoke-"));
    mkdirSync(join(root, ".agent"), { recursive: true });
    writeFileSync(join(root, ".agent", "config.yml"), 'version: 1\ntier: pro\nverify:\n  test: "pytest -q"\n');
    writeFileSync(join(root, "README.md"), "# Fixture\n");
    for (const cmd of [
      "git init",
      'git config user.name "Test"',
      'git config user.email "test@example.com"',
      "git add -A",
      'git commit -m "fixture"',
    ]) {
      execSync(cmd, { cwd: root, stdio: "ignore" });
    }
  });

  t.afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * The exact object `bin/agentctl.mjs` builds for `agentctl task create` with
   * no flags. Every key is present; every value is undefined. Spread after the
   * answers, it wiped all of them, and the wizard rejected its own prompt with
   * "Task prompt cannot be empty" — reported by a user on a real repository.
   */
  const CLI_OPTIONS_NO_FLAGS = {
    title: undefined,
    prompt: undefined,
    role: undefined,
    tier: undefined,
    template: undefined,
    dependsOn: undefined,
    verifyCmd: undefined,
    autoPr: undefined,
    requirePlanApproval: undefined,
    repoless: undefined,
  };

  await t.test("typed answers survive the merge with unpassed CLI flags", async () => {
    const stdin = new PassThrough();
    stdin.isTTY = true;
    stdin.setRawMode = () => {};
    const stdout = new PassThrough();

    const driver = drive(stdin, stdout, [
      { expect: "Task Title", send: "UI/UX Fixes\n" },
      { expect: "Detailed Task Instructions", send: "Restore the focus trap in the settings modal\n" },
      { expect: "Enable Automatic PR Creation", send: "y\n" },
      { expect: "Require Plan Approval Gate", send: "n\n" },
      { expect: "Dispatch in Repoless mode", send: "y\n" },
    ]);

    const res = await runTaskCreateWizard(root, { ...CLI_OPTIONS_NO_FLAGS, stdin, stdout });

    assert.equal(driver.remaining(), 0, `wizard never reached: ${driver.sent.length} of 5 prompts seen`);
    assert.equal(res.plan.title, "UI/UX Fixes");
    assert.equal(res.plan.prompt, "Restore the focus trap in the settings modal");
    assert.deepEqual(res.plan.flags, {
      autoPr: true,
      requirePlanApproval: false,
      repoless: true,
      startingBranch: "main",
    });
    assert.ok(existsSync(res.taskFile));
    assert.match(readFileSync(res.taskFile, "utf-8"), /Restore the focus trap/);
  });

  await t.test("an explicit --prompt still wins over the interactive default", async () => {
    const stdin = new PassThrough();
    stdin.isTTY = true;
    stdin.setRawMode = () => {};
    const stdout = new PassThrough();

    // Passed prompts are offered as the editable default, so accepting it with
    // a bare newline must keep the flag's value rather than blanking it.
    const driver = drive(stdin, stdout, [
      { expect: "Task Title", send: "\n" },
      { expect: "Detailed Task Instructions", send: "\n" },
      { expect: "Enable Automatic PR Creation", send: "n\n" },
      { expect: "Require Plan Approval Gate", send: "n\n" },
      { expect: "Dispatch in Repoless mode", send: "n\n" },
    ]);

    const res = await runTaskCreateWizard(root, {
      ...CLI_OPTIONS_NO_FLAGS,
      title: "Flagged Title",
      prompt: "Flagged instructions",
      stdin,
      stdout,
    });

    assert.equal(driver.remaining(), 0);
    assert.equal(res.plan.title, "Flagged Title");
    assert.equal(res.plan.prompt, "Flagged instructions");
  });
});
