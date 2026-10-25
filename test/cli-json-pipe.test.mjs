import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";

const CLI = fileURLToPath(new URL("../bin/agentctl.mjs", import.meta.url));
const ITEMS = 1500;
// A dry run builds a full result per task, which is far slower than listing one.
// This many tasks already produce ~4x the 64 KiB pipe buffer.
const RUN_ITEMS = 250;

function createFixture(items = ITEMS) {
  const root = mkdtempSync(join(tmpdir(), "jules-json-pipe-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test Fixture");
  git("config", "user.email", "fixture@example.com");
  mkdirSync(join(root, ".agent", "jules-queue"), { recursive: true });
  mkdirSync(join(root, ".agent", "state"), { recursive: true });
  writeFileSync(join(root, ".agent", "config.yml"), "version: 1\nbase_branch: main\nverify:\n  test: node --test\n");
  const ledger = [];
  for (let i = 0; i < items; i++) {
    writeFileSync(
      join(root, ".agent", "jules-queue", `TASK-${i}.md`),
      `# ${"t".repeat(80)}${i}\n\n[TASK INSTRUCTIONS]\n${"x".repeat(80)}\n`
    );
    ledger.push(JSON.stringify({ sessionId: `session-${i}`, status: "COMPLETED", task: "t".repeat(80) + i }));
  }
  const day = new Date().toISOString().split("T")[0];
  writeFileSync(join(root, ".agent", "state", `ledger-${day}.jsonl`), ledger.join("\n") + "\n");
  git("add", ".agent/config.yml");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "test: establish fixture");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  return root;
}

async function captureThroughSlowPipe(root, args) {
  const child = spawn(process.execPath, [CLI, ...args], {
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
      setTimeout(() => child.stdout.resume(), 100);
    }
  });
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { exitCode, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
}

describe("list-style JSON output survives a pipe with backpressure", () => {
  it("queue list --json emits every queued task", async () => {
    const root = createFixture();
    try {
      const result = await captureThroughSlowPipe(root, ["queue", "list", "--json"]);
      assert.equal(result.exitCode, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.ok(result.stdout.length > 256 * 1024, "fixture must exceed the pipe buffer");
      assert.equal(report.ok, true);
      assert.equal(report.count, ITEMS);
      assert.equal(report.tasks.length, ITEMS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("session list --json emits every requested session", async () => {
    const root = createFixture();
    try {
      const result = await captureThroughSlowPipe(root, ["session", "list", "--json", "--dry-run", "--limit", String(ITEMS)]);
      assert.equal(result.exitCode, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.ok(result.stdout.length > 128 * 1024, "fixture must exceed the pipe buffer");
      assert.equal(report.ok, true);
      assert.equal(report.count, ITEMS);
      assert.equal(report.sessions.length, ITEMS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // `queue` and `swarm` print their run report and then call process.exit(). A
  // pipe that is not draining yet still holds most of a large report in
  // userland when the process exits, so the consumer received a prefix of the
  // JSON with exit code 0.
  for (const command of ["queue", "swarm"]) {
    it(`${command} --dry-run --json emits every task result`, async () => {
      const root = createFixture(RUN_ITEMS);
      try {
        const result = await captureThroughSlowPipe(root, [command, "--dry-run", "--json"]);
        assert.equal(result.exitCode, 0, result.stderr);
        let report;
        try {
          report = JSON.parse(result.stdout);
        } catch (err) {
          assert.fail(`stdout is not complete JSON (${result.stdout.length} bytes received): ${err.message}`);
        }
        assert.ok(result.stdout.length > 128 * 1024, "fixture must exceed the pipe buffer");
        assert.equal(report.results.length, RUN_ITEMS);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
