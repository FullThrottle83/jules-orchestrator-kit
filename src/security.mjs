import { openSync, readFileSync, writeSync, fsyncSync, closeSync, renameSync, realpathSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { canonicalizePath, isWindowsAbsolutePath } from "./config.mjs";
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
/**
 * Matches one `/`-free glob segment against one `/`-free path segment.
 *
 * Only `*` (zero or more characters) and `?` (exactly one) are special; every
 * other character — including regex metacharacters like `(`, `+`, `.`, `[` —
 * is matched literally, preserving the escaping behaviour the old regex
 * translation had. A segment that is exactly `*` keeps its historical one-or-
 * more semantics, so `*` cannot match an empty segment.
 *
 * Implemented with the classic greedy-star wildcard algorithm rather than a
 * compiled regex: a segment like `*a*a*a*a*a*a*b` translated to
 * `^[^/]*a[^/]*a…$` and backtracked exponentially on a long run of `a`s, so
 * this path must never build a regex. The algorithm scans each character a
 * bounded number of times and cannot blow up the way the regex could.
 *
 * @param {string} str
 * @param {string} pattern
 * @param {boolean} [caseInsensitive]
 * @returns {boolean}
 */
function matchGlobSegment(str, pattern, caseInsensitive = false) {
  if (pattern === "*") return str.length > 0;

  let s = caseInsensitive ? str.toLowerCase() : str;
  let p = caseInsensitive ? pattern.toLowerCase() : pattern;

  let si = 0;
  let pi = 0;
  let star = -1;
  let matchIdx = 0;

  while (si < s.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === s[si])) {
      si++;
      pi++;
    } else if (pi < p.length && p[pi] === "*") {
      star = pi;
      matchIdx = si;
      pi++;
    } else if (star !== -1) {
      pi = star + 1;
      matchIdx++;
      si = matchIdx;
    } else {
      return false;
    }
  }

  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}

/**
 * Linear-time glob matcher over `/`-split segments.
 *
 * `**` matches zero or more whole segments; every other pattern segment
 * matches exactly one path segment via `matchGlobSegment`. This is a
 * bottom-up dynamic program with a rolling array: O(n·m) time and O(m) memory
 * for n path and m pattern segments, and it builds no regex at all.
 *
 * The previous implementation translated `**` into overlapping dot-star and
 * start-anchored `(?: … |^)` alternations (`SEC-01`). Anchored against `$`, a
 * pattern like `*a*a*a*a*a*a*a*a*b` or a chain of globstars caused catastrophic
 * backtracking — the match time grew exponentially with input length and a
 * hostile deny rule or file list could stall the dispatch gate. The DP
 * replaces every one of those constructs with a bounded scan.
 *
 * @param {string[]} pathSegs
 * @param {string[]} patSegs
 * @param {boolean} [caseInsensitive]
 * @returns {boolean}
 */
function matchGlobSegments(pathSegs, patSegs, caseInsensitive = false) {
  const n = pathSegs.length;
  const m = patSegs.length;

  // next[j] answers "does pathSegs[i+1..] match patSegs[j..]?". Seeded for the
  // empty-path row (i = n): only true when every remaining pattern segment is
  // `**`, since those are the only segments that can match zero path segments.
  let next = new Array(m + 1).fill(false);
  next[m] = true;
  for (let j = m - 1; j >= 0; j--) {
    next[j] = patSegs[j] === "**" && next[j + 1];
  }

  for (let i = n - 1; i >= 0; i--) {
    const cur = new Array(m + 1).fill(false);
    // cur[m] stays false: a path segment remains but the pattern is exhausted.
    for (let j = m - 1; j >= 0; j--) {
      if (patSegs[j] === "**") {
        // Consume this segment and keep `**` (next[j]), or match zero segments
        // and move on (cur[j + 1]).
        cur[j] = next[j] || cur[j + 1];
      } else if (matchGlobSegment(pathSegs[i], patSegs[j], caseInsensitive)) {
        cur[j] = next[j + 1];
      }
    }
    next = cur;
  }

  return next[0];
}

export function matchesGlob(filePath, globPattern, opts = {}) {
  if (!filePath || !globPattern) return false;
  const file = canonicalizePath(filePath);
  const pattern = canonicalizePath(globPattern);
  const caseInsensitive = Boolean(opts.caseInsensitive);

  if (caseInsensitive ? file.toLowerCase() === pattern.toLowerCase() : file === pattern) return true;

  return matchGlobSegments(file.split("/"), pattern.split("/"), caseInsensitive);
}

export function isForbiddenPath(filePath, config = {}) {
  const normFile = canonicalizePath(filePath);
  const forbidden = config.scope?.deny || config.forbidden_paths || [];
  return forbidden.some((pattern) => matchesGlob(normFile, pattern, { caseInsensitive: true }));
}

/**
 * The builtin deny patterns that exist to keep credentials out of a diff, and
 * the documented template filenames those patterns must not catch.
 *
 * The recursive dot-env glob is correct for `.env.local` and `.env.production`
 * and wrong for `.env.example` — a file nearly every repository commits
 * precisely so the environment can be documented without the values. Denying it
 * meant no agent could ever be asked to document a new variable, in any project.
 *
 * The exemption is deliberately narrow. It applies only when one of the two
 * *builtin* patterns matched: a repository that writes its own broader dot-env
 * deny rule blocks templates too, because the pattern string is not one of
 * these. And the diff secret scanner runs over every changed file regardless of
 * scope, so a real credential pasted into a template still fails on exit 6.
 */
