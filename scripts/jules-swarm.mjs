import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

const tasksFile = process.argv[2];

if (!tasksFile) {
  console.error("Usage: node scripts/jules-swarm.mjs <path-to-tasks.json>");
  console.error('Format of tasks.json: [ { "id": "t1", "title": "Task 1", "prompt": "Description 1", "scope": ["src/moduleA/**"] } ]');
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

const parsedConcurrent = parseInt(process.env.JULES_SWARM_CONCURRENCY || "3", 10);
const MAX_CONCURRENT = Number.isFinite(parsedConcurrent) && parsedConcurrent > 0 ? parsedConcurrent : 3;

const parsedStagger = parseInt(process.env.JULES_SWARM_STAGGER_MS || "1500", 10);
const STAGGER_MS = Number.isFinite(parsedStagger) && parsedStagger >= 0 ? parsedStagger : 1500;

const USE_WORKTREES = process.env.JULES_USE_WORKTREES === "true";

// Ensure root project path is preserved for history logs even when running in worktrees
process.env.JULES_PROJECT_ROOT = process.cwd();

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
    } catch (fallbackErr) {
      console.warn(`⚠️ Failed to create worktree for ${taskId}:`, fallbackErr.message);
      return null;
    }
  }
}

async function removeWorktree(wtDir, branchName) {
  if (!wtDir) return;
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", wtDir]);
  } catch (err) {
    console.warn(`⚠️ Failed to remove worktree at ${wtDir}:`, err.message);
  }
  if (branchName) {
    try {
      await execFileAsync("git", ["branch", "-D", branchName]);
    } catch (err) {
      console.warn(`⚠️ Failed to delete swarm branch ${branchName}:`, err.message);
    }
  }
}

async function runSwarm() {
  const results = [];
  let hasFailure = false;

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

        let effectivePrompt = task.prompt || "";
        if (task.scope) {
          const scopeStr = typeof task.scope === "string" ? task.scope : JSON.stringify(task.scope);
          effectivePrompt += `\n\n[SCOPE LOCK]\nStrictly limit changes to designated bounds: ${scopeStr}`;
        }

        try {
          const dispatchScript = path.resolve(process.cwd(), "scripts/jules-dispatch.mjs");
          const { stdout } = await execFileAsync("node", [dispatchScript, task.title, effectivePrompt], {
            cwd: execCwd,
            timeout: 15 * 60 * 1000,
            env: { ...process.env, JULES_PROJECT_ROOT: process.env.JULES_PROJECT_ROOT },
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
        if (r.value.status === "FAILED") hasFailure = true;
      } else {
        results.push({ title: "Unknown Task", status: "FAILED", error: r.reason });
        hasFailure = true;
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

  if (hasFailure) {
    process.exitCode = 1;
  }
}

runSwarm().catch((err) => {
  console.error("❌ Unhandled swarm rejection:", err);
  process.exit(1);
});
