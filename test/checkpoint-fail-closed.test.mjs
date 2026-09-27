import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  createCheckpoint,
  restoreCheckpoint,
  CheckpointError,
  getCheckpointDir,
} from "../src/ops/checkpoint.mjs";
import { git } from "../src/git.mjs";

function gitExec(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

function readText(filePath) {
  return readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
}

function setupRepo(prefix = "ckpt-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  gitExec(dir, ["init", "-b", "main"]);
  gitExec(dir, ["config", "user.name", "Test Runner"]);
  gitExec(dir, ["config", "user.email", "test@runner.local"]);
  gitExec(dir, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(dir, ".gitignore"), ".agent/state/\n.agent/handovers/\n");
  writeFileSync(join(dir, "file1.txt"), "Initial content\n");
  gitExec(dir, ["add", "."]);
  gitExec(dir, ["commit", "-m", "Initial commit"]);
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
      gitExec(tmpDir, ["add", "staged.txt"]);

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
      assert.equal(readText(join(tmpDir, "file1.txt")), "Dirty unstaged edit\n");
      assert.equal(readText(join(tmpDir, "staged.txt")), "Staged change\n");
      assert.equal(readText(join(tmpDir, "untracked.txt")), "Untracked pre-existing text\n");
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
    // 1. Create clean checkpoint
    const snap = createCheckpoint("session-clean", { root: tmpDir });
    assert.equal(snap.clean, true);

    // 2. Add untracked files (both text and binary) and post-checkpoint modifications
    writeFileSync(join(tmpDir, "post-untracked.txt"), "Should survive\n");
    writeFileSync(join(tmpDir, "post-binary.dat"), Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    writeFileSync(join(tmpDir, "file1.txt"), "Post-checkpoint modification\n");

    // 3. Default rollback fails closed and reports refused
    const res = restoreCheckpoint("session-clean", { root: tmpDir });
    assert.equal(res.ok, false);
    assert.equal(res.status, "refused");
    assert.match(res.reason, /Destructive restore requires explicit authorization/);

    // Untracked files and modifications are preserved
    assert.equal(existsSync(join(tmpDir, "post-untracked.txt")), true);
    assert.equal(existsSync(join(tmpDir, "post-binary.dat")), true);
    assert.equal(readText(join(tmpDir, "file1.txt")), "Post-checkpoint modification\n");

    // 4. Forced rollback also refuses if untracked files are present (preventing silent data loss)
    const forced = restoreCheckpoint("session-clean", { root: tmpDir, force: true });
    assert.equal(forced.ok, false);
    assert.equal(forced.status, "refused");
    assert.match(forced.reason, /Untracked files are present/);

    // Material survives intact
    assert.equal(existsSync(join(tmpDir, "post-untracked.txt")), true);
    assert.equal(existsSync(join(tmpDir, "post-binary.dat")), true);
    assert.equal(readText(join(tmpDir, "file1.txt")), "Post-checkpoint modification\n");
  });

  await t.test("3. HEAD/branch drift and a new commit fail closed; no history rewrite", () => {
    const initialHead = git(["rev-parse", "HEAD"], { cwd: tmpDir });
    createCheckpoint("session-drift", { root: tmpDir });

    // Make a new commit (HEAD drift)
    writeFileSync(join(tmpDir, "file1.txt"), "Committed revision 2\n");
    gitExec(tmpDir, ["commit", "-am", "Second commit"]);
    const secondHead = git(["rev-parse", "HEAD"], { cwd: tmpDir });
    assert.notEqual(secondHead, initialHead);

    // Attempt rollback with force
    const headDriftRes = restoreCheckpoint("session-drift", { root: tmpDir, force: true });
    assert.equal(headDriftRes.ok, false);
    assert.equal(headDriftRes.status, "refused");
    assert.match(headDriftRes.reason, /HEAD has drifted/);
    assert.equal(git(["rev-parse", "HEAD"], { cwd: tmpDir }), secondHead, "HEAD was not rewritten");

    // Branch drift test
    gitExec(tmpDir, ["checkout", "-b", "feature-drift"]);
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
    assert.equal(readText(join(tmpDir, "file1.txt")), "Dirty in-flight\n");
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
      gitExec(tmpDir, ["add", "file1.txt", "tracked2.txt"]);
      gitExec(tmpDir, ["commit", "-m", "Add tracked2 and update file1"]);

      // Take a clean checkpoint at this commit
      const snap2 = createCheckpoint("session-safe-2", { root: tmpDir });
      assert.equal(snap2.clean, true);

      // Modify both tracked files
      writeFileSync(join(tmpDir, "file1.txt"), "Dirty edit 1\n");
      writeFileSync(join(tmpDir, "tracked2.txt"), "Dirty edit 2\n");
      gitExec(tmpDir, ["add", "tracked2.txt"]); // tracked2 is staged

      assert.equal(git(["status", "--porcelain=v1", "-uall"], { cwd: tmpDir }).trim().length > 0, true);

      // 3. Authorized restore execution
      const res = restoreCheckpoint("session-safe-2", { root: tmpDir, force: true });
      assert.equal(res.ok, true);
      assert.equal(res.status, "restored");
      assert.equal(res.id, "session-safe-2");
      assert.ok(res.restoredAt);

      // 4. Proved independently on disk: files reverted to checkpoint state
      assert.equal(readText(join(tmpDir, "file1.txt")), "Modified tracked content\n");
      assert.equal(readText(join(tmpDir, "tracked2.txt")), "Second tracked file\n");
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
    assert.equal(readText(join(tmpDir, "file1.txt")), "Dirty CLI edit\n");
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

  await t.test(
    "8. Git command failures (status or rev-parse) fail closed immediately, refusing restore without touching HEAD, index, or files",
    () => {
      // Create clean baseline checkpoint
      const snap = createCheckpoint("session-git-fail", { root: tmpDir });
      assert.equal(snap.clean, true);

      // Add tracked modification and untracked file
      writeFileSync(join(tmpDir, "file1.txt"), "Dirty in-flight data\n");
      writeFileSync(join(tmpDir, "untracked-work.txt"), "Untracked important work\n");
      const headBefore = git(["rev-parse", "HEAD"], { cwd: tmpDir });

      // Corrupt .git/index so git status fails
      const indexPath = join(tmpDir, ".git", "index");
      const savedIndex = readFileSync(indexPath);
      writeFileSync(indexPath, "corrupted-git-index-payload\n");

      // Attempt forced restore while Git queries fail
      const resStatusFail = restoreCheckpoint("session-git-fail", { root: tmpDir, force: true });
      assert.equal(resStatusFail.ok, false);
      assert.equal(resStatusFail.status, "refused");
      assert.equal(resStatusFail.canRestore, false);
      assert.match(resStatusFail.reason, /Failed to inspect repository status/);

      // Verify material untouched
      assert.equal(readText(join(tmpDir, "file1.txt")), "Dirty in-flight data\n");
      assert.equal(readText(join(tmpDir, "untracked-work.txt")), "Untracked important work\n");

      // Restore .git/index
      writeFileSync(indexPath, savedIndex);

      // Corrupt .git/HEAD so git rev-parse HEAD fails
      const headRefPath = join(tmpDir, ".git", "HEAD");
      const savedHeadRef = readFileSync(headRefPath);
      writeFileSync(headRefPath, "ref: refs/heads/nonexistent-branch-nowhere\n");

      const resHeadFail = restoreCheckpoint("session-git-fail", { root: tmpDir, force: true });
      assert.equal(resHeadFail.ok, false);
      assert.equal(resHeadFail.status, "refused");
      assert.equal(resHeadFail.canRestore, false);
      assert.match(resHeadFail.reason, /Failed to determine current HEAD commit/);

      // Verify files still untouched
      assert.equal(readText(join(tmpDir, "file1.txt")), "Dirty in-flight data\n");
      assert.equal(readText(join(tmpDir, "untracked-work.txt")), "Untracked important work\n");

      // Restore HEAD ref
      writeFileSync(headRefPath, savedHeadRef);
      assert.equal(git(["rev-parse", "HEAD"], { cwd: tmpDir }), headBefore);
    }
  );

  await t.test(
    "9. Tracked files under internal paths (e.g. .agent/state/) are not ignored: uncommitted modifications prevent falsely clean snapshots and default rollback preserves them",
    () => {
      // 1. Commit a tracked file under .agent/state/
      const internalDir = join(tmpDir, ".agent", "state");
      mkdirSync(internalDir, { recursive: true });
      const internalTracked = join(internalDir, "tracked-schema.json");
      writeFileSync(internalTracked, '{"version": 1, "status": "clean"}\n');
      gitExec(tmpDir, ["add", "-f", ".agent/state/tracked-schema.json"]);
      gitExec(tmpDir, ["commit", "-m", "Track internal schema file"]);

      // 2. Clean checkpoint at this commit
      const cleanSnap = createCheckpoint("session-internal-clean", { root: tmpDir });
      assert.equal(cleanSnap.clean, true);
      assert.equal(cleanSnap.preflight.clean, true);
      assert.deepEqual(cleanSnap.preflight.unstaged, []);

      // 3. Modify the tracked internal file (unstaged)
      writeFileSync(internalTracked, '{"version": 1, "status": "dirty modification"}\n');

      // 4. createCheckpoint must NOT mark this as clean!
      const dirtySnap = createCheckpoint("session-internal-dirty", { root: tmpDir });
      assert.equal(dirtySnap.clean, false, "tracked internal modification must make checkpoint dirty");
      assert.equal(dirtySnap.preflight.clean, false);
      assert.ok(
        dirtySnap.preflight.unstaged.some((f) => f.includes(".agent/state/tracked-schema.json")),
        "tracked internal modification must be recorded in unstaged preflight"
      );

      // 5. Default rollback targets checkpoint and refuses without deleting tracked modifications
      const refusal = restoreCheckpoint("session-internal-dirty", { root: tmpDir });
      assert.equal(refusal.ok, false);
      assert.equal(refusal.status, "refused");
      assert.equal(refusal.dirty, true);
      assert.ok(
        refusal.unstaged.some((f) => f.includes(".agent/state/tracked-schema.json")),
        "unstaged tracked internal file must be reported in preflight"
      );
      assert.equal(readText(internalTracked), '{"version": 1, "status": "dirty modification"}\n');

      // 6. Forced restore to dirtySnap refuses because it lacks complete lossless preflight state
      const forcedDirty = restoreCheckpoint("session-internal-dirty", { root: tmpDir, force: true });
      assert.equal(forcedDirty.ok, false);
      assert.equal(forcedDirty.status, "refused");
      assert.match(forcedDirty.reason, /lacks complete lossless preflight state/);
      assert.equal(readText(internalTracked), '{"version": 1, "status": "dirty modification"}\n');

      // 7. Forced restore to cleanSnap resets tracked modifications safely
      const forcedClean = restoreCheckpoint("session-internal-clean", { root: tmpDir, force: true });
      assert.equal(forcedClean.ok, true);
      assert.equal(forcedClean.status, "restored");
      assert.equal(readText(internalTracked), '{"version": 1, "status": "clean"}\n');
      assert.equal(git(["status", "--porcelain=v1", "-uall"], { cwd: tmpDir }).trim(), "");
    }
  );
});
