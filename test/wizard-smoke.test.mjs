import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { runInitWizard } from "../src/wizard-init.mjs";

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
      // Plan select: arrow down once, then confirm.
      { expect: "Which plan does your Jules account use?", send: "\u001b[B\r" },
      { expect: "Verification Test Command", send: "pytest -q\n" },
      { expect: "Verification Build Command", send: "\n" },
      { expect: "Select Autonomous Workflows", send: "\r" },
      // Decline the probe: answering yes would execute the test command above.
      { expect: "Run verification probe", send: "n\n" },
    ]);

    const res = await runInitWizard(root, { stdin, stdout });

    assert.equal(driver.remaining(), 0, `wizard never reached: ${driver.sent.length} of 5 prompts seen`);
    assert.equal(res.ok, true);
    assert.ok(existsSync(res.configPath), "wizard must write .agent/config.yml");

    const config = readFileSync(res.configPath, "utf-8");
    assert.match(config, /pytest -q/, "the answered test command must reach the config");
    // The default tier is `pro`; one arrow-down lands on `ultra`. Asserting the
    // moved-to value is what makes the keypress meaningful — accepting the
    // default would pass whether or not the escape sequence was decoded.
    assert.match(config, /tier:\s*["']?ultra/, "arrow-down must actually move the selection");

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
});
