/**
 * Swarm session audit & reservation sync manifest.
 *
 * Extracted from the deleted `scripts/utils.mjs` shim. These four functions
 * are the SDK-level surface index.mjs re-exports (extractPrUrls,
 * auditSessions, buildSyncManifest, pushReservationManifest): parsing PR
 * links out of session outputs, bucketing sessions by staleness, and writing
 * the swarm reservation manifest the merge gate reads.
 */

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function extractPrUrls(outputs = []) {
  const prs = [];
  const regex = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/g;
  for (const item of outputs) {
    const text = typeof item === "string" ? item : item?.link || JSON.stringify(item);
    const matches = text.match(regex);
    if (matches) {
      for (const m of matches) {
        if (!prs.includes(m)) prs.push(m);
      }
    }
  }
  return prs;
}

export function auditSessions(sessions = [], opts = {}) {
  const staleHoursThreshold = opts.staleHoursThreshold || 24;
  const now = Date.now();
  const merged = [];
  const active = [];
  const stale = [];

  for (const s of sessions) {
    if (s.state === "MERGED") {
      merged.push(s);
    } else {
      const updatedMs = s.updateTime ? new Date(s.updateTime).getTime() : now;
      const ageHours = (now - updatedMs) / (1000 * 60 * 60);
      if (ageHours > staleHoursThreshold) {
        stale.push(s);
      } else {
        active.push(s);
      }
    }
  }

  return { merged, active, stale };
}

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
