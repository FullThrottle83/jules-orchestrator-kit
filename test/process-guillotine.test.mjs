/**
 * Process Group Guillotine & Subshell Teardown (Roadmap v0.44.0)
 *
 * Falsifiable oracles for src/process.mjs:
 *   1. POSIX process-group teardown via negative-PID signaling.
 *   2. Win32 process-tree teardown via `taskkill /T /F /PID <pid>`.
 *   3. Non-throwing cleanup on already-dead processes (ESRCH).
 *   4. Timeout enforcement: SIGTERM-immune subprocesses are reaped with
 *      SIGKILL after a grace period.
 *
 * Plus two wiring-integration oracles proving that src/git.mjs `runCmd`
 * timeouts and src/engine.mjs `probeDevServer` teardown reap *background
 * grandchildren* — the orphaned Jest/Vite watcher and EADDRINUSE failure
 * mode this module exists to prevent.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawnProcessGroup, killProcessTree } from "../src/process.mjs";
import { runCmd } from "../src/git.mjs";
import { probeDevServer } from "../src/engine.mjs";

const skipOnWindows = { skip: process.platform === "win32" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `file` exists (a grandchild announces itself by pid file). */
async function waitForFile(file, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(file)) return true;
    await sleep(20);
  }
  return false;
}

/** Polls until `process.kill(pid, 0)` reports ESRCH, i.e. the pid is reaped. */
async function waitForDeath(pid, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code === "ESRCH") return true;
      throw err;
    }
    await sleep(25);
  }
  return false;
}

async function waitForExit(child, timeoutMs = 8000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(timeoutMs),
  ]);
}

/** A grandchild whose pid is announced via a file, then lives forever. */
const SPIN_SCRIPT = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const gc = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
fs.writeFileSync(process.env.GC_PID_FILE, String(gc.pid));
setInterval(() => {}, 1000);
`;

/** Same, but parent AND grandchild both ignore SIGTERM. */
const IMMUNE_SCRIPT = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
process.on("SIGTERM", () => {});
const gc = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
  { stdio: "ignore" }
);
fs.writeFileSync(process.env.GC_PID_FILE, String(gc.pid));
setInterval(() => {}, 1000);
`;

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "jules-guillotine-"));
}

