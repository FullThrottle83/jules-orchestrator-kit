import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const BINARY_EXTENSIONS = new Set([
  ".woff2", ".woff", ".ttf", ".otf", ".eot",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif",
  ".pdf", ".ico"
]);

/**
 * Checks binary and font assets for silent HTML/text corruption (e.g. fake font saved HTML error page).
 *
 * @param {string} searchDir - Directory to scan (e.g., public/ or src/assets/)
 * @returns {{ ok: boolean, checkedCount: number, corruptedFiles: Array<{ path: string, reason: string }> }}
 */
export function checkAssetIntegrity(searchDir) {
  const corruptedFiles = [];
  let checkedCount = 0;

  function scan(dir) {
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch (_) {
      return;
    }

    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch (_) {
        continue;
      }

      if (stat.isDirectory()) {
        scan(fullPath);
      } else if (stat.isFile()) {
        const ext = extname(entry).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) {
          checkedCount++;
          try {
            // Read first 64 bytes
            const fd = readFileSync(fullPath);
            const header = fd.subarray(0, 64).toString("utf-8").toLowerCase().trim();

            if (
              header.startsWith("<!doctype") ||
              header.startsWith("<html") ||
              header.startsWith("<?xml") ||
              header.startsWith("{\"error") ||
              header.startsWith("{\"status")
            ) {
              corruptedFiles.push({
                path: fullPath,
                reason: `File has extension '${ext}' but starts with text header '${header.substring(0, 20)}'`,
              });
            }
          } catch (_) {
            // Ignore read errors
          }
        }
      }
    }
  }

  scan(searchDir);

  return {
    ok: corruptedFiles.length === 0,
    checkedCount,
    corruptedFiles,
  };
}
