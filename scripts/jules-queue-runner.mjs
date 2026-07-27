import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const queueDir = path.resolve(process.cwd(), ".agent/jules-queue");
const completedDir = path.resolve(process.cwd(), ".agent/jules-queue/completed");

if (!fs.existsSync(queueDir)) {
  console.error(`❌ Queue directory not found: ${queueDir}`);
  process.exit(1);
}

if (!fs.existsSync(completedDir)) {
  fs.mkdirSync(completedDir, { recursive: true });
}

const files = fs.readdirSync(queueDir).filter(f => f.endsWith(".md"));

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
  
  try {
    execFileSync("node", ["scripts/jules-dispatch.mjs", title, filePath], {
      stdio: "inherit",
    });
    
    // Move to completed
    const destPath = path.join(completedDir, file);
    fs.renameSync(filePath, destPath);
    console.log(`✅ Moved ${file} to completed/`);
  } catch (error) {
    console.error(`⚠️ Failed to dispatch task [${title}]:`, error.message);
  }
});

console.log(`\n🎉 Queue processing complete!`);
