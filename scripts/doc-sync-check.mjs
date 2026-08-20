#!/usr/bin/env node

/**
 * Documentation / version consistency gate.
 *
 * Implements the `doc-sync-sentinel` preset advertised in src/wizard-init.mjs:
 * asserts that package.json, bin/agentctl.mjs, README.md, ROADMAP_V1.md and
 * CHANGELOG.md all agree on the current version, and that README's advertised
 * test counts match what the suite actually reports.
 *
 * Runs as a blocking step in scripts/release.mjs. Standalone usage:
 *   node scripts/doc-sync-check.mjs                 # runs the suite for counts
 *   node scripts/doc-sync-check.mjs --tests 429 --suites 59
 *   node scripts/doc-sync-check.mjs --json
 *
 * Exit codes: 0 = in sync, 1 = drift detected.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { resolveRoot } from "../src/config.mjs";

/**
 * Runs the unit suite and extracts the authoritative counts.
 *
 * README advertises *passing* tests, so `pass` — not `tests` — is the number
 * the documentation claim is compared against. The two diverge as soon as the
 * adversarial suite records a `todo` probe for a known gap.
 *
 * @param {string} root
 * @returns {{ tests: number|null, pass: number|null, suites: number|null, todo: number|null }}
 */
export function measureTestCounts(root = process.cwd()) {
  let out = "";
  try {
    out = execSync("npm test", { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    // A failing suite still prints its summary; parse whatever we got.
    out = `${err.stdout || ""}${err.stderr || ""}`;
  }
  return parseTestCounts(out);
}

/**
 * Parses node:test summary counters out of an already-captured run.
 * Accepts both the spec reporter ("ℹ tests 452") and tap ("# tests 452").
 * @param {string} out
 * @returns {{ tests: number|null, pass: number|null, suites: number|null, todo: number|null }}
 */
export function parseTestCounts(out = "") {
  const num = (key) => {
    const m = String(out).match(new RegExp(`^[^\\n]*?(?:ℹ|#)\\s*${key}\\s+(\\d+)\\s*$`, "m"));
    return m ? Number(m[1]) : null;
  };
  return { tests: num("tests"), pass: num("pass"), suites: num("suites"), todo: num("todo") };
}

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

/**
 * Version numbers that appear in shipped sources but do not describe this kit.
 * Kept as an explicit, justified list rather than a looser pattern, so a real
 * drift can never slip through by resembling one of these.
 */
const FOREIGN_VERSIONS = [
  { file: "src/ops/doctor-registry.mjs", value: "20.0.0", why: "minimum supported Node.js runtime" },
  { file: "src/ops/ide-scaffold.mjs", value: "2.0.0", why: "VS Code tasks.json schema version" },
  { file: "src/version.mjs", value: "0.0.0", why: "documented fallback when package.json is absent" },
];

function isForeignVersion(relPath, value) {
  return FOREIGN_VERSIONS.some((f) => f.file === relPath && f.value === value);
}

/** Every .mjs under `dir`, recursively. */
function listSourceFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listSourceFiles(full, acc);
    else if (entry.endsWith(".mjs")) acc.push(full);
  }
  return acc;
}

/**
 * Verifies documentation is in sync with package.json and the real test counts.
 * @param {string} [root]
 * @param {object} [opts]
 * @param {number} [opts.tests] Actual passing test count (measured if omitted).
 * @param {number} [opts.suites] Actual suite count (measured if omitted).
 * @returns {{ ok: boolean, version: string, checks: Array<{name: string, ok: boolean, detail: string}> }}
 */