const BUILTIN_ENV_DENY_PATTERNS = new Set(["**/.env", "**/.env.*"]);
export const ENV_TEMPLATE_BASENAMES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.dist",
  ".env.defaults",
]);

/**
 * True when a deny hit is the builtin credential rule catching a committed
 * environment *template* rather than an environment file.
 *
 * @param {string} file - canonicalised repo-relative path
 * @param {string} pattern - the deny pattern that matched
 * @returns {boolean}
 */
export function isEnvTemplateException(file, pattern) {
  if (!BUILTIN_ENV_DENY_PATTERNS.has(pattern)) return false;
  const name = basename(file).toLowerCase();
  if (ENV_TEMPLATE_BASENAMES.has(name)) return true;
  // `.env.production.example`, `.env.test.sample`, ... — the documented-template
  // suffix is what matters, not how many environment segments precede it.
  return /^\.env\..+\.(example|sample|template|dist|defaults)$/.test(name);
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
    // must not be silently pattern-matched against repo-relative rules. This
    // covers every spelling: POSIX absolute (`/etc/passwd`) and traversal
    // (`../`, `..`), Windows drive-qualified and drive-relative (`C:\...`,
    // `C:/...`, `C:foo`), and UNC (`\\server\share`, `//server/share`). The raw
    // spelling is checked as well as the canonical one, because canonicalisation
    // folds a leading `//` UNC into `/` and the check must fail on both.
    if (
      file === ".." ||
      file.startsWith("../") ||
      file.startsWith("/") ||
      isWindowsAbsolutePath(rawFile) ||
      isWindowsAbsolutePath(file)
    ) {
      violations.push({ file, reason: "Path escapes the repository root", rule: "deny", pattern: "<traversal>" });
      continue;
    }

    // Deny folds case: on macOS/Windows ".GitHub/" resolves to the same
    // directory as ".github/", so a case-sensitive deny is bypassable there.
    const matchedDeny = deny.find((pat) => matchesGlob(file, pat, { caseInsensitive: true }));
    if (matchedDeny && !isEnvTemplateException(file, matchedDeny)) {
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
  for (const [from, to] of CONFUSABLE_TO_ASCII) {
    out = out.split(from).join(to);
  }
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

// ---------------------------------------------------------------------------
// Statement-level expectation-rewrite detection (multi-line aware)
// ---------------------------------------------------------------------------
//
// The original pairing ran on physical lines. That caught
// `assert.equal(add(1, 2), 3);` becoming `assert.equal(add(1, 2), -1);`, but
// the same edit walked straight through the moment it was wrapped across
// lines — which every formatter does the day a line runs long, and which an
// agent doing an ordinary reformat does on its own:
//
//   -assert.equal(
//   -  add(1, 2),
//   -  3
//   -);
//   +assert.equal(
//   +  add(1, 2),
//   +  -1
//   +);
//
// The value lives on a line that carries no assertion keyword, so neither
// side ever paired, and the suite went from checking that addition works to
// certifying that it is broken. The statement, not the line, is the unit an
// agent rewrites, so the pairing now runs on reassembled statements: a run
// of physical lines joined while its delimiters are unbalanced, one of its
// strings or comments is still open, a Python line-continuation is pending,
// or the next line cannot start a statement of its own. The hunk's context
// lines belong to both images and are what make the reassembly possible;
// when they are absent (a zero-context diff) the only pair that can survive
// is the one where each image is a single fragment, and that pair is taken
// too, requiring a literal placeholder so a code change cannot masquerade as
// a value change.
//
// The pairing rule is unchanged in spirit: the two sides must be the *same*
// assertion — identical once every literal is blanked out — with different
// values. That does not distinguish an attack from a deliberate change of
// spec; nothing can, from a diff alone. This reports rather than decides,
// and `--allow-test-modifications` is the answer when the new expectation is
// the correct one.

// An assertion that states a *specific* expected value. Counting assertions
// alone let a test be gutted while looking untouched: swapping
// `assert.strictEqual(add(2,3), 5)` for `assert.ok(add(2,3) !== undefined)`
// removes one and adds one, so `removed > added` stayed false and the guard
// said nothing — while the suite stopped checking the answer.
//
// The `expect` argument span is a bounded lazy match rather than `[^)]*` so
// that a call split across lines with a nested call in its arguments
// (`expect(\n  formatInvoice(bill)\n).toBe(…`) still recognises the chain.
// The bound is a guess: an argument list longer than 240 characters is
// rarer than a missed chain.
const SPECIFIC_ASSERTION = new RegExp(
  [
    "\\bassert(?:\\.strict)?\\.?(?:strictEqual|deepStrictEqual|deepEqual|notStrictEqual|notDeepStrictEqual|equal|notEqual|match|doesNotMatch|throws|rejects|doesNotThrow)\\s*\\(",
    "\\bexpect\\s*\\([\\s\\S]{0,240}?\\)\\s*\\.(?:toBe|toEqual|toStrictEqual|toMatch|toMatchObject|toContain|toHaveBeenCalledWith|toThrow|toHaveLength|toBeCloseTo)\\s*\\(",
    "\\bassert\\.(?:equals|deepEquals|include|lengthOf)\\s*\\(",
    "assert_eq!|assert_ne!",
    "\\bt\\.(?:Errorf|Fatalf)\\s*\\(",
    "\\brequire\\.(?:Equal|NotEqual|Len|Contains|Error|NoError)\\s*\\(",
  ].join("|"),
  "i"
);
const isSpecificAssertion = (str) => SPECIFIC_ASSERTION.test(str);

/**
 * An assertion with every literal value replaced by a placeholder.
 *
 * Two lines that normalize to the same string are the same assertion about
 * the same expression; whatever differs between them is a value.
 *
 * The number form covers hex, octal, binary, underscores and exponents: the
 * original decimal-only regex never blanked `0xFF`, so an expectation
 * rewritten from `0xFF` to `0xFE` normalized to two *different* shapes and
 * the pair was never formed.
 */
const blankLiterals = (str) =>
  str
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, "\u0000S")
    // The sign belongs to the literal: without it `3` and `-1` normalized to
    // different shapes and the rewritten expectation was never paired.
    .replace(
      /(?<![\w$])(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|-?\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)/g,
      "\u0000N"
    )
    .replace(/\b(?:true|false|null|undefined|None|True|False|nil)\b/g, "\u0000B")
    // Whitespace is dropped, not collapsed: the shape is compared for
    // equality only, and a reformatted statement must normalize to the same
    // shape as the original — ` <N> );` and ` <N>);` are the same assertion.
    .replace(/\s+/g, "");

// The test languages the gate runs over. The scanner below is written for
// these four and nothing else; an unrecognised extension falls back to `js`,
// which is the strictest of the four for line joining.
const TEST_LANG_BY_EXT = new Map([
  [".js", "js"], [".mjs", "js"], [".cjs", "js"], [".jsx", "js"],
  [".ts", "js"], [".mts", "js"], [".cts", "js"], [".tsx", "js"],
  [".py", "python"], [".pyi", "python"],
  [".go", "go"],
  [".rs", "rust"],
]);

function langForTestFile(file) {
  const n = String(file || "").toLowerCase();
  const dot = n.lastIndexOf(".");
  if (dot === -1) return "js";
  return TEST_LANG_BY_EXT.get(n.slice(dot)) || "js";
}

function freshScanState() {
  // str: the open string, or null.
  //   q         the quote character
  //   tri       Python triple-quoted
  //   raw       raw string, no escapes (Go backtick)
  //   rawHashes Rust raw string r#"…"#: terminator is " plus that many #
  // block: depth of an open /* … */ (nested only in Rust)
  // accDelta: counted delimiters still open in the current statement
  // specialStack: counted depth recorded at each non-joining call (see below)
  return { str: null, block: 0, accDelta: 0, specialStack: [] };
}

// A call whose opening paren must not join lines: the test name is not the
// expectation. Without this, `it("old name", () => { expect(f()).toBe(3); })`
// would pair against its renamed copy, because a name is a string and so
// blanks to the same placeholder as any value change would. The closer of a
// non-joining paren is recognised by the depth it was opened at, so the
// running balance stays exact.
const NON_JOINING_CALL = /\b(?:it|test|describe|context)\s*\($|\bt\.Run\s*\($/;

/**
 * Scan one physical line of source.
 *
 * Returns { delta, trailingBackslash }. `delta` is the net number of
 * still-open ( [ { delimiters outside strings and comments; a statement
 * continues to the next physical line while it is positive, while a string
 * or block comment is open (tracked on `state`), or on a Python line
 * continuation.
 *
 * This is not a parser, and the approximations are deliberate: JS regex
 * literals are detected with a one-token look-behind (a `/` that cannot
 * follow an identifier, number, `)` or `]` starts one), template
 * interpolation is treated as opaque string content, and Rust lifetimes are
 * told apart from char literals by shape alone. `stripComments` below
 * walks the same constructs, so the two must stay in lock-step.
 */
function scanSourceLine(text, lang, state) {
  let delta = 0;
  let lastSig = "\n";
  const n = text.length;
  let i = 0;

  while (i < n) {
    const c = text[i];
    const c2 = i + 1 < n ? text[i + 1] : "";

    if (state.str) {
      const s = state.str;
      let closed = false;
      if (s.rawHashes !== undefined) {
        if (c === '"') {
          let j = i + 1;
          let h = 0;
          while (j < n && text[j] === "#") { h++; j++; }
          if (h >= s.rawHashes) { i = j; closed = true; }
        }
      } else if (s.raw) {
        closed = c === s.q;
      } else if (c === "\\") {
        i += s.tri ? 1 : 2;
        continue;
      } else if (c === s.q) {
        if (s.tri) {
          if (text[i + 1] === s.q && text[i + 2] === s.q) { i += 3; closed = true; }
          else { i += 1; }
        } else {
          i += 1;
          closed = true;
        }
      }
      if (closed) { state.str = null; lastSig = s.q; continue; }
      i += 1;
      continue;
    }

    if (state.block > 0) {
      if (c === "/" && c2 === "*") {
        if (lang === "rust") state.block += 1;
        i += 2;
        continue;
      }
      if (c === "*" && c2 === "/") {
        state.block -= 1;
        i += 2;
        lastSig = "/";
        continue;
      }
      i += 1;
      continue;
    }

    // A line comment ends the line.
    if (c === "/" && c2 === "/") break;
    if (lang === "python" && c === "#") break;

    if (c === "/" && c2 === "*") {
      state.block = 1;
      i += 2;
      continue;
    }

    // JS regex literal, best effort. Delimiters inside are not counted.
    if ((lang === "js" || lang === "ts") && c === "/" && !/[\w$)\]}]/.test(lastSig)) {
      i += 1;
      let inClass = false;
      while (i < n) {
        const rc = text[i];
        if (rc === "\\") { i += 2; continue; }
        if (rc === "[") inClass = true;
        else if (rc === "]") inClass = false;
        else if (rc === "/" && !inClass) { i += 1; break; }
        i += 1;
      }
      while (i < n && /[a-z]/i.test(text[i])) i += 1; // flags
      lastSig = "/";
      continue;
    }

    if (c === '"' || c === "'" || (lang === "go" && c === "`")) {
      if (lang === "python" && c2 === c && text[i + 2] === c) {
        state.str = { q: c, tri: true };
        i += 3;
      } else if (lang === "rust" && c === '"') {
        if (i > 0 && text[i - 1] === "r") {
          let j = i - 1;
          let h = 0;
          while (j >= 1 && text[j - 1] === "#") { h++; j--; }
          state.str = { q: '"', rawHashes: h };
          i += 1;
        } else {
          state.str = { q: c };
          i += 1;
        }
      } else if (lang === "rust" && c === "'") {
        // A char literal is 'X' or '\X' within four characters; anything
        // else starting with a quote is a lifetime and only the quote is
        // skipped, or the next line would see a string that never closed.
        if (c2 === "\\") {
          const end = text.indexOf("'", i + 2);
          if (end !== -1 && end - i <= 4) { i = end + 1; lastSig = "'"; continue; }
        } else if (text[i + 2] === "'" && c2 !== "'") {
          i += 3;
          lastSig = "'";
          continue;
        }
        i += 1;
        continue;
      } else {
        state.str = { q: c };
        i += 1;
      }
      lastSig = c;
      continue;
    }

    // A backslash on the very last character is a Python line continuation.
    if (c === "\\" && i + 1 === n) {
      return { delta, trailingBackslash: true };
    }

    if (c === "(") {
      // `before` ends with the paren itself; NON_JOINING_CALL matches on it.
      const before = text.slice(0, i + 1).replace(/\s+$/, "");
      if (NON_JOINING_CALL.test(before)) state.specialStack.push(state.accDelta);
      else { delta += 1; state.accDelta += 1; }
      lastSig = c;
      i += 1;
      continue;
    }
    if (c === "[") { delta += 1; state.accDelta += 1; lastSig = c; i += 1; continue; }
    if (c === "{") {
      // Go joins braces: the `if got != want { t.Errorf(…) }` block is the
      // idiomatic Go assertion, and the value lives on its first line. The
      // other three languages get no brace joining, so a rename of a test
      // inside a block cannot pair as a value change on its own.
      if (lang === "go") { delta += 1; state.accDelta += 1; }
      lastSig = c;
      i += 1;
      continue;
    }
    if (c === ")") {
      const top = state.specialStack[state.specialStack.length - 1];
      if (top === state.accDelta) state.specialStack.pop();
      else { delta -= 1; state.accDelta -= 1; }
      lastSig = c;
      i += 1;
      continue;
    }
    if (c === "]") { delta -= 1; state.accDelta -= 1; lastSig = c; i += 1; continue; }
    if (c === "}") {
      if (lang === "go") { delta -= 1; state.accDelta -= 1; }
      lastSig = c;
      i += 1;
      continue;
    }

    if (!/\s/.test(c)) lastSig = c;
    i += 1;
  }

  return { delta, trailingBackslash: false };
}

