import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { evaluateNodeRuntime } from "../src/ops/doctor-registry.mjs";

describe("Jules Workflow & Provider Documentation Contracts", () => {
  const rootDir = process.cwd();
  const providerDocPath = path.join(rootDir, "docs", "providers", "jules.md");
  const workflowDocPath = path.join(rootDir, "docs", "jules-workflow.md");

  it("docs/providers/jules.md exists, describes Google-first workflow, and links to docs/jules-workflow.md", () => {
    assert.ok(fs.existsSync(providerDocPath), "docs/providers/jules.md must exist");
    const content = fs.readFileSync(providerDocPath, "utf-8");

    assert.ok(
      /google-first/i.test(content),
      "docs/providers/jules.md must describe a Google-first workflow"
    );
    assert.ok(
      content.includes("../jules-workflow.md") || content.includes("docs/jules-workflow.md"),
      "docs/providers/jules.md must link to docs/jules-workflow.md"
    );
  });

  it("docs/jules-workflow.md exists and contains all required task contract sections", () => {
    assert.ok(fs.existsSync(workflowDocPath), "docs/jules-workflow.md must exist");
    const content = fs.readFileSync(workflowDocPath, "utf-8");

    const requiredSections = [
      "Objective",
      "Context",
      "Allowed Paths",
      "Forbidden Paths",
      "Functional Requirements",
      "Acceptance Criteria",
      "Verification Commands",
      "Required Evidence",
      "Retry Budget",
      "Stop", // Stop/escalation conditions
    ];

    for (const section of requiredSections) {
      const regex = new RegExp(section, "i");
      assert.ok(regex.test(content), `docs/jules-workflow.md must include section for '${section}'`);
    }
  });

  it("docs/jules-workflow.md defines native trigger and Reactive Mode distinction", () => {
    const content = fs.readFileSync(workflowDocPath, "utf-8");

    assert.ok(
      /jules/i.test(content) && /issue label/i.test(content),
      "docs/jules-workflow.md must mention case-insensitive jules issue label as native task-start trigger"
    );
    assert.ok(
      /@Jules/i.test(content) && /Reactive Mode/i.test(content),
      "docs/jules-workflow.md must distinguish between issue-label trigger and targeted @Jules PR feedback in Reactive Mode"
    );
  });

  it("docs/jules-workflow.md defines PR creation and independent read-only CI", () => {
    const content = fs.readFileSync(workflowDocPath, "utf-8");

    assert.ok(
      /pull request|PR/i.test(content),
      "docs/jules-workflow.md must cover Jules opening the PR"
    );
    assert.ok(
      /CI/i.test(content) && /independent/i.test(content) && /read-only/i.test(content),
      "docs/jules-workflow.md must specify independent read-only CI"
    );
  });

  it("docs/jules-workflow.md names gatekeepers without claiming they are required branch protection checks", () => {
    const content = fs.readFileSync(workflowDocPath, "utf-8");

    assert.ok(
      content.includes("Jules PR Audit & Test Gatekeeper"),
      "docs/jules-workflow.md must name Jules PR Audit & Test Gatekeeper"
    );
    assert.ok(
      content.includes("Agent Scope Guard"),
      "docs/jules-workflow.md must name Agent Scope Guard"
    );
  });

  it("docs/jules-workflow.md defines bounded repair budget and immediate stop conditions", () => {
    const content = fs.readFileSync(workflowDocPath, "utf-8");

    assert.ok(
      /two|2/i.test(content) && /repair/i.test(content),
      "docs/jules-workflow.md must cap repair attempts to a maximum of two rounds"
    );
    assert.ok(
      /immediate stop|stop/i.test(content),
      "docs/jules-workflow.md must specify immediate stop conditions"
    );
  });

  it("docs/jules-workflow.md enforces merge rules and forbids autonomous side effects", () => {
    const content = fs.readFileSync(workflowDocPath, "utf-8");

    assert.ok(
      /necessary but not sufficient/i.test(content),
      "docs/jules-workflow.md must state green CI is necessary but not sufficient for merge"
    );
    assert.ok(
      /no auto-merge|never.*merge/i.test(content),
      "docs/jules-workflow.md must prohibit auto-merge"
    );
    assert.ok(
      /no auto-close|never.*close/i.test(content),
      "docs/jules-workflow.md must prohibit auto-close"
    );
    assert.ok(
      /no self-approval|never.*approve/i.test(content),
      "docs/jules-workflow.md must prohibit self-approval"
    );
    assert.ok(
      /no production side effects/i.test(content),
      "docs/jules-workflow.md must prohibit production side effects"
    );
  });

  it("docs/jules-workflow.md identifies administrative settings outside repository task", () => {
    const content = fs.readFileSync(workflowDocPath, "utf-8");

    assert.ok(
      /branch protection/i.test(content) && /authenticated/i.test(content),
      "docs/jules-workflow.md must identify branch protection and Reactive Mode as authenticated settings outside this task"
    );
  });
});

