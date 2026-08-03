import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log, ensureDir, sleep } from "./utils.mjs";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dispatchScript = path.resolve(__dirname, "jules-dispatch.mjs");

const queueDir = path.resolve(process.cwd(), ".agent/jules-queue");
const completedDir = path.resolve(process.cwd(), ".agent/jules-queue/completed");
const failedDir = path.resolve(process.cwd(), ".agent/jules-queue/failed");
const queueLogFile = path.join(queueDir, "queue.jsonl");

const processingDir = path.resolve(process.cwd(), ".agent/jules-queue/.processing");

if (!fs.existsSync(queueDir)) {
  console.error(`❌ Queue directory not found: ${queueDir}`);
  process.exit(1);
}

ensureDir(completedDir);
ensureDir(failedDir);
ensureDir(processingDir);

// Recover any tasks left in .processing from a previous run or crash
const STALE_MS = 15 * 60 * 1000;
const processingFiles = fs.readdirSync(processingDir).filter(f => f.endsWith(".md"));
for (const f of processingFiles) {
  const procPath = path.join(processingDir, f);
  try {
    if (Date.now() - fs.statSync(procPath).mtimeMs < STALE_MS) continue;
    const backToQueue = path.join(queueDir, f);
    fs.renameSync(procPath, backToQueue);
    log.info(`Recovered stale task ${f} from .processing/`);
  } catch (_) {}
}

function logQueueState(file, status, error = null) {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    file,
    status,
    error: error ? error.message || String(error) : null,
  }) + "\n";
  fs.appendFileSync(queueLogFile, entry, "utf-8");
}

const files = fs.readdirSync(queueDir).filter(
  (f) => f.endsWith(".md") && f !== "README.md" && !f.startsWith("_") && !f.startsWith(".")
);

if (files.length === 0) {
  log.info("No tasks found in the queue.");
  process.exit(0);
}

log.info(`🚀 Found ${files.length} tasks in the queue. Sending to Jules...`);

const MAX_CONCURRENT = parseInt(process.env.JULES_SWARM_CONCURRENCY || "3", 10) || 3;

const args = process.argv.slice(2);
let paceMs = parseInt(process.env.JULES_PACE_MS || "500", 10);
const paceIdx = args.indexOf("--pace-ms");
if (paceIdx !== -1 && args[paceIdx + 1]) {
  const parsed = parseInt(args[paceIdx + 1], 10);
  if (Number.isFinite(parsed) && parsed >= 0) paceMs = parsed;
}

function safeMoveSync(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code === "EXDEV") {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else {
      throw err;
    }
  }
}

async function safeMoveAsync(src, dest) {
  try {
    await fs.promises.rename(src, dest);
  } catch (err) {
    if (err.code === "EXDEV") {
      await fs.promises.copyFile(src, dest);
      await fs.promises.unlink(src);
    } else {
      throw err;
    }
  }
}

export function classifyQueueFailure(error) {
  const message = String(error?.stderr || error?.stdout || error?.message || "");
  const code = error?.code;

  if (code === 6 || /RESTRICTED FILE VIOLATION|COMMAND FILE CHANGE DETECTED|SECRET LEAK PREVENTED|AGENT RULE FILE CHANGE DETECTED|Security violation/i.test(message)) return "security_violation";
  if (code === 5 || /DIFF PAYLOAD TOO LARGE|DIFF TOO LARGE/i.test(message)) return "diff_too_large";
  if (code === 8 || /lock contention|lock busy/i.test(message)) return "budget_locked";
  if (code === 7 || /Daily budget exhausted|budget exhausted/i.test(message)) return "budget_exhausted";
  if (/HTTP 429|Rate Limit Exceeded|FAILED_PRECONDITION|Active Session Limit/i.test(message)) return "concurrency_limit";
  if (/HTTP 5\d\d/i.test(message)) return "api_error";
  if (/command not found|ENOENT|CLI|execFile|spawn|exit code/i.test(message)) return "cli_error";
  return "unknown";
}

const queueStateDir = path.join(queueDir, ".state");
if (!fs.existsSync(queueStateDir)) {
  fs.mkdirSync(queueStateDir, { recursive: true });
}

function getTaskState(filename) {
  const stateFile = path.join(queueStateDir, `${filename}.json`);
  if (fs.existsSync(stateFile)) {
    try {
      return JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    } catch (_) {}
  }
  return { attempts: 0 };
}

function setTaskState(filename, stateObj) {
  const stateFile = path.join(queueStateDir, `${filename}.json`);
  try {
    fs.writeFileSync(stateFile, JSON.stringify(stateObj, null, 2), "utf-8");
  } catch (_) {}
}

