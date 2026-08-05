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
});
