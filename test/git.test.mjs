import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runCmd,
  git,
  resolveBase,
  changedFiles,
  diffText,
  diffBytes,
  showFromOrigin,
  worktreeRemove,
  worktreePrune,
  parseGitHubRepo,
  resolveGitRemoteOrigin,
  GateError,
  NET_GUARD_FLAG,
  NET_GUARD_PRELOAD_URL,
} from "../src/git.mjs";

test("src/git.mjs Unit Tests", async (t) => {
  let tmpRoot;

  t.beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "jules-git-test-"));
  });

  t.afterEach(() => {
    if (tmpRoot) {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  await t.test("GateError structure and constants", () => {
    const err = new GateError("Test error", { code: 42 });
    assert.equal(err.name, "GateError");
    assert.equal(err.message, "Test error");
    assert.equal(err.code, 42);

    const defaultErr = new GateError("Default code error");
    assert.equal(defaultErr.code, 1);

    assert.ok(typeof NET_GUARD_FLAG === "string" && NET_GUARD_FLAG.includes("--import"));
    assert.ok(typeof NET_GUARD_PRELOAD_URL === "string");
  });

  await t.test("runCmd: executes basic commands and handles options", () => {
    // Array command
    const resArray = runCmd([process.execPath, "-e", "console.log('hello from node')"], { cwd: tmpRoot });
    assert.equal(resArray.status, 0);
    assert.equal(resArray.stdout, "hello from node");
    assert.equal(resArray.stderr, "");

    // String command without shell
    const resStr = runCmd(`"${process.execPath}" -e "console.log(123)"`, { cwd: tmpRoot });
    assert.equal(resStr.status, 0);
    assert.equal(resStr.stdout, "123");

    // Shell command with pipe / special character
    const resShell = runCmd(`"${process.execPath}" -e "console.log(String.fromCharCode(112,105,112,101,100))"`, { cwd: tmpRoot });
    assert.equal(resShell.status, 0);
    assert.equal(resShell.stdout, "piped");

    // Empty command handling
    assert.throws(
      () => runCmd("", { cwd: tmpRoot }),
      (err) => err instanceof GateError && err.message.includes("Empty command provided")
    );

    const emptyIgnore = runCmd("", { cwd: tmpRoot, ignoreError: true });
    assert.equal(emptyIgnore.status, 0);
    assert.equal(emptyIgnore.stdout, "");
  });

  await t.test("runCmd: runs a package-manager shim, which on Windows is not an executable", () => {
    // `npm` is `npm.cmd` on Windows and execFileSync cannot spawn one, so the
    // kit's own default verify command failed with `spawnSync npm ENOENT` on
    // every Windows install — the gate's VERIFY phase could never run there.
    // Written against npm rather than a stub because the shim, not the
    // argument handling, is what breaks.
    const res = runCmd("npm --version", { cwd: tmpRoot, ignoreError: true });
    assert.equal(res.status, 0, `npm --version failed: ${res.stderr}`);
    assert.match(res.stdout, /^\d+\.\d+\.\d+/);
  });

  await t.test("runCmd: an array command keeps arguments that contain spaces intact", () => {
    // The Windows shim path rebuilds the command line by joining on spaces,
    // which is lossless only for a string that was split on whitespace. An
    // array is exempt from it, and this is the case that would break if it
    // were not.
    const res = runCmd([process.execPath, "-e", "console.log(process.argv[1])", "two words"], { cwd: tmpRoot });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, "two words");
  });

  await t.test("runCmd: error handling, ignoreError, timeouts and maxBuffer", () => {
    // Non-zero exit code with ignoreError: false
    assert.throws(
      () => runCmd([process.execPath, "-e", "process.exit(5)"], { cwd: tmpRoot }),
      (err) => err.status === 5 || err.code === 5
    );

    // Non-zero exit code with ignoreError: true
    const failRes = runCmd([process.execPath, "-e", "console.error('custom error'); process.exit(3)"], {
      cwd: tmpRoot,
      ignoreError: true,
    });
    assert.equal(failRes.status, 3);
    assert.ok(failRes.stderr.includes("custom error"));

    // Timeout (ETIMEDOUT)
    assert.throws(
      () => runCmd([process.execPath, "-e", "while(true){}"], { cwd: tmpRoot, timeout: 50 }),
      (err) => err instanceof GateError && err.message.includes("ETIMEDOUT")
    );

    const timeoutRes = runCmd([process.execPath, "-e", "while(true){}"], { cwd: tmpRoot, timeout: 50, ignoreError: true });
    assert.equal(timeoutRes.status, 124);
    assert.ok(timeoutRes.stderr.includes("ETIMEDOUT"));

    // Buffer overflow (ENOBUFS)
    assert.throws(
      () => runCmd([process.execPath, "-e", "console.log('A'.repeat(5000))"], { cwd: tmpRoot, maxBuffer: 100 }),
      (err) => err instanceof GateError && err.message.includes("ENOBUFS")
    );
  });

  await t.test("git: executes git commands in initialized repository", () => {
    // Initialize git repo
    runCmd(["git", "init", "-b", "main"], { cwd: tmpRoot });
    runCmd(["git", "config", "user.name", "TestUser"], { cwd: tmpRoot });
    runCmd(["git", "config", "user.email", "test@example.com"], { cwd: tmpRoot });

    // Status check
    const status = git(["status", "--porcelain"], { cwd: tmpRoot });
    assert.equal(status, "");

    // Raw mode returns untrimmed output with trailing newline
    const rawStatus = git(["status", "--porcelain"], { cwd: tmpRoot, raw: true });
    assert.equal(typeof rawStatus, "string");

    // Create file and commit
    writeFileSync(join(tmpRoot, "file1.txt"), "hello\n", "utf-8");
    git(["add", "file1.txt"], { cwd: tmpRoot });
    git(["commit", "-m", "initial commit"], { cwd: tmpRoot });

    // String argument parsing
    const branch = git("branch --show-current", { cwd: tmpRoot });
    assert.equal(branch, "main");

    // Error handling with ignoreError
    const invalidRes = git(["rev-parse", "--verify", "non-existent-ref"], { cwd: tmpRoot, ignoreError: true });
    assert.equal(invalidRes, "");

    // Error handling without ignoreError
    assert.throws(
      () => git(["rev-parse", "--verify", "non-existent-ref"], { cwd: tmpRoot }),
      (err) => err instanceof GateError && err.message.includes("Git command failed")
    );
  });

  await t.test("resolveBase, changedFiles, diffText, diffBytes and showFromOrigin", () => {
    // Setup git repo with commits and branches
    runCmd(["git", "init", "-b", "main"], { cwd: tmpRoot });
    runCmd(["git", "config", "user.name", "TestUser"], { cwd: tmpRoot });
    runCmd(["git", "config", "user.email", "test@example.com"], { cwd: tmpRoot });

    writeFileSync(join(tmpRoot, "base.txt"), "base content\n", "utf-8");
    git(["add", "base.txt"], { cwd: tmpRoot });
    git(["commit", "-m", "commit on main"], { cwd: tmpRoot });

    const mainCommit = resolveBase(tmpRoot, "main");
    assert.ok(/^[0-9a-f]{40}$/.test(mainCommit));

    // Create feature branch
    git(["checkout", "-b", "feature-branch"], { cwd: tmpRoot });
    writeFileSync(join(tmpRoot, "feature.txt"), "feature content\n", "utf-8");
    git(["add", "feature.txt"], { cwd: tmpRoot });
    git(["commit", "-m", "commit on feature"], { cwd: tmpRoot });

    // Committed mode
    const committedChanged = changedFiles(tmpRoot, "main", "committed");
    assert.deepEqual(committedChanged, ["feature.txt"]);

    const textDiff = diffText(tmpRoot, "main", "committed");
    assert.ok(textDiff.includes("+feature content"));

    const bytes = diffBytes(tmpRoot, "main", "committed");
    assert.ok(bytes > 0);
    assert.equal(bytes, Buffer.byteLength(textDiff, "utf-8"));

    // showFromOrigin
    const originBaseContent = showFromOrigin(tmpRoot, "main", "base.txt");
    assert.equal(originBaseContent, "base content\n");

    const nonExistentOrigin = showFromOrigin(tmpRoot, "main", "does-not-exist.txt");
    assert.equal(nonExistentOrigin, null);

    // Working-tree mode with untracked files
    writeFileSync(join(tmpRoot, "untracked.txt"), "untracked content\n", "utf-8");
    const workingChanged = changedFiles(tmpRoot, "main", "working-tree");
    assert.ok(workingChanged.includes("feature.txt"));
    assert.ok(workingChanged.includes("untracked.txt"));

    const workingDiff = diffText(tmpRoot, "main", "working-tree");
    assert.ok(workingDiff.includes("untracked content"));

    // Staged mode
    writeFileSync(join(tmpRoot, "staged.txt"), "staged content\n", "utf-8");
    git(["add", "staged.txt"], { cwd: tmpRoot });
    const stagedChanged = changedFiles(tmpRoot, "main", "staged");
    assert.ok(stagedChanged.includes("feature.txt"));
    assert.ok(stagedChanged.includes("staged.txt"));
  });

  await t.test("worktreeRemove and worktreePrune helpers", () => {
    runCmd(["git", "init", "-b", "main"], { cwd: tmpRoot });
    runCmd(["git", "config", "user.name", "TestUser"], { cwd: tmpRoot });
    runCmd(["git", "config", "user.email", "test@example.com"], { cwd: tmpRoot });

    writeFileSync(join(tmpRoot, "initial.txt"), "init\n", "utf-8");
    git(["add", "initial.txt"], { cwd: tmpRoot });
    git(["commit", "-m", "init"], { cwd: tmpRoot });

    const wtDir = join(tmpdir(), `jules-wt-${Date.now()}`);
    mkdirSync(wtDir, { recursive: true });

    try {
      git(["worktree", "add", wtDir, "-b", "wt-branch"], { cwd: tmpRoot });
      // Remove worktree via helper
      worktreeRemove(tmpRoot, wtDir);
      // Prune worktrees via helper
      const pruneRes = worktreePrune(tmpRoot);
      assert.equal(typeof pruneRes, "string");
    } finally {
      try {
        rmSync(wtDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  await t.test("parseGitHubRepo extracts owner/repo from SSH, HTTPS, and auth URLs", () => {
    // SSH format
    assert.equal(parseGitHubRepo("git@github.com:owner/my-repo.git"), "owner/my-repo");
    assert.equal(parseGitHubRepo("git@github.com:owner/my-repo"), "owner/my-repo");
    assert.equal(parseGitHubRepo("ssh://git@github.com/owner/my-repo.git"), "owner/my-repo");

    // HTTPS format
    assert.equal(parseGitHubRepo("https://github.com/owner/my-repo.git"), "owner/my-repo");
    assert.equal(parseGitHubRepo("https://github.com/owner/my-repo"), "owner/my-repo");
    assert.equal(parseGitHubRepo("https://token:x@github.com/owner/my-repo.git"), "owner/my-repo");
    assert.equal(parseGitHubRepo("git://github.com/owner/my-repo.git"), "owner/my-repo");

    // Non-GitHub or invalid
    assert.equal(parseGitHubRepo("https://gitlab.com/owner/my-repo.git"), "");
    assert.equal(parseGitHubRepo("https://bitbucket.org/owner/my-repo.git"), "");
    assert.equal(parseGitHubRepo("not a url"), "");
    assert.equal(parseGitHubRepo(""), "");
    assert.equal(parseGitHubRepo(null), "");
  });

  await t.test("resolveGitRemoteOrigin extracts repo from configured git remote", () => {
    runCmd(["git", "init", "-b", "main"], { cwd: tmpRoot });
    // Without remote
    assert.equal(resolveGitRemoteOrigin(tmpRoot), "");

    // With remote
    runCmd(["git", "remote", "add", "origin", "git@github.com:test-owner/test-repo.git"], { cwd: tmpRoot });
    assert.equal(resolveGitRemoteOrigin(tmpRoot), "test-owner/test-repo");
  });
});
