import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { ensureSignedReleaseTag } from "../scripts/release-tag-policy.mjs";

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "jok-release-tag-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Release Test"]);
  git(root, ["config", "user.email", "release-test@example.com"]);
  writeFileSync(join(root, "README.md"), "Initial release fixture\n");
  git(root, ["add", "README.md"]);
  git(root, ["-c", "commit.gpgsign=false", "commit", "-qm", "initial"]);
  return root;
}

test("missing signing key stops creation without leaving an unsigned tag", (t) => {
  const root = fixture(t);
  git(root, ["config", "gpg.format", "ssh"]);
  git(root, ["config", "user.signingkey", join(root, "missing-key")]);
  assert.throws(() => ensureSignedReleaseTag(root, "v9.1.0", "v9.1.0"), /Could not create signed release tag/);
  assert.equal(git(root, ["tag", "--list", "v9.1.0"]), "");
});

test("existing unsigned annotated tag is rejected and not rewritten", (t) => {
  const root = fixture(t);
  git(root, ["tag", "-a", "v9.1.1", "-m", "unsigned"]);
  const previous = git(root, ["rev-parse", "refs/tags/v9.1.1"]);
  assert.throws(() => ensureSignedReleaseTag(root, "v9.1.1", "v9.1.1"), /no verifiable Git signature/);
  assert.equal(git(root, ["rev-parse", "refs/tags/v9.1.1"]), previous);
});

test("existing tag pointing to an older commit is never moved", (t) => {
  const root = fixture(t);
  git(root, ["tag", "-a", "v9.1.2", "-m", "old"]);
  const previous = git(root, ["rev-parse", "refs/tags/v9.1.2"]);
  writeFileSync(join(root, "README.md"), "New commit\n");
  git(root, ["add", "README.md"]);
  git(root, ["-c", "commit.gpgsign=false", "commit", "-qm", "new"]);
  assert.throws(() => ensureSignedReleaseTag(root, "v9.1.2", "v9.1.2"), /Refusing to rewrite/);
  assert.equal(git(root, ["rev-parse", "refs/tags/v9.1.2"]), previous);
});

test("lightweight tag cannot pass as a signed release", (t) => {
  const root = fixture(t);
  git(root, ["tag", "v9.1.3"]);
  assert.throws(() => ensureSignedReleaseTag(root, "v9.1.3", "v9.1.3"), /lightweight/);
});

test("SSH-signed tags are verified, reusable, and never rewritten", (t) => {
  const probe = spawnSync("ssh-keygen", ["-V"], { encoding: "utf8" });
  assert.ifError(probe.error);
  const root = fixture(t);
  const key = join(root, "release-test-key");
  const makeKey = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "release-test@example.com", "-f", key], { encoding: "utf8" });
  assert.equal(makeKey.status, 0, (makeKey.stderr || "").trim());
  const allowed = join(root, "allowed-signers");
  writeFileSync(allowed, "release-test@example.com " + readFileSync(key + ".pub", "utf8"));
  git(root, ["config", "gpg.format", "ssh"]);
  git(root, ["config", "user.signingkey", key]);
  git(root, ["config", "gpg.ssh.allowedSignersFile", allowed]);

  const first = ensureSignedReleaseTag(root, "v9.1.4", "v9.1.4");
  assert.equal(first.created, true);
  assert.equal(first.verified, true);
  const initialRef = git(root, ["rev-parse", "refs/tags/v9.1.4"]);
  const repeat = ensureSignedReleaseTag(root, "v9.1.4", "v9.1.4");
  assert.equal(repeat.created, false);
  assert.equal(git(root, ["rev-parse", "refs/tags/v9.1.4"]), initialRef);
});
