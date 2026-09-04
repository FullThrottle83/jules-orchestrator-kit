import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseCollectedTests } from "../src/ops/test-collection.mjs";
import { oracleCandidates } from "../src/stack-detector.mjs";
import { COUNTED_RUN_CANARIES, EMPTY_RUN_CANARIES } from "../src/guard-policy.mjs";

/**
 * A cold-start trial on four repositories nobody here chose found four
 * failures that every internal signal had missed, because every internal
 * signal was measured in a repository already set up by someone who knew
 * how the tool worked. These are those four.
 */

const CLI = fileURLToPath(new URL("../bin/agentctl.mjs", import.meta.url));
const win = process.platform === "win32";

/** A repository with a real `origin`, because that is what users have. */
function repoWithOrigin() {
  const dir = mkdtempSync(join(tmpdir(), "jok-firsthour-"));
  const origin = join(dir, "origin.git");
  const work = join(dir, "work");
  execFileSync("git", ["init", "-q", "--bare", origin], { stdio: "pipe" });
  execFileSync("git", ["clone", "-q", origin, work], { stdio: "pipe" });
  const git = (args) => execFileSync("git", args, { cwd: work, encoding: "utf-8", stdio: "pipe" });
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  mkdirSync(join(work, "test"), { recursive: true });
  writeFileSync(join(work, "index.mjs"), "export const add = (a, b) => a + b;\n");
  writeFileSync(
    join(work, "test", "calc.test.mjs"),
    'import assert from "node:assert";\nimport { test } from "node:test";\nimport { add } from "../index.mjs";\ntest("adds", () => assert.equal(add(1, 2), 3));\n'
  );
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0", scripts: { test: "node --test" } }));
  git(["add", "-A"]);
  git(["commit", "-qm", "initial"]);
  git(["branch", "-M", "main"]);
  git(["push", "-q", "origin", "main"]);
  return { dir, work, git };
}

