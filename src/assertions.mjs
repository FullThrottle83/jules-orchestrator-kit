import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { resolve, relative, join, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { checkAssetIntegrity } from "./asset-integrity.mjs";
import { checkRulesBudget } from "./rules-budget.mjs";

/**
 * Normalizes path to POSIX slashes.
 * @param {string} p
 * @returns {string}
 */
export function normalizePosix(p = "") {
  return p.split(sep).join("/").replace(/\\/g, "/");
}

/**
 * Formats byte count into human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes = 0) {
  if (!Number.isFinite(bytes) || bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = (bytes / Math.pow(1024, i)).toFixed(2);
  return `${val.replace(/\.00$/, "")} ${units[i]}`;
}

/**
 * Resolves byte limit from config options (maxBytes, maxKb, maxMb, maxGb).
 * @param {object} opts
 * @returns {number | null}
 */
export function resolveBytesLimit(opts = {}) {
  if (typeof opts.maxBytes === "number" && Number.isFinite(opts.maxBytes)) {
    return opts.maxBytes;
  }
  if (typeof opts.maxKb === "number" && Number.isFinite(opts.maxKb)) {
    return opts.maxKb * 1024;
  }
  if (typeof opts.maxMb === "number" && Number.isFinite(opts.maxMb)) {
    return opts.maxMb * 1024 * 1024;
  }
  if (typeof opts.maxGb === "number" && Number.isFinite(opts.maxGb)) {
    return opts.maxGb * 1024 * 1024 * 1024;
  }
  return null;
}

/**
 * Simple zero-dependency glob/pattern matcher supporting * and **.
 * @param {string} pathStr
 * @param {string} pattern
 * @returns {boolean}
 */
export function matchesGlob(pathStr, pattern) {
  if (!pattern || pattern === "*") return true;
  const normalizedPath = normalizePosix(pathStr).replace(/^\.\//, "");
  const normalizedPattern = normalizePosix(pattern).replace(/^\.\//, "");

  if (normalizedPath === normalizedPattern) return true;

  // Convert simple glob pattern to RegExp
  let regexStr = "^";
  let i = 0;
  while (i < normalizedPattern.length) {
    const c = normalizedPattern[i];
    if (c === "*" && normalizedPattern[i + 1] === "*") {
      if (normalizedPattern[i + 2] === "/") {
        regexStr += "(?:.*/)?";
        i += 3;
        continue;
      } else {
        regexStr += ".*";
        i += 2;
        continue;
      }
    } else if (c === "*") {
      regexStr += "[^/]*";
      i++;
    } else if (c === "?") {
      regexStr += "[^/]";
      i++;
    } else if (["\\", ".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]"].includes(c)) {
      regexStr += "\\" + c;
      i++;
    } else {
      regexStr += c;
      i++;
    }
  }
  regexStr += "$";

  try {
    const re = new RegExp(regexStr);
    return re.test(normalizedPath);
  } catch (_) {
    return normalizedPath.includes(normalizedPattern);
  }
}

/**
 * Asserts total byte size of a directory.
 */
export function assertDirSize(config = {}, root = process.cwd()) {
  const targetRel = config.path || config.dir || config.target || ".";
  const targetAbs = resolve(root, targetRel);
  const limitBytes = resolveBytesLimit(config);
  const useGzip = Boolean(config.gzip);

  if (!existsSync(targetAbs)) {
    return {
      ok: false,
      measuredBytes: 0,
      limitBytes,
      exceededBy: 0,
      fileCount: 0,
      gzip: useGzip,
      diagnostics: [`Target directory does not exist: '${targetRel}'`],
      metrics: { measuredBytes: 0, limitBytes, fileCount: 0, gzip: useGzip },
    };
  }

  const stat = statSync(targetAbs);
  if (!stat.isDirectory()) {
    return {
      ok: false,
      measuredBytes: 0,
      limitBytes,
      exceededBy: 0,
      fileCount: 0,
      gzip: useGzip,
      diagnostics: [`Path '${targetRel}' is a file, not a directory. Use 'assert:file-size' instead.`],
      metrics: { measuredBytes: 0, limitBytes, fileCount: 0, gzip: useGzip },
    };
  }

  const includes = Array.isArray(config.include) ? config.include : config.include ? [config.include] : [];
  const excludes = Array.isArray(config.exclude) ? config.exclude : config.exclude ? [config.exclude] : ["node_modules/**", ".git/**"];

  let totalBytes = 0;
  let fileCount = 0;

  function scan(currentDir) {
    let entries = [];
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch (_) {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const relToTarget = normalizePosix(relative(targetAbs, fullPath));
      const relToRoot = normalizePosix(relative(root, fullPath));

      if (entry.isDirectory()) {
        const isExcluded = excludes.some((pat) => matchesGlob(relToTarget, pat) || matchesGlob(relToRoot, pat) || entry.name === "node_modules" || entry.name === ".git");
        if (!isExcluded) {
          scan(fullPath);
        }
      } else if (entry.isFile()) {
        const isExcluded = excludes.some((pat) => matchesGlob(relToTarget, pat) || matchesGlob(relToRoot, pat));
        if (isExcluded) continue;

        if (includes.length > 0) {
          const isIncluded = includes.some((pat) => matchesGlob(relToTarget, pat) || matchesGlob(relToRoot, pat));
          if (!isIncluded) continue;
        }

        try {
          if (useGzip) {
            const buf = readFileSync(fullPath);
            const gzipped = gzipSync(buf);
            totalBytes += gzipped.length;
          } else {
            const fileStat = statSync(fullPath);
            totalBytes += fileStat.size;
          }
          fileCount++;
        } catch (_) {}
      }
    }
  }

  scan(targetAbs);

  const exceededBy = limitBytes !== null ? Math.max(0, totalBytes - limitBytes) : 0;
  const ok = limitBytes !== null ? totalBytes <= limitBytes : true;
  const diagnostics = [];

  if (!ok) {
    const formattedMeasured = formatBytes(totalBytes);
    const formattedLimit = formatBytes(limitBytes);
    const formattedExceeded = formatBytes(exceededBy);
    diagnostics.push(
      `Directory '${targetRel}' (${formattedMeasured}${useGzip ? " gzipped" : ""}) exceeds limit of ${formattedLimit} by ${formattedExceeded}.`
    );
  }

  return {
    ok,
    measuredBytes: totalBytes,
    limitBytes,
    exceededBy,
    fileCount,
    gzip: useGzip,
    diagnostics,
    metrics: {
      measuredBytes: totalBytes,
      limitBytes,
      exceededBy,
      fileCount,
      gzip: useGzip,
    },
  };
}

/**
 * Asserts size of a single file.
 */
export function assertFileSize(config = {}, root = process.cwd()) {
  const targetRel = config.path || config.file || config.target;
  if (!targetRel) {
    return {
      ok: false,
      measuredBytes: 0,
      limitBytes: null,
      exceededBy: 0,
      gzip: false,
      diagnostics: ["'assert:file-size' requires a 'path' or 'file' parameter."],
      metrics: { measuredBytes: 0, limitBytes: null },
    };
  }

  const targetAbs = resolve(root, targetRel);
  const limitBytes = resolveBytesLimit(config);
  const useGzip = Boolean(config.gzip);

  if (!existsSync(targetAbs)) {
    return {
      ok: false,
      measuredBytes: 0,
      limitBytes,
      exceededBy: 0,
      gzip: useGzip,
      diagnostics: [`Target file does not exist: '${targetRel}'`],
      metrics: { measuredBytes: 0, limitBytes, gzip: useGzip },
    };
  }

  let measuredBytes = 0;
  try {
    if (useGzip) {
      const buf = readFileSync(targetAbs);
      measuredBytes = gzipSync(buf).length;
    } else {
      measuredBytes = statSync(targetAbs).size;
    }
  } catch (err) {
    return {
      ok: false,
      measuredBytes: 0,
      limitBytes,
      exceededBy: 0,
      gzip: useGzip,
      diagnostics: [`Failed to read file '${targetRel}': ${err.message}`],
      metrics: { measuredBytes: 0, limitBytes, gzip: useGzip },
    };
  }

  const exceededBy = limitBytes !== null ? Math.max(0, measuredBytes - limitBytes) : 0;
  const ok = limitBytes !== null ? measuredBytes <= limitBytes : true;
  const diagnostics = [];

  if (!ok) {
    const formattedMeasured = formatBytes(measuredBytes);
    const formattedLimit = formatBytes(limitBytes);
    const formattedExceeded = formatBytes(exceededBy);
    diagnostics.push(
      `File '${targetRel}' (${formattedMeasured}${useGzip ? " gzipped" : ""}) exceeds limit of ${formattedLimit} by ${formattedExceeded}.`
    );
  }

  return {
    ok,
    measuredBytes,
    limitBytes,
    exceededBy,
    gzip: useGzip,
    diagnostics,
    metrics: {
      measuredBytes,
      limitBytes,
      exceededBy,
      gzip: useGzip,
    },
  };
}

/**
 * Asserts that files matching targets contain no forbidden patterns or banned terms.
 */
export function assertFilePatterns(config = {}, root = process.cwd()) {
  const targets = Array.isArray(config.targets)
    ? config.targets
    : Array.isArray(config.files)
    ? config.files
    : config.targets
    ? [config.targets]
    : config.files
    ? [config.files]
    : config.path
    ? [config.path]
    : ["src/**/*"];

  let patterns = [];
  if (Array.isArray(config.patterns)) {
    patterns.push(...config.patterns);
  }
  if (Array.isArray(config.forbiddenRegex)) {
    patterns.push(...config.forbiddenRegex);
  }
  if (Array.isArray(config.bannedWords)) {
    patterns.push(...config.bannedWords);
  }

  if (config.patternsFile) {
    const patFileAbs = resolve(root, config.patternsFile);
    if (existsSync(patFileAbs)) {
      try {
        const raw = readFileSync(patFileAbs, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          patterns.push(...parsed);
        } else if (parsed && Array.isArray(parsed.patterns)) {
          patterns.push(...parsed.patterns);
        }
      } catch (err) {
        return {
          ok: false,
          matchCount: 0,
          matches: [],
          diagnostics: [`Failed to parse patternsFile '${config.patternsFile}': ${err.message}`],
          metrics: { filesScanned: 0, matchCount: 0 },
        };
      }
    } else {
      return {
        ok: false,
        matchCount: 0,
        matches: [],
        diagnostics: [`patternsFile not found: '${config.patternsFile}'`],
        metrics: { filesScanned: 0, matchCount: 0 },
      };
    }
  }

  if (patterns.length === 0) {
    return {
      ok: true,
      matchCount: 0,
      matches: [],
      diagnostics: [],
      metrics: { filesScanned: 0, matchCount: 0 },
    };
  }

  const compiledPatterns = patterns.map((p) => {
    if (p instanceof RegExp) return { raw: p.source, re: p };
    const str = String(p);
    try {
      return { raw: str, re: new RegExp(str, "g") };
    } catch (_) {
      const escaped = str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return { raw: str, re: new RegExp(escaped, "g") };
    }
  });

  const candidateFiles = [];

  function collectFiles(dir) {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }

    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const fullPath = join(dir, entry.name);
      const relPath = normalizePosix(relative(root, fullPath));

      if (entry.isDirectory()) {
        collectFiles(fullPath);
      } else if (entry.isFile()) {
        const matchesAnyTarget = targets.some((tgt) => matchesGlob(relPath, tgt));
        if (matchesAnyTarget) {
          candidateFiles.push(relPath);
        }
      }
    }
  }

  collectFiles(root);

  const matches = [];

  for (const relFile of candidateFiles) {
    const absFile = resolve(root, relFile);
    let content = "";
    try {
      content = readFileSync(absFile, "utf-8");
    } catch (_) {
      continue;
    }

    const lines = content.split("\n");
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      for (const pat of compiledPatterns) {
        pat.re.lastIndex = 0;
        if (pat.re.test(line)) {
          matches.push({
            file: relFile,
            line: lineIdx + 1,
            pattern: pat.raw,
            snippet: line.trim().slice(0, 120),
          });
        }
      }
    }
  }

  const ok = matches.length === 0;
  const diagnostics = matches.map(
    (m) => `Forbidden pattern '${m.pattern}' found in ${m.file}:${m.line}: "${m.snippet}"`
  );

  return {
    ok,
    matchCount: matches.length,
    matches,
    diagnostics,
    metrics: {
      filesScanned: candidateFiles.length,
      matchCount: matches.length,
    },
  };
}

