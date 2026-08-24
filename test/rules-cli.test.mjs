import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { scaffoldContracts, scaffoldRepoAssets } from "../src/scaffold.mjs";

const CLI = fileURLToPath(new URL("../bin/agentctl.mjs", import.meta.url));

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "jules-rules-cli-test-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "test-app", version: "1.0.0", type: "module", scripts: { test: "true" } }),
    "utf-8"
  );
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

test("agentctl rules check and compile CLI commands", async (t) => {
  await t.test("agentctl rules check exits 0 on valid rules", () => {
    const dir = tempRepo();
    try {
      writeFileSync(join(dir, "AGENTS.md"), "# Standard Rules\nShort rule file.");
      const res = spawnSync(process.execPath, [CLI, "rules", "check"], {
        cwd: dir,
        encoding: "utf-8",
      });
      assert.equal(res.status, 0);
      assert.match(res.stdout, /All agent rule files are within safe character/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("agentctl rules check exits 1 on bloated rules with --json output", () => {
    const dir = tempRepo();
    try {
      writeFileSync(join(dir, "AGENTS.md"), "# Bloated Rules\n" + "X".repeat(12000));
      const res = spawnSync(process.execPath, [CLI, "rules", "check", "--json"], {
        cwd: dir,
        encoding: "utf-8",
      });
      assert.equal(res.status, 1);
      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.violations.length, 1);
      assert.match(parsed.violations[0].reason, /Exceeds max character budget/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("agentctl rules compile writes to --out file with valid sentinels", () => {
    const dir = tempRepo();
    try {
      writeFileSync(join(dir, "AGENTS.md"), "# Core Directives\nStrict zero-dep invariant.");
      const outPath = "COMPILED_RULES.md";
      const res = spawnSync(process.execPath, [CLI, "rules", "compile", "--out", outPath], {
        cwd: dir,
        encoding: "utf-8",
      });
      assert.equal(res.status, 0);
      assert.ok(existsSync(join(dir, outPath)));
      const compiled = readFileSync(join(dir, outPath), "utf-8");
      assert.match(compiled, /JULES_RULES_SENTINEL BEGIN/);
      assert.match(compiled, /Strict zero-dep invariant/);
      assert.match(compiled, /JULES_RULES_SENTINEL END/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("Stack-tailored contract scaffolding (SPEC.md, CONSTRAINTS.md, DESIGN.md)", async (t) => {
  await t.test("scaffolds generic TypeScript/Node contracts by default", () => {
    const dir = tempRepo();
    try {
      const created = scaffoldContracts(dir);
      assert.ok(created.includes("SPEC.md"));
      assert.ok(created.includes("CONSTRAINTS.md"));

      const spec = readFileSync(join(dir, "SPEC.md"), "utf-8");
      assert.match(spec, /# SPEC — System & Product Contract/);

      const constraints = readFileSync(join(dir, "CONSTRAINTS.md"), "utf-8");
      assert.match(constraints, /Zero third-party runtime dependencies/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("tailors CONSTRAINTS.md for Cloudflare / workerd edge runtime", () => {
    const dir = tempRepo();
    try {
      writeFileSync(join(dir, "wrangler.json"), JSON.stringify({ name: "cf-worker" }));
      scaffoldContracts(dir);

      const constraints = readFileSync(join(dir, "CONSTRAINTS.md"), "utf-8");
      assert.match(constraints, /Cloudflare Workers/);
      assert.match(constraints, /Zero unbundled `node:\*` imports/);
      assert.match(constraints, /128 MB/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("tailors CONSTRAINTS.md for Rust / Cargo architecture", () => {
    const dir = tempRepo();
    try {
      writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "rust-app"\nversion = "0.1.0"');
      scaffoldContracts(dir);

      const constraints = readFileSync(join(dir, "CONSTRAINTS.md"), "utf-8");
      assert.match(constraints, /Rust Architecture/);
      assert.match(constraints, /Zero `unsafe` blocks/);
      assert.match(constraints, /cargo clippy/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("tailors CONSTRAINTS.md for Go architecture", () => {
    const dir = tempRepo();
    try {
      writeFileSync(join(dir, "go.mod"), "module example.com/go-app\n\ngo 1.22");
      scaffoldContracts(dir);

      const constraints = readFileSync(join(dir, "CONSTRAINTS.md"), "utf-8");
      assert.match(constraints, /Go Architecture/);
      assert.match(constraints, /CGO_ENABLED=0/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("scaffolds DESIGN.md for Web UI projects (e.g. Astro / Tailwind)", () => {
    const dir = tempRepo();
    try {
      writeFileSync(join(dir, "astro.config.mjs"), "export default {};");
      const created = scaffoldContracts(dir);
      assert.ok(created.includes("DESIGN.md"));

      const design = readFileSync(join(dir, "DESIGN.md"), "utf-8");
      assert.match(design, /# DESIGN — Visual Tokens & Design System/);
      assert.match(design, /Tokens \(@theme\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("scaffoldRepoAssets includes contracts seamlessly", () => {
    const dir = tempRepo();
    try {
      const res = scaffoldRepoAssets(dir);
      assert.ok(res.created.includes("SPEC.md"));
      assert.ok(res.created.includes("CONSTRAINTS.md"));
      assert.ok(existsSync(join(dir, "SPEC.md")));
      assert.ok(existsSync(join(dir, "CONSTRAINTS.md")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
