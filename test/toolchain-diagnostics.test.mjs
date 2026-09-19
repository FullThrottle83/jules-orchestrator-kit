import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { runDoctorChecks } from "../src/ops/doctor-registry.mjs";
import {
  extractPrimaryExecutable,
  diagnoseVerifyFailure,
  missingNodeModules,
} from "../src/ops/toolchain-diagnostics.mjs";

const KIT_ROOT = fileURLToPath(new URL("..", import.meta.url));

function gitInit(dir) {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
}

function commitAll(dir, msg) {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", msg], { cwd: dir });
}

function tempRepo(prefix = "jok-toolchain-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  gitInit(dir);
  return dir;
}

test("extractPrimaryExecutable peels env prefixes and package managers", () => {
  assert.equal(extractPrimaryExecutable("PYTHONPATH=src python3 -m pytest"), "python3");
  assert.equal(extractPrimaryExecutable("npm test"), "npm");
  assert.equal(extractPrimaryExecutable("pnpm test"), "pnpm");
  assert.equal(extractPrimaryExecutable("cargo test"), "cargo");
  assert.equal(extractPrimaryExecutable("go test ./..."), "go");
  assert.equal(extractPrimaryExecutable("cd apps/api && npm test"), "npm");
  assert.equal(extractPrimaryExecutable(""), null);
});

test("runDoctorChecks reports toolchain.binary fail for an unresolvable verify.test binary", async () => {
  const dir = tempRepo();
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "tc-bin", version: "1.0.0", scripts: {} }),
      "utf-8"
    );
    mkdirSync(join(dir, ".agent"), { recursive: true });
    writeFileSync(
      join(dir, ".agent", "config.yml"),
      "version: 1\nverify:\n  test: totally-missing-binary-xyz-9f3a --flag\n",
      "utf-8"
    );
    commitAll(dir, "baseline");

    const report = await runDoctorChecks({ root: dir });
    const row = report.results.find((r) => r.id === "toolchain.binary");
    assert.ok(row, "toolchain.binary diagnostic must be present");
    assert.equal(row.status, "fail", "missing required verify binary must fail");
    assert.match(row.summary, /totally-missing-binary-xyz-9f3a/);
    assert.ok(report.summary.fail >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDoctorChecks detects missing node_modules when package.json is present", async () => {
  const dir = tempRepo();
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "tc-deps", version: "1.0.0", scripts: { test: "node -e 'process.exit(0)'" } }),
      "utf-8"
    );
    mkdirSync(join(dir, ".agent"), { recursive: true });
    writeFileSync(
      join(dir, ".agent", "config.yml"),
      "version: 1\nverify:\n  test: node -e 'process.exit(0)'\n",
      "utf-8"
    );
    commitAll(dir, "baseline");

    assert.equal(missingNodeModules(dir), true);
    assert.equal(existsSync(join(dir, "node_modules")), false);

    const report = await runDoctorChecks({ root: dir });
    const row = report.results.find((r) => r.id === "toolchain.deps");
    assert.ok(row, "toolchain.deps diagnostic must be present");
    assert.equal(row.status, "warn");
    assert.match(row.summary, /node_modules/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDoctorChecks warns on Python manifest without a usable venv", async () => {
  const dir = tempRepo();
  try {
    writeFileSync(
      join(dir, "pyproject.toml"),
      '[project]\nname = "tc-py"\nversion = "0.1.0"\n',
      "utf-8"
    );
    writeFileSync(join(dir, "test_ok.py"), "def test_ok():\n    assert True\n", "utf-8");
    commitAll(dir, "baseline");

    const report = await runDoctorChecks({ root: dir, activeProbe: false });
    const row = report.results.find((r) => r.id === "toolchain.python-env");
    assert.ok(row, "toolchain.python-env diagnostic must be present");
    assert.equal(row.status, "warn");
    assert.match(row.summary, /venv/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI exit-4 remediation distinguishes missing binary vs missing deps", () => {
  const binCase = diagnoseVerifyFailure({
    exitCode: 127,
    command: "totally-missing-binary-xyz-9f3a --flag",
    stderr: "totally-missing-binary-xyz-9f3a: command not found",
  });
  assert.equal(binCase.kind, "missing-binary");
  assert.match(binCase.lines.join("\n"), /totally-missing-binary-xyz-9f3a/);

  const enoent = diagnoseVerifyFailure({
    exitCode: 1,
    command: "npm test",
    stderr: "spawnSync npm ENOENT",
    code: "ENOENT",
  });
  assert.equal(enoent.kind, "missing-binary");
  assert.match(enoent.lines.join("\n"), /npm|PATH/i);

  const nodeMod = diagnoseVerifyFailure({
    exitCode: 1,
    command: "npm test",
    stderr: "Error: Cannot find module 'left-pad'\nRequire stack:\n- index.js",
  });
  assert.equal(nodeMod.kind, "missing-deps");
  assert.match(nodeMod.lines.join("\n"), /npm install|dependencies/i);

  const pyMod = diagnoseVerifyFailure({
    exitCode: 1,
    command: "python3 -m pytest",
    stderr: "ModuleNotFoundError: No module named 'pytest'",
  });
  assert.equal(pyMod.kind, "missing-deps");
  assert.match(pyMod.lines.join("\n"), /venv|pip|deps/i);

  const general = diagnoseVerifyFailure({
    exitCode: 1,
    command: "npm test",
    stderr: "AssertionError: expected 2 to equal 3",
  });
  assert.equal(general.kind, "general");
  assert.match(general.lines.join("\n"), /Reproduce|repair/i);
});

test("activeProbe adds oracle.probe when the verify binary is present", async () => {
  const dir = tempRepo();
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "tc-probe", version: "1.0.0", scripts: { test: "node -e 'process.exit(0)'" } }),
      "utf-8"
    );
    mkdirSync(join(dir, ".agent"), { recursive: true });
    writeFileSync(
      join(dir, ".agent", "config.yml"),
      "version: 1\nverify:\n  test: node -e 'process.exit(0)'\n",
      "utf-8"
    );
    commitAll(dir, "baseline");

    const report = await runDoctorChecks({ root: dir, activeProbe: true });
    const probe = report.results.find((r) => r.id === "oracle.probe");
    assert.ok(probe, "oracle.probe must appear under --probe");
    assert.equal(probe.status, "pass");
    assert.equal(report.activeProbe, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toolchain diagnostics never leave artifacts under the kit checkout", () => {
  // Guard: this suite only touches mkdtemp dirs under os.tmpdir().
  assert.ok(!KIT_ROOT.includes("jok-toolchain-"));
  const agentInKit = join(KIT_ROOT, ".agent", "state", "locks");
  // Presence of kit's own .agent is fine; we just must not have created
  // jok-toolchain- scratch under the kit tree.
  assert.equal(existsSync(join(KIT_ROOT, "jok-toolchain-scratch")), false);
  void agentInKit;
});
