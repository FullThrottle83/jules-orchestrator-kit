import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  createCheckpoint,
  restoreCheckpoint,
  listCheckpoints,
} from "../src/ops/checkpoint.mjs";

test("Atomic Git Checkpoint & Rollback Manager", async (t) => {
  let tmpDir;

  t.beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
    execSync("git init -b main", { cwd: tmpDir, stdio: "ignore" });
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: "ignore" });
    execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: "ignore" });
    // The checkpoint store lives inside the tree it snapshots, so without the
    // ignore rule `init` normally writes, checkpoint N captures checkpoints
    // 1..N-1 and each one is roughly three times the last. Measured here: 12 KB
    // at the fifth, 157 MB at the fifteenth, and 18 GB left in /tmp across
    // accumulated runs. A real repository has this line; the fixture did not.
    writeFileSync(join(tmpDir, ".gitignore"), ".agent/state/\n");
    writeFileSync(join(tmpDir, "file1.txt"), "Initial content");
    execSync("git add .", { cwd: tmpDir, stdio: "ignore" });
    execSync('git commit -m "Initial commit"', { cwd: tmpDir, stdio: "ignore" });
  });

  t.afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("a) createCheckpoint snapshots HEAD SHA and working tree metadata", () => {
    const snapshot = createCheckpoint("sess-1", { root: tmpDir });
    assert.equal(snapshot.id, "sess-1");
    assert.ok(snapshot.headSha);
    assert.ok(Array.isArray(snapshot.uncommittedFiles));

    const list = listCheckpoints(tmpDir);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "sess-1");
  });

  await t.test("b) restoreCheckpoint fails closed without authorization and preserves untracked files", () => {
    createCheckpoint("sess-2", { root: tmpDir });

    // Modify file and add un-tracked file
    writeFileSync(join(tmpDir, "file1.txt"), "Dirty modified content!");
    writeFileSync(join(tmpDir, "untracked.txt"), "Untracked asset");

    assert.equal(readFileSync(join(tmpDir, "file1.txt"), "utf-8"), "Dirty modified content!");
    assert.equal(existsSync(join(tmpDir, "untracked.txt")), true);

    // Default rollback to latest checkpoint is a non-destructive inspection that refuses mutation
    const preflight = restoreCheckpoint("--latest", { root: tmpDir });
    assert.equal(preflight.ok, false);
    assert.equal(preflight.status, "refused");

    // Verify uncommitted modifications and untracked files are preserved
    assert.equal(readFileSync(join(tmpDir, "file1.txt"), "utf-8"), "Dirty modified content!");
    assert.equal(existsSync(join(tmpDir, "untracked.txt")), true);

    // Explicit restore request refuses when untracked files are present to prevent data loss
    const forcedRefused = restoreCheckpoint("--latest", { root: tmpDir, force: true });
    assert.equal(forcedRefused.ok, false);
    assert.equal(forcedRefused.status, "refused");
    assert.equal(existsSync(join(tmpDir, "untracked.txt")), true);

    // When untracked files are removed, authorized restore safely resets tracked files
    rmSync(join(tmpDir, "untracked.txt"), { force: true });
    const res = restoreCheckpoint("--latest", { root: tmpDir, force: true });
    assert.equal(res.ok, true);
    assert.equal(res.status, "restored");

    // Verify state restored
    assert.equal(readFileSync(join(tmpDir, "file1.txt"), "utf-8"), "Initial content");
  });

  await t.test("c) pruneCheckpoints keeps only the N most recent checkpoints", () => {
    for (let i = 1; i <= 15; i++) {
      createCheckpoint(`sess-${i}`, { root: tmpDir });
    }

    const listBefore = listCheckpoints(tmpDir);
    assert.equal(listBefore.length, 10, "Expected checkpoint count to be capped at 10");
  });
});
