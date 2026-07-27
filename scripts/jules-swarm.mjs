import { execFileSync } from "node:child_process";
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

console.log(`🐝 Launching Jules Swarm Orchestrator (${tasks.length} tasks, Rate-Limit Throttled)...`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runSwarm() {
  const results = [];
  const MAX_CONCURRENT = 2;
  const STAGGER_MS = 2500; // 2.5s delay between dispatches to prevent API 429 thrashing

  for (let i = 0; i < tasks.length; i += MAX_CONCURRENT) {
    const batch = tasks.slice(i, i + MAX_CONCURRENT);
    const batchResults = await Promise.allSettled(
      batch.map(async (task, bIdx) => {
        const taskNum = i + bIdx + 1;
        const taskId = task.id || `task-${taskNum}`;

        // Stagger dispatches inside batch
        if (bIdx > 0) {
          await sleep(STAGGER_MS * bIdx);
        }

        console.log(`\n----------------------------------------`);
        console.log(`[${taskNum}/${tasks.length}] Dispatching Swarm Task: ${task.title} (${taskId})`);

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

    for (const r of batchResults) {
      if (r.status === "fulfilled") {
        results.push(r.value);
      } else {
        results.push({ title: "Unknown Task", status: "FAILED", error: r.reason });
      }
    }

    if (i + MAX_CONCURRENT < tasks.length) {
      console.log(`\n⏳ Batch finished. Cooling down for 3s before next batch...`);
      await sleep(3000);
    }
  }

  console.log(`\n========================================`);
  console.log(`🎉 Swarm Dispatch Summary (${results.length} tasks processed):`);
  results.forEach((res) => {
    console.log(`  - [${res.status}] ${res.title}`);
  });
}

runSwarm();
