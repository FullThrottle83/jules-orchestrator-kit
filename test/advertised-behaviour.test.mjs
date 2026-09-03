import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { scaffoldTddTest } from "../src/ops/tdd-generator.mjs";
import { isDagTaskFile } from "../src/dag-engine.mjs";
import { isTaskFile } from "../src/engine.mjs";
import { runMutationTest } from "../src/mutation.mjs";
import { COMMAND_REGISTRY } from "../src/ops/command-registry.mjs";

/** A git repository whose stack is decided by the manifest written into it. */
function repoWith(files) {
  const dir = mkdtempSync(join(tmpdir(), "jok-adv-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

describe("a generated TDD oracle is written in the runner's language", () => {
  it("emits pytest for a Python project, not a Node file pytest cannot collect", () => {
    const dir = repoWith({ "pyproject.toml": '[project]\nname = "demo"\n' });
    try {
      const res = scaffoldTddTest({ title: "parse-eof", spec: "Handle EOF cleanly" }, { root: dir });
      assert.equal(res.stack, "python");
      assert.match(res.relativePath, /\.py$/);
      assert.match(res.testCmdStr, /^pytest /);

      const body = readFileSync(res.filePath, "utf-8");
      assert.match(body, /^def test_tdd_oracle_parse_eof\(\):/m);
      assert.match(body, /assert is_implemented/);
      assert.ok(body.includes(res.redMarker), "the marker proving the assertion ran must be in the file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits a Rust integration test into tests/, where cargo looks", () => {
    const dir = repoWith({ "Cargo.toml": '[package]\nname = "demo"\n' });
    try {
      const res = scaffoldTddTest({ title: "parse-eof", spec: "Handle EOF" }, { root: dir });
      assert.equal(res.stack, "cargo");
      assert.match(res.relativePath, /^tests\/.*\.rs$/);
      assert.match(res.testCmdStr, /^cargo test --test /);
      assert.match(readFileSync(res.filePath, "utf-8"), /#\[test\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still emits a node:test file when the stack is a Node one", () => {
    const dir = repoWith({ "package.json": '{"name":"d","version":"1.0.0","scripts":{"test":"node --test"}}' });
    try {
      const res = scaffoldTddTest({ title: "parse-eof", spec: "Handle EOF" }, { root: dir });
      assert.match(res.relativePath, /\.test\.mjs$/);
      assert.match(res.testCmdStr, /^node --test /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries a marker so a run that never collected the file cannot pass as RED", () => {
    const dir = repoWith({ "pyproject.toml": '[project]\nname = "demo"\n' });
    try {
      const res = scaffoldTddTest({ title: "x-y", spec: "s" }, { root: dir });
      // pytest exits 4 on a file it cannot collect. Without this marker the
      // cycle read any non-zero exit as a verified failing test.
      assert.ok(res.redMarker && res.redMarker.length > 10);
      assert.ok(readFileSync(res.filePath, "utf-8").includes(res.redMarker));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the queue counts what the runner can actually run", () => {
  it("recognises the JSON and .task envelopes the DAG runner accepts", () => {
    assert.equal(isDagTaskFile("task-a.json", '{"id":"task-a","prompt":"do a thing"}', isTaskFile), true);
    assert.equal(isDagTaskFile("task-b.task", "anything", isTaskFile), true);
    assert.equal(isDagTaskFile("notes.txt", "x", isTaskFile), false);
  });

  it("is reachable from outside the module, which is what the CLI needed", () => {
    // It was module-private, so `agentctl queue --dag` gated on the
    // Markdown-only filter and reported "0 queued task(s)" for a queue full of
    // JSON envelopes the runner understood perfectly well.
    assert.equal(typeof isDagTaskFile, "function");
  });
});

describe("a score is only reported when something was measured", () => {
  it("reports no score rather than 100% when the diff has nothing to mutate", () => {
    const dir = repoWith({ "package.json": '{"name":"d","version":"1.0.0"}' });
    try {
      // Added lines with no comparison, boolean or arithmetic operator to invert.
      const diff = [
        "diff --git a/src/service.mjs b/src/service.mjs",
        "--- /dev/null",
        "+++ b/src/service.mjs",
        "@@ -0,0 +1,3 @@",
        "+export function record(a, e) {",
        "+  a.events.push(e);",
        "+}",
      ].join("\n");

      const report = runMutationTest({ root: dir, diffStr: diff, testCmd: "true", minScore: 80 });
      assert.equal(report.totalMutants, 0);
      assert.equal(report.scored, false);
      assert.equal(report.mutationScore, null, "100% of nothing is not a score");
      assert.match(report.reason, /nothing to falsify/i);
      assert.equal(report.ok, true, "an unfalsifiable diff has not failed to be falsified");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("swarm is documented as the dispatcher it is", () => {
  it("declares that it mutates and lists the flags it honours", () => {
    const swarm = COMMAND_REGISTRY.find((c) => c.id === "swarm");
    assert.ok(swarm);
    assert.equal(swarm.mutates, true, "swarm dispatches every queued task and spends budget");
    assert.notEqual(swarm.risk, "low");
    const flags = swarm.flags.map((f) => f.name);
    for (const expected of ["concurrency", "dry-run", "json"]) {
      assert.ok(flags.includes(expected), `--${expected} is real and must be documented`);
    }
    assert.equal(flags.includes("interactive"), false, "there is no interactive swarm dashboard");
  });

  it("emits JSON and writes nothing on a rehearsal", () => {
    const dir = repoWith({
      "package.json": '{"name":"d","version":"1.0.0","type":"module","scripts":{"test":"node --test"}}',
    });
    try {
      mkdirSync(join(dir, ".agent", "jules-queue"), { recursive: true });
      const out = execFileSync(
        "node",
        [join(process.cwd(), "bin", "agentctl.mjs"), "swarm", "--json", "--dry-run"],
        { cwd: dir, encoding: "utf-8", stdio: "pipe" }
      );
      const parsed = JSON.parse(out);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.dryRun, true, "the flag was parsed by nothing before this");
      assert.equal(existsSync(join(dir, ".agent", "jules-queue", "completed")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a brand-new file is not invisible to the gates that judge it", () => {
  function repoWithUntracked(name, content) {
    const dir = repoWith({ "package.json": '{"name":"d","version":"1.0.0","type":"module"}' });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
    writeFileSync(join(dir, name), content);
    return dir;
  }

  it("gives an untracked file a real hunk header", async () => {
    const { diffText } = await import("../src/git.mjs");
    const dir = repoWithUntracked("index.mjs", "export function isValid(n) {\n  return n > 0;\n}\n");
    try {
      const diff = diffText(dir, "main", "working-tree");
      assert.match(diff, /^@@ -0,0 \+1,\d+ @@$/m, "without it, nothing downstream can place the added lines");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets the mutation harness reach a new file", async () => {
    const { diffText } = await import("../src/git.mjs");
    const { generateDiffMutants } = await import("../src/mutation.mjs");
    const dir = repoWithUntracked("index.mjs", "export function isValid(n) {\n  return n > 0;\n}\n");
    try {
      const mutants = generateDiffMutants(diffText(dir, "main", "working-tree"), dir);
      assert.ok(mutants.length > 0, "a new file is exactly where untested code arrives");
      assert.ok(mutants.some((m) => m.file === "index.mjs" && m.line === 2));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets diff coverage reach a new file", async () => {
    const { diffText } = await import("../src/git.mjs");
    const { extractAddedLinesFromDiff } = await import("../src/coverage.mjs");
    const dir = repoWithUntracked("index.mjs", "export function isValid(n) {\n  return n > 0;\n}\n");
    try {
      const added = extractAddedLinesFromDiff(diffText(dir, "main", "working-tree"));
      assert.deepEqual(added.get("index.mjs"), [1, 2, 3, 4]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a threshold of zero is a threshold", () => {
  it("honours --min-score 0 instead of falling back to the default", () => {
    const dir = repoWith({ "package.json": '{"name":"d","version":"1.0.0","type":"module"}' });
    try {
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: dir });
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], { cwd: dir });
      writeFileSync(join(dir, "index.mjs"), "export function isValid(n) {\n  return n > 0;\n}\n");

      // `Number(x) || 80` swallowed the zero, so the documented way to run the
      // harness for its report without a threshold quietly enforced 80.
      const out = execFileSync(
        "node",
        [join(process.cwd(), "bin", "agentctl.mjs"), "mutate", "--json", "--min-score", "0"],
        { cwd: dir, encoding: "utf-8", stdio: "pipe" }
      );
      const parsed = JSON.parse(out);
      assert.equal(parsed.minScore, 0);
      assert.equal(parsed.ok, true, "nothing can be below a floor of zero");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
