#!/usr/bin/env node

/**
 * Automated Release Orchestrator script for jules-orchestrator-kit.
 * Verifies the release commit, validates its signed tag and creates a GitHub Release.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { resolveRoot } from "../src/config.mjs";
import { readReleaseHead, ensureReleaseTag, pushReleaseRefs, createGithubRelease } from "./release-control.mjs";

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

let verifiedHead;
try {
  verifiedHead = readReleaseHead(root);
} catch (err) {
  console.error(`Release aborted: ${err.message}`);
  process.exit(1);
}

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

// 1a. Activation coverage (blocking).
//
// Step 1 proved the suite is green. Green is only evidence if the guards were
// switched on: a check that silently stopped applying contributes passing
// tests and a zero exit code exactly like one that ran. This asks the question
// the suite cannot — can every blocking guard still be made red? — and it runs
// before the doc-sync gate because a silent guard makes every later signal
// meaningless.
console.log("1a. Verifying every blocking guard can still be made red...");
try {
  execSync("node scripts/guard-reach-check.mjs", { cwd: root, stdio: "inherit" });
  console.log("");
} catch (_) {
  console.error("\n❌ Release Aborted: a guard has gone silent. See the failing rows above.");
  process.exit(1);
}

// Step 1a proved the guards work here. Here is not where users run them.
//
// Every signal so far was measured in the source tree, where every file
// exists by construction. What ships is a tarball built from the `files`
// list, and v0.63.0 published the guard-reach check without the policy
// contract it imports — green suite, green matrix, green release, and a
// module that threw ERR_MODULE_NOT_FOUND the moment anyone installed it.
console.log("1a-2. Verifying the package we would publish is self-contained...");
try {
  execSync("node scripts/package-integrity-check.mjs", { cwd: root, stdio: "inherit" });
  console.log("");
} catch (_) {
  console.error("\n❌ Release Aborted: the tarball is not what the source tree looks like.");
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

// 1c. Continuous-integration gate (blocking). Step 1 ran the suite on this one
//     machine. Every cross-platform break this repository has shipped was green
//     locally and red on the matrix — a forward-slash path assertion, a
//     case-folded deny rule — so a local pass says nothing about Windows or
//     macOS. `gh` resolves the repository from the git remote, so this is not
//     specific to any one fork.
console.log("1c. Verifying CI is green for HEAD...");
if (process.argv.includes("--skip-ci-check")) {
  console.log("   ⚠️ Skipped via --skip-ci-check.\n");
} else {
  const headSha = verifiedHead;
  let runs;
  try {
    const raw = execSync("gh run list --limit 40 --json headSha,status,conclusion,workflowName,url", {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    runs = JSON.parse(raw).filter((r) => r.headSha === headSha);
  } catch {
    console.error("❌ Release Aborted: could not query CI status via `gh`.");
    console.error("   Restore gh access, or independently verify CI for this exact commit before using --skip-ci-check.");
    process.exit(1);
  }

  if (runs.length === 0) {
    console.error(`❌ Release Aborted: no CI run found for HEAD (${headSha.slice(0, 7)}).`);
    console.error("   Push the commit and let CI finish for this exact HEAD before releasing.");
    process.exit(1);
  }

  // A run that is still going is not a pass. Releasing on a pending matrix is
  // exactly how a red Windows job gets published.
  const pending = runs.filter((r) => r.status !== "completed");
  const failed = runs.filter((r) => !["success", "skipped", "neutral"].includes(r.conclusion));

  for (const r of runs) {
    const state = r.status !== "completed" ? r.status : r.conclusion;
    const mark = pending.includes(r) ? "⏳" : failed.includes(r) ? "❌" : "✅";
    console.log(`   ${mark} ${r.workflowName.padEnd(32)} ${state}`);
  }

  if (pending.length > 0) {
    console.error(`\n❌ Release Aborted: ${pending.length} CI run(s) still in progress for HEAD.`);
    console.error(`   Wait for them to finish: ${pending[0].url}`);
    process.exit(1);
  }
  if (failed.length > 0) {
    console.error(`\n❌ Release Aborted: ${failed.length} CI run(s) not green for HEAD.`);
    for (const r of failed) console.error(`   ${r.workflowName}: ${r.conclusion} — ${r.url}`);
    process.exit(1);
  }
  console.log(`   ✅ All ${runs.length} CI run(s) green for ${headSha.slice(0, 7)}.\n`);
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

// 3. Bind a signed tag to the exact clean main commit verified above.
console.log(`3. Checking signed Git tag ${tagName}...`);
try {
  ensureReleaseTag(root, { tagName, headSha: verifiedHead, packageName: pkg.name });
} catch (err) {
  console.error(`Release aborted: ${err.message}`);
  process.exit(1);
}

// 4. Push git commits and tag to origin
console.log(`4. Pushing main and tag ${tagName} to origin...`);
try {
  pushReleaseRefs(root, { headSha: verifiedHead, tagName });
  console.log("   ✅ Pushed commits and tag to origin.\n");
} catch (err) {
  console.error(`❌ Push failed: ${err.message}`);
  process.exit(1);
}

// 5. Create GitHub Release via gh CLI
console.log(`5. Creating GitHub Release via gh CLI...`);
try {
  createGithubRelease(root, { tagName, notes });
  console.log(`GitHub Release ${tagName} created successfully.`);
} catch (err) {
  console.error(`Release aborted: GitHub Release creation failed: ${err.message}`);
  process.exit(1);
}

console.log("-------------------------------------------------------");
console.log(`✅ Release ${tagName} Completed Successfully!\n`);
