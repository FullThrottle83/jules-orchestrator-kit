import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { resolveWorkspaceExecutionBoundary } from "./command-resolver.mjs";
import { log, hasHighConfidenceSecret, hasLowConfidenceSecret } from "./utils.mjs";

function runGitCommand(args, ignoreError = false) {
  try {
    return execFileSync("git", args, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", ignoreError ? "ignore" : "pipe"],
    }).trim();
  } catch (error) {
    if (ignoreError) return "";
    const err = new Error(`Git command failed: git ${args.join(" ")}\n${error.message}`);
    err.code = 1;
    throw err;
  }
}

export function matchGlob(filepath, globPattern) {
  const cleanPath = filepath.replace(/\\/g, "/").replace(/^\.\//, "");
  // Normalize consecutive glob wildcards (e.g., "**/**" -> "**")
  const normalizedGlob = globPattern.replace(/\\/g, "/").replace(/(?:\*\*\/)+/g, "**/");
  const segments = normalizedGlob.split("/");
  const regexParts = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === "**") {
      regexParts.push("**");
    } else {
      regexParts.push(
        seg
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, "[^/]*")
          .replace(/\?/g, "[^/]")
      );
    }
  }
  let patternStr = regexParts.join("/");
  patternStr = patternStr.replace(/(?:^|\/)\*\*(?:\/|$)/g, (m) => {
    if (m === "**") return ".*";
    if (m === "/**/") return "(?:/|/.*/)";
    if (m === "/**") return "(?:/.*)?";
    if (m === "**/") return "(?:.*/)?";
    return ".*";
  });
  patternStr = patternStr.replace(/\*\*/g, ".*");
  return new RegExp(`^${patternStr}$`, "i").test(cleanPath);
}


export const EXECUTION_CONFIG_FILES = [
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "pnpmfile.js",
  "pnpmfile.cjs",
  ".pnpmfile.cjs",
  "jest.config.js",
  "jest.config.cjs",
  "jest.config.mjs",
  "jest.config.ts",
  "vitest.config.js",
  "vitest.config.cjs",
  "vitest.config.mjs",
  "vitest.config.ts",
  "playwright.config.js",
  "playwright.config.ts",
  "vite.config.js",
  "vite.config.ts",
  "webpack.config.js",
  "webpack.config.cjs",
  "webpack.config.mjs",
  "rollup.config.js",
  "rollup.config.mjs",
  "esbuild.config.js",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "babel.config.js",
  "babel.config.cjs",
  "babel.config.json",
  ".babelrc",
  "tsconfig.json",
  "tsconfig.*.json",
  "deno.json",
  "deno.jsonc",
  "bunfig.toml"
];

export const RESTRICTED_AGENT_FILES = [
  "AGENTS.md",
  "JULES_RULES_TEMPLATE.md",
  ".agent/rules/**",
  ".agent/workflows/**",
  ".agent/jules.yml",
  "jules.config.json"
];

export const COMMAND_DEFINING_FILES = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lockb",
  "turbo.json",
  "nx.json",
  "lerna.json",
  "rush.json",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "pyproject.toml",
  "setup.py",
  "requirements.txt",
  "Makefile",
  "build.gradle",
  "build.gradle.kts",
  "pom.xml",
  ".agent/jules.yml",
  "jules.config.json"
];

/**
 * Lightweight Zero-Dependency YAML Pattern Extractor
 * Extracts forbidden_paths and allow_paths arrays from jules.yml.
 * Supported subset:
 *  - Flow style arrays: forbidden_paths: ["path1", "path2"]
 *  - Block style arrays: forbidden_paths:\n  - path1\n  - path2
 * Limitations: Does not support multiline strings (|/>), nested dicts, or inline comments.
 */
