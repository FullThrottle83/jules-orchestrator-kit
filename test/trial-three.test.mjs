import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkTestTampering } from "../src/security.mjs";
import { runCmd } from "../src/git.mjs";
import { isPlaceholderTestScript } from "../src/stack-detector.mjs";
import { parseCollectedTests } from "../src/ops/test-collection.mjs";

/**
 * A third cold-start trial. Everything here is a case where the shipped gate
 * gave an answer it had not earned, and every one of them was measured
 * against the release before it was changed.
 *
 * The two that matter most share a shape: the guard recognised a line as an
 * assertion, counted it in its denominator, and then reported PASS without
 * ever reading the value being asserted. A denominator is not evidence if the
 * things counted in it were not understood.
 */

const oneLine = (file, before, after) =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1,1 +1,1 @@",
    `-${before}`,
    `+${after}`,
  ].join("\n");

const typesOf = (diff) => (checkTestTampering(diff).violations || []).map((v) => v.type);

describe("expected value first is still an expected value", () => {
  // `messageArgIndices` treated a string in argument 0 of any two-or-more
  // argument assertion as prose for a human. JUnit and PHPUnit document the
  // opposite order, so every Java and PHP repository had no protection at all
  // against a rewritten string expectation.
  const cases = [
    ["JUnit assertEquals", "src/test/java/CalcTest.java", '        assertEquals("Hello World", out);', '        assertEquals("Hello Tampered", out);'],
    ["TestNG assertEquals", "src/test/java/CalcTest.java", '        assertEquals("ok", status);', '        assertEquals("nope", status);'],
    ["PHPUnit assertSame", "tests/CalcTest.php", '        $this->assertSame("Hello World", $out);', '        $this->assertSame("Hello Tampered", $out);'],
    ["unittest assertIn", "tests/test_cli.py", '        self.assertIn("Hello World", result.output)', '        self.assertIn("Hello Tampered", result.output)'],
    ["unittest assertNotIn", "tests/test_cli.py", '        self.assertNotIn("error", result.output)', '        self.assertNotIn("zzz", result.output)'],
    ["node assert.equal", "test/cli.test.js", '  assert.equal("Hello World", out);', '  assert.equal("Hello Tampered", out);'],
  ];

  for (const [name, file, before, after] of cases) {
    it(`${name} — a rewritten expectation is reported`, () => {
      assert.deepEqual(typesOf(oneLine(file, before, after)), ["ASSERTION_EXPECTATION_CHANGED"]);
    });
  }

  it("JUnit 4's message-first form is still read as a message", () => {
    // The one dialect that really does put prose first. It is distinguishable
    // because its trailing argument is the actual value, not a message — and
    // that distinction is the whole reason the rule above is safe.
    const diff = oneLine(
      "src/test/java/CalcTest.java",
      '        assertEquals("why", expected, out);',
      '        assertEquals("why this matters", expected, out);'
    );
    assert.deepEqual(typesOf(diff), []);
  });

  it("a reworded trailing message is still read as a message", () => {
    const diff = oneLine("tests/test_cli.py", '        self.assertEqual(a, b, "old note")', '        self.assertEqual(a, b, "new note")');
    assert.deepEqual(typesOf(diff), []);
  });
});

describe("a regex literal is an expected value", () => {
  // Rewritten patterns normalised to two different shapes, so they never met
  // in a bucket: one specific assertion out, one in, no net loss, silence.
  const cases = [
    ["jest toMatch", "test/cli.test.js", "  expect(out).toMatch(/Hello World/);", "  expect(out).toMatch(/Hello Tampered/);"],
    ["jest toThrow", "test/cli.test.js", "  expect(fn).toThrow(/permission denied/);", "  expect(fn).toThrow(/x/);"],
    ["rspec match", "spec/cli_spec.rb", "    expect(out).to match(/Hello World/)", "    expect(out).to match(/Hello Tampered/)"],
    ["node assert.match", "test/cli.test.js", "  assert.match(out, /Hello World/);", "  assert.match(out, /Hello Tampered/);"],
  ];

  for (const [name, file, before, after] of cases) {
    it(`${name} — a rewritten pattern is reported`, () => {
      assert.deepEqual(typesOf(oneLine(file, before, after)), ["ASSERTION_EXPECTATION_CHANGED"]);
    });
  }

  it("division is not mistaken for a regex", () => {
    const diff = oneLine("test/cli.test.js", "  assert.strictEqual(total / count, 5);", "  assert.strictEqual(total / count, 6);");
    assert.deepEqual(typesOf(diff), ["ASSERTION_EXPECTATION_CHANGED"], "the 5 → 6 is the finding, and the statement still parsed");
  });
});

