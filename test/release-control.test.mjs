import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readReleaseHead, ensureReleaseTag, pushReleaseRefs, createGithubRelease } from "../scripts/release-control.mjs";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const release = { tagName: "v0.76.1", headSha: HEAD, packageName: "fixture" };

function gitFixture(overrides = {}) {
  const state = { branch: "main", dirty: "", head: HEAD, tag: HEAD, signatureValid: true, ...overrides };
  const calls = [];
  const run = (command, args) => {
    assert.equal(command, "git");
    calls.push(args);
    const key = args.join(" ");
    if (key === "branch --show-current") return state.branch;
    if (key === "status --porcelain") return state.dirty;
    if (key === "rev-parse HEAD") return state.head;
    if (args[0] === "show-ref") {
      if (state.headAfterLookup) state.head = state.headAfterLookup;
      if (state.lookupError) throw state.lookupError;
      if (state.tag === null) throw Object.assign(new Error("missing ref"), { status: 1 });
      return "";
    }
    if (args[0] === "tag") {
      assert.equal(args[1], "-s", "release tags must be signed");
      assert.equal(state.tag, null, "an existing tag must never be replaced");
      state.tag = /^[a-f0-9]{40}$/.test(args.at(-1)) ? args.at(-1) : state.head;
      return "";
    }
    if (args[0] === "rev-parse") return state.tag;
    if (args[0] === "verify-tag") {
      if (!state.signatureValid) throw new Error("invalid tag signature");
      return "";
    }
    assert.fail(`Unexpected git call: ${key}`);
  };
  return { state, calls, run };
}

describe("release commit and tag identity", () => {
  it("accepts a clean main commit", () => {
    const fixture = gitFixture();
    assert.equal(readReleaseHead("/fixture", fixture.run), HEAD);
  });

  it("rejects a feature branch or detached HEAD", () => {
    for (const branch of ["docs/preview", ""]) {
      const fixture = gitFixture({ branch });
      assert.throws(() => readReleaseHead("/fixture", fixture.run), /main branch/);
      assert.equal(fixture.calls.some((args) => args[0] === "tag"), false);
    }
  });

  it("rejects tracked and untracked changes", () => {
    for (const dirty of [" M src/core.mjs", "?? extra.mjs"]) {
      const fixture = gitFixture({ dirty });
      assert.throws(() => readReleaseHead("/fixture", fixture.run), /clean working tree/);
    }
  });

  it("rejects HEAD changing after checks without creating a tag", () => {
    const fixture = gitFixture({ head: OTHER, tag: null });
    assert.throws(() => ensureReleaseTag("/fixture", release, fixture.run), /HEAD changed/);
    assert.equal(fixture.state.tag, null);
  });

  it("rejects an existing tag for another commit without moving it", () => {
    const fixture = gitFixture({ tag: OTHER });
    assert.throws(() => ensureReleaseTag("/fixture", release, fixture.run), /refusing to move/);
    assert.equal(fixture.state.tag, OTHER);
    assert.equal(fixture.calls.some((args) => args[0] === "tag"), false);
  });

  it("accepts an existing tag only after signature verification", () => {
    const fixture = gitFixture();
    ensureReleaseTag("/fixture", release, fixture.run);
    assert.equal(fixture.calls.some((args) => args[0] === "verify-tag"), true);
    assert.equal(fixture.calls.some((args) => args[0] === "tag"), false);
  });

  it("rejects an unsigned or unverifiable existing tag", () => {
    const fixture = gitFixture({ signatureValid: false });
    assert.throws(() => ensureReleaseTag("/fixture", release, fixture.run), /invalid tag signature/);
  });

  it("creates a missing signed tag and verifies its commit and signature", () => {
    const fixture = gitFixture({ tag: null });
    ensureReleaseTag("/fixture", release, fixture.run);
    assert.equal(fixture.state.tag, HEAD);
    assert.equal(fixture.calls.some((args) => args[0] === "verify-tag"), true);
  });

  it("does not interpret a git failure as a missing tag", () => {
    const failure = Object.assign(new Error("corrupt refs"), { status: 128 });
    const fixture = gitFixture({ lookupError: failure });
    assert.throws(() => ensureReleaseTag("/fixture", release, fixture.run), (err) => err === failure);
    assert.equal(fixture.calls.some((args) => args[0] === "tag"), false);
  });

  it("tags the verified commit if main advances during the tag lookup", () => {
    const fixture = gitFixture({ tag: null, headAfterLookup: OTHER });
    ensureReleaseTag("/fixture", release, fixture.run);
    assert.equal(fixture.state.head, OTHER);
    assert.equal(fixture.state.tag, HEAD);
  });
});

