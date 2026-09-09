/**
 * Credential and PII detection over arbitrary text.
 *
 * Split out of src/security.mjs (P05). Everything here answers one of two
 * questions about a blob of text: "does it contain a secret" and "give me a copy
 * with the secret removed". It is the scanner half of the old bundle; deciding
 * what to do with a finding (scanDiff, binary payload scanning, the diff parser)
 * stayed in the facade so this module never has to know what a unified diff is.
 *
 * Evasion hardening lives here: invisible-character stripping, NFKD plus a
 * homoglyph table, string-concatenation rejoining, and hex/percent/base64
 * decoding — all of it so a credential cannot hide behind a substituted glyph,
 * a line wrap, or an encoding.
 */

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

// Zero-width, bidi-control characters, and Unicode tag plane (U+E0000..U+E007F).
// Inserting one mid-token defeats a regex without changing how the value renders, copies, or authenticates.
const INVISIBLE_CHARS = /[\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu;

// Unicode lookalikes that NFKD does NOT decompose. Full-width and other
// compatibility forms are handled by String#normalize("NFKD") below; these are
// the Cyrillic/Greek/Latin homoglyphs that survive NFKD because they are
// distinct code points with no compatibility decomposition. A credential
// scanner without this table can be defeated by a single substituted glyph,
// e.g. `ghp_` spelled with Cyrillic `р`.
const CONFUSABLE_TO_ASCII = new Map([
  // Cyrillic
  ["А", "A"], ["В", "B"], ["Е", "E"], ["К", "K"], ["М", "M"], ["Н", "H"],
  ["О", "O"], ["Р", "P"], ["С", "C"], ["Т", "T"], ["У", "Y"], ["Х", "X"],
  ["а", "a"], ["е", "e"], ["о", "o"], ["р", "p"], ["с", "c"], ["у", "y"],
  ["х", "x"], ["і", "i"], ["ј", "j"], ["ѕ", "s"],
  // Greek
  ["Α", "A"], ["Β", "B"], ["Ε", "E"], ["Ζ", "Z"], ["Η", "H"], ["Ι", "I"],
  ["Κ", "K"], ["Μ", "M"], ["Ν", "N"], ["Ο", "O"], ["Ρ", "P"], ["Τ", "T"],
  ["Υ", "Y"], ["Χ", "X"], ["ο", "o"], ["ι", "i"], ["ν", "v"], ["υ", "u"],
  ["ρ", "p"], ["τ", "t"], ["χ", "x"],
  // Other Unicode lookalikes
  ["ſ", "s"], // U+017F LATIN SMALL LETTER LONG S
  ["K", "K"], // U+212A KELVIN SIGN
]);

const CONFUSABLE_REGEX = new RegExp([...CONFUSABLE_TO_ASCII.keys()].join("|"), "g");

/**
 * Reduces the confusable spellings a credential can hide behind to plain
 * ASCII before the secret patterns run (`SEC-04`).
 *
 *   1. NFKD decomposes full-width and other compatibility forms
 *      (`ｇｈｐ＿…` → `ghp_…`).
 *   2. Combining marks the decomposition may leave behind are stripped
 *      (`e\u0301` → `e`).
 *   3. The curated lookalike table maps Cyrillic/Greek/Latin homoglyphs that
 *      NFKD cannot see through to their ASCII target.
 *
 * This is the zero-dependency subset of Unicode TR39 confusable handling; the
 * full confusables data table is intentionally omitted so the kit keeps
 * shipping with no runtime dependencies.
 *
 * @param {string} str
 * @returns {string}
 */
function normalizeSecretText(str) {
  if (!str || typeof str !== "string") return str;
  let out = str;
  try {
    out = out.normalize("NFKD");
  } catch (_) {}
  out = out.replace(/[\u0300-\u036f]/g, "");
  out = out.replace(CONFUSABLE_REGEX, (m) => CONFUSABLE_TO_ASCII.get(m));
  return out;
}

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
 * Exported so the diff scanner in `security.mjs` can run its classification
 * over the same variants without re-deriving them; it is not part of the
 * `security.mjs` public surface and is deliberately not re-exported there.
 *
 * @param {string} addedLines
 * @returns {{ all: string[], normalized: string }}
 */
export function secretScanVariants(addedLines) {
  const stripped = addedLines.replace(INVISIBLE_CHARS, "");
  // Collapse `"AAA" +\n  "BBB"` into `"AAABBB"` before matching.
  let dejoined = stripped.replace(/\s*\n\s*/g, " ").replace(STRING_CONCAT_JOIN, "");
  // Collapse template literal empty expressions `${""}` and `${"VALUE"}`
  dejoined = dejoined.replace(/\$\{\s*["'`]{2}\s*\}/g, "").replace(/\$\{\s*["'`]([^"'`]+)["'`]\s*\}/g, "$1");
  // Collapse method concatenations like .concat("...") or .join("")
  dejoined = dejoined.replace(/\.concat\(\s*["'`]/g, "").replace(/\.join\(\s*["'`]{2}\s*\)/g, "");

  // Collapse whitespace/newlines between adjacent base64 characters (including line-wrapped PEM/base64, template literals, and quoted string chunks)
  const base64Dejoined = stripped
    .replace(/([A-Za-z0-9+/=_-])\s*[\r\n]+\s*(?=[A-Za-z0-9+/=_-])/g, "$1")
    .replace(/([A-Za-z0-9+/=_-])["'`]\s*(?:\+\s*)?[\r\n]+\s*["'`]?([A-Za-z0-9+/=_-])/g, "$1$2");

  const hexDecoded = tryHexDecodeTokens(dejoined);
  const pctDecoded = tryPercentDecode(dejoined);
  // Confusable / NFKD normalisation runs over both the raw text and the
  // concatenation-collapsed text, so a credential that is both split across a
  // source-level join AND spelled with homoglyphs still surfaces.
  const confusable = normalizeSecretText(stripped);
  const confusableDejoined = normalizeSecretText(dejoined);

  return {
    all: [...new Set([addedLines, stripped, dejoined, base64Dejoined, hexDecoded, pctDecoded, confusable, confusableDejoined])],
    normalized: dejoined,
    base64Normalized: base64Dejoined,
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
  if (!text) return false;
  const result = decodeBase64Blobs(text);
  if (result.capped) return true; // Fail closed if cap exceeded
  if (result.decoded.some((plain) => hasHighConfidenceSecret(plain))) return true;

  if (text.includes("\n") || text.includes("\r")) {
    const collapsed = text
      .replace(/([A-Za-z0-9+/=_-])\s*[\r\n]+\s*(?=[A-Za-z0-9+/=_-])/g, "$1")
      .replace(/([A-Za-z0-9+/=_-])["'`]\s*(?:\+\s*)?[\r\n]+\s*["'`]?([A-Za-z0-9+/=_-])/g, "$1$2");
    if (collapsed !== text) {
      const collapsedResult = decodeBase64Blobs(collapsed);
      if (collapsedResult.capped) return true;
      if (collapsedResult.decoded.some((plain) => hasHighConfidenceSecret(plain))) return true;
    }
  }
  return false;
}

const CANDIDATE_TOKEN_REGEX = /[A-Za-z0-9_-]{24,}/g;

/** A whole data: URI, base64-encoded or not. Its payload is not a credential. */
const DATA_URI_TOKEN = /\bdata:[a-z0-9.+-]+\/[a-z0-9.+-]*(?:;[a-z0-9.+=-]+)*,[^\s"'`<>)\]}]*/gi;

/** A subresource-integrity digest. High entropy by construction, public by design. */
const INTEGRITY_TOKEN = /\bsha(?:256|384|512)-[A-Za-z0-9+/=]+/gi;

/** A URL, from its scheme to the first character that cannot be part of one. */
const URL_TOKEN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>)\]},;]+/gi;

/**
 * Remove from a line the noise that made URLs worth ignoring, and keep the
 * parts of a URL that can carry a credential.
 *
 * This used to be `if (rawLine.includes("://")) continue;` — one substring
 * anywhere on the line switched off entropy analysis for the entire line. So
 * the scanner caught a bare 32-character key and let the identical key through
 * the moment a comment carrying any http link sat beside it. An agent does not
 * need to know why that works to stumble into it; a fetch call and its endpoint
 * on one line is ordinary code.
 *
 * What actually justified the skip is narrower: a CDN path segment or an npm
 * integrity hash looks exactly like a secret and is neither. Those are dropped
 * here. A URL's userinfo and its query values are the opposite — `?api_key=…`
 * and `//user:password@host` are where credentials genuinely hide — so they
 * are carried over and scanned on their own.
 */
function stripEntropyNoise(rawLine) {
  const carried = [];
  let line = rawLine.replace(DATA_URI_TOKEN, " ").replace(INTEGRITY_TOKEN, " ");
  line = line.replace(URL_TOKEN, (url) => {
    const afterScheme = url.slice(url.indexOf("://") + 3);
    const authority = afterScheme.split(/[/?#]/)[0];
    const at = authority.lastIndexOf("@");
    if (at > 0) carried.push(authority.slice(0, at));
    const q = url.indexOf("?");
    if (q !== -1) {
      for (const pair of url.slice(q + 1).split(/[&;#]/)) {
        const eq = pair.indexOf("=");
        if (eq !== -1) carried.push(pair.slice(eq + 1));
      }
    }
    return " ";
  });
  return carried.length ? `${line} ${carried.join(" ")}` : line;
}

/**
 * Checks for high-entropy continuous tokens (>= 24 chars, entropy > 4.5) on added lines.
 * Strips URLs, data: URIs, SRI hashes (sha512-, sha256-, sha384-) and skips lockfiles
 * to eliminate false positives.
 *
 * @param {string} text - Text to scan
 * @param {string|null} [file=null] - File path associated with the text
 * @returns {boolean}
 */
export function hasHighEntropyToken(text = "", file = null) {
  if (!text || typeof text !== "string") return false;
  if (
    file &&
    (file.endsWith(".lock") ||
      file.endsWith(".lockb") ||
      file.includes("package-lock.json") ||
      file.includes("pnpm-lock.yaml") ||
      file.includes("yarn.lock") ||
      file.includes("Cargo.lock") ||
      file.includes("composer.lock"))
  ) {
    return false;
  }

  const lines = text.split("\n");
  for (const rawLine of lines) {
    const line = stripEntropyNoise(rawLine);

    CANDIDATE_TOKEN_REGEX.lastIndex = 0;
    let match;
    while ((match = CANDIDATE_TOKEN_REGEX.exec(line)) !== null) {
      const token = match[0];
      if (token.startsWith("sha512-") || token.startsWith("sha256-")) continue;
      if (token.length >= 24) {
        // If the token is a formatted base64 blob, distinguish binary assets and plain prose
        if (token.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(token)) {
          try {
            const plain = Buffer.from(token, "base64").toString("utf-8");
            const pr = printableRatio(plain);
            if (pr < 0.9) {
              // Ordinary binary asset (e.g. icon/font/wasm) - do not trip on binary entropy.
              // Only treat as binary asset if sufficiently large (>= 256 chars);
              // shorter tokens (24-255 chars) are keys/secrets/hashes, not embedded assets.
              if (token.length >= 256) {
                continue;
              }
            } else {
              // If it decodes to text, check decoded plain text entropy
              if (shannonEntropy(plain) > 4.5) {
                return true;
              }
              continue;
            }
          } catch (_) {}
        }

        const ent = shannonEntropy(token);
        if (ent > 4.5) {
          return true;
        }
      }
    }
  }
  return false;
}
