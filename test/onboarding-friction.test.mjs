import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { detectDefaultBranch } from "../src/git.mjs";
import { setConfigProvider, setVerificationProfile } from "../src/config-edit.mjs";
import { planInit } from "../src/wizard-init.mjs";
import { runTaskCreateWizard } from "../src/wizard-task.mjs";
import { selectFailureOutput } from "../src/ops/verify-output.mjs";
import { COMMAND_REGISTRY } from "../src/ops/command-registry.mjs";
import { scaffoldIdeConfig } from "../src/ops/ide-scaffold.mjs";
import { resolveWizardInteractivity } from "../src/ops/cli-intent.mjs";
import { probeProviderLiveness } from "../src/provider-readiness.mjs";

/** A git repository initialised on a named branch, optionally with a commit. */
function repoOn(branch, { commit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "jok-branch-"));
  execFileSync("git", ["init", "-q", "-b", branch], { cwd: dir });
  if (commit) {
    writeFileSync(join(dir, "a.txt"), "x\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  }
  return dir;
}

describe("the base branch is detected, not assumed", () => {
  it("reports the branch the repository actually uses", () => {
    for (const branch of ["master", "develop", "trunk"]) {
      const dir = repoOn(branch);
      try {
        assert.equal(detectDefaultBranch(dir), branch);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("names the unborn branch of a repository with no commits yet", () => {
    const dir = repoOn("master", { commit: false });
    try {
      assert.equal(detectDefaultBranch(dir), "master", "init runs before the first commit exists");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers a conventional branch over whichever one is checked out", () => {
    const dir = repoOn("main");
    try {
      execFileSync("git", ["checkout", "-q", "-b", "feature/x"], { cwd: dir });
      assert.equal(
        detectDefaultBranch(dir),
        "main",
        "running init from a feature branch must not record that branch as the base"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to main outside a repository rather than throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "jok-nogit-"));
    try {
      assert.equal(detectDefaultBranch(dir), "main");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scaffolds the detected branch into the manifest", () => {
    const dir = repoOn("develop");
    try {
      const plan = planInit(dir, { env: { PATH: "" } });
      assert.equal(plan.baseBranch, "develop");
      assert.match(plan.configYaml, /base_branch: develop/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still lets an explicit choice and an existing manifest win", () => {
    const dir = repoOn("master");
    try {
      assert.equal(planInit(dir, { baseBranch: "release", env: { PATH: "" } }).baseBranch, "release");

      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\nbase_branch: staging\n");
      assert.equal(planInit(dir, { env: { PATH: "" } }).baseBranch, "staging");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a failing stage shows what failed", () => {
  it("keeps stdout when stderr holds only the spawn wrapper's line", () => {
    const out = selectFailureOutput({
      stderr: "Command failed: npm test",
      stdout: "✖ adds two numbers\n  AssertionError: 3 !== 4\n    at calc.test.mjs:9",
    });
    assert.match(out, /AssertionError/);
    assert.match(out, /adds two numbers/);
  });

  it("shows both when each stream carries something real", () => {
    const out = selectFailureOutput({ stderr: "SyntaxError: unexpected token", stdout: "1..0" });
    assert.match(out, /SyntaxError/);
    assert.match(out, /1\.\.0/);
  });

  it("handles a stream being absent, empty or identical", () => {
    assert.equal(selectFailureOutput({ stdout: "only stdout" }), "only stdout");
    assert.equal(selectFailureOutput({ stderr: "only stderr" }), "only stderr");
    assert.equal(selectFailureOutput({ stderr: "same", stdout: "same" }), "same");
    assert.equal(selectFailureOutput({}), "");
  });

  it("does not discard stdout for an npm error banner either", () => {
    const out = selectFailureOutput({ stderr: "npm ERR! Test failed.", stdout: "FAIL src/calc.test.js" });
    assert.equal(out, "FAIL src/calc.test.js");
  });
});

describe("switching provider does not mean re-running onboarding", () => {
  function manifest(yaml) {
    const dir = mkdtempSync(join(tmpdir(), "jok-provset-"));
    mkdirSync(join(dir, ".agent"), { recursive: true });
    writeFileSync(join(dir, ".agent", "config.yml"), yaml);
    return dir;
  }

  it("replaces an existing provider key in place", () => {
    const dir = manifest("# keep me\nversion: 1\nprovider: jules\ntier: pro\n");
    try {
      assert.equal(setConfigProvider(dir, "claude-code").ok, true);
      const out = readFileSync(join(dir, ".agent", "config.yml"), "utf-8");
      assert.match(out, /^provider: claude-code$/m);
      assert.match(out, /# keep me/);
      assert.match(out, /tier: pro/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("inserts the key after version when the manifest has none", () => {
    const dir = manifest("version: 1\ntier: free\n");
    try {
      assert.equal(setConfigProvider(dir, "codex").ok, true);
      const lines = readFileSync(join(dir, ".agent", "config.yml"), "utf-8").split("\n");
      assert.equal(lines[0], "version: 1");
      assert.equal(lines[1], "provider: codex");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a name that could not be a YAML scalar, and a repo with no manifest", () => {
    const dir = manifest("version: 1\n");
    try {
      assert.equal(setConfigProvider(dir, "evil: true\nprovider").ok, false);
      assert.equal(setConfigProvider(dir, "").ok, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const bare = mkdtempSync(join(tmpdir(), "jok-noconf-"));
    try {
      assert.match(setConfigProvider(bare, "codex").error, /agentctl init/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("leaves the profile setter working on the same manifest", () => {
    const dir = manifest("version: 1\nverify:\n  test: \"npm test\"\n");
    try {
      assert.equal(setConfigProvider(dir, "codex").ok, true);
      assert.equal(setVerificationProfile(dir, "max").ok, true);
      const out = readFileSync(join(dir, ".agent", "config.yml"), "utf-8");
      assert.match(out, /^provider: codex$/m);
      assert.match(out, /^ {2}profile: max$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a rehearsal writes nothing", () => {
  it("synthesizes the envelope without queueing it", async () => {
    const dir = repoOn("main");
    try {
      const res = await runTaskCreateWizard(dir, {
        interactive: false,
        title: "Rehearse",
        prompt: "Add a retry to the webhook receiver so a 503 is retried three times",
        verifyCmd: "npm test",
        dryRun: true,
      });

      assert.equal(res.ok, true);
      assert.equal(res.dryRun, true);
      assert.equal(res.written, false);
      assert.ok(res.plan.taskFileContent, "the envelope is still fully synthesized");
      assert.equal(existsSync(res.taskFile), false, "nothing reaches the queue");

      const queueDir = join(dir, ".agent", "jules-queue");
      const queued = existsSync(queueDir) ? readdirSync(queueDir) : [];
      assert.deepEqual(queued, [], "and the queue directory is not created as a side effect");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes for real when the flag is absent", async () => {
    const dir = repoOn("main");
    try {
      const res = await runTaskCreateWizard(dir, {
        interactive: false,
        title: "For real",
        prompt: "Add a retry to the webhook receiver so a 503 is retried three times",
        verifyCmd: "npm test",
      });
      assert.equal(res.written, true);
      assert.equal(existsSync(res.taskFile), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("help text matches what the command does", () => {
  it("describes queue as the dispatcher it is", () => {
    const queue = COMMAND_REGISTRY.find((c) => c.id === "queue");
    assert.ok(queue);
    assert.equal(queue.mutates, true, "queue dispatches tasks and spends budget");
    assert.notEqual(queue.risk, "low");
    const flags = queue.flags.map((f) => f.name);
    for (const expected of ["dag", "concurrency", "dry-run"]) {
      assert.ok(flags.includes(expected), `queue --${expected} is real and must be documented`);
    }
  });
});

describe("a named target is the target", () => {
  function bareRepo() {
    const dir = mkdtempSync(join(tmpdir(), "jok-ide-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    return dir;
  }

  it("scaffolds only what was asked for", () => {
    const dir = bareRepo();
    try {
      const res = scaffoldIdeConfig("cursor", { root: dir });
      assert.deepEqual(res.results.map((r) => r.target), ["cursor"]);
      assert.equal(existsSync(join(dir, ".cursor", "mcp.json")), true);
      assert.equal(existsSync(join(dir, ".vscode", "tasks.json")), false, "VS Code was not asked for");
      assert.equal(
        existsSync(join(dir, ".agent", "claude_desktop_config.snippet.json")),
        false,
        "neither was Claude Desktop"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reaches every target when asked for all", () => {
    const dir = bareRepo();
    try {
      const res = scaffoldIdeConfig("all", { root: dir });
      assert.deepEqual(res.results.map((r) => r.target).sort(), ["claude", "cursor", "vscode"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes nothing on a rehearsal, not even the directories", () => {
    const dir = bareRepo();
    try {
      const res = scaffoldIdeConfig("all", { root: dir, dryRun: true });
      assert.equal(res.dryRun, true);
      assert.equal(res.results.length, 3, "it still reports what it would touch");
      for (const p of [".cursor", ".vscode", ".agent"]) {
        assert.equal(existsSync(join(dir, p)), false, `${p} must not be created by a rehearsal`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown target rather than falling back to all", () => {
    const dir = bareRepo();
    try {
      assert.throws(() => scaffoldIdeConfig("emacs", { root: dir }), /Invalid target/);
      assert.equal(existsSync(join(dir, ".cursor")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes the CLI's positional target through to the scaffolder", () => {
    const dir = bareRepo();
    try {
      execFileSync("node", [join(process.cwd(), "bin", "agentctl.mjs"), "mcp", "init", "vscode"], {
        cwd: dir,
        stdio: "pipe",
      });
      assert.equal(existsSync(join(dir, ".vscode", "tasks.json")), true);
      assert.equal(existsSync(join(dir, ".cursor", "mcp.json")), false, "the positional must not be ignored");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stating the whole task is not a request to be asked for it", () => {
  it("goes headless when the title and prompt are both given", () => {
    assert.equal(resolveWizardInteractivity({ fullySpecified: true }), false);
  });

  it("still defers to the TTY when the invocation is incomplete", () => {
    assert.equal(resolveWizardInteractivity({}), undefined);
    assert.equal(resolveWizardInteractivity({ fullySpecified: false }), undefined);
  });

  it("lets an explicit --interactive override a complete invocation", () => {
    assert.equal(
      resolveWizardInteractivity({ interactive: true, fullySpecified: true }),
      true,
      "the flags may be seeds to edit rather than a finished task"
    );
  });

  it("honours the explicit headless flags", () => {
    assert.equal(resolveWizardInteractivity({ yes: true }), false);
    assert.equal(resolveWizardInteractivity({ nonInteractive: true }), false);
  });
});

describe("provider readiness says what it actually checked", () => {
  it("does not claim to have run a hosted provider", () => {
    const res = probeProviderLiveness("jules", { env: {} });
    assert.equal(res.attempted, false);
    assert.match(res.detail, /cannot be validated/);
  });

  it("reports a CLI that will not start, rather than a green binary-on-PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "jok-live-"));
    try {
      const isWin = process.platform === "win32";
      const bin = join(dir, isWin ? "claude.CMD" : "claude");
      writeFileSync(bin, isWin ? "@echo off\r\nexit /b 7\r\n" : "#!/bin/sh\necho 'not logged in' >&2\nexit 7\n", { mode: 0o755 });

      const res = probeProviderLiveness("claude-code", { env: { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" } });
      assert.equal(res.attempted, true);
      assert.equal(res.ok, false, "an installed CLI that exits non-zero is not ready");
      assert.match(res.detail, /exited 7/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not attempt a probe for a CLI that is not installed", () => {
    const res = probeProviderLiveness("codex", { env: { PATH: "" } });
    assert.equal(res.attempted, false);
    assert.equal(res.ok, false);
  });
});

describe("advertised flags exist", () => {
  it("only lists doctor flags the command implements", () => {
    const doctor = COMMAND_REGISTRY.find((c) => c.id === "doctor");
    const flags = doctor.flags.map((f) => f.name);
    assert.ok(flags.includes("probe"), "--probe is real and reaches the checks");
    for (const absent of ["fix", "yes", "interactive"]) {
      assert.equal(flags.includes(absent), false, `--${absent} is not implemented, so it must not be advertised`);
    }
  });
});
