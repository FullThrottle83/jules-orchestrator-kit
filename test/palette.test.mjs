import test from "node:test";
import assert from "node:assert/strict";

import {
  COMMAND_REGISTRY,
  getCommandDescriptor,
  listCommandsByCategory,
  formatCommandHelp,
  formatRegistryJson,
} from "../src/ops/command-registry.mjs";
import { createPaletteState, renderPaletteView } from "../src/ux/palette.mjs";

test("src/ops/command-registry.mjs", async (t) => {
  await t.test("contains all required command descriptors", () => {
    assert.ok(COMMAND_REGISTRY.length >= 6);
    const ids = COMMAND_REGISTRY.map((c) => c.id);
    assert.ok(ids.includes("doctor"));
    assert.ok(ids.includes("queue"));
    assert.ok(ids.includes("swarm"));
    assert.ok(ids.includes("task-create"));
    assert.ok(ids.includes("init"));
  });

  await t.test("getCommandDescriptor looks up by ID, path, or shortcut", () => {
    const docById = getCommandDescriptor("doctor");
    assert.ok(docById);
    assert.equal(docById.id, "doctor");

    const taskByPath = getCommandDescriptor("task create");
    assert.ok(taskByPath);
    assert.equal(taskByPath.id, "task-create");

    const doctorByShortcut = getCommandDescriptor("doc");
    assert.ok(doctorByShortcut);
    assert.equal(doctorByShortcut.id, "doctor");
  });

  await t.test("listCommandsByCategory filters commands", () => {
    const operateCmds = listCommandsByCategory("Operate");
    assert.ok(operateCmds.length >= 2);
    assert.ok(operateCmds.some((c) => c.id === "queue"));
    assert.ok(operateCmds.some((c) => c.id === "swarm"));
  });

  await t.test("formatCommandHelp formats help text", () => {
    const doc = getCommandDescriptor("doctor");
    const helpText = formatCommandHelp(doc);
    assert.ok(helpText.includes("Usage: agentctl doctor"));
    assert.ok(helpText.includes("Description:"));
    assert.ok(helpText.includes("Flags:"));
  });

  await t.test("formatRegistryJson formats JSON registry payload", () => {
    const json = formatRegistryJson();
    assert.equal(json.ok, true);
    assert.ok(json.commands.length >= 6);
  });
});

test("src/ux/palette.mjs", async (t) => {
  await t.test("createPaletteState filters commands by search query", () => {
    const state = createPaletteState();
    state.filter = "diagnostics";
    const filtered = state.getFilteredCommands();
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, "doctor");
  });

  await t.test("createPaletteState cycles category tabs", () => {
    const state = createPaletteState();
    assert.equal(state.category, null);

    state.nextCategory();
    assert.equal(state.category, "Create");

    state.nextCategory();
    assert.equal(state.category, "Inspect");
  });

  await t.test("renderPaletteView renders complete palette frame", () => {
    const state = createPaletteState();
    const caps = { columns: 80, rows: 24, ansi: true };

    const frame = renderPaletteView(state, caps);
    assert.equal(frame.width, 80);
    assert.equal(frame.height, 24);
    assert.ok(frame.lines.some((l) => l.runs.some((r) => r.text.includes("Command Palette"))));
  });
});
