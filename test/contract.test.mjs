import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

describe("Repository-Side Jules Contract & Workflow Validation", () => {
  const root = process.cwd();

  test("Task_Template.md contains all required sections and default retry budget", () => {
    const templatePath = path.join(root, ".agent/prompts/Task_Template.md");
    assert.ok(fs.existsSync(templatePath), "Task_Template.md must exist");
    const content = fs.readFileSync(templatePath, "utf-8");

    const requiredSections = [
      "## Objective",
      "## Context",
      "## Allowed Paths",
      "## Forbidden Paths",
      "## Functional Requirements",
      "## Acceptance Criteria",
      "## Verification Commands",
      "## Evidence",
      "## Retry Budget",
      "## Stop", // Covers "## Stop / Escalation Conditions" or similar
    ];

    for (const section of requiredSections) {
      assert.ok(content.includes(section), `Task_Template.md missing section: ${section}`);
    }

    assert.match(content, /2\s*(repair rounds|repair)/i, "Task_Template.md must state a default budget of 2 repair rounds");
  });

  test("jules-review.md workflow is strictly read-only and forbids auto-merge/close commands", () => {
    const reviewPath = path.join(root, ".agent/workflows/jules-review.md");
    assert.ok(fs.existsSync(reviewPath), "jules-review.md must exist");
    const content = fs.readFileSync(reviewPath, "utf-8");

    assert.equal(content.includes("gh pr merge"), false, "jules-review.md must not instruct gh pr merge");
    assert.equal(content.includes("gh pr close"), false, "jules-review.md must not instruct gh pr close");

    assert.match(content, /read-only/i, "jules-review.md must specify read-only audit gate");
    assert.match(content, /necessary/i, "jules-review.md must state green CI is necessary but not sufficient");
    assert.match(content, /@Jules/i, "jules-review.md must state explicit @Jules repair steering");
    assert.match(content, /2\s*repair/i, "jules-review.md must specify maximum 2 repair rounds");
  });

  test("Documentation accurately reflects Google-first hands-off workflow", () => {
    const providerDoc = fs.readFileSync(path.join(root, "docs/providers/jules.md"), "utf-8");
    const workflowDoc = fs.readFileSync(path.join(root, "docs/jules-workflow.md"), "utf-8");

    for (const doc of [providerDoc, workflowDoc]) {
      assert.match(doc, /jules/i, "Doc must mention jules label trigger");
      assert.match(doc, /@Jules/i, "Doc must mention @Jules PR feedback");
      assert.match(doc, /Jules PR Audit & Test Gatekeeper/i, "Doc must name Jules PR Audit & Test Gatekeeper");
      assert.match(doc, /Agent Scope Guard/i, "Doc must name Agent Scope Guard");
    }
  });
});
