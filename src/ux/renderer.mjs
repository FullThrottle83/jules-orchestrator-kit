import { getStringWidth, clipText, stripAnsi } from "./layout.mjs";

/**
 * @typedef {Object} TextStyle
 * @property {"default" | "red" | "green" | "yellow" | "blue" | "cyan" | "white"} [fg]
 * @property {"default" | "blue" | "cyan" | "bgRed" | "bgGreen"} [bg]
 * @property {boolean} [bold]
 * @property {boolean} [dim]
 * @property {boolean} [underline]
 * @property {boolean} [inverse]
 */

/**
 * @typedef {Object} CellRun
 * @property {string} text
 * @property {TextStyle} style
 */

/**
 * @typedef {Object} ScreenLine
 * @property {CellRun[]} runs
 * @property {string} [key]
 */

/**
 * @typedef {Object} RenderFrame
 * @property {number} width
 * @property {number} height
 * @property {ScreenLine[]} lines
 * @property {{ row: number, column: number, visible: boolean }} [cursor]
 * @property {string} [title]
 */

const FG_CODES = {
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  cyan: 36,
  white: 37,
};

const BG_CODES = {
  blue: 44,
  cyan: 46,
  bgRed: 41,
  bgGreen: 42,
};

/**
 * Strip or sanitize untrusted control characters and ANSI escape sequences.
 * @param {string} text
 * @returns {string}
 */
export function sanitizeControlChars(text) {
  if (text === null || text === undefined) return "";
  // Strip CSI, OSC, and single-byte ANSI sequences before removing controls.
  return stripAnsi(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

/**
 * Encode style to ANSI escape code sequence.
 * @param {TextStyle} [style]
 * @returns {string}
 */
export function encodeAnsiStyle(style) {
  if (!style) return "";
  const codes = [];

  if (style.bold) codes.push(1);
  if (style.dim) codes.push(2);
  if (style.underline) codes.push(4);
  if (style.inverse) codes.push(7);

  if (style.fg && FG_CODES[style.fg]) {
    codes.push(FG_CODES[style.fg]);
  }
  if (style.bg && BG_CODES[style.bg]) {
    codes.push(BG_CODES[style.bg]);
  }

  if (codes.length === 0) return "";
  return `\u001b[${codes.join(";")}m`;
}

/**
 * Format cell runs into line string with ANSI styling applied.
 * @param {ScreenLine} line
 * @param {number} maxWidth
 * @param {import("./capabilities.mjs").TerminalCapabilities} capabilities
 * @returns {string}
 */
export function renderLineToAnsi(line, maxWidth, capabilities) {
  let lineText = "";
  let currentWidth = 0;

  for (const run of line.runs || []) {
    if (currentWidth >= maxWidth) break;
    const cleanText = sanitizeControlChars(run.text);
    const runWidth = getStringWidth(cleanText);

    let textToDraw = cleanText;
    if (currentWidth + runWidth > maxWidth) {
      textToDraw = clipText(cleanText, maxWidth - currentWidth, "");
    }

    const runDrawWidth = getStringWidth(textToDraw);
    currentWidth += runDrawWidth;

    if (capabilities.ansi && run.style) {
      const styleAnsi = encodeAnsiStyle(run.style);
      if (styleAnsi) {
        lineText += `${styleAnsi}${textToDraw}\u001b[0m`;
      } else {
        lineText += textToDraw;
      }
    } else {
      lineText += textToDraw;
    }
  }

  // Pad remaining line width with spaces
  if (currentWidth < maxWidth) {
    lineText += " ".repeat(maxWidth - currentWidth);
  }

  return lineText;
}

/**
 * Render complete frame into ANSI string buffer.
 * @param {RenderFrame} frame
 * @param {import("./capabilities.mjs").TerminalCapabilities} capabilities
 * @returns {string}
 */
export function renderFrameToAnsi(frame, capabilities) {
  if (!capabilities.ansi) {
    return renderFrameToString(frame);
  }

  let output = capabilities.alternateScreen ? "\u001b[H" : "\u001b[1;1H";

  const renderLines = frame.lines.slice(0, frame.height);
  for (let i = 0; i < frame.height; i++) {
    const line = renderLines[i] || { runs: [] };
    const lineAnsi = renderLineToAnsi(line, frame.width, capabilities);
    output += lineAnsi;
    if (i < frame.height - 1) {
      output += "\n";
    }
  }

  if (frame.cursor && frame.cursor.visible) {
    const row = Math.min(frame.height, Math.max(1, frame.cursor.row));
    const col = Math.min(frame.width, Math.max(1, frame.cursor.column));
    output += `\u001b[${row};${col}H\u001b[?25h`;
  } else {
    output += "\u001b[?25l";
  }

  return output;
}

/**
 * Render frame into plain string lines for non-TTY or testing assertions.
 * @param {RenderFrame} frame
 * @returns {string}
 */
export function renderFrameToString(frame) {
  const lines = [];
  for (let i = 0; i < frame.height; i++) {
    const line = frame.lines[i] || { runs: [] };
    let lineStr = "";
    let width = 0;
    for (const run of line.runs || []) {
      const clean = sanitizeControlChars(run.text);
      lineStr += clean;
      width += getStringWidth(clean);
    }
    if (width < frame.width) {
      lineStr += " ".repeat(frame.width - width);
    } else if (width > frame.width) {
      lineStr = clipText(lineStr, frame.width, "");
    }
    lines.push(lineStr);
  }
  return lines.join("\n");
}
