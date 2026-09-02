import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { resolveVerify } from "./config.mjs";

/**
 * Checks if a file path should be excluded from diff coverage enforcement.
 * Excludes test files, configs, documentation, and agent rules.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isExcludedFromCoverage(filePath = "") {
  if (!filePath) return true;
  const norm = filePath.replace(/\\/g, "/").toLowerCase();
  if (
    norm.startsWith(".agent/") ||
    norm.startsWith(".github/") ||
    norm.startsWith(".git/") ||
    norm.startsWith("test/") ||
    norm.startsWith("tests/") ||
    norm.includes("/__tests__/") ||
    norm.includes(".test.") ||
    norm.includes(".spec.") ||
    norm.includes("_test.") ||
    norm.endsWith(".md") ||
    norm.endsWith(".json") ||
    norm.endsWith(".yml") ||
    norm.endsWith(".yaml") ||
    norm.endsWith(".lock")
  ) {
    return true;
  }
  return false;
}

/**
 * Maps V8 function range offsets to 1-indexed line hit counts.
 * @param {string} sourceContent - Full text of source file
 * @param {Array<object>} v8Functions - Functions array from V8 coverage JSON
 * @returns {Map<number, number>} Map of lineNo -> hitCount
 */
export function mapV8RangesToLines(sourceContent = "", v8Functions = []) {
  if (!sourceContent || !Array.isArray(v8Functions) || v8Functions.length === 0) {
    return new Map();
  }

  const lines = sourceContent.split("\n");
  const lineRanges = [];
  let currentOffset = 0;
  for (let i = 0; i < lines.length; i++) {
    const start = currentOffset;
    const end = currentOffset + lines[i].length;
    lineRanges.push({ lineNo: i + 1, start, end, text: lines[i] });
    currentOffset = end + 1;
  }

  const allRanges = [];
  for (const fn of v8Functions) {
    if (Array.isArray(fn.ranges)) {
      for (const r of fn.ranges) {
        allRanges.push(r);
      }
    }
  }

  // Sort ranges: broader outer ranges first
  allRanges.sort((a, b) => {
    if (a.startOffset !== b.startOffset) return a.startOffset - b.startOffset;
    return b.endOffset - a.endOffset;
  });

  const lineHits = new Map();

  for (const { lineNo, start, text } of lineRanges) {
    const trimmed = text.trim();
    if (
      !trimmed ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("import ") ||
      trimmed.startsWith("export default {") ||
      trimmed === "};" ||
      trimmed === "}"
    ) {
      continue;
    }

    const nonWsStart = start + text.search(/\S/);
    const nonWsEnd = start + text.trimEnd().length;

    let count = 0;
    let matched = false;

    for (const r of allRanges) {
      if (r.startOffset <= nonWsStart && nonWsEnd <= r.endOffset) {
        count = r.count;
        matched = true;
      }
    }

    if (matched) {
      lineHits.set(lineNo, count);
    }
  }

  return lineHits;
}

/**
 * Spawns the verification test command with NODE_V8_COVERAGE and collects raw coverage maps.
 * @param {string} [testCmd] - Command to execute (defaults to package test cmd)
 * @param {object} [options]
 * @param {string} [options.root=process.cwd()]
 * @param {number} [options.timeoutMs=60000]
 * @returns {object} { ok, coverageFiles, coverageByFile, stdout, stderr, exitCode }
 */
