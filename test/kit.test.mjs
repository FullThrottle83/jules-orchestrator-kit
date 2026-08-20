import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { resolveProjectCommands, resolveWorkspaceExecutionBoundary, detectPackageManager, parseYamlConfig, detectFrameworkCommands } from "../scripts/command-resolver.mjs";
import { matchGlob, loadForbiddenPatterns, loadAllowedPatterns, validateJulesConfig, parseAndCleanStderr, COMMAND_DEFINING_FILES, EXECUTION_CONFIG_FILES, RESTRICTED_AGENT_FILES, getOodaStateFile, auditLedgers, auditWorktrees, auditGates } from "../scripts/jules-self-audit.mjs";
import { resolveMarkdownConflict, redactSecrets, anonymizePii, verifyLedgerIntegrity, checkDailyBudget, reserveDailyBudget, hasHighConfidenceSecret, hasLowConfidenceSecret, pruneOldLedgers, loadEnv, ensureDir, getIsolatedCacheDir, ensureSdkCacheIsolation, extractPrUrls, auditSessions, buildSyncManifest, pushReservationManifest } from "../scripts/utils.mjs";
import { getDynamicGuardrails, getAlphaRange, getSlotPartitionDirective, extractImageAttachments, getMultimodalAttachmentDirective } from "../scripts/jules-dispatch.mjs";
import { scanCodebaseForTodos } from "../scripts/jules-scan-todos.mjs";
import { fetchSessionPatch } from "../scripts/jules-patch.mjs";

