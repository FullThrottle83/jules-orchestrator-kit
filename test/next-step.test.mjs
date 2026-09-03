import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { resolveNextStep, renderNextStep } from "../src/ops/next-step.mjs";

function bareDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function gitDir(prefix) {
  const dir = bareDir(prefix);
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  return dir;
}

/** A key-free environment, so the host's real shell cannot skew the ladder. */
const NO_KEY = {};
const WITH_KEY = { JULES_API_KEY: "test-key" };

describe("src/ops/next-step.mjs", () => {
  it("asks for a git repository before anything else", () => {
    const dir = bareDir("jok-next-nogit-");
    try {
      const step = resolveNextStep(dir, WITH_KEY);
      assert.equal(step.id, "git");
      assert.equal(step.blocking, true);
      assert.match(step.command, /git init/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("asks for init once git exists but no config does", () => {
    const dir = gitDir("jok-next-noconfig-");
    try {
      const step = resolveNextStep(dir, WITH_KEY);
      assert.equal(step.id, "init");
      assert.match(step.command, /agentctl init/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("asks for a key once a hosted-provider repo is configured", () => {
    const dir = gitDir("jok-next-nokey-");
    try {
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\n");

      const step = resolveNextStep(dir, NO_KEY);
      assert.equal(step.id, "provider");
      assert.equal(step.blocking, false, "gate and dry-run still work without a key");
      assert.match(step.detail, /every verification gate works with no provider/);
      assert.match(step.command, /JULES_API_KEY/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts the legacy key variable", () => {
    const dir = gitDir("jok-next-legacykey-");
    try {
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\n");

      assert.notEqual(resolveNextStep(dir, { GEMINI_API_KEY: "k" }).id, "provider");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not demand an API key from a repo driving a local CLI provider", () => {
    const dir = gitDir("jok-next-execprovider-");
    try {
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\nprovider: claude-code\n");

      // No key anywhere, and a PATH that holds the CLI the provider spawns.
      const binDir = join(dir, "fakebin");
      mkdirSync(binDir, { recursive: true });
      const binName = process.platform === "win32" ? "claude.CMD" : "claude";
      writeFileSync(join(binDir, binName), "#!/bin/sh\n", { mode: 0o755 });

      const step = resolveNextStep(dir, { PATH: binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" });
      assert.notEqual(step.id, "provider", "an exec provider on PATH is ready without any key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the missing binary, not a key, for an unavailable local CLI provider", () => {
    const dir = gitDir("jok-next-missingbin-");
    try {
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\nprovider: codex\n");

      const emptyBin = join(dir, "emptybin");
      mkdirSync(emptyBin, { recursive: true });

      const step = resolveNextStep(dir, { PATH: emptyBin });
      assert.equal(step.id, "provider");
      assert.match(step.reason ?? step.detail, /codex/);
      assert.doesNotMatch(step.command, /JULES_API_KEY/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("points at the queue when work is already waiting", () => {
    const dir = gitDir("jok-next-queue-");
    try {
      mkdirSync(join(dir, ".agent", "queue"), { recursive: true });
      writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\n");
      writeFileSync(join(dir, ".agent", "queue", "task-1.md"), "# Task ID: 1\n\nFix issue");

      const step = resolveNextStep(dir, WITH_KEY);
      assert.equal(step.id, "queue");
      assert.match(step.headline, /1 task/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not count queue README.md as a pending task", () => {
    const dir = gitDir("jok-next-queue-readme-");
    try {
      mkdirSync(join(dir, ".agent", "jules-queue"), { recursive: true });
      writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\n");
      writeFileSync(join(dir, ".agent", "jules-queue", "README.md"), "# Task Queue\nExplanation");

      const step = resolveNextStep(dir, WITH_KEY);
      assert.notEqual(step.id, "queue");
      assert.equal(step.id, "ready");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("suggests a dispatch when everything is in place", () => {
    const dir = gitDir("jok-next-ready-");
    try {
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(join(dir, ".agent", "jules.yml"), "version: 1\n");

      const step = resolveNextStep(dir, WITH_KEY);
      assert.equal(step.id, "ready");
      assert.match(step.detail, /--dry-run/, "previewing costs nothing and should be offered first");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders a greeting that names the action and where to find the rest", () => {
    const out = renderNextStep({
      version: "9.9.9",
      root: "/tmp/x",
      next: { headline: "H", detail: "D", command: "agentctl init" },
      budgetLine: "3 / 10 used",
    });

    assert.match(out, /agentctl v9\.9\.9/);
    assert.match(out, /Next:\s+agentctl init/);
    assert.match(out, /3 \/ 10 used/);
    assert.match(out, /agentctl --help/, "the full reference must stay one hop away");
  });

  it("omits the budget line when none applies", () => {
    const out = renderNextStep({
      version: "1.0.0",
      root: "/tmp/x",
      next: { headline: "H", detail: "D", command: "git init" },
    });
    assert.doesNotMatch(out, /Budget:/);
  });
});
