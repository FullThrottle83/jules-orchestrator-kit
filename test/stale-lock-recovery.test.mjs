import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  acquireLock,
  releaseLock,
  reapStaleLocks,
  lockStatus,
  isConcurrencyGroupLocked,
  getLockDir,
} from "../src/state.mjs";
import { runDoctorChecks } from "../src/ops/doctor-registry.mjs";

const CLI_PATH = fileURLToPath(new URL("../bin/agentctl.mjs", import.meta.url));

function gitInit(dir) {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

function tempRepo(prefix = "jok-lock-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  gitInit(dir);
  mkdirSync(join(dir, ".agent", "state", "locks"), { recursive: true });
  writeFileSync(
    join(dir, ".agent", "config.yml"),
    "version: 1\nverify:\n  test: echo ok\n",
    "utf-8"
  );
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: dir });
  return dir;
}

test("reapStaleLocks cleans up dead-pid, expired-lease, and corrupted lock files while preserving live locks", () => {
  const dir = tempRepo();
  try {
    const lockDir = getLockDir(dir);

    // 1. Dead PID lock (non-leased)
    const deadLockPath = join(lockDir, "task-dead.json");
    writeFileSync(
      deadLockPath,
      JSON.stringify({
        agent: "dead-worker",
        taskId: "task-dead",
        pid: 9999999,
        processStartTime: "12345",
        leased: false,
        files: ["src/dead.js"],
        acquiredAt: new Date(Date.now() - 60_000).toISOString(),
      }),
      "utf-8"
    );

    // 2. Expired leased lock
    const expiredLockPath = join(lockDir, "task-expired.json");
    writeFileSync(
      expiredLockPath,
      JSON.stringify({
        agent: "lease-worker",
        taskId: "task-expired",
        leased: true,
        expiresAt: new Date(Date.now() - 10_000).toISOString(),
        files: ["src/expired.js"],
        acquiredAt: new Date(Date.now() - 70_000).toISOString(),
      }),
      "utf-8"
    );

    // 3. Corrupted 0-byte lock file
    const zeroByteLockPath = join(lockDir, "task-corrupted-zero.json");
    writeFileSync(zeroByteLockPath, "", "utf-8");

    // 4. Corrupted malformed JSON lock file
    const malformedLockPath = join(lockDir, "task-corrupted-bad.json");
    writeFileSync(malformedLockPath, "{bad-json::", "utf-8");

    // 5. Active live in-process lock (bound to this process)
    const liveAcquire = acquireLock("live-agent", "task-live", ["src/live.js"], dir, {
      lease: false,
      ownerPid: process.pid,
    });
    assert.equal(liveAcquire.ok, true, "live lock acquire must succeed");

    // 6. Active unexpired leased lock
    const activeLeaseAcquire = acquireLock("active-lease", "task-lease", ["src/lease.js"], dir, {
      lease: true,
      ttlMs: 3600_000,
    });
    assert.equal(activeLeaseAcquire.ok, true, "active lease acquire must succeed");

    // Dry-run should report 4 stale locks without removing them
    const dryRunRes = reapStaleLocks(dir, { dryRun: true });
    assert.equal(dryRunRes.reapedCount, 4);
    assert.equal(existsSync(deadLockPath), true);
    assert.equal(existsSync(expiredLockPath), true);
    assert.equal(existsSync(zeroByteLockPath), true);
    assert.equal(existsSync(malformedLockPath), true);

    // Real reap should unlink all 4 stale locks
    const reapRes = reapStaleLocks(dir, { dryRun: false });
    assert.equal(reapRes.reapedCount, 4);
    assert.equal(existsSync(deadLockPath), false);
    assert.equal(existsSync(expiredLockPath), false);
    assert.equal(existsSync(zeroByteLockPath), false);
    assert.equal(existsSync(malformedLockPath), false);

    // Live locks must remain untouched
    assert.equal(existsSync(join(lockDir, "task-live.json")), true);
    assert.equal(existsSync(join(lockDir, "task-lease.json")), true);

    // Subsequent reap is idempotent
    const secondReap = reapStaleLocks(dir);
    assert.equal(secondReap.reapedCount, 0);

    releaseLock("task-live", dir);
    releaseLock("task-lease", dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireLock self-heals stale locks on conflicting paths and corrupted existing files", () => {
  const dir = tempRepo();
  try {
    const lockDir = getLockDir(dir);

    // Place a stale lock on src/conflict.js
    const staleLockPath = join(lockDir, "task-stale-conflict.json");
    writeFileSync(
      staleLockPath,
      JSON.stringify({
        agent: "old-agent",
        taskId: "task-stale-conflict",
        pid: 9999999,
        processStartTime: "111",
        leased: false,
        files: ["src/conflict.js"],
        acquiredAt: new Date(Date.now() - 3600_000).toISOString(),
      }),
      "utf-8"
    );

    // Acquire on src/conflict.js should recognize stale lock, unlink it, and succeed
    const res = acquireLock("new-agent", "task-new", ["src/conflict.js"], dir);
    assert.equal(res.ok, true, "should acquire lock after self-healing stale conflicting lock");
    assert.equal(existsSync(staleLockPath), false, "stale conflicting lock file should have been unlinked");

    // Existing corrupted file for task-corrupt should be cleaned up on acquire attempt
    const corruptFile = join(lockDir, "task-corrupt.json");
    writeFileSync(corruptFile, "corrupted-json-content", "utf-8");
    const corruptAcquire = acquireLock("corrupt-agent", "task-corrupt", ["src/test.js"], dir);
    // After unlinking corrupted file, next acquire succeeds
    if (!corruptAcquire.ok) {
      const retry = acquireLock("corrupt-agent", "task-corrupt", ["src/test.js"], dir);
      assert.equal(retry.ok, true, "subsequent acquire must succeed after corrupted lock recovery");
    }

    releaseLock("task-new", dir);
    releaseLock("task-corrupt", dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isConcurrencyGroupLocked ignores stale locks and only blocks on live locks", () => {
  const dir = tempRepo();
  try {
    const lockDir = getLockDir(dir);

    // Stale lock in group "deploy"
    writeFileSync(
      join(lockDir, "task-deploy-stale.json"),
      JSON.stringify({
        agent: "dead-deployer",
        taskId: "task-deploy-stale",
        concurrencyGroup: "deploy",
        pid: 9999999,
        leased: false,
        files: [],
        acquiredAt: new Date().toISOString(),
      }),
      "utf-8"
    );

    assert.equal(isConcurrencyGroupLocked("deploy", dir), false, "stale lock must not lock group");

    // Active live lock in group "deploy"
    acquireLock("live-deployer", "task-deploy-live", [], dir, {
      concurrencyGroup: "deploy",
      lease: true,
      ttlMs: 60_000,
    });

    assert.equal(isConcurrencyGroupLocked("deploy", dir), true, "live lock must lock group");
    assert.equal(isConcurrencyGroupLocked("deploy", dir, "task-deploy-live"), false, "excluding active task must return false");

    releaseLock("task-deploy-live", dir);
    assert.equal(isConcurrencyGroupLocked("deploy", dir), false, "releasing live lock frees group");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lockStatus decorates records with live status and respects activeOnly option", () => {
  const dir = tempRepo();
  try {
    const lockDir = getLockDir(dir);

    // 1 live lock
    acquireLock("live-agent", "live-task", ["a.js"], dir, {
      lease: true,
      ttlMs: 60_000,
    });

    // 1 dead lock
    writeFileSync(
      join(lockDir, "dead-task.json"),
      JSON.stringify({
        agent: "dead-agent",
        taskId: "dead-task",
        pid: 9999999,
        leased: false,
        files: ["b.js"],
        acquiredAt: new Date().toISOString(),
      }),
      "utf-8"
    );

    const all = lockStatus(dir);
    assert.equal(all.length, 2);
    const liveRec = all.find((l) => l.taskId === "live-task");
    const deadRec = all.find((l) => l.taskId === "dead-task");
    assert.equal(liveRec.live, true);
    assert.equal(deadRec.live, false);

    const activeOnly = lockStatus(dir, { activeOnly: true });
    assert.equal(activeOnly.length, 1);
    assert.equal(activeOnly[0].taskId, "live-task");

    releaseLock("live-task", dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI agentctl lock reap and status report active vs stale locks", () => {
  const dir = tempRepo();
  try {
    const lockDir = getLockDir(dir);

    writeFileSync(
      join(lockDir, "task-stale-cli.json"),
      JSON.stringify({
        agent: "cli-dead",
        taskId: "task-stale-cli",
        pid: 9999999,
        leased: false,
        files: ["src/foo.js"],
        acquiredAt: new Date().toISOString(),
      }),
      "utf-8"
    );

    // agentctl lock status --json
    const statusOut = execFileSync(process.execPath, [CLI_PATH, "lock", "status", "--json"], {
      cwd: dir,
      encoding: "utf-8",
    });
    const statusParsed = JSON.parse(statusOut);
    assert.equal(statusParsed.ok, true);
    assert.equal(statusParsed.activeCount, 0);
    assert.equal(statusParsed.staleCount, 1);

    // agentctl lock reap --dry-run --json
    const dryRunOut = execFileSync(process.execPath, [CLI_PATH, "lock", "reap", "--dry-run", "--json"], {
      cwd: dir,
      encoding: "utf-8",
    });
    const dryRunParsed = JSON.parse(dryRunOut);
    assert.equal(dryRunParsed.reapedCount, 1);
    assert.equal(existsSync(join(lockDir, "task-stale-cli.json")), true);

    // agentctl lock reap --json
    const reapOut = execFileSync(process.execPath, [CLI_PATH, "lock", "reap", "--json"], {
      cwd: dir,
      encoding: "utf-8",
    });
    const reapParsed = JSON.parse(reapOut);
    assert.equal(reapParsed.reapedCount, 1);
    assert.equal(existsSync(join(lockDir, "task-stale-cli.json")), false);

    // Running reap again reports 0
    const reapEmptyOut = execFileSync(process.execPath, [CLI_PATH, "lock", "reap"], {
      cwd: dir,
      encoding: "utf-8",
    });
    assert.match(reapEmptyOut, /No stale locks found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor reports stale locks as warning and active locks as pass", async () => {
  const dir = tempRepo();
  try {
    const lockDir = getLockDir(dir);

    // Write a stale lock
    writeFileSync(
      join(lockDir, "task-doc-stale.json"),
      JSON.stringify({
        agent: "doc-dead",
        taskId: "task-doc-stale",
        pid: 9999999,
        leased: false,
        files: [],
        acquiredAt: new Date().toISOString(),
      }),
      "utf-8"
    );

    const report1 = await runDoctorChecks({ root: dir });
    const lockCheck1 = report1.results.find((r) => r.id === "locks.active");
    assert.ok(lockCheck1);
    assert.equal(lockCheck1.status, "warn");
    assert.match(lockCheck1.summary, /stale VFS lock/);

    // Clean up stale lock
    reapStaleLocks(dir);

    const report2 = await runDoctorChecks({ root: dir });
    const lockCheck2 = report2.results.find((r) => r.id === "locks.active");
    assert.ok(lockCheck2);
    assert.equal(lockCheck2.status, "pass");
    assert.match(lockCheck2.summary, /No active VFS locks present/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
