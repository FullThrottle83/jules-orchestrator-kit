import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { detectTerminalCapabilities, getSymbols } from "../src/ux/capabilities.mjs";
import { createKeyDecoder } from "../src/ux/key-decoder.mjs";
import { createTerminalSession, WizardCancelledError } from "../src/ux/terminal-session.mjs";
import { getStringWidth, clipText, padText, computeResponsiveLayout } from "../src/ux/layout.mjs";
import { sanitizeControlChars, renderFrameToAnsi, renderFrameToString } from "../src/ux/renderer.mjs";
import { createListState, filterItems, createTextInputState, renderStatusBar } from "../src/ux/widgets.mjs";
import { parseUnifiedDiff, renderDiffView } from "../src/ux/diff-viewer.mjs";
import { renderLogView } from "../src/ux/log-viewer.mjs";

test("src/ux/capabilities.mjs", async (t) => {
  await t.test("detects TTY and defaults safely", () => {
    const caps = detectTerminalCapabilities({
      input: { isTTY: true },
      output: { isTTY: true, columns: 120, rows: 40 },
    });
    assert.equal(caps.inputIsTTY, true);
    assert.equal(caps.outputIsTTY, true);
    assert.equal(caps.columns, 120);
    assert.equal(caps.rows, 40);
  });

  await t.test("respects NO_COLOR and --no-color precedence", () => {
    const caps = detectTerminalCapabilities({
      color: "never",
      output: { isTTY: true },
    });
    assert.equal(caps.ansi, false);
    assert.equal(caps.colorDepth, 0);
  });

  await t.test("disables ANSI unconditionally in jsonMode", () => {
    const caps = detectTerminalCapabilities({
      jsonMode: true,
      color: "always",
      output: { isTTY: true },
    });
    assert.equal(caps.ansi, false);
  });

  await t.test("returns correct unicode vs ascii symbols", () => {
    const unicodeSymbols = getSymbols({ unicode: true });
    assert.equal(unicodeSymbols.select, "❯");
    assert.equal(unicodeSymbols.success, "✓");

    const asciiSymbols = getSymbols({ unicode: false });
    assert.equal(asciiSymbols.select, ">");
    assert.equal(asciiSymbols.success, "OK");
  });
});

test("src/ux/key-decoder.mjs", async (t) => {
  await t.test("decodes single-byte keys and arrow sequences", () => {
    const decoder = createKeyDecoder();

    const eventsUp = decoder.push("\x1b[A");
    assert.equal(eventsUp.length, 1);
    assert.equal(eventsUp[0].name, "up");

    const eventsDown = decoder.push("\x1b[B");
    assert.equal(eventsDown.length, 1);
    assert.equal(eventsDown[0].name, "down");

    const eventsEnter = decoder.push("\r");
    assert.equal(eventsEnter.length, 1);
    assert.equal(eventsEnter[0].name, "enter");

    const eventsCtrlC = decoder.push("\x03");
    assert.equal(eventsCtrlC.length, 1);
    assert.equal(eventsCtrlC[0].name, "ctrl-c");
    assert.equal(eventsCtrlC[0].ctrl, true);
  });

  await t.test("handles chunk boundary split sequences", () => {
    const decoder = createKeyDecoder();

    const chunk1 = decoder.push("\x1b");
    assert.equal(chunk1.length, 0);

    const chunk2 = decoder.push("[5~");
    assert.equal(chunk2.length, 1);
    assert.equal(chunk2[0].name, "page-up");
  });

  await t.test("flushes standalone escape on timeout", () => {
    const decoder = createKeyDecoder({ escapeTimeoutMs: 30 });
    decoder.push("\x1b", 1000);
    const flushed = decoder.flush(1050);
    assert.equal(flushed.length, 1);
    assert.equal(flushed[0].name, "escape");
  });
});

