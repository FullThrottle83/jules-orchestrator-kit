/**
 * Unicode security detection for diffs and source text.
 *
 * Covers Trojan Source BiDi overrides (CVE-2021-42574), invisible/zero-width
 * obfuscation characters, Unicode Plane 14 tags, and mixed-script confusable
 * identifiers (Latin mixed with vetted Cyrillic/Greek lookalikes).
 *
 * Split out of src/security.mjs (P05). A Unicode directional override — or an
 * invisible filler mid-token — can make the line an agent reads differ from
 * the line the parser executes, so these checks run on every added line of
 * every non-markdown file before anything else looks at the diff.
 *
 * Zero third-party deps; Node ESM builtins + the shared confusable table from
 * secret-scanner.mjs only.
 */

import { CONFUSABLE_TO_ASCII } from "./secret-scanner.mjs";

/**
 * BiDi directional controls — the CVE-2021-42574 Trojan Source set (12 chars).
 * Exported so scanDiff can locate the offending line without duplicating the set.
 */
export const BIDI_CONTROL_REGEX =
  /[\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\u061C\u200E\u200F]/;

/**
 * Invisible ZW / Hangul fillers used to obfuscate identifiers on added lines:
 * U+00AD, U+200B–U+200D, U+2060–U+2064, U+FEFF, U+034F, U+3164, U+FFA0,
 * U+115F, U+1160.
 */
export const INVISIBLE_OBFUSCATION_REGEX =
  /[\u00AD\u200B-\u200D\u2060-\u2064\uFEFF\u034F\u3164\uFFA0\u115F\u1160]/;

/** Unicode Plane 14 language tags U+E0000–U+E007F. */
export const PLANE14_TAG_REGEX = /[\u{E0000}-\u{E007F}]/u;

/**
 * Cyrillic/Greek entries from the secret-scanner confusable table.
 * Latin lookalikes outside those scripts (ſ, K) are intentionally excluded —
 * they are not mixed-script substitutions.
 */
const MIXED_SCRIPT_CONFUSABLE_CHARS = [...CONFUSABLE_TO_ASCII.keys()].filter((ch) => {
  const cp = ch.codePointAt(0);
  return (cp >= 0x0370 && cp <= 0x03ff) || (cp >= 0x0400 && cp <= 0x04ff);
});

const CONFUSABLE_CLASS = MIXED_SCRIPT_CONFUSABLE_CHARS.map(
  (ch) => `\\u${ch.codePointAt(0).toString(16).padStart(4, "0")}`,
).join("");

/** Identifier-like tokens built from ASCII id chars and vetted confusables. */
export const MIXED_SCRIPT_TOKEN_REGEX = new RegExp(
  `[A-Za-z0-9_${CONFUSABLE_CLASS}]+`,
  "g",
);

const HAS_LATIN_ID = /[A-Za-z0-9_]/;
const HAS_CONFUSABLE = new RegExp(`[${CONFUSABLE_CLASS}]`);

/**
 * True when a line contains an identifier token that mixes Latin [A-Za-z0-9_]
 * with at least one Cyrillic/Greek confusable (e.g. Cyrillic i or a in an ASCII token).
 * Pure Cyrillic / Greek / multilingual text without intra-token Latin mixing
 * does not match.
 *
 * @param {string} line
 * @returns {boolean}
 */
export function hasMixedScriptConfusable(line) {
  if (!line || typeof line !== "string") return false;
  MIXED_SCRIPT_TOKEN_REGEX.lastIndex = 0;
  let match;
  while ((match = MIXED_SCRIPT_TOKEN_REGEX.exec(line)) !== null) {
    const token = match[0];
    if (HAS_LATIN_ID.test(token) && HAS_CONFUSABLE.test(token)) return true;
  }
  return false;
}

/**
 * Select the lines to scan: added lines of a unified diff, or every line of
 * plain text.
 *
 * @param {string} diffOrText
 * @returns {string[]}
 */
function targetLines(diffOrText) {
  const lines = diffOrText.split("\n");
  // Only filter diff syntax if we actually start with typical diff headers.
  // This avoids treating text containing "+++ b/" as a diff mistakenly.
  const isDiff =
    diffOrText.startsWith("--- a/") ||
    diffOrText.startsWith("+++ b/") ||
    diffOrText.includes("\n+++ b/");

  return lines.filter((line) => {
    if (isDiff) {
      return line.startsWith("+") && !line.startsWith("+++");
    }
    return true;
  });
}

