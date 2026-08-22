import { openSync, writeSync, fsyncSync, closeSync, renameSync, realpathSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { canonicalizePath } from "./config.mjs";
import { detectCrossPackageBoundaryViolations } from "./stack-detector.mjs";

export const HIGH_CONFIDENCE_PATTERNS = [
  /\bghp_[A-Za-z0-9_]{36,255}\b/g,
  /\bgho_[A-Za-z0-9_]{36,255}\b/g,
  /\bghu_[A-Za-z0-9_]{36,255}\b/g,
  /\bghs_[A-Za-z0-9_]{36,255}\b/g,
  /\bghr_[A-Za-z0-9_]{36,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g,

  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\baws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9\/+=]{40}['"]?/gi,

  /-----BEGIN (?:RSA|DSA|EC|OPENSSH|ENCRYPTED|PRIVATE)(?:\s+PRIVATE)? KEY-----[\s\S]*?-----END (?:RSA|DSA|EC|OPENSSH|ENCRYPTED|PRIVATE)(?:\s+PRIVATE)? KEY-----/g,
  /PuTTY-User-Key-File-[0-9]:[^\n]+/g,

  /\bsk_live_[0-9a-zA-Z]{24,99}\b/g,
  /\brk_live_[0-9a-zA-Z]{24,99}\b/g,
  /\bnpm_[0-9a-zA-Z]{36}\b/g,
  /\/\/[^/\s]+\/:_authToken=[A-Za-z0-9_-]{20,}/g,
  /\bglpat-[0-9a-zA-Z_-]{20,99}\b/g,
  /\bGOCSPX-[0-9a-zA-Z_-]{28,99}\b/g,

  /\bAIzaSy[A-Za-z0-9_-]{33}\b/g,
  /\bya29\.[A-Za-z0-9_-]{20,255}\b/g,
  /\b(?:sk-ant-api03-|sk-proj-|sk-)[A-Za-z0-9_-]{20,255}\b/g,

  /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]{8,}\/B[A-Za-z0-9_]{8,}\/[A-Za-z0-9_]{24,}/g,
  /\bxox[baprs]-[0-9a-zA-Z-]{10,48}\b/g,

  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

export const LOW_CONFIDENCE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/-]{10,255}/gi,
  /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/-]{10,255}/gi,
  /\bsk_test_[0-9a-zA-Z]{24,99}\b/g,
  /(?:api[_-]?key|secret|password|passwd|token|auth[_-]?token)\s*[:=]\s*(?:['"`]([^'"`\n]{8,128})['"`]|([A-Za-z0-9._~+/-]{16,128}))/gi,
];

export function safeRenameSync(src, dst) {
  try {
    renameSync(src, dst);
  } catch (err) {
    if (process.platform === "win32" && (err.code === "EEXIST" || err.code === "EPERM")) {
      try { unlinkSync(dst); } catch (_) {}
      renameSync(src, dst);
    } else {
      throw err;
    }
  }
}

/**
 * TOCTOU-safe atomic file write using O_CREAT|O_EXCL|O_WRONLY temp file in target dir.
 */
export function safeAtomicWrite(filePath, content, options = {}) {
  const mode = options.mode || 0o644;
  const encoding = options.encoding || "utf-8";
  const rejectSymlinks = options.rejectSymlinks !== false;

  if (existsSync(filePath)) {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      const realPath = realpathSync(filePath);
      if (rejectSymlinks) {
        throw new Error(`TOCTOU Guard: Refusing to write to symlink ${filePath} -> ${realPath}`);
      }
    }
  }

  const dir = dirname(filePath);
  const tempFile = join(dir, `.tmp-${basename(filePath)}-${randomBytes(6).toString("hex")}`);

  let fd;
  try {
    fd = openSync(tempFile, "wx", mode);
    writeSync(fd, content, null, encoding);
    if (options.sync !== false) {
      fsyncSync(fd);
    }
    closeSync(fd);
    fd = undefined;
    safeRenameSync(tempFile, filePath);
    return true;
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch (_) {}
    }
    try {
      if (existsSync(tempFile)) unlinkSync(tempFile);
    } catch (_) {}
    throw err;
  }
}

export function shannonEntropy(str) {
  if (!str || typeof str !== "string") return 0;
  const len = str.length;
  const frequencies = {};
  for (let i = 0; i < len; i++) {
    const char = str[i];
    frequencies[char] = (frequencies[char] || 0) + 1;
  }
  let entropy = 0;
  for (const char in frequencies) {
    const p = frequencies[char] / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function hasHighConfidenceSecret(text) {
  if (!text) return false;
  return HIGH_CONFIDENCE_PATTERNS.some((pat) => {
    pat.lastIndex = 0;
    const res = pat.test(text);
    pat.lastIndex = 0;
    return res;
  });
}

export function hasLowConfidenceSecret(text) {
  if (!text) return false;
  return LOW_CONFIDENCE_PATTERNS.some((pat) => {
    pat.lastIndex = 0;
    const res = pat.test(text);
    pat.lastIndex = 0;
    return res;
  });
}

export function redactSecrets(text) {
  if (!text) return "";
  let sanitized = text;

  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (
      envVal &&
      (envVal.length >= 20 || shannonEntropy(envVal) > 3.6) &&
      /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH|PASSPHRASE|URL|URI|DSN|CONNECTION|ACCOUNT/i.test(envKey)
    ) {
      if (sanitized.includes(envVal)) {
        sanitized = sanitized.split(envVal).join("[REDACTED_ENV_SECRET]");
      }
    }
  }

  const allPatterns = [...HIGH_CONFIDENCE_PATTERNS, ...LOW_CONFIDENCE_PATTERNS];
  for (const pat of allPatterns) {
    pat.lastIndex = 0;
    sanitized = sanitized.replace(pat, "[REDACTED_BY_SECURITY_GATE]");
  }

  // A key the scanner can find inside a base64 blob must not survive redaction
  // just because the literal bytes differ — otherwise scanDiff blocks the
  // dispatch and the escalation payload leaks the very value it blocked on. The
  // whole blob goes, not part of it: a partially-redacted encoding still
  // decodes to the key.
  const encoded = new Set();
  decodeBase64Blobs(sanitized, (plain, blob) => {
    if (hasHighConfidenceSecret(plain)) encoded.add(blob);
  });
  for (const blob of encoded) {
    sanitized = sanitized.split(blob).join("[REDACTED_ENCODED_SECRET]");
  }

  return sanitized;
}

export function anonymizePii(text) {
  if (!text) return "";
  let sanitized = text;

  sanitized = sanitized.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]");
  sanitized = sanitized.replace(/\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g, (ip) => {
    if (ip === "127.0.0.1" || ip === "0.0.0.0") return ip;
    return "[REDACTED_IP]";
  });
  sanitized = sanitized.replace(/(?:(?:\+\d{1,3}[\s-]?)|\b)\(?\d{2,4}\)?(?:[\s-]?\d{2,4}){2,4}\b/g, (phone) => {
    const digitsOnly = phone.replace(/\D/g, "");
    if (digitsOnly.length >= 7 && digitsOnly.length <= 15) {
      return "[REDACTED_PHONE]";
    }
    return phone;
  });

  return sanitized;
}

/**
 * Glob matcher.
 *
 * `caseInsensitive` exists because the same repository is checked out on
 * Linux, macOS and Windows. On APFS and NTFS, `.GitHub/` and `.github/` are
 * the *same directory*, but git records whichever case was committed — so a
 * case-sensitive deny rule can be walked straight past on two of the three
 * target platforms. Deny and protect matching therefore folds case; allow
 * matching deliberately does not, so that a case mismatch fails closed
 * (unmatched by allow = violation) rather than opening a hole.
 *
 * @param {string} filePath
 * @param {string} globPattern
 * @param {{ caseInsensitive?: boolean }} [opts]
 */
export function matchesGlob(filePath, globPattern, opts = {}) {
  if (!filePath || !globPattern) return false;
  const file = canonicalizePath(filePath);
  const pattern = canonicalizePath(globPattern);
  const flags = opts.caseInsensitive ? "i" : "";

  if (opts.caseInsensitive ? file.toLowerCase() === pattern.toLowerCase() : file === pattern) return true;

  const parts = pattern.split("/");
  const regexParts = parts.map((part) => {
    if (part === "**") return "___GLOBSTAR___";
    if (part === "*") return "[^/]+";
    const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return escaped.replace(/\\\*/g, "[^/]*").replace(/\\\?/g, ".");
  });

  let regexStr = regexParts.join("/");
  regexStr = regexStr
    .replace(/^___GLOBSTAR___\//g, "(?:.*/|^)")
    .replace(/\/___GLOBSTAR___$/g, "(?:/.*|$)")
    .replace(/\/___GLOBSTAR___\//g, "(?:/|/.+/|/)")
    .replace(/___GLOBSTAR___/g, ".*");

  try {
    return new RegExp(`^${regexStr}$`, flags).test(file);
  } catch (_) {
    return false;
  }
}

export function isForbiddenPath(filePath, config = {}) {
  const normFile = canonicalizePath(filePath);
  const forbidden = config.scope?.deny || config.forbidden_paths || [];
  return forbidden.some((pattern) => matchesGlob(normFile, pattern, { caseInsensitive: true }));
}

export function checkScope(files = [], scope = {}, opts = {}) {
  const violations = [];
  const deny = scope.deny || [];
  const allow = scope.allow || [];
  const protect = scope.protect || [];

  for (const rawFile of files) {
    // Canonicalised so that "./x", "a/../x" and "a//x" cannot present the same
    // file under a spelling the deny patterns do not literally match.
    const file = canonicalizePath(rawFile);

    // A path that climbs out of the repository root can never be legitimate and
    // must not be silently pattern-matched against repo-relative rules.
    if (file === ".." || file.startsWith("../") || file.startsWith("/")) {
      violations.push({ file, reason: "Path escapes the repository root", rule: "deny", pattern: "<traversal>" });
      continue;
    }

    // Deny folds case: on macOS/Windows ".GitHub/" resolves to the same
    // directory as ".github/", so a case-sensitive deny is bypassable there.
    const matchedDeny = deny.find((pat) => matchesGlob(file, pat, { caseInsensitive: true }));
    if (matchedDeny) {
      violations.push({ file, reason: `Forbidden path restriction matched pattern "${matchedDeny}"`, rule: "deny", pattern: matchedDeny });
      continue;
    }

    // Allow stays case-sensitive on purpose: a case mismatch here yields "not
    // allowed" (a violation), which is the fail-closed direction.
    if (allow.length > 0) {
      const isExplicitlyAllowed = allow.some((pat) => matchesGlob(file, pat));
      if (!isExplicitlyAllowed) {
        violations.push({ file, reason: "Path not included in allowed paths list", rule: "allow" });
        continue;
      }
    }

    if (!opts.allowProtected) {
      const matchedProtect = protect.find((pat) => matchesGlob(file, pat, { caseInsensitive: true }));
      if (matchedProtect) {
        violations.push({ file, reason: `Protected file modification restriction matched pattern "${matchedProtect}"`, rule: "protect", pattern: matchedProtect });
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}

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
  const isEdgeContext = isEdgeExplicit || hasEdgeExport;

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

// Zero-width and bidi-control characters. Inserting one mid-token defeats a
// regex without changing how the value renders, copies, or authenticates.
const INVISIBLE_CHARS = /[\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\uFEFF]/g;

// A credential split across a source-level string concatenation is invisible to
// a line-oriented scanner. This is not only an evasion technique — formatters
// wrap long string literals exactly this way, so it also happens by accident.
const STRING_CONCAT_JOIN = /(["'`])\s*(?:\/\*[\s\S]*?\*\/)?\s*\+\s*(?:\/\*[\s\S]*?\*\/)?\s*(["'`])/g;

function tryHexDecodeTokens(str) {
  return str.replace(/\b([0-9a-fA-F]{24,})\b/g, (match) => {
    if (match.length % 2 !== 0) return match;
    try {
      const decoded = Buffer.from(match, "hex").toString("utf-8");
      if (printableRatio(decoded) >= 0.9) return decoded;
    } catch (_) {}
    return match;
  });
}

function tryPercentDecode(str) {
  try {
    return decodeURIComponent(str);
  } catch (_) {
    return str.replace(/%([0-9a-fA-F]{2})/g, (_, hex) => {
      try {
        return String.fromCharCode(parseInt(hex, 16));
      } catch (_) {
        return _;
      }
    });
  }
}

/**
 * Produces the variants of the added-line text that secret patterns are run
 * against: as-written, with invisible characters stripped, and with
 * source-level string concatenation collapsed.
 *
 * @param {string} addedLines
 * @returns {{ all: string[], normalized: string }}
 */
function secretScanVariants(addedLines) {
  const stripped = addedLines.replace(INVISIBLE_CHARS, "");
  // Collapse `"AAA" +\n  "BBB"` into `"AAABBB"` before matching.
  let dejoined = stripped.replace(/\s*\n\s*/g, " ").replace(STRING_CONCAT_JOIN, "");
  // Collapse template literal empty expressions `${""}` and `${"VALUE"}`
  dejoined = dejoined.replace(/\$\{\s*["'`]{2}\s*\}/g, "").replace(/\$\{\s*["'`]([^"'`]+)["'`]\s*\}/g, "$1");
  // Collapse method concatenations like .concat("...") or .join("")
  dejoined = dejoined.replace(/\.concat\(\s*["'`]/g, "").replace(/\.join\(\s*["'`]{2}\s*\)/g, "");

  const hexDecoded = tryHexDecodeTokens(dejoined);
  const pctDecoded = tryPercentDecode(dejoined);

  return {
    all: [...new Set([addedLines, stripped, dejoined, hexDecoded, pctDecoded])],
    normalized: dejoined,
  };
}

// Base64 is less an evasion technique than a file format. Every value in a
// Kubernetes Secret manifest is base64 by specification, and whole `.env` files
// get encoded into a single CI variable.
const BASE64_CANDIDATE = /[A-Za-z0-9+/\-_]{20,}={0,2}/g;

// Budgets the decoder spends before it gives up and reports `capped`.
//
// The count that matters is payloads *retained* — blobs that decoded to text
// and so could be carrying a credential. Counting every token that merely
// matches the base64 alphabet instead made a digest indistinguishable from a
// payload: a sha256 hex string is 64 characters of that alphabet, decodes to
// binary, gets discarded, and used to consume a slot anyway. Any diff holding
// 65 hashes — every lockfile bump — then tripped the cap and failed closed as
// a CRITICAL credential leak with no credential anywhere in it.
const BASE64_MAX_CANDIDATES = 64;
const BASE64_MAX_TOKENS_EXAMINED = 8192;
const BASE64_MAX_DECODED_BYTES = 64 * 1024;
// Per-blob ceiling, so one oversized payload cannot spend the whole budget and
// starve the blobs after it. The trade-off is deliberate: a credential buried
// past 8 KB inside a single blob is missed, where the old code caught it only
// by refusing to decode and then failing the entire diff closed. That refusal
// fired on every checked-in base64 asset, and a gate that cries wolf on
// ordinary input gets switched off. The cleartext scanners still run over the
// raw diff regardless.
const BASE64_MAX_BLOB_BYTES = 8 * 1024;

/**
 * Share of characters that are printable ASCII (plus tab/newline/return).
 */
function printableRatio(str) {
  if (!str) return 0;
  let printable = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126)) printable++;
  }
  return printable / str.length;
}

/**
 * Decode the base64-looking blobs in `text` that plausibly hold text.
 *
 * @param {string} text
 * @param {(plain: string, blob: string) => void} [onDecoded] - Called per blob.
 * @returns {{ decoded: string[], capped: boolean }}
 */
function decodeBase64Blobs(text, onDecoded) {
  if (!text) return { decoded: [], capped: false };
  const decoded = [];
  let examined = 0;
  let retained = 0;
  let bytes = 0;
  let capped = false;

  BASE64_CANDIDATE.lastIndex = 0;
  let match;
  while ((match = BASE64_CANDIDATE.exec(text)) !== null) {
    if (examined++ >= BASE64_MAX_TOKENS_EXAMINED) {
      capped = true;
      break;
    }
    const rawBlob = match[0].replace(/[\s\r\n]+/g, "");
    let stdBlob = rawBlob.replace(/-/g, "+").replace(/_/g, "/");
    while (stdBlob.length % 4 !== 0) {
      stdBlob += "=";
    }

    // An oversized blob is decoded up to a bounded prefix rather than skipped
    // outright. Base64 decodes in independent 4-character groups, so a prefix
    // is exact, and a credential near the head of a large payload still
    // surfaces — where skipping used to hide it and then blame the whole diff.
    const budget = Math.min(BASE64_MAX_BLOB_BYTES, BASE64_MAX_DECODED_BYTES - bytes);
    if (budget <= 0) {
      capped = true;
      break;
    }
    const maxChars = Math.floor(budget / 3) * 4;
    if (stdBlob.length > maxChars) stdBlob = stdBlob.slice(0, maxChars);

    let plain;
    try {
      plain = Buffer.from(stdBlob, "base64").toString("utf-8");
    } catch (_) {
      continue;
    }
    bytes += plain.length;

    // A blob that decodes to binary has been examined and cleared. It is not a
    // blind spot, so it must not spend a payload slot.
    if (printableRatio(plain) < 0.9) continue;

    if (retained++ >= BASE64_MAX_CANDIDATES) {
      capped = true;
      break;
    }

    decoded.push(plain);
    if (onDecoded) onDecoded(plain, rawBlob);

    // Try 1 level of nested base64 decoding if printable
    if (/[A-Za-z0-9+/\-_]{20,}={0,2}/.test(plain)) {
      try {
        let nestedStd = plain.trim().replace(/-/g, "+").replace(/_/g, "/");
        while (nestedStd.length % 4 !== 0) nestedStd += "=";
        const nestedPlain = Buffer.from(nestedStd, "base64").toString("utf-8");
        if (printableRatio(nestedPlain) >= 0.9) {
          decoded.push(nestedPlain);
        }
      } catch (_) {}
    }
  }
  BASE64_CANDIDATE.lastIndex = 0;
  return { decoded, capped };
}

/**
 * True when a base64-encoded value on an added line decodes to a structured
 * credential.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasEncodedSecret(text) {
  const result = decodeBase64Blobs(text);
  if (result.capped) return true; // Fail closed if cap exceeded
  return result.decoded.some((plain) => hasHighConfidenceSecret(plain));
}

export function scanDiff(diffTextStr = "", options = {}) {
  if (!diffTextStr) return { ok: true, findings: [] };
  const addedLines = diffTextStr
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");

  const { all: variants, normalized } = secretScanVariants(addedLines);
  const hasHigh = variants.some((v) => hasHighConfidenceSecret(v));
  // Only worth decoding when nothing was found in the clear, and only against
  // the fully-normalised text: decoding is the expensive step, and the
  // intermediate variants differ from it in ways base64 blobs do not care about.
  const hasEncoded = !hasHigh && hasEncodedSecret(normalized);
  const hasLow = !hasHigh && !hasEncoded && variants.some((v) => hasLowConfidenceSecret(v));
  const findings = [];

  if (hasHigh) {
    findings.push({ severity: "CRITICAL", type: "HIGH_CONFIDENCE_SECRET", description: "High-confidence secret pattern detected in added diff lines" });
  } else if (hasEncoded) {
    // Same type as the cleartext case: every gate that blocks on
    // HIGH_CONFIDENCE_SECRET should block on this too, and a new type would
    // have silently passed through the ones not updated. The description
    // carries the difference the operator needs.
    findings.push({ severity: "CRITICAL", type: "HIGH_CONFIDENCE_SECRET", description: "High-confidence secret pattern detected inside a base64-encoded value on an added diff line" });
  } else if (hasLow) {
    findings.push({ severity: "HIGH", type: "LOW_CONFIDENCE_SECRET", description: "Low-confidence secret or authorization token detected in added diff lines" });
  }

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
      findings.push({ severity: "HIGH", type: "CROSS_PACKAGE_BOUNDARY_VIOLATION", description: v.reason });
    }
  }

  return {
    ok: !hasHigh && !hasEncoded && !hasLow && edgeRes.ok && crossPkgRes.ok,
    findings,
  };
}

