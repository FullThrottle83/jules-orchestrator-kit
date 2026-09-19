/**
 * Process-tree cleanup for timed-out commands (ROADMAP_V1 reliability item).
 *
 * Real POSIX integration tests: spawn parent→child workers, kill the tree,
 * assert nothing lingers. Windows taskkill path is covered by code review /
 * platform branch (this environment is Linux).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { killProcessTree } from "../src/process-tree.mjs";
import { runCmd } from "../src/git.mjs";

/** @param {number} pid */
function isAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

/**
 * Poll until predicate is true or timeout. Throws on timeout.
 * @param {() => boolean} pred
 * @param {number} ms
 * @param {string} label
 */
async function waitUntil(pred, ms, label) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

describe("killProcessTree", () => {
  it("does not throw for a non-existent PID", () => {
    // PIDs this high are vanishingly unlikely to exist; either way must be quiet.
    assert.doesNotThrow(() => killProcessTree(2_147_483_647));
    assert.doesNotThrow(() => killProcessTree(0));
    assert.doesNotThrow(() => killProcessTree(-1));
    assert.doesNotThrow(() => killProcessTree("not-a-pid"));
    assert.doesNotThrow(() => killProcessTree(undefined));
  });

  it("kills parent and spawned child workers", async () => {
    if (process.platform === "win32") {
      // Real tree-kill on Windows needs taskkill; skip live spawn here.
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "kit-ptree-"));
    const pidFile = join(dir, "pids.json");
    const script = join(dir, "parent.mjs");

    writeFileSync(
      script,
      `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 200)"], {
  stdio: "ignore",
});
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({
  parent: process.pid,
  child: child.pid,
}));
setInterval(() => {}, 200);
`
    );

    let parentProc;
    const tracked = [];
    try {
      parentProc = spawn(process.execPath, [script], {
        stdio: "ignore",
        // Not detached: forces the pgrep / recursive-walk fallback path.
      });
      tracked.push(parentProc.pid);

      await waitUntil(() => existsSync(pidFile), 3000, "pid file written");
      const pids = JSON.parse(readFileSync(pidFile, "utf-8"));
      tracked.push(pids.parent, pids.child);

      assert.ok(isAlive(pids.parent), "parent should be alive before kill");
      assert.ok(isAlive(pids.child), "child should be alive before kill");

      killProcessTree(pids.parent);

      await waitUntil(() => !isAlive(pids.parent), 3000, "parent dead");
      await waitUntil(() => !isAlive(pids.child), 3000, "child dead");
      assert.equal(isAlive(pids.parent), false);
      assert.equal(isAlive(pids.child), false);
    } finally {
      for (const pid of tracked) {
        try {
          killProcessTree(pid);
        } catch {
          /* ignore */
        }
      }
      if (parentProc && !parentProc.killed) {
        try {
          parentProc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});

describe("runCmd timeout process-tree cleanup", () => {
  it("kills parent and background workers on short timeout", async () => {
    if (process.platform === "win32") return;

    const dir = mkdtempSync(join(tmpdir(), "kit-runCmd-ptree-"));
    const pidFile = join(dir, "workers.json");
    const script = join(dir, "workers.mjs");

    writeFileSync(
      script,
      `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const kids = [];
for (let i = 0; i < 2; i++) {
  const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 100)"], {
    stdio: "ignore",
  });
  kids.push(c.pid);
}
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({
  parent: process.pid,
  kids,
}));
setInterval(() => {}, 100);
`
    );

    const leftover = [];
    try {
      // Short timeout: script writes PIDs immediately then parks on intervals.
      const res = runCmd([process.execPath, script], {
        timeout: 250,
        ignoreError: true,
      });

      assert.equal(res.status, 124, "expected timeout status 124");
      assert.match(res.stderr, /ETIMEDOUT|timed out/i);

      assert.ok(existsSync(pidFile), "worker pid file should have been written before timeout");
      const { parent, kids } = JSON.parse(readFileSync(pidFile, "utf-8"));
      leftover.push(parent, ...kids);

      // Allow a brief settle window for signals to deliver.
      await delay(150);

      assert.equal(isAlive(parent), false, `parent ${parent} should be dead`);
      for (const kid of kids) {
        assert.equal(isAlive(kid), false, `worker ${kid} should be dead`);
      }
    } finally {
      for (const pid of leftover) {
        try {
          killProcessTree(pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
      // Last-resort sweep: any node still holding our script path.
      try {
        spawnSync("pkill", ["-f", script], { stdio: "ignore" });
      } catch {
        /* ignore */
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("preserves existing timeout error messaging when not ignoreError", () => {
    let threw = null;
    try {
      runCmd([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
        timeout: 100,
      });
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, "should throw GateError on timeout");
    assert.match(String(threw.message), /ETIMEDOUT|timed out/i);
  });
});
