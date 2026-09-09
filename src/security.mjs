/**
 * Safety gatekeeper: the façade over the security subsystem, and scanDiff().
 *
 * P05 split this module into five focused submodules and kept two things here:
 *
 *   - the checks that read a *diff* rather than a value — the Edge-runtime
 *     import scan, the workspace-boundary scan, binary-payload scanning, and the
 *     per-file classification the findings are attributed through;
 *   - scanDiff(), the orchestrator that walks the diff once and calls the
 *     submodules (src/bidi-guard.mjs, src/secret-scanner.mjs,
 *     src/test-tamper-guard.mjs) plus the local ones below.
 *
 * Everything the module exported before the split is still exported from here,
 * re-exported from the submodule that now owns it, so `import … from
 * "./src/security.mjs"` keeps working unchanged — including scanBinaryPayloads
 * and the pattern tables, which the façade defines or re-exports directly.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectCrossPackageBoundaryViolations, detectEdgeRuntime } from "./stack-detector.mjs";
import { checkTrojanSource } from "./bidi-guard.mjs";
import {
  hasHighConfidenceSecret,
  hasLowConfidenceSecret,
  hasEncodedSecret,
  hasHighEntropyToken,
  secretScanVariants,
} from "./secret-scanner.mjs";
import { checkTestTampering } from "./test-tamper-guard.mjs";

export const FORBIDDEN_EDGE_MODULES = [
  "fs", "node:fs",
  "child_process", "node:child_process",
  "cluster", "node:cluster",
  "dgram", "node:dgram",
  "net", "node:net",
  "tls", "node:tls",
  "v8", "node:v8",
  "vm", "node:vm",
  "worker_threads", "node:worker_threads",
];

export function checkEdgeRuntimeImports(diffOrText = "", options = {}) {
  if (!diffOrText || typeof diffOrText !== "string") return { ok: true, violations: [] };

  const isEdgeExplicit = options.isEdgeRuntime === true;
  const hasEdgeExport = /export\s+const\s+runtime\s*=\s*['"]edge['"]/i.test(diffOrText);
  const isEdgeDetected = options.root ? detectEdgeRuntime(options.root).isEdgeRuntime : false;
  const isEdgeContext = isEdgeExplicit || hasEdgeExport || isEdgeDetected;

  if (!isEdgeContext) {
    return { ok: true, violations: [] };
  }

  const lines = diffOrText.split("\n");
  const targetLines = lines.filter((line) => {
    if (diffOrText.includes("+++ b/")) {
      return line.startsWith("+") && !line.startsWith("+++");
    }
    return true;
  });

  const edgeImportRegex = /(?:import\s+.*?\s+from\s+|require\s*\(\s*)['"](node:(?:fs|child_process|cluster|dgram|net|tls|v8|vm|worker_threads)|(?:fs|child_process|cluster|dgram|net|tls|v8|vm|worker_threads))(?:\/.*)?['"]/i;

  const violations = [];
  for (const line of targetLines) {
    const match = line.match(edgeImportRegex);
    if (match) {
      violations.push({
        module: match[1],
        line: line.trim(),
        reason: `Edge Runtime Violation: Native Node module "${match[1]}" is unsupported in Edge environments (Cloudflare Workers / Vercel Edge / Netlify Edge).`,
      });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}

export function checkCrossPackageImports(diffOrText = "", root = process.cwd(), options = {}) {
  if (!diffOrText || typeof diffOrText !== "string") return { ok: true, violations: [] };

  const violations = [];

  if (diffOrText.includes("+++ b/")) {
    const lines = diffOrText.split("\n");
    let currentFile = null;
    let currentAdded = [];

    const flushFile = () => {
      if (currentFile && currentAdded.length > 0) {
        const fileViolations = detectCrossPackageBoundaryViolations([currentFile], root, {
          fileContents: { [currentFile]: currentAdded.join("\n") },
          ...options,
        });
        violations.push(...fileViolations);
      }
    };

    for (const line of lines) {
      if (line.startsWith("+++ b/")) {
        flushFile();
        currentFile = line.slice(6).trim();
        currentAdded = [];
      } else if (line.startsWith("+") && !line.startsWith("+++")) {
        currentAdded.push(line.slice(1));
      }
    }
    flushFile();
  } else if (options.file) {
    const fileViolations = detectCrossPackageBoundaryViolations([options.file], root, {
      fileContents: { [options.file]: diffOrText },
      ...options,
    });
    violations.push(...fileViolations);
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}

/**
 * Group the added lines of a unified diff by the file they belong to.
 *
 * Line numbers come from the `@@` hunk headers and count the post-image, so a
 * reported number matches what an editor shows after the change is applied.
 * Both the file and the number are best-effort: a fragment with no headers —
 * the shape `wizard-task.mjs` synthesises from a prompt — yields one anonymous
 * segment, which is exactly the old whole-diff behaviour.
 *
 * @param {string} diffText
 * @returns {Array<{ file: string|null, lines: Array<{ text: string, no: number|null }> }>}
 */
