import test from "node:test";
import assert from "node:assert/strict";
import { isTTY, styleText, select, multiSelect, input, confirm, secretInput, spinner, ANSI, WizardCancelledError } from "../src/tui.mjs";
import { createKeyDecoder } from "../src/key-decoder.mjs";
import { PassThrough } from "node:stream";

test("Native Terminal UI (TUI) Engine", async (t) => {
  await t.test("WizardCancelledError is exported and thrown on Ctrl+C SIGINT keypress", () => {
    const err = new WizardCancelledError("Cancelled");
    assert.equal(err.name, "WizardCancelledError");
    assert.equal(err.message, "Cancelled");
  });
  await t.test("isTTY detects non-TTY streams accurately", () => {
    const mockNonTTY = new PassThrough();
    assert.equal(isTTY(mockNonTTY), false);
  });

  await t.test("styleText applies ANSI styles correctly", () => {
    const styled = styleText("Hello", ANSI.bold + ANSI.cyan);
    assert.equal(styled, `${ANSI.bold}${ANSI.cyan}Hello${ANSI.reset}`);
    assert.equal(styleText("Plain", ""), "Plain");
  });

  await t.test("select non-TTY headless fallback returns default or provided fallback", async () => {
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();
    let stdoutData = "";
    mockStdout.on("data", (c) => (stdoutData += c.toString()));

    const options = [
      { label: "Option 1", value: "opt1" },
      { label: "Option 2", value: "opt2" },
    ];

    const res = await select(options, "Select option", {
      stdin: mockStdin,
      stdout: mockStdout,
      defaultIdx: 1,
    });

    assert.equal(res, "opt2");
    assert.ok(stdoutData.includes("[Headless Select]"));
  });

  await t.test("multiSelect non-TTY headless fallback returns checked items", async () => {
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();

    const options = [
      { label: "Option A", value: "A", checked: true },
      { label: "Option B", value: "B", checked: false },
      { label: "Option C", value: "C", checked: true },
    ];

    const res = await multiSelect(options, "Select items", {
      stdin: mockStdin,
      stdout: mockStdout,
    });

    assert.deepEqual(res, ["A", "C"]);
  });

  await t.test("input non-TTY fallback returns default value", async () => {
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();

    const res = await input("Enter name", {
      defaultValue: "default-name",
      stdin: mockStdin,
      stdout: mockStdout,
    });

    assert.equal(res, "default-name");
  });

  await t.test("confirm non-TTY fallback returns default boolean", async () => {
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();

    const resTrue = await confirm("Proceed?", true, { stdin: mockStdin, stdout: mockStdout });
    assert.equal(resTrue, true);

    const resFalse = await confirm("Delete?", false, { stdin: mockStdin, stdout: mockStdout });
    assert.equal(resFalse, false);
  });

  await t.test("secretInput non-TTY fallback returns fallbackValue", async () => {
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();

    const res = await secretInput("API Key", {
      fallbackValue: "secret-123",
      stdin: mockStdin,
      stdout: mockStdout,
    });

    assert.equal(res, "secret-123");
  });

  await t.test("spinner stop and fail methods work in non-TTY mode", () => {
    const mockStdout = new PassThrough();
    let out = "";
    mockStdout.on("data", (c) => (out += c.toString()));

    const sp = spinner("Analyzing stack", { stdout: mockStdout });
    sp.stop("Analysis complete");

    assert.ok(out.includes("[Starting] Analyzing stack"));
    assert.ok(out.includes("[Completed] Analysis complete"));
  });

  await t.test("interactive TTY sequential prompts: select -> input -> multiSelect does not abort stream", async () => {
    const mockStdin = new PassThrough();
    mockStdin.isTTY = true;
    mockStdin.setRawMode = () => {};
    const mockStdout = new PassThrough();

    // 1. First prompt: select
    const selectPromise = select(
      [
        { label: "Free", value: "free" },
        { label: "Pro", value: "pro" },
        { label: "Ultra", value: "ultra" },
      ],
      "Which plan does your Jules account use?",
      { stdin: mockStdin, stdout: mockStdout }
    );
    setTimeout(() => mockStdin.write("\u001b[B\r"), 10);
    const chosenPlan = await selectPromise;
    assert.equal(chosenPlan, "pro");
    assert.equal(mockStdin.destroyed, false, "stdin stream must not be destroyed after select()");

    // 2. Second prompt: input (uses readline.createInterface)
    const inputPromise = input("Verification Test Command", {
      defaultValue: "npm test",
      stdin: mockStdin,
      stdout: mockStdout,
    });
    setTimeout(() => mockStdin.write("pytest\n"), 10);
    const chosenCmd = await inputPromise;
    assert.equal(chosenCmd, "pytest");
    assert.equal(mockStdin.destroyed, false, "stdin stream must not be destroyed after input()");

    // 3. Third prompt: multiSelect
    const multiPromise = multiSelect(
      [
        { label: "Workflow A", value: "wf_a", checked: false },
        { label: "Workflow B", value: "wf_b", checked: true },
      ],
      "Select Autonomous Workflows",
      { stdin: mockStdin, stdout: mockStdout }
    );
    setTimeout(() => mockStdin.write("\r"), 10);
    const chosenWfs = await multiPromise;
    assert.deepEqual(chosenWfs, ["wf_b"]);
    assert.equal(mockStdin.destroyed, false, "stdin stream must remain intact across all steps");
  });

  await t.test("interactive TTY select throws WizardCancelledError on Ctrl+C (\\u0003)", async () => {
    const mockStdin = new PassThrough();
    mockStdin.isTTY = true;
    mockStdin.setRawMode = () => {};
    const mockStdout = new PassThrough();

    const selectPromise = select(
      [{ label: "A", value: "a" }],
      "Pick one",
      { stdin: mockStdin, stdout: mockStdout }
    );

    setTimeout(() => mockStdin.write("\u0003"), 10);

    await assert.rejects(
      async () => {
        await selectPromise;
      },
      (err) => {
        assert.equal(err instanceof WizardCancelledError, true);
        assert.equal(err.code, 130);
        return true;
      }
    );
  });

  await t.test("interactive TTY input throws WizardCancelledError on Ctrl+C (\\u0003)", async () => {
    const mockStdin = new PassThrough();
    mockStdin.isTTY = true;
    mockStdin.setRawMode = () => {};
    const mockStdout = new PassThrough();

    const inputPromise = input("Enter something", {
      stdin: mockStdin,
      stdout: mockStdout,
    });

    setTimeout(() => mockStdin.write("\u0003\n"), 10);

    await assert.rejects(
      async () => {
        await inputPromise;
      },
      (err) => {
        assert.equal(err instanceof WizardCancelledError, true);
        assert.equal(err.code, 130);
        return true;
      }
    );
  });

  await t.test("interactive TTY select navigates correctly with SS3 application arrow keys (\\u001bOB)", async () => {
    const mockStdin = new PassThrough();
    mockStdin.isTTY = true;
    mockStdin.setRawMode = () => {};
    const mockStdout = new PassThrough();

    const selectPromise = select(
      [
        { label: "Option 1", value: "opt1" },
        { label: "Option 2", value: "opt2" },
      ],
      "Select an option",
      { stdin: mockStdin, stdout: mockStdout }
    );

    // Down arrow using SS3 sequence (\u001bOB) then Enter
    setTimeout(() => mockStdin.write("\u001bOB\r"), 10);
    const chosen = await selectPromise;
    assert.equal(chosen, "opt2");
  });

  await t.test("createKeyDecoder decodes standard escape sequences and raw characters", () => {
    const decoder = createKeyDecoder();
    const upEvents = decoder.push("\u001b[A");
    assert.equal(upEvents.length, 1);
    assert.equal(upEvents[0].name, "up");

    const downEvents = decoder.push("\u001bOB");
    assert.equal(downEvents.length, 1);
    assert.equal(downEvents[0].name, "down");

    const charEvents = decoder.push("x");
    assert.equal(charEvents.length, 1);
    assert.equal(charEvents[0].name, "character");
    assert.equal(charEvents[0].text, "x");
  });

  await t.test("createKeyDecoder handles chunked multi-byte UTF-8 sequences", () => {
    const decoder = createKeyDecoder();
    const emoji = Buffer.from("😀");
    assert.deepEqual(decoder.push(emoji.subarray(0, 1)), []);
    const completed = decoder.push(emoji.subarray(1));
    assert.equal(completed.length, 1);
    assert.equal(completed[0].text, "😀");
  });
});
