/**
 * Calculate display width of string without external dependencies.
 * Handles wide characters, emoji ranges, and combining characters.
 * @param {string} str
 * @returns {number}
 */
export function getStringWidth(str) {
  if (!str) return 0;
  // Remove ANSI escape sequences if present
  const plain = str.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "");

  let width = 0;
  for (const char of plain) {
    const code = char.codePointAt(0) || 0;

    // Combining characters (width 0)
    if ((code >= 0x0300 && code <= 0x036f) || (code >= 0x1ab0 && code <= 0x1aff)) {
      continue;
    }
    // Control characters (width 0)
    if (code < 32 || (code >= 0x7f && code <= 0x9f)) {
      continue;
    }
    // East Asian Wide / Fullwidth and Emoji ranges (width 2)
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f9ff) ||
      (code >= 0x2600 && code <= 0x26ff) ||
      (code >= 0x2700 && code <= 0x27bf)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/**
 * Truncate or clip text to fit maximum display width.
 * @param {string} text
 * @param {number} maxWidth
 * @param {string} [ellipsis="…"]
 * @returns {string}
 */
export function clipText(text, maxWidth, ellipsis = "…") {
  if (maxWidth <= 0) return "";
  const currentWidth = getStringWidth(text);
  if (currentWidth <= maxWidth) return text;

  const ellipsisWidth = getStringWidth(ellipsis);
  if (maxWidth <= ellipsisWidth) return ellipsis.slice(0, maxWidth);

  const targetWidth = maxWidth - ellipsisWidth;
  let truncated = "";
  let accumulatedWidth = 0;

  for (const char of text) {
    const charWidth = getStringWidth(char);
    if (accumulatedWidth + charWidth > targetWidth) break;
    accumulatedWidth += charWidth;
    truncated += char;
  }
  return truncated + ellipsis;
}

/**
 * Pad text to a fixed display width.
 * @param {string} text
 * @param {number} width
 * @param {"left" | "right" | "center"} [align="left"]
 * @returns {string}
 */
export function padText(text, width, align = "left") {
  const textWidth = getStringWidth(text);
  if (textWidth >= width) return clipText(text, width);

  const missing = width - textWidth;
  if (align === "right") {
    return " ".repeat(missing) + text;
  }
  if (align === "center") {
    const leftPad = Math.floor(missing / 2);
    const rightPad = missing - leftPad;
    return " ".repeat(leftPad) + text + " ".repeat(rightPad);
  }
  return text + " ".repeat(missing);
}

/**
 * Compute responsive layout panes based on terminal dimensions.
 * @param {number} width
 * @param {number} height
 */
export function computeResponsiveLayout(width, height) {
  const headerHeight = Math.min(4, Math.max(2, Math.floor(height * 0.1)));
  const footerHeight = 2;
  const bodyHeight = Math.max(4, height - headerHeight - footerHeight);

  /** @type {"single" | "tabs" | "split-55" | "split-50"} */
  let layoutMode = "single";
  let mainWidth = width;
  let detailWidth = 0;

  if (width >= 140) {
    layoutMode = "split-50";
    mainWidth = Math.floor(width * 0.5);
    detailWidth = width - mainWidth - 1;
  } else if (width >= 100) {
    layoutMode = "split-55";
    mainWidth = Math.floor(width * 0.55);
    detailWidth = width - mainWidth - 1;
  } else if (width >= 60) {
    layoutMode = "tabs";
  } else {
    layoutMode = "single";
  }

  return {
    width,
    height,
    headerHeight,
    footerHeight,
    bodyHeight,
    layoutMode,
    mainWidth,
    detailWidth,
  };
}
