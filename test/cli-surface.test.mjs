/**
 * CLI surface — the domain suite for how agentctl parses, routes and reports:
 *
 *   - command invocation and exit codes (verify phases, dry-run framing,
 *     prompt resolution across --prompt / --prompt-file / positionals);
 *   - argument parsing parity and subcommand help routing (--strict-locks,
 *     command registry descriptors);
 *   - truthful diagnostic output (waiver banners, dry-run markers, lockfile
 *     supply-chain hints, markdown/EOF hygiene);
 *   - lock plumbing diagnostics (proc/stat starttime parsing, task-file
 *     classification, envelope base SHA, runCmd buffer/timeout handling,
 *     Windows .cmd shim quoting);
 *   - offline coverage for dispatch, queue, swarm, rollback, checkpoint,
 *     retry, prune, escalate, learning and evidence — every run scrubs
 *     provider credentials, uses --dry-run or mock providers, and makes zero
 *     network calls.
 *
 * Formed in P08 by merging: cli-diagnostics, cold-start-trial-f13-f22,
 * edge-fixes, the P-07 section of critical-hardening and the P0-07 section of
 * p0-remediation, plus the new offline command-surface section.
 */
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectStackOracles } from "../src/wizard-oracle.mjs";
import { parseCollectedTests } from "../src/ops/test-collection.mjs";
import { gate } from "../src/engine.mjs";
import { COMMAND_REGISTRY, formatRegistryMarkdown, getCommandDescriptor } from "../src/ops/command-registry.mjs";
import {
  parseProcStat,
  getProcessStartTime,
  isTaskFile,
  createExecutionEnvelope,
  resolveBase,
  runCmd,
} from "../index.mjs";
import { windowsEscapeArgument, windowsEscapeCommand, resolveWindowsSpawn } from "../src/git.mjs";
import {
  createCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
  pruneCheckpoints,
  CheckpointError,
} from "../src/ops/checkpoint.mjs";
import { retrySession, pruneSessions } from "../src/session-ops.mjs";
import { loadLearnings } from "../src/memory.mjs";
import { checkDailyBudget } from "../src/state.mjs";

