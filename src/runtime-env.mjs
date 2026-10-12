/**
 * Runtime environment helpers shared by the kit's CLI entry points.
 *
 * Extracted from the deleted `scripts/utils.mjs` shim: .env loading,
 * timestamping, the console logger the CLI entries print through, and the
 * isolated SDK cache directory. Nothing here is business logic; these are the
 * small environment primitives entry scripts (and tests) need so they do not
 * each carry their own copy.
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import os from "node:os";

export const log = {
  info: (msg) => console.log(`ℹ️  ${msg}`),
  success: (msg) => console.log(`✅ ${msg}`),
  warn: (msg) => console.warn(`⚠️  ${msg}`),
  error: (msg) => console.error(`❌ ${msg}`),
  step: (stepStr, msg) => console.log(`${stepStr} ${msg}`),
  dim: (msg) => console.log(msg),
  header: (msg) => console.log(`\n=== ${msg} ===\n`),
  groupEnd: () => {},
};

export function timestamp() {
  return new Date().toISOString();
}

/**
 * Loads KEY=VALUE lines from `<targetDir>/.env` into `process.env`.
 * Quoted values and leading `export ` are tolerated; a missing file is a no-op.
 */
export function loadEnv(targetDir = process.cwd()) {
  const envPath = join(targetDir, ".env");
  if (!existsSync(envPath)) return;
  try {
    const raw = readFileSync(envPath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const clean = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
      const eqIdx = clean.indexOf("=");
      if (eqIdx > 0) {
        const k = clean.slice(0, eqIdx).trim();
        let v = clean.slice(eqIdx + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        process.env[k] = v;
      }
    }
  } catch (_) {}
}

export function getIsolatedCacheDir() {
  return process.env.JULES_CACHE_DIR ? resolve(process.env.JULES_CACHE_DIR) : join(os.homedir(), ".cache", "jules-orchestrator-kit");
}

export function ensureSdkCacheIsolation() {
  const dir = getIsolatedCacheDir();
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }); } catch (_) {}
  }
  process.env.JULES_CACHE_DIR = dir;
  return dir;
}
