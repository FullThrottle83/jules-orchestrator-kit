import test from "node:test";
import assert from "node:assert/strict";
import { detectStackOracles, runVerificationProbe } from "../src/wizard-oracle.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Stack Oracle & Verification Probes", async (t) => {
  await t.test("detects Node.js scripts and TypeScript typecheck oracle from package.json and tsconfig.json", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "jules-oracle-node-"));
    try {
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({
          name: "test-node-app",
          scripts: {
            test: "node --test",
            build: "node build.js",
            lint: "eslint .",
          },
        })
      );
      writeFileSync(join(tmpDir, "tsconfig.json"), "{}");

      const res = detectStackOracles(tmpDir);
      assert.equal(res.candidates.testCmd, "npm test");
      assert.equal(res.candidates.buildCmd, "npm run build");
      assert.equal(res.candidates.lintCmd, "npm run lint");
      assert.equal(res.candidates.typecheckCmd, "npx tsc --noEmit");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("detects Cargo workspace oracle candidates from Cargo.toml", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "jules-oracle-cargo-"));
    try {
      writeFileSync(
        join(tmpDir, "Cargo.toml"),
        `[workspace]\nmembers = ["cli"]\n`
      );

      const res = detectStackOracles(tmpDir);
      assert.equal(res.candidates.testCmd, "cargo test --workspace");
      assert.equal(res.candidates.buildCmd, "cargo build --workspace");
      assert.equal(res.candidates.lintCmd, "cargo clippy --workspace -- -D warnings");
      assert.equal(res.candidates.typecheckCmd, "cargo check --workspace");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("runVerificationProbe executes successful command and returns ok: true", async () => {
    const res = await runVerificationProbe("node -e 'process.exit(0)'");
    assert.equal(res.ok, true);
    assert.equal(res.code, 0);
    assert.equal(typeof res.durationMs, "number");
  });

  await t.test("runVerificationProbe executes failing command and returns ok: false", async () => {
    const res = await runVerificationProbe("node -e 'process.exit(1)'");
    assert.equal(res.ok, false);
    assert.equal(res.code, 1);
  });
});