export function runV8Coverage(testCmd, options = {}) {
  const root = options.root || process.cwd();
  const cmd = testCmd || resolveVerify(root).testCmd || "npm test";
  const timeoutMs = options.timeoutMs || 60000;

  const tempCoverageDir = mkdtempSync(join(tmpdir(), "jules-v8-cov-"));

  try {
    const env = {
      ...process.env,
      NODE_V8_COVERAGE: tempCoverageDir,
    };
    // Strip child test runner flags to avoid collisions
    for (const k of Object.keys(env)) {
      if (k.startsWith("NODE_TEST_") || k.startsWith("NODE_CHANNEL_")) {
        delete env[k];
      }
    }

    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    try {
      stdout = execSync(cmd, {
        cwd: root,
        env,
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      });
    } catch (err) {
      exitCode = err.status || 1;
      stdout = err.stdout ? String(err.stdout) : "";
      stderr = err.stderr ? String(err.stderr) : err.message;
    }

    const coverageByFile = new Map();
    const files = existsSync(tempCoverageDir) ? readdirSync(tempCoverageDir) : [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const fullPath = join(tempCoverageDir, file);
      try {
        const content = readFileSync(fullPath, "utf-8");
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed.result)) {
          for (const item of parsed.result) {
            if (!item.url || item.url.startsWith("node:")) continue;
            let relPath = item.url;
            if (relPath.startsWith("file://")) {
              try {
                relPath = fileURLToPath(item.url);
              } catch (_) {
                relPath = relPath.replace(/^file:\/\//, "");
              }
            }
            if (isAbsolute(relPath)) {
              relPath = relPath.replace(root, "").replace(/^[/\\]+/, "");
            }
            relPath = relPath.replace(/\\/g, "/");

            if (!isExcludedFromCoverage(relPath)) {
              if (!coverageByFile.has(relPath)) {
                coverageByFile.set(relPath, []);
              }
              coverageByFile.get(relPath).push(...(item.functions || []));
            }
          }
        }
      } catch (_) {}
    }

    return {
      ok: exitCode === 0,
      exitCode,
      stdout,
      stderr,
      coverageFiles: files.length,
      coverageByFile,
    };
  } finally {
    try {
      rmSync(tempCoverageDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

/**
 * Parses diff text to extract added line numbers for each modified file.
 * @param {string} diffStr
 * @returns {Map<string, number[]>} Map of filePath -> added line numbers
 */
export function extractAddedLinesFromDiff(diffStr = "") {
  const fileAddedLines = new Map();
  if (!diffStr) return fileAddedLines;

  let currentFile = null;
  let currentLineNo = null;

  const lines = diffStr.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if ((line.startsWith("+++ ") || line.startsWith("+++ b/") || line.startsWith("+++ /dev/null")) && !line.startsWith("++++")) {
      const target = line.slice(3).split("\t")[0].trim().replace(/^b\//, "");
      currentFile = target && target !== "/dev/null" ? target : null;
      currentLineNo = null;
      continue;
    }

    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (hunkMatch) {
      currentLineNo = parseInt(hunkMatch[1], 10);
      continue;
    }

    if (currentLineNo === null || !currentFile) continue;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (!isExcludedFromCoverage(currentFile)) {
        if (!fileAddedLines.has(currentFile)) {
          fileAddedLines.set(currentFile, []);
        }
        fileAddedLines.get(currentFile).push(currentLineNo);
      }
      currentLineNo++;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      currentLineNo++;
    }
  }

  return fileAddedLines;
}

/**
 * Calculates diff coverage percentage by cross-referencing V8 coverage against added lines in the git diff.
 * @param {Map<string, Array<object>>} coverageByFile - Map of relative file path -> V8 function arrays
 * @param {string} diffStr - Unified git diff
 * @param {object} [options]
 * @param {string} [options.root=process.cwd()]
 * @param {number} [options.minCoverage=100] - Expected minimum coverage percentage (0-100)
 * @returns {object} { ok, score, totalLines, coveredLines, missedLines, missedByFile, summary }
 */
export function calculateDiffCoverage(coverageByFile, diffStr = "", options = {}) {
  const root = options.root || process.cwd();
  const minCoverage = typeof options.minCoverage === "number" ? options.minCoverage : 100;
  const addedLinesMap = extractAddedLinesFromDiff(diffStr);

  let totalLines = 0;
  let coveredLines = 0;
  const missedByFile = {};

  for (const [file, addedLines] of addedLinesMap.entries()) {
    const absPath = resolve(root, file);
    if (!existsSync(absPath)) continue;

    let sourceContent = "";
    try {
      sourceContent = readFileSync(absPath, "utf-8");
    } catch (_) {
      continue;
    }

    const v8Functions = coverageByFile.get(file) || [];
    const lineHits = mapV8RangesToLines(sourceContent, v8Functions);

    const missed = [];
    for (const lineNo of addedLines) {
      if (lineHits.has(lineNo)) {
        totalLines++;
        const count = lineHits.get(lineNo);
        if (count > 0) {
          coveredLines++;
        } else {
          missed.push(lineNo);
        }
      }
    }

    if (missed.length > 0) {
      missedByFile[file] = missed;
    }
  }

  const score = totalLines > 0 ? Math.round((coveredLines / totalLines) * 10000) / 100 : 100;
  const ok = score >= minCoverage;

  return {
    ok,
    score,
    minCoverage,
    totalLines,
    coveredLines,
    missedLines: totalLines - coveredLines,
    missedByFile,
    summary: `Diff Coverage: ${score}% (${coveredLines}/${totalLines} added executable lines covered, min: ${minCoverage}%)`,
  };
}