describe("release push identity", () => {
  it("rejects a changed HEAD before pushing", () => {
    const fixture = gitFixture({ head: OTHER });
    assert.throws(() => pushReleaseRefs("/fixture", release, fixture.run), /HEAD changed/);
    assert.equal(fixture.calls.some((args) => args[0] === "push"), false);
  });

  it("pushes only the verified commit even if local main advances during push", () => {
    const dir = mkdtempSync(join(tmpdir(), "jok-release-push-"));
    const remote = join(dir, "remote.git");
    const checkout = join(dir, "checkout");
    const git = (args, cwd = checkout) => execFileSync("git", args, {
      cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    try {
      git(["init", "--bare", remote], dir);
      git(["init", "-b", "main", checkout], dir);
      git(["config", "user.name", "Release Push Fixture"]);
      git(["config", "user.email", "release-push-fixture@example.com"]);
      writeFileSync(join(checkout, "source.txt"), "verified\n");
      git(["add", "."]);
      git(["commit", "-m", "test: establish verified fixture"]);
      const verified = git(["rev-parse", "HEAD"]);
      git(["tag", release.tagName]);
      writeFileSync(join(checkout, "source.txt"), "unverified\n");
      git(["commit", "-am", "test: advance fixture branch"]);
      const unverified = git(["rev-parse", "HEAD"]);
      git(["reset", "--hard", verified]);
      git(["remote", "add", "origin", remote]);
      let advanced = false;
      pushReleaseRefs(checkout, { ...release, headSha: verified }, (command, args, opts) => {
        if (args[0] === "push" && !advanced) {
          git(["update-ref", "refs/heads/main", unverified]);
          advanced = true;
        }
        return execFileSync(command, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
      });
      assert.equal(advanced, true);
      assert.equal(git(["rev-parse", "main"]), unverified);
      assert.equal(git(["rev-parse", "main"], remote), verified);
      assert.equal(git(["rev-parse", `refs/tags/${release.tagName}^{commit}`], remote), verified);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("GitHub Release outcome", () => {
  it("passes exact notes to gh and cleans the temporary file on success", () => {
    let notesFile;
    createGithubRelease("/fixture", { tagName: release.tagName, notes: "Line one\nLine two\n" }, (command, args, opts) => {
      assert.equal(command, "gh");
      assert.deepEqual(args.slice(0, 3), ["release", "create", release.tagName]);
      assert.equal(opts.cwd, "/fixture");
      notesFile = args[args.indexOf("--notes-file") + 1];
      assert.equal(readFileSync(notesFile, "utf-8"), "Line one\nLine two\n");
    });
    assert.equal(existsSync(notesFile), false);
  });

  it("propagates gh failure and cleans notes instead of claiming success", () => {
    let notesFile;
    const failure = new Error("gh failed: authentication or network error");
    assert.throws(() => createGithubRelease("/fixture", { tagName: release.tagName, notes: "Release notes" }, (_command, args) => {
      notesFile = args[args.indexOf("--notes-file") + 1];
      assert.equal(existsSync(notesFile), true);
      throw failure;
    }), (err) => err === failure);
    assert.equal(existsSync(notesFile), false);
  });
});
