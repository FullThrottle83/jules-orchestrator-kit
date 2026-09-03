import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { diffText, runCmd } from "./git.mjs";

/**
 * @typedef {Object} MutationCandidate
 * @property {string} id - Unique mutant identifier (file:line:operator)
 * @property {string} file - Relative path of target file
 * @property {number} line - 1-indexed line number
 * @property {string} originalLine - Original line content
 * @property {string} mutatedLine - Mutated line content
 * @property {string} mutationType - Category of mutation (e.g., 'EQUALITY', 'LOGICAL', 'RELATIONAL', 'ARITHMETIC', 'BOOLEAN', 'RETURN')
 * @property {string} description - Human-readable explanation of mutation
 */

/**
 * @typedef {Object} MutantResult
 * @property {MutationCandidate} mutant - The evaluated mutant
 * @property {"KILLED" | "SURVIVED" | "TIMEOUT" | "ERROR"} status - Outcome of mutant execution
 * @property {number} exitCode - Exit code from test command
 * @property {number} durationMs - Execution time in milliseconds
 * @property {string} [stdout] - Test command stdout
 * @property {string} [stderr] - Test command stderr
 */

/**
 * @typedef {Object} MutationReport
 * @property {boolean} ok - True if mutation score meets or exceeds minScore
 * @property {number} totalMutants - Total candidate mutants tested
 * @property {number} killedMutants - Number of mutants killed (test failed as expected)
 * @property {number} survivedMutants - Number of mutants survived (test passed despite mutation)
 * @property {number} errorMutants - Number of mutants with execution errors/timeouts
 * @property {number} mutationScore - Percentage of killed mutants (0 - 100)
 * @property {number} minScore - Required threshold score
 * @property {MutantResult[]} results - Detailed results for all mutants
 * @property {MutantResult[]} survivors - List of survived mutants for remediation
 * @property {number} durationMs - Total run duration in milliseconds
 */

/**
 * Operator mutation replacement rules.
 * Sorted to prevent premature substring collision (e.g. `===` before `==`).
 */
export const MUTATION_RULES = [
  // 1. Strict & Loose Equality
  {
    type: "EQUALITY",
    pattern: /===/g,
    replace: "!==",
    desc: "Inverted strict equality (=== -> !==)",
  },
  {
    type: "EQUALITY",
    pattern: /!==/g,
    replace: "===",
    desc: "Inverted strict inequality (!== -> ===)",
  },
  {
    type: "EQUALITY",
    // Ensure we don't match === or !==
    pattern: /(?<![=!])==(?![=])/g,
    replace: "!=",
    desc: "Inverted loose equality (== -> !=)",
  },
  {
    type: "EQUALITY",
    pattern: /(?<![=!])!=(?![=])/g,
    replace: "==",
    desc: "Inverted loose inequality (!= -> ==)",
  },

  // 2. Relational Operators
  {
    type: "RELATIONAL",
    pattern: />=/g,
    replace: "<",
    desc: "Inverted relational operator (>= -> <)",
  },
  {
    type: "RELATIONAL",
    // Exclude arrow functions (<= is relational, => is arrow)
    pattern: /<=(?!>)/g,
    replace: ">",
    desc: "Inverted relational operator (<= -> >)",
  },
  {
    type: "RELATIONAL",
    // Exclude =>, >>, ->, and closing XML/HTML tags
    pattern: /(?<![=-])>(?![=>])/g,
    replace: "<=",
    desc: "Inverted comparison (> -> <=)",
  },
  {
    type: "RELATIONAL",
    // Exclude <<, <-, and HTML/XML tag openings (<foo)
    pattern: /(?<![<])<(?![<=/a-zA-Z!])/g,
    replace: ">=",
    desc: "Inverted comparison (< -> >=)",
  },

  // 3. Logical Operators
  {
    type: "LOGICAL",
    pattern: /&&/g,
    replace: "||",
    desc: "Swapped logical AND with OR (&& -> ||)",
  },
  {
    type: "LOGICAL",
    pattern: /\|\|/g,
    replace: "&&",
    desc: "Swapped logical OR with AND (|| -> &&)",
  },

  // 4. Boolean Literals
  {
    type: "BOOLEAN",
    pattern: /\btrue\b/g,
    replace: "false",
    desc: "Inverted boolean literal (true -> false)",
  },
  {
    type: "BOOLEAN",
    pattern: /\bfalse\b/g,
    replace: "true",
    desc: "Inverted boolean literal (false -> true)",
  },

  // 5. Unary & Arithmetic
  {
    type: "ARITHMETIC",
    pattern: /\+\+/g,
    replace: "--",
    desc: "Swapped increment with decrement (++ -> --)",
  },
  {
    type: "ARITHMETIC",
    pattern: /--/g,
    replace: "++",
    desc: "Swapped decrement with increment (-- -> ++)",
  },
  {
    type: "ARITHMETIC",
    pattern: /(\s)\+(\s)/g,
    replace: "$1-$2",
    desc: "Swapped addition with subtraction (+ -> -)",
  },
  {
    type: "ARITHMETIC",
    pattern: /(\s)-(?![\d>])(\s)/g,
    replace: "$1+$2",
    desc: "Swapped subtraction with addition (- -> +)",
  },
  {
    type: "ARITHMETIC",
    pattern: /(\s)\*(\s)/g,
    replace: "$1/$2",
    desc: "Swapped multiplication with division (* -> /)",
  },
  {
    type: "ARITHMETIC",
    pattern: /(\s)\/(\s)/g,
    replace: "$1*$2",
    desc: "Swapped division with multiplication (/ -> *)",
  },

  // 6. Return Statements
  {
    type: "RETURN",
    pattern: /\breturn\s+true\b/g,
    replace: "return false",
    desc: "Inverted return boolean (return true -> return false)",
  },
  {
    type: "RETURN",
    pattern: /\breturn\s+false\b/g,
    replace: "return true",
    desc: "Inverted return boolean (return false -> return true)",
  },
  {
    type: "RETURN",
    pattern: /\breturn\s+null\b/g,
    replace: "return undefined",
    desc: "Altered return null (return null -> return undefined)",
  },
];

