#!/usr/bin/env node

import { readFileSync, existsSync } from "node:fs";
import { validateEnvelope } from "../src/envelope.mjs";

const args = process.argv.slice(2);
const envelopeFile = args[0];

if (!envelopeFile) {
  console.log("Usage: node scripts/validate-envelope.mjs <path-to-envelope.json>");
  process.exit(1);
}

if (!existsSync(envelopeFile)) {
  console.error(`Error: Envelope file not found: ${envelopeFile}`);
  process.exit(1);
}

try {
  const content = readFileSync(envelopeFile, "utf-8");
  const payload = JSON.parse(content);
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
  console.error(`❌ Invalid JSON or execution error: ${err.message}`);
  process.exit(1);
}
