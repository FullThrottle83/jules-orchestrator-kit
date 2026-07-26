import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const tasksFile = process.argv[2];

if (!tasksFile) {
  console.error("Usage: node scripts/jules-swarm.mjs <path-to-tasks.json>");
  console.error("Format of tasks.json: [ { \"title\": \"Task 1\", \"prompt\": \"Description 1\" } ]");
  process.exit(1);
}

const resolvedPath = path.resolve(process.cwd(), tasksFile);
if (!fs.existsSync(resolvedPath)) {
  console.error(`❌ Tasks file not found: ${resolvedPath}`);
  process.exit(1);
}

const tasks = JSON.parse(fs.readFileSync(resolvedPath, "utf-8"));
if (!Array.isArray(tasks)) {
  console.error("❌ tasks.json must contain a JSON array of task objects.");
  process.exit(1);
}

console.log(`🐝 Launching Jules Swarm Orchestrator (${tasks.length} tasks)...`);

tasks.forEach((task, index) => {
  console.log(`\n----------------------------------------`);
  console.log(`[${index + 1}/${tasks.length}] Dispatching: ${task.title}`);
  try {
    execFileSync("node", ["scripts/jules-dispatch.mjs", task.title, task.prompt], {
      stdio: "inherit",
    });
  } catch (error) {
    console.error(`⚠️ Failed to dispatch task [${task.title}]:`, error.message);
  }
});

console.log(`\n🎉 Swarm Dispatch Complete! All ${tasks.length} tasks queued.`);