export function checkDocSync(root = process.cwd(), opts = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
  const version = pkg.version;

  // 1. bin/agentctl.mjs — VERSION const, help banner, `version` command output.
  const cli = readIfExists(join(root, "bin", "agentctl.mjs"));
  if (cli === null) {
    add("agentctl present", false, "bin/agentctl.mjs not found");
  } else {
    // Either the version is derived from the manifest — which cannot drift —
    // or it is a literal, which must match. The derived form is preferred;
    // this check exists to stop a literal creeping back in unnoticed.
    const derived = /export const VERSION\s*=\s*KIT_VERSION/.test(cli);
    const constMatch = cli.match(/export const VERSION\s*=\s*"([^"]+)"/);
    if (derived) {
      const versionModule = readIfExists(join(root, "src", "version.mjs"));
      const readsManifest = Boolean(versionModule && /package\.json/.test(versionModule));
      add(
        "agentctl VERSION const",
        readsManifest,
        readsManifest ? "derived from package.json via src/version.mjs" : "VERSION derives from KIT_VERSION but src/version.mjs does not read package.json"
      );
    } else {
      add(
        "agentctl VERSION const",
        constMatch?.[1] === version,
        constMatch ? `found "${constMatch[1]}", expected "${version}"` : "no `export const VERSION` found"
      );
    }

    // Scan everything shipped, not just the CLI: the MCP server, dashboard and
    // init wizard each hardcoded a version and sat three minor releases behind
    // while this gate only ever looked at bin/agentctl.mjs and stayed green.
    const shipped = [
      ...listSourceFiles(join(root, "src")),
      join(root, "bin", "agentctl.mjs"),
    ];
    const stale = [];
    for (const file of shipped) {
      const text = readIfExists(file);
      if (text === null) continue;
      const rel = file.replace(root + "/", "");
      for (const m of text.matchAll(/\bv?(\d+\.\d+\.\d+)\b/g)) {
        if (m[1] === version) continue;
        // Only flag figures presented as *this kit's* version.
        const context = text.slice(Math.max(0, m.index - 60), m.index).toLowerCase();
        if (!/version|agentctl|orchestrator kit|kit config/.test(context)) continue;
        if (isForeignVersion(rel, m[1], context)) continue;
        stale.push(`${rel}: ${m[1]}`);
      }
    }
    add(
      "agentctl banner/version strings",
      stale.length === 0,
      stale.length ? `stale version string(s): ${[...new Set(stale)].join(", ")}` : `all shipped sources reference v${version}`
    );
  }

  // 2. ROADMAP_V1.md — milestone header must name the shipped version, and no
  //    already-released version may still be labelled "(Unreleased)".
  const roadmap = readIfExists(join(root, "ROADMAP_V1.md"));
  if (roadmap === null) {
    add("ROADMAP present", false, "ROADMAP_V1.md not found");
  } else {
    const current = roadmap.match(/v(\d+\.\d+\.\d+)\s*\(Current Stable\)/);
    add(
      "ROADMAP Current Stable",
      current?.[1] === version,
      current ? `found v${current[1]}, expected v${version}` : "no `(Current Stable)` marker found"
    );

    const shipped = roadmap.match(/Shipped Milestones\s*\(v[\d.]+\s*[–-]\s*v(\d+\.\d+\.\d+)\)/);
    add(
      "ROADMAP Shipped range",
      shipped?.[1] === version,
      shipped ? `ends at v${shipped[1]}, expected v${version}` : "no `Shipped Milestones (…)` range found"
    );

    const unreleased = [...roadmap.matchAll(/v(\d+\.\d+\.\d+)\s*\(Unreleased\)/g)]
      .map((m) => m[1])
      .filter((v) => compareSemver(v, version) <= 0);
    add(
      "ROADMAP no stale (Unreleased)",
      unreleased.length === 0,
      unreleased.length
        ? `v${unreleased.join(", v")} marked (Unreleased) but <= shipped v${version}`
        : "no released version left marked (Unreleased)"
    );

    // An unchecked item under "Shipped Milestones" is a claim the release
    // contradicts. v0.37.0 shipped base64 decoding while the deferral note
    // under v0.32.6 still read "still does not decode" — two statements about
    // the same feature, thirty lines apart, disagreeing. Both survived every
    // other check here, because nothing compared a milestone to its own
    // section heading. Deferrals belong under a target milestone, not a
    // shipped one; moving the item is the fix, ticking it off is the other.
    const shippedStart = roadmap.search(/^##\s.*Shipped Milestones/m);
    if (shippedStart === -1) {
      add("ROADMAP shipped items resolved", false, "no `## … Shipped Milestones` heading found");
    } else {
      const rest = roadmap.slice(shippedStart);
      // Search from index 1 so the section's own heading cannot terminate it.
      const nextHeading = rest.slice(1).search(/^##\s/m);
      const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading + 1);
      const openItems = [...section.matchAll(/^-\s\[ \]\s+(.+)$/gm)].map((m) =>
        m[1].replace(/\*\*/g, "").split("—")[0].trim().slice(0, 60)
      );
      add(
        "ROADMAP shipped items resolved",
        openItems.length === 0,
        openItems.length
          ? `unchecked under Shipped Milestones: ${openItems.join("; ")}`
          : "every item under Shipped Milestones is resolved"
      );
    }
  }

  // 3. CHANGELOG.md — a released version needs a matching entry (release.mjs
  //    extracts its notes from here, and silently falls back if it is missing).
  const changelog = readIfExists(join(root, "CHANGELOG.md"));
  if (changelog === null) {
    add("CHANGELOG present", false, "CHANGELOG.md not found");
  } else {
    add(
      "CHANGELOG entry",
      changelog.includes(`## [${version}]`),
      changelog.includes(`## [${version}]`) ? `## [${version}] found` : `no "## [${version}]" section`
    );
  }

  // 4. README.md — advertised test counts and roadmap-table release labels.
  const readme = readIfExists(join(root, "README.md"));
  if (readme === null) {
    add("README present", false, "README.md not found");
  } else {
    const claim = readme.match(/(\d+)\s+unit tests across\s+(\d+)\s+suites/);
    const claimedTests = claim ? Number(claim[1]) : null;
    const claimedSuites = claim ? Number(claim[2]) : null;

    let { tests, suites } = opts;
    if (tests === undefined || suites === undefined) {
      const measured = measureTestCounts(root);
      tests = tests ?? measured.pass;
      suites = suites ?? measured.suites;
    }

    if (claimedTests === null) {
      add("README test count", false, "no `N unit tests across M suites` claim found");
    } else if (tests === null || suites === null) {
      add("README test count", false, "could not measure actual test counts");
    } else {
      add(
        "README test count",
        claimedTests === tests && claimedSuites === suites,
        `README claims ${claimedTests}/${claimedSuites} passing, suite reports ${tests}/${suites}`
      );
    }

    const unreleasedRows = (readme.match(/\|\s*\*\*Unreleased\*\*\s*\*\(main\)\*\s*\|/g) || []).length;
    add(
      "README roadmap table labels",
      unreleasedRows === 0,
      unreleasedRows ? `${unreleasedRows} row(s) still labelled "Unreleased (main)"` : "no stale Unreleased rows"
    );
  }

  // 5. Agent rule-file budgets. rules-lint has existed unwired, which is how
  //    AGENTS.md silently drifted past its 10k character budget — agent rule
  //    files are truncated by the model host, so an over-budget file loses
  //    directives from the end without any error surfacing.
  if (opts.skipRulesLint !== true) {
    try {
      execSync("node scripts/rules-lint.mjs", { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      add("agent rule budgets", true, "AGENTS.md and .agent/rules/ within char/line budgets");
    } catch (err) {
      const detail = `${err.stdout || ""}${err.stderr || ""}`
        .split("\n")
        .filter((l) => l.trim().startsWith("-"))
        .map((l) => l.trim().replace(/^-\s*/, ""))
        .join("; ");
      add("agent rule budgets", false, detail || "rules-lint reported violations");
    }
  }

  return { ok: checks.every((c) => c.ok), version, checks };
}

function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// ---- CLI ----
const isMain = process.argv[1] && process.argv[1].endsWith("doc-sync-check.mjs");
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && argv[i + 1] ? Number(argv[i + 1]) : undefined;
  };

  const root = resolveRoot();
  const res = checkDocSync(root, { tests: flag("tests"), suites: flag("suites") });

  if (argv.includes("--json")) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(`\n📐 Documentation Sync Gate (v${res.version})`);
    console.log("-------------------------------------------------------");
    for (const c of res.checks) {
      console.log(`  ${c.ok ? "✅" : "❌"} ${c.name.padEnd(32)} ${c.detail}`);
    }
    console.log("-------------------------------------------------------");
    console.log(res.ok ? "✅ Documentation is in sync.\n" : "❌ DOC SYNC GATE FAIL: documentation has drifted from package.json / test suite.\n");
  }

  process.exit(res.ok ? 0 : 1);
}
