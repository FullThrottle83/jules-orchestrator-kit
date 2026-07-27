import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { resolveProjectCommands, resolveWorkspaceExecutionBoundary } from "../scripts/command-resolver.mjs";
import { matchGlob, loadForbiddenPatterns, loadAllowedPatterns, parseAndCleanStderr } from "../scripts/jules-self-audit.mjs";
import { resolveMarkdownConflict } from "../scripts/utils.mjs";
import { redactSecrets, getDynamicGuardrails, getAlphaRange, getSlotPartitionDirective } from "../scripts/jules-dispatch.mjs";
import { extractPrUrls, auditSessions } from "../scripts/jules-cleanup.mjs";
import { scanCodebaseForTodos } from "../scripts/jules-scan-todos.mjs";

describe("Dynamic Command Resolver", () => {
  test("resolves default verification commands from manifest or config", () => {
    const res = resolveProjectCommands(process.cwd());
    assert.ok(res.source === "package.json" || res.source === ".agent/jules.yml");
    assert.equal(res.testCmd, "npm test");
    assert.equal(res.buildCmd, "");
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

describe("Security Redaction", () => {
  test("redacts active environment secrets matching denylist keys", () => {
    process.env.TEST_SECRET_KEY = "super-secret-token-12345";
    const text = "Connecting with key super-secret-token-12345 to server";
    const redacted = redactSecrets(text);
    assert.equal(redacted.includes("super-secret-token-12345"), false);
    assert.ok(redacted.includes("[REDACTED_ENV_SECRET]"));
    delete process.env.TEST_SECRET_KEY;
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
  test("package.json excludes wildcard .agent/ and includes scoped agent files", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf-8"));
    assert.ok(Array.isArray(pkg.files));
    assert.equal(pkg.files.includes(".agent/"), false, ".agent/ wildcard MUST NOT be present to prevent publishing prompt logs");
    assert.ok(pkg.files.includes(".agent/jules.yml"));
    assert.ok(pkg.files.includes(".agent/rules/"));
    assert.ok(pkg.files.includes(".agent/workflows/"));
  });
});

describe("Security Input Validation", () => {
  test("rejects malicious BASE_BRANCH values", () => {
    const SAFE_BRANCH = /^[a-zA-Z0-9._\/-]+$/;
    assert.equal(SAFE_BRANCH.test("main"), true);
    assert.equal(SAFE_BRANCH.test("feature/my-branch"), true);
    assert.equal(SAFE_BRANCH.test("main; rm -rf /"), false);
    assert.equal(SAFE_BRANCH.test("main$(whoami)"), false);
    assert.equal(SAFE_BRANCH.test("main`id`"), false);
    assert.equal(SAFE_BRANCH.test("main | cat /etc/passwd"), false);
  });

  test("rejects malicious package names in workspace filter", () => {
    const SAFE_PKG_NAME = /^[@a-zA-Z0-9._\/-]+$/;
    assert.equal(SAFE_PKG_NAME.test("@scope/pkg"), true);
    assert.equal(SAFE_PKG_NAME.test("my-package"), true);
    assert.equal(SAFE_PKG_NAME.test("foo$(whoami)"), false);
    assert.equal(SAFE_PKG_NAME.test("foo;rm -rf /"), false);
    assert.equal(SAFE_PKG_NAME.test("foo`id`"), false);
  });

  test("handles consecutive double-star wildcards without regex syntax errors", () => {
    assert.equal(matchGlob("a/secrets/b/c/foo", "**/secrets/**/**/foo"), true);
    assert.equal(matchGlob("a/public/b/c/foo", "**/secrets/**/**/foo"), false);
  });
});

describe("Workspace Boundary Resolution & Fallbacks", () => {
  test("resolves Turborepo workspace execution boundary", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jules-test-turbo-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "turbo.json"), JSON.stringify({ pipeline: {} }));
      fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "root", private: true }));
      const subDir = path.join(tmpDir, "packages", "app");
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, "package.json"), JSON.stringify({ name: "@scope/app" }));

      const res = resolveWorkspaceExecutionBoundary(["packages/app/index.js"], tmpDir);
      assert.ok(res.source.includes("Turborepo Workspace"));
      assert.ok(res.testCmd.includes("--filter=@scope/app..."));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("resolves pnpm workspace execution boundary", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jules-test-pnpm-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
      fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "root" }));
      const subDir = path.join(tmpDir, "packages", "web");
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, "package.json"), JSON.stringify({ name: "web" }));

      const res = resolveWorkspaceExecutionBoundary(["packages/web/src/App.tsx"], tmpDir);
      assert.ok(res.source.includes("pnpm Workspace"));
      assert.ok(res.testCmd.includes("--filter=...web"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("handles malformed JSON in package.json gracefully", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jules-test-badjson-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "package.json"), "{ invalid_json: ");
      const res = resolveProjectCommands(tmpDir);
      assert.equal(res.source, "generic");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Specialized Domain Guardrails", () => {
  test("triggers Sentinel guardrail on security keywords", () => {
    const rules = getDynamicGuardrails("implement auth RBAC permissions and secret token sanitization");
    assert.ok(rules.includes("Security Guidance (Sentinel)"));
  });

  test("triggers Bolt guardrail on performance keywords", () => {
    const rules = getDynamicGuardrails("optimize cache memoization and perf bottlenecks");
    assert.ok(rules.includes("Performance Guidance (Bolt)"));
  });

  test("triggers Janitor guardrail on cleanup keywords", () => {
    const rules = getDynamicGuardrails("refactor deadcode and fix lint warnings");
    assert.ok(rules.includes("Clean Code Guidance (Janitor)"));
  });

  test("triggers Alchemist guardrail on database keywords", () => {
    const rules = getDynamicGuardrails("update postgres drizzle schema migration");
    assert.ok(rules.includes("Database Guidance (Alchemist)"));
  });
});

