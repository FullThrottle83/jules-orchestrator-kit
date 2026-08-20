#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const testDir = join(root, "test");
const testFiles = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort()
  .map((f) => join("test", f));

const res = spawnSync(process.execPath, ["--test", ...testFiles], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

process.exit(res.status ?? 1);
