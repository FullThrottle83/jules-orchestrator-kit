import fs from "node:fs";
import path from "node:path";
import { log, checkDailyBudget } from "./utils.mjs";

const isJson = process.argv.includes("--json");
const queueLogPath = path.resolve(process.cwd(), ".agent/jules-queue/queue.jsonl");

const budgetInfo = checkDailyBudget();

if (!fs.existsSync(queueLogPath)) {
  if (isJson) {
    console.log(JSON.stringify({ queue: [], budget: budgetInfo }, null, 2));
  } else {
    log.info("Queue log is empty. No tasks have been dispatched yet.");
  }
  process.exit(0);
}

try {
  const content = fs.readFileSync(queueLogPath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  
  if (lines.length === 0) {
    if (isJson) {
      console.log(JSON.stringify({ queue: [], budget: budgetInfo }, null, 2));
    } else {
      log.info("Queue log is empty.");
    }
    process.exit(0);
  }

  // We only want the latest status for each task file
  const statusMap = new Map();

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.file) {
        statusMap.set(entry.file, {
          file: entry.file,
          Task: entry.file.replace(/^TASK-\d+-/, "").replace(/\.md$/, ""),
          Status: entry.status,
          Timestamp: entry.timestamp,
          Error: entry.error || null
        });
      }
    } catch (e) {
      // Ignore malformed lines
    }
  }

  const tasksList = Array.from(statusMap.values());

  if (isJson) {
    console.log(JSON.stringify({ queue: tasksList, budget: budgetInfo }, null, 2));
    process.exit(0);
  }

  if (tasksList.length === 0) {
    log.info("No parseable task events found in queue.jsonl");
    process.exit(0);
  }

  log.header(`JULES QUEUE STATUS (Budget: ${budgetInfo.used}/${budgetInfo.budget} sessions used)`);
  console.table(tasksList.map(t => ({ Task: t.Task, Status: t.Status, Timestamp: new Date(t.Timestamp).toLocaleString(), Error: t.Error || "-" })));

} catch (err) {
  if (isJson) {
    console.log(JSON.stringify({ error: err.message }, null, 2));
  } else {
    log.error(`Failed to read queue log: ${err.message}`);
  }
  process.exit(1);
}
