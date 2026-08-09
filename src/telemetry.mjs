import {
  openSync,
  writeSync,
  closeSync,
  readFileSync,
  existsSync,
  statSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { resolveRoot } from "./config.mjs";
import { getStateDir, withVfsMutex } from "./state.mjs";
import { safeAtomicWrite } from "./security.mjs";

export const MAX_TELEMETRY_SEGMENT_BYTES = 8 * 1024 * 1024; // 8 MB log segment ceiling
export const TELEMETRY_GENESIS_HASH = "0".repeat(64);

/**
 * Returns telemetry file paths for a given date string sorted by segment index.
 */
function getTelemetrySegmentFiles(stateDir, dateStr) {
  if (!existsSync(stateDir)) return [];
  const prefix = `telemetry-${dateStr}`;
  const files = readdirSync(stateDir).filter(
    (f) => f.startsWith(prefix) && f.endsWith(".jsonl")
  );

  return files
    .map((name) => {
      let index = 0;
      if (name !== `${prefix}.jsonl`) {
        const match = name.match(/telemetry-[0-9]{4}-[0-9]{2}-[0-9]{2}-([0-9]+)\.jsonl$/);
        if (match) index = parseInt(match[1], 10);
      }
      return { name, path: join(stateDir, name), index };
    })
    .sort((a, b) => a.index - b.index);
}

/**
 * Performs a cold scan of telemetry jsonl files to recover the last valid hash and active segment index.
 */
function coldScanTelemetry(stateDir, dateStr) {
  const segments = getTelemetrySegmentFiles(stateDir, dateStr);
  if (segments.length === 0) {
    return { hash: TELEMETRY_GENESIS_HASH, segment: 0 };
  }

  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (existsSync(seg.path)) {
      try {
        const content = readFileSync(seg.path, "utf-8");
        const lines = content.split("\n").filter(Boolean);
        for (let j = lines.length - 1; j >= 0; j--) {
          try {
            const entry = JSON.parse(lines[j]);
            if (entry && typeof entry.hash === "string") {
              return { hash: entry.hash, segment: seg.index };
            }
          } catch (_) {}
        }
      } catch (_) {}
    }
  }

  return { hash: TELEMETRY_GENESIS_HASH, segment: 0 };
}

/**
 * Appends a structured telemetry event to .agent/state/telemetry-<date>.jsonl with SHA-256 hash chaining.
 * Uses .head atomic cache for O(1) constant-time appends.
 *
 * @param {string} [rootOrOpts]
 * @param {string} kind
 * @param {Object} [fields={}]
 * @returns {Object} Appended telemetry record
 */
export function appendTelemetry(rootOrOpts = resolveRoot(), kind = "event", fields = {}) {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  const stateDir = getStateDir(root);
  const mutexDir = join(stateDir, ".telemetry.mutex");

  return withVfsMutex(mutexDir, () => {
    const dateStr = new Date().toISOString().split("T")[0];
    const headPath = join(stateDir, `telemetry-${dateStr}.head`);

    let prevHash = TELEMETRY_GENESIS_HASH;
    let activeSegmentIndex = 0;
    let headValid = false;

    if (existsSync(headPath)) {
      try {
        const headContent = readFileSync(headPath, "utf-8");
        const headObj = JSON.parse(headContent);
        if (headObj && typeof headObj.hash === "string") {
          prevHash = headObj.hash;
          activeSegmentIndex = typeof headObj.segment === "number" ? headObj.segment : 0;
          headValid = true;
        }
      } catch (_) {}
    }

    if (!headValid) {
      const recovered = coldScanTelemetry(stateDir, dateStr);
      prevHash = recovered.hash;
      activeSegmentIndex = recovered.segment;
    }

    let activeFileName =
      activeSegmentIndex === 0
        ? `telemetry-${dateStr}.jsonl`
        : `telemetry-${dateStr}-${activeSegmentIndex}.jsonl`;
    let activeFilePath = join(stateDir, activeFileName);

    if (existsSync(activeFilePath)) {
      try {
        const stat = statSync(activeFilePath);
        if (stat.size >= MAX_TELEMETRY_SEGMENT_BYTES) {
          activeSegmentIndex += 1;
          activeFileName = `telemetry-${dateStr}-${activeSegmentIndex}.jsonl`;
          activeFilePath = join(stateDir, activeFileName);
        }
      } catch (_) {}
    }

    const ts = new Date().toISOString();
    const payloadWithoutHash = { v: 1, ts, kind, ...fields, prevHash };
    const hash = createHash("sha256").update(JSON.stringify(payloadWithoutHash)).digest("hex");
    const entry = { ...payloadWithoutHash, hash };

    const fd = openSync(activeFilePath, "a");
    try {
      writeSync(fd, JSON.stringify(entry) + "\n", "utf-8");
    } finally {
      closeSync(fd);
    }

    safeAtomicWrite(
      headPath,
      JSON.stringify({ v: 1, hash, segment: activeSegmentIndex, ts }),
      { sync: false }
    );

    return entry;
  });
}

