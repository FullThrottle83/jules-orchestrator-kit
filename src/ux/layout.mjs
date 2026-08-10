const ANSI_ESCAPE_REGEX = /(?:\u001b\][\s\S]*?(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~])/g;

/**
 * Remove terminal control sequences before measuring or rendering text.
 * @param {string} value
 * @returns {string}
 */
export function stripAnsi(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(ANSI_ESCAPE_REGEX, "").replace(/\u001b\][\s\S]*$/g, "");
}

function isCombining(code) {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xe0100 && code <= 0xe01ef) ||
    (code >= 0x1f3fb && code <= 0x1f3ff) ||
    code === 0x200d
  );
}

function isEmoji(code) {
  return (
    (code >= 0x1f000 && code <= 0x1faff) ||
    (code >= 0x2600 && code <= 0x27ff)
  );
}

function graphemeClusters(value) {
  if (typeof Intl?.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(value), ({ segment }) => segment);
  }
  return Array.from(value);
}

/**
 * Calculate display width of string without external dependencies.
 * Handles wide characters, emoji ranges, and combining characters.
 * @param {string} str
 * @returns {number}
 */
export function getStringWidth(str) {
  const plain = stripAnsi(str);
  if (!plain) return 0;

  let width = 0;
  let joinNext = false;
  let regionalIndicators = 0;
  for (const char of plain) {
    const code = char.codePointAt(0) || 0;

    if (isCombining(code)) {
      if (code === 0x200d) joinNext = true;
      continue;
    }
    if (code < 32 || (code >= 0x7f && code <= 0x9f)) {
      continue;
    }

    if (code >= 0x1f1e6 && code <= 0x1f1ff) {
      if (regionalIndicators % 2 === 0) width += 2;
      regionalIndicators++;
      continue;
    }
    regionalIndicators = 0;

    if (joinNext) {
      joinNext = false;
      continue;
    }

    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      isEmoji(code)
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
  const widthLimit = Number.isFinite(maxWidth) ? Math.max(0, Math.floor(maxWidth)) : 0;
  if (widthLimit === 0) return "";

  const plain = stripAnsi(text);
  if (getStringWidth(plain) <= widthLimit) return plain;

  const cleanEllipsis = stripAnsi(ellipsis);
  const ellipsisWidth = getStringWidth(cleanEllipsis);
  if (ellipsisWidth >= widthLimit) {
    let fitted = "";
    for (const cluster of graphemeClusters(cleanEllipsis)) {
      if (getStringWidth(fitted + cluster) > widthLimit) break;
      fitted += cluster;
    }
    return fitted;
  }

  const targetWidth = widthLimit - ellipsisWidth;
  let truncated = "";
  let accumulatedWidth = 0;
  for (const cluster of graphemeClusters(plain)) {
    const clusterWidth = getStringWidth(cluster);
    if (accumulatedWidth + clusterWidth > targetWidth) break;
    accumulatedWidth += clusterWidth;
    truncated += cluster;
  }
  return truncated + cleanEllipsis;
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
