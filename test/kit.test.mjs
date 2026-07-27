import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveProjectCommands, resolveWorkspaceExecutionBoundary } from "../scripts/command-resolver.mjs";
import { matchGlob, loadForbiddenPatterns, loadAllowedPatterns, parseAndCleanStderr } from "../scripts/jules-self-audit.mjs";
import { calculateEntropy, redactSecrets, assertPathWithinWorkspace } from "../scripts/jules-dispatch.mjs";

describe("Dynamic Command Resolver", () => {
  test("resolves default verification commands from manifest or config", () => {
    const res = resolveProjectCommands(process.cwd());
    assert.ok(res.source === "package.json" || res.source === ".agent/jules.yml");
    assert.equal(res.testCmd, "npm test");
  });

  test("resolves workspace execution boundary", () => {
    const res = resolveWorkspaceExecutionBoundary(["package.json"], process.cwd());
    assert.ok(res.source);
  });
});

describe("Glob Matcher (matchGlob)", () => {
  test("matches root-level files with **/ wildcard patterns", () => {
    assert.equal(matchGlob("secrets/prod.env", "**/secrets/**"), true);
    assert.equal(matchGlob("app/secrets/keys.txt", "**/secrets/**"), true);
    assert.equal(matchGlob("key.pem", "**/*.pem"), true);
    assert.equal(matchGlob("config/key.pem", "**/*.pem"), true);
    assert.equal(matchGlob(".github/workflows/ci.yml", ".github/**"), true);
  });

  test("normalizes Windows backslashes in filepaths", () => {
    assert.equal(matchGlob("secrets\\prod.env", "**/secrets/**"), true);
    assert.equal(matchGlob("app\\secrets\\keys.txt", "**/secrets/**"), true);
    assert.equal(matchGlob("config\\key.pem", "**/*.pem"), true);
    assert.equal(matchGlob(".github\\workflows\\ci.yml", ".github/**"), true);
  });

  test("does not match non-matching files", () => {
    assert.equal(matchGlob("src/index.ts", "**/secrets/**"), false);
    assert.equal(matchGlob("src/main.js", "**/*.pem"), false);
    assert.equal(matchGlob("scripts/jules/x.mjs", "scripts/jules-*"), false);
  });
});

describe("Forbidden & Allowed Patterns Parser", () => {
  test("always includes default immutable security paths when config is empty or missing", () => {
    const patterns = loadForbiddenPatterns("");
    assert.ok(patterns.includes("scripts/jules-*"));
    assert.ok(patterns.includes(".agent/jules.yml"));
    assert.ok(patterns.includes(".github/**"));
  });

  test("parses flow-style YAML arrays", () => {
    const yaml = 'forbidden_paths: [".github/**", "secrets/**"]';
    const patterns = loadForbiddenPatterns(yaml);
    assert.ok(patterns.includes(".github/**"));
    assert.ok(patterns.includes("secrets/**"));
  });

  test("parses block-style YAML arrays and preserves immutable defaults", () => {
    const yaml = `
version: 2
forbidden_paths:
  - ".github/**"
  - "custom/secrets/*"
`;
    const patterns = loadForbiddenPatterns(yaml);
    assert.ok(patterns.includes(".github/**"));
    assert.ok(patterns.includes("custom/secrets/*"));
    assert.ok(patterns.includes("scripts/jules-*"));
  });

  test("parses allow_paths from trusted base config", () => {
    const yaml = `
version: 2
allow_paths:
  - "scripts/jules-*"
  - ".github/**"
`;
    const allowed = loadAllowedPatterns(yaml);
    assert.ok(allowed.includes("scripts/jules-*"));
    assert.ok(allowed.includes(".github/**"));
  });
});

