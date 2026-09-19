/**
 * ROADMAP_V1 packed-package downstream fixture.
 *
 * Exercises the consumer lifecycle against a real `npm pack` artifact:
 *   init → doctor → task create → gate → uninstall
 *
 * Zero runtime deps: node builtins only. Packs once from the repository root
 * and installs into a temporary git consumer so doctor/gate see a real repo
 * with a falsifiable test oracle (required for APPROVED).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  rmSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const GITIGNORE_BLOCK_HEADER = "# Jules Orchestrator runtime state & credentials";

const isWin = process.platform === "win32";

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, timeout?: number, env?: NodeJS.ProcessEnv }} [opts]
 */
function run(cmd, args, opts = {}) {
  const env = { ...(opts.env ?? process.env) };
  // Isolate downstream child processes from verification net-guard preload
  delete env.NODE_OPTIONS;

  const actualCmd = isWin && (cmd === "npm" || cmd === "npx") ? `${cmd}.cmd` : cmd;
  return spawnSync(actualCmd, args, {
    cwd: opts.cwd,
    encoding: "utf-8",
    timeout: opts.timeout ?? 120_000,
    env,
    shell: isWin,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * @param {import("node:child_process").SpawnSyncReturns<string>} result
 * @param {string} label
 */
function assertOk(result, label) {
  const detail = [
    `${label} exited ${result.status}`,
    result.error ? `error: ${result.error.message}` : null,
    result.stdout?.trim() ? `stdout:\n${result.stdout}` : null,
    result.stderr?.trim() ? `stderr:\n${result.stderr}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  assert.equal(result.status, 0, detail);
  assert.equal(result.error, undefined, detail);
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  const result = run("git", args, { cwd, timeout: 30_000 });
  assertOk(result, `git ${args.join(" ")}`);
  return result;
}

/**
 * Strip the kit runtime block from `.gitignore`, preserving user content
 * (docs/uninstall.md).
 * @param {string} content
 */
function stripKitGitignoreBlock(content) {
  const marker = `\n${GITIGNORE_BLOCK_HEADER}\n`;
  const idx = content.indexOf(marker);
  if (idx !== -1) {
    return content.slice(0, idx) + (content.endsWith("\n") ? "\n" : "");
  }
  if (content.startsWith(`${GITIGNORE_BLOCK_HEADER}\n`)) {
    return "";
  }
  return content;
}

test(
  "ROADMAP_V1 downstream packed-package fixture: init → doctor → task → gate → uninstall",
  { timeout: 300_000 },
  () => {
    const packDir = mkdtempSync(join(tmpdir(), "kit-downstream-pack-"));
    const consumer = mkdtempSync(join(tmpdir(), "kit-downstream-consumer-"));

    try {
      // --- a. git repo with main + dummy identity ---
      git(consumer, ["init", "-b", "main"]);
      git(consumer, ["config", "user.name", "Downstream Fixture"]);
      git(consumer, ["config", "user.email", "downstream-fixture@example.com"]);

      // --- b. Minimal package with a falsifiable, non-placeholder oracle ---
      // `node -e 'process.exit(0)'` is rejected by the gate as a placeholder.
      // A real `node --test` suite exits 0 and prints a countable summary.
      writeFileSync(join(consumer, ".gitignore"), "node_modules/\n");
      writeFileSync(join(consumer, "index.mjs"), "export const add = (a, b) => a + b;\n");
      mkdirSync(join(consumer, "test"), { recursive: true });
      writeFileSync(
        join(consumer, "test", "add.test.mjs"),
        [
          'import assert from "node:assert/strict";',
          'import { test } from "node:test";',
          'import { add } from "../index.mjs";',
          'test("adds", () => assert.equal(add(1, 2), 3));',
          "",
        ].join("\n")
      );
      writeFileSync(
        join(consumer, "package.json"),
        JSON.stringify(
          {
            name: "downstream-consumer",
            version: "1.0.0",
            private: true,
            type: "module",
            scripts: { test: "node --test" },
          },
          null,
          2
        ) + "\n"
      );

      // --- c. Commit initial baseline (clean tree) ---
      git(consumer, ["add", "-A"]);
      git(consumer, ["commit", "-m", "baseline: minimal consumer with passing tests"]);

      // --- d. npm pack from repository root (not the temp consumer) ---
      const pack = run("npm", ["pack", "--pack-destination", packDir], {
        cwd: KIT_ROOT,
        timeout: 180_000,
      });
      assertOk(pack, "npm pack");
      const tarballName = pack.stdout
        .trim()
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .pop();
      assert.ok(
        tarballName && tarballName.endsWith(".tgz"),
        `npm pack stdout missing tarball name:\n${pack.stdout}`
      );
      const tarballPath = join(packDir, tarballName);
      assert.ok(existsSync(tarballPath), `packed tarball missing at ${tarballPath}`);

      // --- e. npm install packed artifact into the consumer ---
      const install = run("npm", ["install", tarballPath], {
        cwd: consumer,
        timeout: 180_000,
      });
      assertOk(install, "npm install <tarball>");

      // Commit dependency manifests so package.json / lockfile protect rules
      // do not reject the later gate (install is consumer setup, not an agent edit).
      git(consumer, ["add", "package.json", "package-lock.json"]);
      git(consumer, ["commit", "-m", "chore: install packed jules-orchestrator-kit"]);

      // --- f. init --yes ---
      const init = run("npx", ["agentctl", "init", "--yes"], {
        cwd: consumer,
        timeout: 120_000,
      });
      assertOk(init, "npx agentctl init --yes");

      assert.ok(
        existsSync(join(consumer, ".agent", "config.yml")),
        ".agent/config.yml must exist after init"
      );
      assert.equal(
        existsSync(join(consumer, ".agent", "jules.yml")),
        false,
        "deprecated .agent/jules.yml must not be written by default init"
      );

      const gitignoreAfterInit = readFileSync(join(consumer, ".gitignore"), "utf-8");
      assert.ok(
        gitignoreAfterInit.includes(GITIGNORE_BLOCK_HEADER),
        `.gitignore must include the kit runtime block header:\n${gitignoreAfterInit}`
      );
      assert.ok(
        gitignoreAfterInit.includes(".agent/state/") || gitignoreAfterInit.includes(".agent/history/"),
        `.gitignore kit block should list runtime paths:\n${gitignoreAfterInit}`
      );

      // Commit init artifacts so gate evaluates a clean working tree (same
      // posture as a consumer that followed the README quickstart).
      git(consumer, ["add", ".agent/config.yml", ".gitignore"]);
      git(consumer, ["commit", "-m", "chore: agentctl init"]);

      // --- g. doctor --json ---
      const doctor = run("npx", ["agentctl", "doctor", "--json"], {
        cwd: consumer,
        timeout: 120_000,
      });
      assertOk(doctor, "npx agentctl doctor --json");

      let report;
      try {
        report = JSON.parse(doctor.stdout);
      } catch (err) {
        assert.fail(
          `doctor --json stdout was not valid JSON: ${err.message}\n${doctor.stdout}\n${doctor.stderr}`
        );
      }
      assert.equal(
        report?.summary?.fail ?? -1,
        0,
        `doctor reported failures:\n${JSON.stringify(report, null, 2)}`
      );
      const criticalFails = (report.results || []).filter(
        (r) => r && r.status === "fail" && r.severity === "critical"
      );
      assert.equal(
        criticalFails.length,
        0,
        `doctor had critical failures: ${criticalFails.map((r) => r.id).join(", ")}\n${JSON.stringify(report, null, 2)}`
      );

      // --- h. task create ---
      // `--verify` is the documented alias for `--verify-cmd` (both accepted).
      const taskCreate = run(
        "npx",
        [
          "agentctl",
          "task",
          "create",
          "--prompt",
          "E2E lifecycle verification",
          "--verify",
          "npm test",
        ],
        { cwd: consumer, timeout: 120_000 }
      );
      assertOk(taskCreate, "npx agentctl task create");

      const queueDir = join(consumer, ".agent", "jules-queue");
      assert.ok(existsSync(queueDir), "task create should ensure .agent/jules-queue/");
      const envelopes = readdirSync(queueDir).filter((f) => f.endsWith(".md") && f !== "README.md");
      assert.ok(
        envelopes.length >= 1,
        `expected a task envelope under .agent/jules-queue/, found: ${readdirSync(queueDir).join(", ") || "(empty)"}`
      );
      const envelopeBody = readFileSync(join(queueDir, envelopes[0]), "utf-8");
      assert.ok(envelopeBody.length > 0, "task envelope should be non-empty");

      // --- i. gate --dry-run and gate ---
      const gateDry = run("npx", ["agentctl", "gate", "--dry-run"], {
        cwd: consumer,
        timeout: 180_000,
      });
      assertOk(gateDry, "npx agentctl gate --dry-run");

      const gate = run("npx", ["agentctl", "gate"], {
        cwd: consumer,
        timeout: 180_000,
      });
      assertOk(gate, "npx agentctl gate");

      // --- j. Uninstall per docs/uninstall.md ---
      const configPath = join(consumer, ".agent", "config.yml");
      assert.ok(existsSync(configPath), "precondition: config exists before uninstall");
      unlinkSync(configPath);
      rmSync(join(consumer, ".agent"), { recursive: true, force: true });

      const gitignorePath = join(consumer, ".gitignore");
      const restoredGitignore = stripKitGitignoreBlock(readFileSync(gitignorePath, "utf-8"));
      writeFileSync(
        gitignorePath,
        restoredGitignore.endsWith("\n") ? restoredGitignore : `${restoredGitignore}\n`
      );

      assert.equal(existsSync(join(consumer, ".agent")), false, ".agent/ must be gone after uninstall");
      assert.equal(existsSync(configPath), false, ".agent/config.yml must be gone after uninstall");
      const gitignoreFinal = readFileSync(gitignorePath, "utf-8");
      assert.equal(
        gitignoreFinal.includes(GITIGNORE_BLOCK_HEADER),
        false,
        `kit gitignore block must be removed:\n${gitignoreFinal}`
      );

      // Prove the consumer can return to the post-install baseline (dependency
      // retained; kit-owned init writes discarded) with a clean working tree.
      const installSha = run("git", ["rev-parse", "HEAD~1"], { cwd: consumer, timeout: 15_000 });
      assertOk(installSha, "git rev-parse HEAD~1");
      git(consumer, ["reset", "--hard", installSha.stdout.trim()]);
      const status = run("git", ["status", "--porcelain"], { cwd: consumer, timeout: 15_000 });
      assertOk(status, "git status");
      assert.equal(
        status.stdout.trim(),
        "",
        `after uninstall + reset to install baseline, tree should be clean:\n${status.stdout}`
      );
      assert.equal(
        existsSync(join(consumer, ".agent")),
        false,
        "install baseline must not include .agent/"
      );
    } finally {
      rmSync(consumer, { recursive: true, force: true });
      rmSync(packDir, { recursive: true, force: true });
    }
  }
);
