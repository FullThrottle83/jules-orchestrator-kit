import test from "node:test";
import assert from "node:assert/strict";
import { classifyRiskTier, RISK_TIERS, resolveRiskPatterns, BUILTIN_RESTRICTED } from "../src/risk.mjs";

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

test("Risk model is repository-configurable, not one project's paths", async (t) => {
  await t.test("project restricted paths raise a file the builtins do not know", () => {
    const files = ["src/pricing/vat-rates.ts"];
    assert.equal(classifyRiskTier(files).tier, RISK_TIERS.R1);

    const config = { risk: { restricted: ["**/pricing/**"] } };
    const res = classifyRiskTier(files, { config });
    assert.equal(res.tier, RISK_TIERS.R3);
    assert.equal(res.isAutoMergeAllowed, false);
    assert.match(res.reason, /\*\*\/pricing\/\*\*/);
  });

  await t.test("project patterns extend the builtins, they do not replace them", () => {
    const config = { risk: { restricted: ["**/pricing/**"], consequential: ["internal/**"] } };
    const resolved = resolveRiskPatterns(config);
    for (const builtin of BUILTIN_RESTRICTED) {
      assert.ok(resolved.restricted.includes(builtin), `${builtin} must survive a project override`);
    }
    // A config that narrows the risk model by accident is the failure this prevents.
    assert.equal(classifyRiskTier([".github/workflows/ci.yml"], { config }).tier, RISK_TIERS.R3);
  });

  await t.test("the routine diff ceiling is configurable", () => {
    const config = { risk: { maxRoutineDiffLines: 50 } };
    assert.equal(classifyRiskTier(["src/a.mjs"], { diffLines: 120 }).tier, RISK_TIERS.R1);
    assert.equal(classifyRiskTier(["src/a.mjs"], { diffLines: 120, config }).tier, RISK_TIERS.R2);
  });

  await t.test("lockfiles are restricted in every ecosystem, nested or at the root", () => {
    for (const lock of ["Cargo.lock", "poetry.lock", "go.sum", "Gemfile.lock", "composer.lock", "pnpm-lock.yaml"]) {
      assert.equal(classifyRiskTier([lock]).tier, RISK_TIERS.R3, `${lock} at root`);
      assert.equal(classifyRiskTier([`crates/api/${lock}`]).tier, RISK_TIERS.R3, `${lock} nested`);
    }
    // Anchored on a separator: a plain endsWith also matched this.
    assert.equal(classifyRiskTier(["vendor-Cargo.lock"]).tier, RISK_TIERS.R1);
  });

  await t.test("migrations and key material are restricted regardless of language", () => {
    assert.equal(classifyRiskTier(["api/alembic/migrations/0001_init.py"]).tier, RISK_TIERS.R3);
    assert.equal(classifyRiskTier(["db/migrate/20240101_add_users.rb"]).tier, RISK_TIERS.R3);
    assert.equal(classifyRiskTier(["infra/main.tf"]).tier, RISK_TIERS.R3);
    assert.equal(classifyRiskTier(["config/prod.pem"]).tier, RISK_TIERS.R3);
  });

  // checkScope folds case for deny/protect because .GitHub/ and .github/ are the
  // same directory on APFS and NTFS. The classifier used not to, so the same
  // change was blocked by the gate and auto-merge eligible by the harvester.
  await t.test("matches case-insensitively, like the scope gate", () => {
    assert.equal(classifyRiskTier([".GitHub/workflows/ci.yml"]).tier, RISK_TIERS.R3);
    assert.equal(classifyRiskTier(["Packages/Auth/Session.ts"]).tier, RISK_TIERS.R3);
  });

  await t.test("does not ship one project's source files as everyone's risk paths", () => {
    const all = [...BUILTIN_RESTRICTED, ...resolveRiskPatterns().consequential];
    for (const pat of all) {
      assert.ok(
        !pat.startsWith("src/") && !pat.startsWith("apps/") && !pat.startsWith("packages/"),
        `builtin '${pat}' names a specific repository layout and belongs in .agent/config.yml`
      );
    }
  });
});
