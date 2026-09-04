#!/usr/bin/env node

/**
 * Activation coverage: proof that every blocking check can still be made red.
 *
 * A defect that turns a check off cannot be found by the check it turns off.
 * That is not a hypothetical — `isTestFile` matched the substring `/test/`,
 * which does not occur in `tests/test_calc.py`, so the entire tamper guard was
 * silent for the standard pytest, Rust and RSpec layouts. Every mechanism that
 * should have caught it was working exactly as designed:
 *
 *   - the unit suite sampled the same distribution the implementation was
 *     written from, so its fixtures re-confirmed the dialect it already knew;
 *   - the doc-sync gate compares counts and versions, and a guard that guards
 *     nothing still contributes passing tests;
 *   - the nine-way CI matrix varies OS and Node version — dimensions
 *     orthogonal to the defect. Nine runs of `test/foo.test.js` never explore
 *     `tests/test_calc.py`;
 *   - cold review reads the code against its stated intent, and here the code
 *     and the intent agreed. The eye supplies the leading slash;
 *   - the release gate is a conjunction over those four, and a signal that
 *     silently goes absent contributes `true`.
 *
 * The common property: `ok: true` from a check that examined nothing is
 * byte-identical to `ok: true` from a check that examined everything. There is
 * no denominator. This script supplies one.
 *
 * Three steps, all in-process, no dependencies, well under a second:
 *
 *   1. POLICY   — the hand-written witness table in src/guard-policy.mjs
 *                 must hold. It is derived from what the tool advertises, never
 *                 from the regexes that implement it.
 *   2. CANARIES — every known-bad input must produce the finding it names. A
 *                 canary that comes back clean is not a pass; it is proof that
 *                 the rule stopped being reachable.
 *   3. MUTANTS  — each hand-written mutant of the applicability predicate must
 *                 kill at least one canary. A surviving mutant means no canary
 *                 ever required the guard to activate, so the suite would stay
 *                 green if it silently stopped looking.
 *
 * Usage: node scripts/guard-reach-check.mjs [--json]
 * Exit codes: 0 = every guard reachable, 1 = a guard has gone silent.
 */

import { checkTestTampering, checkScope } from "../src/security.mjs";
import { isTestPath } from "../src/test-paths.mjs";
import { normalizeScope } from "../src/config.mjs";
import { parseCollectedTests } from "../src/ops/test-collection.mjs";
import {
  TEST_PATH_CASES,
  TAMPER_CANARIES,
  PREDICATE_MUTANTS,
  EMPTY_RUN_CANARIES,
  COUNTED_RUN_CANARIES,
  SCOPE_CANARIES,
  INNOCENT_EDITS,
  UNREADABLE_DIALECTS,
} from "../src/guard-policy.mjs";

/**
 * Build a unified diff for one canary.
 *
 * The context line carries the comment syntax of the file's own language.
 * A `//` line in a `.py` fixture is not a comment, and a fixture that lies
 * about the language under test measures the fixture rather than the guard —
 * which is how two false results were once read as two defects.
 */
function canaryDiff(c) {
  const ctx = c.context || "// context";
  const lines = [`--- a/${c.file}`, `+++ b/${c.file}`, "@@ -1,20 +1,20 @@", ` ${ctx}`];
  for (const l of c.removed) lines.push(`-${l}`);
  for (const l of c.added) lines.push(`+${l}`);
  lines.push(` ${ctx}`);
  return lines.join("\n");
}

const failures = [];
const checks = [];
const add = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(`${name}: ${detail}`);
};

// --- 1. Policy contract -----------------------------------------------------
{
  const wrong = TEST_PATH_CASES.filter((c) => isTestPath(c.path) !== c.expected);
  add(
    "policy: test-path domain",
    wrong.length === 0,
    wrong.length
      ? wrong.map((c) => `${c.path} → ${isTestPath(c.path)}, policy says ${c.expected} (${c.why})`).join("; ")
      : `${TEST_PATH_CASES.length} witnesses hold`
  );
}

{
  const scope = normalizeScope({ deny: [], allow: [], protect: [] });
  const wrong = [];
  for (const c of SCOPE_CANARIES) {
    const res = checkScope([c.path], scope);
    const rule = res.ok ? "none" : res.violations[0].rule;
    if (rule !== c.rule) wrong.push(`${c.path} → ${rule}, policy says ${c.rule} (${c.why})`);
  }
  add("policy: scope tiers", wrong.length === 0, wrong.length ? wrong.join("; ") : `${SCOPE_CANARIES.length} paths tiered as declared`);
}

{
  const missed = EMPTY_RUN_CANARIES.filter((c) => parseCollectedTests(c.output, "").count !== 0);
  const undercounted = COUNTED_RUN_CANARIES.filter((c) => {
    const n = parseCollectedTests(c.output, "").count;
    return n === null || n < c.atLeast;
  });
  add(
    "policy: a stated count is never read as empty",
    undercounted.length === 0,
    undercounted.length
      ? undercounted.map((c) => `${c.id} (${c.why})`).join("; ")
      : `${COUNTED_RUN_CANARIES.length} healthy runs counted, not rejected`
  );
  add(
    "policy: empty-run detection",
    missed.length === 0,
    missed.length ? `${missed.map((m) => m.id).join(", ")} report zero tests in a spelling the floor cannot read` : `${EMPTY_RUN_CANARIES.length} runners recognised`
  );
}

