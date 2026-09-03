import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { gate } from "../src/engine.mjs";
import { loadConfig } from "../src/config.mjs";
import { diffBytes, binaryDiffEntries } from "../src/git.mjs";
import { scanBinaryPayloads } from "../src/security.mjs";

/**
 * Every case here is a way an agent could have been approved without its work
 * being checked. They were all reachable in shipped versions; each one is the
 * gate's central promise inverted, so each gets a test that fails loudly if the
 * hole reopens.
 */

const git = (dir, args, input) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: "pipe", ...(input === undefined ? {} : { input }) });
const commit = (dir, msg) => {
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", msg]);
};

/**
 * Add a symlink to the index without creating one on disk.
 *
 * `ln` does not exist on Windows, and git there stores symlinks as ordinary
 * files unless core.symlinks is on — so a fixture built with either would test
 * nothing on the platform where scope bypasses are least examined. Writing mode
 * 120000 straight into the index produces the object the gate actually reads
 * (`symlinkChanges` takes the target from the blob), identically everywhere.
 */
const addSymlinkToIndex = (dir, linkPath, target) => {
  const sha = git(dir, ["hash-object", "-w", "--stdin"], target).trim();
  git(dir, ["update-index", "--add", "--cacheinfo", `120000,${sha},${linkPath}`]);
  git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", `link ${linkPath}`]);
};

/** A repo with a real passing suite, committed on `main`. */
function repoWithSuite(extraConfig = "") {
  const dir = mkdtempSync(join(tmpdir(), "jok-hole-"));
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "d", version: "1.0.0", type: "module", scripts: { test: "node --test" } })
  );
  writeFileSync(join(dir, "x.test.mjs"), 'import {test} from "node:test";\ntest("ok",()=>{});\n');
  mkdirSync(join(dir, ".agent"), { recursive: true });
  writeFileSync(join(dir, ".agent", "config.yml"), `version: 1\nbase_branch: main\nverify:\n  test: "npm test"\n${extraConfig}`);
  commit(dir, "init");
  return dir;
}

