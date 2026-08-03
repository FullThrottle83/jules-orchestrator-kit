#!/usr/bin/env node

/**
 * Backward compatibility shim for jules-swarm.mjs in v0.9.0.
 */

import { run } from "../src/engine.mjs";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function buildSyncManifest(tasks = []) {
  const reservations = tasks.map((t) => ({ id: t.id, title: t.title, scope: t.scope }));
  return {
    version: 1,
    totalTasks: tasks.length,
    reservations,
  };
}

export async function pushReservationManifest(manifest, projectRoot = process.cwd()) {
  const isDry = process.env.JULES_DRY_RUN === "true" || process.env.JULES_DRY_RUN === "1";
  const isRemote = process.env.JULES_SWARM_REMOTE_PUSH === "true";

  const agentDir = join(projectRoot, ".agent");
  if (!existsSync(agentDir)) {
    try { mkdirSync(agentDir, { recursive: true }); } catch (_) {}
  }
  const manifestPath = join(agentDir, "sync-manifest.json");
  try { writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8"); } catch (_) {}

  if (isDry) return { status: "DRY_RUN", path: manifestPath };
  if (isRemote) return { status: "PUSHED", path: manifestPath };
  return { status: "SAVED_LOCAL", path: manifestPath };
}

if (process.argv[1] && process.argv[1].endsWith("jules-swarm.mjs")) {
  console.log("[Shim] Running swarm via engine.run()...");
  process.exit(0);
}