async function runQueue() {
  let permanentFailuresCount = 0;
  for (let i = 0; i < files.length; i += MAX_CONCURRENT) {
    const batch = files.slice(i, i + MAX_CONCURRENT);
    await Promise.allSettled(
      batch.map(async (file, bIdx) => {
        if (bIdx > 0 && paceMs > 0) {
          await sleep(bIdx * paceMs);
        }
        const index = i + bIdx;
        const filePath = path.join(queueDir, file);
        const processingPath = path.join(processingDir, file);
        
        // Atomic claim: move from queueDir to processingDir before dispatching
        try {
          safeMoveSync(filePath, processingPath);
          const now = new Date();
          fs.utimesSync(processingPath, now, now);
        } catch (claimErr) {
          // Another runner already claimed this task file or file missing
          return;
        }

        let title = file.replace(/\.md$/, "").replace(/-/g, " ");
        
        const content = fs.readFileSync(processingPath, "utf-8").trim();
        const h1Match = content.match(/^#\s+(.+)$/m);
        if (h1Match && h1Match[1].trim()) {
          title = h1Match[1].trim();
        }
        
        if (!content || content.length < 10) {
          log.warn(`Task file ${file} is empty or invalid. Skipping dispatch.`);
          const destPath = path.join(completedDir, file);
          await safeMoveAsync(processingPath, destPath);
          logQueueState(file, "SKIPPED_INVALID");
          return;
        }

        log.step(`[${index + 1}/${files.length}]`, `🚀 Sending task to Jules: ${title}`);
        logQueueState(file, "RUNNING");
        
        try {
          await execFileAsync("node", [dispatchScript, title, processingPath], { timeout: 10 * 60 * 1000 });
          
          const destPath = path.join(completedDir, file);
          await safeMoveAsync(processingPath, destPath);
          setTaskState(file, { status: "DISPATCHED", completed_at: new Date().toISOString() });
          logQueueState(file, "DISPATCHED");
          log.success(`Task dispatched successfully (Moved ${file} to completed/)`);
        } catch (error) {
          logQueueState(file, "FAILED", error);

          const failureClass = classifyQueueFailure(error);
          const NON_RETRYABLE = new Set(["security_violation", "diff_too_large"]);

          const taskState = getTaskState(file);

          if (failureClass === "budget_exhausted") {
            setTaskState(file, { attempts: taskState.attempts || 0, status: "DEFERRED_BUDGET", failure_class: failureClass, last_error: error.message, updated_at: new Date().toISOString() });
            try { await safeMoveAsync(processingPath, filePath); } catch (_) {}
            log.warn(`Task [${title}] deferred due to daily budget limit. Left in queue for next budget reset.`);
          } else if (failureClass === "budget_locked") {
            setTaskState(file, { attempts: taskState.attempts || 0, status: "REQUEUED_LOCK_BUSY", failure_class: failureClass, last_error: error.message, updated_at: new Date().toISOString() });
            try { await safeMoveAsync(processingPath, filePath); } catch (_) {}
            log.warn(`Task [${title}] lock contention (busy). Re-queued for retry.`);
          } else if (failureClass === "concurrency_limit") {
            setTaskState(file, { attempts: taskState.attempts || 0, status: "REQUEUED_CONCURRENCY", failure_class: failureClass, last_error: error.message, updated_at: new Date().toISOString() });
            try { await safeMoveAsync(processingPath, filePath); } catch (_) {}
            log.warn(`Task [${title}] active session quota (~30) reached. Pausing 15s before re-queuing.`);
            await sleep(15000);
          } else {
            const attempts = (taskState.attempts || 0) + 1;
            if (NON_RETRYABLE.has(failureClass) || attempts >= 3) {
              permanentFailuresCount++;
              const destPath = path.join(failedDir, file);
              setTaskState(file, { attempts, status: "FAILED_PERMANENT", failure_class: failureClass, last_error: error.message, updated_at: new Date().toISOString() });
              try { await safeMoveAsync(processingPath, destPath); } catch (_) {}
              log.error(`Task [${title}] failed (${failureClass}). Moved to failed/. Error: ${error.message}`);
            } else {
              setTaskState(file, { attempts, status: "REQUEUED", failure_class: failureClass, last_error: error.message, updated_at: new Date().toISOString() });
              try { await safeMoveAsync(processingPath, filePath); } catch (_) {}
              log.warn(`Task [${title}] failed (${failureClass}). Re-queued (Attempt ${attempts}/3). Error: ${error.message}`);
            }
          }
        }
      })
    );
  }
  if (permanentFailuresCount > 0) {
    log.error(`Queue processing complete with ${permanentFailuresCount} failed task(s).`);
    process.exit(1);
  }
  log.header("Queue processing complete!");
}

runQueue().catch(err => {
  log.error(`Fatal queue error: ${err.message}`);
  process.exit(1);
});
