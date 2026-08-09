import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseYaml, detectStack, loadConfig, normalizePath } from "../src/config.mjs";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

describe("src/config.mjs", () => {
  it("parseYaml parses key-value pairs and arrays", () => {
    const yaml = `
version: 1
provider: jules
forbidden_paths:
  - ".github/**"
  - "**/*.pem"
limits:
  diff_kb: 50
`;
    const parsed = parseYaml(yaml);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.provider, "jules");
    assert.deepEqual(parsed.forbidden_paths, [".github/**", "**/*.pem"]);
    assert.equal(parsed.limits?.diff_kb, 50);
  });

  it("normalizePath converts backslashes to forward slashes", () => {
    assert.equal(normalizePath("foo\\bar\\baz.txt"), "foo/bar/baz.txt");
  });

  it("detectStack detects package.json node project", () => {
    const res = detectStack(process.cwd());
    assert.equal(res.stack, "node");
    assert.equal(res.testCmd, "npm test");
  });

  it("loadConfig returns default configuration when no file exists", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "no-config-"));
    try {
      const cfg = loadConfig(tmp);
      assert.equal(cfg.version, 1);
      assert.ok(Array.isArray(cfg.scope.deny));
      assert.equal(cfg.limits.diffKb, 75);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("detects pnpm-workspace.yaml and returns correct pnpm recursive test command", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-workspace-"));
    try {
      fs.writeFileSync(path.join(tmp, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
      const res = detectStack(tmp);
      assert.equal(res.stack, "pnpm");
      assert.equal(res.testCmd, "pnpm -r test");
      assert.equal(res.buildCmd, "pnpm -r build");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("gracefully falls back when package.json contains malformed syntax", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "malformed-pkg-"));
    try {
      fs.writeFileSync(path.join(tmp, "package.json"), "invalid json {");
      const res = detectStack(tmp);
      assert.equal(res.stack, "node");
      assert.equal(res.testCmd, "npm test");
      assert.equal(res.buildCmd, "npm run build");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("gracefully falls back when package.json is an empty object", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "empty-pkg-"));
    try {
      fs.writeFileSync(path.join(tmp, "package.json"), "{}");
      const res = detectStack(tmp);
      assert.equal(res.stack, "node");
      assert.equal(res.testCmd, "npm test");
      assert.equal(res.buildCmd, "");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("handles null or undefined root parameter in loadConfig()", () => {
    // Calling with null
    const cfgNull = loadConfig(null);
    assert.ok(cfgNull.version);
    assert.equal(cfgNull.limits.diffKb, 75);

    // Calling with undefined
    const cfgUndefined = loadConfig(undefined);
    assert.ok(cfgUndefined.version);
    assert.equal(cfgUndefined.limits.diffKb, 75);
  });
});
