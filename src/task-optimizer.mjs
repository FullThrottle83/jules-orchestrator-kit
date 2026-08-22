import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { checkScope } from "./security.mjs";
import { detectStackOracles } from "./wizard-oracle.mjs";
import { loadConfig } from "./config.mjs";
import { sanitizePromptVocabulary } from "./prompt-guard.mjs";

/**
 * Calculates Levenshtein distance between two strings.
 * Zero external dependencies.
 */
export function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a || a.length === 0) return b ? b.length : 0;
  if (!b || b.length === 0) return a.length;

  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const val = a[i - 1] === b[j - 1] ? row[j - 1] : Math.min(row[j - 1], prev, row[j]) + 1;
      row[j - 1] = prev;
      prev = val;
    }
    row[b.length] = prev;
  }
  return row[b.length];
}

/**
 * Traverses local repository directory to harvest candidate relative file paths.
 */
function harvestRepoFiles(dir, maxDepth = 4, currentDepth = 0) {
  if (currentDepth > maxDepth) return [];
  const files = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === "coverage") continue;
      const fullPath = join(dir, entry);
      const relPath = relative(process.cwd(), fullPath).replace(/\\/g, "/");
      let stat;
      try { stat = statSync(fullPath); } catch (_) { continue; }
      if (stat.isDirectory()) {
        files.push(...harvestRepoFiles(fullPath, maxDepth, currentDepth + 1));
      } else if (stat.isFile()) {
        files.push(relPath);
      }
    }
  } catch (_) {}
  return files;
}

/**
 * Extracts potential file/directory path tokens from prompt text.
 */