/**
 * The same source with every comment blanked out, strings and line
 * structure untouched. Shapes and keywords are computed on this text so a
 * commented-out `expect(…)` cannot make a block an assertion, and a number
 * changed inside a comment cannot pair as a value change.
 */
function stripComments(text, lang) {
  const state = freshScanState();
  return text.split("\n").map((line) => {
    let out = "";
    let pending = 0;
    const copyCode = (to) => {
      out += line.slice(pending, to);
      pending = to;
    };
    let i = 0;
    const n = line.length;

    while (i < n) {
      const c = line[i];
      const c2 = i + 1 < n ? line[i + 1] : "";

      if (state.block > 0) {
        if (c === "/" && c2 === "*") {
          if (lang === "rust") state.block += 1;
          i += 2;
          continue;
        }
        if (c === "*" && c2 === "/") {
          state.block -= 1;
          i += 2;
          if (state.block === 0) pending = i;
          continue;
        }
        i += 1;
        continue;
      }

      if (state.str) {
        const s = state.str;
        let closed = false;
        if (s.rawHashes !== undefined) {
          if (c === '"') {
            let j = i + 1;
            let h = 0;
            while (j < n && line[j] === "#") { h++; j++; }
            if (h >= s.rawHashes) { i = j; closed = true; }
          }
        } else if (s.raw) {
          closed = c === s.q;
        } else if (c === "\\") {
          i += s.tri ? 1 : 2;
          continue;
        } else if (c === s.q) {
          if (s.tri) {
            if (line[i + 1] === s.q && line[i + 2] === s.q) { i += 3; closed = true; }
            else { i += 1; }
          } else {
            i += 1;
            closed = true;
          }
        }
        if (closed) {
          state.str = null;
          copyCode(i);
          continue;
        }
        i += 1;
        continue;
      }

      if (c === "/" && c2 === "/") { copyCode(i); break; }
      if (lang === "python" && c === "#") { copyCode(i); break; }
      if (c === "/" && c2 === "*") {
        copyCode(i);
        state.block = 1;
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || (lang === "go" && c === "`")) {
        copyCode(i);
        if (lang === "python" && c2 === c && line[i + 2] === c) {
          state.str = { q: c, tri: true };
          i += 3;
        } else if (lang === "rust" && c === '"') {
          if (i > 0 && line[i - 1] === "r") {
            let j = i - 1;
            let h = 0;
            while (j >= 1 && line[j - 1] === "#") { h++; j--; }
            state.str = { q: '"', rawHashes: h };
            i += 1;
          } else {
            state.str = { q: c };
            i += 1;
          }
        } else if (lang === "rust" && c === "'") {
          if (c2 === "\\") {
            const end = line.indexOf("'", i + 2);
            if (end !== -1 && end - i <= 4) { i = end + 1; copyCode(i); continue; }
          } else if (line[i + 2] === "'" && c2 !== "'") {
            i += 3;
            copyCode(i);
            continue;
          }
          i += 1;
          copyCode(i);
          continue;
        } else {
          state.str = { q: c };
          i += 1;
        }
        continue;
      }
      i += 1;
    }
    copyCode(n);
    return out;
  }).join("\n");
}