describe("Jules Session Cleanup Auditor", () => {
  test("extracts GitHub PR URLs from session outputs", () => {
    const outputs = [
      "Created PR: https://github.com/owner/repo/pull/42 successfully",
      { link: "https://github.com/owner/repo/pull/99" }
    ];
    const prs = extractPrUrls(outputs);
    assert.deepEqual(prs, ["https://github.com/owner/repo/pull/42", "https://github.com/owner/repo/pull/99"]);
  });

  test("categorizes stale and active sessions accurately", () => {
    const now = Date.now();
    const staleTime = new Date(now - 30 * 60 * 60 * 1000).toISOString(); // 30h ago
    const activeTime = new Date(now - 2 * 60 * 60 * 1000).toISOString(); // 2h ago

    const sessions = [
      { id: "s1", title: "Active task", state: "IN_PROGRESS", updateTime: activeTime },
      { id: "s2", title: "Stale task", state: "AWAITING_USER_FEEDBACK", updateTime: staleTime }
    ];

    const { merged, active, stale } = auditSessions(sessions, { staleHoursThreshold: 24 });
    assert.equal(merged.length, 0);
    assert.equal(active.length, 1);
    assert.equal(active[0].id, "s1");
    assert.equal(stale.length, 1);
    assert.equal(stale[0].id, "s2");
  });
});

describe("Markdown Conflict Resolver", () => {
  test("concatenates HEAD and DEV buffers when conflict markers are present", () => {
    const conflicted = `
# Header
<<<<<<< HEAD
- Feature A added
=======
- Feature B added
>>>>>>> dev
Footer
`.trim();

    const resolved = resolveMarkdownConflict(conflicted);
    assert.equal(resolved.includes("<<<<<<<"), false);
    assert.equal(resolved.includes("======="), false);
    assert.equal(resolved.includes(">>>>>>>"), false);
    assert.ok(resolved.includes("- Feature A added"));
    assert.ok(resolved.includes("- Feature B added"));
  });

  test("returns unmodified text when no conflict markers are present", () => {
    const normal = "# Clean Markdown\n- item 1";
    assert.equal(resolveMarkdownConflict(normal), normal);
  });
});

describe("Parallel Slot Partitioning", () => {
  test("computes correct alphabetical ranges for concurrent slots", () => {
    assert.equal(getAlphaRange(0, 2), "A–M");
    assert.equal(getAlphaRange(1, 2), "N–Z");
  });

  test("builds parallel slot directive when slot index and total are valid", () => {
    const directive = getSlotPartitionDirective("1", "3");
    assert.ok(directive.includes("1 of 3"));
    assert.ok(directive.includes("Partition Focus"));
  });

  test("returns empty string when total slots <= 1", () => {
    assert.equal(getSlotPartitionDirective("1", "1"), "");
  });
});

describe("Repoless Session Mode Execution", () => {
  test("executes jules-dispatch.mjs in repoless mode via CLI flag", () => {
    const scriptPath = path.resolve(process.cwd(), "scripts/jules-dispatch.mjs");
    const output = execFileSync("node", [scriptPath, "Repoless Task", "Analyze data", "--repoless"], {
      env: { ...process.env, JULES_DRY_RUN: "1" },
      encoding: "utf-8",
    });
    assert.ok(output.includes("(repoless / serverless)"), "Repoless dry run target must be reported");
  });
});

describe("Suggested Tasks Scanner", () => {
  test("scans temporary directory for TODO and FIXME comments", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jules-test-scan-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "file1.js"), "// TODO: refactor auth logic\nconst a = 1;");
      fs.writeFileSync(path.join(tmpDir, "file2.py"), "# FIXME: fix memory leak\npass");

      const tasks = scanCodebaseForTodos(tmpDir);
      assert.equal(tasks.length, 2);
      assert.ok(tasks.some((t) => t.tag === "TODO" && t.priority === "MEDIUM"));
      assert.ok(tasks.some((t) => t.tag === "FIXME" && t.priority === "HIGH"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});