export function loadForbiddenPatterns(configContent = "") {
  const defaultForbidden = [
    ".github/**",
    "**/secrets/**",
    "**/*.pem",
    "**/lock-manager/**",
    "scripts/jules-*",
    ".agent/jules.yml"
  ];
  if (!configContent) return defaultForbidden;

  // Flow style: forbidden_paths: [...]
  const flowMatch = configContent.match(/forbidden_paths:\s*\[([^\]]+)\]/);
  if (flowMatch) {
    const parsed = flowMatch[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    return Array.from(new Set([...defaultForbidden, ...parsed]));
  }

  // Block style: forbidden_paths:\n  - "path1"\n  - "path2"
  const lines = configContent.split("\n");
  let inForbidden = false;
  const blockParsed = [];
  for (const line of lines) {
    if (line.trim().startsWith("forbidden_paths:")) {
      inForbidden = true;
      continue;
    }
    if (inForbidden) {
      const trimmed = line.trim();
      if (trimmed.startsWith("-")) {
        blockParsed.push(trimmed.slice(1).trim().replace(/^["']|["']$/g, ""));
      } else if (trimmed && !trimmed.startsWith("#")) {
        break;
      }
    }
  }
  if (blockParsed.length > 0) {
    return Array.from(new Set([...defaultForbidden, ...blockParsed]));
  }

  return defaultForbidden;
}

export function loadAllowedPatterns(configContent = "") {
  if (!configContent) return [];
  const flowMatch = configContent.match(/allow_paths:\s*\[([^\]]+)\]/);
  if (flowMatch) {
    return flowMatch[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  }
  const lines = configContent.split("\n");
  let inAllow = false;
  const blockParsed = [];
  for (const line of lines) {
    if (line.trim().startsWith("allow_paths:")) {
      inAllow = true;
      continue;
    }
    if (inAllow) {
      const trimmed = line.trim();
      if (trimmed.startsWith("-")) {
        blockParsed.push(trimmed.slice(1).trim().replace(/^["']|["']$/g, ""));
      } else if (trimmed && !trimmed.startsWith("#")) {
        break;
      }
    }
  }
  return blockParsed;
}

export function parseAndCleanStderr(stderrStr) {
  if (!stderrStr) return "";
  const clean = stderrStr.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
  const lines = clean.split("\n").filter(Boolean);
  return lines.slice(-100).join("\n");
}

export function getOodaStateFile(mergeBase = "main") {
  const oodaDir = path.resolve(process.cwd(), ".agent/state/ooda");
  if (!fs.existsSync(oodaDir)) fs.mkdirSync(oodaDir, { recursive: true });

  const keyInput = [
    process.env.GITHUB_REPOSITORY || "",
    process.env.GITHUB_REF || "",
    process.env.GITHUB_HEAD_REF || "",
    mergeBase,
    process.cwd()
  ].join("\u0000");

  const key = crypto.createHash("sha256").update(keyInput).digest("hex").slice(0, 16);
  return path.join(oodaDir, `${key}.json`);
}

export function logAuditMetrics(metrics) {
  const historyDir = path.resolve(process.cwd(), ".agent/history");
  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true });
  }
  const metricsFile = path.join(historyDir, "metrics.jsonl");
  const logLine = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...metrics,
  }) + "\n";
  fs.appendFileSync(metricsFile, logLine, "utf-8");
}

export function runSelfAudit() {
  log.header("Running Jules PR Self-Audit Gatekeeper...");

  const targetBranch = process.env.BASE_BRANCH || "main";
  const SAFE_BRANCH = /^[a-zA-Z0-9._\/-]+$/;
  if (!SAFE_BRANCH.test(targetBranch)) {
    const err = new Error(`FATAL: Invalid BASE_BRANCH "${targetBranch}". Must match ^[a-zA-Z0-9._\\/-]+$`);
    err.code = 2;
    throw err;
  }
  log.info(`Target Branch: ${targetBranch}`);

  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    const err = new Error("FATAL: git is not installed or not in PATH.");
    err.code = 2;
    throw err;
  }

  if (process.env.CI) {
    log.info("☁️ CI environment detected. Fetching merge-base history...");
    runGitCommand(["fetch", "origin", targetBranch, "--depth=100"], true);
    const tmpRef = runGitCommand(["rev-parse", "--verify", `origin/${targetBranch}`], true) ? `origin/${targetBranch}` : targetBranch;
    const tmpMerge = runGitCommand(["merge-base", "HEAD", tmpRef], true);
    if (!tmpMerge) {
      log.warn("Shallow fetch failed to find merge-base, executing full unshallow...");
      runGitCommand(["fetch", "origin", targetBranch, "--unshallow"], true);
    }
  }

  const mainRef = runGitCommand(["rev-parse", "--verify", `origin/${targetBranch}`], true) ? `origin/${targetBranch}` : targetBranch;
  const mergeBase = runGitCommand(["merge-base", "HEAD", mainRef], true);

  if (!mergeBase) {
    const err = new Error(`FATAL: Could not compute merge-base with ${mainRef}. Make sure git history is unshallowed.`);
    err.code = 2;
    throw err;
  }

  log.info(`Merge-Base Hash: ${mergeBase}`);

  const rawDiffFiles = runGitCommand(["diff", "-z", "--name-only", `${mergeBase}...HEAD`])
    .split("\0")
    .map((f) => f.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);

  const ALL_COMMAND_FILES = [...COMMAND_DEFINING_FILES, ...EXECUTION_CONFIG_FILES];
  const commandFileChanges = rawDiffFiles.filter((file) =>
    ALL_COMMAND_FILES.some((cmdFile) => file === cmdFile || file.endsWith(`/${cmdFile}`) || matchGlob(file, cmdFile))
  );

  if (commandFileChanges.length > 0 && process.env.JULES_ALLOW_COMMAND_FILE_CHANGES !== "true" && process.env.JULES_ALLOW_COMMAND_FILE_CHANGES !== "1") {
    const err = new Error(
      "COMMAND / BUILD CONFIG FILE CHANGE DETECTED: [" + commandFileChanges.join(", ") + "]. " +
      "Refusing to execute verification scripts from untrusted branch. " +
      "To override for legitimate dependency updates, set JULES_ALLOW_COMMAND_FILE_CHANGES=true."
    );
    err.code = 3;
    throw err;
  }

  const agentRuleChanges = rawDiffFiles.filter((file) =>
    RESTRICTED_AGENT_FILES.some((pattern) => matchGlob(file, pattern))
  );

  if (agentRuleChanges.length > 0 && process.env.JULES_ALLOW_AGENT_RULE_CHANGES !== "true" && process.env.JULES_ALLOW_AGENT_RULE_CHANGES !== "1") {
    const err = new Error(
      "AGENT RULE FILE CHANGE DETECTED: [" + agentRuleChanges.join(", ") + "]. " +
      "Refusing to load agent rules from untrusted branch. " +
      "To override for legitimate rule updates, set JULES_ALLOW_AGENT_RULE_CHANGES=true."
    );
    err.code = 3;
    throw err;
  }

  const isBloatFile = (file) => /(\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.png|\.jpg|\.jpeg|\.pdf|\.min\.js|\.map)$/i.test(file);
  const changedCodeFiles = rawDiffFiles.filter((f) => !isBloatFile(f));

  log.info(`Modified Code Files (${changedCodeFiles.length} of ${rawDiffFiles.length} total changes):`);
  changedCodeFiles.forEach((file) => log.dim(`   - ${file}`));

  // Fail closed: Load security config exclusively from base branch (mainRef).
  // Never fall back to working-tree config which an untrusted PR could craft.
  const trustedConfig = runGitCommand(["show", `${mainRef}:.agent/jules.yml`], true);
  const forbiddenPatterns = loadForbiddenPatterns(trustedConfig);
  const allowedPatterns = loadAllowedPatterns(trustedConfig);

  const violationsWithDetails = [];
  rawDiffFiles.forEach((file) => {
    const matchedForbidden = forbiddenPatterns.find((pattern) => matchGlob(file, pattern));
    if (matchedForbidden) {
      violationsWithDetails.push(`${file} (matched forbidden pattern '${matchedForbidden}')`);
      return;
    }
    if (allowedPatterns.length > 0) {
      const isAllowed = allowedPatterns.some((pattern) => matchGlob(file, pattern));
      if (!isAllowed) {
        violationsWithDetails.push(`${file} (not permitted in allow_paths [${allowedPatterns.join(", ")}])`);
      }
    }
  });

  if (violationsWithDetails.length > 0) {
    const err = new Error(
      `RESTRICTED FILE VIOLATION DETECTED (config read from ${mainRef}:.agent/jules.yml):\n` +
      violationsWithDetails.map((v) => `  - ${v}`).join("\n") +
      "\nTo override restricted file checks, set JULES_ALLOW_RESTRICTED_FILES=true."
    );
    err.code = 3;
    throw err;
  }
  log.success("Restricted File Boundary Check: PASSED");

  log.info("Analyzing Code Diff Payload Size & Content...");
  const codeDiffPayload = changedCodeFiles.length > 0
    ? runGitCommand(["diff", `${mergeBase}...HEAD`, "--", ...changedCodeFiles], true)
    : "";

  const diffBytes = Buffer.byteLength(codeDiffPayload, "utf8");
  const maxDiffBytes = 75 * 1024; // 75 KB

  if (diffBytes > maxDiffBytes) {
    const err = new Error(`DIFF PAYLOAD TOO LARGE: ${diffBytes} bytes exceeds ${maxDiffBytes} bytes limit for code files. Split the task.`);
    err.code = 5;
    throw err;
  }
  
  const fullDiffPayload = runGitCommand(["diff", `${mergeBase}...HEAD`], true);
  const addedLines = fullDiffPayload
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");

  if (hasHighConfidenceSecret(addedLines)) {
    const err = new Error("SECRET LEAK PREVENTED: High-confidence secret token or private key detected in added diff lines. Aborting.");
    err.code = 6;
    throw err;
  }

  if (hasLowConfidenceSecret(addedLines)) {
    log.warn("SECURITY WARNING: Low-confidence secret or test key pattern detected in added diff lines.");
  }
  log.success(`Diff Inspection Check: PASSED (${diffBytes} bytes code diff, No Active High-Confidence Secrets)`);

  log.info("Resolving Dynamic Verification Suite from Trusted Base Branch...");
  
  const runId = crypto.randomBytes(4).toString("hex");
  const trustedDir = path.join(os.tmpdir(), `jules-trusted-tree-${runId}`);
  const tempArchive = path.join(os.tmpdir(), `jules-trusted-archive-${runId}.tar`);
  
  let resolutionRoot;
  try {
    fs.mkdirSync(trustedDir, { recursive: true });
    execFileSync("git", ["archive", mainRef, "-o", tempArchive]);
    execFileSync("tar", ["-xf", tempArchive, "-C", trustedDir]);
    resolutionRoot = trustedDir;
  } catch (err) {
    const error = new Error("FATAL: Failed to extract trusted base branch for command resolution. Refusing to fall back to working tree.\n" + err.message);
    error.code = 2;
    throw error;
  }

  let resolvedCmds;
  try {
    resolvedCmds = resolveWorkspaceExecutionBoundary(changedCodeFiles, resolutionRoot);
  } finally {
    try {
      if (trustedDir && fs.existsSync(trustedDir)) {
        fs.rmSync(trustedDir, { recursive: true, force: true });
      }
      if (tempArchive && fs.existsSync(tempArchive)) {
        fs.rmSync(tempArchive, { force: true });
      }
    } catch (e) {}
  }

  log.info(`Discovered Execution Scope: ${resolvedCmds.source}`);

  const startTime = Date.now();
  let testPassed = true;
  let failureLog = "";

  const runVerification = (cmd) => {
    if (typeof cmd !== "string" || !cmd.trim()) {
      return false;
    }
    if (/[\r\n\0]/.test(cmd)) {
      log.error(`Security violation: Invalid control characters in command: ${cmd}`);
      failureLog = `Security violation: Invalid control characters in verification command`;
      return false;
    }
    try {
      execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      return true;
    } catch (err) {
      failureLog = parseAndCleanStderr((err.stderr || "") + "\n" + (err.stdout || "") + "\n" + (err.message || ""));
      return false;
    }
  };

  if (resolvedCmds.testCmd) {
    log.step("▶", `Running Test Verification: ${resolvedCmds.testCmd}`);
    if (!runVerification(resolvedCmds.testCmd)) {
      testPassed = false;
      log.error(`Test verification failed: ${resolvedCmds.testCmd}`);
    }
  }

  if (testPassed && resolvedCmds.buildCmd) {
    log.step("▶", `Running Build Verification: ${resolvedCmds.buildCmd}`);
    if (!runVerification(resolvedCmds.buildCmd)) {
      testPassed = false;
      log.error(`Build verification failed: ${resolvedCmds.buildCmd}`);
    }
  }

  if (!resolvedCmds.testCmd && !resolvedCmds.buildCmd) {
    log.info("No build or test scripts found. Running git status check.");
    execSync("git status", { stdio: "inherit" });
  }

  const durationMs = Date.now() - startTime;
  logAuditMetrics({
    targetBranch,
    changedFilesCount: changedCodeFiles.length,
    testPassed,
    durationMs,
    scope: resolvedCmds.source,
  });

  if (!testPassed) {
    log.error("OODA SELF-HEALING FEEDBACK LOG:");
    log.dim(failureLog.slice(-1500));

    if (process.env.CI && !process.env.ALLOW_AUTO_REPAIR) {
      const err = new Error("CI environment detected and ALLOW_AUTO_REPAIR is not set. Failing fast to save CI minutes.");
      err.code = 4;
      throw err;
    }

    let oodaRetries = 0;
    const oodaStateFile = getOodaStateFile(mergeBase);
    try {
      if (fs.existsSync(oodaStateFile)) {
        const oodaData = JSON.parse(fs.readFileSync(oodaStateFile, "utf-8"));
        oodaRetries = oodaData.attempts || 0;
      } else {
        const history = execSync("git log -n 5 --format=%B", { encoding: "utf-8" });
        const matches = history.match(/OODA Auto-Repair/gi);
        if (matches) {
          oodaRetries = matches.length;
        }
      }
    } catch (e) {
      // Ignore errors here
    }

    if (oodaRetries < 3) {
      log.info(`🛠️ Initiating OODA Auto-Repair (Attempt ${oodaRetries + 1}/3)...`);
      try {
        fs.writeFileSync(oodaStateFile, JSON.stringify({ attempts: oodaRetries + 1, lastAttempt: new Date().toISOString() }), "utf-8");
      } catch (e) {}
      const prompt = `OODA Auto-Repair Attempt ${oodaRetries + 1}\n\nThe verification suite failed with the following errors after the previous patch:\n\n\`\`\`\n${failureLog.slice(-1500)}\n\`\`\`\n\nPlease fix the errors so the verification passes.`;
      
      const dispatchScript = path.resolve(process.cwd(), "scripts/jules-dispatch.mjs");
      try {
        const env = { 
          ...process.env, 
          BASE_BRANCH: process.env.GITHUB_HEAD_REF || targetBranch 
        };
        execFileSync("node", [dispatchScript, "OODA Auto-Repair", prompt], {
          stdio: "inherit",
          env
        });
      } catch (dispatchErr) {
        log.error(`Failed to trigger OODA repair dispatch: ${dispatchErr.message}`);
      }
    } else {
      log.error("❌ OODA Auto-Repair exhausted maximum retries (3). Giving up.");
    }
    const err = new Error("OODA Auto-Repair failed or exhausted.");
    err.code = 4;
    throw err;
  }

  try {
    const oodaStateFile = getOodaStateFile(mergeBase);
    if (fs.existsSync(oodaStateFile)) {
      fs.rmSync(oodaStateFile, { force: true });
    }
  } catch (_) {}

  log.success("🎉 JULES PR SELF-AUDIT PASSED SUCCESSFULLY!");
}

