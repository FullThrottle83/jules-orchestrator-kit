import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { runDoctorChecks } from "../src/ops/doctor-registry.mjs";

const CLI = fileURLToPath(new URL("../bin/agentctl.mjs", import.meta.url));

function gitInit(dir) {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
}
const commitAll = (dir, msg) => {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", msg], { cwd: dir });
};

/**
 * Fresh python-shaped git repo whose committed baseline has NO package.json —
 * the cold-start shape that tripped the task-create preflight (F1). A later
 * `npm init`/`npm install` creates an untracked package.json the scope rules
 * `protect`.
 */
function pythonBaselineRepo() {
  const dir = mkdtempSync(join(tmpdir(), "jules-coldstart-py-"));
  gitInit(dir);
  writeFileSync(
    join(dir, "pyproject.toml"),
    "[project]\nname = \"py-fixture\"\nversion = \"0.1.0\"\n\n[tool.pytest.ini_options]\ntestpaths = [\".\"]\n",
    "utf-8"
  );
  writeFileSync(join(dir, "test_sample.py"), "def test_ok():\n    assert 1 + 1 == 2\n", "utf-8");
  commitAll(dir, "baseline");
  return dir;
}

/** Minimal JS repo; the caller adds the exact manifest/config state it wants. */
function jsRepo(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "jules-coldstart-js-"));
  gitInit(dir);
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf-8");
  if (extra.manifest) {
    writeFileSync(join(dir, "package.json"), extra.manifest, "utf-8");
    if (extra.lockfile) writeFileSync(join(dir, "package-lock.json"), extra.lockfile, "utf-8");
  }
  if (extra.config) {
    mkdirSync(join(dir, ".agent"), { recursive: true });
    writeFileSync(join(dir, ".agent", "config.yml"), extra.config, "utf-8");
  }
  commitAll(dir, "baseline");
  return dir;
}

const run = (dir, args) => spawnSync("node", [CLI, ...args], { cwd: dir, encoding: "utf-8" });

test("cold-start onboarding regressions (P12 trial findings F1 & F2)", async (t) => {
  await t.test("F1: task create succeeds on a fresh repo before the onboarding package.json is committed", () => {
    const dir = pythonBaselineRepo();
    try {
      const init = run(dir, ["init"]);
      assert.equal(init.status, 0, `init failed:\n${init.stdout}\n${init.stderr}`);

      // `npm init -y` + `npm install -D` just ran and left package.json +
      // package-lock.json as brand-new UNTRACKED files — nothing is committed.
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "py", version: "1.0.0", scripts: {} }), "utf-8");
      writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "py", lockfileVersion: 3 }), "utf-8");

      // Before the F1 fix this threw "Gate Preflight Rejected Task (Exit 3)".
      const created = run(dir, ["task", "create", "-p", "Implement healthcheck endpoint"]);
      assert.equal(created.status, 0, `task create should pass preflight:\n${created.stdout}\n${created.stderr}`);
      assert.ok(
        !/Gate Preflight Rejected|scope or secret violations/.test(created.stdout + created.stderr),
        "task create must not reject untracked onboarding install artifacts"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("F1 guard: a MODIFIED tracked lockfile still blocks task create", () => {
    const dir = jsRepo({
      manifest: JSON.stringify({ name: "app", version: "1.0.0", scripts: { test: "node -e 'process.exit(0)'" } }),
      lockfile: JSON.stringify({ name: "app", lockfileVersion: 3 }),
      config: "version: 1\nverify:\n  test: node -e 'process.exit(0)'\n",
    });
    try {
      // The developer ships a dependency update: the committed lockfile changes.
      writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "app", lockfileVersion: 3, tampered: true }), "utf-8");

      const created = run(dir, ["task", "create", "-p", "Bump a dependency. Verify with: node -e 'process.exit(0)'"]);
      assert.notEqual(created.status, 0, "a tracked, modified lockfile is supply-chain tampering and must block");
      assert.ok(
        /Gate Preflight Rejected Task/.test(created.stdout + created.stderr),
        `expected preflight rejection, got:\n${created.stdout}\n${created.stderr}`
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("F2: doctor reports a fail (exit 1) when no verification oracle exists and verification is required", async () => {
    const dir = jsRepo({
      manifest: JSON.stringify({ name: "z", version: "1.0.0", scripts: {} }),
    });
    try {
      // init keeps verify.test empty for a zero-test JS repo.
      const init = run(dir, ["init"]);
      assert.equal(init.status, 0, "init must succeed");

      const report = await runDoctorChecks({ root: dir });
      const oracle = report.results.find((r) => r.id === "oracle.test");
      assert.ok(oracle, "an oracle.test diagnostic must be present");
      assert.equal(oracle.status, "fail", "missing required oracle must be a fail, not a warn");
      assert.ok(report.summary.fail >= 1, "summary must count the failure");

      const doc = run(dir, ["doctor"]);
      assert.equal(doc.status, 1, "doctor must exit non-zero when the gate cannot verify anything");
      assert.ok(/No verification command|bootstrap/.test(doc.stdout + doc.stderr), "doctor should point at bootstrap");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("F2 companion: doctor stays green (warn) when verify.required: false", async () => {
    const dir = jsRepo({
      manifest: JSON.stringify({ name: "z", version: "1.0.0", scripts: {} }),
      config: "version: 1\nverify:\n  required: false\n",
    });
    try {
      const report = await runDoctorChecks({ root: dir });
      const oracle = report.results.find((r) => r.id === "oracle.test");
      assert.equal(oracle.status, "warn", "verify.required:false means a deliberate scope-only policy — a warning, not a failure");
      const doc = run(dir, ["doctor"]);
      assert.equal(doc.status, 0, "doctor must stay exit 0 under a deliberate verify.required:false policy");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("F2 companion: a detected stack reports a real oracle even before config exists", async () => {
    const dir = pythonBaselineRepo();
    try {
      const report = await runDoctorChecks({ root: dir });
      const oracle = report.results.find((r) => r.id === "oracle.test");
      assert.equal(oracle.status, "pass", "an auto-detectable stack has an oracle and must not report a false red");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
