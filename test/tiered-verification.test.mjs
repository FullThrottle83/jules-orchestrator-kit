import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectPolyglotStack } from "../src/stack-detector.mjs";
import { loadConfig, parseYaml } from "../src/config.mjs";
import { planInit } from "../src/wizard-init.mjs";
import { runDoctorChecks } from "../src/ops/doctor-registry.mjs";
import { resolveProjectCommands } from "../scripts/command-resolver.mjs";
import { gate } from "../src/engine.mjs";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

describe("Tiered Verification, Offline Execution Policy & Foundry Stack", () => {
  it("detectPolyglotStack detects Foundry/Solidity projects with offline execution commands", () => {
    const tmp = mkdtempSync(join(tmpdir(), "foundry-stack-"));
    try {
      writeFileSync(join(tmp, "foundry.toml"), '[profile.default]\nsrc = "src"\ntest = "test"\n', "utf-8");
      const res = detectPolyglotStack(tmp);
      assert.equal(res.stack, "foundry");
      assert.equal(res.testCmd, "forge test --offline");
      assert.equal(res.buildCmd, "forge build --offline");
      assert.equal(res.fmtCmd, "forge fmt --check");
      assert.equal(res.fuzzCmd, "forge test --offline --match-test testFuzz");
      assert.equal(res.invariantCmd, "forge test --offline --match-test invariant");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("detectPolyglotStack detects Hardhat projects", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hardhat-stack-"));
    try {
      writeFileSync(join(tmp, "hardhat.config.js"), "module.exports = {};", "utf-8");
      const res = detectPolyglotStack(tmp);
      assert.equal(res.stack, "hardhat");
      assert.equal(res.testCmd, "npx hardhat test");
      assert.equal(res.buildCmd, "npx hardhat compile");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("loadConfig parses tiered verification commands from .agent/jules.yml", () => {
    const tmp = mkdtempSync(join(tmpdir(), "tiered-cfg-"));
    try {
      mkdirSync(join(tmp, ".agent"), { recursive: true });
      const yaml = `
verify:
  lint: "npm run lint"
  unit: "npm test"
  fuzz: "npm run test:fuzz"
  invariant: "npm run test:invariant"
  e2e: "npm run test:e2e"
  build: "npm run build"
  policy:
    networkAccess: "forbidden"
    offline: true
evidence:
  enabled: true
  strict_test_lock: true
`;
      writeFileSync(join(tmp, ".agent", "jules.yml"), yaml, "utf-8");
      const cfg = loadConfig(tmp);
      assert.equal(cfg.verify.lint, "npm run lint");
      assert.equal(cfg.verify.unit, "npm test");
      assert.equal(cfg.verify.fuzz, "npm run test:fuzz");
      assert.equal(cfg.verify.invariant, "npm run test:invariant");
      assert.equal(cfg.verify.e2e, "npm run test:e2e");
      assert.equal(cfg.verify.policy.networkAccess, "forbidden");
      assert.equal(cfg.verify.policy.offline, true);
      assert.equal(cfg.evidence.enabled, true);
      assert.equal(cfg.evidence.strictTestLock, true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("canonical config wins when both canonical and legacy manifests exist", () => {
    const tmp = mkdtempSync(join(tmpdir(), "canonical-precedence-"));
    try {
      mkdirSync(join(tmp, ".agent"), { recursive: true });
      writeFileSync(join(tmp, ".agent", "config.yml"), 'verify:\n  test: "canonical-test"\n', "utf-8");
      writeFileSync(join(tmp, ".agent", "jules.yml"), 'test_cmd: "legacy-test"\n', "utf-8");
      const cfg = loadConfig(tmp);
      assert.equal(cfg.verify.test, "canonical-test");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("command resolver uses canonical config before legacy jules.yml", () => {
    const tmp = mkdtempSync(join(tmpdir(), "canonical-commands-"));
    try {
      mkdirSync(join(tmp, ".agent"), { recursive: true });
      writeFileSync(join(tmp, ".agent", "config.yml"), 'verify:\n  test: "canonical-test"\n', "utf-8");
      writeFileSync(join(tmp, ".agent", "jules.yml"), 'test_cmd: "legacy-test"\n', "utf-8");
      const res = resolveProjectCommands(tmp);
      assert.equal(res.testCmd, "canonical-test");
      assert.equal(res.source, ".agent/config.yml");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("planInit migrates legacy verification and scope into canonical config", () => {
    const tmp = mkdtempSync(join(tmpdir(), "legacy-migration-"));
    try {
      mkdirSync(join(tmp, ".agent"), { recursive: true });
      writeFileSync(
        join(tmp, ".agent", "jules.yml"),
        'test_cmd: "legacy-test"\nbuild_cmd: "legacy-build"\nforbidden_paths:\n  - "private/**"\nallow_paths:\n  - "private/fixture.txt"\n',
        "utf-8"
      );
      const plan = planInit(tmp, { provider: "jules", tier: "free", baseBranch: "main", profile: "standard" });
      const parsed = parseYaml(plan.configYaml);
      assert.equal(plan.verify.test, "legacy-test");
      assert.equal(plan.verify.build, "legacy-build");
      assert.deepEqual(parsed.scope?.deny, ["private/**"]);
      assert.deepEqual(parsed.scope?.allow, ["private/fixture.txt"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("doctor reports deterministic migration guidance for legacy-only config", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "legacy-doctor-"));
    try {
      mkdirSync(join(tmp, ".agent"), { recursive: true });
      writeFileSync(join(tmp, ".agent", "jules.yml"), 'test_cmd: "node -e \\"console.log(1)\\""\n', "utf-8");
      const report = await runDoctorChecks({ root: tmp, activeProbe: false });
      const configResult = report.results.find((entry) => entry.id === "config.present");
      assert.equal(configResult?.status, "warn");
      assert.match(configResult?.summary || "", /migrate to canonical \.agent\/config\.yml/i);
      assert.match(configResult?.fixes?.[0]?.summary || "", /agentctl init --yes/i);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resolveProjectCommands returns tiered verification commands and policy", () => {
    const tmp = mkdtempSync(join(tmpdir(), "cmd-res-"));
    try {
      mkdirSync(join(tmp, ".agent"), { recursive: true });
      const yaml = `
verify:
  lint: "forge fmt --check"
  test: "forge test --offline"
  fuzz: "forge test --offline --match-test testFuzz"
  build: "forge build --offline"
`;
      writeFileSync(join(tmp, ".agent", "jules.yml"), yaml, "utf-8");
      const res = resolveProjectCommands(tmp);
      assert.equal(res.lintCmd, "forge fmt --check");
      assert.equal(res.testCmd, "forge test --offline");
      assert.equal(res.fuzzCmd, "forge test --offline --match-test testFuzz");
      assert.equal(res.buildCmd, "forge build --offline");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("gate executes tiered stages sequentially and records execution evidence", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gate-tiered-"));
    try {
      execSync("git init -b main", { cwd: tmp, stdio: "ignore" });
      execSync("git config user.name 'Test'", { cwd: tmp, stdio: "ignore" });
      execSync("git config user.email 'test@test.com'", { cwd: tmp, stdio: "ignore" });
      execSync("git commit --allow-empty -m 'initial'", { cwd: tmp, stdio: "ignore" });

      mkdirSync(join(tmp, ".agent"), { recursive: true });
      mkdirSync(join(tmp, "test"), { recursive: true });
      writeFileSync(join(tmp, "test", "dummy.test.js"), "assert.equal(2 + 2, 4);", "utf-8");

      const step1Flag = join(tmp, "step1.done").replace(/\\/g, "/");
      const step2Flag = join(tmp, "step2.done").replace(/\\/g, "/");

      // Each stage prints a count as well as writing its flag. This test is
      // about stage ordering and evidence records, but the stages still have to
      // be things the gate will accept: a command that exits 0 having written
      // nothing on either stream now fails the collection floor, because that
      // is what `pnpm -r test` looks like on a workspace with no test scripts.

      const yaml = `
verify:
  lint: node -e "require('fs').writeFileSync('${step1Flag}', 'ok'); console.log('collected 1 items')"
  unit: node -e "require('fs').writeFileSync('${step2Flag}', 'ok'); console.log('collected 1 items')"
  policy:
    networkAccess: "forbidden"
`;
      writeFileSync(join(tmp, ".agent", "jules.yml"), yaml, "utf-8");
      execSync('git add . && git commit -m "setup verification config"', { cwd: tmp, stdio: "ignore" });

      const res = await gate({ root: tmp, base: "main" });
      assert.equal(res.ok, true);
      assert.equal(res.code, 0);
      assert.ok(res.evidence);
      assert.equal(res.evidence.executionRecords.length, 2);
      assert.equal(res.evidence.executionRecords[0].id, "lint");
      assert.equal(res.evidence.executionRecords[0].networkAccess, "forbidden");
      assert.equal(res.evidence.executionRecords[1].id, "unit");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
