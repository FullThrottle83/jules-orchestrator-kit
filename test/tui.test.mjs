import test from "node:test";
import assert from "node:assert/strict";
import { isTTY, styleText, select, multiSelect, input, confirm, secretInput, spinner, ANSI } from "../src/tui.mjs";
import { PassThrough } from "node:stream";

test("Native Terminal UI (TUI) Engine", async (t) => {
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
});
