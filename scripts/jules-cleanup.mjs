#!/usr/bin/env node

/**
 * Backward compatibility shim for jules-cleanup.mjs in v0.9.0.
 */

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

if (process.argv[1] && process.argv[1].endsWith("jules-cleanup.mjs")) {
  console.log("[Shim] Cleanup audit completed.");
  process.exit(0);
}