// A line that cannot start a statement of its own continues the previous
// statement: a closing delimiter, a member-access, or an operator.
const CONTINUATION_START = /^[)\],.]/;
const CONTINUATION_OP_START = /^[+\-*/%<>=&|^:]/;

// A scanner miscount (an unbalanced delimiter inside a regex literal is the
// usual cause) must not be able to merge a whole file into one statement,
// which would pair *any* literal change anywhere in the file.
const MAX_STATEMENT_LINES = 100;
const MAX_STATEMENT_CHARS = 12000;

/**
 * Reassemble physical lines into statements.
 *
 * `sliceLines` is one image of a hunk in file order: context lines plus the
 * removed (or added) lines. Context lines are ordinary file text; a
 * statement spans them freely, which is exactly what makes a value edit
 * inside a formatter-wrapped assertion visible to the pairing.
 *
 * @param {Array<{ kind: string, text: string, oldNo: number|null, newNo: number|null }>} sliceLines
 * @param {string} lang
 * @returns {Array<{ text: string, firstOld: number|null, lastOld: number|null, firstNew: number|null, lastNew: number|null, removedLines: Array, addedLines: Array }>}
 */
function assembleStatements(sliceLines, lang) {
  const stmts = [];
  let cur = null;

  const flush = () => {
    if (!cur) return;
    stmts.push({
      text: cur.lines.join("\n"),
      firstOld: cur.firstOld,
      lastOld: cur.lastOld,
      firstNew: cur.firstNew,
      lastNew: cur.lastNew,
      removedLines: cur.removedLines,
      addedLines: cur.addedLines,
    });
    cur = null;
  };

  for (const L of sliceLines) {
    const trimmed = L.text.replace(/^\s+/, "");
    const joins =
      cur !== null &&
      (cur.delta > 0 ||
        cur.state.str !== null ||
        cur.state.block > 0 ||
        cur.trailingBackslash ||
        CONTINUATION_START.test(trimmed) ||
        CONTINUATION_OP_START.test(trimmed));

    if (
      joins &&
      cur.lines.length < MAX_STATEMENT_LINES &&
      cur.chars + L.text.length + 1 <= MAX_STATEMENT_CHARS
    ) {
      cur.lines.push(L.text);
      cur.chars += L.text.length + 1;
      const sc = scanSourceLine(L.text, lang, cur.state);
      cur.delta += sc.delta;
      cur.trailingBackslash = sc.trailingBackslash;
      cur.lastOld = L.oldNo;
      cur.lastNew = L.newNo;
      if (L.kind === "-") cur.removedLines.push(L);
      else if (L.kind === "+") cur.addedLines.push(L);
    } else {
      flush();
      const st = freshScanState();
      const sc = scanSourceLine(L.text, lang, st);
      cur = {
        lines: [L.text],
        chars: L.text.length,
        firstOld: L.oldNo,
        lastOld: L.oldNo,
        firstNew: L.newNo,
        lastNew: L.newNo,
        delta: sc.delta,
        state: st,
        trailingBackslash: sc.trailingBackslash,
        removedLines: L.kind === "-" ? [L] : [],
        addedLines: L.kind === "+" ? [L] : [],
      };
    }
  }
  flush();
  return stmts;
}