test("src/ux/terminal-session.mjs", async (t) => {
  function createMockStream(isTTY = true) {
    const stream = new EventEmitter();
    stream.isTTY = isTTY;
    stream.fd = 0;
    stream.setRawMode = (val) => {
      stream.isRaw = val;
    };
    stream.resume = () => {};
    stream.pause = () => {};
    stream.columns = 80;
    stream.rows = 24;
    stream.written = [];
    stream.write = (chunk) => {
      stream.written.push(String(chunk));
    };
    return stream;
  }

  await t.test("manages raw mode and alternate screen lifecycle", async () => {
    const input = createMockStream(true);
    const output = createMockStream(true);

    const session = createTerminalSession({ input, output, alternateScreen: true, color: "always" });
    await session.enter();

    assert.equal(input.isRaw, true);
    assert.ok(output.written.some((w) => w.includes("\u001b[?1049h"))); // Alternate screen

    await session.close();
    assert.equal(input.isRaw, false);
    assert.ok(output.written.some((w) => w.includes("\u001b[?1049l"))); // Leave alternate screen
  });

  await t.test("suspend() temporarily restores cooked mode", async () => {
    const input = createMockStream(true);
    const output = createMockStream(true);

    const session = createTerminalSession({ input, output, alternateScreen: true, color: "always" });
    await session.enter();

    let executedInSuspend = false;
    await session.suspend(async () => {
      executedInSuspend = true;
      assert.equal(input.isRaw, false);
    });

    assert.equal(executedInSuspend, true);
    assert.equal(input.isRaw, true);
    await session.close();
  });

  await t.test("WizardCancelledError has code 130 and correct properties", () => {
    const err = new WizardCancelledError("Cancelled by user", "ctrl-c");
    assert.equal(err.code, 130);
    assert.equal(err.reason, "ctrl-c");
    assert.equal(err.name, "WizardCancelledError");
  });
});

test("src/ux/layout.mjs & src/ux/renderer.mjs", async (t) => {
  await t.test("getStringWidth calculates string widths accurately", () => {
    assert.equal(getStringWidth("Hello"), 5);
    assert.equal(getStringWidth("日本語"), 6); // Wide chars
    assert.equal(getStringWidth("Test\u001b[31mRed\u001b[0m"), 7); // Ignores ANSI
  });

  await t.test("clipText clips text with ellipsis to target width", () => {
    assert.equal(clipText("Hello World", 5, ""), "Hello");
    assert.equal(clipText("Long String Here", 8, "…"), "Long St…");
  });

  await t.test("padText pads text correctly", () => {
    assert.equal(padText("ABC", 6, "left"), "ABC   ");
    assert.equal(padText("ABC", 6, "right"), "   ABC");
    assert.equal(padText("ABC", 6, "center"), " ABC  ");
  });

  await t.test("computeResponsiveLayout calculates breakpoint layout", () => {
    const layout = computeResponsiveLayout(120, 30);
    assert.equal(layout.layoutMode, "split-55");
    assert.equal(layout.width, 120);
    assert.equal(layout.height, 30);
  });

  await t.test("sanitizeControlChars removes dangerous control chars and ANSI", () => {
    const dirty = "Safe\x00Text\u001b[31mColor\u001b[0m\x07";
    assert.equal(sanitizeControlChars(dirty), "SafeTextColor");
  });

  await t.test("renderFrameToString converts frame into plain lines", () => {
    const frame = {
      width: 20,
      height: 2,
      lines: [
        { runs: [{ text: "Line 1", style: {} }] },
        { runs: [{ text: "Line 2 Text Here", style: {} }] },
      ],
    };
    const plain = renderFrameToString(frame);
    assert.equal(plain.split("\n")[0], "Line 1              ");
    assert.equal(plain.split("\n")[1], "Line 2 Text Here    ");
  });

  await t.test("renderFrameToAnsi produces ANSI escape output", () => {
    const frame = {
      width: 20,
      height: 1,
      lines: [{ runs: [{ text: "Styled", style: { fg: "cyan", bold: true } }] }],
    };
    const caps = { ansi: true, alternateScreen: true };
    const ansiOutput = renderFrameToAnsi(frame, caps);
    assert.ok(ansiOutput.includes("36m"));
  });
});

