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
  pruneCheckpoints,
} from "../src/ops/checkpoint.mjs";

test("Atomic Git Checkpoint & Rollback Manager", async (t) => {
  let tmpDir;

  t.beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
    execSync("git init -b main", { cwd: tmpDir, stdio: "ignore" });
    execSync("git config user.name 'Test'", { cwd: tmpDir, stdio: "ignore" });
    execSync("git config user.email 'test@test.com'", { cwd: tmpDir, stdio: "ignore" });
    writeFileSync(join(tmpDir, "file1.txt"), "Initial content");
    execSync("git add .", { cwd: tmpDir, stdio: "ignore" });
    execSync("git commit -m 'Initial commit'", { cwd: tmpDir, stdio: "ignore" });
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

  await t.test("b) restoreCheckpoint resets uncommitted file modifications and untracked files", () => {
    const snapshot = createCheckpoint("sess-2", { root: tmpDir });

    // Modify file and add un-tracked file
    writeFileSync(join(tmpDir, "file1.txt"), "Dirty modified content!");
    writeFileSync(join(tmpDir, "untracked.txt"), "Untracked asset");

    assert.equal(readFileSync(join(tmpDir, "file1.txt"), "utf-8"), "Dirty modified content!");
    assert.equal(existsSync(join(tmpDir, "untracked.txt")), true);

    // Rollback to latest checkpoint
    const res = restoreCheckpoint("--latest", { root: tmpDir });
    assert.equal(res.ok, true);

    // Verify state restored
    assert.equal(readFileSync(join(tmpDir, "file1.txt"), "utf-8"), "Initial content");
    assert.equal(existsSync(join(tmpDir, "untracked.txt")), false);
  });

  await t.test("c) pruneCheckpoints keeps only the N most recent checkpoints", () => {
    for (let i = 1; i <= 15; i++) {
      createCheckpoint(`sess-${i}`, { root: tmpDir });
    }

    const listBefore = listCheckpoints(tmpDir);
    assert.equal(listBefore.length, 10, "Expected checkpoint count to be capped at 10");
  });
});