function splitDiffByFile(diffText) {
  const byFile = new Map();
  let current = null;
  let lineNo = null;

  const select = (file) => {
    if (!byFile.has(file)) byFile.set(file, { file, lines: [] });
    current = byFile.get(file);
  };

  for (const line of diffText.split("\n")) {
    if ((line.startsWith("+++ ") || line.startsWith("+++ b/") || line.startsWith("+++ /dev/null")) && !line.startsWith("++++")) {
      const name = line.slice(3).split("\t")[0].trim().replace(/^b\//, "");
      select(name && name !== "/dev/null" ? name : null);
      lineNo = null;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) {
      lineNo = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+")) {
      if (!current) select(null);
      current.lines.push({ text: line.slice(1), no: lineNo });
      if (lineNo !== null) lineNo++;
    } else if (lineNo !== null && !line.startsWith("-") && !line.startsWith("\\")) {
      lineNo++; // A context line advances the post-image just as an added one does.
    }
  }

  return [...byFile.values()].filter((s) => s.lines.length > 0);
}

/** Bytes of any one binary file the scanner will read. */
const BINARY_SCAN_CAP_BYTES = 8 * 1024 * 1024;

/** Runs of printable ASCII at least this long are worth classifying. */
const BINARY_STRING_MIN_RUN = 8;

/**
 * Scan the contents of files git summarised as "Binary files ... differ".
 *
 * Everything else in this module reads the diff *text*, and git renders a
 * binary file as one 43-byte summary line — so a credential became invisible to
 * the entire scanner by prefixing the file with a single NUL byte. That is not
 * a theoretical bypass: `printf '\0ghp_...' > secret.dat` walked a live GitHub
 * token straight through a green gate.
 *
 * Only the *structured* high-confidence patterns are applied here, never
 * entropy. A real PNG is full of high-entropy bytes and would fail every gate
 * it touched; a string matching `ghp_[A-Za-z0-9]{36}` inside a file claiming to
 * be an image is not a coincidence.
 *
 * @param {Array<{ file: string, bytes: number }>} entries
 * @param {string} root
 * @param {object} [opts]
 * @param {number} [opts.capBytes] - per-file read ceiling
 * @returns {Array<{ severity: string, type: string, file: string, line: null, description: string }>}
 */
export function scanBinaryPayloads(entries = [], root = process.cwd(), opts = {}) {
  const cap = Number.isFinite(opts.capBytes) ? opts.capBytes : BINARY_SCAN_CAP_BYTES;
  const findings = [];
  // `entries` comes from a git call that returns null on failure, and the
  // default parameter only covers `undefined`.
  const list = Array.isArray(entries) ? entries : [];

  for (const entry of list) {
    if (!entry || !entry.file) continue;
    // A file too large to read is reported rather than skipped: silence here is
    // exactly the hole being closed.
    if (entry.bytes > cap) {
      findings.push({
        severity: "HIGH",
        type: "BINARY_PAYLOAD_UNSCANNED",
        file: entry.file,
        line: null,
        description: `Binary file ${entry.file} is ${Math.round(entry.bytes / 1024)} KB, above the ${Math.round(cap / 1024)} KB scan ceiling, and was not inspected for credentials`,
      });
      continue;
    }

    let buf;
    try {
      buf = readFileSync(join(root, entry.file));
    } catch (_) {
      continue;
    }

    // Extract printable runs the way `strings(1)` does: a credential inside a
    // binary is still ASCII, and decoding the whole buffer as UTF-8 would let
    // replacement characters split the token apart.
    const runs = [];
    let current = "";
    for (const byte of buf) {
      if (byte >= 0x20 && byte <= 0x7e) {
        current += String.fromCharCode(byte);
      } else {
        if (current.length >= BINARY_STRING_MIN_RUN) runs.push(current);
        current = "";
      }
    }
    if (current.length >= BINARY_STRING_MIN_RUN) runs.push(current);
    if (runs.length === 0) continue;

    const text = runs.join("\n");
    if (hasHighConfidenceSecret(text)) {
      findings.push({
        severity: "CRITICAL",
        type: "HIGH_CONFIDENCE_SECRET",
        file: entry.file,
        line: null,
        description: `High-confidence secret pattern found inside binary file ${entry.file}, which the diff renders only as "Binary files ... differ"`,
      });
      continue;
    }
    if (hasEncodedSecret(text)) {
      findings.push({
        severity: "CRITICAL",
        type: "HIGH_CONFIDENCE_SECRET",
        file: entry.file,
        line: null,
        description: `Base64-encoded secret found inside binary file ${entry.file}`,
      });
    }
  }

  return findings;
}

/**
 * Classify a block of added lines. Returns the single most severe finding, or
 * null when the block is clean.
 *
 * @param {string} addedLines
 * @param {string|null} [file=null]
 * @returns {{ severity: string, type: string, description: string, encoded: boolean }|null}
 */
function classifyAddedLines(addedLines, file = null) {
  const { all: variants, normalized, base64Normalized } = secretScanVariants(addedLines);
  if (variants.some((v) => hasHighConfidenceSecret(v))) {
    return { severity: "CRITICAL", type: "HIGH_CONFIDENCE_SECRET", encoded: false, description: "High-confidence secret pattern detected in added diff lines" };
  }
  // Only worth decoding when nothing was found in the clear, and only against
  // the fully-normalised text: decoding is the expensive step, and the
  // intermediate variants differ from it in ways base64 blobs do not care about.
  if (hasEncodedSecret(normalized) || (base64Normalized && hasEncodedSecret(base64Normalized))) {
    // Same type as the cleartext case: every gate that blocks on
    // HIGH_CONFIDENCE_SECRET should block on this too, and a new type would
    // have silently passed through the ones not updated. The description
    // carries the difference the operator needs.
    return { severity: "CRITICAL", type: "HIGH_CONFIDENCE_SECRET", encoded: true, description: "High-confidence secret pattern detected inside a base64-encoded value on an added diff line" };
  }
  if (variants.some((v) => hasLowConfidenceSecret(v))) {
    return { severity: "HIGH", type: "LOW_CONFIDENCE_SECRET", encoded: false, description: "Low-confidence secret or authorization token detected in added diff lines" };
  }
  if (hasHighEntropyToken(addedLines, file)) {
    return { severity: "HIGH", type: "HIGH_ENTROPY_TOKEN", encoded: false, description: "High-entropy token detected in added diff lines (potential unstructured secret or API key)" };
  }
  return null;
}

/**
 * Narrow a segment-level finding to the line that produced it.
 *
 * Only runs on a segment that has already been flagged, so the extra pass costs
 * nothing on a clean diff. Returns null when no single line reproduces the
 * verdict — a credential split across a concatenation belongs to the block, not
 * to either half of it, and guessing one of them would point the operator at an
 * innocent line.
 *
 * @param {Array<{ text: string, no: number|null }>} lines
 * @param {string} type
 * @param {string|null} [file=null]
 * @returns {number|null}
 */
function locateFindingLine(lines, type, file = null) {
  for (const line of lines) {
    if (line.no === null) continue;
    const hit = classifyAddedLines(line.text, file);
    if (hit && hit.type === type) return line.no;
  }
  return null;
}

export function scanDiff(diffTextStr = "", options = {}) {
  if (!diffTextStr) return { ok: true, findings: [] };

  const segments = splitDiffByFile(diffTextStr);
  const findings = [];

  for (const segment of segments) {
    const addedText = segment.lines.map((l) => l.text).join("\n");

    // Check Trojan Source
    if (!segment.file || !segment.file.endsWith('.md')) {
      const tsRes = checkTrojanSource(addedText, options);
      if (!tsRes.ok) {
        // Find line number where it happened if possible
        const bidiRegex = /[\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\u061C\u200E\u200F]/;
        let lineNo = null;
        for (const l of segment.lines) {
          if (bidiRegex.test(l.text)) {
            lineNo = l.no;
            break;
          }
        }
        for (const v of tsRes.violations) {
          findings.push({
            severity: "CRITICAL",
            type: "TROJAN_SOURCE_DETECTED",
            file: segment.file,
            line: lineNo,
            description: v.reason,
          });
        }
      }
    }

    const hit = classifyAddedLines(addedText, segment.file);
    if (!hit) continue;
    const line = segment.file ? locateFindingLine(segment.lines, hit.type, segment.file) : null;
    const at = segment.file ? ` (${segment.file}${line ? `:${line}` : ""})` : "";
    findings.push({
      severity: hit.severity,
      type: hit.type,
      file: segment.file,
      line,
      description: `${hit.description}${at}`,
    });
  }

  // Scanning per file loses anything that only matches across a file boundary,
  // which the previous whole-diff join happened to catch. Rather than trade
  // detection for attribution, fall back to the joined text when every file
  // came back clean — the cost lands only on diffs with nothing to report.
  if (findings.length === 0 && segments.length > 1) {
    const hit = classifyAddedLines(segments.flatMap((s) => s.lines.map((l) => l.text)).join("\n"), null);
    if (hit) {
      findings.push({
        severity: hit.severity,
        type: hit.type,
        file: null,
        line: null,
        description: `${hit.description} (spanning more than one file)`,
      });
    }
  }

  const secretsOk = findings.length === 0;

  const edgeRes = checkEdgeRuntimeImports(diffTextStr, options);
  if (!edgeRes.ok) {
    for (const v of edgeRes.violations) {
      findings.push({ severity: "HIGH", type: "EDGE_RUNTIME_VIOLATION", description: v.reason });
    }
  }

  const root = options.root || process.cwd();
  const crossPkgRes = checkCrossPackageImports(diffTextStr, root, options);
  if (!crossPkgRes.ok) {
    for (const v of crossPkgRes.violations) {
      findings.push({ severity: "HIGH", type: "CROSS_PACKAGE_BOUNDARY_VIOLATION", file: v.file ?? null, description: v.reason });
    }
  }

  const tamperingRes = checkTestTampering(diffTextStr, options);
  if (!tamperingRes.ok) {
    for (const v of tamperingRes.violations) {
      findings.push({ severity: "CRITICAL", type: "TEST_TAMPERING_DETECTED", file: v.file ?? null, line: v.line ?? null, description: v.reason });
    }
  }

  // The gate calls `scanDiff`, not `assertTestIntegrity` — so wiring the
  // dialect warning into the latter meant it reached nobody. The guard
  // computed `UNREADABLE`, and the operator was shown an unblemished pass.
  // A boundary that is not reported is not a boundary.
  //
  // And it blocks, because the previous wording was the defect it described.
  // Printing "this change was NOT checked for tampering ... it is not an
  // approval either" and then returning APPROVED (Exit 0) is the exact shape
  // this project exists to refuse: a verdict from a check that examined
  // nothing, dressed as a pass. A second cold-start trial walked a tampered
  // test and broken production code straight through on node-tap, and again
  // on BATS. `verify.tamperGuard: "warn"` is how a repository whose dialect
  // is genuinely unsupported opts out — deliberately, and on the record.
  let unreadableBlocks = false;
  if (tamperingRes.status === "UNREADABLE") {
    const mode = options.tamperGuard === "warn" || options.allowUnreadableTests === true ? "warn" : "block";
    unreadableBlocks = mode === "block";
    const where = (tamperingRes.unreadable || []).map((u) => u.file);
    const sample = tamperingRes.unreadable?.[0]?.samples?.[0];
    findings.push({
      severity: unreadableBlocks ? "CRITICAL" : "MEDIUM",
      type: "TEST_DIALECT_UNREADABLE",
      file: where[0] ?? null,
      line: null,
      description:
        `Test Tamper Guard: changed ${tamperingRes.inputsSeen} line(s) in ${tamperingRes.filesSeen} test file(s) ` +
        `and recognised no assertion among them${sample ? ` (e.g. ${JSON.stringify(sample)})` : ""}. ` +
        `This change was NOT checked for tampering${unreadableBlocks ? ", so it cannot be approved" : ""}. ` +
        (unreadableBlocks
          ? `If this repository's assertion library is genuinely unsupported, say so once in .agent/config.yml ` +
            `with verify.tamperGuard: "warn", or allow this run with --allow-unreadable-tests. Reporting the ` +
            `dialect is more useful than either: the guard covers Node, pytest, Go, Rust, JUnit, RSpec, PHPUnit, ` +
            `Minitest, XCTest, chai and node-tap.`
          : `Reported only, because verify.tamperGuard is set to "warn".`),
    });
  }

  return {
    ok: secretsOk && edgeRes.ok && crossPkgRes.ok && tamperingRes.ok && !unreadableBlocks,
    findings,
  };
}

/* -- re-exports: the submodules' public surface, unchanged by the split ------ */

export { safeRenameSync, safeAtomicWrite } from "./fs-atomic.mjs";
export {
  matchesGlob,
  isForbiddenPath,
  ENV_TEMPLATE_BASENAMES,
  isEnvTemplateException,
  checkScope,
} from "./scope-guard.mjs";
export {
  HIGH_CONFIDENCE_PATTERNS,
  LOW_CONFIDENCE_PATTERNS,
  shannonEntropy,
  hasHighConfidenceSecret,
  hasLowConfidenceSecret,
  redactSecrets,
  anonymizePii,
  hasEncodedSecret,
  hasHighEntropyToken,
} from "./secret-scanner.mjs";
export { TAMPER_KINDS, TAMPER_KIND_NAMES, resolveAllowedTamperKinds, checkTestTampering } from "./test-tamper-guard.mjs";
export { checkTrojanSource } from "./bidi-guard.mjs";
