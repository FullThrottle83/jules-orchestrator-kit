import test from "node:test";
import assert from "node:assert/strict";
import { classifyRiskTier, RISK_TIERS } from "../src/risk.mjs";

test("Risk Tier Classification Engine", async (t) => {
  await t.test("classifies markdown changes as R0 Cosmetic", () => {
    const res = classifyRiskTier(["README.md", "docs/architecture.md"]);
    assert.equal(res.tier, RISK_TIERS.R0);
    assert.equal(res.isAutoMergeAllowed, true);
  });

  await t.test("classifies isolated package logic as R1 Routine", () => {
    const res = classifyRiskTier(["src/utils.mjs", "test/utils.test.mjs"], { diffLines: 50 });
    assert.equal(res.tier, RISK_TIERS.R1);
    assert.equal(res.isAutoMergeAllowed, true);
  });

  await t.test("classifies UI component updates or large diffs as R2 Consequential", () => {
    const resPath = classifyRiskTier(["apps/web/src/components/Button.astro"]);
    assert.equal(resPath.tier, RISK_TIERS.R2);
    assert.equal(resPath.requiresHumanReview, true);

    const resDiff = classifyRiskTier(["src/utils.mjs"], { diffLines: 450 });
    assert.equal(resDiff.tier, RISK_TIERS.R2);
    assert.equal(resDiff.requiresHumanReview, true);
  });

  await t.test("classifies security, auth, migration, or workflow paths as R3 Restricted", () => {
    const resAuth = classifyRiskTier(["packages/auth/session.ts"]);
    assert.equal(resAuth.tier, RISK_TIERS.R3);
    assert.equal(resAuth.isAutoMergeAllowed, false);

    const resGithub = classifyRiskTier([".github/workflows/ci.yml"]);
    assert.equal(resGithub.tier, RISK_TIERS.R3);
    assert.equal(resGithub.isAutoMergeAllowed, false);
  });

  await t.test("modifying .agent/rules/ files triggers Risk Tier R3 Restricted", () => {
    const res = classifyRiskTier([".agent/rules/jules-protocol.md"]);
    assert.equal(res.tier, RISK_TIERS.R3);
    assert.equal(res.isAutoMergeAllowed, false);
    assert.equal(res.requiresHumanReview, true);
  });

  await t.test("changing documentation markdown files triggers Risk Tier R0 Cosmetic", () => {
    const resDocs = classifyRiskTier(["docs/architecture.md", "README.md"]);
    assert.equal(resDocs.tier, RISK_TIERS.R0);
    assert.equal(resDocs.isAutoMergeAllowed, true);
    assert.equal(resDocs.requiresHumanReview, false);
  });

  await t.test("verifies priority calculation logic when multiple risk triggers overlap", () => {
    // Overlap 1: One cosmetic file (.md) and one restricted file (.agent/rules/...) => R3 Restricted
    const overlap1 = classifyRiskTier(["README.md", ".agent/rules/jules-protocol.md"]);
    assert.equal(overlap1.tier, RISK_TIERS.R3);
    assert.equal(overlap1.isAutoMergeAllowed, false);

    // Overlap 2: One cosmetic file (R0) and one routine logic file (R1) => R1 Routine
    const overlap2 = classifyRiskTier(["README.md", "src/risk.mjs"]);
    assert.equal(overlap2.tier, RISK_TIERS.R1);
    assert.equal(overlap2.isAutoMergeAllowed, true);

    // Overlap 3: Consequential path (R2) and restricted path (R3) => R3 Restricted
    const overlap3 = classifyRiskTier(["src/security.mjs", ".agent/rules/jules-protocol.md"]);
    assert.equal(overlap3.tier, RISK_TIERS.R3);
    assert.equal(overlap3.isAutoMergeAllowed, false);

    // Overlap 4: Single file with cosmetic extension inside restricted folder => R3 Restricted
    const overlap4 = classifyRiskTier([".agent/rules/jules-protocol.md"]);
    assert.equal(overlap4.tier, RISK_TIERS.R3);

    // Overlap 5: Single consequential file with large diff lines (>= 400) => R2 Consequential
    const overlap5 = classifyRiskTier(["src/security.mjs"], { diffLines: 450 });
    assert.equal(overlap5.tier, RISK_TIERS.R2);

    // Overlap 6: Single restricted file with large diff lines (>= 400) => R3 Restricted (R3 overrides R2)
    const overlap6 = classifyRiskTier([".agent/rules/jules-protocol.md"], { diffLines: 500 });
    assert.equal(overlap6.tier, RISK_TIERS.R3);
    assert.equal(overlap6.isAutoMergeAllowed, false);
  });
});