/**
 * Checks if a file path is a test or non-implementation file that should be excluded from mutation.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isExcludedFromMutation(filePath = "") {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();

  // Exclude test files
  if (
    normalized.includes(".test.") ||
    normalized.includes(".spec.") ||
    normalized.includes("_test.") ||
    normalized.includes("/test/") ||
    normalized.includes("/tests/") ||
    normalized.includes("/__tests__/")
  ) {
    return true;
  }

  // Exclude non-executable / config / documentation formats
  const nonExecExtensions = [
    ".md", ".markdown", ".json", ".yml", ".yaml", ".toml", ".txt",
    ".svg", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2",
    ".lock", ".lockb", ".css", ".scss", ".less", ".html",
  ];

  if (nonExecExtensions.some((ext) => normalized.endsWith(ext))) {
    return true;
  }

  // Exclude package manifests and agent rules
  if (
    normalized.endsWith("package.json") ||
    normalized.endsWith("package-lock.json") ||
    normalized.includes(".agent/") ||
    normalized.includes(".github/")
  ) {
    return true;
  }

  return false;
}

/**
 * Returns a map of line number (1-indexed) to array of character index ranges [startCol, endCol]
 * that are part of string literals (including multiline template literals and block comments).
 * @param {string} sourceCode
 * @returns {Map<number, Array<[number, number]>>}
 */
export function getFileStringLiteralLineMap(sourceCode = "") {
  const lines = sourceCode.split("\n");
  const lineMap = new Map();
  let inTemplate = false;
  let inBlockComment = false;

  for (let l = 0; l < lines.length; l++) {
    const line = lines[l];
    const ranges = [];
    let inQuote = null;
    let quoteStart = -1;
    let escaped = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (inBlockComment) {
        if (char === "*" && line[i + 1] === "/") {
          inBlockComment = false;
          i++;
        }
        continue;
      }

      if (inTemplate) {
        if (char === "`") {
          inTemplate = false;
          ranges.push([0, i]);
        }
        continue;
      }

      if (inQuote) {
        if (char === inQuote) {
          ranges.push([quoteStart, i]);
          inQuote = null;
        }
      } else {
        if (char === "/" && line[i + 1] === "*") {
          inBlockComment = true;
          quoteStart = i;
          i++;
          continue;
        }
        if (char === "/" && line[i + 1] === "/") {
          ranges.push([i, line.length - 1]);
          break;
        }
        if (char === '"' || char === "'") {
          inQuote = char;
          quoteStart = i;
        } else if (char === "`") {
          inTemplate = true;
          quoteStart = i;
        }
      }
    }

    if (inTemplate) {
      ranges.push([quoteStart >= 0 ? quoteStart : 0, line.length - 1]);
      quoteStart = 0;
    } else if (inBlockComment) {
      ranges.push([quoteStart >= 0 ? quoteStart : 0, line.length - 1]);
      quoteStart = 0;
    } else if (inQuote && quoteStart >= 0) {
      ranges.push([quoteStart, line.length - 1]);
    }

    lineMap.set(l + 1, ranges);
  }
  return lineMap;
}

