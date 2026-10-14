import test from "node:test";
import assert from "node:assert/strict";
import { checkRulesBudget, compileRules, verifyRulesSentinel } from "../src/rules-budget.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("Rules Character and Line Budget Linter", async (t) => {
  const testDir = mkdtempSync(join(tmpdir(), "jules-rules-test-"));

  t.after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  await t.test("passes rule files within budget", () => {
    writeFileSync(join(testDir, "AGENTS.md"), "# Standard Rules\nShort rule file.");
    writeFileSync(join(testDir, "CLAUDE.md"), "@AGENTS.md\n");
    mkdirSync(join(testDir, ".agent", "rules"), { recursive: true });
    writeFileSync(join(testDir, ".agent", "rules", "sample.md"), "---\ntrigger: manual\n---\n\n# Rule\n");
    const res = checkRulesBudget(testDir);
    assert.equal(res.ok, true);
    assert.equal(res.violations.length, 0);
  });

  await t.test("flags rule files exceeding character budget or missing adapter wiring", () => {
    const bloatedContent = "# Bloated Rules\n" + "A".repeat(12000);
    writeFileSync(join(testDir, "AGENTS.md"), bloatedContent);
    writeFileSync(join(testDir, "CLAUDE.md"), "Read AGENTS.md first.\n");
    writeFileSync(join(testDir, ".agent", "rules", "sample.md"), "# Missing frontmatter\n");
    const res = checkRulesBudget(testDir, { maxChars: 10000 });
    assert.equal(res.ok, false);
    assert.equal(res.violations.length, 3);
    assert.match(res.violations[0].reason, /Exceeds max character budget/);
    assert.match(res.violations[1].reason, /CLAUDE\.md must import @AGENTS\.md/);
    assert.match(res.violations[2].reason, /YAML frontmatter/);
    rmSync(join(testDir, "CLAUDE.md"), { force: true });
    rmSync(join(testDir, ".agent"), { recursive: true, force: true });
  });

  await t.test("compiles rules with anti-truncation sentinels and verifies integrity", () => {
    writeFileSync(join(testDir, "AGENTS.md"), "# Core Rules\nDo not violate.");
    const { compiled, sha256, bodyLen } = compileRules(testDir);
    assert.ok(compiled.includes("JULES_RULES_SENTINEL BEGIN"));
    assert.ok(compiled.includes("JULES_RULES_SENTINEL END"));
    assert.ok(bodyLen > 0);

    const verified = verifyRulesSentinel(compiled);
    assert.equal(verified.ok, true);
    assert.equal(verified.sha256, sha256);

    // Tamper / Truncate body
    const truncated = compiled.replace("Do not violate.", "Do not");
    const tamperedCheck = verifyRulesSentinel(truncated);
    assert.equal(tamperedCheck.ok, false);
    assert.ok(tamperedCheck.errors.some((e) => e.includes("body length") || e.includes("checksum")));
  });
});

