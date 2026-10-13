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
import {
  endsInExactEnvIgnoreRule,
  planUninstall,
  uninstallKit,
} from "../src/uninstall.mjs";

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

  await t.test("P1-19: Adversarial A & lifecycle: newly created .env with fake secret remains ignored and committable-safe after uninstall", () => {
    const dir = tempRepo();
    try {
      seedKitInstall(dir);
      const sentinelEnvContent = "SENTINEL_VAR=not-a-real-secret-p1-19-sentinel\nANOTHER_VAR=dont-commit-me\n";
      const envPath = join(dir, ".env");
      writeFileSync(envPath, sentinelEnvContent, "utf-8");

      // Verify ignored before uninstall
      const checkBefore = execFileSync("git", ["check-ignore", ".env"], { cwd: dir, encoding: "utf-8" }).trim();
      assert.equal(checkBefore, ".env");
      const statusBefore = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf-8" });
      assert.equal(statusBefore.includes(".env"), false);

      const res = run(dir, ["uninstall", "--yes", "--json"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);

      // 1. .env still exists
      assert.ok(existsSync(envPath));
      // 2. .env content is unchanged byte-for-byte
      assert.equal(readFileSync(envPath, "utf-8"), sentinelEnvContent);
      // 3. git check-ignore returns .env (exit 0)
      const checkAfter = execFileSync("git", ["check-ignore", ".env"], { cwd: dir, encoding: "utf-8" }).trim();
      assert.equal(checkAfter, ".env");
      // 4. git status does NOT list .env as untracked
      const statusAfter = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf-8" });
      assert.equal(statusAfter.includes(".env"), false, `.env must not appear in untracked status:\n${statusAfter}`);
      // 5. .gitignore contains .env rule, and stripped kit header
      const ignore = readFileSync(join(dir, ".gitignore"), "utf-8");
      assert.match(ignore, /^\.env$/m);
      assert.equal(ignore.includes(RUNTIME_GITIGNORE_HEADER), false);
      // 6. user entries preserved
      assert.match(ignore, /node_modules\//);
      assert.match(ignore, /dist\//);
      // 7. secret never appears in stdout/stderr
      assert.equal(res.stdout.includes("not-a-real-secret"), false);
      assert.equal(res.stderr.includes("not-a-real-secret"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("P1-19: Adversarial B: pre-existing user .env ignore rule is preserved without duplication", () => {
    const dir = tempRepo();
    try {
      writeFileSync(join(dir, ".gitignore"), "# project rules\nnode_modules/\ndist/\n.env\n", "utf-8");
      seedKitInstall(dir);
      writeFileSync(join(dir, ".env"), "SENTINEL_VAR=pre-existing-sentinel\n", "utf-8");

      const res = run(dir, ["uninstall", "--yes"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const ignore = readFileSync(join(dir, ".gitignore"), "utf-8");
      assert.match(ignore, /# project rules/);
      assert.match(ignore, /node_modules\//);
      assert.match(ignore, /dist\//);
      assert.equal(ignore.includes(RUNTIME_GITIGNORE_HEADER), false);
      const occurrences = (ignore.match(/^\.env$/gm) || []).length;
      assert.equal(occurrences, 1, `expected exactly 1 .env rule, found: ${occurrences}`);

      // Confirm git ignore oracle
      const check = execFileSync("git", ["check-ignore", "-q", ".env"], { cwd: dir });
      assert.equal(check.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("P1-19: pre-existing user .env followed by other rules appends trailing .env to guarantee protection", () => {
    const dir = tempRepo();
    try {
      writeFileSync(join(dir, ".gitignore"), "# project rules\nnode_modules/\n.env\ndist/\n", "utf-8");
      seedKitInstall(dir);
      writeFileSync(join(dir, ".env"), "SENTINEL_VAR=interleaved\n", "utf-8");

      const res = run(dir, ["uninstall", "--yes"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const ignore = readFileSync(join(dir, ".gitignore"), "utf-8");
      assert.match(ignore, /dist\/\n\.env\n$/);
      // Git ignore oracle proves .env remains ignored
      execFileSync("git", ["check-ignore", "-q", ".env"], { cwd: dir });
      const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf-8" });
      assert.equal(status.includes(".env"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("P1-19: Negation Case A: .env followed by !.env appends trailing .env to guarantee protection", () => {
    const dir = tempRepo();
    try {
      writeFileSync(join(dir, ".gitignore"), "# rules\nnode_modules/\n.env\n!.env\n", "utf-8");
      seedKitInstall(dir);
      writeFileSync(join(dir, ".env"), "SENTINEL_VAR=case-a\n", "utf-8");

      const plan = planUninstall(dir);
      assert.equal(plan.willPreserveEnv, true);

      const res = run(dir, ["uninstall", "--yes"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const ignore = readFileSync(join(dir, ".gitignore"), "utf-8");
      assert.match(ignore, /!\.env\n\.env\n$/);
      execFileSync("git", ["check-ignore", "-q", ".env"], { cwd: dir });
      const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf-8" });
      assert.equal(status.includes(".env"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("P1-19: Negation Case B: *.env followed by !.env appends trailing .env to guarantee protection", () => {
    const dir = tempRepo();
    try {
      writeFileSync(join(dir, ".gitignore"), "# rules\nnode_modules/\n*.env\n!.env\n", "utf-8");
      seedKitInstall(dir);
      writeFileSync(join(dir, ".env"), "SENTINEL_VAR=case-b\n", "utf-8");

      const plan = planUninstall(dir);
      assert.equal(plan.willPreserveEnv, true);

      const res = run(dir, ["uninstall", "--yes"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const ignore = readFileSync(join(dir, ".gitignore"), "utf-8");
      assert.match(ignore, /!\.env\n\.env\n$/);
      execFileSync("git", ["check-ignore", "-q", ".env"], { cwd: dir });
      const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf-8" });
      assert.equal(status.includes(".env"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("P1-19: Negation Case C: !.env followed by .env already ends in .env and requires no duplicate", () => {
    const dir = tempRepo();
    try {
      writeFileSync(join(dir, ".gitignore"), "# rules\nnode_modules/\n!.env\n.env\n", "utf-8");
      seedKitInstall(dir);
      writeFileSync(join(dir, ".env"), "SENTINEL_VAR=case-c\n", "utf-8");

      const plan = planUninstall(dir);
      assert.equal(plan.willPreserveEnv, false);

      const res = run(dir, ["uninstall", "--yes"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const ignore = readFileSync(join(dir, ".gitignore"), "utf-8");
      assert.match(ignore, /!\.env\n\.env\n?$/);
      const occurrences = (ignore.match(/^\.env$/gm) || []).length;
      assert.equal(occurrences, 1);
      execFileSync("git", ["check-ignore", "-q", ".env"], { cwd: dir });
      const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf-8" });
      assert.equal(status.includes(".env"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("P1-19: Negation Case D: multiple alternating negation rules (.env/!.env/.env/!.env) append trailing .env", () => {
    const dir = tempRepo();
    try {
      writeFileSync(join(dir, ".gitignore"), "# rules\nnode_modules/\n.env\n!.env\n.env\n!.env\n", "utf-8");
      seedKitInstall(dir);
      writeFileSync(join(dir, ".env"), "SENTINEL_VAR=case-d\n", "utf-8");

      const plan = planUninstall(dir);
      assert.equal(plan.willPreserveEnv, true);

      const res = run(dir, ["uninstall", "--yes"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const ignore = readFileSync(join(dir, ".gitignore"), "utf-8");
      assert.match(ignore, /!\.env\n\.env\n$/);
      execFileSync("git", ["check-ignore", "-q", ".env"], { cwd: dir });
      const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf-8" });
      assert.equal(status.includes(".env"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("P1-19: Negation Case E: trailing comments/blank lines after exact .env do not cause duplicate", () => {
    const dir = tempRepo();
    try {
      writeFileSync(join(dir, ".gitignore"), "# rules\nnode_modules/\n.env\n# trailing comment\n\n", "utf-8");
      seedKitInstall(dir);
      writeFileSync(join(dir, ".env"), "SENTINEL_VAR=case-e\n", "utf-8");

      const plan = planUninstall(dir);
      assert.equal(plan.willPreserveEnv, false);

      const res = run(dir, ["uninstall", "--yes"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const ignore = readFileSync(join(dir, ".gitignore"), "utf-8");
      const occurrences = (ignore.match(/^\.env$/gm) || []).length;
      assert.equal(occurrences, 1);
      execFileSync("git", ["check-ignore", "-q", ".env"], { cwd: dir });
      const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf-8" });
      assert.equal(status.includes(".env"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("P1-19: Negation Case F: trailing comments/blank lines after negation !.env still trigger safety append", () => {
    const dir = tempRepo();
    try {
      writeFileSync(join(dir, ".gitignore"), "# rules\nnode_modules/\n.env\n!.env\n# keep env committable\n\n", "utf-8");
      seedKitInstall(dir);
      writeFileSync(join(dir, ".env"), "SENTINEL_VAR=case-f\n", "utf-8");

      const plan = planUninstall(dir);
      assert.equal(plan.willPreserveEnv, true);

      const res = run(dir, ["uninstall", "--yes"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const ignore = readFileSync(join(dir, ".gitignore"), "utf-8");
      assert.match(ignore, /# keep env committable\n\.env\n$/);
      execFileSync("git", ["check-ignore", "-q", ".env"], { cwd: dir });
      const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf-8" });
      assert.equal(status.includes(".env"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("P1-19: Adversarial C: unrelated user ignore rules and custom files are preserved", () => {
    const dir = tempRepo();
    try {
      writeFileSync(
        join(dir, ".gitignore"),
        "node_modules/\ndist/\n*.log\ncoverage/\n.cache/\n",
        "utf-8"
      );
      seedKitInstall(dir);
      writeFileSync(join(dir, ".env"), "SENTINEL_VAR=sentinel\n", "utf-8");
      writeFileSync(join(dir, "my-app.config.js"), "export default {};\n", "utf-8");

      const res = run(dir, ["uninstall", "--yes"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const ignore = readFileSync(join(dir, ".gitignore"), "utf-8");
      assert.match(ignore, /node_modules\//);
      assert.match(ignore, /dist\//);
      assert.match(ignore, /\*\.log/);
      assert.match(ignore, /coverage\//);
      assert.match(ignore, /\.cache\//);
      assert.match(ignore, /^\.env$/m);
      assert.ok(existsSync(join(dir, "my-app.config.js")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("P1-19: Adversarial D: --force uninstall removes legacy scaffold dirs but still preserves .env ignore safety", () => {
    const dir = tempRepo();
    try {
      seedKitInstall(dir, { forceDirs: true });
      const sentinelEnvContent = "SENTINEL_VAR=force-uninstall-sentinel\n";
      const envPath = join(dir, ".env");
      writeFileSync(envPath, sentinelEnvContent, "utf-8");

      const res = run(dir, ["uninstall", "--yes", "--force", "--json"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);

      assert.equal(existsSync(join(dir, ".agent/rules")), false);
      assert.equal(existsSync(join(dir, ".agent/prompts")), false);
      assert.ok(existsSync(envPath));
      assert.equal(readFileSync(envPath, "utf-8"), sentinelEnvContent);

      const checkAfter = execFileSync("git", ["check-ignore", ".env"], { cwd: dir, encoding: "utf-8" }).trim();
      assert.equal(checkAfter, ".env");
      const statusAfter = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf-8" });
      assert.equal(statusAfter.includes(".env"), false);
      assert.equal(res.stdout.includes("force-uninstall-sentinel"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("P1-19: Adversarial E: when no .env exists on disk, ordinary kit block cleanup leaves no leftover .env rule", () => {
    const dir = tempRepo();
    try {
      seedKitInstall(dir);
      assert.equal(existsSync(join(dir, ".env")), false);

      const res = run(dir, ["uninstall", "--yes", "--json"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const ignore = readFileSync(join(dir, ".gitignore"), "utf-8");
      assert.equal(ignore.includes(".env"), false, ".gitignore should not have .env when no .env file existed");
      assert.equal(ignore.includes(RUNTIME_GITIGNORE_HEADER), false);
      assert.match(ignore, /node_modules\//);
      assert.match(ignore, /dist\//);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("P1-19: Adversarial F: sentinel secret value never appears in stdout, stderr, or JSON payload", () => {
    const dir = tempRepo();
    try {
      seedKitInstall(dir);
      const canaryEnvLine = "CANARY_PAYLOAD=forbidden-canary-sample-value-987654";
      writeFileSync(join(dir, ".env"), `${canaryEnvLine}\n`, "utf-8");

      const dry = run(dir, ["uninstall", "-d", "-j"]);
      assert.equal(dry.stdout.includes("forbidden-canary-sample-value-987654"), false);
      assert.equal(dry.stderr.includes("forbidden-canary-sample-value-987654"), false);

      const real = run(dir, ["uninstall", "-y", "-j"]);
      assert.equal(real.stdout.includes("forbidden-canary-sample-value-987654"), false);
      assert.equal(real.stderr.includes("forbidden-canary-sample-value-987654"), false);

      const human = run(dir, ["uninstall", "-y"]);
      assert.equal(human.stdout.includes("forbidden-canary-sample-value-987654"), false);
      assert.equal(human.stderr.includes("forbidden-canary-sample-value-987654"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("P1-19: Adversarial G: already tracked .env is not deleted, modified, or untracked", () => {
    const dir = tempRepo();
    try {
      const trackedEnvContent = "TRACKED_PAYLOAD=tracked-by-user-beforehand\n";
      const envPath = join(dir, ".env");
      writeFileSync(envPath, trackedEnvContent, "utf-8");
      execFileSync("git", ["add", ".env"], { cwd: dir });
      execFileSync("git", ["commit", "-qm", "track env file"], { cwd: dir });

      const commitBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim();

      seedKitInstall(dir);

      const res = run(dir, ["uninstall", "--yes", "--json"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);

      // 1. .env file remains and is byte-identical
      assert.ok(existsSync(envPath));
      assert.equal(readFileSync(envPath, "utf-8"), trackedEnvContent);

      // 2. Git commit history is unmodified
      const commitAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim();
      assert.equal(commitAfter, commitBefore);

      // 3. .env remains in Git index (was not git rm --cached)
      const lsFiles = execFileSync("git", ["ls-files", "--stage", ".env"], { cwd: dir, encoding: "utf-8" });
      assert.match(lsFiles, /\.env/);

      // 4. Working tree diff against HEAD for .env is clean
      const diff = execFileSync("git", ["diff", "HEAD", "--", ".env"], { cwd: dir, encoding: "utf-8" });
      assert.equal(diff.trim(), "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("P1-19: --dry-run accurately predicts .env preservation without mutating disk", () => {
    const dir = tempRepo();
    try {
      seedKitInstall(dir);
      writeFileSync(join(dir, ".env"), "SENTINEL_VAR=dry-run\n", "utf-8");
      const beforeGitignore = readFileSync(join(dir, ".gitignore"), "utf-8");

      const plan = planUninstall(dir);
      assert.equal(plan.ok, true);
      assert.equal(plan.willCleanGitignore, true);
      assert.equal(plan.willPreserveEnv, true);

      const res = run(dir, ["uninstall", "--dry-run", "--json"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);
      const payload = JSON.parse(res.stdout);
      assert.equal(payload.ok, true);
      assert.equal(payload.dryRun, true);

      // Disk untouched
      assert.equal(readFileSync(join(dir, ".gitignore"), "utf-8"), beforeGitignore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("P1-19: Unit: endsInExactEnvIgnoreRule accurately parses trailing ignore rules and rejects comments", () => {
    assert.equal(endsInExactEnvIgnoreRule(".env"), true);
    assert.equal(endsInExactEnvIgnoreRule("  .env  "), true);
    assert.equal(endsInExactEnvIgnoreRule("/.env"), true);
    assert.equal(endsInExactEnvIgnoreRule("  /.env  "), true);
    assert.equal(endsInExactEnvIgnoreRule("node_modules/\n.env"), true);
    assert.equal(endsInExactEnvIgnoreRule("node_modules/\n/.env"), true);
    assert.equal(endsInExactEnvIgnoreRule(".env\n# trailing comment"), true);
    assert.equal(endsInExactEnvIgnoreRule(".env\n\n  \n# comment\n"), true);
    assert.equal(endsInExactEnvIgnoreRule("*.env"), false);
    assert.equal(endsInExactEnvIgnoreRule(".env\n!.env"), false);
    assert.equal(endsInExactEnvIgnoreRule("*.env\n!.env"), false);
    assert.equal(endsInExactEnvIgnoreRule(".env\n!.env\n# comment"), false);
    assert.equal(endsInExactEnvIgnoreRule("node_modules/\n.env\ndist/"), false);
    assert.equal(endsInExactEnvIgnoreRule("# .env\nnode_modules/"), false);
    assert.equal(endsInExactEnvIgnoreRule("# comments only"), false);
    assert.equal(endsInExactEnvIgnoreRule("node_modules/\ndist/"), false);
    assert.equal(endsInExactEnvIgnoreRule(""), false);
  });

  await t.test("P1-19: Programmatic uninstallKit returns preservedEnv metadata accurately", () => {
    const dirWithEnv = tempRepo();
    const dirWithoutEnv = tempRepo();
    try {
      seedKitInstall(dirWithEnv);
      writeFileSync(join(dirWithEnv, ".env"), "SENTINEL_VAR=1\n", "utf-8");
      const resWith = uninstallKit(dirWithEnv);
      assert.equal(resWith.ok, true);
      assert.equal(resWith.cleanedGitignore, true);
      assert.equal(resWith.preservedEnv, true);

      seedKitInstall(dirWithoutEnv);
      const resWithout = uninstallKit(dirWithoutEnv);
      assert.equal(resWithout.ok, true);
      assert.equal(resWithout.cleanedGitignore, true);
      assert.equal(resWithout.preservedEnv, false);
    } finally {
      rmSync(dirWithEnv, { recursive: true, force: true });
      rmSync(dirWithoutEnv, { recursive: true, force: true });
    }
  });
});