describe("the gate cannot approve a change it never verified", () => {
  it("rejects when no verification command exists at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jok-nooracle-"));
    try {
      git(dir, ["init", "-q", "-b", "main"]);
      writeFileSync(join(dir, "app.js"), 'console.log("hi");\n');
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(join(dir, ".agent", "config.yml"), 'version: 1\nbase_branch: main\nverify:\n  test: ""\n');
      commit(dir, "init");

      // Syntactically broken code that nothing will ever run.
      writeFileSync(join(dir, "app.js"), "function broken() {\n  this is absolute garbage\n}\n");

      const res = await gate({ root: dir, config: loadConfig(dir), base: "main", mode: "working-tree" });
      assert.equal(res.ok, false, "approving an unverified change is the one thing this tool must not do");
      assert.equal(res.code, 4);

      const verify = res.phases.find((p) => p.phase === "verify");
      assert.equal(verify.ok, false);
      assert.equal(verify.failure.stageId, "oracle");
      assert.match(verify.failure.stderr, /No verification command ran/);
      assert.match(verify.failure.stderr, /verify\.required: false/, "and it must name the deliberate opt-out");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets a repository opt out of verification deliberately", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jok-optout-"));
    try {
      git(dir, ["init", "-q", "-b", "main"]);
      writeFileSync(join(dir, "notes.md"), "# notes\n");
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        'version: 1\nbase_branch: main\nverify:\n  required: false\n  test: ""\n'
      );
      commit(dir, "init");
      writeFileSync(join(dir, "notes.md"), "# notes\nmore\n");

      const res = await gate({ root: dir, config: loadConfig(dir), base: "main", mode: "working-tree" });
      assert.equal(res.ok, true, "scope- and secret-scanning only is a legitimate use, when stated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not count an assertion as verification", async () => {
    // `assert:test-integrity` proves the diff did not weaken a test. It says
    // nothing about whether the code works, so it cannot stand in for an oracle.
    const dir = mkdtempSync(join(tmpdir(), "jok-assertonly-"));
    try {
      git(dir, ["init", "-q", "-b", "main"]);
      writeFileSync(join(dir, "app.js"), "export const a = 1;\n");
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        'version: 1\nbase_branch: main\nverify:\n  test: ""\n  stages:\n    - id: anti-tamper\n      kind: assert\n      assert: test-integrity\n'
      );
      commit(dir, "init");
      writeFileSync(join(dir, "app.js"), "export const a = 2;\n");

      const res = await gate({ root: dir, config: loadConfig(dir), base: "main", mode: "working-tree" });
      assert.equal(res.ok, false);
      assert.equal(res.phases.find((p) => p.phase === "verify").failure.stageId, "oracle");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a binary file is not a blind spot", () => {
  it("measures what a binary blob actually weighs, not its one-line summary", () => {
    const dir = repoWithSuite();
    try {
      git(dir, ["checkout", "-q", "-b", "agent/huge"]);
      // Git decides "binary" by looking for a NUL byte, so the fixture needs
      // real ones — a file of repeated 0x07 diffs as text and would be counted
      // by the old measurement anyway, proving nothing.
      const blob = Buffer.alloc(500_000);
      for (let i = 0; i < blob.length; i += 64) blob[i] = 0;
      writeFileSync(join(dir, "huge.bin"), blob);
      commit(dir, "huge");

      const entries = binaryDiffEntries(dir, "main", "committed");
      assert.ok(entries.some((e) => e.file === "huge.bin" && e.bytes >= 500_000), "the blob's real size must be seen");

      // The diff text alone is a couple of hundred bytes; the payload governor
      // was walked straight past with a file of any size.
      assert.ok(diffBytes(dir, "main", "committed") >= 500_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a credential hidden behind a leading NUL byte", async () => {
    const dir = repoWithSuite();
    try {
      git(dir, ["checkout", "-q", "-b", "agent/sneaky"]);
      writeFileSync(
        join(dir, "secret.dat"),
        Buffer.concat([Buffer.from([0]), Buffer.from("ghp_123456789012345678901234567890123456\n")])
      );
      commit(dir, "sneaky");

      const res = await gate({ root: dir, config: loadConfig(dir), base: "main", mode: "committed" });
      assert.equal(res.ok, false);
      assert.equal(res.code, 6);
      const secrets = res.phases.find((p) => p.phase === "secrets");
      assert.ok(
        secrets.findings.some((f) => f.type === "HIGH_CONFIDENCE_SECRET" && f.file === "secret.dat"),
        "one NUL byte was enough to make the scanner look away"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not fail an ordinary binary asset", async () => {
    const dir = repoWithSuite();
    try {
      git(dir, ["checkout", "-q", "-b", "agent/asset"]);
      // High-entropy bytes with a PNG header — every real image looks like this,
      // which is why only structured patterns are applied to binary content.
      writeFileSync(
        join(dir, "logo.png"),
        Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 37) % 256))])
      );
      commit(dir, "asset");

      const res = await gate({ root: dir, config: loadConfig(dir), base: "main", mode: "committed" });
      assert.equal(res.phases.find((p) => p.phase === "secrets").ok, true, "a real asset must not be a false positive");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a binary too large to inspect rather than passing it silently", () => {
    const dir = mkdtempSync(join(tmpdir(), "jok-bigbin-"));
    try {
      writeFileSync(join(dir, "big.bin"), Buffer.alloc(16, 1));
      const findings = scanBinaryPayloads([{ file: "big.bin", bytes: 50_000_000 }], dir, { capBytes: 1024 });
      assert.equal(findings.length, 1);
      assert.equal(findings[0].type, "BINARY_PAYLOAD_UNSCANNED");
      assert.match(findings[0].description, /not inspected/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a missing or unreadable file instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "jok-nofile-"));
    try {
      assert.deepEqual(scanBinaryPayloads([{ file: "gone.bin", bytes: 10 }], dir), []);
      assert.deepEqual(scanBinaryPayloads([], dir), []);
      assert.deepEqual(scanBinaryPayloads(null, dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("weakening a test is not the same as keeping it", () => {
  const diffOf = (removed, added) =>
    [
      "diff --git a/test/math.test.mjs b/test/math.test.mjs",
      "--- a/test/math.test.mjs",
      "+++ b/test/math.test.mjs",
      "@@ -1,3 +1,3 @@",
      ...removed.map((l) => `-  ${l}`),
      ...added.map((l) => `+  ${l}`),
    ].join("\n");

  it("catches a value check swapped for a truthiness check", async () => {
    const { checkTestTampering } = await import("../src/security.mjs");
    const res = checkTestTampering(
      diffOf(["assert.strictEqual(add(2, 3), 5);"], ["assert.ok(add(2, 3) !== undefined);"])
    );
    assert.equal(res.ok, false, "one out, one in kept the count level while the suite stopped checking");
    assert.ok(res.violations.some((v) => v.type === "ASSERTION_WEAKENED"));
  });

  it("catches it across assertion dialects", async () => {
    const { checkTestTampering } = await import("../src/security.mjs");
    for (const [removed, added] of [
      ["expect(sum).toBe(5);", "expect(sum).toBeDefined();"],
      ["assert_eq!(add(2, 3), 5);", "assert!(add(2, 3) != 0);"],
    ]) {
      const res = checkTestTampering(diffOf([removed], [added]));
      assert.equal(res.ok, false, `${removed} → ${added} is a weakening`);
    }
  });

  it("leaves ordinary maintenance alone", async () => {
    const { checkTestTampering } = await import("../src/security.mjs");
    // Strengthening, renaming and adding all keep the number of assertions
    // that name an expected value from falling.
    assert.equal(checkTestTampering(diffOf(["assert.equal(a, b);"], ["assert.strictEqual(a, b);"])).ok, true);
    assert.equal(checkTestTampering(diffOf(["assert.strictEqual(x, 1);"], ["assert.strictEqual(y, 1);"])).ok, true);
    assert.equal(checkTestTampering(diffOf([], ["assert.ok(thing);"])).ok, true);
  });
});

describe("a symlink is judged by where it points", () => {
  it("rejects a link that reaches a protected path", async () => {
    const dir = repoWithSuite();
    try {
      git(dir, ["checkout", "-q", "-b", "agent/link"]);
      addSymlinkToIndex(dir, "notes.md", ".agent/config.yml");

      const res = await gate({ root: dir, config: loadConfig(dir), base: "main", mode: "committed" });
      assert.equal(res.ok, false);
      assert.equal(res.code, 3);
      const scope = res.phases.find((p) => p.phase === "scope");
      const violation = scope.violations.find((v) => v.symlink === "notes.md");
      assert.ok(violation, "the violation must be reported against the link the diff actually adds");
      assert.match(violation.reason, /reached through symlink/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves an ordinary symlink alone", async () => {
    const dir = repoWithSuite();
    try {
      git(dir, ["checkout", "-q", "-b", "agent/oklink"]);
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(join(dir, "docs", "real.md"), "hi\n");
      commit(dir, "docs");
      addSymlinkToIndex(dir, "shortcut.md", "docs/real.md");

      const res = await gate({ root: dir, config: loadConfig(dir), base: "main", mode: "committed" });
      assert.equal(res.phases.find((p) => p.phase === "scope").ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("evidence attests to what it claims to attest to", () => {
  it("fails once the source it covered has been rewritten", async () => {
    const dir = repoWithSuite();
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "math.mjs"), "export const add = (a, b) => a + b;\n");
      commit(dir, "src");

      const { generateEvidenceManifest, verifyEvidenceManifest } = await import("../src/evidence.mjs");
      const manifest = generateEvidenceManifest(dir, { executionRecords: [] });
      assert.equal(verifyEvidenceManifest(dir, manifest).ok, true, "untouched, it verifies");

      writeFileSync(join(dir, "src", "math.mjs"), "BROKEN MALICIOUS CODE\n");
      const after = verifyEvidenceManifest(dir, manifest);
      assert.equal(after.ok, false, "evidence must not survive the code it attests to being replaced");
      assert.match(after.reason, /Source tree has changed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sees a test file that lives at the repository root", async () => {
    const dir = repoWithSuite();
    try {
      const { computeDirectoryHash } = await import("../src/evidence.mjs");
      const before = computeDirectoryHash(dir, { testOnly: true });
      assert.ok(
        Object.keys(before.fileHashes).some((f) => f === "x.test.mjs"),
        "a suite beside package.json was invisible to every hash the manifest recorded"
      );

      writeFileSync(join(dir, "x.test.mjs"), "GARBAGE\n");
      assert.notEqual(computeDirectoryHash(dir, { testOnly: true }).treeHash, before.treeHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("features that were advertised and never called", () => {
  it("locks a file against every other task, not just the same one", async () => {
    const { acquireLock, releaseLock } = await import("../src/state.mjs");
    const dir = mkdtempSync(join(tmpdir(), "jok-lock-"));
    try {
      assert.equal(acquireLock("agent-1", "task-1", ["src/math.js"], dir).ok, true);

      // The lock file is named after the task, so this used to succeed: the
      // `files` argument — the entire point of the call — was recorded as
      // metadata and compared against nothing.
      const conflict = acquireLock("agent-2", "task-2", ["src/math.js"], dir);
      assert.equal(conflict.ok, false, "two agents cannot both hold the same file");
      assert.equal(conflict.holder, "agent-1");
      assert.deepEqual(conflict.conflictingFiles, ["src/math.js"]);

      // A disjoint file set is not a conflict.
      assert.equal(acquireLock("agent-3", "task-3", ["src/other.js"], dir).ok, true);

      // Releasing frees the path again.
      releaseLock("task-1", dir);
      assert.equal(acquireLock("agent-4", "task-4", ["src/math.js"], dir).ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalises separators before comparing held paths", async () => {
    const { acquireLock } = await import("../src/state.mjs");
    const dir = mkdtempSync(join(tmpdir(), "jok-lockwin-"));
    try {
      assert.equal(acquireLock("a", "t1", ["src\\deep\\mod.js"], dir).ok, true);
      assert.equal(
        acquireLock("b", "t2", ["src/deep/mod.js"], dir).ok,
        false,
        "a backslash spelling is the same file"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes a checkpoint before a dispatch can touch the tree", async () => {
    const dir = repoWithSuite();
    try {
      const { dispatch } = await import("../src/engine.mjs");
      const { listCheckpoints } = await import("../src/ops/checkpoint.mjs");
      assert.equal(listCheckpoints(dir).length, 0);

      // A stub provider stands in for the agent: what matters is that the
      // snapshot exists by the time anything could have run.
      await dispatch(
        { id: "TASK-CKPT", title: "t", prompt: "do a thing" },
        { root: dir, config: loadConfig(dir), provider: { dispatch: async () => ({ id: "s1", status: "active" }) } }
      );

      const checkpoints = listCheckpoints(dir);
      assert.equal(checkpoints.length, 1, "`agentctl rollback` had nothing to restore because nothing ever created one");
      assert.match(String(checkpoints[0].id ?? checkpoints[0]), /TASK-CKPT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not snapshot a rehearsal", async () => {
    const dir = repoWithSuite();
    try {
      const { dispatch } = await import("../src/engine.mjs");
      const { listCheckpoints } = await import("../src/ops/checkpoint.mjs");
      await dispatch(
        { id: "TASK-DRY", title: "t", prompt: "do a thing" },
        { root: dir, config: loadConfig(dir), dryRun: true, provider: { dispatch: async () => ({ id: "s", status: "active" }) } }
      );
      assert.equal(listCheckpoints(dir).length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("an authenticated GET does not need a session id", () => {
  it("allows a custom url through the session guard", async () => {
    const { createProvider } = await import("../src/provider.mjs");
    const provider = createProvider("jules", {});

    // `listSources()` reuses getSession purely as an authenticated GET. The id
    // guard fired before the url was consulted, so listing a repository's
    // connected sources threw a TypeError against the live API every time —
    // a failure neither a dry run nor a unit test could reach, because both
    // stop before the request is built.
    await assert.rejects(
      () => provider.getSession("", {}),
      /requires a valid sessionId/,
      "a plain call with no id is still a programming error"
    );

    const res = await provider.getSession("", { customUrl: "https://example.invalid/sources", dryRun: true });
    assert.ok(res, "a customUrl call is a legitimate shape and must not throw");
  });
});
