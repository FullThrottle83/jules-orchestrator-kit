#!/usr/bin/env node

import { readFileSync, existsSync } from "node:fs";
import { validateEnvelope, parseEnvelopeHeader } from "../src/envelope.mjs";

const args = process.argv.slice(2);
const envelopeFile = args[0];

if (!envelopeFile) {
  console.log("Usage: node scripts/validate-envelope.mjs <path-to-envelope.json|path-to-task.md>");
  process.exit(1);
}

if (!existsSync(envelopeFile)) {
  console.error(`Error: Envelope file not found: ${envelopeFile}`);
  process.exit(1);
}

try {
  const content = readFileSync(envelopeFile, "utf-8");
  let payload = null;
  if (envelopeFile.endsWith(".json")) {
    payload = JSON.parse(content);
  } else {
    payload = parseEnvelopeHeader(content);
    if (!payload) {
      try {
        payload = JSON.parse(content);
      } catch {
        payload = null;
      }
    }
  }

  if (!payload || typeof payload !== "object") {
    console.error("❌ TASK ENVELOPE PREMISE VALIDATION FAILED:");
    console.error("  - File does not contain a valid JSON payload or task envelope frontmatter.");
    process.exit(1);
  }

  const res = validateEnvelope(payload);

  if (!res.ok) {
    console.error("❌ TASK ENVELOPE PREMISE VALIDATION FAILED:");
    for (const err of res.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  if (res.warnings.length > 0) {
    console.warn("⚠️ TASK ENVELOPE WARNINGS:");
    for (const w of res.warnings) {
      console.warn(`  - ${w}`);
    }
  }

  console.log("✅ Task envelope validated successfully.");
  process.exit(0);
} catch (err) {
  console.error(`❌ Invalid envelope or execution error: ${err.message}`);
  process.exit(1);
}
