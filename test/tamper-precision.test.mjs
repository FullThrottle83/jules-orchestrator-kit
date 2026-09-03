import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  checkTestTampering,
  resolveAllowedTamperKinds,
  TAMPER_KIND_NAMES,
} from "../src/security.mjs";

/**
 * The expectation-rewrite check is only worth having if an operator still
 * reads it after a month. These are the two edits that fired without anything
 * having changed, and the override that answered one finding by silencing
 * five other checks nobody had looked at.
 */

const CLI = fileURLToPath(new URL("../bin/agentctl.mjs", import.meta.url));

const diff = (...body) =>
  ["--- a/test/x.test.js", "+++ b/test/x.test.js", "@@ -1,20 +1,20 @@", " context", ...body, " context"].join("\n");

const fired = (d, opts) => !checkTestTampering(d, opts).ok;

describe("edits that changed no expected value stay silent", () => {
  it("two assertions swapped round", () => {
    // Both are removed and both are added back unchanged. Positional
    // alignment matched the first removed against the first added — a
    // different assertion — and reported two rewrites for an edit that
    // rewrote nothing.
    assert.equal(
      fired(diff("-assert.equal(f(1), 1);", "-assert.equal(f(2), 2);", "+assert.equal(f(2), 2);", "+assert.equal(f(1), 1);")),
      false
    );
  });

  it("an assertion that merely moved within its block", () => {
    assert.equal(
      fired(diff("-assert.equal(f(1), 1);", "-assert.equal(g(), true);", "+assert.equal(g(), true);", "+assert.equal(f(1), 1);")),
      false
    );
  });

  it("a failure message reworded", () => {
    assert.equal(
      fired(diff('-assert.equal(f(1), 1, "should be one");', '+assert.equal(f(1), 1, "must be one");')),
      false
    );
  });

  it("a Go format string reworded", () => {
    assert.equal(
      fired(diff('-\tt.Errorf("got %d want %d", got, 3)', '+\tt.Errorf("got=%d want=%d", got, 3)')),
      false
    );
  });

  it("pure re-indentation of a block of same-shape assertions", () => {
    assert.equal(
      fired(diff("-  assert.equal(f(0), 0);", "-  assert.equal(f(1), 1);", "+    assert.equal(f(0), 0);", "+    assert.equal(f(1), 1);")),
      false
    );
  });
});

describe("edits that did change one still fire", () => {
  it("a numeric expectation", () => {
    assert.equal(fired(diff("-assert.equal(add(1, 2), 3);", "+assert.equal(add(1, 2), -1);")), true);
  });

  it("a string expectation — the last argument of two is a value, not a message", () => {
    assert.equal(fired(diff('-assert.equal(name(), "Alice");', '+assert.equal(name(), "Bob");')), true);
  });

  it("a value and its message together", () => {
    assert.equal(fired(diff('-assert.equal(f(1), 1, "one");', '+assert.equal(f(1), 9, "nine");')), true);
  });

  it("a Go table's want value, with the format string untouched", () => {
    assert.equal(fired(diff('-\tt.Errorf("got %d want %d", got, 3)', '+\tt.Errorf("got %d want %d", got, 999)')), true);
  });

  it("one of two swapped assertions also rewritten", () => {
    assert.equal(
      fired(diff("-assert.equal(f(1), 1);", "-assert.equal(f(2), 2);", "+assert.equal(f(2), 2);", "+assert.equal(f(1), 7);")),
      true,
      "cancelling identical pairs must not cancel the one that changed"
    );
  });
});

describe("an override answers one finding, not six", () => {
  const mixed = diff("-assert.equal(add(1, 2), 3);", "+assert.equal(add(1, 2), -1);", '+it.skip("other", () => {});');

  it("names every kind it accepts", () => {
    assert.deepEqual(TAMPER_KIND_NAMES, ["commented", "expectation", "removal", "skip", "vacuous", "weakening"]);
  });

  it("allowing one kind leaves the others reporting", () => {
    const types = checkTestTampering(mixed, { allowTestChanges: "expectation" }).violations.map((v) => v.type);
    assert.deepEqual(types, ["TEST_SKIP_INJECTION"], "the skip nobody looked at must survive the override");
  });

  it("accepts a list, in either spelling", () => {
    assert.equal(checkTestTampering(mixed, { allowTestChanges: "expectation,skip" }).ok, true);
    assert.equal(checkTestTampering(mixed, { allowTestChanges: ["expectation", "skip"] }).ok, true);
  });

  it("the blunt form still turns everything off", () => {
    assert.equal(checkTestTampering(mixed, { allowTestModifications: true }).ok, true);
    assert.equal(checkTestTampering(mixed, { allowTestChanges: "all" }).ok, true);
  });

  it("reports a kind name it does not recognise rather than guessing", () => {
    const res = resolveAllowedTamperKinds({ allowTestChanges: "expecation" });
    assert.deepEqual(res.unknown, ["expecation"]);
    assert.equal(res.kinds.size, 0);
    assert.equal(checkTestTampering(mixed, { allowTestChanges: "expecation" }).ok, false, "a typo must not silence anything");
  });

  it("the violation names the narrow flag, not the blunt one", () => {
    const reason = checkTestTampering(mixed).violations.find((v) => v.type === "ASSERTION_EXPECTATION_CHANGED").reason;
    assert.match(reason, /--allow-test-change expectation/);
    assert.doesNotMatch(reason, /re-run with --allow-test-modifications/);
  });
});

describe("the flag reaches the gate", () => {
  it("silences only the expectation check end to end", () => {
    const dir = mkdtempSync(join(tmpdir(), "jok-tamper-"));
    try {
      const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: "pipe" });
      git(["init", "-q", "-b", "main"]);
      git(["config", "user.email", "t@t"]);
      git(["config", "user.name", "t"]);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "v", version: "1.0.0", type: "module", scripts: { test: "node --test" } }));
      writeFileSync(join(dir, ".gitignore"), ".agent/\n");
      writeFileSync(join(dir, "index.js"), "export function add(a, b) { return a + b; }\n");
      mkdirSync(join(dir, "test"), { recursive: true });
      const suite = (want) =>
        `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../index.js";\ntest("add", () => { assert.equal(add(1, 2), ${want}); });\n`;
      writeFileSync(join(dir, "test", "index.test.js"), suite(3));
      git(["add", "-A"]);
      git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);

      writeFileSync(join(dir, "index.js"), "export function add(a, b) { return a - b; }\n");
      writeFileSync(join(dir, "test", "index.test.js"), suite(-1));

      const run = (extra) => spawnSync(process.execPath, [CLI, "check", "--mode", "working-tree", ...extra], { cwd: dir, encoding: "utf-8" });

      assert.equal(run([]).status, 6, "the rewrite must be rejected without a flag");
      assert.equal(run(["--allow-test-change", "expectation"]).status, 0);
      assert.equal(run(["--allow-test-change", "removal"]).status, 6, "the wrong kind must not silence it");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
