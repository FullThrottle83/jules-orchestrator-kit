import test from "node:test";
import assert from "node:assert/strict";
import { checkRulesBudget } from "../src/rules_budget.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("Rules Character and Line Budget Linter", async (t) => {
  const testDir = mkdtempSync(join(tmpdir(), "jules-rules-test-"));

  t.after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  await t.test("passes rule files within budget", () => {
    writeFileSync(join(testDir, "AGENTS.md"), "# Standard Rules\nShort rule file.");
    const res = checkRulesBudget(testDir);
    assert.equal(res.ok, true);
    assert.equal(res.violations.length, 0);
  });

  await t.test("flags rule files exceeding character budget", () => {
    const bloatedContent = "# Bloated Rules\n" + "A".repeat(12000);
    writeFileSync(join(testDir, "AGENTS.md"), bloatedContent);
    const res = checkRulesBudget(testDir, { maxChars: 10000 });
    assert.equal(res.ok, false);
    assert.equal(res.violations.length, 1);
    assert.match(res.violations[0].reason, /Exceeds max character budget/);
  });
});
