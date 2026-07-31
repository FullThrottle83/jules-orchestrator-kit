#!/usr/bin/env node
/**
 * Jules Task Scaffolding Utility
 * Quickly creates a boilerplate markdown task in .agent/jules-queue/
 */

import fs from "node:fs";
import path from "node:path";
import { log, ensureDir } from "./utils.mjs";

const taskTitle = process.argv[2];

if (!taskTitle) {
  log.error("Usage: npm run jules:create \"Task Title\"");
  process.exit(1);
}

const queueDir = path.resolve(process.cwd(), ".agent/jules-queue");
ensureDir(queueDir);

const safeTitle = taskTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

let maxId = 0;
const dirsToCheck = [queueDir, path.join(queueDir, ".processing"), path.join(queueDir, "completed")];

for (const dir of dirsToCheck) {
  try {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (f.startsWith("TASK-") && f.endsWith(".md")) {
        const match = f.match(/^TASK-(\d+)-/);
        if (match) {
          const id = parseInt(match[1], 10);
          if (id > maxId) maxId = id;
        }
      }
    }
  } catch (e) {
    // Directory might not exist yet, that's fine
  }
}

const nextId = (maxId + 1).toString().padStart(3, "0");
const filename = `TASK-${nextId}-${safeTitle}.md`;
const filepath = path.join(queueDir, filename);

const boilerplate = `# ${taskTitle}

## Objective
[Describe the primary goal of this task in a few sentences]

## Context & Files
[List the specific files Jules should focus on or any context required]
- 

## Verification
[How should Jules verify that this task is completed? e.g., run tests, check UI]
`;

try {
  fs.writeFileSync(filepath, boilerplate, "utf-8");
  log.success(`Scaffolded new task: ${path.relative(process.cwd(), filepath)}`);
  log.dim("Open this file, fill in the details, and run `npm run jules:queue` when ready!");
} catch (err) {
  log.error(`Failed to create task file: ${err.message}`);
  process.exit(1);
}
