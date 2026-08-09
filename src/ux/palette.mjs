import { listCommandsByCategory } from "../ops/command-registry.mjs";
import { clipText } from "./layout.mjs";
import { getSymbols } from "./capabilities.mjs";

/**
 * @typedef {import("../ops/command-registry.mjs").CommandDescriptor} CommandDescriptor
 * @typedef {import("../ops/command-registry.mjs").CommandCategory} CommandCategory
 * @typedef {import("./capabilities.mjs").TerminalCapabilities} TerminalCapabilities
 * @typedef {import("./renderer.mjs").RenderFrame} RenderFrame
 */

/**
 * Create command palette state manager.
 * @param {Object} [opts]
 * @param {CommandCategory} [opts.initialCategory]
 */
export function createPaletteState(opts = {}) {
  let filter = "";
  let category = opts.initialCategory || null;
  let selectedIndex = 0;

  function getFilteredCommands() {
    let pool = listCommandsByCategory(category || undefined);
    if (!filter || !filter.trim()) return pool;

    const tokens = filter.trim().toLowerCase().split(/\s+/);
    return pool.filter((cmd) => {
      const text = `${cmd.id} ${cmd.title} ${cmd.description} ${cmd.category} ${cmd.shortcuts.join(" ")}`.toLowerCase();
      return tokens.every((token) => text.includes(token));
    });
  }

  function clampSelection() {
    const list = getFilteredCommands();
    if (list.length === 0) {
      selectedIndex = 0;
      return;
    }
    if (selectedIndex < 0) selectedIndex = 0;
    if (selectedIndex >= list.length) selectedIndex = list.length - 1;
  }

  clampSelection();

  return {
    get filter() {
      return filter;
    },
    set filter(val) {
      filter = String(val);
      selectedIndex = 0;
      clampSelection();
    },
    get category() {
      return category;
    },
    set category(val) {
      category = val;
      selectedIndex = 0;
      clampSelection();
    },
    get selectedIndex() {
      return selectedIndex;
    },

    move(delta) {
      const list = getFilteredCommands();
      if (list.length === 0) return;
      selectedIndex += delta;
      clampSelection();
    },

    nextCategory() {
      const categories = [null, "Create", "Inspect", "Operate", "Repair", "Configure"];
      const currentIdx = categories.indexOf(category);
      const nextIdx = (currentIdx + 1) % categories.length;
      this.category = categories[nextIdx];
    },

    getSelectedCommand() {
      const list = getFilteredCommands();
      return list[selectedIndex] || null;
    },

    getFilteredCommands,
  };
}

/**
 * Render native command palette view frame.
 * @param {ReturnType<typeof createPaletteState>} state
 * @param {TerminalCapabilities} caps
 * @returns {RenderFrame}
 */
export function renderPaletteView(state, caps) {
  const width = caps.columns || 80;
  const height = caps.rows || 24;
  const symbols = getSymbols(caps);

  const lines = [];

  // Header line
  const titleStr = " agentctl · Command Palette ";
  lines.push({
    runs: [{ text: clipText(titleStr, width), style: { fg: "cyan", bold: true, inverse: true } }],
  });

  // Filter input line
  const promptStr = ` > ${state.filter}${symbols.bullet}`;
  lines.push({
    runs: [{ text: clipText(promptStr, width), style: { fg: "yellow" } }],
  });

  // Category tabs line
  const categories = [
    { label: "All", value: null },
    { label: "Create", value: "Create" },
    { label: "Inspect", value: "Inspect" },
    { label: "Operate", value: "Operate" },
    { label: "Repair", value: "Repair" },
    { label: "Configure", value: "Configure" },
  ];

  const tabRuns = [];
  for (const cat of categories) {
    const isSelected = state.category === cat.value;
    const label = `[${cat.label}] `;
    if (isSelected) {
      tabRuns.push({ text: label, style: { fg: "cyan", bold: true, underline: true } });
    } else {
      tabRuns.push({ text: label, style: { fg: "white", dim: true } });
    }
  }
  lines.push({ runs: tabRuns });

  // Command items body
  const filtered = state.getFilteredCommands();
  const maxBodyLines = height - 5;

  if (filtered.length === 0) {
    lines.push({
      runs: [{ text: " No matching commands found.", style: { fg: "yellow", dim: true } }],
    });
  } else {
    for (let i = 0; i < Math.min(filtered.length, maxBodyLines); i++) {
      const cmd = filtered[i];
      const isSelected = i === state.selectedIndex;

      const pointer = isSelected ? `${symbols.select} ` : "  ";
      const catBadge = `[${cmd.category.padEnd(9)}] `;
      const cmdTitle = cmd.title.padEnd(16);
      const desc = cmd.description;

      const lineText = `${pointer}${catBadge}${cmdTitle} ${desc}`;
      const style = isSelected ? { fg: "cyan", bold: true } : { fg: "default" };

      lines.push({
        runs: [{ text: clipText(lineText, width), style }],
      });
    }
  }

  // Pad remaining height
  while (lines.length < height - 1) {
    lines.push({ runs: [{ text: " ".repeat(width), style: { fg: "default" } }] });
  }

  // Footer status bar line
  lines.push({
    runs: [
      {
        text: clipText("Up/Down: move  Enter: select  Tab: category  Esc: quit", width),
        style: { fg: "cyan", dim: true },
      },
    ],
  });

  return { width, height, lines };
}