/**
 * Asserts file existence or absence.
 */
export function assertFileExists(config = {}, root = process.cwd()) {
  const targetRel = config.path || config.file || config.target;
  const mustExist = config.mustExist !== false && config.exists !== false;

  if (!targetRel) {
    return {
      ok: false,
      exists: false,
      diagnostics: ["'assert:exists' requires a 'path' parameter."],
      metrics: {},
    };
  }

  const targetAbs = resolve(root, targetRel);
  const exists = existsSync(targetAbs);
  const ok = mustExist ? exists : !exists;
  const diagnostics = [];

  if (!ok) {
    diagnostics.push(
      mustExist
        ? `Required file or directory '${targetRel}' does not exist.`
        : `Path '${targetRel}' exists but was asserted to not exist.`
    );
  }

  return {
    ok,
    exists,
    diagnostics,
    metrics: { path: targetRel, exists, mustExist },
  };
}

/**
 * Dispatches and executes an assertion primitive.
 */
export function runAssertion(stage = {}, root = process.cwd()) {
  const startTime = Date.now();
  const rawType = stage.assert || stage.type || stage.kind || "";
  const assertionType = String(rawType).toLowerCase().replace(/^assert:/, "").trim();

  let res;
  switch (assertionType) {
    case "dir-size":
    case "dir_size":
    case "directory-size":
      res = assertDirSize(stage, root);
      break;

    case "file-size":
    case "file_size":
      res = assertFileSize(stage, root);
      break;

    case "file-patterns":
    case "file_patterns":
    case "patterns":
    case "pattern":
    case "no-forbidden-terms":
    case "forbidden-patterns":
      res = assertFilePatterns(stage, root);
      break;

    case "asset-integrity":
    case "asset_integrity":
    case "assets": {
      const targetDir = stage.path || stage.dir || stage.searchDir || "public";
      const checkRes = checkAssetIntegrity(resolve(root, targetDir));
      const diag = (checkRes.corruptedFiles || []).map((f) => `Corrupted asset: ${f.path} (${f.reason})`);
      res = {
        ok: checkRes.ok,
        diagnostics: diag,
        metrics: { checkedCount: checkRes.checkedCount, corruptedCount: checkRes.corruptedFiles?.length || 0 },
      };
      break;
    }

    case "rules-budget":
    case "rules_budget": {
      const budgetRes = checkRulesBudget(root, stage);
      const diag = (budgetRes.violations || []).map((v) => `${v.path}: ${v.reason}`);
      res = {
        ok: budgetRes.ok,
        diagnostics: diag,
        metrics: { violationCount: budgetRes.violations?.length || 0 },
      };
      break;
    }

    case "exists":
    case "file-exists":
    case "not-exists": {
      const cfg = { ...stage, mustExist: assertionType !== "not-exists" };
      res = assertFileExists(cfg, root);
      break;
    }

    default:
      res = {
        ok: false,
        diagnostics: [`Unknown assertion primitive type: '${rawType}'`],
        metrics: {},
      };
  }

  const durationMs = Date.now() - startTime;
  const metrics = { ...(res.metrics || {}), durationMs };
  const ok = Boolean(res.ok);
  const status = ok ? 0 : 1;

  const stdout = ok ? `Assertion '${assertionType}' PASSED (${durationMs}ms)` : "";
  const stderr = !ok ? (res.diagnostics || []).join("\n") || `Assertion '${assertionType}' FAILED` : "";

  return {
    ok,
    status,
    assertionType,
    stdout,
    stderr,
    diagnostics: res.diagnostics || [],
    metrics,
  };
}
