import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync, realpathSync } from "node:fs";
import { isTestPath } from "./test-paths.mjs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runCmd } from "./git.mjs";
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
    isTestPath(norm) ||
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
 * Extensions V8 could have observed. Coverage outside this family is not a
 * measurement that returned nothing — it is no measurement at all, and a
 * hard red there is how the gate gets switched off.
 */
const V8_OBSERVABLE_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"]);

const isV8Observable = (file) => {
  const dot = file.lastIndexOf(".");
  return dot !== -1 && V8_OBSERVABLE_EXT.has(file.slice(dot).toLowerCase());
};

/**
 * Lines of source text that are executable on their own — the denominator a
 * line coverage measure would count. V8's own mapper only emits entries for
 * lines its function ranges *observed*; a file Node never imported has no
 * functions at all, so every executable line in it was previously invisible
 * and a 0/0 diff was reported as a passing 100% (F12). The heuristic stays
 * deliberately conservative: comments, blank lines, and pure declarations
 * (imports, exports of names alone) do not count.
 */
export function executableLineNumbers(sourceContent = "") {
  const lines = sourceContent.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;
    if (trimmed.startsWith("import ")) continue;
    if (/^(?:export\s+)?(?:default\s+)?(?:class|function|const|let|var)\s+[A-Za-z_$][\w$]*\s*$/.test(trimmed)) continue;
    if (trimmed === "{" || trimmed === "}" || trimmed === "};") continue;
    out.push(i + 1);
  }
  return out;
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

    const res = runCmd(cmd, {
      cwd: root,
      env,
      timeout: timeoutMs,
      ignoreError: true,
    });
    const exitCode = res.status;
    const stdout = res.stdout;
    const stderr = res.stderr;

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

            let resolvedRoot = root;
            try {
              if (existsSync(root)) resolvedRoot = realpathSync(root);
            } catch (_) {}

            try {
              if (existsSync(relPath)) relPath = realpathSync(relPath);
            } catch (_) {}

            if (isAbsolute(relPath)) {
              relPath = relative(resolvedRoot, relPath);
            }
            relPath = relPath.replace(/\\/g, "/").replace(/^\.\//, "");

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
  // Files V8 can measure, but for which the test run produced no coverage
  // data at all — code Node never imported. Distinct from files V8 cannot
  // observe (Python, Go, …): those are genuinely not measurable here, and
  // scoring them zero blocks stacks the gate never claimed to cover.
  const unobservedExecutableFiles = [];

  for (const [file, addedLines] of addedLinesMap.entries()) {
    const absPath = resolve(root, file);
    if (!existsSync(absPath)) continue;

    let sourceContent = "";
    try {
      sourceContent = readFileSync(absPath, "utf-8");
    } catch (_) {
      continue;
    }

    const v8Observable = isV8Observable(file);
    const v8Functions = coverageByFile.get(file) || [];
    const lineHits = mapV8RangesToLines(sourceContent, v8Functions);

    // The executable denominator *from the source itself*, independent of
    // whether V8 happened to map the file. A file that added executable
    // lines but never appeared in V8's report ran nothing of what was added.
    const executableSet = new Set(executableLineNumbers(sourceContent));
    const neverObserved = v8Observable && v8Functions.length === 0 && addedLines.some((n) => executableSet.has(n));
    if (neverObserved) unobservedExecutableFiles.push(file);

    const missed = [];
    for (const lineNo of addedLines) {
      const isExecutable = executableSet.has(lineNo);
      if (lineHits.has(lineNo)) {
        totalLines++;
        const count = lineHits.get(lineNo);
        if (count > 0) {
          coveredLines++;
        } else {
          missed.push(lineNo);
        }
      } else if (neverObserved && isExecutable) {
        // V8 could have seen this line, mapped nothing in the file, and the
        // line is executable: it was not covered. Counting it is what turns
        // "0/0 scored" for an unimported module into a real miss — the gate
        // returning exit 0 on code no test ran is F12.
        totalLines++;
        missed.push(lineNo);
      }
    }

    if (missed.length > 0) {
      missedByFile[file] = missed;
    }
  }

  // 100% of nothing is not 100%.
  //
  // Two very different ways the denominator can be zero:
  //
  //   1. There were no executable added lines to measure, or the diff is in
  //      code V8 cannot observe (Python, Go, …). The measurement is simply
  //      not applicable here; `ok` stays true because nothing failed to be
  //      covered — a gate that blocks every non-Node diff gets switched off.
  //      What changes is the claim: `scored: false` and a reason.
  //   2. There were executable lines in code V8 *can* observe, and the test
  //      run mapped none of them — the file was never imported. A passing
  //      result on that is the same failure as a line counted uncovered:
  //      the suite certified code it never ran (F12). That is scored zero,
  //      not scored nothing.
  //
  // `mutation.mjs` had the original "100% of 0/0" bug in the first family
  // and was fixed in v0.57.0; this is the second family, one module over.
  const measuredNothingExecutable = unobservedExecutableFiles.length > 0 && totalLines === 0;
  const scored = totalLines > 0;
  const score = scored ? Math.round((coveredLines / totalLines) * 10000) / 100 : null;
  // N/A only when V8 could not have measured the added code (no executable
  // lines at all, or a stack V8 does not observe). Executable Node code the
  // test run never reached is a failure, not an N/A.
  const notApplicable = !scored && !measuredNothingExecutable;
  const ok = notApplicable ? true : score >= minCoverage;

  return {
    ok,
    score: notApplicable ? null : score,
    scored,
    ...(notApplicable
      ? { reason: "No added executable lines were measurable — V8 coverage only observes code Node itself ran, so nothing was scored." }
      : {
          reason: `Added executable code was never executed by the test run (unobserved: ${unobservedExecutableFiles.join(", ")}) — V8 coverage saw no execution of it, so it counts as uncovered.`,
          unobservedFiles: unobservedExecutableFiles,
        }),
    minCoverage,
    totalLines,
    coveredLines,
    missedLines: totalLines - coveredLines,
    missedByFile,
    summary: `Diff Coverage: ${notApplicable ? "null" : score}% (${coveredLines}/${totalLines} added executable lines covered, min: ${minCoverage}%)`,
  };
}
