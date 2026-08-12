import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { recordRemediation, queryRemediations, harvestFailureRecord, hydrateMemory } from "../src/remediation.mjs";
import { createExecutionEnvelope, verifyExecutionEnvelope } from "../src/execution_envelope.mjs";

describe("Remediation Subsystem & Envelope Hydration", () => {
  const testRoot = join(process.cwd(), ".agent/test-remediation-" + Date.now());

  test("recordRemediation persists sanitized entries to remediations.jsonl", () => {
    try {
      const entry = recordRemediation(testRoot, {
        fingerprint: "abc123sha256",
        targetFiles: ["src/engine.mjs", "src\\utils.mjs"],
        symptom: "Failed verification with secret sk_test_51MockStripeSecretPatternTest99",
        remediationHint: "Add missing null check in normalizeScope()",
      });

      assert.ok(entry.id.startsWith("rem-"));
      assert.strictEqual(entry.fingerprint, "abc123sha256");
      assert.deepStrictEqual(entry.targetFiles, ["src/engine.mjs", "src/utils.mjs"]);
      assert.ok(!entry.symptom.includes("sk_test_51MockStripeSecretPatternTest99"));

      const filePath = join(testRoot, ".agent/state/remediations.jsonl");
      assert.strictEqual(existsSync(filePath), true);

      const raw = readFileSync(filePath, "utf-8");
      assert.ok(raw.includes("abc123sha256"));
      assert.ok(raw.includes("normalizeScope()"));
    } finally {
      try { rmSync(testRoot, { recursive: true, force: true }); } catch (_) {}
    }
  });

  test("queryRemediations filters by fingerprint and target file paths", () => {
    try {
      recordRemediation(testRoot, {
        fingerprint: "fp-fingerprint-1",
        targetFiles: ["src/config.mjs"],
        symptom: "Config parse error",
        remediationHint: "Fix YAML syntax",
      });

      recordRemediation(testRoot, {
        fingerprint: "fp-fingerprint-2",
        targetFiles: ["src/engine.mjs"],
        symptom: "Gate timeout error",
        remediationHint: "Increase timeout threshold",
      });

      // Match by exact fingerprint
      const byFp = queryRemediations(testRoot, { fingerprint: "fp-fingerprint-1" });
      assert.strictEqual(byFp.length, 1);
      assert.strictEqual(byFp[0].remediationHint, "Fix YAML syntax");

      // Match by target file path
      const byFile = queryRemediations(testRoot, { targetFiles: ["src/engine.mjs"] });
      assert.strictEqual(byFile.length, 1);
      assert.strictEqual(byFile[0].remediationHint, "Increase timeout threshold");

      // Non-matching query returns empty array
      const noMatch = queryRemediations(testRoot, { targetFiles: ["nonexistent.mjs"] });
      assert.strictEqual(noMatch.length, 0);
    } finally {
      try { rmSync(testRoot, { recursive: true, force: true }); } catch (_) {}
    }
  });

  test("createExecutionEnvelope hydrates matching remediations into execution envelope pre-flight", () => {
    try {
      recordRemediation(testRoot, {
        fingerprint: "fp-envelope-test",
        targetFiles: ["src/auth.mjs"],
        symptom: "Auth token validation failure",
        remediationHint: "Use timingSafeEqual for token comparison",
      });

      const envelope = createExecutionEnvelope(
        { id: "task-remediation-hydrated", files: ["src/auth.mjs"] },
        { root: testRoot }
      );

      assert.ok(Array.isArray(envelope.remediations));
      assert.strictEqual(envelope.remediations.length, 1);
      assert.strictEqual(envelope.remediations[0].remediationHint, "Use timingSafeEqual for token comparison");
      assert.strictEqual(verifyExecutionEnvelope(envelope), true);

      // Verify Object.freeze applies to remediations
      assert.throws(() => {
        envelope.remediations.push({ hint: "tamper" });
      }, TypeError);
    } finally {
      try { rmSync(testRoot, { recursive: true, force: true }); } catch (_) {}
    }
  });

  test("harvestFailureRecord and hydrateMemory format learned remediations correctly", () => {
    try {
      const rec = harvestFailureRecord(testRoot, {
        symptom: "Database pool connection timeout",
        remediationHint: "Increase max connection pool limit and add retry backoff",
        targetFiles: ["src/db.mjs"],
        fingerprint: "fp-db-timeout",
      });

      assert.ok(rec);
      assert.strictEqual(rec.fingerprint, "fp-db-timeout");

      const hydrated = hydrateMemory(testRoot, { targetFiles: ["src/db.mjs"] });
      assert.ok(hydrated.includes("[LEARNED_REMEDIATIONS_CONTEXT]"));
      assert.ok(hydrated.includes("Database pool connection timeout"));
      assert.ok(hydrated.includes("Increase max connection pool limit"));

      const emptyHydrated = hydrateMemory(testRoot, { targetFiles: ["src/unknown_file.mjs"] });
      assert.strictEqual(emptyHydrated, "");
    } finally {
      try { rmSync(testRoot, { recursive: true, force: true }); } catch (_) {}
    }
  });
});


