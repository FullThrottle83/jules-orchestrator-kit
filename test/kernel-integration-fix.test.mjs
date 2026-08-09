import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { reapStaleMutexDirs, reapOrphanedIntents, journalIntent } from "../src/journal.mjs";
import { getStateDir, getLockDir, getProcessStartTime, checkDailyBudget, reserveBudgetAtomic, appendLedger } from "../src/state.mjs";
import { NET_GUARD_PRELOAD_URL, NET_GUARD_FLAG } from "../src/git.mjs";

test("Integration Safety & Lock/Reaper Edge Cases (Kernel Integration Fixes)", async (t) => {
  const tmpRoot = join(process.cwd(), `.test-kernel-fix-${Date.now()}`);

  t.after(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch (_) {}
  });

  await t.test("a) Orphaned .budget.mutex dir > 30s old is reaped at boot; active mutex dirs are preserved", () => {
    const stateDir = getStateDir(tmpRoot);
    const staleMutex = join(stateDir, ".stale.budget.mutex");
    const activeMutex = join(stateDir, ".active.budget.mutex");
    const nonemptyMutex = join(stateDir, ".nonempty.budget.mutex");

    mkdirSync(staleMutex, { recursive: true });
    mkdirSync(activeMutex, { recursive: true });
    mkdirSync(nonemptyMutex, { recursive: true });
    writeFileSync(join(nonemptyMutex, "lock.file"), "busy");

    // Backdate mtime/atime of staleMutex to 60 seconds ago (>30s ttl)
    const sixtySecsAgo = (Date.now() - 60000) / 1000;
    utimesSync(staleMutex, sixtySecsAgo, sixtySecsAgo);

    const res = reapStaleMutexDirs(tmpRoot, { ttlMs: 30000 });

    assert.ok(res.reaped.includes(".stale.budget.mutex"), "stale mutex should be reaped");
    assert.equal(existsSync(staleMutex), false, "stale mutex dir should be removed");

    assert.equal(existsSync(activeMutex), true, "active/fresh mutex dir should be preserved");
    assert.equal(existsSync(nonemptyMutex), true, "non-empty mutex dir should be preserved");
  });

  await t.test("b) Live PID with matching start time is NOT reaped by reapOrphanedIntents", () => {
    // eslint-disable-next-line no-unused-vars
    const stateDir = getStateDir(tmpRoot);
    const lockDir = getLockDir(tmpRoot);
    const pid = process.pid;
    const startTime = getProcessStartTime(pid);

    // eslint-disable-next-line no-unused-vars
    const opId = journalIntent(tmpRoot, { type: "test_op", path: "some/path" });

    const lockFile = join(lockDir, "test-task.json");
    writeFileSync(
      lockFile,
      JSON.stringify({
        agent: "test-agent",
        taskId: "test-task",
        pid,
        processStartTime: startTime,
        acquiredAt: new Date().toISOString(),
      }),
      "utf-8"
    );

    const res = reapOrphanedIntents(tmpRoot);

    assert.equal(res.reapedCount, 0, "live PID with matching start time must not be reaped");
    assert.equal(existsSync(lockFile), true, "lock file for live process must remain intact");
  });

  await t.test("c) Net-guard preload generates absolute file URL", () => {
    assert.ok(NET_GUARD_PRELOAD_URL.startsWith("file://"), "NET_GUARD_PRELOAD_URL should start with file://");
    assert.ok(NET_GUARD_PRELOAD_URL.endsWith("/preload-net-guard.mjs"), "NET_GUARD_PRELOAD_URL should point to preload-net-guard.mjs");
    assert.ok(NET_GUARD_FLAG.startsWith("--import file://"), "NET_GUARD_FLAG should use absolute file:// import URL");
  });

  await t.test("d) Budget counter only counts budget_reserved events", () => {
    // Perform 1 budget reservation
    const res = reserveBudgetAtomic(tmpRoot, 300);
    assert.equal(res.used, 1);

    // Append non-budget_reserved events (e.g. budget_committed, task_completed)
    appendLedger({ event: "budget_committed", reservationId: res.reservationId }, tmpRoot);
    appendLedger({ event: "task_completed", file: "task-1.md" }, tmpRoot);
    appendLedger({ event: "audit_finding", detail: "passed" }, tmpRoot);

    const check = checkDailyBudget(tmpRoot, 300);

    assert.equal(check.used, 1, "checkDailyBudget should count only budget_reserved events, not other ledger lines");
    assert.equal(check.remaining, 299);
  });
});