export function runPreflightSandbox() {
  log.header("Initializing Pre-Flight Sandbox (Sterile Simulation)...");
  
  const runId = crypto.randomBytes(4).toString("hex");
  const sandboxDir = path.join(os.tmpdir(), `jules-preflight-${runId}`);
  const tempArchive = path.join(os.tmpdir(), `jules-archive-${runId}.tar`);
  
  try {
    log.step("[1/5]", `Creating isolated environment in ${sandboxDir}...`);
    fs.mkdirSync(sandboxDir, { recursive: true });
    
    execSync(`git archive HEAD -o "${tempArchive}"`);
    execSync(`tar -xf "${tempArchive}" -C "${sandboxDir}"`);
    
    log.step("[2/5]", "Sterilizing environment variables...");
    const sterileEnv = { ...process.env };
    const stripKeys = ["DATABASE_URL", "NPM_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "AWS_ACCESS_KEY_ID", "STRIPE_TEST_KEY"];
    for (const key of stripKeys) {
      if (sterileEnv[key]) {
        sterileEnv[key] = `mock-${key.toLowerCase()}`;
      }
    }
    
    log.step("[3/5]", "Resolving package manager and installing dependencies...");
    let installCmd = "";
    if (fs.existsSync(path.join(sandboxDir, "pnpm-lock.yaml"))) installCmd = "pnpm install --ignore-scripts";
    else if (fs.existsSync(path.join(sandboxDir, "bun.lockb"))) installCmd = "bun install --ignore-scripts";
    else if (fs.existsSync(path.join(sandboxDir, "yarn.lock"))) installCmd = "yarn install --ignore-scripts";
    else if (fs.existsSync(path.join(sandboxDir, "package-lock.json"))) installCmd = "npm ci --ignore-scripts";

    if (installCmd) {
      try {
        execSync(installCmd, { cwd: sandboxDir, stdio: "pipe", encoding: "utf-8" });
      } catch (e) {
        log.warn(`${installCmd} failed or wasn't needed. Output: ${e.stdout}\nError: ${e.stderr}\nProceeding...`);
      }
    } else {
      log.info("Skipping dependency installation (no lockfile detected).");
    }

    log.step("[4/5]", "Resolving execution boundary in sandbox...");
    const resolvedCmds = resolveWorkspaceExecutionBoundary([], sandboxDir);
    
    if (resolvedCmds.testCmd || resolvedCmds.buildCmd) {
      log.step("[5/5]", `Running verification: ${resolvedCmds.testCmd || resolvedCmds.buildCmd}`);
      execSync(resolvedCmds.testCmd || resolvedCmds.buildCmd, {
        cwd: sandboxDir,
        env: sterileEnv,
        stdio: "inherit"
      });
      log.success("Pre-Flight Passed. Zero epistemic drift detected.");
    } else {
      log.info("No test/build commands found for verification.");
      log.success("Pre-Flight Passed (No-Op).");
    }
  } catch (err) {
    log.error("\nPRE-FLIGHT FAILED!");
    log.error("The agent would likely crash (The 5-Minute Drop-off) in the Web UI due to missing dependencies.");
    const wrappedErr = new Error(err.message);
    wrappedErr.code = 1;
    throw wrappedErr;
  } finally {
    try {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
      if (fs.existsSync(tempArchive)) {
        fs.rmSync(tempArchive, { force: true });
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

// Execute when invoked directly from CLI
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv.includes("--preflight")) {
      runPreflightSandbox();
    } else {
      runSelfAudit();
    }
  } catch (err) {
    if (err.message) log.error(err.message);
    process.exit(err.code || 1);
  }
}


