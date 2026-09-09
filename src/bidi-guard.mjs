/**
 * Trojan Source (CVE-2021-42574) BiDi override detection.
 *
 * Split out of src/security.mjs (P05). A Unicode directional override can make
 * the line an agent reads differ from the line the parser executes, so the
 * check runs on every added line of every non-markdown file before anything
 * else looks at the diff.
 */

export function checkTrojanSource(diffOrText = "", _options = {}) {
  if (!diffOrText || typeof diffOrText !== "string") return { ok: true, violations: [] };

  const violations = [];
  const bidiRegex = /[\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\u061C\u200E\u200F]/;

  const lines = diffOrText.split("\n");
  // Only filter diff syntax if we actually start with typical diff headers
  // This avoids treating text containing "+++ b/" as a diff mistakenly.
  const isDiff = diffOrText.startsWith("--- a/") || diffOrText.startsWith("+++ b/") || diffOrText.includes("\n+++ b/");

  const targetLines = lines.filter((line) => {
    if (isDiff) {
      return line.startsWith("+") && !line.startsWith("+++");
    }
    return true;
  });

  for (const line of targetLines) {
    if (bidiRegex.test(line)) {
      violations.push({ reason: "Trojan Source BiDi override detected: contains invisible directional control characters (CVE-2021-42574)." });
      break; // One violation is enough for the file/diff block
    }
  }

  return { ok: violations.length === 0, violations };
}