// ═══════════════════════════════════════════════════════════════════════════
// From: test/cli-diagnostics.test.mjs
// Moved verbatim by the P08 test consolidation; scoped to its own block.
// ═══════════════════════════════════════════════════════════════════════════
{
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

  await t.test("dispatch accepts --verify-cmd and --verify flags in dry-run", () => {
    const dir = repoWithFailingTest("unused");
    try {
      const res = run(dir, ["dispatch", "--dry-run", "-p", "Refactor slug builder", "--role", "bolt", "--verify-cmd", "npm test"]);
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.match(res.stdout, /Dry Run — nothing was dispatched/);
      assert.match(res.stdout, /bolt/);

      const resAlias = run(dir, ["dispatch", "--dry-run", "-p", "Refactor slug builder", "-r", "bolt", "--verify", "npm test"]);
      assert.equal(resAlias.status, 0, resAlias.stdout + resAlias.stderr);
      assert.match(resAlias.stdout, /Dry Run — nothing was dispatched/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("dispatch accepts --auto-approve-plans and --auto-approve in dry-run", () => {
    const dir = repoWithFailingTest("unused");
    try {
      const res = run(dir, ["dispatch", "--dry-run", "-p", "Refactor slug builder", "--auto-approve-plans", "--json"]);
      assert.equal(res.status, 0, res.stdout + res.stderr);
      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.session?.data?.dryRun, true);

      const resAlias = run(dir, ["dispatch", "--dry-run", "-p", "Refactor slug builder", "--auto-approve", "--json"]);
      assert.equal(resAlias.status, 0, resAlias.stdout + resAlias.stderr);
      const parsedAlias = JSON.parse(resAlias.stdout);
      assert.equal(parsedAlias.ok, true);
      assert.equal(parsedAlias.session?.data?.dryRun, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("dispatch resolves positional task envelope path and inherits metadata", () => {
    const dir = repoWithFailingTest("unused");
    try {
      const qDir = join(dir, ".agent", "jules-queue");
      mkdirSync(qDir, { recursive: true });
      const taskFile = join(qDir, "TASK-TEST1.md");
      const envelope = `<!-- JULES_TASK_ENVELOPE: {"version":1,"id":"TASK-TEST1","title":"feat: Test Positional Task","flags":{"autoPr":true,"requirePlanApproval":false},"verifyCmd":"npm test","role":"performance","tier":"fast"} -->
# feat: Test Positional Task
Task instructions here. Verify with npm test.`;
      writeFileSync(taskFile, envelope, "utf-8");

      // 1. Dispatch via relative file path (json & text)
      const resPath = run(dir, ["dispatch", ".agent/jules-queue/TASK-TEST1.md", "--dry-run", "--json"]);
      assert.equal(resPath.status, 0, resPath.stdout + resPath.stderr);
      const parsedPath = JSON.parse(resPath.stdout);
      assert.equal(parsedPath.ok, true);
      assert.equal(parsedPath.session?.title, "feat: Test Positional Task");

      const resText = run(dir, ["dispatch", ".agent/jules-queue/TASK-TEST1.md", "--dry-run"]);
      assert.equal(resText.status, 0, resText.stdout + resText.stderr);
      assert.match(resText.stdout, /feat: Test Positional Task/);
      assert.match(resText.stdout, /performance/);

      // 2. Dispatch via bare task ID
      const resId = run(dir, ["dispatch", "TASK-TEST1", "--dry-run", "--json"]);
      assert.equal(resId.status, 0, resId.stdout + resId.stderr);
      const parsedId = JSON.parse(resId.stdout);
      assert.equal(parsedId.ok, true);
      assert.equal(parsedId.session?.title, "feat: Test Positional Task");

      // 3. Dispatch with no arguments auto-selects queued task
      const resAuto = run(dir, ["dispatch", "--dry-run", "--json"]);
      assert.equal(resAuto.status, 0, resAuto.stdout + resAuto.stderr);
      const parsedAuto = JSON.parse(resAuto.stdout);
      assert.equal(parsedAuto.ok, true);
      assert.equal(parsedAuto.session?.title, "feat: Test Positional Task");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
}

// ═══════════════════════════════════════════════════════════════════════════
// From: test/cold-start-trial-f13-f22.test.mjs
// Moved verbatim by the P08 test consolidation; scoped to its own block.
// ═══════════════════════════════════════════════════════════════════════════
{
const ROOT = resolve(import.meta.dirname, "..");
const AGENTCTL = join(ROOT, "bin", "agentctl.mjs");

function setupGitRepo(initialBranch = "main") {
  const dir = mkdtempSync(join(tmpdir(), "cst-f13-f22-"));
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: "pipe" });
  git(["init", "-q", "-b", initialBranch]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test User"]);
  return { dir, git };
}

describe("F13 — Markdown EOF hygiene", () => {
  it("JULES_RULES_TEMPLATE.md ends with a single newline, not multiple trailing blanks", () => {
    const content = readFileSync(join(ROOT, "JULES_RULES_TEMPLATE.md"), "utf-8");
    assert.ok(content.endsWith("\n"), "file must end with a newline");
    assert.ok(!content.endsWith("\n\n"), "file must not end with trailing blank lines");
  });

  it(".agent/rules/jules-protocol.md ends with a single newline, not multiple trailing blanks", () => {
    const content = readFileSync(join(ROOT, ".agent", "rules", "jules-protocol.md"), "utf-8");
    assert.ok(content.endsWith("\n"), "file must end with a newline");
    assert.ok(!content.endsWith("\n\n"), "file must not end with trailing blank lines");
  });
});

describe("F14 — Cargo lint oracle defaults without -D warnings", () => {
  it("generates cargo clippy candidate without forcing -D warnings", () => {
    const dir = mkdtempSync(join(tmpdir(), "cst-f14-"));
    try {
      writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "test-pkg"\nversion = "0.1.0"\n');
      const oracles = detectStackOracles(dir);
      assert.ok(oracles.candidates.lintCmd, "lint oracle must be detected for Cargo");
      assert.ok(
        oracles.candidates.lintCmd.startsWith("cargo clippy"),
        `lint command should be cargo clippy, got: ${oracles.candidates.lintCmd}`
      );
      assert.ok(
        !oracles.candidates.lintCmd.includes("-D warnings"),
        `cargo clippy must not enforce -D warnings by default: ${oracles.candidates.lintCmd}`
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("F15 — Multi-target Cargo test count aggregation", () => {
  it("aggregates test counts across all Cargo compilation targets (0 unit + 58 integration = 58)", () => {
    const multiTargetOutput = `
     Running unittests src/lib.rs (target/debug/deps/my_lib-abc)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/integration.rs (target/debug/deps/integration-def)

running 58 tests
test test_parse ... ok
test test_render ... ok
test result: ok. 58 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.05s
`;
    const res = parseCollectedTests(multiTargetOutput);
    assert.equal(res.count, 58, "must sum across all target test runners");
    assert.equal(res.runner, "cargo", "runner must be cargo");
  });
});

describe("F16 — Lockfile scope violation and supply chain remediation hint", () => {
  it("prints informative supply chain hint and suggests --allow-protected on lockfile modification", () => {
    const { dir, git } = setupGitRepo();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", scripts: { test: "node -e 'process.exit(0)'" } }));
      writeFileSync(join(dir, "package-lock.json"), "{}");
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\nverify:\n  test: node -e 'process.exit(0)'\n");
      git(["add", "."]);
      git(["commit", "-qm", "feat: initial commit"]);

      // Modify lockfile
      writeFileSync(join(dir, "package-lock.json"), '{"name": "app", "version": "1.0.0"}');

      let stdout = "";
      let stderr = "";
      let exitCode = 0;
      try {
        stdout = execFileSync(process.execPath, [AGENTCTL, "check", "--base", "main"], {
          cwd: dir,
          encoding: "utf-8",
          stdio: "pipe",
        });
      } catch (err) {
        exitCode = err.status;
        stdout = err.stdout || "";
        stderr = err.stderr || "";
      }

      assert.equal(exitCode, 3, "must exit 3 on lockfile tamper");
      const out = stdout + stderr;
      assert.ok(out.includes("supply-chain tampering"), "output should explain lockfile supply-chain protection");
      assert.ok(out.includes("--allow-protected"), "output should suggest --allow-protected");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("F17 — CLI parsing accepts --strict-locks", () => {
  it("agentctl check accepts --strict-locks flag without unknown option error", () => {
    const { dir, git } = setupGitRepo();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", scripts: { test: "node -e 'console.log(\"# tests 1\\n# pass 1\")'" } }));
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\nverify:\n  test: node -e 'console.log(\"# tests 1\\n# pass 1\")'\n");
      git(["add", "."]);
      git(["commit", "-qm", "feat: initial commit"]);

      const out = execFileSync(
        process.execPath,
        [AGENTCTL, "check", "--base", "main", "--strict-locks"],
        { cwd: dir, encoding: "utf-8", stdio: "pipe" }
      );
      assert.ok(!out.includes("Unknown option: --strict-locks"), "should not fail with unknown option");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("F18 & F19 — Active waivers, overrides banner, and truthful messaging", () => {
  it("tracks active waivers in gate result overrides", () => {
    const { dir, git } = setupGitRepo();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", scripts: { test: "node -e 'console.log(\"# tests 1\\n# pass 1\")'" } }));
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        "version: 1\nverify:\n  test: node -e 'console.log(\"# tests 1\\n# pass 1\")'\n  minTests: 0\n"
      );
      git(["add", "."]);
      git(["commit", "-qm", "feat: initial commit"]);

      const origEnv = process.env.JULES_ALLOW_COMMAND_FILE_CHANGES;
      process.env.JULES_ALLOW_COMMAND_FILE_CHANGES = "1";
      try {
        let stdout = "";
        try {
          stdout = execFileSync(
            process.execPath,
            [AGENTCTL, "check", "--base", "main", "--json"],
            { cwd: dir, encoding: "utf-8", stdio: "pipe" }
          );
        } catch (err) {
          stdout = err.stdout || "";
        }
        const parsed = JSON.parse(stdout);
        assert.ok(Array.isArray(parsed.overrides), "parsed.overrides should be an array");
        assert.ok(
          parsed.overrides.some((o) => o.includes("JULES_ALLOW_COMMAND_FILE_CHANGES")),
          "should record environment waiver"
        );
        assert.ok(
          parsed.overrides.some((o) => o.includes("minTests: 0")),
          "should record minTests waiver"
        );
      } finally {
        if (origEnv === undefined) {
          delete process.env.JULES_ALLOW_COMMAND_FILE_CHANGES;
        } else {
          process.env.JULES_ALLOW_COMMAND_FILE_CHANGES = origEnv;
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("formats verify.required: false accurately as permitting verification failures rather than nothing executed", () => {
    const { dir, git } = setupGitRepo();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", scripts: { test: "node -e 'process.exit(0)'" } }));
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        "version: 1\nverify:\n  required: false\n  test: node -e 'process.exit(0)'\n"
      );
      git(["add", "."]);
      git(["commit", "-qm", "feat: initial commit"]);

      const out = execFileSync(
        process.execPath,
        [AGENTCTL, "check", "--base", "main"],
        { cwd: dir, encoding: "utf-8", stdio: "pipe" }
      );
      assert.ok(
        out.includes("verification failures and empty test suites permitted"),
        "should display accurate warning for verify.required: false"
      );
      assert.ok(!out.includes("nothing is executed"), "should not falsely claim nothing is executed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("F20 — Dry-run suppression and simulation markers", () => {
  it("suppresses evidence manifest creation when dryRun is active", async () => {
    const { dir, git } = setupGitRepo();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", scripts: { test: "node -e 'console.log(\"# tests 1\\n# pass 1\")'" } }));
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\nverify:\n  test: node -e 'console.log(\"# tests 1\\n# pass 1\")'\n");
      git(["add", "."]);
      git(["commit", "-qm", "feat: initial commit"]);

      // Gate run with dryRun: true
      const res = await gate({ root: dir, base: "main", mode: "working-tree", dryRun: true });
      assert.equal(res.ok, true);

      const evidenceDir = join(dir, ".agent", "evidence");
      if (existsSync(evidenceDir)) {
        const files = readdirSync(evidenceDir);
        assert.equal(files.length, 0, "no evidence files should be written on dryRun");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("agentctl plan approve and session get show [DRY-RUN] markers during simulation", () => {
    const planOut = execFileSync(
      process.execPath,
      [AGENTCTL, "plan", "approve", "session-123", "--dry-run"],
      { encoding: "utf-8", stdio: "pipe" }
    );
    assert.ok(planOut.includes("[DRY-RUN]"), "plan approve output must contain [DRY-RUN]");

    const sessionOut = execFileSync(
      process.execPath,
      [AGENTCTL, "session", "get", "session-123", "--dry-run"],
      { encoding: "utf-8", stdio: "pipe" }
    );
    assert.ok(sessionOut.includes("[DRY-RUN]"), "session get output must contain [DRY-RUN]");
  });
});

describe("F21 — Subcommand help routing", () => {
  it("command-registry exports descriptors for pr harvest, session get, and plan approve", () => {
    assert.ok(getCommandDescriptor("pr harvest"), "pr harvest descriptor must exist");
    assert.ok(getCommandDescriptor("session get"), "session get descriptor must exist");
    assert.ok(getCommandDescriptor("plan approve"), "plan approve descriptor must exist");
  });

  it("agentctl pr harvest --help outputs targeted flags including --allow-no-checks", () => {
    const out = execFileSync(
      process.execPath,
      [AGENTCTL, "pr", "harvest", "--help"],
      { encoding: "utf-8", stdio: "pipe" }
    );
    assert.ok(out.includes("--allow-no-checks"), "must document --allow-no-checks");
    assert.ok(!out.includes("Core Capabilities"), "must not dump full root help");
  });

  it("agentctl help check outputs targeted help for the check command", () => {
    const out = execFileSync(
      process.execPath,
      [AGENTCTL, "help", "check"],
      { encoding: "utf-8", stdio: "pipe" }
    );
    assert.ok(out.includes("agentctl gate"), "must include canonical agentctl gate usage");
    assert.ok(!out.includes("agentctl help <command>"), "must be focused command help");
  });
});

describe("F22 — Complete uninstall and undo init documentation", () => {
  it("README.md contains complete uninstall / removing the kit documentation", () => {
    const content = readFileSync(join(ROOT, "README.md"), "utf-8");
    assert.match(
      content,
      /Complete Uninstall \/ Removing the Kit \(Undo Init\)/i,
      "README.md must have uninstall / undo init section"
    );
    assert.match(
      content,
      /git rm -rf --ignore-unmatch.*\.agent.*AGENTS\.md.*SPEC\.md/s,
      "README.md must document git rm command for tracked scaffold assets"
    );
    assert.match(
      content,
      /rm -rf \.agent \.agentctl/,
      "README.md must document runtime state cleanup"
    );
    assert.match(
      content,
      /clean.*maintenance.*not an uninstaller/i,
      "README.md must clarify that clean is maintenance not uninstaller"
    );
  });
});
}

// ═══════════════════════════════════════════════════════════════════════════
// From: test/edge-fixes.test.mjs
// Moved verbatim by the P08 test consolidation; scoped to its own block.
// ═══════════════════════════════════════════════════════════════════════════
{
describe("Edge Fixes & Critical Safeguards", () => {
  describe("a) /proc/<pid>/stat parsing robustness", () => {
    test("correctly parses starttime when process title contains spaces", () => {
      // Field 3 (state) = R (index 0 after rpar+2)
      // Field 22 (starttime) = 100200300 (index 19 after rpar+2)
      const mockStat = "12345 (jules worker task) R 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 100200300 20 21";
      const starttime = parseProcStat(mockStat);
      assert.strictEqual(starttime, "100200300", "Must extract starttime (field 22) correctly despite spaces in process title");
    });

    test("correctly parses starttime when process title contains nested parentheses and spaces", () => {
      const mockStat = "12345 (jules (worker) task) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 99887766 20 21";
      const starttime = parseProcStat(mockStat);
      assert.strictEqual(starttime, "99887766", "Must extract starttime correctly using lastIndexOf(')')");
    });

    test("getProcessStartTime handles mock stat string inputs cleanly", () => {
      const mockStat = "999 (worker process title) R 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 77665544 20 21";
      const starttime = getProcessStartTime(mockStat);
      assert.strictEqual(starttime, "77665544");
    });

    test("returns null for malformed stat strings without closing parenthesis", () => {
      assert.strictEqual(parseProcStat("invalid stat line without parens"), null);
    });
  });

  describe("b) Queue task matching & README.md filtering", () => {
    test("explicitly filters out README.md regardless of case", () => {
      assert.strictEqual(isTaskFile("README.md"), false);
      assert.strictEqual(isTaskFile("readme.md"), false);
      assert.strictEqual(isTaskFile("ReadMe.MD"), false);
      assert.strictEqual(isTaskFile(".agent/jules-queue/README.md"), false);
    });

    test("matches task files named TASK-*.md", () => {
      assert.strictEqual(isTaskFile("TASK-001-init.md"), true);
      assert.strictEqual(isTaskFile("task-subtask.md"), true);
      assert.strictEqual(isTaskFile("TASK-BUGFIX.md"), true);
    });

    test("matches files with valid envelope front-matter", () => {
      const validFmContent = "---\ntaskId: task-123\ntitle: Sample Task\n---\n# Task Description";
      assert.strictEqual(isTaskFile("custom-name.md", validFmContent), true);
    });

    test("rejects files without TASK- prefix or envelope front-matter", () => {
      const plainContent = "# Just a normal note\nNo front-matter here.";
      assert.strictEqual(isTaskFile("notes.md", plainContent), false);
      assert.strictEqual(isTaskFile("random.txt"), false);
    });
  });

  describe("c) Immutable base commit SHA resolution", () => {
    test("resolveBase returns a 40-character commit SHA", () => {
      const sha = resolveBase(process.cwd(), "HEAD");
      assert.ok(typeof sha === "string", "resolveBase must return a string");
      assert.strictEqual(sha.length, 40, "Base commit SHA must be 40 hexadecimal characters");
      assert.ok(/^[0-9a-f]{40}$/i.test(sha), "Base commit SHA must match 40-char hex pattern");
    });

    test("createExecutionEnvelope pins baseSha to exact 40-char commit SHA", () => {
      const envelope = createExecutionEnvelope(
        { id: "task-sha-test", files: ["src/state.mjs"] },
        { base: "HEAD" }
      );
      assert.ok(envelope.baseSha);
      assert.strictEqual(envelope.baseSha.length, 40);
      assert.ok(/^[0-9a-f]{40}$/i.test(envelope.baseSha), "baseSha in envelope must be a 40-char commit hash");
    });
  });

  describe("d) Process execution guardrails & error handling", () => {
    test("runCmd catches buffer limits (ENOBUFS) gracefully when ignoreError is true", () => {
      const res = runCmd(["node", "-e", "console.log('A'.repeat(200))"], {
        maxBuffer: 50,
        ignoreError: true,
      });
      assert.notStrictEqual(res.status, 0);
      assert.ok(res.stderr.includes("ENOBUFS") || res.stderr.includes("buffer"));
    });

    test("runCmd catches timeouts (ETIMEDOUT) gracefully when ignoreError is true", () => {
      const res = runCmd(["node", "-e", "setTimeout(() => {}, 5000)"], {
        timeout: 50,
        ignoreError: true,
      });
      assert.strictEqual(res.status, 124);
      assert.ok(res.stderr.includes("ETIMEDOUT") || res.stderr.includes("timed out"));
    });
  });
});
}

// ═══════════════════════════════════════════════════════════════════════════
// From: test/critical-hardening.test.mjs — P-07 Windows shim spawning
// Moved verbatim by the P08 test consolidation; scoped to its own block.
// ═══════════════════════════════════════════════════════════════════════════
{
describe("P-07: Windows .cmd shim spawning (quoting helpers)", () => {
  it("escapes command names", () => {
    assert.equal(windowsEscapeCommand("npm.cmd"), "npm.cmd");
    assert.equal(windowsEscapeCommand("C:\\Program Files\\node\\npm.cmd"), "C:\\Program^ Files\\node\\npm.cmd");
  });

  it("quotes arguments with the C-runtime + cmd.exe rules", () => {
    assert.equal(windowsEscapeArgument("two words"), '^"two^ words^"');
    assert.equal(windowsEscapeArgument("plain"), '^"plain^"');
    assert.equal(windowsEscapeArgument(""), '^"^"');
    assert.equal(windowsEscapeArgument("a\\b"), '^"a\\b^"');
    assert.equal(windowsEscapeArgument("trailing\\"), '^"trailing\\\\^"');
    assert.equal(windowsEscapeArgument('quote"inside'), '^"quote\\^"inside^"');
    assert.equal(windowsEscapeArgument("a & b"), '^"a^ ^&^ b^"');
  });

  it("double-escapes meta characters for node_modules/.bin cmd shims", () => {
    assert.equal(windowsEscapeArgument("a & b", true), '^^^"a^^^ ^^^&^^^ b^^^"');
  });

  it("returns null on non-Windows so callers spawn directly", () => {
    assert.equal(resolveWindowsSpawn("npm", ["--version"], process.env, "linux"), null);
  });

  it("spawns a native .exe directly", () => {
    const dir = mkdtempSync(join(tmpdir(), "win-exe-"));
    try {
      // Lower-case PATHEXT so resolution works on the case-sensitive Linux
      // filesystem the suite runs on; on Windows the same code is
      // case-insensitive.
      writeFileSync(join(dir, "fake.exe"), "");
      const env = { PATH: dir, PATHEXT: ".exe;.cmd" };
      const spec = resolveWindowsSpawn("fake", ["run", "two words"], env, "win32");
      assert.ok(spec);
      assert.equal(spec.file, join(dir, "fake.exe"));
      assert.deepEqual(spec.args, ["run", "two words"]);
      assert.equal(spec.verbatim, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wraps a .cmd shim in cmd.exe with per-argument quoting", () => {
    const dir = mkdtempSync(join(tmpdir(), "win-cmd-"));
    try {
      writeFileSync(join(dir, "fake.cmd"), "");
      const env = { PATH: dir, PATHEXT: ".cmd" };
      const spec = resolveWindowsSpawn("fake", ["run", "two words"], env, "win32");
      assert.ok(spec);
      assert.equal(spec.file, "cmd.exe");
      assert.deepEqual(spec.args.slice(0, 3), ["/d", "/s", "/c"]);
      assert.ok(spec.args[3].includes(join(dir, "fake.cmd")), "command name is present in the cmd line");
      assert.ok(spec.args[3].includes('^"two^ words^"'), "space-bearing arg is quoted");
      assert.equal(spec.verbatim, true);

      // Explicit ComSpec in environment is respected
      const customEnv = { PATH: dir, PATHEXT: ".cmd", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
      const customSpec = resolveWindowsSpawn("fake", ["run"], customEnv, "win32");
      assert.equal(customSpec.file, "C:\\Windows\\system32\\cmd.exe");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runCmd still executes array commands with space-bearing args on POSIX", () => {
    const res = runCmd([process.execPath, "-e", "console.log(process.argv[1])", "two words"], { cwd: process.cwd() });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, "two words");
  });
});
}

// ═══════════════════════════════════════════════════════════════════════════
// From: test/p0-remediation.test.mjs — P0-07 runCmd shell safety
// Moved verbatim by the P08 test consolidation; scoped to its own block.
// ═══════════════════════════════════════════════════════════════════════════
{
test("P0-07: Shell Execution Safety in runCmd", async (t) => {
  await t.test("executes shell chained operators && correctly", () => {
    const res = runCmd(`"${process.execPath}" -e "process.stdout.write(String.fromCharCode(115,116,101,112,49,32))" && "${process.execPath}" -e "process.stdout.write(String.fromCharCode(115,116,101,112,50))"`);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, "step1 step2");
  });
});
}

// ═══════════════════════════════════════════════════════════════════════════
// New: offline CLI command-surface coverage
// Written new in P08 for offline coverage of the merged domain.
// ═══════════════════════════════════════════════════════════════════════════
/**
 * P08 addition: offline coverage for the ten previously untested (or lightly
 * tested) CLI surfaces. Every invocation runs with provider credentials and
 * webhook URLs scrubbed from the environment and every provider-touching path
 * either uses --dry-run or an injected mock provider, so the whole section
 * makes zero network egress. The net-guard preload allows only loopback, and
 * none of these tests even open that.
 */

const AGENTCTL = fileURLToPath(new URL("../bin/agentctl.mjs", import.meta.url));

// Any credential that could turn a rehearsal into a live call is removed
// before the child starts — belt and braces alongside --dry-run.
const SCRUBBED_ENV_KEYS = [
  "JULES_API_KEY",
  "GEMINI_API_KEY",
  "AGENT_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "JULES_SESSION_WEBHOOK_URL",
  "SLACK_WEBHOOK_URL",
  "DISCORD_WEBHOOK_URL",
];

/** A throwaway git repo with one commit and no .agent state. */
function offlineRepo(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@e.com");
  git("config", "user.name", "T");
  git("commit", "--allow-empty", "-qm", "base");
  return dir;
}

/** Runs agentctl in `dir` with every credential scrubbed from the environment. */
function runCli(dir, args) {
  const env = { ...process.env };
  for (const key of SCRUBBED_ENV_KEYS) delete env[key];
  return spawnSync(process.execPath, [AGENTCTL, ...args], { cwd: dir, encoding: "utf-8", env });
}

/** Parses the JSON object out of stdout that may carry a banner line first. */
function jsonOut(proc) {
  const start = proc.stdout.indexOf("{");
  assert.notEqual(start, -1, `expected JSON in stdout, got: ${JSON.stringify(proc.stdout.slice(0, 200))}`);
  return JSON.parse(proc.stdout.slice(start));
}

describe("agentctl command surface — offline CLI coverage", () => {

  it("dispatch --dry-run reports a rehearsal and consumes no budget slot", () => {
    const dir = offlineRepo("jok-cli-dispatch-");
    try {
      const proc = runCli(dir, ["dispatch", "--dry-run", "--json", "-p", "Rehearse this"]);
      assert.equal(proc.status, 0, proc.stderr);
      const out = JSON.parse(proc.stdout);
      assert.equal(out.ok, true);
      assert.equal(out.session.id, "dry-run-session-id");
      assert.equal(out.session.status, "pending");
      assert.equal(checkDailyBudget(dir, 300).used, 0, "a dry run must not reserve budget");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dispatch --dry-run announces itself as a rehearsal, not a dispatch", () => {
    const dir = offlineRepo("jok-cli-banner-");
    try {
      const proc = runCli(dir, ["dispatch", "--dry-run", "-p", "Rehearse this"]);
      assert.equal(proc.status, 0, proc.stderr);
      assert.match(proc.stdout, /Dry Run — nothing was dispatched/);
      assert.doesNotMatch(proc.stdout, /Dispatched Successfully/, "a rehearsal must never print the success banner");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dispatch without a prompt or a queued task fails with usage guidance", () => {
    const dir = offlineRepo("jok-cli-noprompt-");
    try {
      const proc = runCli(dir, ["dispatch"]);
      assert.equal(proc.status, 1);
      assert.match(proc.stderr, /a prompt is required/);
      assert.match(proc.stderr, /--prompt/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dispatch --role rejects an unresolvable role before any dispatch", () => {
    const dir = offlineRepo("jok-cli-role-");
    try {
      const proc = runCli(dir, ["dispatch", "--dry-run", "--json", "-p", "hi", "-r", "NoSuchRole"]);
      assert.equal(proc.status, 1);
      assert.match(proc.stderr, /Unknown agent role 'NoSuchRole'/);
      assert.match(proc.stderr, /agentctl init/);
      assert.equal(proc.stdout.trim(), "", "a rejected role must not produce a session payload");
      assert.equal(checkDailyBudget(dir, 300).used, 0, "a rejected role must not consume a budget slot");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("queue reports an empty queue and exits clean", () => {
    const dir = offlineRepo("jok-cli-queue0-");
    try {
      const proc = runCli(dir, ["queue"]);
      assert.equal(proc.status, 0, proc.stderr);
      assert.match(proc.stdout, /Found 0 queued task\(s\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("queue --dry-run --json processes in place and keeps the task queued", () => {
    const dir = offlineRepo("jok-cli-queue-");
    try {
      const queueDir = join(dir, ".agent", "jules-queue");
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, "TASK-01.md"), "# Task ID: TASK-01\n\nDo the thing.\n");

      const proc = runCli(dir, ["queue", "--dry-run", "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      const out = jsonOut(proc);
      assert.equal(out.processed, 1);
      assert.equal(out.results[0].file, "TASK-01.md");
      assert.equal(out.results[0].ok, true);
      assert.equal(out.results[0].dryRun, true);

      assert.equal(existsSync(join(queueDir, "TASK-01.md")), true, "a dry run must leave the task in the queue");
      assert.equal(existsSync(join(queueDir, "completed")), false, "a dry run must not create completed/");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("queue --dag --dry-run --json extracts the envelope task id", () => {
    const dir = offlineRepo("jok-cli-dag-");
    try {
      const queueDir = join(dir, ".agent", "jules-queue");
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, "TASK-07.md"), "# Task ID: TASK-07\n\nDag job.\n");

      const proc = runCli(dir, ["queue", "--dag", "--dry-run", "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      const out = jsonOut(proc);
      assert.equal(out.processed, 1);
      assert.equal(out.results[0].taskId, "TASK-07");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("swarm --json on an empty queue reports zero work without a banner", () => {
    const dir = offlineRepo("jok-cli-swarm0-");
    try {
      const proc = runCli(dir, ["swarm", "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      const out = JSON.parse(proc.stdout);
      assert.equal(out.ok, true);
      assert.equal(out.processed, 0);
      assert.deepEqual(out.results, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("swarm --dry-run --json fans out over every queued task and moves nothing", () => {
    const dir = offlineRepo("jok-cli-swarm-");
    try {
      const queueDir = join(dir, ".agent", "jules-queue");
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, "TASK-A.md"), "# Task ID: TASK-A\n\nA.\n");
      writeFileSync(join(queueDir, "TASK-B.md"), "# Task ID: TASK-B\n\nB.\n");

      const proc = runCli(dir, ["swarm", "--dry-run", "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      const out = JSON.parse(proc.stdout);
      assert.equal(out.ok, true);
      assert.equal(out.dryRun, true, "the JSON must carry the dry-run flag it was given");
      assert.equal(out.processed, 2);
      assert.deepEqual(out.results.map((r) => r.file).sort(), ["TASK-A.md", "TASK-B.md"]);
      assert.deepEqual(readdirSync(queueDir).sort(), ["TASK-A.md", "TASK-B.md"], "swarm dry run moves nothing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rollback fails closed with guidance when no checkpoint exists", () => {
    const dir = offlineRepo("jok-cli-rollback0-");
    try {
      const proc = runCli(dir, ["rollback", "--latest", "--json"]);
      assert.equal(proc.status, 1);
      assert.match(proc.stderr, /Rollback Failed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rollback --latest --json restores the newest checkpoint and writes a handover", () => {
    const dir = offlineRepo("jok-cli-rollback-");
    try {
      createCheckpoint("session-a", { root: dir });
      createCheckpoint("session-b", { root: dir });
      const dirty = join(dir, "uncommitted.txt");
      writeFileSync(dirty, "work in flight\n");

      const proc = runCli(dir, ["rollback", "--latest", "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      const out = JSON.parse(proc.stdout);
      assert.equal(out.ok, true);
      assert.equal(out.id, "session-b", "the newest checkpoint is restored");
      assert.ok(out.restoredAt);
      assert.ok(out.handover, "the rollback records a handover document");
      assert.equal(existsSync(out.handover), true);
      assert.equal(existsSync(dirty), false, "restoring discards uncommitted work to the checkpoint state");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rollback <sessionId> restores an explicitly named checkpoint", () => {
    const dir = offlineRepo("jok-cli-rollback-id-");
    try {
      createCheckpoint("session-a", { root: dir });
      createCheckpoint("session-b", { root: dir });

      const proc = runCli(dir, ["rollback", "session-a", "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      const out = JSON.parse(proc.stdout);
      assert.equal(out.ok, true);
      assert.equal(out.id, "session-a", "the positional id selects the checkpoint, not recency");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checkpoint create/list/restore/prune round-trips and rejects path escapes", () => {
    const dir = offlineRepo("jok-cli-ckpt-");
    try {
      const snap = createCheckpoint("session-a", { root: dir });
      assert.equal(snap.id, "session-a");
      assert.match(snap.headSha, /^[0-9a-f]{40}$/);
      assert.equal(snap.branch, "main");

      createCheckpoint("session-b", { root: dir });
      assert.deepEqual(listCheckpoints(dir).map((c) => c.id), ["session-b", "session-a"], "checkpoints list newest first");

      const dirty = join(dir, "dirty.txt");
      writeFileSync(dirty, "discard me\n");
      const restored = restoreCheckpoint("session-a", { root: dir });
      assert.equal(restored.id, "session-a");
      assert.ok(restored.restoredAt);
      assert.equal(existsSync(dirty), false, "restore rewinds the working tree to the checkpoint state");

      for (let i = 0; i < 12; i++) createCheckpoint(`session-${i}`, { root: dir });
      pruneCheckpoints(dir, 10);
      assert.equal(listCheckpoints(dir).length, 10, "prune keeps the newest maxRetention checkpoints");

      for (const bad of ["../../evil", "a/b"]) {
        assert.throws(() => restoreCheckpoint(bad, { root: dir }), CheckpointError, `restore must reject ${bad}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retry <session> --dry-run --json returns a rehearsal retry offline", () => {
    const dir = offlineRepo("jok-cli-retry-");
    try {
      const proc = runCli(dir, ["retry", "sess-123", "--dry-run", "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      const out = JSON.parse(proc.stdout);
      assert.equal(out.ok, true);
      assert.equal(out.originalSessionId, "sess-123");
      assert.equal(out.newSession.id, "dry-run-session-id");
      assert.equal(out.newSession.status, "pending");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retry without a session id exits 1 with usage", () => {
    const dir = offlineRepo("jok-cli-retry0-");
    try {
      const proc = runCli(dir, ["retry"]);
      assert.equal(proc.status, 1);
      assert.match(proc.stderr, /Missing required session ID/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retrySession injects the captured failure diagnostics into the retry prompt", async () => {
    const dir = offlineRepo("jok-unit-retry-");
    try {
      const dispatched = [];
      const provider = {
        name: "mock",
        async getSession() {
          return { id: "sess-1", status: "FAILED", raw: { title: "Fix the login bug", prompt: "Fix it." } };
        },
        async listActivities() {
          return {
            activities: [
              { artifacts: [{ bashOutput: { command: "npm test", output: "1 test failed: login rejects valid user", exitCode: 1 } }] },
            ],
          };
        },
        async dispatch(task, opts) {
          dispatched.push({ task, opts });
          return { id: "sess-2", status: "pending", ...(opts && opts.dryRun ? { dryRun: true } : {}) };
        },
      };

      const res = await retrySession("sess-1", { root: dir, provider, title: "Round two" });

      assert.equal(res.ok, true);
      assert.equal(res.originalSessionId, "sess-1");
      assert.equal(res.diagnosticsFound, 1, "the readable bash failure counts as a diagnostic");
      assert.deepEqual(res.diagnosticSources, ["bashOutput"]);
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0].task.title, "Round two", "an explicit retry title wins");
      assert.match(dispatched[0].task.prompt, /\[PREVIOUS_ATTEMPT_FAILURE_DIAGNOSTIC\]/);
      assert.match(dispatched[0].task.prompt, /login rejects valid user/, "the actual failure output rides along");
      assert.match(dispatched[0].task.prompt, /Fix it\./, "the original prompt is preserved");
      assert.match(res.failureReason, /login rejects valid user/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prune --json on an untouched repo exits 0 and reports zero matches", () => {
    const dir = offlineRepo("jok-cli-prune0-");
    try {
      const proc = runCli(dir, ["prune", "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      const out = JSON.parse(proc.stdout);
      assert.equal(out.ok, true);
      assert.equal(out.matchedCount, 0);
      assert.deepEqual(out.sessions, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pruneSessions honours age and state filters, dry-run, archive and delete", async () => {
    const dir = offlineRepo("jok-unit-prune-");
    try {
      const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
      const sessions = [
        { id: "old-completed", state: "COMPLETED", createTime: daysAgo(10) },
        { id: "fresh-completed", state: "COMPLETED", createTime: new Date().toISOString() },
        { id: "old-failed", state: "FAILED", createTime: daysAgo(10) },
      ];
      const archived = [];
      const deleted = [];
      const provider = {
        name: "mock",
        async listSessions() {
          return { sessions };
        },
        async archiveSession(id) {
          archived.push(id);
          return { ok: true };
        },
        async deleteSession(id) {
          deleted.push(id);
          return { ok: true };
        },
      };

      const dry = await pruneSessions({ root: dir, provider, age: "7d", dryRun: true });
      assert.equal(dry.matchedCount, 2, "only sessions older than the cutoff match");
      assert.ok(dry.sessions.every((s) => s.action === "DRY_RUN_SKIP"));
      assert.equal(dry.archivedCount, 0);
      assert.deepEqual(archived, [], "a dry run must not touch the provider");

      const wet = await pruneSessions({ root: dir, provider, age: "7d" });
      assert.equal(wet.archivedCount, 2);
      assert.deepEqual(archived.sort(), ["old-completed", "old-failed"]);

      const filtered = await pruneSessions({ root: dir, provider, age: "7d", state: "COMPLETED" });
      assert.equal(filtered.matchedCount, 1, "the state filter excludes the FAILED session");

      const removed = await pruneSessions({ root: dir, provider, age: "7d", delete: true });
      assert.deepEqual(deleted.sort(), ["old-completed", "old-failed"]);
      assert.ok(removed.sessions.every((s) => s.action === "DELETED"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escalate --status --json reports the silence governor offline", () => {
    const dir = offlineRepo("jok-cli-esc-status-");
    try {
      const proc = runCli(dir, ["escalate", "--status", "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      const out = JSON.parse(proc.stdout);
      assert.equal(out.ok, true);
      assert.equal(out.status.pendingCount, 0);
      assert.deepEqual(out.status.incidents, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escalate <session> --dry-run --json builds the payload and marks itself a dry run", () => {
    const dir = offlineRepo("jok-cli-esc-dry-");
    try {
      const proc = runCli(dir, ["escalate", "sess-9", "--dry-run", "--json", "-r", "TESTS_RED"]);
      assert.equal(proc.status, 0, proc.stderr);
      const out = JSON.parse(proc.stdout);
      assert.equal(out.ok, true);
      assert.equal(out.result.dryRun, true, "the result must admit nothing actually left");
      assert.equal(out.result.payload.sessionId, "sess-9");
      assert.equal(out.result.payload.reason, "TESTS_RED");
      assert.match(out.result.payload.resumeCmd, /agentctl resume sess-9/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escalate without a webhook configured dispatches nothing and says why", () => {
    const dir = offlineRepo("jok-cli-esc-live-");
    try {
      const proc = runCli(dir, ["escalate", "sess-9", "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      const out = JSON.parse(proc.stdout);
      assert.equal(out.ok, true);
      assert.equal(out.result.dispatched, false, "no webhook URL means nothing is sent");
      assert.match(out.result.reason, /No webhook URL configured/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escalate without a session id exits 1 with usage", () => {
    const dir = offlineRepo("jok-cli-esc0-");
    try {
      const proc = runCli(dir, ["escalate"]);
      assert.equal(proc.status, 1);
      assert.match(proc.stderr, /Session ID is required/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("learning add records a learning and reports the running count", () => {
    const dir = offlineRepo("jok-cli-learn-");
    try {
      const first = runCli(dir, ["learning", "add", "flaky port bind", "retry with port 0"]);
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /Total learnings: 1/);

      const second = runCli(dir, ["learning", "add", "stale lock", "run agentctl lock clear"]);
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /Total learnings: 2/);

      const learnings = loadLearnings(dir);
      assert.equal(learnings.length, 2);
      assert.ok(learnings.some((l) => l.trigger === "flaky port bind" && l.solution === "retry with port 0"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("learning without the add subcommand prints usage and exits 1", () => {
    const dir = offlineRepo("jok-cli-learn0-");
    try {
      const proc = runCli(dir, ["learning"]);
      assert.equal(proc.status, 1);
      assert.match(proc.stderr, /Usage: agentctl learning add/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("evidence generate --json writes a manifest with test integrity", () => {
    const dir = offlineRepo("jok-cli-evd-");
    try {
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(join(dir, "test", "sanity.test.mjs"), "assert.equal(2 + 2, 4);\n");

      const proc = runCli(dir, ["evidence", "generate", "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      const out = JSON.parse(proc.stdout);
      assert.equal(out.ok, true);
      assert.match(out.manifest.manifestId, /^EVD-/);
      assert.match(out.manifest.evidenceHash, /^sha256:/);
      assert.equal(out.manifest.testIntegrity.testFileCount, 1);
      assert.equal(out.manifest.testIntegrity.tamperDetected, false);
      assert.equal(existsSync(out.manifestPath ?? join(dir, ".agent", "evidence")), true, "the manifest lands on disk");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("evidence verify passes on an untouched tree and fails red after a test file changes", () => {
    const dir = offlineRepo("jok-cli-evd-tamper-");
    try {
      mkdirSync(join(dir, "test"), { recursive: true });
      const testFile = join(dir, "test", "sanity.test.mjs");
      writeFileSync(testFile, "assert.equal(2 + 2, 4);\n");

      const gen = runCli(dir, ["evidence", "generate", "--json"]);
      assert.equal(gen.status, 0, gen.stderr);

      const clean = runCli(dir, ["evidence", "verify"]);
      assert.equal(clean.status, 0, clean.stderr);
      assert.match(clean.stdout, /Evidence Verification PASSED/);

      // The vacuous-assertion killer: if `verify` inverted its verdict this
      // test goes red instead of blessing a tampered evidence trail.
      writeFileSync(testFile, "assert.equal(2 + 2, 5);\n");
      const tampered = runCli(dir, ["evidence", "verify"]);
      assert.equal(tampered.status, 1, "verification must fail after the test tree changed");
      assert.match(tampered.stderr, /Evidence Verification FAILED/);
      assert.match(tampered.stderr, /does not match manifest/, "the failure names the hash mismatch");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * P06 addition: CLI↔registry parity. bin/agentctl.mjs routes on `case "<cmd>":`
 * labels while --help, `help <command>` and docs/COMMAND_REFERENCE.md render
 * from src/ops/command-registry.mjs. These tests pin the two together: a new
 * case without a descriptor (or a descriptor for a command that no longer
 * exists) fails here instead of shipping silent help drift.
 */
describe("P06: CLI case labels and registry descriptors stay in sync", () => {
  const CLI_SOURCE = readFileSync(AGENTCTL, "utf-8");
  const caseLabels = [...CLI_SOURCE.matchAll(/^\s*case "([^"]+)":/gm)].map((m) => m[1]);

  it("extracts the routed case labels from bin/agentctl.mjs", () => {
    assert.ok(caseLabels.length >= 49, `expected at least 49 case labels, found ${caseLabels.length}`);
  });

  it("every case label resolves to a registry descriptor", () => {
    // Resolution goes through getCommandDescriptor (id, path, then shortcut)
    // because multi-word commands are described once: `plan` and `approve`
    // both resolve via the plan-approve shortcuts, `session` via session-get,
    // `pr` via pr-harvest.
    const missing = [...new Set(caseLabels)].filter((label) => !getCommandDescriptor(label));
    assert.deepEqual(missing, [], `case labels without a registry descriptor: ${missing.join(", ")}`);
  });

  it("every descriptor path head is a real routed case label", () => {
    const labels = new Set(caseLabels);
    const orphaned = COMMAND_REGISTRY.filter((d) => !labels.has(d.path[0])).map((d) => d.id);
    assert.deepEqual(orphaned, [], `descriptors with no routed command: ${orphaned.join(", ")}`);
  });

  it("docs/COMMAND_REFERENCE.md matches the rendered registry", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const onDisk = readFileSync(join(root, "docs", "COMMAND_REFERENCE.md"), "utf-8");
    const rendered = `${formatRegistryMarkdown()}`.replace(/\s+$/, "") + "\n";
    assert.equal(onDisk, rendered, "stale reference — run: node scripts/generate-command-reference.mjs");
  });
});
