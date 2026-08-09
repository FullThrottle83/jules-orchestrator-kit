import test from "node:test";
import assert from "node:assert/strict";
import { planInit, loadPresets, runInitWizard, TIER_PROFILES } from "../src/wizard-init.mjs";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

test("Interactive Onboarding & Presets Engine", async (t) => {
  await t.test("planInit generates valid config and jules manifests for Pro tier", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "jules-init-test-"));
    try {
      const plan = planInit(tmpDir, { tier: "pro", testCmd: "npm test", presets: ["nightly-security-audit"] });

      assert.equal(plan.tier, "pro");
      assert.equal(plan.limits.concurrency, TIER_PROFILES.pro.concurrency);
      assert.ok(plan.configYaml.includes("tier: pro"));
      assert.ok(plan.configYaml.includes('test: "npm test"'));
      assert.ok(plan.julesYaml.includes('test_cmd: "npm test"'));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("loadPresets loads built-in presets and repository presets from .agent/presets/", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "jules-presets-test-"));
    try {
      const presetsDir = join(tmpDir, ".agent", "presets");
      mkdirSync(presetsDir, { recursive: true });
      writeFileSync(
        join(presetsDir, "custom-audit.yml"),
        `id: custom-audit\ntitle: Custom Security Audit\ndescription: Custom audit rule\ncron: "0 0 * * *"\n`
      );

      const presets = loadPresets(tmpDir);
      assert.ok(presets.some((p) => p.id === "nightly-security-audit"));
      assert.ok(presets.some((p) => p.id === "custom-audit"));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("runInitWizard in non-TTY mode generates .agent/config.yml and .agent/jules.yml atomically", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "jules-init-wizard-"));
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();

    try {
      const res = await runInitWizard(tmpDir, {
        interactive: false,
        tier: "pro",
        testCmd: "npm test",
        stdin: mockStdin,
        stdout: mockStdout,
      });

      assert.equal(res.ok, true);
      assert.ok(existsSync(join(tmpDir, ".agent", "config.yml")));
      assert.ok(existsSync(join(tmpDir, ".agent", "jules.yml")));

      const configContent = readFileSync(join(tmpDir, ".agent", "config.yml"), "utf-8");
      assert.ok(configContent.includes("provider: jules"));
      assert.ok(configContent.includes("tier: pro"));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("planInit preserves existing config fields upon re-initialization", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "jules-init-preserve-"));
    try {
      const agentDir = join(tmpDir, ".agent");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, "config.yml"),
        "version: 1\nprovider: custom-jules\nbranch_prefix: custom-agent/\nbase_branch: develop\n"
      );

      const plan = planInit(tmpDir, { tier: "enterprise", testCmd: "npm test" });
      assert.equal(plan.tier, "enterprise");
      assert.ok(plan.configYaml.includes("provider: custom-jules"));
      assert.ok(plan.configYaml.includes("branch_prefix: custom-agent/"));
      assert.ok(plan.configYaml.includes("base_branch: develop"));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("runInitWizard in non-TTY mode throws error if required parameters are missing and allowDefaults is false", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "jules-init-nontty-fail-"));
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();

    try {
      await assert.rejects(
        async () => {
          await runInitWizard(tmpDir, {
            interactive: false,
            stdin: mockStdin,
            stdout: mockStdout,
          });
        },
        /Non-interactive init requires explicit options/
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