const hasLiteralPlaceholder = (shape) =>
  shape.includes("\u0000S") || shape.includes("\u0000N") || shape.includes("\u0000B");

const collapseWhitespace = (s) => s.replace(/\s+/g, " ").trim();
const shorten = (s) => (s.length > 160 ? `${s.slice(0, 157)}…` : s);

/**
 * Pair rewritten expectations across the removed and added images of every
 * hunk of one file, and report each pair.
 *
 * A statement is only a candidate when it actually contains a removed
 * (resp. added) line: a context-only statement is unchanged text on both
 * sides, and letting it pair would flag a genuinely new assertion that
 * merely has the same shape as one that stayed put.
 *
 * @param {string} file
 * @param {Array<{ lines: Array }>} hunks
 * @param {object} stats - per-file stats; the paired physical lines are
 *   spliced out of the count pools so the count-based checks below do not
 *   report the same edit a second time.
 * @param {Array} violations
 * @returns {Array<{ r: object, a: object }>} the pairs, for the caller
 */
function detectExpectationRewrites(file, hunks, stats, violations) {
  const lang = langForTestFile(file);
  const allPairs = [];

  for (const hunk of hunks) {
    const oldSlice = [];
    const newSlice = [];
    for (const L of hunk.lines) {
      if (L.kind !== "+") oldSlice.push(L);
      if (L.kind !== "-") newSlice.push(L);
    }
    const oldStmts = assembleStatements(oldSlice, lang);
    const newStmts = assembleStatements(newSlice, lang);

    // Candidate statements in file order, per image.
    const oldCands = [];
    for (const s of oldStmts) {
      if (s.removedLines.length === 0) continue;
      const clean = stripComments(s.text, lang);
      if (!isSpecificAssertion(clean)) continue;
      oldCands.push({ s, shape: blankLiterals(clean), canon: clean.replace(/\s+/g, "") });
    }
    const newCands = [];
    for (const s of newStmts) {
      if (s.addedLines.length === 0) continue;
      const clean = stripComments(s.text, lang);
      if (!isSpecificAssertion(clean)) continue;
      newCands.push({ s, shape: blankLiterals(clean), canon: clean.replace(/\s+/g, "") });
    }

    // The t-th removed candidate of a shape pairs with the t-th added
    // candidate of the same shape. Position alignment is what keeps a
    // formatter run over a block of same-shape assertions silent: a greedy
    // "first different text" pairing would match a re-indented
    // `assert.equal(f(0), 0)` against its neighbour's value and report a
    // rewrite that did not happen. It also keeps the pairing linear in the
    // number of statements, which a 4000-line same-shape table would not
    // survive as a square of comparisons.
    const oldByShape = new Map();
    const newByShape = new Map();
    for (const c of oldCands) {
      let arr = oldByShape.get(c.shape);
      if (!arr) arr = oldByShape.set(c.shape, []).get(c.shape);
      arr.push(c);
    }
    for (const c of newCands) {
      let arr = newByShape.get(c.shape);
      if (!arr) arr = newByShape.set(c.shape, []).get(c.shape);
      arr.push(c);
    }

    const pairs = [];
    for (const [shape, olds] of oldByShape) {
      const news = newByShape.get(shape) || [];
      const k = Math.min(olds.length, news.length);
      for (let t = 0; t < k; t++) {
        if (olds[t].canon !== news[t].canon) {
          pairs.push({ r: olds[t].s, a: news[t].s });
        }
      }
    }

    // Zero-context hunk: each image is a single fragment and the assertion
    // keyword may sit outside the hunk entirely. The fragment pair is taken
    // only when both sides normalize to the same shape *and* that shape
    // holds a literal — a code change cannot fake it.
    if (pairs.length === 0 && oldStmts.length === 1 && newStmts.length === 1) {
      const r = oldStmts[0];
      const a = newStmts[0];
      if (r.removedLines.length > 0 && a.addedLines.length > 0) {
        const sr = blankLiterals(stripComments(r.text, lang));
        const sa = blankLiterals(stripComments(a.text, lang));
        if (sr === sa && hasLiteralPlaceholder(sr)) {
          const cr = stripComments(r.text, lang).replace(/\s+/g, "");
          const ca = stripComments(a.text, lang).replace(/\s+/g, "");
          if (cr !== ca) pairs.push({ r, a });
        }
      }
    }

    for (const p of pairs) {
      allPairs.push(p);
      const addedNo = p.a.addedLines.length > 0 ? p.a.addedLines[0].newNo : (p.r.removedLines[0] ? p.r.removedLines[0].oldNo : null);
      violations.push({
        file,
        line: addedNo,
        type: "ASSERTION_EXPECTATION_CHANGED",
        reason:
          `Test Tamper Guard: Expected value rewritten in ${file}${addedNo ? `:${addedNo}` : ""} — ` +
          `"${shorten(collapseWhitespace(p.r.text))}" became "${shorten(collapseWhitespace(p.a.text))}". ` +
          `A deliberately changed spec looks identical to a test bent to match broken ` +
          `output, and a diff alone cannot tell the two apart, so this is flagged for ` +
          `review rather than assumed. If the new expectation is correct, re-run with ` +
          `--allow-test-modifications (which also silences the skip, vacuous, removal ` +
          `and weakening checks for this diff).`,
      });

      // Both sides are accounted for here, so they must not also feed the
      // count-based checks below — the same line reported twice under two
      // names tells the operator nothing extra. Consumption is symmetric so
      // a statement that absorbed two old assertion lines but only one new
      // one still leaves the surplus to the removal check.
      const removedMatches = p.r.removedLines.filter(
        (L) => stats.removed.some((e) => e.line === L.oldNo && e.text === L.text)
      );
      const addedMatches = p.a.addedLines.filter(
        (L) => stats.addedTexts.some((e) => e.line === L.newNo && e.text === L.text)
      );
      const take = Math.min(removedMatches.length, addedMatches.length);
      for (let k = 0; k < take; k++) {
        const L = removedMatches[k];
        const idx = stats.removed.findIndex((e) => e.line === L.oldNo && e.text === L.text);
        if (idx === -1) continue;
        const entry = stats.removed.splice(idx, 1)[0];
        const rsIdx = stats.removedSpecific.indexOf(entry);
        if (rsIdx !== -1) {
          stats.removedSpecific.splice(rsIdx, 1);
          stats.addedSpecific--;
        }
        stats.added--;
      }
    }
  }

  return allPairs;
}