describe("src/process.mjs — Process Group Guillotine", () => {
  it("POSIX: killProcessTree terminates the entire process group via negative PID", { ...skipOnWindows }, async () => {
    const dir = makeTmpDir();
    const gcFile = join(dir, "gc.pid");
    try {
      const child = spawnProcessGroup(process.execPath, ["-e", SPIN_SCRIPT], {
        cwd: dir,
        stdio: "ignore",
        env: { ...process.env, GC_PID_FILE: gcFile },
      });

      assert.equal(await waitForFile(gcFile), true, "grandchild must announce itself");
      const gcPid = Number(readFileSync(gcFile, "utf-8").trim());
      assert.ok(Number.isInteger(gcPid) && gcPid > 0, "grandchild pid must be valid");

      // The spawned child must lead its own process group (detached semantics).
      assert.doesNotThrow(() => process.kill(-child.pid, 0), "child must be a process-group leader");

      const result = killProcessTree(child, { graceMs: 100 });
      assert.equal(result.ok, true, `teardown failed: ${JSON.stringify(result)}`);
      assert.equal(result.method, "posix-group");
      assert.equal(result.reaped, true);

      await waitForExit(child);
      assert.equal(await waitForDeath(gcPid), true, "background grandchild must be reaped");
      assert.equal(await waitForDeath(child.pid), true, "direct child must be reaped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POSIX: SIGTERM-immune subprocesses are reaped with SIGKILL after the grace period", { ...skipOnWindows }, async () => {
    const dir = makeTmpDir();
    const gcFile = join(dir, "gc.pid");
    try {
      const child = spawnProcessGroup(process.execPath, ["-e", IMMUNE_SCRIPT], {
        cwd: dir,
        stdio: "ignore",
        env: { ...process.env, GC_PID_FILE: gcFile },
      });

      assert.equal(await waitForFile(gcFile), true, "grandchild must announce itself");
      const gcPid = Number(readFileSync(gcFile, "utf-8").trim());

      // Prove the fixture really is SIGTERM-immune: a lone SIGTERM to the
      // group must not kill the parent, so the group stays signalable.
      process.kill(-child.pid, "SIGTERM");
      await sleep(100);
      assert.doesNotThrow(() => process.kill(-child.pid, 0), "fixture must survive bare SIGTERM");

      const graceMs = 400;
      const t0 = Date.now();
      const result = killProcessTree(child, { graceMs });
      const elapsed = Date.now() - t0;

      assert.equal(result.ok, true, `teardown failed: ${JSON.stringify(result)}`);
      assert.equal(result.escalated, true, "SIGKILL escalation must be attempted");
      assert.ok(
        elapsed >= graceMs - 25,
        `grace period must be honored before SIGKILL (elapsed ${elapsed}ms < ${graceMs}ms)`
      );

      await waitForExit(child);
      assert.equal(await waitForDeath(child.pid), true, "SIGTERM-immune child must be SIGKILLed");
      assert.equal(await waitForDeath(gcPid), true, "SIGTERM-immune grandchild must be SIGKILLed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POSIX: already-dead processes are handled gracefully (ESRCH, no throw)", { ...skipOnWindows }, async () => {
    const child = spawnProcessGroup(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    await waitForExit(child);

    const result = killProcessTree(child, { graceMs: 50 });
    assert.equal(result.ok, true);
    assert.equal(result.reaped, true);
    assert.equal(result.alreadyDead, true);

    // A pid that can never exist must not throw either.
    const bogus = killProcessTree(987654321, { graceMs: 0 });
    assert.equal(bogus.ok, true);
    assert.equal(bogus.alreadyDead, true);
  });

  it("win32: killProcessTree invokes `taskkill /T /F /PID <pid>`", () => {
    const calls = [];
    const fakeSpawnSync = (file, args, opts) => {
      calls.push({ file, args, opts });
      return { status: 0, error: null };
    };

    const result = killProcessTree(4242, { platform: "win32", _spawnSync: fakeSpawnSync });
    assert.equal(result.ok, true);
    assert.equal(result.method, "taskkill");
    assert.equal(calls.length, 1, "taskkill must be invoked exactly once");

    const { file, args, opts } = calls[0];
    assert.match(file, /taskkill(\.exe)?$/i);
    assert.deepEqual(args, ["/pid", "4242", "/T", "/F"]);
    assert.equal(opts.stdio, "ignore", "taskkill output must not leak into the caller stream");
  });

  it("win32: taskkill reporting a missing process is treated as already-dead", () => {
    // taskkill exits 128 with "ERROR: The process ... not found."
    const result = killProcessTree(999999, {
      platform: "win32",
      _spawnSync: () => ({ status: 128, error: null }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.alreadyDead, true);
  });

  it("POSIX: platform override selects the posix-group path and never invokes taskkill", { ...skipOnWindows }, () => {
    const child = spawnProcessGroup(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    try {
      let invoked = false;
      const result = killProcessTree(child, {
        platform: "linux",
        graceMs: 0,
        _spawnSync: () => {
          invoked = true;
          return { status: 0, error: null };
        },
      });
      assert.equal(result.ok, true);
      assert.equal(result.method, "posix-group");
      assert.equal(invoked, false, "taskkill must never run on a POSIX platform");
    } finally {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (_) {}
    }
  });

  it("spawnProcessGroup spawns a detached process-group leader and forwards options", { ...skipOnWindows }, async () => {
    const dir = makeTmpDir();
    const outFile = join(dir, "child.pid");
    try {
      const script = `require("node:fs").writeFileSync(${JSON.stringify(outFile)}, String(process.pid)); setInterval(()=>{},1000);`;
      const child = spawnProcessGroup(process.execPath, ["-e", script], {
        cwd: dir,
        stdio: "ignore",
        env: process.env,
      });

      assert.equal(await waitForFile(outFile), true, "cwd option must reach the child");
      assert.equal(Number(readFileSync(outFile, "utf-8").trim()), child.pid);
      assert.doesNotThrow(() => process.kill(-child.pid, 0), "child must be a process-group leader");

      const result = killProcessTree(child, { graceMs: 0 });
      assert.equal(result.ok, true);
      await waitForExit(child);
      assert.equal(await waitForDeath(child.pid), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("spawnProcessGroup forces detached group leadership even if the caller opts out", { ...skipOnWindows }, async () => {
    // Containment is the whole point of the module: a caller passing
    // `detached: false` must not silently disable group teardown.
    const child = spawnProcessGroup(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: false,
      stdio: "ignore",
    });
    try {
      assert.doesNotThrow(() => process.kill(-child.pid, 0), "group leadership must be forced");
    } finally {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (_) {}
      await waitForExit(child);
    }
  });

  it("invalid or missing pids fail closed without throwing", () => {
    for (const bad of [null, undefined, 0, -5, "abc", {}, { pid: 0 }]) {
      const result = killProcessTree(bad, { graceMs: 0 });
      assert.equal(result.ok, false, `expected fail-closed for ${JSON.stringify(bad)}`);
      assert.equal(result.reason, "invalid-pid");
    }
  });
});

describe("wiring — subshell & dev-server teardown must leave no orphans", () => {
  it("runCmd: a timed-out subshell command cannot leave background children behind", { ...skipOnWindows }, async () => {
    const dir = makeTmpDir();
    const gcFile = join(dir, "gc.pid");
    try {
      // `sleep 300 &` is exactly the orphaned-background-server failure mode.
      // The shell dies on Node's SIGTERM timeout kill; the sleep must be
      // reaped by the process-group guillotine, or it lives 300s.
      const cmd = `sleep 300 & echo $! > ${gcFile}; wait`;
      const t0 = Date.now();
      const res = runCmd(cmd, { cwd: dir, timeout: 700, ignoreError: true, graceMs: 150 });
      const elapsed = Date.now() - t0;

      assert.equal(res.status, 124, "timed-out command must report status 124");
      assert.ok(elapsed < 5000, `timeout path must return promptly (took ${elapsed}ms)`);
      assert.equal(await waitForFile(gcFile), true, "shell must have started the background child");
      const gcPid = Number(readFileSync(gcFile, "utf-8").trim());
      assert.equal(await waitForDeath(gcPid), true, "background child must be reaped on timeout");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("probeDevServer: teardown reaps the whole process group and frees the port (no EADDRINUSE)", { ...skipOnWindows }, async () => {
    const dir = makeTmpDir();
    const gcFile = join(dir, "gc.pid");
    const port = await new Promise((resolve, reject) => {
      const s = createServer();
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });

    try {
      // A dev server that also leaves a watcher-style background child behind.
      // BOTH ignore SIGTERM: the legacy teardown sent one bare SIGTERM to the
      // group, so this fixture survives it deterministically — the test only
      // goes green when the guillotine escalates to SIGKILL.
      const script = [
        "const http = require('node:http');",
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {});",
        "const gc = spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"], { stdio: 'ignore' });",
        `fs.writeFileSync(${JSON.stringify(gcFile)}, String(gc.pid));`,
        "http.createServer((req, res) => res.end('ok')).listen(" + port + ");",
      ].join(" ");

      const probe = await probeDevServer(
        {
          command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
          url: `http://127.0.0.1:${port}`,
          timeoutMs: 6000,
        },
        dir
      );

      assert.equal(probe.ok, true, `probe failed: ${JSON.stringify(probe)}`);
      assert.equal(await waitForFile(gcFile), true, "dev server must have spawned its background child");
      const gcPid = Number(readFileSync(gcFile, "utf-8").trim());
      assert.equal(await waitForDeath(gcPid), true, "background child must be torn down with the server");

      // The definitive EADDRINUSE oracle: the port must be immediately
      // rebindable once the probe returns.
      const rebindError = await new Promise((resolve) => {
        const s = createServer();
        s.once("error", (err) => resolve(err.code || err.message));
        s.listen(port, "127.0.0.1", () => s.close(() => resolve(null)));
      });
      assert.equal(rebindError, null, `port ${port} must be free after teardown (got ${rebindError})`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
