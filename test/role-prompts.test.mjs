import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveRolePrompt, hydrateRolePrompt, ROLE_PROMPT_TOKENS } from "../src/role-resolver.mjs";

const SHIPPED_PROMPTS = join(process.cwd(), ".agent", "prompts");

test("Role prompts are stack-neutral", async (t) => {
  // These files ship inside the npm package (`files` in package.json includes
  // .agent/prompts/), so every `agentctl init` in any language gets them. They
  // used to carry this kit's own contribution rules: "npm test", "npm run
  // lint", and a ban on third-party npm packages in favour of Node built-ins.
  await t.test("every documented specialist role ships as a prompt file", () => {
    // JULES_RULES_TEMPLATE.md advertises these personas. A `--role` flag whose
    // prompt is missing resolves to null, so a documented role with no file is
    // a broken promise rather than an undocumented feature. Names are matched
    // case-insensitively by resolveRolePrompt, so the on-disk filename can be
    // Title-Case without affecting dispatch.
    const required = ["overseer", "bolt", "sentinel", "janitor", "a11y", "scribe", "spectator", "alchemist"];
    const present = readdirSync(SHIPPED_PROMPTS)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/i, "").toLowerCase());
    for (const role of required) {
      assert.ok(present.includes(role), `documented role "${role}" must have a prompt file in .agent/prompts/`);
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
});