// --- 2. Canaries ------------------------------------------------------------
const canaryResults = new Map();
{
  const silent = [];
  const noDenominator = [];
  const noAssertions = [];
  for (const c of TAMPER_CANARIES) {
    const res = checkTestTampering(canaryDiff(c));
    const hit = (res.violations || []).some((v) => v.type === c.expect);
    canaryResults.set(c.id, hit);
    if (!hit) silent.push(`${c.id} expected ${c.expect}, got ${JSON.stringify((res.violations || []).map((v) => v.type))}`);
    // A finding with no denominator is the shape this script exists to reject.
    if (hit && !(res.inputsSeen > 0)) noDenominator.push(c.id);
    // Counting lines was not enough: a JUnit diff reported one input examined
    // and a clean PASS while every assertion in it went unrecognised. A rule
    // about assertions has to say how many assertions it actually read.
    if (hit && c.expect !== "TEST_SKIP_INJECTION" && !(res.assertionsSeen > 0)) {
      noAssertions.push(`${c.id} (${res.assertionsSeen} assertions parsed)`);
    }
  }
  add("canaries: every tamper rule still fires", silent.length === 0, silent.length ? silent.join("; ") : `${TAMPER_CANARIES.length} canaries red as required`);
  add("canaries: every finding carries a denominator", noDenominator.length === 0, noDenominator.length ? noDenominator.join(", ") : "inputsSeen > 0 on every hit");
  add("canaries: assertion rules parsed an assertion", noAssertions.length === 0, noAssertions.length ? noAssertions.join(", ") : "assertionsSeen > 0 on every assertion finding");
}

// --- 3. The opposite failure: flagging what is innocent ---------------------
{
  const noisy = [];
  for (const e of INNOCENT_EDITS) {
    const res = checkTestTampering(canaryDiff(e));
    const types = (res.violations || []).map((v) => v.type);
    if (types.length > 0) noisy.push(`${e.id} → ${JSON.stringify(types)} (${e.why})`);
  }
  add(
    "innocent edits stay silent",
    noisy.length === 0,
    noisy.length
      ? noisy.join("; ")
      : `${INNOCENT_EDITS.length} ordinary edits produce no finding`
  );
}

{
  const quiet = [];
  for (const d of UNREADABLE_DIALECTS) {
    const res = checkTestTampering(canaryDiff(d));
    if (res.status !== "UNREADABLE") quiet.push(`${d.id} → ${res.status} (${d.why})`);
  }
  add(
    "an unparsable dialect says so",
    quiet.length === 0,
    quiet.length
      ? `${quiet.join("; ")} — coverage ending is fine, ending silently is not`
      : `${UNREADABLE_DIALECTS.length} unsupported dialects reported, not passed`
  );
}

// --- 4. Predicate mutants ---------------------------------------------------
{
  const survivors = [];
  for (const mutant of PREDICATE_MUTANTS) {
    let killed = false;
    for (const c of TAMPER_CANARIES) {
      // Only canaries the healthy predicate catches can kill a mutant.
      if (!canaryResults.get(c.id)) continue;
      const res = checkTestTampering(canaryDiff(c), { isTestPath: mutant.fn });
      if (!(res.violations || []).some((v) => v.type === c.expect)) {
        killed = true;
        break;
      }
    }
    if (!killed) survivors.push(`${mutant.id} (${mutant.why})`);
  }
  add(
    "mutants: blinding the predicate breaks a canary",
    survivors.length === 0,
    survivors.length
      ? `survived: ${survivors.join(", ")} — no canary required the guard to activate`
      : `${PREDICATE_MUTANTS.length} mutants killed`
  );
}

// --- Report -----------------------------------------------------------------
const json = process.argv.includes("--json");
const activated = [...canaryResults.values()].filter(Boolean).length;

if (json) {
  console.log(
    JSON.stringify(
      {
        ok: failures.length === 0,
        checks,
        activationCoverage: { canaries: canaryResults.size, activated },
      },
      null,
      2
    )
  );
} else {
  console.log("\n🎯 Guard Reach Check (activation coverage)");
  console.log("-------------------------------------------------------");
  for (const c of checks) console.log(`  ${c.ok ? "✅" : "❌"} ${c.name.padEnd(46)} ${c.detail}`);
  console.log("-------------------------------------------------------");
  console.log(`  canaries activated: ${activated}/${canaryResults.size}`);
  console.log(
    failures.length === 0
      ? "✅ Every blocking guard can still be made red.\n"
      : `\n❌ ${failures.length} guard(s) may have gone silent. A check that cannot be made red is not a check.\n`
  );
}

process.exit(failures.length === 0 ? 0 : 1);
