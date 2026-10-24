import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";

const CLI = fileURLToPath(new URL("../bin/agentctl.mjs", import.meta.url));
const OUTPUT_MARKER = "END-LARGE-VERIFY-OUTPUT";

function createFixture(failing) {
  const root = mkdtempSync(join(tmpdir(), "jules-gate-json-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test Fixture");
  git("config", "user.email", "fixture@example.com");
  mkdirSync(join(root, ".agent"));
  writeFileSync(join(root, ".agent", "config.yml"), "version: 1\nbase_branch: main\nverify:\n  test: node --test --test-reporter=spec fixture.test.mjs\n");
  writeFileSync(join(root, "source.mjs"), "export const add = (a, b) => a + b;\n");
  writeFileSync(join(root, "fixture.test.mjs"), [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { add } from "./source.mjs";',
    'test("addition", () => {',
    `  console.log("x".repeat(256 * 1024) + ${JSON.stringify(OUTPUT_MARKER)});`,
    '  assert.equal(add(2, 3), 5);',
    '});',
    '',
  ].join("\n"));
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "test: establish verification fixture");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(root, "source.mjs"), failing
    ? "export const add = (a, b) => a - b;\n"
    : "// Preserve numeric addition.\nexport const add = (a, b) => a + b;\n");
  return root;
}

async function captureThroughSlowPipe(root, command) {
  const child = spawn(process.execPath, [CLI, command, "--json"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let paused = false;
  child.stdout.on("data", (chunk) => {
    stdout.push(chunk);
    if (!paused) {
      paused = true;
      child.stdout.pause();
      setTimeout(() => child.stdout.resume(), 50);
    }
  });
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { exitCode, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
}

describe("gate JSON survives a pipe with backpressure", () => {
  for (const command of ["gate", "check", "audit"]) {
    for (const failing of [false, true]) {
      it(`${command} preserves the full ${failing ? "rejected" : "approved"} report and exit code`, async () => {
        const root = createFixture(failing);
        try {
          const result = await captureThroughSlowPipe(root, command);
          assert.equal(result.exitCode, failing ? 4 : 0, result.stderr);
          const report = JSON.parse(result.stdout);
          assert.equal(report.ok, !failing);
          assert.equal(report.code, failing ? 4 : 0);
          assert.deepEqual(report.overrides, []);
          const verify = report.phases.find((phase) => phase.phase === "verify");
          assert.equal(verify.ok, !failing);
          assert.equal(verify.testResult.status, failing ? 1 : 0);
          assert.ok(verify.testResult.stdout.includes("x".repeat(256 * 1024) + OUTPUT_MARKER));
          assert.equal(report.phases.find((phase) => phase.phase === "evidence").ok, true);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
});
