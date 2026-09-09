import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveRolePrompt, hydrateRolePrompt, ROLE_PROMPT_TOKENS, CANONICAL_ROLES } from "../src/role-resolver.mjs";

const SHIPPED_PROMPTS = join(process.cwd(), ".agent", "prompts");

test("Role prompts are stack-neutral", async (t) => {
  // These files ship inside the npm package (`files` in package.json includes
  // .agent/prompts/), so every `agentctl init` in any language gets them.
  await t.test("every canonical engineering specialist role ships as a prompt file", () => {
    const present = readdirSync(SHIPPED_PROMPTS)
      .filter((f) => f.endsWith(".md") && f !== "Task_Template.md")
      .map((f) => f.replace(/\.md$/i, "").toLowerCase());
    for (const role of CANONICAL_ROLES) {
      assert.ok(present.includes(role), `canonical role "${role}" must have a prompt file in .agent/prompts/`);
    }
  });

  await t.test("legacy aliases resolve transparently to canonical prompt files", () => {
    const legacyMap = {
      overseer: "auditor",
      bolt: "performance",
      sentinel: "security",
      janitor: "hygiene",
      spectator: "e2e",
      scribe: "docs",
      alchemist: "database",
      bulwark: "resilience",
      typist: "types",
      hunter: "debugger",
    };
    for (const [legacy, canonical] of Object.entries(legacyMap)) {
      const resolved = resolveRolePrompt(process.cwd(), legacy);
      assert.ok(resolved, `legacy alias "${legacy}" must resolve`);
      assert.equal(resolved.role.toLowerCase(), canonical);
      assert.ok(resolved.content.length > 50);
    }
  });

  await t.test("operator shortcuts resolve to canonical prompt files", () => {
    const shortcuts = ["perf", "sec", "db", "cleanup", "accessibility", "visual", "debug"];
    for (const sc of shortcuts) {
      const resolved = resolveRolePrompt(process.cwd(), sc);
      assert.ok(resolved, `shortcut "${sc}" must resolve`);
    }
  });

  await t.test("no shipped role prompt hardcodes an ecosystem's commands", () => {
    const offenders = [];
    for (const file of readdirSync(SHIPPED_PROMPTS).filter((f) => f.endsWith(".md"))) {
      const body = readFileSync(join(SHIPPED_PROMPTS, file), "utf-8");
      for (const pattern of [/\bnpm (?:test|run|install|ci)\b/, /\bnode:(?:fs|path|crypto|child_process|os)\b/, /\bnpm packages?\b/, /\bpnpm\b/, /\byarn\b/]) {
        if (pattern.test(body)) offenders.push(`${file}: ${pattern}`);
      }
    }
    assert.deepEqual(offenders, [], "role prompts must use {{VERIFY_*}} tokens, not one ecosystem's commands");
  });

  await t.test("hydrateRolePrompt substitutes the repository's own commands", () => {
    const template = "Run `{{VERIFY_TEST}}` and `{{VERIFY_LINT}}`, keep the diff under {{DIFF_KB}} KB, rebase onto {{BASE_BRANCH}}.";

    const rust = hydrateRolePrompt(template, {
      verify: { test: "cargo test --workspace", lint: "cargo clippy -- -D warnings" },
      limits: { diffKb: 50 },
      baseBranch: "trunk",
    });
    assert.equal(rust, "Run `cargo test --workspace` and `cargo clippy -- -D warnings`, keep the diff under 50 KB, rebase onto trunk.");

    const python = hydrateRolePrompt(template, {
      verify: { test: "pytest", lint: "ruff check ." },
      limits: { diffKb: 75 },
      baseBranch: "main",
    });
    assert.match(python, /Run `pytest` and `ruff check \.`/);
    assert.ok(!python.includes("cargo"));
  });

  await t.test("an unknown token is left visible rather than blanked", () => {
    // "run  before and after" is a worse prompt than one that still shows a
    // placeholder, because only the second is diagnosable.
    assert.equal(hydrateRolePrompt("run {{NOT_A_TOKEN}} now"), "run {{NOT_A_TOKEN}} now");
  });

  await t.test("a missing verify command degrades to prose, not to an empty string", () => {
    const out = hydrateRolePrompt("Execute `{{VERIFY_TEST}}`.", {});
    assert.equal(out, "Execute `the project's test command`.");
  });

  await t.test("every documented token resolves", () => {
    const template = ROLE_PROMPT_TOKENS.map((t2) => `{{${t2}}}`).join(" ");
    const out = hydrateRolePrompt(template, { verify: { test: "go test ./..." } });
    assert.ok(!out.includes("{{"), `unresolved token in: ${out}`);
  });

  await t.test("resolveRolePrompt hydrates against the target repository's config", () => {
    const root = mkdtempSync(join(tmpdir(), "jules-role-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));

    mkdirSync(join(root, ".agent", "prompts"), { recursive: true });
    writeFileSync(join(root, ".agent", "prompts", "janitor.md"), "Verify with `{{VERIFY_TEST}}`.");
    writeFileSync(
      join(root, ".agent", "config.yml"),
      'version: 1\ntier: free\nverify:\n  test: "go test ./..."\n'
    );

    const resolved = resolveRolePrompt(root, "janitor");
    assert.equal(resolved.role, "janitor");
    assert.equal(resolved.content, "Verify with `go test ./...`.");
  });

  await t.test("returns null for an unknown role and a missing prompts directory", () => {
    const root = mkdtempSync(join(tmpdir(), "jules-role-empty-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assert.equal(resolveRolePrompt(root, "janitor"), null);

    mkdirSync(join(root, ".agent", "prompts"), { recursive: true });
    assert.equal(resolveRolePrompt(root, "nonexistent"), null);
    assert.equal(resolveRolePrompt(root, ""), null);
  });

  await t.test("operator shortcuts for testing resolve to Testing.md", () => {
    for (const sc of ["testing", "test", "unit-test", "integration-test", "qa"]) {
      const resolved = resolveRolePrompt(process.cwd(), sc);
      assert.ok(resolved, `testing shortcut "${sc}" must resolve`);
      assert.equal(resolved.role.toLowerCase(), "testing");
    }
  });

  await t.test("two-hop legacy alias resolves in legacy-only checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "jules-legacy-only-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const promptsDir = join(root, ".agent", "prompts");
    mkdirSync(promptsDir, { recursive: true });
    // Write only legacy Bolt.md
    writeFileSync(join(promptsDir, "Bolt.md"), "# Bolt Protocol\nLegacy micro-optimization.");

    // "perf" -> "performance" -> "bolt" (two-hop fallback)
    const resolved = resolveRolePrompt(root, "perf");
    assert.ok(resolved, "perf shortcut must resolve to Bolt.md in legacy-only checkout");
    assert.equal(resolved.role, "Bolt");
    assert.ok(resolved.content.includes("Legacy micro-optimization"));
  });

  await t.test("resolveRolePrompt respects explicit opts.config override", () => {
    const root = mkdtempSync(join(tmpdir(), "jules-config-override-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const promptsDir = join(root, ".agent", "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(join(promptsDir, "Testing.md"), "Run `{{VERIFY_TEST}}`.");
    // Disk has standard npm test
    writeFileSync(join(root, ".agent", "config.yml"), 'version: 1\nverify:\n  test: "npm test"\n');

    // Caller passes explicit custom override
    const resolved = resolveRolePrompt(root, "testing", {
      config: { verify: { test: "vitest run --coverage" } }
    });
    assert.ok(resolved);
    assert.equal(resolved.content, "Run `vitest run --coverage`.");
  });
});