/**
 * Returns character index ranges [start, end] for all string literals on a line.
 * @param {string} line
 * @returns {Array<[number, number]>}
 */
export function getStringLiteralRanges(line) {
  const ranges = [];
  let inQuote = null;
  let start = -1;
  let escaped = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (inQuote) {
      if (char === inQuote) {
        ranges.push([start, i]);
        inQuote = null;
      }
    } else {
      if (char === '"' || char === "'" || char === "`") {
        inQuote = char;
        start = i;
      }
    }
  }
  if (inQuote && start !== -1) {
    ranges.push([start, line.length - 1]);
  }
  return ranges;
}

/**
 * Generates mutation candidates for a given single line of code.
 * @param {string} line - Line text
 * @param {number} lineNo - 1-indexed line number
 * @param {string} filePath - Target file path
 * @param {Array<[number, number]>} [explicitStringRanges] - Pre-calculated string ranges
 * @returns {MutationCandidate[]}
 */
export function generateLineMutants(line = "", lineNo = 1, filePath = "", explicitStringRanges = null) {
  const trimmed = line.trim();
  // Skip comments, imports, exports, and empty lines
  if (
    !trimmed ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("import ") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("from ") ||
    trimmed.startsWith("package ")
  ) {
    return [];
  }

  const mutants = [];
  const lineHash = createHash("sha256").update(line).digest("hex").slice(0, 6);
  const stringRanges = Array.isArray(explicitStringRanges) ? explicitStringRanges : getStringLiteralRanges(line);

  for (let ruleIdx = 0; ruleIdx < MUTATION_RULES.length; ruleIdx++) {
    const rule = MUTATION_RULES[ruleIdx];
    const regex = new RegExp(rule.pattern.source, rule.pattern.flags);

    let match;
    while ((match = regex.exec(line)) !== null) {
      const matchIndex = match.index;
      const matchedText = match[0];
      if (matchedText.length === 0) {
        regex.lastIndex++;
        continue;
      }

      // Do not mutate operators inside string literals or comments
      if (rule.type !== "BOOLEAN" && rule.type !== "RETURN") {
        const isInsideString = stringRanges.some(([start, end]) => matchIndex >= start && matchIndex <= end);
        if (isInsideString) {
          if (!rule.pattern.global) break;
          continue;
        }
      }

      let replacement = rule.replace;
      if (typeof replacement === "string" && replacement.includes("$")) {
        const singleRegex = new RegExp(rule.pattern.source);
        replacement = matchedText.replace(singleRegex, rule.replace);
      }

      const mutatedLine = line.slice(0, matchIndex) + replacement + line.slice(matchIndex + matchedText.length);

      if (mutatedLine !== line) {
        mutants.push({
          id: `${filePath}:${lineNo}:m${ruleIdx}-${matchIndex}-${lineHash}`,
          file: filePath,
          line: lineNo,
          originalLine: line,
          mutatedLine,
          mutationType: rule.type,
          description: rule.desc,
        });
      }

      if (!rule.pattern.global) break;
    }
  }

  return mutants;
}

/**
 * Generates mutation candidates for an entire file content.
 * @param {string} sourceCode
 * @param {string} filePath
 * @returns {MutationCandidate[]}
 */
export function generateMutants(sourceCode = "", filePath = "source.js") {
  if (isExcludedFromMutation(filePath)) return [];

  const lines = sourceCode.split("\n");
  const stringMap = getFileStringLiteralLineMap(sourceCode);
  const allMutants = [];

  for (let i = 0; i < lines.length; i++) {
    const lineRanges = stringMap.get(i + 1) || [];
    const lineMutants = generateLineMutants(lines[i], i + 1, filePath, lineRanges);
    allMutants.push(...lineMutants);
  }

  return allMutants;
}

/**
 * Parses a unified diff string and extracts mutation candidates strictly from added lines (`+` hunks).
 * @param {string} diffStr - Unified git diff
 * @param {string} [root=process.cwd()] - Project root
 * @returns {MutationCandidate[]}
 */
