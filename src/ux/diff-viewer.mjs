import { sanitizeControlChars } from "./renderer.mjs";
import { clipText } from "./layout.mjs";

/**
 * @typedef {Object} DiffLine
 * @property {"context" | "add" | "delete" | "header" | "no-newline"} kind
 * @property {number} [oldLine]
 * @property {number} [newLine]
 * @property {string} text
 */

/**
 * @typedef {Object} DiffHunk
 * @property {string} header
 * @property {number} oldStart
 * @property {number} oldCount
 * @property {number} newStart
 * @property {number} newCount
 * @property {DiffLine[]} lines
 */

/**
 * @typedef {Object} DiffFile
 * @property {string} oldPath
 * @property {string} newPath
 * @property {"added" | "modified" | "deleted" | "renamed" | "binary"} status
 * @property {DiffHunk[]} hunks
 * @property {number} additions
 * @property {number} deletions
 */

/**
 * @typedef {Object} DiffDocument
 * @property {DiffFile[]} files
 * @property {boolean} truncated
 * @property {number} totalBytes
 */

/**
 * Parse unified diff text into structured DiffDocument.
 * @param {string} text
 * @param {Object} [options]
 * @param {number} [options.maxBytes=1000000]
 * @param {number} [options.maxFiles=100]
 * @param {number} [options.maxLines=5000]
 * @returns {DiffDocument}
 */
export function parseUnifiedDiff(text, options = {}) {
  const maxBytes = options.maxBytes ?? 1_000_000;
  const maxFiles = options.maxFiles ?? 100;
  const maxLines = options.maxLines ?? 5000;

  let truncated = false;
  const totalBytes = Buffer.byteLength(text || "", "utf-8");

  if (totalBytes > maxBytes) {
    text = text.slice(0, maxBytes);
    truncated = true;
  }

  const rawLines = text.split(/\r?\n/);
  const files = [];

  let currentFile = null;
  let currentHunk = null;
  let oldLineNum = 0;
  let newLineNum = 0;
  let lineCount = 0;

  for (const rawLine of rawLines) {
    if (lineCount >= maxLines) {
      truncated = true;
      break;
    }
    lineCount++;

    const line = sanitizeControlChars(rawLine);

    if (line.startsWith("diff --git ")) {
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      const parts = line.split(" ");
      const oldPath = parts[2] ? parts[2].replace(/^a\//, "") : "";
      const newPath = parts[3] ? parts[3].replace(/^b\//, "") : "";

      currentFile = {
        oldPath,
        newPath,
        status: "modified",
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      files.push(currentFile);
      currentHunk = null;
      continue;
    }

    if (!currentFile) {
      if (line.startsWith("--- ") || line.startsWith("+++ ")) {
        currentFile = {
          oldPath: line.startsWith("--- ") ? line.slice(4).replace(/^a\//, "") : "",
          newPath: line.startsWith("+++ ") ? line.slice(4).replace(/^b\//, "") : "",
          status: "modified",
          hunks: [],
          additions: 0,
          deletions: 0,
        };
        files.push(currentFile);
      } else {
        continue;
      }
    }

    if (line.startsWith("new file mode ")) {
      currentFile.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      currentFile.status = "deleted";
      continue;
    }
    if (line.startsWith("Binary files ")) {
      currentFile.status = "binary";
      continue;
    }

    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      oldLineNum = parseInt(hunkMatch[1], 10);
      const oldCount = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
      newLineNum = parseInt(hunkMatch[3], 10);
      const newCount = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;

      currentHunk = {
        header: line,
        oldStart: oldLineNum,
        oldCount,
        newStart: newLineNum,
        newCount,
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentFile.additions++;
      currentHunk.lines.push({
        kind: "add",
        newLine: newLineNum++,
        text: line.slice(1),
      });
    } else if (line.startsWith("-")) {
      currentFile.deletions++;
      currentHunk.lines.push({
        kind: "delete",
        oldLine: oldLineNum++,
        text: line.slice(1),
      });
    } else if (line.startsWith("\\ No newline")) {
      currentHunk.lines.push({
        kind: "no-newline",
        text: line,
      });
    } else {
      currentHunk.lines.push({
        kind: "context",
        oldLine: oldLineNum++,
        newLine: newLineNum++,
        text: line.startsWith(" ") ? line.slice(1) : line,
      });
    }
  }

  return { files, truncated, totalBytes };
}

/**
 * Render unified diff view frame.
 * @param {DiffDocument} document
 * @param {Record<string, any>} state
 * @param {import("./capabilities.mjs").TerminalCapabilities} caps
 * @returns {import("./renderer.mjs").RenderFrame}
 */
export function renderDiffView(document, state, caps) {
  const width = caps.columns || 80;
  const height = caps.rows || 24;

  const fileIdx = Math.max(0, Math.min((document.files.length || 1) - 1, state.fileIdx || 0));
  const currentFile = document.files[fileIdx];

  const lines = [];

  // Header line
  const title = ` Diff · File [${fileIdx + 1}/${document.files.length || 0}] ${currentFile ? currentFile.newPath || currentFile.oldPath : ""} `;
  lines.push({
    runs: [
      { text: clipText(title, width), style: { fg: "cyan", bold: true, inverse: true } },
    ],
  });

  if (!currentFile) {
    lines.push({ runs: [{ text: "No files changed.", style: { dim: true } }] });
    return { width, height, lines };
  }

  // File summary line
  const metaStr = ` Status: ${currentFile.status.toUpperCase()}  +${currentFile.additions} -${currentFile.deletions} `;
  lines.push({ runs: [{ text: metaStr, style: { fg: "yellow" } }] });

  let lineOffset = state.lineOffset || 0;
  let renderCount = 0;
  const maxBodyLines = height - 3;

  for (const hunk of currentFile.hunks) {
    if (renderCount >= maxBodyLines) break;

    // Hunk header line
    lines.push({
      runs: [{ text: clipText(hunk.header, width), style: { fg: "cyan", dim: true } }],
    });
    renderCount++;

    for (const line of hunk.lines) {
      if (renderCount >= maxBodyLines) break;

      if (lineOffset > 0) {
        lineOffset--;
        continue;
      }

      const oldNumStr = line.oldLine !== undefined ? String(line.oldLine).padStart(5) : "     ";
      const newNumStr = line.newLine !== undefined ? String(line.newLine).padStart(5) : "     ";
      const numCol = `${oldNumStr} | ${newNumStr} | `;

      /** @type {import("./renderer.mjs").TextStyle} */
      let style = { fg: "default" };
      let prefix = " ";

      if (line.kind === "add") {
        style = { fg: "green" };
        prefix = "+";
      } else if (line.kind === "delete") {
        style = { fg: "red" };
        prefix = "-";
      }

      const lineText = clipText(`${numCol}${prefix}${line.text}`, width);
      lines.push({ runs: [{ text: lineText, style }] });
      renderCount++;
    }
  }

  // Footer keybindings line
  lines.push({
    runs: [
      {
        text: clipText("[/]: switch file  n/N: hunk  Up/Down: scroll  q: exit", width),
        style: { fg: "cyan", dim: true },
      },
    ],
  });

  return { width, height, lines };
}
