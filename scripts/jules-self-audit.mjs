import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { resolveWorkspaceExecutionBoundary } from "./command-resolver.mjs";
import { log, logToHistory } from "./utils.mjs";

function runGitCommand(args, ignoreError = false) {
  try {
    return execFileSync("git", args, { encoding: "utf-8" }).trim();
  } catch (error) {
    if (ignoreError) return "";
    log.error(`Git command failed: git ${args.join(" ")}`);
    log.error(error.message);
    process.exit(1);
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
          .replace(/\?/g, ".")
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
    log.error(`FATAL: Invalid BASE_BRANCH "${targetBranch}". Must match ^[a-zA-Z0-9._\\/-]+$`);
    process.exit(1);
  }
  log.info(`Target Branch: ${targetBranch}`);

  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    log.error("FATAL: git is not installed or not in PATH.");
    process.exit(1);
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
    log.error(`FATAL: Could not compute merge-base with ${mainRef}. Make sure git history is unshallowed.`);
    process.exit(1);
  }

  log.info(`Merge-Base Hash: ${mergeBase}`);

  const rawDiffFiles = runGitCommand(["diff", "-z", "--name-only", `${mergeBase}...HEAD`])
    .split("\0")
    .map((f) => f.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);

  const isBloatFile = (file) => /(\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.png|\.jpg|\.jpeg|\.pdf|\.min\.js|\.map)$/i.test(file);
  const changedCodeFiles = rawDiffFiles.filter((f) => !isBloatFile(f));

  log.info(`Modified Code Files (${changedCodeFiles.length} of ${rawDiffFiles.length} total changes):`);
  changedCodeFiles.forEach((file) => log.dim(`   - ${file}`));

  // Fail closed: Load security config exclusively from base branch (mainRef).
  // Never fall back to working-tree config which an untrusted PR could craft.
  const trustedConfig = runGitCommand(["show", `${mainRef}:.agent/jules.yml`], true);
  const forbiddenPatterns = loadForbiddenPatterns(trustedConfig);
  const allowedPatterns = loadAllowedPatterns(trustedConfig);

  const violations = rawDiffFiles.filter((file) => {
    const isForbidden = forbiddenPatterns.some((pattern) => matchGlob(file, pattern));
    if (!isForbidden) return false;
    const isAllowed = allowedPatterns.some((pattern) => matchGlob(file, pattern));
    return !isAllowed;
  });

  if (violations.length > 0) {
    log.error("RESTRICTED FILE VIOLATION DETECTED!");
    log.error("Jules PR attempted to modify forbidden system files:");
    violations.forEach((v) => log.error(`   - ${v}`));
    process.exit(1);
  }
  log.success("Restricted File Boundary Check: PASSED");

  log.info("Resolving Dynamic Verification Suite...");
  const resolvedCmds = resolveWorkspaceExecutionBoundary(changedCodeFiles, process.cwd());
  log.info(`Discovered Execution Scope: ${resolvedCmds.source}`);

  const startTime = Date.now();
  let testPassed = true;
  let failureLog = "";

  const runVerification = (cmd) => {
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
    runCommand("git status");
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

    // OODA Circuit Breaker: Fingerprint failure trace using SHA-256
    const normalizedError = failureLog
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/g, "TIMESTAMP")
      .replace(/0x[0-9a-fA-F]+/g, "HEX")
      .replace(/\d+/g, "NUM")
      .trim();
    const errorHash = crypto.createHash("sha256").update(normalizedError).digest("hex");

    const circuitFile = path.resolve(process.cwd(), ".agent/history/ooda-circuit.json");
    let prevCircuit = { hash: "", count: 0 };
    if (fs.existsSync(circuitFile)) {
      try {
        prevCircuit = JSON.parse(fs.readFileSync(circuitFile, "utf-8"));
      } catch (_) {}
    }

    if (prevCircuit.hash === errorHash && prevCircuit.count >= 1) {
      log.error("\n❌ OODA CIRCUIT BREAKER TRIPPED: Consecutive identical failure detected.");
      log.error("Agent generated code with identical error trace twice in a row. Aborting auto-repair.");
      try {
        fs.writeFileSync(circuitFile, JSON.stringify({ hash: "", count: 0 }));
      } catch (_) {}
      process.exit(1);
    }

    try {
      fs.writeFileSync(
        circuitFile,
        JSON.stringify({
          hash: errorHash,
          count: prevCircuit.hash === errorHash ? prevCircuit.count + 1 : 1,
          updatedAt: new Date().toISOString()
        })
      );
    } catch (_) {}

    let oodaRetries = 0;
    try {
      const history = execSync("git log -n 5 --format=%B", { encoding: "utf-8" });
      const matches = history.match(/OODA Auto-Repair/gi);
      if (matches) {
        oodaRetries = matches.length;
      }
    } catch (e) {
      // Ignorera git-fel här
    }

    if (oodaRetries < 3) {
      log.info(`\n🛠️ Initiating OODA Auto-Repair (Attempt ${oodaRetries + 1}/3)...`);
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
      log.error("\n❌ OODA Auto-Repair exhausted maximum retries (3). Giving up.");
    }
    
    process.exit(1);
  }

  log.success("\n🎉 JULES PR SELF-AUDIT PASSED SUCCESSFULLY!");
}

