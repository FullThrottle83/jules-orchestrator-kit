import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmdirSync, rmSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  withVfsMutex,
  MutexTimeoutError,
  isPidAlive,
  getProcessStartTime,
  acquireLock,
  getLockDir,
  reserveBudgetAtomic,
  BudgetError,
  verifyLedgerIntegrity,
  appendLedger,
} from "../index.mjs";
import { getDailyLedgerPath } from "../src/state.mjs";

describe("Kernel Hardening & Concurrency Safety", () => {
  test("a) withVfsMutex throws MutexTimeoutError on timeout and DOES NOT execute callback", () => {
    const testDir = join(process.cwd(), ".agent/test-mutex-timeout-" + Date.now());
    mkdirSync(testDir, { recursive: true });
    const mutexDir = join(testDir, ".test.mutex");
    mkdirSync(mutexDir); // Simulate mutex lock already held by another process

    let callbackExecuted = false;

    try {
      assert.throws(
        () => {
          withVfsMutex(
            mutexDir,
            () => {
              callbackExecuted = true;
            },
            { maxRetries: 5, retryDelayMs: 2 }
          );
        },
        (err) => err instanceof MutexTimeoutError && err.name === "MutexTimeoutError"
      );

      assert.strictEqual(callbackExecuted, false, "Callback must NOT execute when mutex acquisition times out");
    } finally {
      try { rmdirSync(mutexDir); } catch (_) {}
      try { rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  test("b) Stale lock with recycled/mismatched PID starttime is successfully reaped", () => {
    const testDir = join(process.cwd(), ".agent/test-stale-lock-" + Date.now());
    mkdirSync(testDir, { recursive: true });
    const lockDir = getLockDir(testDir);
    const taskId = "task-stale-pid-test";
    const lockFile = join(lockDir, `${taskId}.json`);

    try {
      // Create a lock payload with alive process.pid but a mismatched starttime
      const mismatchedPayload = {
        agent: "stale-worker",
        taskId,
        files: ["src/state.mjs"],
        pid: process.pid,
        processStartTime: "999999999",
        starttime: "999999999",
        nonce: "stale-nonce-12345",
        hostname: "localhost",
        acquiredAt: new Date().toISOString(),
      };
      writeFileSync(lockFile, JSON.stringify(mismatchedPayload, null, 2), "utf-8");

      // Verify isPidAlive returns false for process.pid when expectedStartTime is mismatched on Linux/macOS
      if (process.platform === "linux" || process.platform === "darwin") {
        const alive = isPidAlive(process.pid, "999999999");
        assert.strictEqual(alive, false, "isPidAlive must return false for mismatched PID starttime");
      }

      // acquireLock must detect stale PID starttime, reap the lock file, and acquire lock successfully
      if (process.platform === "linux" || process.platform === "darwin") {
        const res = acquireLock("new-worker", taskId, ["src/state.mjs"], testDir);
        assert.strictEqual(res.ok, true, "acquireLock should succeed after reaping stale lock");
        assert.strictEqual(res.lockFile, lockFile);

        // Verify new lock contents
        const newLock = JSON.parse(readFileSync(lockFile, "utf-8"));
        assert.strictEqual(newLock.agent, "new-worker");
        assert.strictEqual(newLock.pid, process.pid);
        assert.ok(newLock.nonce, "Lock payload must contain a random UUID nonce");

        if (process.platform === "linux") {
          const actualStart = getProcessStartTime(process.pid);
          assert.strictEqual(String(newLock.processStartTime), String(actualStart));
        }
      }
    } finally {
      try { rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  test("c) 20 concurrent reservation calls against budget limit 3 results in exactly 3 successes and 17 rejections", async () => {
    const testDir = join(process.cwd(), ".agent/test-concurrent-budget-" + Date.now());
    mkdirSync(testDir, { recursive: true });
    const limit = 3;

    try {
      const tasks = Array.from({ length: 20 }, () => {
        return new Promise((resolve) => {
          setImmediate(() => {
            try {
              const res = reserveBudgetAtomic(testDir, limit);
              resolve({ ok: true, value: res });
            } catch (err) {
              resolve({ ok: false, error: err });
            }
          });
        });
      });

      const results = await Promise.all(tasks);
      const successes = results.filter((r) => r.ok);
      const failures = results.filter((r) => !r.ok);

      assert.strictEqual(successes.length, 3, "Exactly 3 reservations must succeed");
      assert.strictEqual(failures.length, 17, "Exactly 17 reservations must be rejected");

      for (const failure of failures) {
        assert.ok(failure.error instanceof BudgetError, "Failure error must be an instance of BudgetError");
        assert.strictEqual(failure.error.code, 7, "BudgetError code must be 7");
      }

      // Verify ledger file integrity and entry count
      const dateStr = new Date().toISOString().split("T")[0];
      const ledgerPath = join(testDir, ".agent/state", `ledger-${dateStr}.jsonl`);
      assert.strictEqual(existsSync(ledgerPath), true, "Ledger file must exist");

      const lines = readFileSync(ledgerPath, "utf-8").split("\n").filter(Boolean);
      assert.strictEqual(lines.length, 3, "Ledger must contain exactly 3 reservation entries");

      const integrity = verifyLedgerIntegrity(ledgerPath);
      assert.strictEqual(integrity.ok, true, "Ledger hash-chain integrity must pass verification");
      assert.strictEqual(integrity.count, 3);
    } finally {
      try { rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  test("d) verifyLedgerIntegrity fails closed on unhashed, truncated, and tampered lines", () => {
    const testDir = join(process.cwd(), ".agent/test-ledger-fail-closed-" + Date.now());
    const ledgerPath = join(testDir, "ledger.jsonl");
    mkdirSync(testDir, { recursive: true });

    try {
      // An unhashed line is exactly what the deleted scripts/utils.mjs shim
      // used to bless with { ok: true, lastHash: "sha256-verified" }. It must
      // now fail closed: no hash fields, no verdict of "intact".
      writeFileSync(ledgerPath, JSON.stringify({ timestamp: new Date().toISOString(), event: "budget_reserved" }) + "\n");
      let res = verifyLedgerIntegrity(ledgerPath);
      assert.strictEqual(res.ok, false, "Unhashed ledger entries must NOT pass verification");
      assert.strictEqual(res.error, "MISSING_HASH_FIELDS");
      assert.strictEqual(res.line, 1);

      // A genuine hash chain, built through the kit's own appendLedger.
      rmSync(ledgerPath);
      const first = appendLedger({ event: "budget_reserved", key: "alpha" }, testDir);
      const second = appendLedger({ event: "session_dispatched", key: "alpha" }, testDir);
      const chainedPath = getDailyLedgerPath(testDir);
      res = verifyLedgerIntegrity(chainedPath);
      assert.strictEqual(res.ok, true, "clean chain must verify");
      assert.strictEqual(res.count, 2);
      assert.strictEqual(second.prevHash, first.hash, "second entry links to the first hash");
      assert.strictEqual(res.lastHash, second.hash);

      const lines = readFileSync(chainedPath, "utf-8").split("\n").filter(Boolean);

      // A truncated (torn) final line after an otherwise valid chain must
      // fail closed as corruption, not be skipped as an incomplete append.
      appendFileSync(chainedPath, '{"timestamp":"2020-01-01T00:00:00.000Z","event":"bud');
      res = verifyLedgerIntegrity(chainedPath);
      assert.strictEqual(res.ok, false, "Truncated ledger line must not pass verification");
      assert.strictEqual(res.error, "TORN_WRITE_CORRUPTION");
      assert.strictEqual(res.line, 3);
      writeFileSync(chainedPath, lines.join("\n") + "\n");
      assert.strictEqual(verifyLedgerIntegrity(chainedPath).ok, true, "restored chain verifies again");

      // Tampering: flip a payload field on the head line, keep it valid JSON.
      const head = JSON.parse(lines[0]);
      head.event = "budget_rolled_back";
      writeFileSync(chainedPath, JSON.stringify(head) + "\n" + lines.slice(1).join("\n") + "\n");
      res = verifyLedgerIntegrity(chainedPath);
      assert.strictEqual(res.ok, false, "Edited payload must break the recomputed SHA-256");
      assert.strictEqual(res.error, "CORRUPTED_ENTRY_HASH");

      // Truncation of a valid chain (drop the head, orphan the tail) must fail closed.
      writeFileSync(chainedPath, lines.slice(1).join("\n") + "\n");
      res = verifyLedgerIntegrity(chainedPath);
      assert.strictEqual(res.ok, false, "Removed ledger line must break prevHash linkage");
      assert.strictEqual(res.error, "BROKEN_PREV_HASH");

      // Regression guard: the bypass must never come back. scripts/utils.mjs
      // may not re-implement verification — it may only forward to the secure
      // implementation in src/state.mjs (or be gone entirely).
      const utilsPath = fileURLToPath(new URL("../scripts/utils.mjs", import.meta.url));
      if (existsSync(utilsPath)) {
        const utilsSrc = readFileSync(utilsPath, "utf-8");
        assert.ok(
          !/function\s+verifyLedgerIntegrity\b/.test(utilsSrc),
          "scripts/utils.mjs must not define its own verifyLedgerIntegrity"
        );
        assert.ok(
          /export\s*\{[^}]*verifyLedgerIntegrity[^}]*\}\s*from\s*"\.\.\/src\/state\.mjs"/.test(utilsSrc),
          "scripts/utils.mjs must re-export verifyLedgerIntegrity from src/state.mjs"
        );
      }
    } finally {
      try { rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
    }
  });
});
