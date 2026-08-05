import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_MAX_CHARS = 10000; // Safe threshold below Antigravity 12k & Claude 25k limits
const DEFAULT_MAX_LINES = 250;

/**
 * Audit character and line counts of compiled instruction files to prevent truncation.
 *
 * @param {string} root - Project root directory
 * @param {Object} [opts] - Options (maxChars, maxLines)
 * @returns {{ ok: boolean, violations: Array<{ path: string, charCount: number, lineCount: number, reason: string }> }}
 */
export function checkRulesBudget(root = process.cwd(), opts = {}) {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const violations = [];

  const candidateFiles = [
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    ".cursorrules",
    "JULES_RULES_TEMPLATE.md",
  ];

  // Scan .agent/rules/ directory if it exists
  const rulesDir = join(root, ".agent", "rules");
  try {
    const files = readdirSync(rulesDir);
    for (const f of files) {
      if (f.endsWith(".md")) {
        candidateFiles.push(join(".agent", "rules", f));
      }
    }
  } catch (_) {}

  for (const relPath of candidateFiles) {
    const fullPath = join(root, relPath);
    if (!existsSync(fullPath)) continue;

    try {
      const content = readFileSync(fullPath, "utf-8");
      const charCount = content.length;
      const lineCount = content.split("\n").length;

      if (charCount > maxChars) {
        violations.push({
          path: relPath,
          charCount,
          lineCount,
          reason: `Exceeds max character budget of ${maxChars} chars (${charCount} chars). Antigravity silently truncates rules > 12,000 chars.`,
        });
      } else if (lineCount > maxLines) {
        violations.push({
          path: relPath,
          charCount,
          lineCount,
          reason: `Exceeds max line budget of ${maxLines} lines (${lineCount} lines). Claude Code auto-memory truncates > 200 lines.`,
        });
      }
    } catch (_) {}
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}

function existsSync(p) {
  try {
    return statSync(p).isFile();
  } catch (_) {
    return false;
  }
}
