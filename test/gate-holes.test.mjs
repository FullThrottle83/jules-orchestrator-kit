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

const git = (dir, args) => execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: "pipe" });
const commit = (dir, msg) => {
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", msg]);
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