/**
 * Detects test file assertion tampering, weakening, or test skips.
 *
 * @param {string} diffOrText - Unified git diff
 * @param {Object} [options]
 * @param {boolean} [options.allowTestModifications=false]
 * @returns {{ ok: boolean, violations: Array<{ file: string, type: string, line?: number, reason: string }> }}
 */
export function checkTestTampering(diffOrText = "", options = {}) {
  if (!diffOrText || typeof diffOrText !== "string") return { ok: true, violations: [] };
  if (options.allowTestModifications === true) return { ok: true, violations: [] };

  const violations = [];
  const lines = diffOrText.split("\n");
  let lastOldFile = null;
  let currentFile = null;
  let currentOldLineNo = null;
  let currentNewLineNo = null;

  const isTestFile = (f) => {
    if (!f) return false;
    const n = f.replace(/\\/g, "/").toLowerCase();
    return (
      n.includes(".test.") ||
      n.includes(".spec.") ||
      n.includes("_test.") ||
      n.includes("/test/") ||
      n.includes("/tests/") ||
      n.includes("/__tests__/")
    );
  };

  const SKIP_INJECTIONS = [
    { pattern: /\b(?:it|test|describe|context)\.skip\s*\(/i, desc: "Injected test skip (.skip())" },
    { pattern: /\b(?:xit|xtest|xdescribe)\s*\(/i, desc: "Injected disabled test (xit/xtest/xdescribe)" },
    { pattern: /@pytest\.mark\.skip/i, desc: "Injected Pytest skip decorator (@pytest.mark.skip)" },
    { pattern: /\bt\.Skip\s*\(/i, desc: "Injected Go test skip (t.Skip())" },
    { pattern: /#\[ignore\]/i, desc: "Injected Rust test ignore attribute (#[ignore])" },
    { pattern: /\/\/\s*@ts-ignore/i, desc: "Injected TypeScript ignore comment (// @ts-ignore)" },
    { pattern: /\/\/\s*@ts-nocheck/i, desc: "Injected TypeScript nocheck directive (// @ts-nocheck)" },
  ];

  const COMMENTED_ASSERTION = /^\+\s*(?:\/\/|\/\*)\s*(?:expect\(|assert\.|assert\(|t\.expect|t\.assert)/i;

  const VACUOUS_ASSERTIONS = [
    { pattern: /\bassert(?:\.ok)?\s*\(\s*true\s*(?:,[^)]*)?\)/i, desc: "Vacuous truth assertion (assert.ok(true))" },
    { pattern: /\bassert\.(?:strictEqual|deepStrictEqual|equal|deepEqual)\s*\(\s*([^,]+?)\s*,\s*\1\s*(?:,[^)]*)?\)/i, desc: "Vacuous identity assertion (assert.equal(X, X))" },
    { pattern: /\bexpect\s*\(\s*true\s*\)\s*\.(?:toBe|toEqual)\s*\(\s*true\s*\)/i, desc: "Vacuous truth expectation (expect(true).toBe(true))" },
    { pattern: /\bexpect\s*\(\s*([^)]+?)\s*\)\s*\.(?:toBe|toEqual)\s*\(\s*\1\s*\)/i, desc: "Vacuous identity expectation (expect(X).toBe(X))" },
    { pattern: /\bexpect\s*\(\s*true\s*\)\s*\.toBeTruthy\s*\(/i, desc: "Vacuous truth expectation (expect(true).toBeTruthy())" },
    { pattern: /\bexpect\s*\(\s*false\s*\)\s*\.toBeFalsy\s*\(/i, desc: "Vacuous falsity expectation (expect(false).toBeFalsy())" },
    { pattern: /\bassert\.(?:isTrue|isOk)\s*\(\s*true\s*(?:,[^)]*)?\)/i, desc: "Vacuous truth assertion (assert.isTrue(true))" },
    { pattern: /\bassert\.(?:isFalse|isNotOk)\s*\(\s*false\s*(?:,[^)]*)?\)/i, desc: "Vacuous falsity assertion (assert.isFalse(false))" },
  ];

  const ASSERTION_PATTERN = /(?:\b(?:assert(?:\.[a-zA-Z0-9_$]+)?|expect|t\.(?:assert|expect|is|equal|true|false|Errorf|Fatalf)|require\.[a-zA-Z0-9_$]+)\b|assert!|assert_eq!|assert_ne!)/i;
  const isCommentLine = (str) => /^\s*(?:\/\/|\/\*|\*|#|--|;)/.test(str);

  const fileAssertions = new Map();
  let pendingHunk = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if ((line.startsWith("--- ") || line.startsWith("--- a/")) && !line.startsWith("----")) {
      const orig = line.slice(3).split("\t")[0].trim().replace(/^a\//, "");
      lastOldFile = orig && orig !== "/dev/null" ? orig : null;
      continue;
    }

    if ((line.startsWith("+++ ") || line.startsWith("+++ b/") || line.startsWith("+++ /dev/null")) && !line.startsWith("++++")) {
      const target = line.slice(3).split("\t")[0].trim().replace(/^b\//, "");
      currentFile = target && target !== "/dev/null" ? target : lastOldFile;
      currentOldLineNo = null;
      currentNewLineNo = null;
      pendingHunk = false;
      continue;
    }

    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (hunkMatch) {
      currentOldLineNo = Number(hunkMatch[1]);
      currentNewLineNo = Number(hunkMatch[2]);
      pendingHunk = true;
      continue;
    }

    if (!currentFile || !isTestFile(currentFile)) {
      pendingHunk = false;
      continue;
    }

    if (!fileAssertions.has(currentFile)) {
      fileAssertions.set(currentFile, { removed: [], added: 0, addedTexts: [], removedSpecific: [], addedSpecific: 0, hunks: [] });
    }
    const fileStats = fileAssertions.get(currentFile);
    if (pendingHunk) {
      fileStats.hunks.push({ lines: [] });
      pendingHunk = false;
    }
    const hunk = fileStats.hunks.length > 0 ? fileStats.hunks[fileStats.hunks.length - 1] : null;

    if (line.startsWith("-") && !line.startsWith("---")) {
      const deletedText = line.slice(1);
      if (hunk) hunk.lines.push({ kind: "-", text: deletedText, oldNo: currentOldLineNo, newNo: null });
      if (!isCommentLine(deletedText) && ASSERTION_PATTERN.test(deletedText)) {
        fileStats.removed.push({ line: currentOldLineNo, text: deletedText });
        if (isSpecificAssertion(deletedText)) {
          fileStats.removedSpecific.push({ line: currentOldLineNo, text: deletedText });
        }
      }
      if (currentOldLineNo !== null) currentOldLineNo++;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      const addedText = line.slice(1);
      if (hunk) hunk.lines.push({ kind: "+", text: addedText, oldNo: null, newNo: currentNewLineNo });
      let isVacuous = false;

      // Check skip injections
      for (const skipRule of SKIP_INJECTIONS) {
        if (skipRule.pattern.test(addedText)) {
          violations.push({
            file: currentFile,
            line: currentNewLineNo,
            type: "TEST_SKIP_INJECTION",
            reason: `Test Tamper Guard: ${skipRule.desc} found in ${currentFile}${currentNewLineNo ? `:${currentNewLineNo}` : ""}`,
          });
        }
      }

      // Check vacuous assertions
      for (const vacuousRule of VACUOUS_ASSERTIONS) {
        if (vacuousRule.pattern.test(addedText)) {
          isVacuous = true;
          violations.push({
            file: currentFile,
            line: currentNewLineNo,
            type: "VACUOUS_ASSERTION",
            reason: `Test Tamper Guard: ${vacuousRule.desc} detected in ${currentFile}${currentNewLineNo ? `:${currentNewLineNo}` : ""}`,
          });
        }
      }

      // Check commented-out assertions
      let isCommented = false;
      if (COMMENTED_ASSERTION.test(line)) {
        isCommented = true;
        violations.push({
          file: currentFile,
          line: currentNewLineNo,
          type: "COMMENTED_ASSERTION",
          reason: `Test Tamper Guard: Commented-out test assertion detected in ${currentFile}${currentNewLineNo ? `:${currentNewLineNo}` : ""}`,
        });
      }

      // If valid non-vacuous, non-commented assertion is added, increment added count
      if (!isVacuous && !isCommented && !isCommentLine(addedText) && ASSERTION_PATTERN.test(addedText)) {
        fileStats.added++;
        fileStats.addedTexts.push({ line: currentNewLineNo, text: addedText });
        if (isSpecificAssertion(addedText)) fileStats.addedSpecific++;
      }

      if (currentNewLineNo !== null) currentNewLineNo++;
    } else if (!line.startsWith("\\")) {
      // Context line. It is file text in both images, so the statement
      // assembler needs it to reassemble assertions that span a changed
      // line; `diff --git`/`index` lines that sneak in here are not
      // diff body and are not collected.
      if (hunk && (line.startsWith(" ") || line === "")) {
        hunk.lines.push({ kind: " ", text: line.slice(1), oldNo: currentOldLineNo, newNo: currentNewLineNo });
      }
      if (currentOldLineNo !== null) currentOldLineNo++;
      if (currentNewLineNo !== null) currentNewLineNo++;
    }
  }

  for (const [file, stats] of fileAssertions.entries()) {
    // An expectation that was rewritten rather than removed.
    //
    // Counting assertions cannot see this one: `assert.equal(add(1,2), 3)`
    // becoming `assert.equal(add(1,2), -1)` takes one specific assertion out
    // and puts one specific assertion back, so every total stayed level and
    // the guard said nothing — while the suite went from checking that
    // addition works to certifying that it is broken. It is the single
    // cheapest way to make a red suite green, and the one this tool exists
    // to refuse. The line-based version of this pairing could only see the
    // single-line spelling of the edit; the reassembled-statement version
    // above sees every spelling, and explains why on the way.
    detectExpectationRewrites(file, stats.hunks, stats, violations);

    if (stats.removed.length > stats.added) {
      const unreplaced = stats.removed.slice(stats.added);
      for (const item of unreplaced) {
        violations.push({
          file,
          line: item.line,
          type: "ASSERTION_REMOVAL",
          reason: `Test Tamper Guard: Assertion removed without replacement in ${file}${item.line ? `:${item.line}` : ""}: "${item.text.trim()}"`,
        });
      }
    }

    // Replacing an assertion is not the same as keeping one. Counting totals
    // let a specific expectation be swapped for a vague one at no cost — one
    // out, one in, guard silent, suite no longer checking the answer. What must
    // not fall is the number of assertions that name an expected value.
    //
    // Only the *replaced* ones are reported here. An assertion deleted outright
    // is already an ASSERTION_REMOVAL above, and emitting both would report the
    // same line twice under two names.
    const alreadyReportedSpecific = stats.removed
      .slice(stats.added)
      .filter((item) => isSpecificAssertion(item.text)).length;
    const specificLost = Math.max(0, stats.removedSpecific.length - stats.addedSpecific);
    const weakenedCount = Math.max(0, specificLost - alreadyReportedSpecific);

    if (weakenedCount > 0) {
      for (const item of stats.removedSpecific.slice(stats.addedSpecific, stats.addedSpecific + weakenedCount)) {
        violations.push({
          file,
          line: item.line,
          type: "ASSERTION_WEAKENED",
          reason: `Test Tamper Guard: Assertion weakened in ${file}${item.line ? `:${item.line}` : ""} — an assertion naming an expected value was replaced by one that does not: "${item.text.trim()}"`,
        });
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}

export function scanDiff(diffTextStr = "", options = {}) {
  if (!diffTextStr) return { ok: true, findings: [] };

  const segments = splitDiffByFile(diffTextStr);
  const findings = [];

  for (const segment of segments) {
    const hit = classifyAddedLines(segment.lines.map((l) => l.text).join("\n"), segment.file);
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

  return {
    ok: secretsOk && edgeRes.ok && crossPkgRes.ok && tamperingRes.ok,
    findings,
  };
}

