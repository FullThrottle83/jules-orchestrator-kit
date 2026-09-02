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

// A hung test has to fail, not stall. The readKeypresses() stdin regression
// failed by hanging rather than throwing: without a per-test deadline that
// burns a CI job to GitHub's six-hour default instead of going red in
// seconds. The slowest genuine test on the Windows runner is ~2s, so this is
// two orders of magnitude of headroom and only ever fires on a real hang.
const timeoutMs = Number(process.env.JULES_TEST_TIMEOUT_MS) || 180_000;

// `--test-timeout` landed in Node 20.6. package.json engines allows >=20.0.0,
// and an unrecognised flag makes Node abort before running anything — so on an
// older runtime the suite runs without the deadline rather than not at all.
const [major, minor] = process.versions.node.split(".").map(Number);
const supportsTestTimeout = major > 20 || (major === 20 && minor >= 6);
const timeoutArgs = supportsTestTimeout ? [`--test-timeout=${timeoutMs}`] : [];

const res = spawnSync(process.execPath, ["--test", ...timeoutArgs, ...testFiles], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

process.exit(res.status ?? 1);
