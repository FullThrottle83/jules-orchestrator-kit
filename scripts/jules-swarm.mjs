import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { log, sleep } from "./utils.mjs";

const execFileAsync = promisify(execFile);

const tasksFile = process.argv[2];

if (!tasksFile) {
  log.error("Usage: node scripts/jules-swarm.mjs <path-to-tasks.json>");
  log.error('Format of tasks.json: [ { "id": "t1", "title": "Task 1", "prompt": "Description 1", "scope": ["src/moduleA/**"] } ]');
  process.exit(1);
}

const resolvedPath = path.resolve(process.cwd(), tasksFile);
if (!fs.existsSync(resolvedPath)) {
  log.error(`Tasks file not found: ${resolvedPath}`);
  process.exit(1);
}

const tasks = JSON.parse(fs.readFileSync(resolvedPath, "utf-8"));
if (!Array.isArray(tasks)) {
  log.error("tasks.json must contain a JSON array of task objects.");
  process.exit(1);
}

const parsedConcurrent = parseInt(process.env.JULES_SWARM_CONCURRENCY || "3", 10);
const MAX_CONCURRENT = Number.isFinite(parsedConcurrent) && parsedConcurrent > 0 ? parsedConcurrent : 3;

const parsedStagger = parseInt(process.env.JULES_SWARM_STAGGER_MS || "1500", 10);
const STAGGER_MS = Number.isFinite(parsedStagger) && parsedStagger >= 0 ? parsedStagger : 1500;

const USE_WORKTREES = process.env.JULES_USE_WORKTREES === "true";

// Ensure root project path is preserved for history logs even when running in worktrees
process.env.JULES_PROJECT_ROOT = process.cwd();

log.info(`Launching Jules Swarm Orchestrator (${tasks.length} tasks, Concurrency: ${MAX_CONCURRENT}, Worktrees: ${USE_WORKTREES ? "ENABLED" : "DISABLED"})...`);

const activeWorktrees = new Set();

function cleanupAllWorktreesSync() {
  for (const item of Array.from(activeWorktrees)) {
    if (item.wtDir && fs.existsSync(item.wtDir)) {
      try {
        fs.chmodSync(item.wtDir, 0o755);
      } catch (_) {}
    }
    try {
      execFileSync("git", ["worktree", "remove", "--force", item.wtDir], { stdio: "ignore" });
    } catch (_) {}
    if (item.branchName) {
      try {
        execFileSync("git", ["branch", "-D", item.branchName], { stdio: "ignore" });
      } catch (_) {}
    }
  }
  activeWorktrees.clear();
}

function reapOrphanedWorktrees() {
  const worktreesBase = path.resolve(process.cwd(), ".agent/worktrees");
  if (!fs.existsSync(worktreesBase)) return;
  try {
    const entries = fs.readdirSync(worktreesBase);
    for (const entry of entries) {
      const wtPath = path.join(worktreesBase, entry);
      try {
        execFileSync("git", ["worktree", "remove", "--force", wtPath], { stdio: "ignore" });
      } catch (_) {
        try {
          fs.rmSync(wtPath, { recursive: true, force: true });
        } catch (_) {}
      }
      try {
        execFileSync("git", ["branch", "-D", `jules/${entry}`], { stdio: "ignore" });
      } catch (_) {}
    }
  } catch (_) {}
  try {
    execFileSync("git", ["worktree", "prune"], { stdio: "ignore" });
  } catch (_) {}
}

process.on("SIGINT", () => {
  log.dim("SIGINT received. Cleaning up active Git worktrees...");
  cleanupAllWorktreesSync();
  process.exit(130);
});

process.on("SIGTERM", () => {
  log.dim("SIGTERM received. Cleaning up active Git worktrees...");
  cleanupAllWorktreesSync();
  process.exit(143);
});

async function createWorktree(taskId) {
  const slug = taskId.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const wtDir = path.resolve(process.cwd(), `.agent/worktrees/${slug}`);
  const branchName = `jules/${slug}`;
  let item = null;
  await fs.promises.mkdir(path.dirname(wtDir), { recursive: true });

  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await execFileAsync("git", ["worktree", "add", "-b", branchName, wtDir, "HEAD"]);
      item = { wtDir, branchName };
      break;
    } catch (err) {
      if (attempt < maxRetries) {
        const jitter = Math.floor(Math.random() * 200) + 100 * Math.pow(2, attempt);
        await sleep(jitter);
        continue;
      }
      try {
        await execFileAsync("git", ["worktree", "add", "--force", wtDir, "HEAD"]);
        item = { wtDir, branchName: null };
      } catch (fallbackErr) {
        log.error(`Failed to create worktree for ${taskId}: ${fallbackErr.message}`);
        return null;
      }
    }
  }
  if (item) activeWorktrees.add(item);
  return item;
}

async function removeWorktree(wtDir, branchName) {
  if (!wtDir) return;
  for (const item of Array.from(activeWorktrees)) {
    if (item.wtDir === wtDir) {
      activeWorktrees.delete(item);
    }
  }
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", wtDir]);
  } catch (err) {
    log.error(`Failed to remove worktree at ${wtDir}: ${err.message}`);
  }
  if (branchName) {
    try {
      await execFileAsync("git", ["branch", "-D", branchName]);
    } catch (err) {
      log.error(`Failed to delete swarm branch ${branchName}: ${err.message}`);
    }
  }
}

async function runSwarm() {
  if (USE_WORKTREES) {
    reapOrphanedWorktrees();
  }
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

        log.step("======", `[${taskNum}/${tasks.length}] Dispatching Swarm Task: ${task.title} (${taskId})`);

        let wtInfo = null;
        let execCwd = process.cwd();

        if (USE_WORKTREES) {
          wtInfo = await createWorktree(taskId);
          if (wtInfo?.wtDir) {
            execCwd = wtInfo.wtDir;
            log.info(`Isolated Task ${taskId} in Git Worktree: ${wtInfo.wtDir}`);
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
            env: {
              ...process.env,
              JULES_PROJECT_ROOT: process.env.JULES_PROJECT_ROOT,
              JULES_SLOT_INDEX: String(taskNum),
              JULES_SLOT_TOTAL: String(tasks.length)
            },
          });
          if (stdout) log.dim(stdout.trim());
          return { taskId, title: task.title, status: "SUCCESS" };
        } catch (error) {
          log.error(`Failed task [${task.title}]: ${error.message}`);
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
      log.info(`Batch finished. Cooling down for 2s before next batch...`);
      await sleep(2000);
    }
  }

  log.header(`Swarm Dispatch Summary (${results.length} tasks processed):`);
  results.forEach((res) => {
    log.info(`[${res.status}] ${res.title}`);
  });

  if (hasFailure) {
    process.exitCode = 1;
  }
}

runSwarm().catch((err) => {
  log.error(`Unhandled swarm rejection: ${err.message}`);
  process.exit(1);
});