describe("Node.js Runtime Baseline Contract (>=22.0.0)", () => {
  const rootDir = process.cwd();

  it("package.json requires node engine >=22.0.0", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"));
    assert.equal(pkg.engines?.node, ">=22.0.0");
  });

  it("evaluateNodeRuntime accepts Node >=22 and reports pass", () => {
    for (const v of ["v22.0.0", "v22.14.0", "v24.0.0", "22.0.0", "24.2.0"]) {
      const res = evaluateNodeRuntime(v);
      assert.equal(res.status, "pass", `expected ${v} to pass`);
      assert.equal(res.severity, "info");
      assert.match(res.summary, /satisfies runtime requirements \(v22\+\)/);
    }
  });

  it("evaluateNodeRuntime rejects Node <22 and reports critical failure", () => {
    for (const v of ["v20.0.0", "v20.11.0", "v21.0.0", "v18.19.0", "20.18.0", "21.6.0"]) {
      const res = evaluateNodeRuntime(v);
      assert.equal(res.status, "fail", `expected ${v} to fail`);
      assert.equal(res.severity, "critical");
      assert.match(res.summary, /is below required minimum v22\.0\.0/);
    }
  });

  it("CI workflow jules-audit.yml tests 22.x and 24.x, excluding 20.x", () => {
    const auditWf = fs.readFileSync(path.join(rootDir, ".github", "workflows", "jules-audit.yml"), "utf-8");
    assert.match(auditWf, /node-version:\s*\[['"]22\.x['"],\s*['"]24\.x['"]\]/);
    assert.doesNotMatch(auditWf, /20\.x/);
  });

  it("setup-jules composite action defaults to >=22.0.0", () => {
    const actionYaml = fs.readFileSync(path.join(rootDir, ".github", "actions", "setup-jules", "action.yml"), "utf-8");
    assert.match(actionYaml, /default:\s*['"]>=22\.0\.0['"]/);
  });

  it("README.md documents Node.js 22+ as the runtime baseline", () => {
    const readme = fs.readFileSync(path.join(rootDir, "README.md"), "utf-8");
    assert.match(readme, /Node\.js 22\+/);
    assert.doesNotMatch(readme, /Node\.js 20\+/);
  });

  it("scripts/doc-sync-check.mjs records doctor-registry foreign version 22.0.0", () => {
    const docSync = fs.readFileSync(path.join(rootDir, "scripts", "doc-sync-check.mjs"), "utf-8");
    assert.match(docSync, /file:\s*["']src\/ops\/doctor-registry\.mjs["'],\s*value:\s*["']22\.0\.0["']/);
  });

  it("bug report issue template prompts for Node 22 examples", () => {
    const bugTemplate = fs.readFileSync(path.join(rootDir, ".github", "ISSUE_TEMPLATE", "bug_report.md"), "utf-8");
    assert.match(bugTemplate, /placeholder:\s*["']v22\.x["']/);
    assert.doesNotMatch(bugTemplate, /v20\.x/);
  });
});