export function extractPathTokens(promptText) {
  if (!promptText || typeof promptText !== "string") return [];
  const tokens = [];
  const words = promptText.split(/\s+/);
  for (const rawWord of words) {
    const cleanWord = rawWord.replace(/^[`'"]+|[`'":;,.]+$|\.$/g, "");
    if (
      cleanWord.includes("/") &&
      (cleanWord.includes(".") || cleanWord.startsWith(".github/") || cleanWord.startsWith(".agent/")) &&
      !cleanWord.startsWith("http://") &&
      !cleanWord.startsWith("https://")
    ) {
      if (!tokens.includes(cleanWord)) {
        tokens.push(cleanWord);
      }
    }
  }
  return tokens;
}

/**
 * Detects whether a prompt text pertains to web development domains (CWV, WCAG, SEO, E2E).
 * @param {string} promptText
 * @returns {{ isWeb: boolean, categories: string[], suggestedOracles: string[] }}
 */
export function detectWebIntent(promptText) {
  if (!promptText || typeof promptText !== "string") {
    return { isWeb: false, categories: [], suggestedOracles: [] };
  }

  const text = promptText.toLowerCase();
  const categories = [];
  const suggestedOracles = [];

  const isPerformance = /\b(?:lighthouse|core web vitals|cwv|lcp|cls|inp|fcp|bundle size|lazy load|lazy-load|preload|render-blocking)\b/i.test(text);
  const isA11y = /\b(?:wcag|a11y|accessibility|aria|screen reader|contrast ratio|focus trap|keyboard navigation)\b/i.test(text);
  const isSeo = /\b(?:seo|json-ld|schema\.org|structured data|opengraph|sitemap|canonical|meta tag)\b/i.test(text);
  const isE2e = /\b(?:playwright|e2e|visual regression|snapshot|viewport|responsive|tailwind|css|astro|next\.js|nuxt|svelte|react|vue)\b/i.test(text);

  if (isPerformance) {
    categories.push("Performance (CWV)");
    suggestedOracles.push("npm run build && npx lhci autorun");
  }
  if (isA11y) {
    categories.push("Accessibility (WCAG)");
    suggestedOracles.push("npx axe-cli http://localhost:3000 || npm test");
  }
  if (isSeo) {
    categories.push("SEO & Structured Data");
    suggestedOracles.push("npm run build && node scripts/validate-seo.mjs");
  }
  if (isE2e) {
    categories.push("Frontend & E2E");
    suggestedOracles.push("npx playwright test");
  }

  const isWeb = categories.length > 0;
  return {
    isWeb,
    categories,
    suggestedOracles
  };
}

const VAGUE_BUZZWORDS = [
  { term: "clean up", penalty: 15, msg: "Vague goal: 'clean up' lacks explicit acceptance criteria." },
  { term: "make faster", penalty: 15, msg: "Vague goal: 'make faster' lacks quantitative benchmark criteria." },
  { term: "fix bug", penalty: 10, msg: "Vague description: 'fix bug' does not reference specific error code or line." },
  { term: "refactor", penalty: 10, msg: "Unbounded directive: 'refactor' without boundary limits risks payload blowouts." },
  { term: "improve", penalty: 10, msg: "Subjective goal: 'improve' is not objectively scoreable." },
  { term: "better", penalty: 10, msg: "Subjective wording: 'better' lacks falsifiable pass/fail criteria." },
  { term: "various fixes", penalty: 20, msg: "Unbounded scope: 'various fixes' triggers scope leakage and ring-buffer thrashing." },
  { term: "update code", penalty: 15, msg: "Generic request: 'update code' does not specify target contract or behavior." }
];

const TRIVIAL_VERIFY_CMDS = ["true", "echo", ":", "false", "exit 0"];

/**
 * Scores task prompt falsifiability, scope compliance, path validity, and oracle readiness.
 */
export function scorePromptFalsifiability(promptText, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const rawPrompt = (promptText || "").trim();
  const config = options.config || loadConfig(rootDir);

  let score = 100;
  const issues = [];
  const suggestions = [];

  if (!rawPrompt) {
    return {
      score: 0,
      grade: "F",
      isFalsifiable: false,
      issues: [{ type: "EMPTY_PROMPT", message: "Task prompt is empty.", penalty: 100 }],
      suggestions: ["Provide a clear description of the code change requested."],
      paths: { found: [], missingCount: 0, scopeDeniedCount: 0 },
      oracle: { command: null, autoDetected: false, isTrivial: false },
      webIntent: { isWeb: false, categories: [], suggestedOracles: [] }
    };
  }

  // 1. Length & Buzzword Analysis
  if (rawPrompt.length < 15) {
    score -= 25;
    issues.push({ type: "SHORT_PROMPT", message: "Prompt is under 15 characters long.", penalty: 25 });
    suggestions.push("Expand prompt with context, affected symbols, or expected output behavior.");
  }

  const promptLower = rawPrompt.toLowerCase();
  for (const bw of VAGUE_BUZZWORDS) {
    if (promptLower.includes(bw.term)) {
      score -= bw.penalty;
      issues.push({ type: "VAGUE_WORDING", message: bw.msg, penalty: bw.penalty });
    }
  }

  // 2. Concrete Evidence Indicators (Bonus/Protection)
  const hasErrorTrace = /(?:error|exception|fail|failed|stack|traceback|line\s+\d+|exit\s+code)/i.test(rawPrompt);
  const hasSymbolRef = /(?:`[^`]+`|\b[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+\b|\b[a-zA-Z0-9_]+\(\))/i.test(rawPrompt);
  const hasExplicitCheck = /(?:verify|assert|should|must|returns?|expect|< \d+|>= \d+)/i.test(rawPrompt);

  if (hasErrorTrace || hasSymbolRef || hasExplicitCheck) {
    score = Math.min(100, score + 10);
  } else {
    score -= 10;
    issues.push({ type: "NO_CONCRETE_CRITERIA", message: "Lacks explicit symbol references, test names, or quantitative acceptance criteria.", penalty: 10 });
    suggestions.push("Specify exact function names, file paths, or expected test assertions.");
  }

  // 3. Static Path & Scope Verification
  const extractedPaths = extractPathTokens(rawPrompt);
  const repoFiles = harvestRepoFiles(rootDir);
  const pathResults = [];
  let missingCount = 0;
  let scopeDeniedCount = 0;

  for (const token of extractedPaths) {
    const fullPath = resolve(rootDir, token);
    const relPath = relative(rootDir, fullPath).replace(/\\/g, "/");
    const exists = existsSync(fullPath);

    // Check scope policy
    const scopeCheck = checkScope([relPath], config.scope || {});
    const scopeDenied = Boolean(scopeCheck.violations && scopeCheck.violations.length > 0);
    const denialReason = scopeDenied ? scopeCheck.violations[0].reason : null;

    if (scopeDenied) {
      score -= 30;
      scopeDeniedCount++;
      issues.push({ type: "SCOPE_VIOLATION", message: `Referenced path '${relPath}' violates security policy (${denialReason}).`, penalty: 30 });
    }

    let suggestion;
    if (!exists && !scopeDenied) {
      missingCount++;
      score -= 15;
      // Fuzzy search closest file
      let bestDist = Infinity;
      let bestFile = null;
      for (const repoFile of repoFiles) {
        const dist = levenshteinDistance(token, repoFile);
        if (dist < bestDist && dist <= 4) {
          bestDist = dist;
          bestFile = repoFile;
        }
      }
      if (bestFile) {
        suggestion = bestFile;
        suggestions.push(`Referenced file '${token}' not found. Did you mean '${bestFile}'?`);
      } else {
        suggestions.push(`Referenced file '${token}' does not exist on disk.`);
      }
    }

    pathResults.push({
      token,
      exists,
      suggestion,
      scopeDenied,
      reason: denialReason
    });
  }

  // 4. Web Domain Intent Detection
  const webIntent = detectWebIntent(rawPrompt);
  if (webIntent.isWeb && webIntent.categories.length > 0) {
    suggestions.push(`Web domain detected (${webIntent.categories.join(", ")}). Consider incorporating exploration budget and critic agent checks.`);
  }

  // 5. Positive Boundary / Negative Restriction Linting ("Pink Elephant" Principle)
  const negativeMatches = rawPrompt.match(/\b(do not|never|don't|forbidden|must not)\b/gi) || [];
  const positiveScopeMatch = /\b(only modify|strictly scoped to|scoped to|confined to)\b/i.test(rawPrompt);
  if (negativeMatches.length >= 3 && !positiveScopeMatch) {
    suggestions.push("Multiple negative constraints detected. Consider defining Airtight Positive Enclosures (e.g. 'ONLY modify [Target]') to prevent attention-drift.");
  }

  // 6. Headless Remote VM & Dead Code Linting
  if (/\b(?:playwright|e2e|screenshot|browser)\b/i.test(rawPrompt) && !/\b(?:headless|mock)\b/i.test(rawPrompt)) {
    suggestions.push("E2E / Browser testing detected. Ensure Playwright runs specify '--headless' to prevent display-server crashes in headless Jules VMs.");
  }
  if (/\b(?:knip|dead code|unused exports?|remove unused)\b/i.test(rawPrompt) && !/\b(?:report|audit|audit-first)\b/i.test(rawPrompt)) {
    suggestions.push("Dead code cleanup detected. Consider adopting the Audit-First principle (generate .agent/reports/dead-code-audit.md before deleting files) to avoid removing dynamic runtime imports.");
  }

  // 7. Stack Oracle Detection
  let verifyCmd = options.verifyCmd || null;
  let autoDetected = false;
  let isTrivial = false;

  if (!verifyCmd) {
    const detectedOracles = detectStackOracles(rootDir);
    if (detectedOracles.length > 0 && detectedOracles[0].testCmd) {
      verifyCmd = detectedOracles[0].testCmd;
      autoDetected = true;
    }
  }

  if (verifyCmd && TRIVIAL_VERIFY_CMDS.includes(verifyCmd.trim())) {
    isTrivial = true;
    score -= 25;
    issues.push({ type: "TRIVIAL_ORACLE", message: `Verification command '${verifyCmd}' is non-evaluable / trivial.`, penalty: 25 });
    suggestions.push("Use a non-trivial test command like 'npm test', 'pytest', or 'cargo test'.");
  } else if (!verifyCmd) {
    score -= 15;
    issues.push({ type: "MISSING_ORACLE", message: "No automated test or build verification command specified.", penalty: 15 });
    suggestions.push("Specify a verification command using --verify (e.g. 'npm test').");
  }

  // Final score clamping & letter grade assignment
  score = Math.max(0, Math.min(100, Math.round(score)));

  let grade = "F";
  if (score >= 90) grade = "A+";
  else if (score >= 80) grade = "A";
  else if (score >= 70) grade = "B";
  else if (score >= 60) grade = "C";
  else if (score >= 50) grade = "D";

  const isFalsifiable = score >= 65 && scopeDeniedCount === 0 && !isTrivial;

  return {
    score,
    grade,
    isFalsifiable,
    issues,
    suggestions: [...new Set(suggestions)],
    paths: {
      found: pathResults,
      missingCount,
      scopeDeniedCount
    },
    oracle: {
      command: verifyCmd,
      autoDetected,
      isTrivial
    },
    webIntent
  };
}

/**
 * Transforms raw prompt into an optimized, structured task envelope.
 * Supports Google Labs Exploration Budget Protocol & Critic Agent Guidance.
 * @param {string} promptText
 * @param {object} [options={}]
 * @returns {{ optimizedPrompt: string, analysis: object }}
 */
export function optimizeTaskPrompt(promptText, options = {}) {
  const analysis = scorePromptFalsifiability(promptText, options);
  const rawPrompt = (promptText || "").trim();

  if (!rawPrompt) {
    return {
      optimizedPrompt: "",
      analysis
    };
  }

  let promptBody = sanitizePromptVocabulary(rawPrompt);

  // Apply suggestions & path corrections to prompt body if requested
  for (const pathInfo of analysis.paths.found) {
    if (!pathInfo.exists && pathInfo.suggestion) {
      const regex = new RegExp(pathInfo.token.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "g");
      promptBody = promptBody.replace(regex, pathInfo.suggestion);
    }
  }

  const isWeb = Boolean(options.web || (analysis.webIntent && analysis.webIntent.isWeb));
  const includeExplorationBudget = options.explorationBudget !== false;
  const includeCriticGuidance = options.criticGuidance !== false;
  const verifyCmd = analysis.oracle.command || options.verifyCmd || "npm test";

  // Construct structured Markdown envelope
  const lines = [];
  lines.push(`# TASK: ${promptBody.split("\n")[0]}`);
  lines.push("");

  if (includeExplorationBudget) {
    lines.push("## Google Labs Exploration Budget Protocol (3-Phase Discovery)");
    lines.push("To maximize diagnostic accuracy (Hit@5 57%), execute this task in 3 distinct phases:");
    lines.push("1. **PHASE 1: DISCOVERY & SYMBOL TRACING (Stay Silent, Write NO Code)**");
    lines.push("   - Read target source files, definitions, and dependent call sites.");
    lines.push("   - Formulate diagnostic hypothesis and verify exact symbol signatures before making edits.");
    lines.push("2. **PHASE 2: ORACLE FORMULATION**");
    lines.push(`   - Execute baseline verification: \`${verifyCmd}\`.`);
    lines.push("   - Identify specific test assertions, benchmarks, or status codes to satisfy.");
    lines.push("3. **PHASE 3: SURGICAL IMPLEMENTATION & VERIFICATION**");
    lines.push("   - Apply minimal, zero-bloat code modifications.");
    lines.push(`   - Execute \`${verifyCmd}\` and verify 100% clean exit code 0.`);
    lines.push("");
  }

  lines.push("## Objective & Acceptance Criteria");
  lines.push(`- **Goal**: ${promptBody}`);
  if (analysis.oracle.command) {
    lines.push(`- **Verification Command**: \`${analysis.oracle.command}\` (Must pass cleanly with exit code 0)`);
  }
  lines.push("- **Falsifiability Criteria**: Zero deleted tests, zero weakened assertions, zero lint errors.");
  lines.push("");

  if (analysis.paths.found.length > 0) {
    lines.push("## Primary Target Paths");
    for (const p of analysis.paths.found) {
      const pathTarget = p.exists ? p.token : (p.suggestion || p.token);
      lines.push(`- \`${pathTarget}\` (${p.exists ? "Verified" : "Corrected"})`);
    }
    lines.push("");
  }

  if (includeCriticGuidance) {
    lines.push("## Internal Critic Agent Focus (Adversarial Pre-Review)");
    lines.push("Before submitting pull request, ensure the patch satisfies:");
    lines.push("- [ ] Correctness: Functions handle all edge-case arguments and invalid input types.");
    lines.push("- [ ] Complexity: No accidental O(n²) bottlenecks or memory leak allocations.");
    if (isWeb) {
      lines.push("- [ ] Web Integrity: Zero layout shifts (CLS), broken images, or missing accessible ARIA attributes.");
    }
    lines.push("- [ ] Security: No unescaped user inputs, leaked tokens, or unauthorized network calls.");
    lines.push("");
  }

  lines.push("## Standard Guardrails");
  lines.push("- Do NOT modify package.json, lockfiles, or .github/ infrastructure files.");
  lines.push("- Diff Payload Governor: Keep total diff payload under 75 KB (\`git diff | wc -c\`).");
  lines.push(`- Verify before finishing: Execute \`${verifyCmd}\` and confirm zero errors.`);

  const optimizedPrompt = lines.join("\n");

  return {
    optimizedPrompt,
    analysis
  };
}
