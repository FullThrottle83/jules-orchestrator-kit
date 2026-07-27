import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dispatchScript = path.resolve(__dirname, "jules-dispatch.mjs");

const queueDir = path.resolve(process.cwd(), ".agent/jules-queue");
const completedDir = path.resolve(process.cwd(), ".agent/jules-queue/completed");
const queueLogFile = path.join(queueDir, "queue.jsonl");

if (!fs.existsSync(queueDir)) {
  console.error(`❌ Queue directory not found: ${queueDir}`);
  process.exit(1);
}

if (!fs.existsSync(completedDir)) {
  fs.mkdirSync(completedDir, { recursive: true });
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
  console.log("ℹ️ No tasks found in the queue.");
  process.exit(0);
}

console.log(`🐝 Found ${files.length} tasks in the queue. Processing...`);

files.forEach((file, index) => {
  const filePath = path.join(queueDir, file);
  // Generate title from filename (e.g. "TASK-001-auth-spec.md" -> "TASK 001 auth spec")
  const title = file.replace(/\.md$/, "").replace(/-/g, " ");
  
  console.log(`\n----------------------------------------`);
  console.log(`[${index + 1}/${files.length}] Dispatching queued task: ${title}`);
  logQueueState(file, "RUNNING");
  
  try {
    execFileSync("node", [dispatchScript, title, filePath], {
      stdio: "inherit",
    });
    
    // Move to completed
    const destPath = path.join(completedDir, file);
    fs.renameSync(filePath, destPath);
    logQueueState(file, "COMPLETED");
    console.log(`✅ Moved ${file} to completed/`);
  } catch (error) {
    logQueueState(file, "FAILED", error);
    console.error(`⚠️ Failed to dispatch task [${title}]:`, error.message);
  }
});

console.log(`\n🎉 Queue processing complete!`);
