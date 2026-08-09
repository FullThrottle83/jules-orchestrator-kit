import { getStringWidth, clipText } from "./layout.mjs";
import { getSymbols } from "./capabilities.mjs";

/**
 * Filter items by string filter using token subsequence matching.
 * @template T
 * @param {T[]} items
 * @param {string} filterText
 * @param {(item: T) => string} getText
 * @returns {T[]}
 */
export function filterItems(items, filterText, getText) {
  if (!filterText || !filterText.trim()) return items;
  const tokens = filterText.trim().toLowerCase().split(/\s+/);

  return items.filter((item) => {
    const text = getText(item).toLowerCase();
    return tokens.every((token) => text.includes(token));
  });
}

/**
 * Create list widget state and reducers.
 * @template T
 * @param {Object} opts
 * @param {T[]} opts.items
 * @param {(item: T) => string} opts.getId
 * @param {(item: T) => string} opts.getText
 * @param {number} [opts.pageSize=10]
 * @param {boolean} [opts.multiSelect=false]
 */
export function createListState(opts) {
  const { items, getId, getText, pageSize = 10, multiSelect = false } = opts;

  let filter = "";
  let selectedIndex = 0;
  let offset = 0;
  const selectedIds = new Set();

  function getFilteredItems() {
    return filterItems(items, filter, getText);
  }

  function clampSelection() {
    const filtered = getFilteredItems();
    if (filtered.length === 0) {
      selectedIndex = 0;
      offset = 0;
      return;
    }
    if (selectedIndex < 0) selectedIndex = 0;
    if (selectedIndex >= filtered.length) selectedIndex = filtered.length - 1;

    // Adjust scroll offset viewport
    if (selectedIndex < offset) {
      offset = selectedIndex;
    } else if (selectedIndex >= offset + pageSize) {
      offset = selectedIndex - pageSize + 1;
    }
  }

  clampSelection();

  return {
    get filter() {
      return filter;
    },
    set filter(val) {
      filter = val;
      selectedIndex = 0;
      offset = 0;
      clampSelection();
    },
    get selectedIndex() {
      return selectedIndex;
    },
    get offset() {
      return offset;
    },
    get selectedIds() {
      return Array.from(selectedIds);
    },

    setItems(newItems) {
      opts.items = newItems;
      clampSelection();
    },

    move(delta) {
      const filtered = getFilteredItems();
      if (filtered.length === 0) return;
      selectedIndex += delta;
      clampSelection();
    },

    page(direction) {
      const step = Math.max(1, pageSize - 2);
      this.move(direction * step);
    },

    toStart() {
      selectedIndex = 0;
      clampSelection();
    },

    toEnd() {
      const filtered = getFilteredItems();
      selectedIndex = Math.max(0, filtered.length - 1);
      clampSelection();
    },

    toggleCurrent() {
      if (!multiSelect) return;
      const filtered = getFilteredItems();
      const current = filtered[selectedIndex];
      if (!current) return;
      const id = getId(current);
      if (selectedIds.has(id)) {
        selectedIds.delete(id);
      } else {
        selectedIds.add(id);
      }
    },

    selectAll() {
      if (!multiSelect) return;
      for (const item of getFilteredItems()) {
        selectedIds.add(getId(item));
      }
    },

    clearSelection() {
      selectedIds.clear();
    },

    getSelectedItem() {
      const filtered = getFilteredItems();
      return filtered[selectedIndex] || null;
    },

    getFilteredItems,
    getId,
    getText,
    pageSize,
    multiSelect,
  };
}

/**
 * Render paginated list lines.
 * @template T
 * @param {ReturnType<typeof createListState<T>>} state
 * @param {import("./layout.mjs").computeResponsiveLayout extends (...args: any[]) => infer R ? R : never} layout
 * @param {import("./capabilities.mjs").TerminalCapabilities} caps
 * @returns {import("./renderer.mjs").ScreenLine[]}
 */
