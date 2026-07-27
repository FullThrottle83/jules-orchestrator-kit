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
const queueLogFile = path.join(queueDir, "queue.jsonl");

const processingDir = path.resolve(process.cwd(), ".agent/jules-queue/.processing");

if (!fs.existsSync(queueDir)) {
  console.error(`❌ Queue directory not found: ${queueDir}`);
  process.exit(1);
}

ensureDir(completedDir);
ensureDir(processingDir);

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

async function runQueue() {
  for (let i = 0; i < files.length; i += MAX_CONCURRENT) {
    const batch = files.slice(i, i + MAX_CONCURRENT);
    await Promise.allSettled(
      batch.map(async (file, bIdx) => {
        const index = i + bIdx;
        const filePath = path.join(queueDir, file);
        const processingPath = path.join(processingDir, file);
        
        // Atomic claim: move from queueDir to processingDir before dispatching
        try {
          safeMoveSync(filePath, processingPath);
        } catch (claimErr) {
          // Another runner already claimed this task file or file missing
          return;
        }

        const title = file.replace(/\.md$/, "").replace(/-/g, " ");
        
        const content = fs.readFileSync(processingPath, "utf-8").trim();
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
          await execFileAsync("node", [dispatchScript, title, processingPath]);
          
          const destPath = path.join(completedDir, file);
          await safeMoveAsync(processingPath, destPath);
          logQueueState(file, "DISPATCHED");
          log.success(`Task dispatched successfully (Moved ${file} to completed/)`);
        } catch (error) {
          logQueueState(file, "FAILED", error);
          log.error(`Failed to dispatch task [${title}]: ${error.message}`);
        }
      })
    );
  }
  log.header("Queue processing complete!");
}

runQueue().catch(err => {
  log.error(`Fatal queue error: ${err.message}`);
  process.exit(1);
});
