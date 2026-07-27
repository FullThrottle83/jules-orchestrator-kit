import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorkspaceExecutionBoundary } from "./command-resolver.mjs";

function runCommand(cmd, ignoreError = false) {
  try {
    return execSync(cmd, { encoding: "utf-8" }).trim();
  } catch (error) {
    if (ignoreError) return "";
    console.error(`❌ Command failed: ${cmd}`);
    console.error(error.message);
    process.exit(1);
  }
}

export function matchGlob(filepath, globPattern) {
  const cleanPath = filepath.replace(/^\.\//, "");
  const segments = globPattern.split("/");
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
  patternStr = patternStr.replace(/(^|\/)\*\*(\/|$)/g, (m, p1, p2) => {
    if (p1 === "/" && p2 === "/") return "(?:/|/.*/)";
    if (p1 === "/") return "(?:/.*)?";
    if (p2 === "/") return "(?:.*/)?";
    return ".*";
  });
  return new RegExp(`^${patternStr}$`, "i").test(cleanPath);
}


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

export function runSelfAudit() {
  console.log("🔍 Running Jules PR Self-Audit Gatekeeper...\n");

  const targetBranch = process.env.BASE_BRANCH || "main";
  console.log(`🎯 Target Branch: ${targetBranch}`);

  if (process.env.CI) {
    console.log("☁️ CI environment detected. Fetching merge-base history...");
    runCommand(`git fetch origin ${targetBranch} --depth=100 || git fetch origin ${targetBranch} --unshallow`, true);
  }

  const mainRef = runCommand(`git rev-parse --verify origin/${targetBranch}`, true) ? `origin/${targetBranch}` : targetBranch;
  const mergeBase = runCommand(`git merge-base HEAD ${mainRef}`, true);

  if (!mergeBase) {
    console.error(`❌ FATAL: Could not compute merge-base with ${mainRef}. Make sure git history is unshallowed.`);
    process.exit(1);
  }

  console.log(`🔗 Merge-Base Hash: ${mergeBase}`);

  const rawDiffFiles = runCommand(`git diff --name-only ${mergeBase}...HEAD`)
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);

  const isBloatFile = (file) => /(\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.png|\.jpg|\.jpeg|\.pdf|\.min\.js|\.map)$/i.test(file);
  const changedCodeFiles = rawDiffFiles.filter((f) => !isBloatFile(f));

  console.log(`\n📄 Modified Code Files (${changedCodeFiles.length} of ${rawDiffFiles.length} total changes):`);
  changedCodeFiles.forEach((file) => console.log(`   - ${file}`));

  // Fail closed: Load security config exclusively from base branch (mainRef).
  // Never fall back to working-tree config which an untrusted PR could craft.
  const trustedConfig = runCommand(`git show ${mainRef}:.agent/jules.yml`, true);
  const forbiddenPatterns = loadForbiddenPatterns(trustedConfig);
  const allowedPatterns = loadAllowedPatterns(trustedConfig);


  const violations = rawDiffFiles.filter((file) => {
    const isForbidden = forbiddenPatterns.some((pattern) => matchGlob(file, pattern));
    if (!isForbidden) return false;
    const isAllowed = allowedPatterns.some((pattern) => matchGlob(file, pattern));
    return !isAllowed;
  });

  if (violations.length > 0) {
    console.error("\n❌ RESTRICTED FILE VIOLATION DETECTED!");
    console.error("Jules PR attempted to modify forbidden system files:");
    violations.forEach((v) => console.error(`   - ${v}`));
    process.exit(1);
  }
  console.log("\n✅ Restricted File Boundary Check: PASSED");


  console.log("\n🛠️ Resolving Dynamic Verification Suite...");
  const resolvedCmds = resolveWorkspaceExecutionBoundary(changedCodeFiles, process.cwd());
  console.log(`📋 Discovered Execution Scope: ${resolvedCmds.source}`);

  if (resolvedCmds.testCmd) {
    console.log(`▶ Running Test Verification: ${resolvedCmds.testCmd}`);
    runCommand(resolvedCmds.testCmd);
  }
  if (resolvedCmds.buildCmd) {
    console.log(`▶ Running Build Verification: ${resolvedCmds.buildCmd}`);
    runCommand(resolvedCmds.buildCmd);
  }

  if (!resolvedCmds.testCmd && !resolvedCmds.buildCmd) {
    console.log("ℹ️ No build or test scripts found. Running git status check.");
    runCommand("git status");
  }

  console.log("\n🎉 JULES PR SELF-AUDIT PASSED SUCCESSFULLY!");
}

// Execute when invoked directly from CLI
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runSelfAudit();
}


