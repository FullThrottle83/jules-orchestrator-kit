#!/usr/bin/env node

import { checkAssetIntegrity } from "../src/asset-integrity.mjs";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const dirsToScan = ["public", "src/assets", "assets", "static"].map((d) => join(root, d)).filter(existsSync);

if (dirsToScan.length === 0) {
  console.log("[asset-integrity] No asset directories (public/, src/assets/) found. Passing.");
  process.exit(0);
}

let totalChecked = 0;
let allCorrupted = [];

for (const dir of dirsToScan) {
  const res = checkAssetIntegrity(dir);
  totalChecked += res.checkedCount;
  allCorrupted.push(...res.corruptedFiles);
}

console.log(`[asset-integrity] Checked ${totalChecked} binary/font assets across ${dirsToScan.length} directories.`);

if (allCorrupted.length > 0) {
  console.error("❌ ASSET INTEGRITY FAILURE: Found corrupted assets (HTML/text saved as binary):");
  for (const item of allCorrupted) {
    console.error(`  - ${item.path}: ${item.reason}`);
  }
  process.exit(1);
}

console.log("✅ Asset integrity check passed cleanly.");
process.exit(0);
