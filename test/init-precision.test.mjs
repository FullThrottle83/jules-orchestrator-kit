import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { detectPolyglotStack, bootstrapZeroTestRepo, isPlaceholderTestScript, generateSmokeTestScript } from "../src/stack-detector.mjs";
import { normalizeScope } from "../src/config.mjs";
import { checkScope } from "../src/security.mjs";

/**
 * Everything that goes wrong later goes wrong because of an answer `init`
 * gave in its first four seconds. A test command that fails on a correct
 * repository teaches the user the gate is broken, and they turn it off. One
 * that passes on a repository with nothing to run is worse, and they never
 * find out.
 */

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "jok-init-"));
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

describe("a file is not a claim: the Makefile has to declare the target", () => {
  it("does not answer `make test` when the Makefile has no test target", () => {
    // Measured before the fix: package.json declaring `vitest run`, plus a
    // Makefile with only `build:`, produced `make test` — which exits 2 with
    // "No rule to make target". A hard red on day one, on a correct repo.
    const dir = repo({
      "package.json": JSON.stringify({ name: "x", version: "1.0.0", scripts: { test: "vitest run" } }),
      Makefile: "build:\n\t@echo building\n",
    });
    try {
      assert.equal(detectPolyglotStack(dir).testCmd, "npm test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still answers `make test` when it does", () => {
    const dir = repo({
      "package.json": JSON.stringify({ name: "x", version: "1.0.0", scripts: { test: "vitest run" } }),
      Makefile: "build:\n\t@echo building\ntest:\n\t@pytest\n",
    });
    try {
      assert.equal(detectPolyglotStack(dir).testCmd, "make test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a .PHONY declaration too", () => {
    const dir = repo({ Makefile: ".PHONY: build test lint\n\nbuild:\n\t@true\n" });
    try {
      assert.equal(detectPolyglotStack(dir).stack, "make");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("app.json is configuration, not a manifest", () => {
  it("does not claim a Node stack for a Rust repository", () => {
    // Measured before the fix: `react-native`, testCmd `npm test`, in a
    // repository with no package.json in it at all.
    const dir = repo({ "Cargo.toml": '[package]\nname = "x"\n', "app.json": '{"name":"x"}' });
    try {
      assert.equal(detectPolyglotStack(dir).stack, "cargo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still detects React Native when package.json is beside it", () => {
    const dir = repo({ "app.json": '{"name":"x"}', "package.json": '{"name":"x","version":"1.0.0"}' });
    try {
      assert.equal(detectPolyglotStack(dir).stack, "react-native");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a declared test script that runs nothing is not an oracle", () => {
  const placeholders = ["echo 'no tests yet' && exit 0", "exit 0", "true", "  :  ", "echo hi; exit 0", ""];
  const real = ['echo "Error: no test specified" && exit 1', "vitest run", "npm run test:unit", "pytest -q", "go test ./..."];

  for (const cmd of placeholders) {
    it(`treats ${JSON.stringify(cmd)} as a placeholder`, () => {
      assert.equal(isPlaceholderTestScript(cmd), true);
    });
  }

  for (const cmd of real) {
    it(`treats ${JSON.stringify(cmd)} as real`, () => {
      // npm's own default exits 1. Failing loudly is the opposite of the
      // defect: it never certifies anything.
      assert.equal(isPlaceholderTestScript(cmd), false);
    });
  }

  it("no longer reports a hollow script as an existing oracle", () => {
    const dir = repo({ "package.json": JSON.stringify({ name: "h", version: "1.0.0", scripts: { test: "echo 'no tests yet' && exit 0" } }) });
    try {
      const res = bootstrapZeroTestRepo(dir, { dryRun: true });
      assert.notEqual(res.reason, "EXISTING_VERIFICATION_ORACLE", "the most dangerous repo state was being reported as healthy");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the generated fallback oracle can fail", () => {
  it("passes on sources that parse and fails on one that does not", { skip: process.platform === "win32" }, () => {
    const dir = repo({ "a.mjs": "export function ok() { return 1; }\n" });
    try {
      generateSmokeTestScript(dir);
      // The inner runner must not inherit this suite's NODE_TEST_* context, or
      // it reports into the parent harness instead of exiting non-zero — the
      // same reason the engine strips those before running a stage.
      const env = { ...process.env };
      for (const k of Object.keys(env)) if (k.startsWith("NODE_TEST_")) delete env[k];
      const run = () => spawnSync(process.execPath, ["--test", ".agent/smoke.test.mjs"], { cwd: dir, encoding: "utf-8", env });

      assert.equal(run().status, 0, "a healthy repository must pass");

      writeFileSync(join(dir, "b.mjs"), "export function broken( { return ;;; }\n");
      const bad = run();
      assert.notEqual(bad.status, 0, "the old generated test asserted only that the cwd exists, which no change can break");
      assert.match(bad.stdout, /failed to parse/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to pass with nothing to check", { skip: process.platform === "win32" }, () => {
    const dir = repo({ "notes.md": "# hi\n" });
    try {
      generateSmokeTestScript(dir);
      const env = { ...process.env };
      for (const k of Object.keys(env)) if (k.startsWith("NODE_TEST_")) delete env[k];
      const res = spawnSync(process.execPath, ["--test", ".agent/smoke.test.mjs"], { cwd: dir, encoding: "utf-8", env });
      assert.notEqual(res.status, 0, "a gate with nothing to check is not a passing gate");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("lockfiles decide which code actually runs", () => {
  const scope = normalizeScope({ deny: [], allow: [], protect: [] });
  const guarded = [
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "Cargo.lock",
    "go.sum",
    "poetry.lock",
    "composer.lock",
    ".nvmrc",
    "rust-toolchain.toml",
    "CODEOWNERS",
    ".pre-commit-config.yaml",
  ];

  for (const file of guarded) {
    it(`protects ${file}`, () => {
      // package.json was protected and package-lock.json was not, so an agent
      // could change a resolved URL or an integrity hash — swapping the code
      // that gets installed — without touching a declared dependency. The
      // entropy scanner skips lockfiles by design, so it was invisible twice.
      const res = checkScope([file], scope);
      assert.equal(res.ok, false);
      assert.equal(res.violations[0].rule, "protect");
    });
  }

  it("leaves ordinary source and docs alone", () => {
    assert.equal(checkScope(["src/index.js", "README.md", "docs/guide.md"], scope).ok, true);
  });
});
