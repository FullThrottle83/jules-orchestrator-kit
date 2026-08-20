import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeFileHash,
  computeDirectoryHash,
  generateEvidenceManifest,
  writeEvidenceManifest,
  loadEvidenceManifest,
  verifyEvidenceManifest,
  generateEvidenceMarkdown,
  computeEvidenceHash,
} from "../src/evidence.mjs";
import {
  planEvidenceGenerate,
  planEvidenceVerify,
  planEvidenceShow,
} from "../src/ops/evidence-actions.mjs";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("src/evidence.mjs & Evidence Gate Subsystem", () => {
  it("computeFileHash returns null for non-existent files and valid sha256 for real files", () => {
    assert.equal(computeFileHash("/path/to/nonexistent/file.txt"), null);
    const tmp = mkdtempSync(join(tmpdir(), "evd-test-"));
    try {
      const filePath = join(tmp, "sample.txt");
      writeFileSync(filePath, "hello world\n", "utf-8");
      const hash = computeFileHash(filePath);
      assert.ok(typeof hash === "string");
      assert.ok(hash.startsWith("sha256:"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("computeDirectoryHash produces deterministic hash over test suites", () => {
    const tmp = mkdtempSync(join(tmpdir(), "evd-dir-test-"));
    try {
      mkdirSync(join(tmp, "test"), { recursive: true });
      writeFileSync(join(tmp, "test", "a.test.js"), "assert.ok(true);", "utf-8");
      writeFileSync(join(tmp, "test", "b.test.js"), "assert.ok(1 === 1);", "utf-8");

      const res1 = computeDirectoryHash(tmp, { testOnly: true });
      assert.equal(res1.fileCount, 2);
      assert.ok(res1.treeHash.startsWith("sha256:"));

      const res2 = computeDirectoryHash(tmp, { testOnly: true });
      assert.equal(res1.treeHash, res2.treeHash, "Tree hash must be deterministic across calls");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("generateEvidenceManifest builds valid manifest with signed evidenceHash", () => {
    const tmp = mkdtempSync(join(tmpdir(), "evd-manifest-"));
    try {
      mkdirSync(join(tmp, "test"), { recursive: true });
      writeFileSync(join(tmp, "test", "app.test.js"), "test('pass', () => {})", "utf-8");

      const manifest = generateEvidenceManifest(tmp, {
        taskId: "TASK-123",
        title: "Test Task",
        prompt: "Fix bug in auth handler",
        executionRecords: [
          { id: "unit", kind: "test", cmd: "npm test", exitCode: 0, durationMs: 120, networkAccess: "forbidden" },
        ],
        secretScanOk: true,
        diffKb: 12,
      });

      assert.equal(manifest.schema, "agentctl/evidence-manifest-v1");
      assert.equal(manifest.intent.taskId, "TASK-123");
      assert.equal(manifest.testIntegrity.tamperDetected, false);
      assert.equal(manifest.testIntegrity.testFileCount, 1);
      assert.ok(manifest.evidenceHash.startsWith("sha256:"));

      const expectedHash = computeEvidenceHash(manifest);
      assert.equal(manifest.evidenceHash, expectedHash);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("writeEvidenceManifest and loadEvidenceManifest serialize and verify cryptographic signature", () => {
    const tmp = mkdtempSync(join(tmpdir(), "evd-io-"));
    try {
      const manifest = generateEvidenceManifest(tmp, {
        taskId: "TASK-999",
        title: "Signature Test",
      });

      const writtenPath = writeEvidenceManifest(tmp, manifest);
      assert.ok(writtenPath.endsWith(`${manifest.manifestId}.json`));

      const loaded = loadEvidenceManifest(tmp, manifest.manifestId);
      assert.equal(loaded.manifestId, manifest.manifestId);
      assert.equal(loaded.evidenceHash, manifest.evidenceHash);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("verifyEvidenceManifest catches test suite tampering (No Test Weakening Invariant)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "evd-tamper-"));
    try {
      mkdirSync(join(tmp, "test"), { recursive: true });
      const testFile = join(tmp, "test", "core.test.js");
      writeFileSync(testFile, "test('strict rule', () => { assert.equal(1, 1); });", "utf-8");

      // Generate evidence with baseline test state
      const manifest = generateEvidenceManifest(tmp, {
        taskId: "TASK-STRICT",
      });
      writeEvidenceManifest(tmp, manifest);

      // Verify baseline succeeds
      const check1 = verifyEvidenceManifest(tmp, manifest);
      assert.equal(check1.ok, true);

      // Simulate model weakening test assertions
      writeFileSync(testFile, "test('weakened rule', () => { /* test deleted */ });", "utf-8");

      const check2 = verifyEvidenceManifest(tmp, manifest);
      assert.equal(check2.ok, false);
      assert.ok(check2.reason.includes("does not match manifest evidence"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("generateEvidenceMarkdown formats clean PR-ready markdown summary", () => {
    const manifest = {
      schema: "agentctl/evidence-manifest-v1",
      manifestId: "EVD-123",
      evidenceHash: "sha256:abcdef0123456789",
      testIntegrity: { tamperDetected: false, testFileCount: 4, postTestHash: "sha256:9988776655" },
      securityChecks: { secretScanOk: true, diffKb: 14, maxDiffKb: 75 },
      executionRecords: [
        { id: "unit", kind: "test", cmd: "forge test --offline", networkAccess: "forbidden", exitCode: 0, durationMs: 450 },
      ],
    };

    const md = generateEvidenceMarkdown(manifest);
    assert.ok(md.includes("### 🛡️ Autonomous Verification & Evidence Proof"));
    assert.ok(md.includes("`EVD-123`"));
    assert.ok(md.includes("`4 test files`"));
    assert.ok(md.includes("🔒 Offline"));
    assert.ok(md.includes("`forge test --offline`"));
  });

  it("planEvidenceGenerate and planEvidenceVerify work end-to-end via ops layer", () => {
    const tmp = mkdtempSync(join(tmpdir(), "evd-ops-"));
    try {
      mkdirSync(join(tmp, "test"), { recursive: true });
      writeFileSync(join(tmp, "test", "sanity.test.js"), "assert.ok(true);", "utf-8");

      const genRes = planEvidenceGenerate(tmp, { markdownOutput: join(tmp, "EVIDENCE.md") });
      assert.equal(genRes.ok, true);
      assert.ok(genRes.manifestPath.endsWith(".json"));

      const verifyRes = planEvidenceVerify(tmp);
      assert.equal(verifyRes.ok, true);

      const showRes = planEvidenceShow(tmp);
      assert.equal(showRes.ok, true);
      assert.ok(showRes.markdown.includes("Autonomous Verification & Evidence Proof"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