describe("renaming a test is not tampering", () => {
  // The multi-line form was always safe: NON_JOINING_CALL keeps a test name
  // from joining to the assertion below it. On one line the name blanked to
  // the same shape as its replacement, the two paired, and an author who
  // renamed a test was told they had rewritten an expected value.
  const renames = [
    ["node:test", "test/calc.test.js", 'test("adds", () => { assert.strictEqual(add(2, 3), 5); });', 'test("adds positives", () => { assert.strictEqual(add(2, 3), 5); });'],
    ["jest", "test/calc.spec.js", 'it("adds", () => { expect(add(2, 3)).toBe(5); });', 'it("adds two positives", () => { expect(add(2, 3)).toBe(5); });'],
    ["tap", "test/calc.test.js", 't.test("adds", (ct) => { ct.equal(add(2, 3), 5); ct.end(); });', 't.test("adds positives", (ct) => { ct.equal(add(2, 3), 5); ct.end(); });'],
    ["describe block", "test/calc.spec.js", 'describe("math", () => { it("adds", () => { expect(add(2,3)).toBe(5); }); });', 'describe("arithmetic", () => { it("adds", () => { expect(add(2,3)).toBe(5); }); });'],
  ];

  for (const [name, file, before, after] of renames) {
    it(`${name} — a pure rename produces no finding`, () => {
      assert.deepEqual(typesOf(oneLine(file, before, after)), []);
    });
  }

  it("a rename that also moves the expectation is still reported", () => {
    const diff = oneLine(
      "test/calc.test.js",
      'test("adds", () => { assert.strictEqual(add(2, 3), 5); });',
      'test("adds positives", () => { assert.strictEqual(add(2, 3), 6); });'
    );
    assert.deepEqual(typesOf(diff), ["ASSERTION_EXPECTATION_CHANGED"], "the rename must not become cover for the rewrite");
  });
});

describe("a verification command with an environment prefix runs", () => {
  // `PYTHONPATH=src python3 -m pytest` is how a large part of the Python
  // world writes its test command. execFileSync took the whole assignment as
  // the program name, and the gate reported the resulting ENOENT as a failed
  // verification — telling the user their tests broke when the command had
  // never started.
  it("peels leading assignments into the child environment", () => {
    const res = runCmd("AGENTCTL_PROBE=peeled node -p process.env.AGENTCTL_PROBE", { ignoreError: true });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, "peeled");
  });

  it("peels more than one", () => {
    const res = runCmd("A=1 B=2 node -p process.env.A+process.env.B", { ignoreError: true });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, "12");
  });

  it("does not treat a lone assignment as a command", () => {
    // Nothing left to run is still an error, and it must not be silently
    // reported as a pass.
    const res = runCmd("ONLY=assignment", { ignoreError: true });
    assert.notEqual(res.status, 0);
  });

  it("names the timeout and the way to raise it", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentctl-timeout-"));
    try {
      const script = join(dir, "slow.sh");
      writeFileSync(script, "#!/bin/sh\nsleep 5\n");
      chmodSync(script, 0o755);
      const res = runCmd(`sh ${script}`, { ignoreError: true, timeout: 300 });
      assert.equal(res.status, 124);
      assert.match(res.stderr, /timed out after 300ms/);
      assert.match(res.stderr, /verify\.timeout_ms/, "Node's own ETIMEDOUT message names neither the limit nor the knob");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("an interpreter handed an empty program is a placeholder", () => {
  // The gate blocked `true`, `echo ok` and `exit 0`, and approved
  // `node -e ""` — the same no-op with a spelling that looks like work.
  for (const cmd of ['node -e ""', "node --eval ''", 'python3 -c ""', "sh -c ''", "bash -c \"\"", "node -e"]) {
    it(`rejects ${JSON.stringify(cmd)}`, () => {
      assert.equal(isPlaceholderTestScript(cmd), true);
    });
  }

  for (const cmd of ["npm test", "node --test test/", 'node -e "require(\'./run\')"', "python3 -m pytest", "deno test"]) {
    it(`still accepts ${JSON.stringify(cmd)}`, () => {
      assert.equal(isPlaceholderTestScript(cmd), false);
    });
  }
});

describe("more runners state their count out loud", () => {
  // Every runner here used to land in the same "I could not tell" bucket as a
  // command that ran nothing. The floor stays one-sided — an unrecognised
  // runner still passes — so this only ever converts silence into an answer.
  const stated = {
    unittest: ["Ran 12 tests in 0.003s\n\nOK", 12],
    gtest: ["[==========] 12 tests from 3 test suites ran.", 12],
    catch2: ["test cases: 12 | 12 passed", 12],
    deno: ["ok | 12 passed | 0 failed (30ms)", 12],
    bun: [" 12 pass\n 0 fail", 12],
    ava: ["  12 tests passed", 12],
    tap: ["TAP version 13\nok 1 - a\nok 2 - b\n1..2", 2],
  };

  for (const [runner, [output, expected]] of Object.entries(stated)) {
    it(`reads ${runner}`, () => {
      assert.equal(parseCollectedTests(output, "").count, expected);
    });
  }

  it("an unrecognised runner is still an unknown, not a zero", () => {
    // The one-sidedness is the point: reporting zero here would hard-red every
    // correct repository whose runner is not on the list.
    assert.equal(parseCollectedTests("Everything is fine!", "").count, null);
  });
});
