#!/usr/bin/env node
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { cpus } from "node:os";

const root = process.cwd();
const testDir = join(root, "test");

// The published package ships `scripts/` and not `test/`, so running
// `npm test` inside an installed copy crashed with a raw
// `ENOENT: no such file or directory, scandir '.../test'`. The suite is not
// missing; it was never part of the tarball. Say that, rather than leaving
// someone to work it out from a stack trace.
if (!existsSync(testDir)) {
  console.error("No test/ directory here.");
  console.error("");
  console.error("If this is an installed copy of jules-orchestrator-kit, that is expected:");
  console.error("the test suite is not part of the published package. Clone the repository");
  console.error("to run it:  git clone https://github.com/FullThrottle83/jules-orchestrator-kit");
  console.error("");
  console.error("To check an installed copy instead, run:  npm run guard-reach");
  process.exit(1);
}

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

// The runner leads its own process group, and nothing outlives it.
//
// `spawnSync` kills only the direct child when a run is interrupted, and this
// suite's children spawn children of their own — a verification command, an
// `npm` that fans out to a node per workspace, a git subprocess per fixture.
// Interrupting a run therefore orphaned everything below the first level, and
// those orphans kept running and kept spawning: a laptop accumulated enough of
// them across several interrupted runs to exhaust 32 GB of RAM and 24 GB of
// swap, and two CI runners logged pages of "Terminate orphan process" at the
// end of a job that had already failed.
//
// Detaching makes the child a process-group leader, so one signal to the
// negated pid reaches the whole tree.
const child = spawn(process.execPath, ["--test", ...timeoutArgs, ...concurrencyArgs, ...testFiles], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
  detached: process.platform !== "win32",
});

/**
 * Kill the runner and everything it spawned.
 *
 * POSIX takes a signal to `-pid`, which addresses the whole process group.
 * Windows has no such concept, so `taskkill /T` walks the tree instead.
 */
function reap(signal = "SIGKILL") {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (_) {
    // Already gone, or never had a group. Nothing left to reap either way.
  }
}

// Ctrl-C, a CI cancellation and a harness teardown all arrive as signals; each
// must take the tree with it rather than detaching it from its parent.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    reap("SIGTERM");
    // Give the group a moment to unwind, then make sure.
    setTimeout(() => {
      reap("SIGKILL");
      process.exit(130);
    }, 2000).unref();
  });
}

child.on("exit", (code, signal) => {
  // Stragglers outlive a clean exit too: a test that spawned a server and
  // failed before its teardown leaves it running.
  reap("SIGKILL");
  process.exit(signal ? 1 : code ?? 1);
});

child.on("error", (err) => {
  console.error(`Test runner failed to start: ${err.message}`);
  process.exit(1);
});
