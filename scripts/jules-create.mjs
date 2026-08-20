#!/usr/bin/env node

/**
 * Quick task file creator for .agent/jules-queue/.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getQueueDir } from "../src/state.mjs";

const taskTitle = process.argv[2] || "New Task";
const queueDir = getQueueDir();
const safeTitle = taskTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const filepath = join(queueDir, `TASK-${Date.now()}-${safeTitle}.md`);

const boilerplate = `# ${taskTitle}

## Objective
[Describe task goal]
`;

try {
  writeFileSync(filepath, boilerplate, "utf-8");
  console.log(`[Shim] Scaffolded new task: ${filepath}`);
} catch (err) {
  console.error(`[Shim] Failed to create task: ${err.message}`);
  process.exit(1);
}
