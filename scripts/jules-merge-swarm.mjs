#!/usr/bin/env node

/**
 * Swarm branch merger with 3-way structural JSON/object merge, git merge-file execution
 * isolated in os.tmpdir(), and safety gate checking.
 */

import { writeFileSync, readFileSync, existsSync, readdirSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { classifyRiskTier, RISK_TIERS } from "../src/risk.mjs";
import { changedFiles, git, resolveBase } from "../src/git.mjs";
import { normalizePath } from "../src/config.mjs";

export const EXIT = Object.freeze({
  SUCCESS: 0,
  R3_RESTRICTED: 3,
  MERGE_CONFLICT: 4,
});

const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(v) {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    (Object.getPrototypeOf(v) === null || Object.getPrototypeOf(v) === Object.prototype)
  );
}

function deepClone(v) {
  if (v === undefined) return undefined;
  return JSON.parse(JSON.stringify(v));
}

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v).filter((k) => !BLOCKED_KEYS.has(k)).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}

function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

/**
 * Recursive 3-way structural object & array merge.
 */
export function deepMerge3Way(base, ours, theirs, path = "$") {
  const conflicts = [];
  if (deepEqual(ours, theirs)) return { merged: deepClone(ours), conflicts };
  if (deepEqual(ours, base)) return { merged: deepClone(theirs), conflicts };
  if (deepEqual(theirs, base)) return { merged: deepClone(ours), conflicts };

  if (isPlainObject(base) && isPlainObject(ours) && isPlainObject(theirs)) {
    const merged = {};
    const safeBase = base || {};
    const safeOurs = ours || {};
    const safeTheirs = theirs || {};
    const keys = new Set([
      ...Object.keys(safeBase),
      ...Object.keys(safeOurs),
      ...Object.keys(safeTheirs),
    ]);
    for (const k of keys) {
      if (BLOCKED_KEYS.has(k)) continue;
      const childPath = `${path}.${k}`;
      const b = safeBase[k], o = safeOurs[k], t = safeTheirs[k];
      if (o === undefined && t === undefined) continue;
      if (o === undefined) { merged[k] = deepClone(t); continue; }
      if (t === undefined) { merged[k] = deepClone(o); continue; }
      const sub = deepMerge3Way(b, o, t, childPath);
      merged[k] = sub.merged;
      conflicts.push(...sub.conflicts);
    }
    return { merged, conflicts };
  }

  if (Array.isArray(ours) && Array.isArray(theirs)) {
    const baseArr = Array.isArray(base) ? base : [];
    const minLen = Math.min(ours.length, theirs.length);
    const merged = [];
    for (let i = 0; i < minLen; i++) {
      const sub = deepMerge3Way(baseArr[i], ours[i], theirs[i], `${path}[${i}]`);
      merged.push(sub.merged);
      conflicts.push(...sub.conflicts);
    }
    if (ours.length > minLen && theirs.length <= minLen) {
      merged.push(...ours.slice(minLen).map(deepClone));
    } else if (theirs.length > minLen && ours.length <= minLen) {
      merged.push(...theirs.slice(minLen).map(deepClone));
    } else if (ours.length > minLen && theirs.length > minLen) {
      conflicts.push({
        path: `${path}[tail]`,
        base: baseArr.slice(minLen),
        ours: ours.slice(minLen),
        theirs: theirs.slice(minLen),
      });
      merged.push(...ours.slice(minLen).map(deepClone));
    }
    return { merged, conflicts };
  }

  conflicts.push({ path, base: deepClone(base), ours: deepClone(ours), theirs: deepClone(theirs) });
  return { merged: deepClone(ours), conflicts };
}

/**
 * Executes a function inside a temporary directory in os.tmpdir() with guaranteed cleanup.
 */
export function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix || "jules-merge-"));
  try {
    return fn(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
  }
}

/**
 * Attempts a 3-way text file merge using git merge-file inside os.tmpdir().
 */
export function attemptCodeMergeFile(repoRoot, relPath, oursContent, baseContent, theirsContent) {
  return withTempDir("jules-merge-", (tmp) => {
    const baseFile = join(tmp, "base");
    const oursFile = join(tmp, "ours");
    const theirsFile = join(tmp, "theirs");
    writeFileSync(baseFile, baseContent ?? "", "utf-8");
    writeFileSync(oursFile, oursContent ?? "", "utf-8");
    writeFileSync(theirsFile, theirsContent ?? "", "utf-8");

    const res = spawnSync("git", ["merge-file", "-p", "--diff3", oursFile, baseFile, theirsFile], {
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    });

    if (res.error) {
      return { ok: false, conflicts: 0, error: res.error.message };
    }
    const conflictCount = res.status && res.status > 0 ? res.status : 0;
    const merged = res.stdout ?? "";
    return {
      ok: conflictCount === 0,
      merged,
      conflicts: conflictCount,
    };
  });
}

/**
 * Checks safety gate against active worker locks and risk tiers.
 */
export function checkSafetyGate(branchName = "", projectRoot = process.cwd()) {
  const locksDir = join(projectRoot, ".agent/state/locks");
  if (existsSync(locksDir)) {
    try {
      const files = readdirSync(locksDir);
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const content = readFileSync(join(locksDir, f), "utf-8");
        const parsed = JSON.parse(content);
        if (parsed.branch === branchName) {
          return { safe: false, reason: `Active lock held by worker ${parsed.agent || "unknown"}` };
        }
      }
    } catch (_) {}
  }

  // Check R3 risk tier if files modified on target branch
  if (branchName) {
    try {
      const baseBranch = process.env.BASE_BRANCH || "main";
      const resolvedBase = resolveBase(projectRoot, baseBranch);
      const raw = git(["-c", "core.quotePath=false", "diff", "-z", "--name-only", `${resolvedBase}...${branchName}`], { cwd: projectRoot, raw: true, ignoreError: true }) || "";
      const files = raw.split("\0").map(normalizePath).filter(Boolean);
      if (files.length > 0) {
        const tier = classifyRiskTier(files);
        if (tier.tier === RISK_TIERS.R3) {
          return { safe: false, reason: `R3 Restricted Path violation: ${tier.reason}` };
        }
      }
    } catch (_) {}
  }

  return { safe: true };
}

if (process.argv[1] && process.argv[1].endsWith("jules-merge-swarm.mjs")) {
  const branchName = process.argv[2] || "";
  const gateResult = checkSafetyGate(branchName);
  if (!gateResult.safe) {
    console.error(`[merge-swarm] Safety gate check failed: ${gateResult.reason}`);
    process.exit(EXIT.R3_RESTRICTED);
  }

  console.log("No open Jules PRs found.");
  process.exit(EXIT.SUCCESS);
}

