#!/usr/bin/env node
/**
 * Jules Task Status Utility
 * Parses the queue.jsonl file and renders a clean console.table
 */

import fs from "node:fs";
import path from "node:path";
import { log } from "./utils.mjs";

const queueLogPath = path.resolve(process.cwd(), ".agent/jules-queue/queue.jsonl");

if (!fs.existsSync(queueLogPath)) {
  log.info("Queue log is empty. No tasks have been dispatched yet.");
  process.exit(0);
}

try {
  const content = fs.readFileSync(queueLogPath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  
  if (lines.length === 0) {
    log.info("Queue log is empty.");
    process.exit(0);
  }

  // We only want the latest status for each task file
  const statusMap = new Map();

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.file) {
        statusMap.set(entry.file, {
          Task: entry.file.replace(/^TASK-\d+-/, "").replace(/\.md$/, ""),
          Status: entry.status,
          Timestamp: new Date(entry.timestamp).toLocaleString(),
          Error: entry.error || "-"
        });
      }
    } catch (e) {
      // Ignore malformed lines
    }
  }

  if (statusMap.size === 0) {
    log.info("No parseable task events found in queue.jsonl");
    process.exit(0);
  }

  log.header("Jules Queue Status");
  console.table(Array.from(statusMap.values()));

} catch (err) {
  log.error(`Failed to read queue log: ${err.message}`);
  process.exit(1);
}
