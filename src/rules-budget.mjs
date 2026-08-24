import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const DEFAULT_MAX_CHARS = 10000; // Safe threshold below Antigravity 12k & Claude 25k limits
const DEFAULT_MAX_LINES = 250;

export const SENTINEL_BEGIN = "JULES_RULES_SENTINEL BEGIN";
export const SENTINEL_END = "JULES_RULES_SENTINEL END";

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
      // A CRLF checkout inflates the character count by one `\r` per line, so
      // the identical rules file passes as LF and fails as CRLF — a false
      // budget violation that depends purely on git's autocrlf setting rather
      // than the content. Normalise line endings before measuring (P-12) so the
      // budget counts the rule text, not the line-ending dialect.
      const normalized = content.replace(/\r\n/g, "\n");
      const charCount = normalized.length;
      const lineCount = normalized.split("\n").length;

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

/**
 * Compiles markdown/rules files into a single unified context block wrapped
 * in SHA-256 and byte-length anti-truncation sentinels.
 */
export function compileRules(root = process.cwd(), _opts = {}) {
  const candidateFiles = [
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    ".cursorrules",
    "JULES_RULES_TEMPLATE.md",
  ];

  const rulesDir = join(root, ".agent", "rules");
  try {
    const files = readdirSync(rulesDir);
    for (const f of files) {
      if (f.endsWith(".md")) {
        candidateFiles.push(join(".agent", "rules", f));
      }
    }
  } catch (_) {}

  const sources = [];
  const sections = [];

  for (const relPath of candidateFiles) {
    const fullPath = join(root, relPath);
    if (!existsSync(fullPath)) continue;
    try {
      const raw = readFileSync(fullPath, "utf-8");
      const body = raw.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
      if (!body) continue;
      sections.push(`<!-- source: ${relPath} -->\n${body}`);
      sources.push(relPath);
    } catch (_) {}
  }

  const body = sections.join("\n\n---\n\n");
  const bodyLen = Buffer.byteLength(body, "utf-8");
  const sha256 = createHash("sha256").update(body).digest("hex");

  const header = `<!-- ${SENTINEL_BEGIN} len=${bodyLen} sha256=${sha256} -->`;
  const footer = `<!-- ${SENTINEL_END} len=${bodyLen} sha256=${sha256} -->`;
  const compiled = `${header}\n${body}\n${footer}\n`;

  return { compiled, body, bodyLen, sha256, sources };
}

/**
 * Verifies that a compiled rule string has not been truncated or tampered with by downstream LLMs.
 */
export function verifyRulesSentinel(compiled) {
  const errors = [];
  if (typeof compiled !== "string" || compiled.length === 0) {
    return { ok: false, errors: ["empty input"] };
  }

  const beginRe = new RegExp(`<!--\\s*${SENTINEL_BEGIN.replace(/ /g, "\\s+")}\\s+len=(\\d+)\\s+sha256=([0-9a-f]{64})\\s*-->`);
  const endRe = new RegExp(`<!--\\s*${SENTINEL_END.replace(/ /g, "\\s+")}\\s+len=(\\d+)\\s+sha256=([0-9a-f]{64})\\s*-->`);

  const beginMatch = beginRe.exec(compiled);
  const endMatch = endRe.exec(compiled);

  if (!beginMatch) { errors.push("missing or malformed BEGIN sentinel"); return { ok: false, errors }; }
  if (!endMatch) { errors.push("missing or malformed END sentinel"); return { ok: false, errors }; }

  const beginLen = Number(beginMatch[1]);
  const beginSha = beginMatch[2];
  const endLen = Number(endMatch[1]);
  const endSha = endMatch[2];

  if (beginLen !== endLen) errors.push(`length mismatch: BEGIN=${beginLen} END=${endLen}`);
  if (beginSha !== endSha) errors.push("checksum mismatch between BEGIN and END sentinels");

  const bodyStart = beginMatch.index + beginMatch[0].length;
  const bodyEnd = endMatch.index;
  const body = compiled.slice(bodyStart, bodyEnd).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  const actualLen = Buffer.byteLength(body, "utf-8");

  if (actualLen !== beginLen) {
    errors.push(`body length ${actualLen} != declared ${beginLen} (possible truncation or injection)`);
  }

  const recomputed = createHash("sha256").update(body).digest("hex");
  if (recomputed !== beginSha) {
    errors.push(`body checksum ${recomputed} != declared ${beginSha} (content tampered or truncated)`);
  }

  return {
    ok: errors.length === 0,
    errors,
    bodyLen: actualLen,
    sha256: recomputed,
  };
}

function existsSync(p) {
  try {
    return statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