test("src/ux/widgets.mjs", async (t) => {
  await t.test("filterItems matches tokens subsequence case-insensitively", () => {
    const items = [
      { id: "1", title: "nightly-security-audit" },
      { id: "2", title: "api-security-hardening" },
      { id: "3", title: "database-backup" },
    ];
    const filtered = filterItems(items, "secur audit", (item) => item.title);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, "1");
  });

  await t.test("createListState supports navigation and multi-select", () => {
    const items = ["Alpha", "Beta", "Gamma", "Delta"];
    const state = createListState({
      items,
      getId: (x) => x,
      getText: (x) => x,
      pageSize: 2,
      multiSelect: true,
    });

    assert.equal(state.selectedIndex, 0);
    state.move(1);
    assert.equal(state.selectedIndex, 1);

    state.toggleCurrent();
    assert.deepEqual(state.selectedIds, ["Beta"]);

    state.selectAll();
    assert.equal(state.selectedIds.length, 4);

    state.clearSelection();
    assert.equal(state.selectedIds.length, 0);
  });

  await t.test("createTextInputState manages cursor and secret masking", () => {
    const input = createTextInputState({ secret: true });
    input.insert("my-secret");
    assert.equal(input.value, "my-secret");

    const caps = { unicode: true };
    assert.equal(input.getDisplayValue(caps), "•••••••••");

    input.toggleVisible();
    assert.equal(input.getDisplayValue(caps), "my-secret");

    input.backspace();
    assert.equal(input.value, "my-secre");
  });

  await t.test("renderStatusBar formats keybindings horizontal bar", () => {
    const bindings = [
      { key: "q", label: "Quit" },
      { key: "Enter", label: "Select" },
    ];
    const caps = { unicode: true };
    const line = renderStatusBar(bindings, 80, caps);
    assert.equal(line.runs.length, 4);
  });
});

test("src/ux/diff-viewer.mjs & src/ux/log-viewer.mjs", async (t) => {
  await t.test("parseUnifiedDiff parses git diff output", () => {
    const rawDiff = `diff --git a/src/index.mjs b/src/index.mjs
index 1234..5678 100644
--- a/src/index.mjs
+++ b/src/index.mjs
@@ -10,3 +10,4 @@ function test() {
-  const a = 1;
+  const a = 2;
+  const b = 3;
`;

    const doc = parseUnifiedDiff(rawDiff);
    assert.equal(doc.files.length, 1);
    assert.equal(doc.files[0].additions, 2);
    assert.equal(doc.files[0].deletions, 1);
    assert.equal(doc.files[0].hunks.length, 1);
  });

  await t.test("renderDiffView renders syntax highlighted diff frame", () => {
    const rawDiff = `diff --git a/src/index.mjs b/src/index.mjs
--- a/src/index.mjs
+++ b/src/index.mjs
@@ -10,1 +10,1 @@
-  const a = 1;
+  const a = 2;
`;
    const doc = parseUnifiedDiff(rawDiff);
    const caps = { columns: 80, rows: 24, ansi: true };
    const frame = renderDiffView(doc, {}, caps);
    assert.equal(frame.lines.length > 0, true);
  });

  await t.test("renderLogView bounds retention and filters errors", () => {
    const doc = {
      lines: [
        { number: 1, level: "info", text: "Starting system..." },
        { number: 2, level: "error", text: "Database connection failed!" },
      ],
      source: "test.log",
      truncatedBefore: 0,
      truncatedAfter: 0,
      followable: true,
    };

    const caps = { columns: 80, rows: 24, ansi: false };
    const frameAll = renderLogView(doc, {}, caps);
    assert.ok(frameAll.lines.some((l) => l.runs.some((r) => r.text.includes("Starting system"))));

    const frameErr = renderLogView(doc, { errorsOnly: true }, caps);
    assert.ok(frameErr.lines.some((l) => l.runs.some((r) => r.text.includes("Database connection failed"))));
  });
});
