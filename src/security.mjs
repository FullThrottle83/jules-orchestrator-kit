import { normalizePath } from "./config.mjs";

export const HIGH_CONFIDENCE_PATTERNS = [
  /\bghp_[A-Za-z0-9_]{36,255}\b/g,
  /\bgho_[A-Za-z0-9_]{36,255}\b/g,
  /\bghu_[A-Za-z0-9_]{36,255}\b/g,
  /\bghs_[A-Za-z0-9_]{36,255}\b/g,
  /\bghr_[A-Za-z0-9_]{36,255}\b/g,

  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\baws_secret_access_key\s*=\s*['"]?[A-Za-z0-9\/+=]{40}['"]?/g,

  /-----BEGIN\s+(?:RSA|DSA|EC|OPENSSH|PRIVATE)\s+KEY-----[\s\S]*?-----END\s+(?:RSA|DSA|EC|OPENSSH|PRIVATE)\s+KEY-----/g,
  /PuTTY-User-Key-File-[0-9]:[^\n]+/g,

  /\bsk_live_[0-9a-zA-Z]{24,99}\b/g,
  /\brk_live_[0-9a-zA-Z]{24,99}\b/g,
  /\bnpm_[0-9a-zA-Z]{36}\b/g,
  /\bglpat-[0-9a-zA-Z_-]{20,}\b/g,
  /\bGOCSPX-[0-9a-zA-Z_-]{28}\b/g,

  /\bAIzaSy[A-Za-z0-9_-]{33}\b/g,

  /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9_]+/g,

  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

export const LOW_CONFIDENCE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/-]{10,}/gi,
  /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bsk_test_[0-9a-zA-Z]{24,99}\b/g,
  /(?:api[_-]?key|secret|password|passwd|token|auth[_-]?token)\s*[:=]\s*['"]([^'"]{8,128})['"]/gi,
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

export function matchesGlob(filePath, globPattern) {
  if (!filePath || !globPattern) return false;
  const file = normalizePath(filePath);
  const pattern = normalizePath(globPattern);

  if (file === pattern) return true;

  const parts = pattern.split("/");
  const regexParts = parts.map((part) => {
    if (part === "**") return "___GLOBSTAR___";
    if (part === "*") return "[^/]+";
    return part.replace(/\./g, "\\.").replace(/\*/g, "[^/]*").replace(/\?/g, ".");
  });

  let regexStr = regexParts.join("/");
  regexStr = regexStr
    .replace(/^___GLOBSTAR___\//g, "(?:.*/|^)")
    .replace(/\/___GLOBSTAR___$/g, "(?:/.*|$)")
    .replace(/\/___GLOBSTAR___\//g, "(?:/|/.+/|/)")
    .replace(/___GLOBSTAR___/g, ".*");

  try {
    return new RegExp(`^${regexStr}$`).test(file);
  } catch (_) {
    return false;
  }
}

export function isForbiddenPath(filePath, config = {}) {
  const normFile = normalizePath(filePath);
  const forbidden = config.scope?.deny || config.forbidden_paths || [];
  const allowed = config.scope?.allow || config.allow_paths || [];

  for (const pattern of forbidden) {
    if (matchesGlob(normFile, pattern)) {
      return true;
    }
  }

  return false;
}

export function checkScope(files = [], scope = {}, opts = {}) {
  const violations = [];
  const deny = scope.deny || [];
  const allow = scope.allow || [];
  const protect = scope.protect || [];

  for (const rawFile of files) {
    const file = normalizePath(rawFile);

    const isExplicitlyAllowed = allow.some((pat) => matchesGlob(file, pat));
    if (isExplicitlyAllowed) continue;

    const isDenied = deny.some((pat) => matchesGlob(file, pat));
    if (isDenied) {
      violations.push({ file, reason: "Forbidden path restriction", rule: "deny" });
      continue;
    }

    if (!opts.allowProtected) {
      const isProtected = protect.some((pat) => matchesGlob(file, pat));
      if (isProtected) {
        violations.push({ file, reason: "Command-defining / agent rules file modification restriction", rule: "protect" });
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}

export function scanDiff(diffTextStr = "") {
  if (!diffTextStr) return { ok: true, findings: [] };
  const addedLines = diffTextStr
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");

  const hasHigh = hasHighConfidenceSecret(addedLines);
  const findings = [];
  if (hasHigh) {
    findings.push({ severity: "CRITICAL", type: "HIGH_CONFIDENCE_SECRET", description: "High-confidence secret detected in added diff lines" });
  }

  return {
    ok: !hasHigh,
    findings,
  };
}
