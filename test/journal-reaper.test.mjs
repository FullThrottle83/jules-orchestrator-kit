import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { journalIntent, journalDone, reapOrphanedIntents } from "../src/journal.mjs";
import { getStateDir, getLockDir } from "../src/state.mjs";

describe("Intent Journaling & Boot-Time Zombie Worktree Reaper", () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `jules-journal-test-${randomUUID()}`);
    mkdirSync(tmpRoot, { recursive: true });
    getStateDir(tmpRoot);
  });

  afterEach(() => {
    if (existsSync(tmpRoot)) {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  test("a) Writing an intent without done for a dead PID results in cleanup", () => {
    const lockDir = getLockDir(tmpRoot);
    const lockFile = join(lockDir, "task-dead-pid.json");
    const deadPid = 999999;

    const dummyLock = {
      agent: "test-agent",
      taskId: "task-dead-pid",
      files: ["/tmp/dummy-wt"],
      pid: deadPid,
      processStartTime: "100200",
      acquiredAt: new Date().toISOString(),
    };
    writeFileSync(lockFile, JSON.stringify(dummyLock), "utf-8");

    const journalPath = join(getStateDir(tmpRoot), "journal.jsonl");
    const deadIntent = {
      opId: "op-dead-123",
      event: "intent",
      type: "worktree_add",
      targetPath: join(tmpRoot, "orphaned-worktree"),
      pid: deadPid,
      processStartTime: "100200",
      timestamp: new Date().toISOString(),
    };
    writeFileSync(journalPath, JSON.stringify(deadIntent) + "\n", "utf-8");

    assert.ok(existsSync(lockFile), "Lock file should exist before reaping");

    const res = reapOrphanedIntents(tmpRoot);

    assert.strictEqual(res.reapedCount, 1, "Must reap exactly 1 orphaned intent");
    assert.strictEqual(res.reaped[0].opId, "op-dead-123");
    assert.strictEqual(existsSync(lockFile), false, "Stale lock file for dead PID must be cleaned up");

    const rawJournal = readFileSync(journalPath, "utf-8");
    assert.ok(rawJournal.includes("journal_reaped"), "Journal must contain journal_reaped record");
  });

  test("b) Live PID intents are left untouched", () => {
    const liveOpId = journalIntent(tmpRoot, {
      type: "worktree_add",
      targetPath: join(tmpRoot, "live-worktree"),
    });

    const journalPath = join(getStateDir(tmpRoot), "journal.jsonl");
    assert.ok(existsSync(journalPath), "Journal file must exist after journalIntent");

    const res = reapOrphanedIntents(tmpRoot);

    assert.strictEqual(res.reapedCount, 0, "Live PID intent must NOT be reaped");
    assert.strictEqual(res.reaped.length, 0);

    const rawJournal = readFileSync(journalPath, "utf-8");
    assert.strictEqual(rawJournal.includes("journal_reaped"), false, "No journal_reaped record should be written for live PID");

    journalDone(tmpRoot, liveOpId);
  });

  test("c) Completed intents (journal_done) for dead PIDs are left untouched", () => {
    const journalPath = join(getStateDir(tmpRoot), "journal.jsonl");
    const completedIntent = {
      opId: "op-completed-456",
      event: "intent",
      type: "worktree_add",
      targetPath: join(tmpRoot, "clean-worktree"),
      pid: 999999,
      processStartTime: "100200",
      timestamp: new Date().toISOString(),
    };
    const doneRecord = {
      opId: "op-completed-456",
      event: "journal_done",
      timestamp: new Date().toISOString(),
    };
    writeFileSync(journalPath, JSON.stringify(completedIntent) + "\n" + JSON.stringify(doneRecord) + "\n", "utf-8");

    const res = reapOrphanedIntents(tmpRoot);
    assert.strictEqual(res.reapedCount, 0, "Cleanly completed intent must NOT be reaped even if PID is dead");
  });

  test("d) Reaping is completely idempotent", () => {
    const journalPath = join(getStateDir(tmpRoot), "journal.jsonl");
    const deadIntent = {
      opId: "op-idempotent-789",
      event: "intent",
      type: "worktree_add",
      targetPath: join(tmpRoot, "idempotent-wt"),
      pid: 999999,
      processStartTime: "100200",
      timestamp: new Date().toISOString(),
    };
    writeFileSync(journalPath, JSON.stringify(deadIntent) + "\n", "utf-8");

    const firstRun = reapOrphanedIntents(tmpRoot);
    assert.strictEqual(firstRun.reapedCount, 1, "First run must reap 1 intent");

    const secondRun = reapOrphanedIntents(tmpRoot);
    assert.strictEqual(secondRun.reapedCount, 0, "Second run must result in 0 additional reaps");
    assert.strictEqual(secondRun.reaped.length, 0);

    const thirdRun = reapOrphanedIntents(tmpRoot);
    assert.strictEqual(thirdRun.reapedCount, 0, "Third run must also result in 0 additional reaps");
  });
});
