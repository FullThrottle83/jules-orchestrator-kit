import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const tasksFile = process.argv[2];

if (!tasksFile) {
  console.error("Usage: node scripts/jules-swarm.mjs <path-to-tasks.json>");
  console.error('Format of tasks.json: [ { "id": "t1", "title": "Task 1", "prompt": "Description 1" } ]');
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

async function runSwarm() {
  const results = await Promise.allSettled(
    tasks.map(async (task, index) => {
      const taskId = task.id || `task-${index + 1}`;
      console.log(`\n----------------------------------------`);
      console.log(`[${index + 1}/${tasks.length}] Dispatching Swarm Task: ${task.title} (${taskId})`);

      try {
        execFileSync("node", ["scripts/jules-dispatch.mjs", task.title, task.prompt], {
          stdio: "inherit",
          timeout: 15 * 60 * 1000, // 15 minute TTL
        });
        return { taskId, title: task.title, status: "SUCCESS" };
      } catch (error) {
        console.error(`⚠️ Failed task [${task.title}]:`, error.message);
        return { taskId, title: task.title, status: "FAILED", error: error.message };
      }
    })
  );

  console.log(`\n========================================`);
  console.log(`🎉 Swarm Dispatch Summary (${results.length} tasks processed):`);
  results.forEach((r) => {
    const val = r.value || {};
    console.log(`  - [${val.status}] ${val.title}`);
  });
}

runSwarm();