/**
 * Trojan Source (CVE-2021-42574) BiDi override detection.
 * Backward-compatible: returns `{ ok, violations }` and only reports BiDi
 * controls. Broader Unicode checks live in {@link checkUnicodeSecurity}.
 *
 * @param {string} [diffOrText=""]
 * @param {object} [_options={}]
 * @returns {{ ok: boolean, violations: Array<{ reason: string }> }}
 */
export function checkTrojanSource(diffOrText = "", _options = {}) {
  if (!diffOrText || typeof diffOrText !== "string") return { ok: true, violations: [] };

  const violations = [];
  for (const line of targetLines(diffOrText)) {
    if (BIDI_CONTROL_REGEX.test(line)) {
      violations.push({
        reason:
          "Trojan Source BiDi override detected: contains invisible directional control characters (CVE-2021-42574).",
      });
      break; // One violation is enough for the file/diff block
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Full Unicode security pass over a diff or plain text.
 *
 * Categories (at most one finding each):
 *   - TROJAN_SOURCE_DETECTED — BiDi controls (CVE-2021-42574)
 *   - UNICODE_OBFUSCATION_DETECTED — ZW/Hangul fillers or Plane 14 tags
 *   - MIXED_SCRIPT_CONFUSABLE_DETECTED — Latin+confusable identifier tokens
 *
 * @param {string} [diffOrText=""]
 * @param {object} [_options={}]
 * @returns {{
 *   ok: boolean,
 *   violations: Array<{ reason: string, type: string }>
 * }}
 */
export function checkUnicodeSecurity(diffOrText = "", _options = {}) {
  if (!diffOrText || typeof diffOrText !== "string") return { ok: true, violations: [] };

  const violations = [];
  let sawBidi = false;
  let sawObfuscation = false;
  let sawMixed = false;

  for (const line of targetLines(diffOrText)) {
    if (!sawBidi && BIDI_CONTROL_REGEX.test(line)) {
      sawBidi = true;
      violations.push({
        type: "TROJAN_SOURCE_DETECTED",
        reason:
          "Trojan Source BiDi override detected: contains invisible directional control characters (CVE-2021-42574).",
      });
    }
    if (
      !sawObfuscation &&
      (INVISIBLE_OBFUSCATION_REGEX.test(line) || PLANE14_TAG_REGEX.test(line))
    ) {
      sawObfuscation = true;
      violations.push({
        type: "UNICODE_OBFUSCATION_DETECTED",
        reason:
          "Unicode obfuscation detected: invisible zero-width, Hangul filler, or Plane 14 tag characters on an added line.",
      });
    }
    if (!sawMixed && hasMixedScriptConfusable(line)) {
      sawMixed = true;
      violations.push({
        type: "MIXED_SCRIPT_CONFUSABLE_DETECTED",
        reason:
          "Mixed-script confusable identifier detected: Latin characters combined with Cyrillic/Greek lookalikes in one token.",
      });
    }
    if (sawBidi && sawObfuscation && sawMixed) break;
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Locate the first added-line number that triggers a given Unicode finding type.
 * Shared by scanDiff so it does not re-embed detection regexes.
 *
 * @param {Array<{ text: string, no: number|null }>} lines
 * @param {string} type
 * @returns {number|null}
 */
export function locateUnicodeFindingLine(lines, type) {
  if (!Array.isArray(lines)) return null;
  for (const l of lines) {
    if (!l || typeof l.text !== "string") continue;
    const text = l.text;
    let hit = false;
    if (type === "TROJAN_SOURCE_DETECTED") {
      hit = BIDI_CONTROL_REGEX.test(text);
    } else if (type === "UNICODE_OBFUSCATION_DETECTED") {
      hit = INVISIBLE_OBFUSCATION_REGEX.test(text) || PLANE14_TAG_REGEX.test(text);
    } else if (type === "MIXED_SCRIPT_CONFUSABLE_DETECTED") {
      hit = hasMixedScriptConfusable(text);
    }
    if (hit) return l.no ?? null;
  }
  return null;
}
