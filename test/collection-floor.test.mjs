import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseCollectedTests, checkCollectionFloor } from "../src/ops/test-collection.mjs";

/**
 * The gate's oracle is one number: the verification command's exit code. It
 * cannot tell "every test passed" from "there were no tests", and several
 * runners report the second as success by design. A repository could invert a
 * function, add an untested one, and collect five green phases.
 */

const CLI = fileURLToPath(new URL("../bin/agentctl.mjs", import.meta.url));

describe("a stated zero is a zero", () => {
  const zeros = [
    ["pytest, nothing collected", "collected 0 items\n\nno tests ran in 0.01s"],
    ["jest --passWithNoTests", "No tests found, exiting with code 0"],
    ["vitest, no files", "No test files found, exiting with code 0"],
    ["cargo, empty target", "running 0 tests\ntest result: ok. 0 passed"],
    ["mocha, nothing", "  0 passing (1ms)"],
    ["go, every package without tests", "?   example.com/app\t[no test files]\n?   example.com/lib\t[no test files]"],
  ];

  for (const [name, output] of zeros) {
    it(name, () => {
      assert.equal(parseCollectedTests(output, "").count, 0);
    });
  }
});

describe("a run that did something is never read as zero", () => {
  const nonZero = [
    ["node:test, spec reporter", "ℹ tests 957\nℹ pass 957", 957],
    ["node:test, tap", "# tests 42\n# pass 42", 42],
    ["pytest", "collected 12 items\n\n12 passed in 0.3s", 12],
    ["cargo", "running 7 tests\ntest result: ok. 7 passed", 7],
    ["jest", "Tests:       3 passed, 3 total", 3],
    ["mocha", "  12 passing (30ms)", 12],
    ["go, verbose", "--- PASS: TestAdd (0.00s)\n--- PASS: TestSub (0.00s)\nok  \texample.com/lib\t0.004s", 2],
  ];

  for (const [name, output, expected] of nonZero) {
    it(name, () => {
      assert.equal(parseCollectedTests(output, "").count, expected);
    });
  }

  it("go without -v states no count, which is not a count of zero", () => {
    // `--- PASS:` lines only appear under -v. Reading their absence as zero
    // would have failed every ordinary `go test ./...` in existence.
    assert.equal(parseCollectedTests("ok  \texample.com/lib\t0.004s", "").count, null);
  });

  it("a Go monorepo where only some packages have tests is healthy", () => {
    const mixed = "?   example.com/app\t[no test files]\nok  \texample.com/lib\t0.004s";
    assert.notEqual(parseCollectedTests(mixed, "").count, 0);
  });
});

describe("silence is not a finding", () => {
  it("an unrecognised runner yields no count and no failure", () => {
    const res = parseCollectedTests("Everything is fine, boss.", "");
    assert.equal(res.count, null);
    assert.equal(checkCollectionFloor({ ok: true, stdout: "Everything is fine, boss." }).ok, true);
  });

  it("empty output yields no count", () => {
    assert.equal(parseCollectedTests("", "").count, null);
  });

  it("a failing command is left to fail on its own terms", () => {
    // Only a *passing* command can lie about having verified something.
    const res = checkCollectionFloor({ ok: false, stdout: "collected 0 items" });
    assert.equal(res.ok, true);
  });

  it("verify.minTests: 0 opts out", () => {
    assert.equal(checkCollectionFloor({ ok: true, stdout: "collected 0 items" }, { minTests: 0 }).ok, true);
  });

  it("the floor is 1 by default and names the runner", () => {
    const res = checkCollectionFloor({ ok: true, stdout: "collected 0 items" });
    assert.equal(res.ok, false);
    assert.equal(res.count, 0);
    assert.equal(res.runner, "pytest");
    assert.match(res.reason, /verify\.required: false/);
  });
});

describe("the gate refuses to approve against nothing", () => {
  function repo(testScriptBody) {
    const dir = mkdtempSync(join(tmpdir(), "jok-floor-"));
    const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: "pipe" });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(dir, ".gitignore"), ".agent/\n");
    writeFileSync(join(dir, "index.js"), "export function add(a, b) { return a + b; }\n");

    const runner = join(dir, "runner.sh");
    writeFileSync(runner, `#!/bin/sh\n${testScriptBody}\nexit 0\n`);
    chmodSync(runner, 0o755);

    mkdirSync(join(dir, ".agent"), { recursive: true });
    writeFileSync(join(dir, ".agent", "config.yml"), 'version: 1\nverify:\n  test: "./runner.sh"\n');
    git(["add", "-A"]);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);

    // Break the code, so the only thing standing between this and APPROVED is
    // whether the gate notices that nothing was tested.
    writeFileSync(join(dir, "index.js"), "export function add(a, b) { return a - b; }\n");
    return dir;
  }

  const run = (dir) => spawnSync(process.execPath, [CLI, "check", "--mode", "working-tree"], { cwd: dir, encoding: "utf-8" });

  it("rejects a runner that exits 0 having collected nothing", { skip: process.platform === "win32" }, () => {
    const dir = repo('echo "?   example.com/app\t[no test files]"');
    try {
      const res = run(dir);
      assert.equal(res.status, 4, `expected a verification failure, got ${res.status}:\n${res.stdout}`);
      assert.match(res.stdout, /empty-suite/);
      assert.match(res.stdout, /without running any tests/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("approves the same change when the runner did run tests", { skip: process.platform === "win32" }, () => {
    const dir = repo('echo "ok  \texample.com/app\t0.004s"');
    try {
      assert.equal(run(dir).status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
