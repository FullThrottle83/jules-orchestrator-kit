import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import {
  createCheckpoint,
  restoreCheckpoint,
  CheckpointError,
  getCheckpointDir,
} from "../src/ops/checkpoint.mjs";
import { git } from "../src/git.mjs";

function setupRepo(prefix = "ckpt-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "Test Runner"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@runner.local"', { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, ".gitignore"), ".agent/state/\n.agent/handovers/\n");
  writeFileSync(join(dir, "file1.txt"), "Initial content\n");
  execSync("git add .", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m "Initial commit"', { cwd: dir, stdio: "ignore" });
  return dir;
}

test("Checkpoint Fail-Closed & Lossless Preflight Guard (Issue #70)", async (t) => {
  let tmpDir;

  t.beforeEach(() => {
    tmpDir = setupRepo();
  });

  t.afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test(
    "1. Pre-existing tracked edits, staged changes, untracked text/binary files and symlinks survive an unauthorized/default rollback attempt byte-for-byte, including index state",
    () => {
      // Create pre-existing state:
      // a) tracked unstaged edit
      writeFileSync(join(tmpDir, "file1.txt"), "Dirty unstaged edit\n");

      // b) staged change
      writeFileSync(join(tmpDir, "staged.txt"), "Staged change\n");
      execSync("git add staged.txt", { cwd: tmpDir, stdio: "ignore" });

      // c) untracked text file
      writeFileSync(join(tmpDir, "untracked.txt"), "Untracked pre-existing text\n");

      // d) untracked binary file with raw non-UTF8 bytes
      const binaryPayload = Buffer.from([0x00, 0xff, 0xfe, 0x12, 0xef, 0xbe, 0xad, 0xde]);
      writeFileSync(join(tmpDir, "binary.bin"), binaryPayload);

      // e) symlink (if platform supports it)
      let symlinkCreated = false;
      const symlinkPath = join(tmpDir, "symlink.txt");
      try {
        symlinkSync("file1.txt", symlinkPath);
        symlinkCreated = true;
      } catch (_) {}

      // Snapshot status before rollback
      const porcelainBefore = git(["status", "--porcelain=v1", "-uall"], { cwd: tmpDir });
      const stagedDiffBefore = git(["diff", "--cached"], { cwd: tmpDir });

      // Create checkpoint while repository is in this pre-existing state
      const snap = createCheckpoint("session-pre-existing", { root: tmpDir });
      assert.equal(snap.id, "session-pre-existing");
      assert.equal(snap.clean, false);
      assert.equal(snap.preflight.clean, false);

      // Default / unauthorized rollback attempt
      const res = restoreCheckpoint("session-pre-existing", { root: tmpDir });
      assert.equal(res.ok, false);
      assert.equal(res.status, "refused");
      assert.match(res.reason, /Destructive restore requires explicit authorization/);

      // Verify byte-for-byte survival
      assert.equal(readFileSync(join(tmpDir, "file1.txt"), "utf-8"), "Dirty unstaged edit\n");
      assert.equal(readFileSync(join(tmpDir, "staged.txt"), "utf-8"), "Staged change\n");
      assert.equal(readFileSync(join(tmpDir, "untracked.txt"), "utf-8"), "Untracked pre-existing text\n");
      assert.deepEqual(readFileSync(join(tmpDir, "binary.bin")), binaryPayload);

      if (symlinkCreated) {
        assert.equal(existsSync(symlinkPath), true);
      }

      // Verify index and git status preserved exactly
      const porcelainAfter = git(["status", "--porcelain=v1", "-uall"], { cwd: tmpDir });
      const stagedDiffAfter = git(["diff", "--cached"], { cwd: tmpDir });
      assert.equal(porcelainAfter, porcelainBefore);
      assert.equal(stagedDiffAfter, stagedDiffBefore);
    }
  );

  await t.test("2. Post-checkpoint changes and untracked files are not silently deleted", () => {
    // Checkpoint taken while clean
    const snap = createCheckpoint("session-post", { root: tmpDir });
    assert.equal(snap.clean, true);

    // Post-checkpoint modifications and new untracked files
    writeFileSync(join(tmpDir, "file1.txt"), "Post-checkpoint modification\n");
    writeFileSync(join(tmpDir, "post-untracked.txt"), "Post-checkpoint untracked\n");
    writeFileSync(join(tmpDir, "post-binary.dat"), Buffer.from([0xca, 0xfe, 0xba, 0xbe]));

    // Unauthorized rollback attempt: refuses preflight without mutation
    const unauth = restoreCheckpoint("session-post", { root: tmpDir });
    assert.equal(unauth.ok, false);
    assert.equal(unauth.status, "refused");
    assert.equal(existsSync(join(tmpDir, "post-untracked.txt")), true);
    assert.equal(existsSync(join(tmpDir, "post-binary.dat")), true);

    // Authorized rollback attempt when untracked files are present:
    // MUST REFUSE to prevent silent destruction of untracked material
    const forced = restoreCheckpoint("session-post", { root: tmpDir, force: true });
    assert.equal(forced.ok, false);
    assert.equal(forced.status, "refused");
    assert.match(forced.reason, /Untracked files are present/);

    // Material survives intact
    assert.equal(existsSync(join(tmpDir, "post-untracked.txt")), true);
    assert.equal(existsSync(join(tmpDir, "post-binary.dat")), true);
    assert.equal(readFileSync(join(tmpDir, "file1.txt"), "utf-8"), "Post-checkpoint modification\n");
  });

  await t.test("3. HEAD/branch drift and a new commit fail closed; no history rewrite", () => {
    const initialHead = git(["rev-parse", "HEAD"], { cwd: tmpDir });
    createCheckpoint("session-drift", { root: tmpDir });

    // Make a new commit (HEAD drift)
    writeFileSync(join(tmpDir, "file1.txt"), "Committed revision 2\n");
    execSync('git commit -am "Second commit"', { cwd: tmpDir, stdio: "ignore" });
    const secondHead = git(["rev-parse", "HEAD"], { cwd: tmpDir });
    assert.notEqual(secondHead, initialHead);

    // Attempt rollback with force
    const headDriftRes = restoreCheckpoint("session-drift", { root: tmpDir, force: true });
    assert.equal(headDriftRes.ok, false);
    assert.equal(headDriftRes.status, "refused");
    assert.match(headDriftRes.reason, /HEAD has drifted/);
    assert.equal(git(["rev-parse", "HEAD"], { cwd: tmpDir }), secondHead, "HEAD was not rewritten");

    // Branch drift test
    execSync("git checkout -b feature-drift", { cwd: tmpDir, stdio: "ignore" });
    const branchDriftRes = restoreCheckpoint("session-drift", { root: tmpDir, force: true });
    assert.equal(branchDriftRes.ok, false);
    assert.equal(branchDriftRes.status, "refused");
    assert.match(branchDriftRes.reason, /Branch has drifted/);
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: tmpDir }), "feature-drift");
  });

  await t.test("4. Legacy incomplete checkpoint JSON fails closed without mutation", () => {
    const ckptDir = getCheckpointDir(tmpDir);
    const headSha = git(["rev-parse", "HEAD"], { cwd: tmpDir });

    // Write a legacy v1 checkpoint with uncommitted diff content
    const legacy = {
      version: 1,
      id: "legacy-v1",
      timestamp: new Date().toISOString(),
      headSha,
      branch: "main",
      uncommittedFiles: ["file1.txt"],
      diffContent: "diff --git a/file1.txt b/file1.txt\n...",
    };
    writeFileSync(join(ckptDir, "legacy-v1.json"), JSON.stringify(legacy, null, 2), "utf-8");

    // Dirty file in tree
    writeFileSync(join(tmpDir, "file1.txt"), "Dirty in-flight\n");

    const res = restoreCheckpoint("legacy-v1", { root: tmpDir, force: true });
    assert.equal(res.ok, false);
    assert.equal(res.status, "refused");
    assert.match(res.reason, /lacks complete lossless preflight state/);
    assert.equal(readFileSync(join(tmpDir, "file1.txt"), "utf-8"), "Dirty in-flight\n");
  });

  await t.test("5. Corrupt snapshot and git command failures report error; no success handover", () => {
    const ckptDir = getCheckpointDir(tmpDir);

    // Corrupt snapshot file
    writeFileSync(join(ckptDir, "corrupted.json"), "{ invalid JSON content ...", "utf-8");

    assert.throws(
      () => restoreCheckpoint("corrupted", { root: tmpDir }),
      CheckpointError,
      /Corrupted checkpoint file/
    );

    // Path traversal attempt throws
    for (const bad of ["../../escape", "sub/dir", "C:\\evil"]) {
      assert.throws(
        () => restoreCheckpoint(bad, { root: tmpDir }),
        CheckpointError,
        /Invalid checkpoint session id/
      );
    }
  });

  await t.test(
    "6. Safe/authorized restoration path, if supported, is independently proved on temporary repos",
    () => {
      // 1. Repo is completely clean at known HEAD
      const initialHead = git(["rev-parse", "HEAD"], { cwd: tmpDir });
      const snap = createCheckpoint("session-safe", { root: tmpDir });
      assert.equal(snap.clean, true);
      assert.equal(snap.preflight.clean, true);
      assert.equal(snap.headSha, initialHead);

      // 2. Tracked edits are introduced (unstaged and staged), NO untracked files
      writeFileSync(join(tmpDir, "file1.txt"), "Modified tracked content\n");
      writeFileSync(join(tmpDir, "tracked2.txt"), "Second tracked file\n");
      execSync("git add file1.txt tracked2.txt && git commit -m 'Add tracked2 and update file1'", { cwd: tmpDir, stdio: "ignore" });

      // Take a clean checkpoint at this commit
      const snap2 = createCheckpoint("session-safe-2", { root: tmpDir });
      assert.equal(snap2.clean, true);

      // Modify both tracked files
      writeFileSync(join(tmpDir, "file1.txt"), "Dirty edit 1\n");
      writeFileSync(join(tmpDir, "tracked2.txt"), "Dirty edit 2\n");
      execSync("git add tracked2.txt", { cwd: tmpDir, stdio: "ignore" }); // tracked2 is staged

      assert.equal(git(["status", "--porcelain=v1", "-uall"], { cwd: tmpDir }).trim().length > 0, true);

      // 3. Authorized restore execution
      const res = restoreCheckpoint("session-safe-2", { root: tmpDir, force: true });
      assert.equal(res.ok, true);
      assert.equal(res.status, "restored");
      assert.equal(res.id, "session-safe-2");
      assert.ok(res.restoredAt);

      // 4. Proved independently on disk: files reverted to checkpoint state
      assert.equal(readFileSync(join(tmpDir, "file1.txt"), "utf-8"), "Modified tracked content\n");
      assert.equal(readFileSync(join(tmpDir, "tracked2.txt"), "utf-8"), "Second tracked file\n");
      assert.equal(git(["status", "--porcelain=v1", "-uall"], { cwd: tmpDir }).trim(), "");
    }
  );

  await t.test("7. CLI rollback preflight defaults to non-destructive inspection and truthful handover", () => {
    const root = process.cwd();
    const cli = join(root, "bin", "agentctl.mjs");

    createCheckpoint("session-cli", { root: tmpDir });

    // Add dirty and untracked files
    writeFileSync(join(tmpDir, "file1.txt"), "Dirty CLI edit\n");
    writeFileSync(join(tmpDir, "untracked-cli.txt"), "Untracked CLI file\n");

    // 1. Run agentctl rollback --latest --json without --force
    const proc = spawnSync(process.execPath, [cli, "rollback", "--latest", "--json"], {
      cwd: tmpDir,
      encoding: "utf-8",
    });

    assert.equal(proc.status, 0, proc.stderr);
    const out = JSON.parse(proc.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.status, "refused");
    assert.equal(out.id, "session-cli");
    assert.ok(out.handover, "records a handover");

    // Handover frontmatter must truthfully state status: refused, never rolled-back
    const handoverContent = readFileSync(out.handover, "utf-8");
    assert.match(handoverContent, /status: "refused"/);
    assert.doesNotMatch(handoverContent, /status: "rolled-back"/);

    // Files remain intact
    assert.equal(readFileSync(join(tmpDir, "file1.txt"), "utf-8"), "Dirty CLI edit\n");
    assert.equal(existsSync(join(tmpDir, "untracked-cli.txt")), true);

    // 2. Run agentctl rollback --latest --force --json with untracked files present:
    // Fails closed (status 1) and does not delete untracked files
    const procForced = spawnSync(process.execPath, [cli, "rollback", "--latest", "--force", "--json"], {
      cwd: tmpDir,
      encoding: "utf-8",
    });

    assert.equal(procForced.status, 1);
    const outForced = JSON.parse(procForced.stdout);
    assert.equal(outForced.ok, false);
    assert.equal(outForced.status, "refused");
    assert.equal(existsSync(join(tmpDir, "untracked-cli.txt")), true);
  });
});
