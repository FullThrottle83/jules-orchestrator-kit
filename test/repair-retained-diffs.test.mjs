import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { repair } from "../src/engine.mjs";

function createTempRepo() {
  // Under the OS temp directory, never inside the kit checkout — interrupted
  // runs must not leave `.agent/state/repairs/` debris for the next agent.
  const root = mkdtempSync(join(tmpdir(), "jok-repair-retained-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "repair-test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Repair Test"], { cwd: root });
  writeFileSync(join(root, "app.js"), "export const value = 1;\n");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  mkdirSync(join(root, ".agent"), { recursive: true });
  return root;
}

const FAILING_VERIFY = "node -e \"console.error('AssertionError: expected 1 to equal 2'); process.exit(1)\"";

function repairConfig(overrides = {}) {
  return {
    baseBranch: "main",
    provider: "jules",
    verify: { test: FAILING_VERIFY, build: "" },
    limits: { repairAttempts: 2, dailyTasks: 300 },
    scope: { deny: [], allow: [], protect: [] },
    ...overrides,
  };
}

describe("repair retains failed attempt diffs and diagnostics", () => {
  it("records verified:false attempts with diff+diagnostics and persists patch artifacts", async () => {
    const root = createTempRepo();
    try {
      const mockProvider = {
        dispatch: async () => {
          writeFileSync(join(root, "app.js"), "export const value = 99; // repair attempt\n");
          return { id: "mock-repair-session" };
        },
      };

      const res = await repair(
        {
          command: FAILING_VERIFY,
          stderr: "AssertionError: expected 1 to equal 2",
          status: 1,
        },
        {
          root,
          dryRun: true,
          provider: mockProvider,
          config: repairConfig(),
        }
      );

      assert.equal(res.ok, false);
      assert.ok(res.attempts.length >= 1, "at least one attempt recorded");
      assert.ok(res.repairDir, "repairDir returned for review");
      assert.match(res.repairDir, /^\.agent\/state\/repairs\/repair-/);

      const failed = res.attempts.find((a) => a.ok === false && a.verified === false);
      assert.ok(failed, "failed gate attempt present");
      assert.equal(failed.verified, false);
      assert.equal(typeof failed.diff, "string");
      assert.match(failed.diff, /app\.js/);
      assert.ok(failed.diagnostics && typeof failed.diagnostics === "object");
      assert.equal(failed.diagnostics.phase, "verify");
      assert.ok(failed.diagnostics.patchPath);
      assert.ok(failed.diagnostics.diagnosticsPath);

      const absRepairDir = join(root, res.repairDir);
      assert.equal(existsSync(absRepairDir), true);
      const names = readdirSync(absRepairDir);
      assert.ok(names.includes(`attempt-${failed.n}.patch`));
      assert.ok(names.includes(`attempt-${failed.n}-diagnostics.json`));

      const patchOnDisk = readFileSync(join(absRepairDir, `attempt-${failed.n}.patch`), "utf8");
      assert.match(patchOnDisk, /export const value = 99/);

      const diagOnDisk = JSON.parse(
        readFileSync(join(absRepairDir, `attempt-${failed.n}-diagnostics.json`), "utf8")
      );
      assert.equal(diagOnDisk.phase, "verify");
      assert.equal(diagOnDisk.ok, undefined);
      assert.ok(diagOnDisk.error || diagOnDisk.stderr || diagOnDisk.code != null);

      // Kit checkout must remain untouched.
      assert.equal(existsSync(join(process.cwd(), ".agent/state/repairs")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records dispatch failures with phase=dispatch without fabricating verify artifacts", async () => {
    const root = createTempRepo();
    try {
      const mockProvider = {
        dispatch: async () => {
          const err = new Error("simulated dispatch blow-up");
          throw err;
        },
      };

      const res = await repair(
        { command: FAILING_VERIFY, stderr: "boom", status: 1 },
        {
          root,
          dryRun: true,
          provider: mockProvider,
          config: repairConfig({ limits: { repairAttempts: 1, dailyTasks: 300 } }),
        }
      );

      assert.equal(res.ok, false);
      assert.equal(res.attempts.length, 1);
      assert.equal(res.attempts[0].ok, false);
      assert.equal(res.attempts[0].phase, "dispatch");
      assert.match(res.attempts[0].error, /simulated dispatch blow-up/);
      assert.equal(res.repairDir, null);
      assert.equal(existsSync(join(root, ".agent/state/repairs")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("CLI --json serializes attempts with diff and diagnostics", () => {
    const root = createTempRepo();
    try {
      writeFileSync(
        join(root, ".agent/config.yml"),
        [
          "provider: jules",
          "verify:",
          `  test: ${JSON.stringify(FAILING_VERIFY)}`,
          '  build: ""',
          "limits:",
          "  repair_attempts: 1",
          "  daily_tasks: 300",
          "",
        ].join("\n")
      );

      // Seed a dirty tree so the retained patch is non-empty under dry-run
      // (the dry-run provider does not mutate the working tree itself).
      writeFileSync(join(root, "app.js"), "export const value = 42; // pre-seeded repair residue\n");

      const cli = spawnSync(
        process.execPath,
        [
          join(process.cwd(), "bin", "agentctl.mjs"),
          "repair",
          "--input",
          "AssertionError: expected 1 to equal 2",
          "--json",
          "--dry-run",
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, ["JULES_" + "API_KEY"]: "stub" },
          timeout: 45_000,
        }
      );

      assert.equal(cli.status, 1, `expected repair failure exit\n${cli.stderr}\n${cli.stdout}`);
      const jsonStart = cli.stdout.indexOf("{");
      assert.ok(jsonStart >= 0, "CLI --json must emit a JSON object");
      const parsed = JSON.parse(cli.stdout.slice(jsonStart));
      assert.equal(parsed.ok, false);
      assert.ok(Array.isArray(parsed.attempts));
      assert.ok(parsed.attempts.length >= 1);
      const attempt = parsed.attempts.find((a) => a.verified === false);
      assert.ok(attempt, "attempt with verified: false present");
      assert.equal(typeof attempt.diff, "string");
      assert.match(attempt.diff, /app\.js/);
      assert.ok(attempt.diagnostics && typeof attempt.diagnostics === "object");
      assert.equal(attempt.diagnostics.phase, "verify");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
