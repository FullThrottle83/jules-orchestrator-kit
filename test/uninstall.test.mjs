import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

import {
  RUNTIME_GITIGNORE_ENTRIES,
  RUNTIME_GITIGNORE_HEADER,
  ensureGitignore,
} from "../src/scaffold.mjs";

const CLI = fileURLToPath(new URL("../bin/agentctl.mjs", import.meta.url));

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "jok-uninstall-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "d", version: "1.0.0", type: "module", scripts: { test: "true" } }),
    "utf-8"
  );
  writeFileSync(join(dir, "README.md"), "# user project\n", "utf-8");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\ndist/\n", "utf-8");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

/** Shape matching what `agentctl init` writes via wizard-init. */
function writeKitConfig(root) {
  mkdirSync(join(root, ".agent"), { recursive: true });
  writeFileSync(
    join(root, ".agent", "config.yml"),
    `# Agent Orchestrator Kit Config (v0.74.0)
# provider: jules | claude-code | codex | gemini-flash  (agentctl providers)
version: 1
provider: jules
tier: pro
base_branch: main
branch_prefix: agent/

verify:
  profile: standard
  scope: global
  test: "npm test"
  timeout_ms: 300000
  build: ""
  lint: ""
  typecheck: ""

presets:
  - doc-sync-sentinel
`,
    "utf-8"
  );
}

function seedKitInstall(root, { forceDirs = false } = {}) {
  writeKitConfig(root);
  ensureGitignore(root);
  if (forceDirs) {
    for (const rel of [".agent/rules", ".agent/prompts", ".agent/workflows", ".agent/jules-queue"]) {
      mkdirSync(join(root, rel), { recursive: true });
      writeFileSync(join(root, rel, "README.md"), "kit\n", "utf-8");
    }
  }
}

const run = (cwd, args) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf-8" });

test("agentctl uninstall", async (t) => {
  await t.test("--dry-run leaves disk untouched and reports expected removals", () => {
    const dir = tempRepo();
    try {
      seedKitInstall(dir);
      const beforeConfig = readFileSync(join(dir, ".agent/config.yml"), "utf-8");
      const beforeIgnore = readFileSync(join(dir, ".gitignore"), "utf-8");

      const res = run(dir, ["uninstall", "--dry-run", "--json"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);
      const payload = JSON.parse(res.stdout);
      assert.equal(payload.ok, true);
      assert.equal(payload.dryRun, true);
      assert.ok(payload.willRemove.includes(".agent/config.yml"));
      assert.ok(payload.willRemove.includes(".gitignore"));

      assert.equal(readFileSync(join(dir, ".agent/config.yml"), "utf-8"), beforeConfig);
      assert.equal(readFileSync(join(dir, ".gitignore"), "utf-8"), beforeIgnore);
      assert.ok(existsSync(join(dir, "README.md")), "user files must remain");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("real run removes config.yml and cleans kit gitignore block", () => {
    const dir = tempRepo();
    try {
      seedKitInstall(dir);
      assert.ok(readFileSync(join(dir, ".gitignore"), "utf-8").includes(RUNTIME_GITIGNORE_HEADER));

      const res = run(dir, ["uninstall", "--yes"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /uninstalled/i);

      assert.equal(existsSync(join(dir, ".agent/config.yml")), false);
      const ignore = readFileSync(join(dir, ".gitignore"), "utf-8");
      assert.equal(ignore.includes(RUNTIME_GITIGNORE_HEADER), false);
      for (const entry of RUNTIME_GITIGNORE_ENTRIES) {
        // Kit-block entries are gone; user lines remain.
        if (entry === ".env") continue; // may or may not have been only in the block
        assert.equal(ignore.includes(entry), false, `kit entry ${entry} should be stripped`);
      }
      assert.match(ignore, /node_modules\//);
      assert.match(ignore, /dist\//);
      assert.ok(existsSync(join(dir, "README.md")));
      assert.ok(existsSync(join(dir, "package.json")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("preserves non-kit .gitignore entries and other user files", () => {
    const dir = tempRepo();
    try {
      writeFileSync(
        join(dir, ".gitignore"),
        "# project\nnode_modules/\n.env\n*.log\n",
        "utf-8"
      );
      seedKitInstall(dir);
      writeFileSync(join(dir, "src-app.js"), "console.log(1)\n", "utf-8");

      const res = run(dir, ["uninstall", "--yes", "--json"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);
      const payload = JSON.parse(res.stdout);
      assert.equal(payload.ok, true);
      assert.ok(Array.isArray(payload.removed));

      const ignore = readFileSync(join(dir, ".gitignore"), "utf-8");
      assert.match(ignore, /node_modules\//);
      assert.match(ignore, /\.env/);
      assert.match(ignore, /\*\.log/);
      assert.equal(ignore.includes(RUNTIME_GITIGNORE_HEADER), false);
      assert.ok(existsSync(join(dir, "src-app.js")));
      assert.ok(existsSync(join(dir, "README.md")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("fails safely if no kit installation detected", () => {
    const dir = tempRepo();
    try {
      const res = run(dir, ["uninstall", "--yes", "--json"]);
      assert.equal(res.status, 1, res.stdout);
      const payload = JSON.parse(res.stdout);
      assert.equal(payload.ok, false);
      assert.match(String(payload.error), /No kit installation detected/i);
      assert.ok(existsSync(join(dir, ".gitignore")));
      assert.ok(existsSync(join(dir, "README.md")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("--json emits valid JSON for dry-run and real run", () => {
    const dir = tempRepo();
    try {
      seedKitInstall(dir);

      const dry = run(dir, ["uninstall", "-d", "-j"]);
      assert.equal(dry.status, 0, dry.stderr || dry.stdout);
      const dryPayload = JSON.parse(dry.stdout);
      assert.equal(dryPayload.ok, true);
      assert.equal(dryPayload.dryRun, true);
      assert.ok(Array.isArray(dryPayload.willRemove));

      const real = run(dir, ["uninstall", "-y", "-j"]);
      assert.equal(real.status, 0, real.stderr || real.stdout);
      const realPayload = JSON.parse(real.stdout);
      assert.equal(realPayload.ok, true);
      assert.equal(realPayload.dryRun, undefined);
      assert.ok(Array.isArray(realPayload.removed));
      assert.ok(realPayload.removed.includes(".agent/config.yml"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("requires --yes for a destructive real run", () => {
    const dir = tempRepo();
    try {
      seedKitInstall(dir);
      const res = run(dir, ["uninstall"]);
      assert.equal(res.status, 1);
      assert.match(res.stderr || res.stdout, /--yes/i);
      assert.ok(existsSync(join(dir, ".agent/config.yml")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("--force removes legacy scaffold directories", () => {
    const dir = tempRepo();
    try {
      seedKitInstall(dir, { forceDirs: true });
      const res = run(dir, ["uninstall", "--yes", "--force", "--json"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);
      const payload = JSON.parse(res.stdout);
      assert.ok(payload.removed.includes(".agent/rules"));
      assert.ok(payload.removed.includes(".agent/prompts"));
      assert.ok(payload.removed.includes(".agent/workflows"));
      assert.ok(payload.removed.includes(".agent/jules-queue"));
      assert.equal(existsSync(join(dir, ".agent/rules")), false);
      assert.equal(existsSync(join(dir, ".agent/prompts")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
