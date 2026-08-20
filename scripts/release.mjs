#!/usr/bin/env node

/**
 * Automated Release Orchestrator script for jules-orchestrator-kit.
 * Verifies test suite, updates git tags, and creates GitHub Release via gh CLI.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { resolveRoot } from "../src/config.mjs";

const root = resolveRoot();
const pkgPath = join(root, "package.json");
const changelogPath = join(root, "CHANGELOG.md");

if (!existsSync(pkgPath)) {
  console.error("❌ Error: package.json not found.");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
const version = pkg.version;
const tagName = `v${version}`;

console.log(`🚀 Automated Release Pipeline for ${pkg.name} (${tagName})`);
console.log("-------------------------------------------------------");

// 1. Verify test suite. Output is captured (not inherited) so the doc-sync gate
//    below can reuse the counts instead of running the suite a second time.
console.log("1. Running unit test verification suite...");
let testOutput = "";
try {
  testOutput = execSync("npm test", { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  const summary = testOutput.match(/^[^\n]*?ℹ\s*(?:tests|suites|pass|fail|todo)\s+\d+\s*$/gm) || [];
  summary.forEach((l) => console.log(`   ${l.trim()}`));
  console.log("   ✅ Test suite passed cleanly.\n");
} catch (err) {
  console.error(`${err.stdout || ""}${err.stderr || ""}`);
  console.error("❌ Release Aborted: Test suite failed.");
  process.exit(1);
}

// 1b. Documentation / version consistency gate (blocking).
console.log("1b. Verifying documentation is in sync with package.json & test suite...");
{
  const { checkDocSync, parseTestCounts } = await import("./doc-sync-check.mjs");
  const counts = parseTestCounts(testOutput);
  const docRes = checkDocSync(root, { tests: counts.pass, suites: counts.suites });
  for (const c of docRes.checks) {
    console.log(`   ${c.ok ? "✅" : "❌"} ${c.name.padEnd(32)} ${c.detail}`);
  }
  if (!docRes.ok) {
    console.error("\n❌ Release Aborted: documentation has drifted. Fix the ❌ rows above and re-run.");
    process.exit(1);
  }
  console.log("   ✅ Documentation is in sync.\n");
}

// 2. Extract release notes from CHANGELOG.md
console.log(`2. Extracting release notes for ${tagName} from CHANGELOG.md...`);
let notes = "";
if (existsSync(changelogPath)) {
  const changelog = readFileSync(changelogPath, "utf-8");
  const regex = new RegExp(`## \\[${version}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n## \\[|$)`, "i");
  const match = changelog.match(regex);
  if (match && match[1]) {
    notes = match[1].trim();
  }
}

if (!notes) {
  notes = `Release ${tagName}`;
  console.log("   ⚠️ Warning: Release entry not found in CHANGELOG.md, using default title.");
} else {
  console.log("   ✅ Extracted release notes from CHANGELOG.md.\n");
}

// 3. Create Git Tag if not exists (or update if version mismatch)
console.log(`3. Checking Git tag ${tagName}...`);
try {
  const tags = execSync("git tag -l", { cwd: root, encoding: "utf-8" }).split("\n").map((t) => t.trim());
  if (tags.includes(tagName)) {
    let taggedVersion = "";
    try {
      const rawPkg = execSync(`git show ${tagName}:package.json`, { cwd: root, encoding: "utf-8" });
      taggedVersion = JSON.parse(rawPkg).version;
    } catch (_) {}
    if (taggedVersion && taggedVersion !== version) {
      console.log(`   ⚠️ Tag ${tagName} points to package.json version ${taggedVersion}. Updating tag to HEAD (${version})...`);
      execSync(`git tag -f -a ${tagName} -m "${pkg.name} ${tagName}"`, { cwd: root, stdio: "inherit" });
    } else {
      console.log(`   ℹ️ Git tag ${tagName} already exists.`);
    }
  } else {
    execSync(`git tag -a ${tagName} -m "${pkg.name} ${tagName}"`, { cwd: root, stdio: "inherit" });
    console.log(`   ✅ Created Git tag ${tagName}.`);
  }
} catch (err) {
  console.error(`❌ Tagging failed: ${err.message}`);
  process.exit(1);
}

// 4. Push git commits and tag to origin
console.log(`4. Pushing main and tag ${tagName} to origin...`);
try {
  execSync("git push origin main", { cwd: root, stdio: "inherit" });
  execSync(`git push origin ${tagName}`, { cwd: root, stdio: "inherit" });
  console.log("   ✅ Pushed commits and tag to origin.\n");
} catch (err) {
  console.error(`❌ Push failed: ${err.message}`);
  process.exit(1);
}

// 5. Create GitHub Release via gh CLI
console.log(`5. Creating GitHub Release via gh CLI...`);
try {
  const notesFile = join(root, ".agent", "temp_release_notes.txt");
  const fs = await import("node:fs");
  fs.writeFileSync(notesFile, notes, "utf-8");
  
  execSync(`gh release create ${tagName} --title "${tagName}" --notes-file "${notesFile}"`, {
    cwd: root,
    stdio: "inherit",
  });
  
  if (fs.existsSync(notesFile)) fs.unlinkSync(notesFile);
  console.log(`   🎉 GitHub Release ${tagName} created successfully!`);
} catch (err) {
  console.log(`   ℹ️ Note: gh release creation finished or already exists.`);
}

console.log("-------------------------------------------------------");
console.log(`✅ Release ${tagName} Completed Successfully!\n`);