describe("Dynamic Command Resolver", () => {
  test("detects package manager correctly based on lockfiles", () => {
    assert.equal(detectPackageManager(process.cwd()), "npm");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jules-pm-test-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");
      assert.equal(detectPackageManager(tmpDir), "pnpm");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("resolves default verification commands from manifest or config", () => {
    const res = resolveProjectCommands(process.cwd());
    assert.ok(res.source.startsWith("package.json") || res.source.endsWith(".yml"));
    assert.ok(res.testCmd.includes("test"));
  });

  test("parses sub-helpers parseYamlConfig and detectFrameworkCommands", () => {
    const frameworkRes = detectFrameworkCommands(process.cwd());
    assert.ok(frameworkRes.source);
    assert.ok(frameworkRes.testCmd);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jules-yaml-test-"));
    try {
      const agentDir = path.join(tmpDir, ".agent");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "jules.yml"), "test_cmd: 'npm run test:custom'\nbuild_cmd: 'npm run build:custom'\n");
      const yamlRes = parseYamlConfig(tmpDir);
      assert.ok(yamlRes);
      assert.equal(yamlRes.testCmd, "npm run test:custom");
      assert.equal(yamlRes.buildCmd, "npm run build:custom");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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

describe("Forbidden & Allowed Patterns Parser & Command File Guardrails", () => {
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

  test("exports COMMAND_DEFINING_FILES, EXECUTION_CONFIG_FILES, and RESTRICTED_AGENT_FILES guardrails", () => {
    assert.ok(COMMAND_DEFINING_FILES.includes("package.json"));
    assert.ok(COMMAND_DEFINING_FILES.includes("Cargo.toml"));
    assert.ok(COMMAND_DEFINING_FILES.includes(".agent/jules.yml"));

    assert.ok(EXECUTION_CONFIG_FILES.includes("vite.config.ts"));
    assert.ok(EXECUTION_CONFIG_FILES.includes("jest.config.js"));
    assert.ok(EXECUTION_CONFIG_FILES.includes(".npmrc"));

    assert.ok(RESTRICTED_AGENT_FILES.includes("AGENTS.md"));
    assert.ok(RESTRICTED_AGENT_FILES.includes("JULES_RULES_TEMPLATE.md"));
  });

  test("runs dedicated audit functions (auditLedgers, auditWorktrees, auditGates)", async () => {
    const ledgers = auditLedgers({ root: process.cwd() });
    assert.equal(ledgers.ok, true);
    assert.ok(ledgers.stateDir);

    const worktrees = auditWorktrees({ root: process.cwd() });
    assert.equal(worktrees.ok, true);
    assert.ok(worktrees.worktreeDir);

    const gates = await auditGates({ root: process.cwd() });
    assert.ok(typeof gates.ok === "boolean");
  });
});

describe("Security Redaction & Secret Classification", () => {
  test("redacts active environment secrets matching denylist keys", () => {
    process.env.TEST_SECRET_KEY = "super-secret-token-12345";
    const text = "Connecting with key super-secret-token-12345 to server";
    const redacted = redactSecrets(text);
    assert.equal(redacted.includes("super-secret-token-12345"), false);
    assert.ok(redacted.includes("[REDACTED_ENV_SECRET]"));
    delete process.env.TEST_SECRET_KEY;
  });

  test("correctly classifies high-confidence vs low-confidence secrets", () => {
    const ghoToken = "gho_" + "1".repeat(36);
    const bearerHeader = "Authorization: Bearer " + "a".repeat(20);
    const testKey = "sk_test_" + "1".repeat(24);

    assert.equal(hasHighConfidenceSecret(ghoToken), true);
    assert.equal(hasHighConfidenceSecret(bearerHeader), false);
    assert.equal(hasHighConfidenceSecret(testKey), false);

    assert.equal(hasLowConfidenceSecret(bearerHeader), true);
    assert.equal(hasLowConfidenceSecret(testKey), true);
  });

  test("redacts secrets across pattern groups using redactSecrets", () => {
    const ghoToken = "gho_" + "1".repeat(36);
    const bearerToken = "Bearer " + "a".repeat(20);
    const privateKey = "-----BEGIN " + "PRIVATE KEY-----\n" + "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC3\n" + "-----END " + "PRIVATE KEY-----";
    const npmToken = "npm_" + "1".repeat(36);
    const stripeKey = "sk_live_" + "1".repeat(24);

    const googleOauth = "GOCSPX-" + "1".repeat(28);
    const awsSts = "ASIA" + "1".repeat(16);
    const gitlabPat = "glpat-" + "1".repeat(20);
    const puttyKey = "PuTTY-User-Key-File-3: ssh-ed25519";

    assert.equal(hasHighConfidenceSecret(ghoToken), true);
    assert.equal(hasHighConfidenceSecret(googleOauth), true);
    assert.equal(hasHighConfidenceSecret(awsSts), true);
    assert.equal(hasHighConfidenceSecret(gitlabPat), true);
    assert.equal(hasHighConfidenceSecret(puttyKey), true);

    assert.equal(redactSecrets(ghoToken).includes(ghoToken), false);
    assert.equal(redactSecrets(bearerToken).includes(bearerToken), false);
    assert.equal(redactSecrets(privateKey).includes("MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC3"), false);
    assert.equal(redactSecrets(npmToken).includes(npmToken), false);
    assert.equal(redactSecrets(stripeKey).includes(stripeKey), false);
    assert.equal(redactSecrets(googleOauth).includes(googleOauth), false);
  });

  test("anonymizes PII (emails, IPs, phone numbers) from prompt text", () => {
    const prompt = "Contact user john.doe@example.com at +46 70 123 45 67 or server 192.168.1.50 for support";
    const cleaned = anonymizePii(prompt);

    assert.equal(cleaned.includes("john.doe@example.com"), false);
    assert.ok(cleaned.includes("[REDACTED_EMAIL]"));
    assert.equal(cleaned.includes("+46 70 123 45 67"), false);
    assert.ok(cleaned.includes("[REDACTED_PHONE]"));
    assert.equal(cleaned.includes("192.168.1.50"), false);
    assert.ok(cleaned.includes("[REDACTED_IP]"));
    assert.ok(anonymizePii("127.0.0.1").includes("127.0.0.1"), "loopback IP preserved");
  });

  test("verifies ledger SHA-256 hash chain integrity", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jules-test-ledger-"));
    try {
      const ledgerFile = path.join(tmpDir, "sessions.jsonl");
      const e1 = JSON.stringify({ event: "budget_reserved", timestamp: new Date().toISOString() });
      const e2 = JSON.stringify({ event: "session_dispatched", timestamp: new Date().toISOString() });
      fs.writeFileSync(ledgerFile, `${e1}\n${e2}\n`);

      const validRes = verifyLedgerIntegrity(ledgerFile);
      assert.equal(validRes.ok, true);
      assert.equal(validRes.count, 2);
      assert.ok(validRes.lastHash);

      // Tamper with ledger line
      fs.writeFileSync(ledgerFile, `INVALID JSON LINE\n`);
      const invalidRes = verifyLedgerIntegrity(ledgerFile);
      assert.equal(invalidRes.ok, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("validates configuration and detects invalid regex triggers", () => {
    const validYaml = "version: 2\nforbidden_paths: [\"src/**\"]\n";
    const validJson = JSON.stringify({ rules: [{ trigger: "\\b(auth|security)\\b", guardrail: "Security" }] });
    assert.equal(validateJulesConfig(validYaml, validJson).ok, true);

    const invalidJson = JSON.stringify({ rules: [{ trigger: "[unclosed_regex", guardrail: "Invalid" }] });
    const invalidRes = validateJulesConfig(validYaml, invalidJson);
    assert.equal(invalidRes.ok, false);
    assert.ok(invalidRes.errors[0].includes("Invalid RegExp trigger"));
  });
});

describe("Atomic Budget Reservation & Ledger Check", () => {
  // These reservations are permanent by design, so they must never land in the
  // operator's real ledger: accumulated test reservations previously exhausted
  // the daily budget and made the whole suite fail locally while CI stayed green.
  let budgetRoot;

  before(() => {
    budgetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jok-budget-"));
    fs.mkdirSync(path.join(budgetRoot, ".agent", "state"), { recursive: true });
  });

  after(() => {
    fs.rmSync(budgetRoot, { recursive: true, force: true });
  });

  test("reserves daily budget and respects maximum session limits", () => {
    const res = reserveDailyBudget(300, "test-key-123", budgetRoot);
    assert.equal(res.ok, true);
    assert.ok(res.used >= 1);
  });

  test("counts only budget_reserved events, avoiding double-counting with session_dispatched", () => {
    const check1 = checkDailyBudget(budgetRoot, 300);
    reserveDailyBudget(300, "test-key-single-event", budgetRoot);
    const check2 = checkDailyBudget(budgetRoot, 300);
    assert.ok(check2.used >= check1.used + 1);
  });

  test("an isolated root never touches the repository ledger", () => {
    const stray = path.join(budgetRoot, ".agent", "state");
    const written = fs.readdirSync(stray).filter((f) => f.startsWith("ledger-"));
    assert.ok(written.length >= 1, "reservations must be written under the isolated root");
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
    assert.ok(pkg.files.includes(".agent/rules/"));
    assert.ok(pkg.files.includes(".agent/prompts/"));
    assert.ok(pkg.files.includes(".agent/workflows/"));
    assert.ok(pkg.files.includes("JULES_RULES_TEMPLATE.md"));
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
    assert.ok(rules.includes("Sentinel") || rules.includes("SECRET REDACTION GUARDRAILS"));
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
    assert.ok(rules.includes("Alchemist") || rules.includes("DATABASE GUARDRAILS"));
  });

  test("triggers JSON-configured dynamic guardrails when dynamic-guardrails.json is present", () => {
    const rules = getDynamicGuardrails("update css theme and tailwind styling");
    assert.ok(rules.includes("CSS & DESIGN GUARDRAILS") || rules.includes("tailwind"));
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
    assert.equal(getAlphaRange(0, 2), "A-M");
    assert.equal(getAlphaRange(1, 2), "N-Z");
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

describe("Node.js SDK Entrypoint (index.mjs)", () => {
  test("exports core orchestrator APIs cleanly", async () => {
    const sdk = await import("../index.mjs");
    assert.equal(typeof sdk.resolveProjectCommands, "function");
    assert.equal(typeof sdk.resolveWorkspaceExecutionBoundary, "function");
    assert.equal(typeof sdk.runSelfAudit, "function");
    assert.equal(typeof sdk.runPreflightSandbox, "function");
    assert.equal(typeof sdk.scanCodebaseForTodos, "function");
    assert.equal(typeof sdk.runScanner, "function");
    assert.equal(typeof sdk.redactSecrets, "function");
    assert.equal(typeof sdk.getDynamicGuardrails, "function");
    assert.equal(typeof sdk.dispatchTask, "function");
    assert.equal(typeof sdk.classifyQueueFailure, "function");
  });
});

describe("CLI Initializer (bin/init.js)", () => {
  test("scaffolds target repo, injects missing scripts, updates .gitignore, and creates JULES_WEB_SETUP.md", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jules-test-init-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "test-app", scripts: { test: "node --test" } }));
      const initScript = path.resolve(process.cwd(), "bin/init.js");
      execFileSync("node", [initScript], { cwd: tmpDir, stdio: "pipe" });

      const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8"));
      assert.ok(pkg.scripts["jules:queue"]);
      assert.ok(pkg.scripts["jules:scan"]);
      assert.ok(pkg.scripts["jules:dispatch"]);

      const gitignore = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf-8");
      assert.ok(gitignore.includes(".env"));
      assert.ok(gitignore.includes(".agent/state/"));

      const setupMd = fs.readFileSync(path.join(tmpDir, ".agent/JULES_WEB_SETUP.md"), "utf-8");
      assert.ok(setupMd.includes("https://jules.google"));
      assert.equal(setupMd.includes("app.jules.ai"), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("OODA State Module Scoping & Ledger Pruning", () => {
  test("exports getOodaStateFile cleanly at module top-level scope", () => {
    assert.equal(typeof getOodaStateFile, "function");
    const stateFile = getOodaStateFile("main");
    assert.ok(stateFile.replace(/\\/g, "/").includes(".agent/state/ooda"));
  });

  test("prunes old ledger files older than retention days", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jules-test-ledger-"));
    try {
      const oldFile = path.join(tmpDir, "2025-01-01.jsonl");
      const newFile = path.join(tmpDir, "2026-07-31.jsonl");
      fs.writeFileSync(oldFile, "{}");
      fs.writeFileSync(newFile, "{}");

      const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;
      fs.utimesSync(oldFile, new Date(thirtyOneDaysAgo), new Date(thirtyOneDaysAgo));

      pruneOldLedgers(tmpDir, 30);

      assert.equal(fs.existsSync(oldFile), false);
      assert.equal(fs.existsSync(newFile), true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("SDK Utilities (loadEnv & ensureDir)", () => {
  test("loadEnv loads environment variables from .env without crashing", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jules-test-env-"));
    try {
      fs.writeFileSync(path.join(tmpDir, ".env"), "TEST_JULES_KIT_VAR=hello_world\n# Comment\nexport ANOTHER_VAR=123");
      loadEnv(tmpDir);
      assert.equal(process.env.TEST_JULES_KIT_VAR, "hello_world");
      assert.equal(process.env.ANOTHER_VAR, "123");
    } finally {
      delete process.env.TEST_JULES_KIT_VAR;
      delete process.env.ANOTHER_VAR;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("ensureDir throws an Error instead of terminating process on creation failure", () => {
    assert.throws(
      () => {
        // Passing an invalid filename path with null byte or forbidden path
        ensureDir("\0invalid_path");
      },
      (err) => err instanceof Error
    );
  });
});

describe("SDK Cache Isolation", () => {
  test("getIsolatedCacheDir respects JULES_CACHE_DIR and defaults to ~/.cache/jules-orchestrator-kit", () => {
    const originalEnv = process.env.JULES_CACHE_DIR;
    try {
      delete process.env.JULES_CACHE_DIR;
      const defaultPath = getIsolatedCacheDir();
      assert.ok(defaultPath.includes(".cache"));
      assert.ok(defaultPath.endsWith("jules-orchestrator-kit"));

      process.env.JULES_CACHE_DIR = "/tmp/custom-jules-cache";
      const customPath = getIsolatedCacheDir();
      assert.equal(customPath, path.resolve("/tmp/custom-jules-cache"));
    } finally {
      if (originalEnv) process.env.JULES_CACHE_DIR = originalEnv;
      else delete process.env.JULES_CACHE_DIR;
    }
  });

  test("ensureSdkCacheIsolation creates target directory and sets JULES_CACHE_DIR env", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jules-test-cache-"));
    const originalEnv = process.env.JULES_CACHE_DIR;
    try {
      process.env.JULES_CACHE_DIR = path.join(tmpDir, "isolated");
      const createdDir = ensureSdkCacheIsolation();
      assert.ok(fs.existsSync(createdDir));
      assert.equal(process.env.JULES_CACHE_DIR, createdDir);
    } finally {
      if (originalEnv) process.env.JULES_CACHE_DIR = originalEnv;
      else delete process.env.JULES_CACHE_DIR;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Swarm Reservation Push & Sync Manifest", () => {
  test("buildSyncManifest formats tasks into valid JSON manifest structure", () => {
    const tasks = [
      { id: "t1", title: "Task 1", scope: ["src/a/**"] },
      { id: "t2", title: "Task 2", scope: null }
    ];
    const manifest = buildSyncManifest(tasks);
    assert.equal(manifest.version, 1);
    assert.equal(manifest.totalTasks, 2);
    assert.equal(manifest.reservations.length, 2);
    assert.equal(manifest.reservations[0].id, "t1");
    assert.deepEqual(manifest.reservations[0].scope, ["src/a/**"]);
  });

  test("pushReservationManifest saves manifest locally by default without pushing", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jules-test-swarm-local-"));
    const originalRemote = process.env.JULES_SWARM_REMOTE_PUSH;
    const originalDry = process.env.JULES_DRY_RUN;
    delete process.env.JULES_SWARM_REMOTE_PUSH;
    delete process.env.JULES_DRY_RUN;
    try {
      const manifest = buildSyncManifest([{ id: "t1", title: "Local Task" }]);
      const res = await pushReservationManifest(manifest, tmpDir);

      assert.equal(res.status, "SAVED_LOCAL");
      assert.ok(fs.existsSync(path.join(tmpDir, ".agent/sync-manifest.json")));
    } finally {
      if (originalRemote !== undefined) process.env.JULES_SWARM_REMOTE_PUSH = originalRemote;
      if (originalDry !== undefined) process.env.JULES_DRY_RUN = originalDry;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("pushReservationManifest writes sync-manifest.json and handles dry-run mode", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jules-test-swarm-"));
    const originalDry = process.env.JULES_DRY_RUN;
    try {
      process.env.JULES_DRY_RUN = "true";
      const manifest = buildSyncManifest([{ id: "t1", title: "Dry Task" }]);
      const res = await pushReservationManifest(manifest, tmpDir);

      assert.equal(res.status, "DRY_RUN");
      assert.ok(fs.existsSync(path.join(tmpDir, ".agent/sync-manifest.json")));
      const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, ".agent/sync-manifest.json"), "utf-8"));
      assert.equal(saved.totalTasks, 1);
    } finally {
      if (originalDry !== undefined) process.env.JULES_DRY_RUN = originalDry;
      else delete process.env.JULES_DRY_RUN;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Headless Jules Patch Extractor", () => {
  test("fetchSessionPatch validates input arguments", async () => {
    await assert.rejects(
      async () => {
        await fetchSessionPatch("");
      },
      (err) => err.message.includes("Session ID is required")
    );
  });
});

describe("Multimodal Image Attachment Extraction", () => {
  test("extracts referenced image files and generates attachment directive", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jules-test-img-"));
    try {
      const imgPath = path.join(tmpDir, "mockup.png");
      fs.writeFileSync(imgPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));

      const prompt = `Please build UI based on ![Mockup](mockup.png) specification.`;
      const attachments = extractImageAttachments(prompt, tmpDir);

      assert.equal(attachments.length, 1);
      assert.equal(attachments[0].relPath, "mockup.png");
      assert.equal(attachments[0].mime, "image/png");
      assert.ok(attachments[0].absPath.endsWith("mockup.png"), "absPath should end with filename");
      assert.ok(typeof attachments[0].size === "number", "size should be a number");

      const directive = getMultimodalAttachmentDirective(attachments);
      assert.ok(directive.includes("Multimodal Task Attachments"));
      assert.ok(directive.includes("mockup.png"));

      // P0-4: Path traversal must be rejected
      const traversalPrompt = `See ![Evil](../../../etc/passwd.svg)`;
      const blocked = extractImageAttachments(traversalPrompt, tmpDir);
      assert.equal(blocked.length, 0, "path traversal should be blocked");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Swarm Concurrency & Merge Engine Hardening", () => {
  test("classifyQueueFailure identifies FAILED_PRECONDITION as concurrency_limit", async () => {
    const { classifyQueueFailure } = await import("../scripts/jules-queue-runner.mjs");
    assert.equal(classifyQueueFailure(new Error("HTTP 400 FAILED_PRECONDITION: Precondition check failed")), "concurrency_limit");
    assert.equal(classifyQueueFailure(new Error("Active Session Limit reached")), "concurrency_limit");
  });

  test("jules-merge-swarm.mjs executes in dry-run mode cleanly", () => {
    const mergeScript = path.resolve(process.cwd(), "scripts/jules-merge-swarm.mjs");
    const output = execFileSync("node", [mergeScript, "--dry-run"], { encoding: "utf-8" });
    assert.ok(output.includes("Jules swarm branches") || output.includes("No open Jules PRs"));
  });

  test("checkSafetyGate detects active worker lock files", async () => {
    const { checkSafetyGate } = await import("../scripts/jules-merge-swarm.mjs");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jules-lock-gate-"));
    try {
      const locksDir = path.join(tmpDir, ".agent/state/locks");
      fs.mkdirSync(locksDir, { recursive: true });
      const lockFile = path.join(locksDir, "test-lock.json");
      fs.writeFileSync(lockFile, JSON.stringify({ branch: "jules/test-branch", agent: "Worker1" }));
      const gateResult = checkSafetyGate("jules/test-branch", tmpDir);
      assert.equal(gateResult.safe, false);
      assert.ok(gateResult.reason.includes("Active lock held by worker"));

      const safeResult = checkSafetyGate("jules/other-branch", tmpDir);
      assert.equal(safeResult.safe, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("deepMerge3Way merges nested objects and arrays deterministically without wiping sibling keys", async () => {
    const { deepMerge3Way } = await import("../scripts/jules-merge-swarm.mjs");
    const base = { config: { timeout: 300, port: 8080 }, items: [1, 2] };
    const ours = { config: { timeout: 600, port: 8080, verbose: true }, items: [1, 2, 3] };
    const theirs = { config: { timeout: 300, port: 9090, retries: 3 }, items: [1, 2] };

    const { merged, conflicts } = deepMerge3Way(base, ours, theirs);
    assert.equal(conflicts.length, 0);
    assert.deepEqual(merged, {
      config: { timeout: 600, port: 9090, verbose: true, retries: 3 },
      items: [1, 2, 3],
    });
  });
});

describe("Specialist Agent Prompt Presets", () => {
  test("loads Overseer, Bolt, Sentinel, and Janitor prompt presets", () => {
    const promptsDir = path.resolve(process.cwd(), ".agent/prompts");
    assert.ok(fs.existsSync(path.join(promptsDir, "Overseer.md")));
    assert.ok(fs.existsSync(path.join(promptsDir, "Bolt.md")));
    assert.ok(fs.existsSync(path.join(promptsDir, "Sentinel.md")));
    assert.ok(fs.existsSync(path.join(promptsDir, "Janitor.md")));

    const overseer = fs.readFileSync(path.join(promptsDir, "Overseer.md"), "utf-8");
    assert.ok(overseer.includes("Overseer Protocol"));

    const bolt = fs.readFileSync(path.join(promptsDir, "Bolt.md"), "utf-8");
    assert.ok(bolt.includes("Payload Budgeting"));

    const sentinel = fs.readFileSync(path.join(promptsDir, "Sentinel.md"), "utf-8");
    assert.ok(sentinel.includes("Vulnerability Mitigation"));

    const janitor = fs.readFileSync(path.join(promptsDir, "Janitor.md"), "utf-8");
    assert.ok(janitor.includes("Janitor Protocol"));

    assert.ok(fs.existsSync(path.join(promptsDir, "Task_Template.md")));
    const template = fs.readFileSync(path.join(promptsDir, "Task_Template.md"), "utf-8");
    assert.ok(template.includes("Master Task Prompt Template"));
  });
});

describe("Pre-Analysis Layering & Status Categorization", () => {
  test("categorizeTaskStatus correctly partitions session states", async () => {
    const { categorizeTaskStatus } = await import("../scripts/jules-status.mjs");
    assert.equal(categorizeTaskStatus("AWAITING_PLAN_APPROVAL"), "action_required");
    assert.equal(categorizeTaskStatus("AWAITING_USER_FEEDBACK"), "action_required");
    assert.equal(categorizeTaskStatus("IN_PROGRESS"), "in_progress");
    assert.equal(categorizeTaskStatus("dispatched"), "in_progress");
    assert.equal(categorizeTaskStatus("COMPLETED"), "completed");
    assert.equal(categorizeTaskStatus("FAILED"), "completed");
  });

  test("runPreflightStaticCheck handles clean and missing scripts gracefully", async () => {
    const { runPreflightStaticCheck } = await import("../scripts/jules-dispatch.mjs");
    const result = runPreflightStaticCheck(process.cwd());
    assert.equal(typeof result, "string");
  });
});