function runPreflightSandbox() {
  log.header("Initializing Pre-Flight Sandbox (Steril Simulering)...");
  
  const runId = crypto.randomBytes(4).toString("hex");
  const sandboxDir = path.join(os.tmpdir(), `jules-preflight-${runId}`);
  const tempArchive = path.join(os.tmpdir(), `jules-archive-${runId}.tar`);
  
  try {
    log.step("[1/4]", `Skapar isolerad miljö i ${sandboxDir}...`);
    fs.mkdirSync(sandboxDir, { recursive: true });
    
    execSync(`git archive HEAD -o "${tempArchive}"`);
    execSync(`tar -xf "${tempArchive}" -C "${sandboxDir}"`);
    
    log.step("[2/4]", "Steriliserar miljövariabler...");
    const sterileEnv = { ...process.env };
    const stripKeys = ["DATABASE_URL", "NPM_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "AWS_ACCESS_KEY_ID", "STRIPE_TEST_KEY"];
    for (const key of stripKeys) {
      if (sterileEnv[key]) {
        sterileEnv[key] = `mock-${key.toLowerCase()}`;
      }
    }
    
    log.step("[3/4]", "Löser beroenden i sandlådan...");
    const resolvedCmds = resolveWorkspaceExecutionBoundary([], sandboxDir);
    
    if (resolvedCmds.testCmd || resolvedCmds.buildCmd) {
      log.step("[4/4]", `Kör verifiering: ${resolvedCmds.testCmd || resolvedCmds.buildCmd}`);
      execSync(resolvedCmds.testCmd || resolvedCmds.buildCmd, {
        cwd: sandboxDir,
        env: sterileEnv,
        stdio: "inherit"
      });
      log.success("Pre-Flight Passed. Zero epistemic drift detected.");
    } else {
      log.info("Inga test/bygg-kommandon hittades för verifiering.");
      log.success("Pre-Flight Passed (No-Op).");
    }
  } catch (err) {
    log.error("\nPRE-FLIGHT MISSLYCKADES!");
    log.error("Agenten skulle förmodligen krascha (The 5-Minute Drop-off) i Web UI på grund av saknade beroenden.");
    log.error(err.message);
    process.exit(1);
  } finally {
    try {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
      if (fs.existsSync(tempArchive)) {
        fs.rmSync(tempArchive, { force: true });
      }
    } catch (e) {
      // Ignorera fel vid cleanup
    }
  }
}

// Execute when invoked directly from CLI
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.includes("--preflight")) {
    runPreflightSandbox();
  } else {
    runSelfAudit();
  }
}