export function generateDiffMutants(diffStr = "", root = process.cwd()) {
  if (!diffStr) return [];

  const candidates = [];
  let currentFile = null;
  let currentLineNo = null;
  let currentFileStringMap = null;

  const lines = diffStr.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if ((line.startsWith("+++ ") || line.startsWith("+++ b/") || line.startsWith("+++ /dev/null")) && !line.startsWith("++++")) {
      const target = line.slice(3).split("\t")[0].trim().replace(/^b\//, "");
      currentFile = target && target !== "/dev/null" ? target : null;
      currentLineNo = null;
      currentFileStringMap = null;

      if (currentFile && root) {
        const fullPath = isAbsolute(currentFile) ? currentFile : resolve(root, currentFile);
        if (existsSync(fullPath)) {
          try {
            const content = readFileSync(fullPath, "utf-8");
            currentFileStringMap = getFileStringLiteralLineMap(content);
          } catch (_) {}
        }
      }
      continue;
    }

    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (hunkMatch) {
      currentLineNo = Number(hunkMatch[1]);
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (currentFile && !isExcludedFromMutation(currentFile) && currentLineNo !== null) {
        const addedText = line.slice(1);
        const lineRanges = currentFileStringMap ? currentFileStringMap.get(currentLineNo) : null;
        const lineMutants = generateLineMutants(addedText, currentLineNo, currentFile, lineRanges);
        candidates.push(...lineMutants);
      }
      if (currentLineNo !== null) currentLineNo++;
    } else if (currentLineNo !== null && !line.startsWith("-") && !line.startsWith("\\")) {
      currentLineNo++;
    }
  }

  return candidates;
}

/**
 * Applies a candidate mutation to a target file, executes the test command, and safely rolls back.
 *
 * @param {MutationCandidate} mutant
 * @param {Object} [options]
 * @param {string} [options.root=process.cwd()]
 * @param {string} [options.testCmd="npm test"]
 * @param {number} [options.timeoutMs=15000]
 * @param {Function} [options.executor] - Optional custom execution function for mocking / speed
 * @returns {MutantResult}
 */
export function executeMutant(mutant, options = {}) {
  const root = options.root || process.cwd();
  const testCmd = options.testCmd || "npm test";
  const timeoutMs = options.timeoutMs || 15000;
  const absPath = isAbsolute(mutant.file) ? mutant.file : resolve(root, mutant.file);

  if (!existsSync(absPath)) {
    return {
      mutant,
      status: "ERROR",
      exitCode: 1,
      durationMs: 0,
      stderr: `Target file does not exist: ${mutant.file}`,
    };
  }

  const originalContent = readFileSync(absPath, "utf-8");
  const lines = originalContent.split("\n");

  if (mutant.line < 1 || mutant.line > lines.length) {
    return {
      mutant,
      status: "ERROR",
      exitCode: 1,
      durationMs: 0,
      stderr: `Mutant line ${mutant.line} out of range (1..${lines.length})`,
    };
  }

  // Replace target line
  lines[mutant.line - 1] = mutant.mutatedLine;
  const mutatedContent = lines.join("\n");

  const startTime = Date.now();
  let exitCode = 0;
  let stdout = "";
  let stderr = "";
  let status = "SURVIVED";

  try {
    // Write mutant to disk
    writeFileSync(absPath, mutatedContent, "utf-8");

    if (typeof options.executor === "function") {
      const execResult = options.executor({ mutant, testCmd, absPath });
      exitCode = typeof execResult.exitCode === "number" ? execResult.exitCode : execResult.status || 0;
      stdout = execResult.stdout || "";
      stderr = execResult.stderr || "";
    } else {
      const execResult = runCmd(testCmd, {
        cwd: root,
        timeout: timeoutMs,
        env: { ...process.env, CI: "true", JULES_MUTATION_RUN: "true" },
        ignoreError: true,
      });
      exitCode = execResult.status;
      stdout = execResult.stdout;
      stderr = execResult.stderr;
      if (execResult.status === 124 || stderr.includes("ETIMEDOUT")) {
        status = "TIMEOUT";
      }
    }

    const durationMs = Date.now() - startTime;

    // If test failed (non-zero exit code) or timed out, mutant was KILLED
    if (status === "TIMEOUT") {
      return { mutant, status: "KILLED", exitCode, durationMs, stdout, stderr };
    }

    if (exitCode !== 0) {
      status = "KILLED";
    } else {
      status = "SURVIVED";
    }

    return {
      mutant,
      status,
      exitCode,
      durationMs,
      stdout: stdout.slice(0, 500),
      stderr: stderr.slice(0, 500),
    };
  } catch (err) {
    return {
      mutant,
      status: "ERROR",
      exitCode: 1,
      durationMs: Date.now() - startTime,
      stderr: err.message,
    };
  } finally {
    // GUARANTEED SAFE ROLLBACK
    try {
      writeFileSync(absPath, originalContent, "utf-8");
    } catch (_) {}
  }
}