const run = (cwd, args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf-8" });

describe("the first hour: init, commit, gate", () => {
  it("the README quickstart approves on a clean repository", { skip: win, timeout: 90_000 }, () => {
    // Measured before the fix: Exit 3, five scope violations, and a hint
    // advising --allow-protected — so a newcomer's first lesson was how to
    // switch the scope guard off. `init` writes `.agent/**` and tells the
    // user to commit it; the base branch does not have that commit yet, and
    // every scaffolded path is protected or denied.
    const { dir, work, git } = repoWithOrigin();
    try {
      run(work, ["init", "--yes"]);
      git(["add", "-A"]);
      git(["commit", "-qm", "chore: add agent config"]);
      const res = run(work, ["check"]);
      assert.equal(res.status, 0, `the quickstart must not reject its own output:\n${res.stdout}`);
      assert.match(res.stdout, /Setup: accepted \d+ gate scaffold file/, "and it must say what it accepted, not accept it silently");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still blocks an edit to the policy once the repository is under the gate", { skip: win, timeout: 90_000 }, () => {
    const { dir, work, git } = repoWithOrigin();
    try {
      run(work, ["init", "--yes"]);
      git(["add", "-A"]);
      git(["commit", "-qm", "chore: add agent config"]);
      git(["push", "-q", "origin", "main"]);

      writeFileSync(join(work, ".agent", "config.yml"), 'version: 1\nverify:\n  test: "true"\n');
      const res = run(work, ["check"]);
      assert.equal(res.status, 3, "an agent must not be able to edit the rules it is governed by");
      assert.match(res.stdout, /\.agent\/config\.yml \(Rule: protect\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not extend the exemption to anything that is not scaffold", { skip: win, timeout: 90_000 }, () => {
    // Every violating path must be scaffold, or the whole diff is judged
    // normally. Otherwise the bootstrap case becomes a way to smuggle a
    // workflow change past the gate.
    const { dir, work } = repoWithOrigin();
    try {
      run(work, ["init", "--yes"]);
      mkdirSync(join(work, ".github", "workflows"), { recursive: true });
      writeFileSync(join(work, ".github", "workflows", "ci.yml"), "on: push\n");
      const res = run(work, ["check"]);
      assert.equal(res.status, 3);
      assert.match(res.stdout, /\.github\/workflows\/ci\.yml \(Rule: deny\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a stated count outranks a phrase that resembles one", () => {
  for (const c of COUNTED_RUN_CANARIES) {
    it(`${c.id} is not read as empty — ${c.why}`, () => {
      const n = parseCollectedTests(c.output, "").count;
      assert.ok(n !== null && n >= c.atLeast, `read as ${n}`);
    });
  }

  for (const c of EMPTY_RUN_CANARIES) {
    it(`${c.id} still reads as zero`, () => {
      assert.equal(parseCollectedTests(c.output, "").count, 0);
    });
  }

  it("TAP's numbered ok lines are not Go's package summaries", () => {
    // `^ok\s` matched both `ok 1 - performance` and `ok  example.com/lib`,
    // so a 190-test TAP suite was classified as Go with no stated count.
    assert.equal(parseCollectedTests("ok 1 - performance # SKIP\n1..191\n# tests 191\n# pass 190", "").count, 191);
    assert.equal(parseCollectedTests("ok  \texample.com/lib\t0.004s", "").runner, "go");
  });
});

describe("init does not save a command it just watched fail", () => {
  it("offers the ecosystem's other conventions, best first", () => {
    const dir = mkdtempSync(join(tmpdir(), "jok-oracle-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", scripts: { test: "vitest run" } }));
      writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "x"\n');
      const cands = oracleCandidates(dir, "make test");
      assert.equal(cands[0], "make test", "detection's choice is always tried first");
      assert.ok(cands.includes("npm test"));
      assert.ok(cands.includes("cargo test"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never offers a placeholder as a fallback oracle", () => {
    const dir = mkdtempSync(join(tmpdir(), "jok-oracle2-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", scripts: { test: "echo 'no tests yet' && exit 0" } }));
      assert.ok(!oracleCandidates(dir, "make test").includes("npm test"), "a script that runs nothing is not a recovery");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("probes on the headless path too", { skip: win, timeout: 90_000 }, () => {
    // `--yes` means "do not ask me", not "do not check". The probe used to
    // live inside the interactive branch, so the user who was not watching —
    // the only one who cannot notice — got the broken command written in.
    const dir = mkdtempSync(join(tmpdir(), "jok-probe-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "pipe" });
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(join(dir, "index.mjs"), "export const add = (a, b) => a + b;\n");
      writeFileSync(
        join(dir, "test", "c.test.mjs"),
        'import assert from "node:assert";\nimport { test } from "node:test";\nimport { add } from "../index.mjs";\ntest("adds", () => assert.equal(add(1, 2), 3));\n'
      );
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "d", version: "1.0.0", scripts: { test: "node --test" } }));
      writeFileSync(join(dir, "Makefile"), '.PHONY: build test\nbuild:\n\t@echo building\ntest:\n\t@echo cannot && exit 2\n');
      const res = run(dir, ["init", "--yes"]);
      assert.match(res.stdout, /Verification Test Command\s*:\s*"npm test"/, `init kept a command it measured as broken:\n${res.stdout}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the remediation the tool prints has to work", () => {
  it("verify.minTests reaches the collection floor", { skip: win, timeout: 90_000 }, () => {
    // The empty-suite failure told the operator to "lower the floor with
    // verify.minTests". `trustedVerify` copied thirteen fields and not that
    // one, so the setting was dropped and the floor stayed at 1 — the hint
    // named a lever that was not connected to anything.
    const { dir, work, git } = repoWithOrigin();
    try {
      const runner = join(work, "runner.sh");
      writeFileSync(runner, '#!/bin/sh\necho "collected 0 items"\nexit 0\n');
      chmodSync(runner, 0o755);
      mkdirSync(join(work, ".agent"), { recursive: true });
      writeFileSync(join(work, ".agent", "config.yml"), 'version: 1\nverify:\n  test: "./runner.sh"\n');
      git(["add", "-A"]);
      git(["commit", "-qm", "chore: config"]);
      git(["push", "-q", "origin", "main"]);

      writeFileSync(join(work, "index.mjs"), "export const add = (a, b) => a - b;\n");
      assert.equal(run(work, ["check"]).status, 4, "a runner that collected nothing must fail by default");

      writeFileSync(join(work, ".agent", "config.yml"), 'version: 1\nverify:\n  test: "./runner.sh"\n  minTests: 0\n');
      git(["add", "-A"]);
      git(["commit", "-qm", "chore: minTests 0"]);
      git(["push", "-q", "origin", "main"]);
      writeFileSync(join(work, "index.mjs"), "export const add = (a, b) => a - b;\n");

      const res = run(work, ["check"]);
      assert.equal(res.status, 0, `the documented opt-out must actually opt out:\n${res.stdout}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
