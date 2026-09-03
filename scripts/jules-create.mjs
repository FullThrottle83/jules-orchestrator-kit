#!/usr/bin/env node

/**
 * Quick task file creator for .agent/jules-queue/.
 */

import { runTaskCreateWizard } from "../src/wizard-task.mjs";

const prompt = process.argv.slice(2).join(" ").trim();

try {
  const result = await runTaskCreateWizard(process.cwd(), prompt ? { prompt } : {});
  console.log(`✅ Scaffolded task envelope: ${result.taskFile}`);
} catch (err) {
  console.error(`❌ Failed to create task: ${err.message}`);
  process.exit(1);
}
