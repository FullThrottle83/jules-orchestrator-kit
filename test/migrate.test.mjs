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

const CLI = fileURLToPath(new URL("../bin/agentctl.mjs", import.meta.url));

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "jok-migrate-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "d", version: "1.0.0", type: "module", scripts: { test: "true" } }),
    "utf-8"
  );
  writeFileSync(join(dir, "README.md"), "# user project\n", "utf-8");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

const run = (cwd, args) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf-8" });

test("agentctl migrate", async (t) => {
  await t.test("--dry-run leaves disk untouched and reports planned migrations", () => {
    const dir = tempRepo();
    try {
      mkdirSync(join(dir, ".agent"), { recursive: true });
      const jules = `version: 2
test_cmd: "npm test"
lint_cmd: "npm run lint"
build_cmd: ""
forbidden_paths:
  - ".github/**"
allow_paths: []
`;
      writeFileSync(join(dir, ".agent/jules.yml"), jules, "utf-8");

      const res = run(dir, ["migrate", "--dry-run", "--json"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);
      const payload = JSON.parse(res.stdout);
      assert.equal(payload.ok, true);
      assert.equal(payload.dryRun, true);
      assert.ok(payload.migrated.some((m) => m.type === "config" && m.path === ".agent/config.yml"));
      assert.equal(existsSync(join(dir, ".agent/config.yml")), false);
      assert.equal(readFileSync(join(dir, ".agent/jules.yml"), "utf-8"), jules);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("jules.yml → config.yml and removes jules.yml", () => {
    const dir = tempRepo();
    try {
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(
        join(dir, ".agent/jules.yml"),
        `version: 2\ntest_cmd: "npm test"\nlint_cmd: "eslint ."\nbuild_cmd: ""\n`,
        "utf-8"
      );

      const res = run(dir, ["migrate", "--yes", "--json"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);
      const payload = JSON.parse(res.stdout);
      assert.equal(payload.ok, true);
      assert.equal(payload.dryRun, false);
      assert.equal(existsSync(join(dir, ".agent/jules.yml")), false);
      assert.equal(existsSync(join(dir, ".agent/config.yml")), true);
      const cfg = readFileSync(join(dir, ".agent/config.yml"), "utf-8");
      assert.match(cfg, /^version:\s*1/m);
      assert.match(cfg, /test:\s*npm test/);
      assert.match(cfg, /lint:\s*eslint/);
      assert.ok(payload.migrated.some((m) => m.path === ".agent/config.yml"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("lifts test_cmd/lint_cmd into verify", () => {
    const dir = tempRepo();
    try {
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(
        join(dir, ".agent/config.yml"),
        `version: 1
provider: jules
test_cmd: "npm test"
lint_cmd: "npm run lint"
timeout_ms: 120000
verify:
  profile: standard
`,
        "utf-8"
      );

      const res = run(dir, ["migrate", "--yes", "--json"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);
      const cfg = readFileSync(join(dir, ".agent/config.yml"), "utf-8");
      assert.equal(/^test_cmd:/m.test(cfg), false);
      assert.equal(/^lint_cmd:/m.test(cfg), false);
      assert.equal(/^timeout_ms:/m.test(cfg), false);
      assert.match(cfg, /test:\s*npm test/);
      assert.match(cfg, /lint:\s*npm run lint/);
      assert.match(cfg, /timeout_ms:\s*120000/);
      const payload = JSON.parse(res.stdout);
      const changes = payload.migrated.flatMap((m) => m.changes);
      assert.ok(changes.some((c) => /test_cmd/.test(c)));
      assert.ok(changes.some((c) => /lint_cmd/.test(c)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("upgrades unversioned / legacy task in jules-queue", () => {
    const dir = tempRepo();
    try {
      mkdirSync(join(dir, ".agent/jules-queue"), { recursive: true });
      writeFileSync(
        join(dir, ".agent/config.yml"),
        `version: 1\nprovider: jules\nverify:\n  test: npm test\n`,
        "utf-8"
      );
      writeFileSync(join(dir, ".agent/jules-queue/README.md"), "skip me\n", "utf-8");
      writeFileSync(
        join(dir, ".agent/jules-queue/task-1.md"),
        `<!-- JULES_TASK_ENVELOPE: {"id":"TASK-1","title":"Do thing","verifyCmd":"npm test","flags":{"autoPr":false}} -->\n# Do thing\n`,
        "utf-8"
      );

      const res = run(dir, ["migrate", "--yes", "--json"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);
      const payload = JSON.parse(res.stdout);
      assert.ok(payload.migrated.some((m) => m.type === "task" && m.path === ".agent/jules-queue/task-1.md"));
      const task = readFileSync(join(dir, ".agent/jules-queue/task-1.md"), "utf-8");
      assert.match(task, /version:\s*agentctl\.task\/v1/);
      assert.equal(task.includes("JULES_TASK_ENVELOPE"), false);
      assert.equal(readFileSync(join(dir, ".agent/jules-queue/README.md"), "utf-8"), "skip me\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("requires --yes for a real run", () => {
    const dir = tempRepo();
    try {
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(join(dir, ".agent/jules.yml"), `version: 2\ntest_cmd: "npm test"\n`, "utf-8");
      const res = run(dir, ["migrate"]);
      assert.equal(res.status, 1);
      assert.match(res.stderr || res.stdout, /--yes/i);
      assert.equal(existsSync(join(dir, ".agent/jules.yml")), true);
      assert.equal(existsSync(join(dir, ".agent/config.yml")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("--json emits expected structure for dry-run and real run", () => {
    const dir = tempRepo();
    try {
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(join(dir, ".agent/jules.yml"), `version: 2\ntest_cmd: "npm test"\n`, "utf-8");

      const dry = run(dir, ["migrate", "-d", "-j"]);
      assert.equal(dry.status, 0, dry.stderr || dry.stdout);
      const dryPayload = JSON.parse(dry.stdout);
      assert.equal(dryPayload.ok, true);
      assert.equal(dryPayload.dryRun, true);
      assert.ok(Array.isArray(dryPayload.migrated));
      assert.ok(Array.isArray(dryPayload.warnings));

      const real = run(dir, ["migrate", "-y", "-j"]);
      assert.equal(real.status, 0, real.stderr || real.stdout);
      const realPayload = JSON.parse(real.stdout);
      assert.equal(realPayload.ok, true);
      assert.equal(realPayload.dryRun, false);
      assert.ok(Array.isArray(realPayload.migrated));
      assert.ok(realPayload.migrated[0].type);
      assert.ok(realPayload.migrated[0].path);
      assert.ok(Array.isArray(realPayload.migrated[0].changes));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("noop on canonical repo", () => {
    const dir = tempRepo();
    try {
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(
        join(dir, ".agent/config.yml"),
        `# Agent Orchestrator Kit Config
version: 1
provider: jules
tier: free
base_branch: main
branch_prefix: agent/
verify:
  profile: standard
  scope: global
  test: npm test
  timeout_ms: 300000
`,
        "utf-8"
      );

      const res = run(dir, ["migrate", "--yes", "--json"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);
      const payload = JSON.parse(res.stdout);
      assert.equal(payload.ok, true);
      assert.deepEqual(payload.migrated, []);
      assert.match(String(payload.message || ""), /canonical/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