/**
 * Runs a complete mutation test sweep across candidate mutants.
 *
 * @param {Object} [options]
 * @param {string} [options.root=process.cwd()]
 * @param {string} [options.diffStr] - Optional unified diff to target (defaults to git working tree diff)
 * @param {string} [options.base="main"] - Base branch if computing diff
 * @param {string} [options.mode="working-tree"] - Diff mode ("working-tree" | "staged" | "committed")
 * @param {string} [options.testCmd="npm test"] - Test command
 * @param {number} [options.minScore=80] - Minimum required mutation score (default 80%)
 * @param {number} [options.maxMutants=20] - Maximum mutants to evaluate to prevent excessive CI duration
 * @param {number} [options.timeoutMs=15000] - Per-mutant test timeout
 * @param {Function} [options.executor] - Custom runner for unit testing
 * @returns {MutationReport}
 */
export function runMutationTest(options = {}) {
  const root = options.root || process.cwd();
  const base = options.base || "main";
  const mode = options.mode || "working-tree";
  const minScore = typeof options.minScore === "number" ? options.minScore : 80;
  const maxMutants = typeof options.maxMutants === "number" ? options.maxMutants : 20;
  const testCmd = options.testCmd || "npm test";

  const startTime = Date.now();

  let candidates = [];
  if (Array.isArray(options.files) && options.files.length > 0) {
    for (const relFile of options.files) {
      const abs = resolve(root, relFile);
      if (existsSync(abs)) {
        const content = readFileSync(abs, "utf-8");
        candidates.push(...generateMutants(content, relFile));
      }
    }
  } else {
    let diffContent = options.diffStr;
    if (!diffContent) {
      try {
        diffContent = diffText(root, base, mode);
      } catch (_) {
        diffContent = "";
      }
    }
    if (diffContent) {
      candidates = generateDiffMutants(diffContent, root);
    }
  }

  // Cap candidates to maxMutants
  const selectedMutants = candidates.slice(0, maxMutants);

  if (selectedMutants.length === 0) {
    // A diff with no mutable operators yields no mutants, and reporting that as
    // "100%" told operators their untested code had a perfect score — the exact
    // false confidence the harness exists to remove. There is no score to
    // report, so there is none: `mutationScore` is null and `reason` says why.
    //
    // `ok` stays true. Nothing was falsifiable, so nothing failed to be
    // falsified; failing here would block every diff that only adds imports,
    // constants or markdown, and a gate that cries wolf gets switched off.
    return {
      ok: true,
      totalMutants: 0,
      killedMutants: 0,
      survivedMutants: 0,
      errorMutants: 0,
      mutationScore: null,
      scored: false,
      reason: "No mutable operators in the added lines — nothing to falsify, so no score was computed.",
      minScore,
      results: [],
      survivors: [],
      durationMs: Date.now() - startTime,
    };
  }

  const results = [];
  let killedCount = 0;
  let survivedCount = 0;
  let errorCount = 0;

  for (const mutant of selectedMutants) {
    const res = executeMutant(mutant, {
      root,
      testCmd,
      timeoutMs: options.timeoutMs,
      executor: options.executor,
    });

    results.push(res);
    if (res.status === "KILLED") {
      killedCount++;
    } else if (res.status === "SURVIVED") {
      survivedCount++;
    } else {
      errorCount++;
    }
  }

  const evaluatedCount = killedCount + survivedCount;
  const mutationScore = evaluatedCount > 0 ? Math.round((killedCount / evaluatedCount) * 100) : 100;
  const ok = mutationScore >= minScore;
  const survivors = results.filter((r) => r.status === "SURVIVED");

  return {
    ok,
    totalMutants: selectedMutants.length,
    killedMutants: killedCount,
    survivedMutants: survivedCount,
    errorMutants: errorCount,
    mutationScore,
    minScore,
    results,
    survivors,
    durationMs: Date.now() - startTime,
  };
}
