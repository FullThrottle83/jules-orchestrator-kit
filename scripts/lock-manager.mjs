#!/usr/bin/env node

/**
 * lock-manager.mjs
 * 
 * Manages multi-agent file locks to prevent concurrent modification collisions.
 * Uses .agent/sync-manifest.json as the lock registry.
 * 
 * Usage:
 *   node scripts/lock-manager.mjs acquire <agent_name> <task_id> <file_path1> <file_path2> [--unattended]
 *   node scripts/lock-manager.mjs release <task_id>
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const MANIFEST_PATH = path.join(process.cwd(), '.agent', 'sync-manifest.json');
const TTL_MS = 20 * 60 * 1000; // 20 minutes

async function readManifest() {
  try {
    const data = await fs.readFile(MANIFEST_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {};
    }
    throw err;
  }
}

async function writeManifest(manifest) {
  await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
  const tmp = MANIFEST_PATH + `.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf-8');
  await fs.rename(tmp, MANIFEST_PATH);
}

async function withManifestLock(fn) {
  const lockPath = MANIFEST_PATH + ".lock";
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  for (let i = 0; i < 50; i++) {
    try {
      const stats = await fs.stat(lockPath);
      if (Date.now() - stats.mtimeMs > 5 * 60 * 1000) {
        await fs.rm(lockPath, { force: true });
      }
    } catch (_) {}

    let handle;
    try {
      handle = await fs.open(lockPath, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      await new Promise(r => setTimeout(r, 50 + Math.random() * 50));
      continue;
    }
    try { return await fn(); }
    finally {
      try { await handle.close(); } catch (_) {}
      await fs.rm(lockPath, { force: true });
    }
  }
  throw new Error("Could not acquire manifest lock");
}

function cleanExpiredLocks(manifest) {
  const now = Date.now();
  let changed = false;
  for (const [file, lock] of Object.entries(manifest)) {
    if (lock.expiresAt < now) {
      delete manifest[file];
      changed = true;
    }
  }
  return changed;
}

async function acquireLocks(agentName, taskId, files) {
  await withManifestLock(async () => {
    const manifest = await readManifest();
  cleanExpiredLocks(manifest);
  
  const now = Date.now();
  const expiresAt = now + TTL_MS;

  const conflicts = [];
  for (const file of files) {
    const normalizedFile = path.normalize(file);
    if (manifest[normalizedFile] && manifest[normalizedFile].taskId !== taskId) {
      conflicts.push({
        file: normalizedFile,
        lockedBy: manifest[normalizedFile].agentName,
        task: manifest[normalizedFile].taskId
      });
    }
  }

    if (conflicts.length > 0) {
      let msg = `Cannot acquire locks for task ${taskId}. Conflicts detected:\n`;
      for (const conflict of conflicts) {
        msg += `  - ${conflict.file} is locked by ${conflict.lockedBy} (Task: ${conflict.task})\n`;
      }
      throw new Error(msg.trim());
    }

  for (const file of files) {
    const normalizedFile = path.normalize(file);
    manifest[normalizedFile] = {
      agentName,
      taskId,
      acquiredAt: now,
      expiresAt
    };
  }

    await writeManifest(manifest);
    console.log(`SUCCESS: Acquired locks for task ${taskId} on ${files.length} files.`);
  });
}

async function releaseLocks(taskId) {
  await withManifestLock(async () => {
    const manifest = await readManifest();
  let releasedCount = 0;
  
  for (const [file, lock] of Object.entries(manifest)) {
    if (lock.taskId === taskId) {
      delete manifest[file];
      releasedCount++;
    }
  }

    if (releasedCount > 0) {
      await writeManifest(manifest);
      console.log(`SUCCESS: Released ${releasedCount} locks for task ${taskId}.`);
    } else {
      console.log(`INFO: No locks found for task ${taskId}.`);
    }
  });
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'acquire') {
    const agentName = args[1];
    const taskId = args[2];
    const unattendedIndex = args.indexOf('--unattended');
    
    let files = [];
    if (unattendedIndex !== -1) {
       files = args.slice(3, unattendedIndex).concat(args.slice(unattendedIndex + 1));
    } else {
       files = args.slice(3);
    }
    
    if (!agentName || !taskId || files.length === 0) {
      console.error('Usage: acquire <agent_name> <task_id> <file_paths...>');
      process.exit(1);
    }
    
    await acquireLocks(agentName, taskId, files);
  } else if (command === 'release') {
    const taskId = args[1];
    if (!taskId) {
      console.error('Usage: release <task_id>');
      process.exit(1);
    }
    await releaseLocks(taskId);
  } else {
    console.error('Unknown command. Use "acquire" or "release".');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
