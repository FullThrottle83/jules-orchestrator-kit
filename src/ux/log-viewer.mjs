import { sanitizeControlChars } from "./renderer.mjs";
import { clipText } from "./layout.mjs";

/**
 * @typedef {Object} LogLine
 * @property {number} number
 * @property {string} [timestamp]
 * @property {"stdout" | "stderr" | "system"} [stream]
 * @property {"debug" | "info" | "warn" | "error"} [level]
 * @property {string} text
 */

/**
 * @typedef {Object} LogDocument
 * @property {LogLine[]} lines
 * @property {string} source
 * @property {number} truncatedBefore
 * @property {number} truncatedAfter
 * @property {boolean} followable
 */

/**
 * Render bounded log viewer frame.
 * @param {LogDocument} document
 * @param {Record<string, any>} state
 * @param {import("./capabilities.mjs").TerminalCapabilities} caps
 * @returns {import("./renderer.mjs").RenderFrame}
 */
export function renderLogView(document, state, caps) {
  const width = caps.columns || 80;
  const height = caps.rows || 24;

  const rawLines = document.lines || [];
  const filter = (state.filter || "").toLowerCase();
  const errorsOnly = Boolean(state.errorsOnly);
  const follow = Boolean(state.follow);

  // Filter lines
  const filtered = rawLines.filter((l) => {
    if (errorsOnly && l.level !== "error" && l.stream !== "stderr") {
      return false;
    }
    if (filter) {
      const clean = (l.text || "").toLowerCase();
      if (!clean.includes(filter)) return false;
    }
    return true;
  });

  const maxBodyLines = Math.max(2, height - 3);
  let offset = state.offset || 0;

  if (follow) {
    offset = Math.max(0, filtered.length - maxBodyLines);
  } else {
    offset = Math.max(0, Math.min(filtered.length - 1, offset));
  }

  const lines = [];

  // Header line
  const headerStr = ` Log Viewer · ${document.source || "Output"} · Showing ${filtered.length} lines ${errorsOnly ? "(Errors Only)" : ""} `;
  lines.push({
    runs: [{ text: clipText(headerStr, width), style: { fg: "cyan", bold: true, inverse: true } }],
  });

  // Status sub-header line
  const subHeader = ` Filter: ${filter || "none"}  Follow: ${follow ? "ON" : "OFF"}  Showing ${offset + 1}-${Math.min(filtered.length, offset + maxBodyLines)} of ${filtered.length} `;
  lines.push({
    runs: [{ text: clipText(subHeader, width), style: { fg: "yellow", dim: true } }],
  });

  // Body lines
  const slice = filtered.slice(offset, offset + maxBodyLines);
  for (const item of slice) {
    const numStr = String(item.number).padStart(5);
    const streamStr = item.stream ? item.stream.padStart(6) : "      ";
    const cleanText = sanitizeControlChars(item.text);

    /** @type {import("./renderer.mjs").TextStyle} */
    let style = { fg: "default" };
    if (item.level === "error" || item.stream === "stderr") {
      style = { fg: "red" };
    } else if (item.level === "warn") {
      style = { fg: "yellow" };
    } else if (item.stream === "system") {
      style = { fg: "cyan", dim: true };
    }

    const lineText = clipText(`${numStr} | ${streamStr} | ${cleanText}`, width);
    lines.push({ runs: [{ text: lineText, style }] });
  }

  // Pad remaining height
  while (lines.length < height - 1) {
    lines.push({ runs: [{ text: " ".repeat(width), style: { fg: "default" } }] });
  }

  // Footer status bar
  lines.push({
    runs: [
      {
        text: clipText("Up/Down: scroll  PgUp/PgDn  / search  e: errors only  f: follow  q: back", width),
        style: { fg: "cyan", dim: true },
      },
    ],
  });

  return { width, height, lines };
}
