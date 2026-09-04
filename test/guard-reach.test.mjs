import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { checkTestTampering } from "../src/security.mjs";
import { TAMPER_CANARIES, PREDICATE_MUTANTS } from "../src/guard-policy.mjs";

/**
 * The meta-check has to be able to fail, for the same reason the guards do.
 * A canary that cannot go red proves nothing about the guard it watches.
 */

const SCRIPT = fileURLToPath(new URL("../scripts/guard-reach-check.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const diffFor = (c) =>
  [`--- a/${c.file}`, `+++ b/${c.file}`, "@@ -1,20 +1,20 @@", " // context", ...c.removed.map((l) => `-${l}`), ...c.added.map((l) => `+${l}`), " // context"].join("\n");

describe("activation coverage", () => {
  it("passes on the current tree", () => {
    const res = spawnSync(process.execPath, [SCRIPT, "--json"], { cwd: ROOT, encoding: "utf-8" });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const report = JSON.parse(res.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.activationCoverage.activated, report.activationCoverage.canaries);
  });

  it("every guard rule has a canary that is red without it", () => {
    // The check the whole mechanism rests on: a known-bad input must produce
    // the finding it names. If it does not, the rule has stopped being
    // reachable and no ordinary test would have noticed.
    for (const c of TAMPER_CANARIES) {
      const res = checkTestTampering(diffFor(c));
      assert.ok(
        (res.violations || []).some((v) => v.type === c.expect),
        `canary ${c.id} came back clean — ${c.expect} is no longer reachable`
      );
      assert.ok(res.inputsSeen > 0, `canary ${c.id} produced a finding with no denominator`);
    }
  });

  it("blinding the applicability predicate breaks at least one canary", () => {
    // A mutant that survives means no canary required the guard to *activate*,
    // so the suite would stay green if the guard silently stopped looking.
    for (const mutant of PREDICATE_MUTANTS) {
      const killed = TAMPER_CANARIES.some((c) => {
        const healthy = checkTestTampering(diffFor(c));
        if (!(healthy.violations || []).some((v) => v.type === c.expect)) return false;
        const blinded = checkTestTampering(diffFor(c), { isTestPath: mutant.fn });
        return !(blinded.violations || []).some((v) => v.type === c.expect);
      });
      assert.ok(killed, `mutant "${mutant.id}" survived (${mutant.why})`);
    }
  });
});

describe("a verdict carries its denominator", () => {
  const rewrite = (file) =>
    [`--- a/${file}`, `+++ b/${file}`, "@@ -1,9 +1,9 @@", " ctx", "-assert.equal(add(1,2), 3);", "+assert.equal(add(1,2), -1);", " ctx"].join("\n");

  it("distinguishes checked-and-clean from nothing-was-checked", () => {
    // `ok: true` cannot tell these apart, and that ambiguity is exactly how a
    // substring bug switched the whole tamper guard off in silence.
    const applied = checkTestTampering(rewrite("test/a.test.js"));
    assert.equal(applied.status, "FAIL");
    assert.ok(applied.inputsSeen > 0);

    const notApplied = checkTestTampering(rewrite("src/a.js"));
    assert.equal(notApplied.status, "NOT_APPLICABLE");
    assert.equal(notApplied.inputsSeen, 0);
    assert.equal(notApplied.ok, true, "not applicable is still not a failure");

    const empty = checkTestTampering("");
    assert.equal(empty.status, "NOT_APPLICABLE");
  });

  it("reports NOT_APPLICABLE when the override silences everything", () => {
    const res = checkTestTampering(rewrite("test/a.test.js"), { allowTestModifications: true });
    assert.equal(res.status, "NOT_APPLICABLE");
    assert.equal(res.ok, true);
  });
});
