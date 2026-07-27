import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

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

const MAX_CONCURRENT = parseInt(process.env.JULES_SWARM_CONCURRENCY || "3", 10);
const STAGGER_MS = parseInt(process.env.JULES_SWARM_STAGGER_MS || "1500", 10);
const USE_WORKTREES = process.env.JULES_USE_WORKTREES === "true";

console.log(`🐝 Launching Jules Swarm Orchestrator (${tasks.length} tasks, Concurrency: ${MAX_CONCURRENT}, Worktrees: ${USE_WORKTREES ? "ENABLED" : "DISABLED"})...`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function createWorktree(taskId) {
  const slug = taskId.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const wtDir = path.resolve(process.cwd(), `.agent/worktrees/${slug}`);
  const branchName = `jules/${slug}`;
  try {
    if (!fs.existsSync(path.dirname(wtDir))) {
      fs.mkdirSync(path.dirname(wtDir), { recursive: true });
    }
    await execFileAsync("git", ["worktree", "add", "-b", branchName, wtDir, "HEAD"]);
    return { wtDir, branchName };
  } catch (err) {
    try {
      await execFileAsync("git", ["worktree", "add", "--force", wtDir, "HEAD"]);
      return { wtDir, branchName: null };
    } catch (_) {
      return null;
    }
  }
}

async function removeWorktree(wtDir, branchName) {
  if (!wtDir) return;
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", wtDir]);
  } catch (_) {}
  if (branchName) {
    try {
      await execFileAsync("git", ["branch", "-D", branchName]);
    } catch (_) {}
  }
}

async function runSwarm() {
  const results = [];

  for (let i = 0; i < tasks.length; i += MAX_CONCURRENT) {
    const batch = tasks.slice(i, i + MAX_CONCURRENT);
    const batchResults = await Promise.allSettled(
      batch.map(async (task, bIdx) => {
        const taskNum = i + bIdx + 1;
        const taskId = task.id || `task-${taskNum}`;

        if (bIdx > 0) {
          await sleep(STAGGER_MS * bIdx);
        }

        console.log(`\n----------------------------------------`);
        console.log(`[${taskNum}/${tasks.length}] Dispatching Swarm Task: ${task.title} (${taskId})`);

        let wtInfo = null;
        let execCwd = process.cwd();

        if (USE_WORKTREES) {
          wtInfo = await createWorktree(taskId);
          if (wtInfo?.wtDir) {
            execCwd = wtInfo.wtDir;
            console.log(`🌲 Isolated Task ${taskId} in Git Worktree: ${wtInfo.wtDir}`);
          }
        }

        try {
          const dispatchScript = path.resolve(process.cwd(), "scripts/jules-dispatch.mjs");
          const { stdout } = await execFileAsync("node", [dispatchScript, task.title, task.prompt], {
            cwd: execCwd,
            timeout: 15 * 60 * 1000,
          });
          if (stdout) console.log(stdout.trim());
          return { taskId, title: task.title, status: "SUCCESS" };
        } catch (error) {
          console.error(`⚠️ Failed task [${task.title}]:`, error.message);
          return { taskId, title: task.title, status: "FAILED", error: error.message };
        } finally {
          if (wtInfo?.wtDir) {
            await removeWorktree(wtInfo.wtDir, wtInfo.branchName);
          }
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
      console.log(`\n⏳ Batch finished. Cooling down for 2s before next batch...`);
      await sleep(2000);
    }
  }

  console.log(`\n========================================`);
  console.log(`🎉 Swarm Dispatch Summary (${results.length} tasks processed):`);
  results.forEach((res) => {
    console.log(`  - [${res.status}] ${res.title}`);
  });
}

runSwarm();