describe("Shannon Entropy & Security Redaction", () => {
  test("calculates low entropy for repetitive text and high entropy for random tokens", () => {
    assert.ok(calculateEntropy("aaaaaaaaaaaaaaaaaaaa") < 1.0);
    assert.ok(calculateEntropy("8f9a2b7c4d1e6f0a9b8c7d6e5f4a3b2c1d0e9f8a") > 3.5);
    assert.ok(calculateEntropy("a8F9+a2B7/c4D1e6F0a9B8c7D6e5F4a3B2c1D0e9F8a+xyz=123456!@#$%^&*()") > 4.0);
  });

  test("redacts high entropy tokens from prompts while preserving file paths", () => {
    const prompt = "Inspect apps/web/src/utils/rate-limit.ts using key 8f9a2b7c4d1e6f0a9b8c7d6e5f4a3b2c1d0e9f8a";
    const redacted = redactSecrets(prompt);
    assert.ok(redacted.includes("apps/web/src/utils/rate-limit.ts"), "File path must NOT be redacted");
    assert.ok(redacted.includes("[REDACTED_ENTROPY_KEY]"), "Secret key must be redacted");
  });

  test("asserts path within workspace root and blocks traversal", () => {
    const safe = assertPathWithinWorkspace("package.json");
    assert.ok(safe.includes("package.json"));
    assert.throws(() => {
      assertPathWithinWorkspace("../../../etc/passwd");
    }, /FATAL: Sandboxed directory traversal breach blocked/);
  });
});

describe("Main Module Dispatch Execution (CLI Dry-Run)", () => {
  test("executes jules-dispatch.mjs directly without runtime crashes", () => {
    const scriptPath = path.resolve(process.cwd(), "scripts/jules-dispatch.mjs");
    const output = execFileSync("node", [scriptPath, "Test Swarm Task", "Test Prompt Description"], {
      env: { ...process.env, JULES_DRY_RUN: "1" },
      encoding: "utf-8",
    });
    assert.ok(output.includes("[DRY RUN] Dispatch payload prepared successfully"), "Dispatch dry run must succeed");
  });
});

describe("Self-Healing OODA Feedback Parser", () => {
  test("strips ANSI color codes and extracts tail of stderr", () => {
    const raw = "\x1B[31mError: Test failed\x1B[0m\nLine 2\nLine 3";
    const cleaned = parseAndCleanStderr(raw);
    assert.equal(cleaned.includes("\x1B[31m"), false);
    assert.ok(cleaned.includes("Error: Test failed"));
  });
});

describe("Dynamic Guardrails Triggers Regex", () => {
  const dgcPath = path.resolve(process.cwd(), ".agent/rules/dynamic-guardrails.json");
  const dgc = JSON.parse(fs.readFileSync(dgcPath, "utf-8"));

  test("Astro trigger fires on .astro files, not on standard text", () => {
    const astroRule = dgc.rules.find((r) => r.trigger.includes("astro"));
    const regex = new RegExp(astroRule.trigger, "i");
    assert.equal(regex.test("edit src/components/Header.astro"), true);
    assert.equal(regex.test("edit src/components/Header.tsx"), false);
  });

  test("Database trigger uses word boundaries and ignores substring matches like feedback", () => {
    const dbRule = dgc.rules.find((r) => r.trigger.includes("db"));
    const regex = new RegExp(dbRule.trigger, "i");
    assert.equal(regex.test("add user feedback form"), false, "feedback should not trigger db rule");
    assert.equal(regex.test("refactor breadboard component"), false, "breadboard should not trigger db rule");
    assert.equal(regex.test("fix the db migration script"), true);
    assert.equal(regex.test("query database for user"), true);
    assert.equal(regex.test("update drizzle schema"), true);
    assert.equal(regex.test("setup PostgreSQL connection pool"), true);
    assert.equal(regex.test("configure SQLite database"), true);
    assert.equal(regex.test("connect to MySQL cluster"), true);
  });
});

describe("Package Manifest Verification", () => {
  test("package.json includes .agent/ in files array for npm publication", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf-8"));
    assert.ok(Array.isArray(pkg.files));
    assert.ok(pkg.files.includes(".agent/"), ".agent/ directory must be included in package.json files array");
  });
});

