import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { gate } from "../src/engine.mjs";
import { exportJsonReport } from "../src/evidence.mjs";

describe("Engine Declarative Assertions & Structured Reporting Integration", () => {
  test("gate() executes assert:dir-size and assert:file-patterns stages cleanly when passing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "engine-assert-pass-"));
    try {
      execSync("git init -b main", { cwd: tmp, stdio: "ignore" });
      execSync("git config user.name \"Test\"", { cwd: tmp, stdio: "ignore" });
      execSync("git config user.email \"test@test.com\"", { cwd: tmp, stdio: "ignore" });

      mkdirSync(join(tmp, ".agent"), { recursive: true });
      mkdirSync(join(tmp, "src"), { recursive: true });
      mkdirSync(join(tmp, "dist"), { recursive: true });

      const configYaml = `
verify:
  stages:
    - id: "bundle-size"
      kind: "invariant"
      assert: "dir-size"
      path: "dist"
      maxMb: 5
    - id: "no-secrets"
      kind: "lint"
      assert: "file-patterns"
      targets: ["src/**/*.js"]
      patterns: ["BANNED_SECRET_XYZ"]
`;
      writeFileSync(join(tmp, ".agent", "jules.yml"), configYaml);
      writeFileSync(join(tmp, "src", "index.js"), "export const a = 1;\n");
      writeFileSync(join(tmp, "dist", "bundle.js"), "console.log('prod');\n");

      execSync("git add . && git commit -m \"initial base\"", { cwd: tmp, stdio: "ignore" });

      // Create feature branch
      execSync("git checkout -b feature", { cwd: tmp, stdio: "ignore" });
      writeFileSync(join(tmp, "src", "index.js"), "export const a = 2;\n");
      execSync("git add . && git commit -m \"feature changes\"", { cwd: tmp, stdio: "ignore" });

      const jsonReportPath = join(tmp, "report.json");
      const res = await gate({
        root: tmp,
        base: "main",
        jsonReport: jsonReportPath,
      });

      assert.equal(res.ok, true);
      assert.equal(res.code, 0);

      const verifyPhase = res.phases.find((p) => p.phase === "verify");
      assert.ok(verifyPhase);
      assert.equal(verifyPhase.ok, true);
      assert.equal(verifyPhase.executionRecords.length, 2);
      assert.equal(verifyPhase.executionRecords[0].id, "bundle-size");
      assert.equal(verifyPhase.executionRecords[0].assert, "dir-size");
      assert.equal(verifyPhase.executionRecords[1].id, "no-secrets");

      // Verify json report on disk
      assert.ok(existsSync(jsonReportPath));
      const report = JSON.parse(readFileSync(jsonReportPath, "utf-8"));
      assert.equal(report.status, "passed");
      assert.equal(report.executionRecords.length, 2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("gate() halts on assertion failure and outputs structured diagnostics & metrics", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "engine-assert-fail-"));
    try {
      execSync("git init -b main", { cwd: tmp, stdio: "ignore" });
      execSync("git config user.name \"Test\"", { cwd: tmp, stdio: "ignore" });
      execSync("git config user.email \"test@test.com\"", { cwd: tmp, stdio: "ignore" });

      mkdirSync(join(tmp, ".agent"), { recursive: true });
      mkdirSync(join(tmp, "dist"), { recursive: true });

      const configYaml = `
verify:
  stages:
    - id: "strict-bundle-budget"
      kind: "invariant"
      assert: "dir-size"
      path: "dist"
      maxKb: 5
`;
      writeFileSync(join(tmp, ".agent", "jules.yml"), configYaml);
      writeFileSync(join(tmp, "dist", "bundle.js"), "x".repeat(100));
      execSync("git add . && git commit -m \"initial base\"", { cwd: tmp, stdio: "ignore" });

      // Create feature branch with heavy bundle
      execSync("git checkout -b feature", { cwd: tmp, stdio: "ignore" });
      writeFileSync(join(tmp, "dist", "heavy.js"), "x".repeat(20000));
      execSync("git add . && git commit -m \"heavy bundle\"", { cwd: tmp, stdio: "ignore" });

      const jsonReportPath = join(tmp, "failure-report.json");
      const res = await gate({
        root: tmp,
        base: "main",
        jsonReport: jsonReportPath,
      });

      assert.equal(res.ok, false);
      assert.equal(res.code, 4);

      assert.ok(res.evidence);
      assert.equal(res.evidence.status, "failed");
      assert.equal(res.evidence.failedStage, "strict-bundle-budget");
      assert.ok(res.evidence.diagnostics.length > 0);
      assert.ok(res.evidence.diagnostics[0].includes("exceeds limit"));
      assert.ok(res.evidence.metrics.measuredBytes >= 20000);

      // Verify report was written
      assert.ok(existsSync(jsonReportPath));
      const report = JSON.parse(readFileSync(jsonReportPath, "utf-8"));
      assert.equal(report.status, "failed");
      assert.equal(report.failedStage, "strict-bundle-budget");
      assert.ok(report.diagnostics[0].includes("exceeds limit"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("exportJsonReport produces valid schema structure", () => {
    const manifest = {
      schema: "agentctl/evidence-manifest-v1",
      manifestId: "EVD-TEST-99",
      generatedAt: new Date().toISOString(),
      status: "failed",
      failedStage: "assert:bundle-size",
      diagnostics: ["Bundle is 12MB > 10MB limit"],
      metrics: { measuredBytes: 12000000, limitBytes: 10000000 },
      evidenceHash: "sha256:1234567890abcdef",
    };

    const tmp = mkdtempSync(join(tmpdir(), "export-report-"));
    try {
      const outPath = join(tmp, "out.json");
      const rep = exportJsonReport(manifest, outPath);
      assert.equal(rep.manifestId, "EVD-TEST-99");
      assert.equal(rep.failedStage, "assert:bundle-size");
      assert.equal(rep.diagnostics[0], "Bundle is 12MB > 10MB limit");

      const onDisk = JSON.parse(readFileSync(outPath, "utf-8"));
      assert.equal(onDisk.manifestId, "EVD-TEST-99");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
