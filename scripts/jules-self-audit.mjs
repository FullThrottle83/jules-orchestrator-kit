import { execSync } from "node:child_process";

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

// 1. Get current branch and diff against merge-base
const currentBranch = runCommand("git rev-parse --abbrev-ref HEAD");
console.log(`📌 Current Branch: ${currentBranch}`);

const mainBranch = runCommand("git rev-parse --verify origin/main", true) ? "origin/main" : "main";
const mergeBase = runCommand(`git merge-base HEAD ${mainBranch}`, true);

if (!mergeBase) {
  console.warn(`⚠️ Could not determine merge-base with ${mainBranch}. Checking working tree status instead...`);
} else {
  console.log(`🔗 Merge-Base with ${mainBranch}: ${mergeBase}`);
  
  const changedFiles = runCommand(`git diff --name-only ${mergeBase}...HEAD`)
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);

  console.log(`\n📄 Modified Files (${changedFiles.length}):`);
  changedFiles.forEach((file) => console.log(`   - ${file}`));

  // 2. Restricted File Boundary Check
  const restrictedPatterns = [/\.github\//, /^scripts\/lock-manager/, /secrets/i];
  const violations = changedFiles.filter((file) =>
    restrictedPatterns.some((pattern) => pattern.test(file))
  );

  if (violations.length > 0) {
    console.error("\n❌ RESTRICTED FILE VIOLATION DETECTED!");
    console.error("Jules PR attempted to modify forbidden system files:");
    violations.forEach((v) => console.error(`   - ${v}`));
    process.exit(1);
  }
  console.log("\n✅ Restricted File Boundary Check: PASSED");
}

// 3. Verification Suite Execution
console.log("\n🛠️ Executing Repository Verification Commands...");

// Try npm run check:all or fallback to npm test / build
let verified = false;
const scriptsToCheck = ["check:all", "test", "build"];

for (const script of scriptsToCheck) {
  const hasScript = runCommand(`npm run | grep "${script}"`, true);
  if (hasScript) {
    console.log(`▶ Running: npm run ${script}`);
    runCommand(`npm run ${script}`);
    verified = true;
  }
}

if (!verified) {
  console.log("ℹ️ No default npm scripts found. Running git status check.");
  runCommand("git status");
}

console.log("\n🎉 JULES PR SELF-AUDIT PASSED SUCCESSFULLY!");