export function renderListLines(state, layout, caps) {
  const symbols = getSymbols(caps);
  const filtered = state.getFilteredItems();
  const lines = [];

  const total = filtered.length;
  const startIdx = state.offset;
  const endIdx = Math.min(total, startIdx + state.pageSize);

  // Scroll indicator top
  if (startIdx > 0) {
    const aboveCount = startIdx;
    lines.push({
      runs: [
        {
          text: `${symbols.arrowUp} ${aboveCount} more items above`,
          style: { fg: "cyan", dim: true },
        },
      ],
    });
  }

  for (let i = startIdx; i < endIdx; i++) {
    const item = filtered[i];
    const isSelected = i === state.selectedIndex;
    const itemText = state.getText(item);
    const itemId = state.getId(item);
    const isChecked = state.selectedIds.includes(itemId);

    let prefix = "  ";
    if (state.multiSelect) {
      prefix = isChecked ? `${symbols.checked} ` : `${symbols.unchecked} `;
    }

    let pointer = isSelected ? `${symbols.select} ` : "  ";
    let lineText = `${pointer}${prefix}${itemText}`;

    /** @type {import("./renderer.mjs").TextStyle} */
    let style = { fg: "default" };
    if (isSelected) {
      style = { fg: "cyan", bold: true };
    }

    lines.push({
      runs: [{ text: clipText(lineText, layout.mainWidth || layout.width), style }],
    });
  }

  // Scroll indicator bottom
  if (endIdx < total) {
    const belowCount = total - endIdx;
    lines.push({
      runs: [
        {
          text: `${symbols.arrowDown} ${belowCount} more items below`,
          style: { fg: "cyan", dim: true },
        },
      ],
    });
  }

  return lines;
}

/**
 * Create text input state and cursor manager.
 * @param {Object} [opts]
 * @param {string} [opts.initialValue=""]
 * @param {boolean} [opts.secret=false]
 */
export function createTextInputState(opts = {}) {
  let value = opts.initialValue || "";
  let cursor = value.length;
  let visible = !opts.secret;

  return {
    get value() {
      return value;
    },
    set value(v) {
      value = String(v);
      cursor = value.length;
    },
    get cursor() {
      return cursor;
    },
    get visible() {
      return visible;
    },
    toggleVisible() {
      visible = !visible;
    },

    insert(text) {
      if (!text) return;
      value = value.slice(0, cursor) + text + value.slice(cursor);
      cursor += text.length;
    },

    backspace() {
      if (cursor > 0) {
        value = value.slice(0, cursor - 1) + value.slice(cursor);
        cursor--;
      }
    },

    delete() {
      if (cursor < value.length) {
        value = value.slice(0, cursor) + value.slice(cursor + 1);
      }
    },

    moveLeft() {
      if (cursor > 0) cursor--;
    },

    moveRight() {
      if (cursor < value.length) cursor++;
    },

    toStart() {
      cursor = 0;
    },

    toEnd() {
      cursor = value.length;
    },

    clear() {
      value = "";
      cursor = 0;
    },

    getDisplayValue(caps) {
      if (!visible && opts.secret) {
        const maskChar = caps.unicode ? "•" : "*";
        return maskChar.repeat(value.length);
      }
      return value;
    },
  };
}

/**
 * Render sticky status bar footer.
 * @param {Array<{ key: string, label: string }>} bindings
 * @param {number} width
 * @param {import("./capabilities.mjs").TerminalCapabilities} caps
 * @returns {import("./renderer.mjs").ScreenLine}
 */
export function renderStatusBar(bindings, width, _caps) {
  const runs = [];
  let currentWidth = 0;

  for (const b of bindings) {
    const itemStr = `${b.key} ${b.label}  `;
    const itemWidth = getStringWidth(itemStr);

    if (currentWidth + itemWidth > width) break;

    runs.push({ text: `${b.key} `, style: { fg: "cyan", bold: true } });
    runs.push({ text: `${b.label}  `, style: { fg: "white", dim: true } });
    currentWidth += itemWidth;
  }

  return { runs };
}
