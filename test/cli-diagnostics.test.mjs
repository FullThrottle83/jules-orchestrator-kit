import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const CLI = fileURLToPath(new URL("../bin/agentctl.mjs", import.meta.url));

/** A repo with a committed baseline and a verify command that exits 3. */
function repoWithFailingTest(stderrLines) {
  const dir = mkdtempSync(join(tmpdir(), "jules-cli-diag-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "d", version: "1.0.0", type: "module", scripts: { test: "node fail.mjs" } }, null, 2),
    "utf-8"
  );
  // A file rather than an inline `node -e`, so the assertion text survives one
  // level of JSON escaping instead of three.
  writeFileSync(join(dir, "fail.mjs"), `console.error(${JSON.stringify(stderrLines)});\nprocess.exit(3);\n`, "utf-8");
  writeFileSync(join(dir, "src.js"), "export const a = 1;\n", "utf-8");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: dir });
  spawnSync("node", [CLI, "init"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "agent config"], { cwd: dir });
  writeFileSync(join(dir, "src.js"), "export const a = 2;\n", "utf-8");
  return dir;
}

const run = (dir, args) => spawnSync("node", [CLI, ...args], { cwd: dir, encoding: "utf-8" });

test("a failed verify phase says what broke", async (t) => {
  await t.test("prints the stage, exit code, command and captured output", () => {
    // VERIFY is the only gate phase whose failure the operator has to fix in
    // their own code, and it was the only one that printed nothing but "FAIL".
    const dir = repoWithFailingTest("AssertionError: expected 2 to equal 1");
    try {
      const res = run(dir, ["gate"]);
      const out = res.stdout + res.stderr;
      assert.equal(res.status, 4);
      assert.match(out, /Phase \[VERIFY\] : ❌ FAIL/);
      assert.match(out, /Stage: unit \(exit 3\)/);
      assert.match(out, /Command: npm test/);
      assert.match(out, /AssertionError: expected 2 to equal 1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("carries the same diagnostics into --json", () => {
    const dir = repoWithFailingTest("boom: the oracle disagreed");
    try {
      const res = run(dir, ["gate", "--json"]);
      const verify = JSON.parse(res.stdout).phases.find((p) => p.phase === "verify");
      assert.equal(verify.ok, false);
      assert.equal(verify.failure.exitCode, 3);
      assert.equal(verify.failure.stageId, "unit");
      assert.match(verify.failure.stderr, /boom: the oracle disagreed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("caps a runaway output instead of flooding the terminal", () => {
    const dir = repoWithFailingTest(Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"));
    try {
      const out = run(dir, ["gate"]).stdout;
      // 202, not 200: the runner's own two banner lines land on stdout, and
      // both streams are now shown rather than stderr silently winning. They
      // are prefixed to stderr's 200 so the surviving tail is still the failure.
      assert.match(out, /last 20 of 202 lines/);
      assert.match(out, /line 199/, "the tail is what matters, so it must be the end that survives");
      assert.doesNotMatch(out, /line 100\b/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("does not offer --fix as a remedy to a run that already used it", () => {
    const dir = repoWithFailingTest("still broken");
    try {
      const out = run(dir, ["gate", "--fix"]).stdout;
      assert.doesNotMatch(out, /pass: agentctl gate --fix/);
      // Exit 4 has two distinct causes and they must not be told as one story:
      // the agent ran and could not fix it, or the provider refused the
      // dispatch and the agent never ran. Which applies here depends on whether
      // this machine's provider is usable, so accept either — but require that
      // whichever it is actually explains itself.
      assert.match(out, /OODA Repair Exhausted|the repair agent never ran/);
      if (/the repair agent never ran/.test(out)) {
        assert.match(out, /Provider error: /, "a dispatch that never happened must say why");
        assert.match(out, /agentctl providers/, "and point at the command that diagnoses it");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("a dry run is distinguishable from a dispatch", async (t) => {
  await t.test("does not claim a session that was never created", () => {
    const dir = repoWithFailingTest("unused");
    try {
      const env = { ...process.env, JULES_API_KEY: "test-key", JULES_REPO: "owner/repo" };
      const res = spawnSync("node", [CLI, "dispatch", "--dry-run", "-p", "Rename slugify in src.js. Verify with: npm test"], {
        cwd: dir,
        env,
        encoding: "utf-8",
      });
      const out = res.stdout + res.stderr;
      assert.equal(res.status, 0);
      assert.match(out, /Dry Run — nothing was dispatched/);
      assert.doesNotMatch(out, /Dispatched Successfully/);
      assert.doesNotMatch(out, /dry-run-session-id/, "a placeholder id must not be presented as a real one");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("every command that takes a prompt takes it the same three ways", async (t) => {
  const forms = [
    { name: "positional", args: (p) => [p] },
    { name: "--prompt", args: (p) => ["--prompt", p] },
    { name: "-p", args: (p) => ["-p", p] },
  ];
  const PROMPT = "Rename slugify to toSlug in src.js. Verify with: npm test";

  for (const form of forms) {
    await t.test(`task create accepts the prompt as ${form.name}`, () => {
      // `task create "do the thing"` used to report a missing prompt while
      // holding one, because only --prompt was wired up.
      const dir = repoWithFailingTest("unused");
      try {
        const res = run(dir, ["task", "create", "--title", "T", ...form.args(PROMPT)]);
        assert.equal(res.status, 0, res.stdout + res.stderr);
        assert.match(res.stdout, /Task synthesized & queued/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await t.test(`task optimize accepts the prompt as ${form.name}`, () => {
      // The mirror image: `task optimize --prompt "..."` silently scored an
      // empty string, because only the positional was wired up. `--fix` echoes
      // the prompt into its output, which is what makes the difference visible.
      const dir = repoWithFailingTest("unused");
      try {
        const res = run(dir, ["task", "optimize", "--fix", ...form.args("shave 200ms off the slug builder")]);
        assert.equal(res.status, 0, res.stdout + res.stderr);
        assert.match(res.stdout, /shave 200ms off the slug builder/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  await t.test("--prompt-file works on task create, not just dispatch", () => {
    const dir = repoWithFailingTest("unused");
    try {
      const promptPath = join(dir, "prompt.txt");
      writeFileSync(promptPath, PROMPT, "utf-8");
      const res = run(dir, ["task", "create", "--title", "T", "--prompt-file", promptPath]);
      assert.equal(res.status, 0, res.stdout + res.stderr);
      const queued = readFileSync(join(dir, ".agent/jules-queue", res.stdout.match(/(TASK-[\w-]+)\.md/)[1] + ".md"), "utf-8");
      assert.match(queued, /toSlug/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("a prompt file that is not there is an error, not an empty prompt", () => {
    const dir = repoWithFailingTest("unused");
    try {
      const res = run(dir, ["dispatch", "--prompt-file", join(dir, "nope.txt")]);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /prompt file not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
