import { execSync } from "node:child_process";
import { resolveProjectCommands } from "./command-resolver.mjs";

console.log("🔍 Running Jules PR Self-Audit Gatekeeper...\n");

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

// 1. Resolve target branch and merge-base with shallow clone defense
const targetBranch = process.env.BASE_BRANCH || "main";
console.log(`🎯 Target Branch: ${targetBranch}`);

// In CI runners (e.g. GitHub Actions), unshallow history if shallow
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

// 2. Fetch modified files and filter out lockfiles & binary bloat
const rawDiffFiles = runCommand(`git diff --name-only ${mergeBase}...HEAD`)
  .split("\n")
  .map((f) => f.trim())
  .filter(Boolean);

// Token-Protection: Ignore lockfiles and binary assets
const isBloatFile = (file) => /(\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.png|\.jpg|\.jpeg|\.pdf|\.min\.js|\.map)$/i.test(file);
const changedCodeFiles = rawDiffFiles.filter((f) => !isBloatFile(f));

console.log(`\n📄 Modified Code Files (${changedCodeFiles.length} of ${rawDiffFiles.length} total changes):`);
changedCodeFiles.forEach((file) => console.log(`   - ${file}`));

// 3. Restricted File Boundary Check
const restrictedPatterns = [/\.github\//, /^scripts\/lock-manager/, /secrets/i];
const violations = rawDiffFiles.filter((file) =>
  restrictedPatterns.some((pattern) => pattern.test(file))
);

if (violations.length > 0) {
  console.error("\n❌ RESTRICTED FILE VIOLATION DETECTED!");
  console.error("Jules PR attempted to modify forbidden system files:");
  violations.forEach((v) => console.error(`   - ${v}`));
  process.exit(1);
}
console.log("\n✅ Restricted File Boundary Check: PASSED");

// 4. Dynamic Verification Suite Execution
console.log("\n🛠️ Resolving Dynamic Verification Suite...");
const resolvedCmds = resolveProjectCommands(process.cwd());
console.log(`📋 Discovered Manifest Source: ${resolvedCmds.source}`);

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
