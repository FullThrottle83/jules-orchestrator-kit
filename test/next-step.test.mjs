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

  it("asks for a key once the repo is configured", () => {
    const dir = gitDir("jok-next-nokey-");
    try {
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\n");

      const step = resolveNextStep(dir, NO_KEY);
      assert.equal(step.id, "key");
      assert.equal(step.blocking, false, "gate and dry-run still work without a key");
      assert.match(step.detail, /never written to config/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts the legacy key variable", () => {
    const dir = gitDir("jok-next-legacykey-");
    try {
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\n");

      assert.notEqual(resolveNextStep(dir, { GEMINI_API_KEY: "k" }).id, "key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("points at the queue when work is already waiting", () => {
    const dir = gitDir("jok-next-queue-");
    try {
      mkdirSync(join(dir, ".agent", "queue"), { recursive: true });
      writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\n");
      writeFileSync(join(dir, ".agent", "queue", "task-1.json"), "{}");

      const step = resolveNextStep(dir, WITH_KEY);
      assert.equal(step.id, "queue");
      assert.match(step.headline, /1 task/);
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