/**
 * Reads telemetry records across segments for a target date (or current date if omitted).
 * Returns array of telemetry objects in chronological order.
 *
 * @param {string} [rootOrOpts]
 * @param {number} [limit=50]
 * @param {string} [targetDateStr]
 * @returns {Array<Object>}
 */
export function readTelemetry(rootOrOpts = resolveRoot(), limit = 50, targetDateStr = null) {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  const stateDir = getStateDir(root);
  const dateStr = targetDateStr || new Date().toISOString().split("T")[0];

  const segments = getTelemetrySegmentFiles(stateDir, dateStr);
  if (segments.length === 0) return [];

  const allEntries = [];
  for (const seg of segments) {
    if (existsSync(seg.path)) {
      try {
        const raw = readFileSync(seg.path, "utf-8");
        const lines = raw.split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            allEntries.push(Object.freeze(entry));
          } catch (_) {}
        }
      } catch (_) {}
    }
  }

  if (allEntries.length <= limit) {
    return allEntries;
  }
  return allEntries.slice(allEntries.length - limit);
}

/**
 * Verifies the cryptographic SHA-256 hash-chain integrity of telemetry records for a date.
 *
 * @param {string} [rootOrOpts]
 * @param {string} [targetDateStr]
 * @returns {Object}
 */
export function verifyTelemetryIntegrity(rootOrOpts = resolveRoot(), targetDateStr = null) {
  const root = typeof rootOrOpts === "string" ? rootOrOpts : resolveRoot();
  const stateDir = getStateDir(root);
  const dateStr = targetDateStr || new Date().toISOString().split("T")[0];

  const segments = getTelemetrySegmentFiles(stateDir, dateStr);
  if (segments.length === 0) {
    return { ok: true, count: 0, lastHash: TELEMETRY_GENESIS_HASH };
  }

  let expectedPrevHash = TELEMETRY_GENESIS_HASH;
  let totalCount = 0;

  for (const seg of segments) {
    if (!existsSync(seg.path)) continue;
    try {
      const raw = readFileSync(seg.path, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        totalCount++;
        let obj;
        try {
          obj = JSON.parse(lines[i]);
        } catch (err) {
          return { ok: false, segment: seg.name, line: i + 1, error: "TORN_WRITE_CORRUPTION", detail: err.message };
        }

        if (!obj.hash || !obj.prevHash) {
          return { ok: false, segment: seg.name, line: i + 1, error: "MISSING_HASH_FIELDS" };
        }

        if (obj.prevHash !== expectedPrevHash) {
          return {
            ok: false,
            segment: seg.name,
            line: i + 1,
            error: "BROKEN_PREV_HASH",
            expected: expectedPrevHash,
            actual: obj.prevHash,
          };
        }

        const { hash, ...rest } = obj;
        const recomputed = createHash("sha256").update(JSON.stringify(rest)).digest("hex");
        if (recomputed !== hash) {
          return {
            ok: false,
            segment: seg.name,
            line: i + 1,
            error: "CORRUPTED_ENTRY_HASH",
            expected: recomputed,
            actual: hash,
          };
        }
        expectedPrevHash = hash;
      }
    } catch (err) {
      return { ok: false, count: totalCount, error: err.message };
    }
  }

  const headPath = join(stateDir, `telemetry-${dateStr}.head`);
  if (existsSync(headPath)) {
    try {
      const headObj = JSON.parse(readFileSync(headPath, "utf-8"));
      if (headObj.hash !== expectedPrevHash) {
        return {
          ok: false,
          error: "HEAD_HASH_MISMATCH",
          expected: expectedPrevHash,
          actual: headObj.hash,
        };
      }
    } catch (_) {
      return { ok: false, error: "CORRUPTED_HEAD_FILE" };
    }
  }

  return { ok: true, count: totalCount, lastHash: expectedPrevHash };
}
