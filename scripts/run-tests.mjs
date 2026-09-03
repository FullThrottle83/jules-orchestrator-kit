#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cpus } from "node:os";

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

// Node runs one test file per core by default. Several suites here spawn a
// verification command of their own — `npm test`, and in the monorepo fixtures
// an `npm test --workspaces` that fans out to one node per package — so the
// real peak is a multiple of the file count, not the file count. On a
// twelve-core laptop that saturates every core for the length of the run,
// which cooks the machine and makes the throughput assertions (1000 telemetry
// appends under 6s) fail for reasons that have nothing to do with the code.
//
// Half the cores keeps the suite comfortably parallel while leaving room for
// the children it spawns. JULES_TEST_CONCURRENCY overrides it — CI runners
// with two cores are already below this and are unaffected.
const cpuCount = Math.max(1, cpus().length);
const envConcurrency = Number(process.env.JULES_TEST_CONCURRENCY);
const concurrency = Number.isFinite(envConcurrency) && envConcurrency > 0
  ? Math.floor(envConcurrency)
  : Math.max(2, Math.floor(cpuCount / 2));
const concurrencyArgs = supportsTestTimeout ? [`--test-concurrency=${concurrency}`] : [];

const res = spawnSync(process.execPath, ["--test", ...timeoutArgs, ...concurrencyArgs, ...testFiles], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

process.exit(res.status ?? 1);
