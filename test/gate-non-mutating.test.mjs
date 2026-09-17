import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { gate } from "../src/engine.mjs";

const CLI = fileURLToPath(new URL("../bin/agentctl.mjs", import.meta.url));

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "agentctl-gate-boundary-"));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Gate Boundary Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "gate@example.test"], { cwd: root });

  mkdirSync(join(root, ".agent"), { recursive: true });
  writeFileSync(
    join(root, ".agent", "config.yml"),
    [
      "version: 1",
      "provider: jules",
      "verify:",
      "  test: node -e \"process.exit(1)\"",
      "",
    ].join("\n")
  );
  writeFileSync(join(root, "index.js"), "export const value = 1;\n");

  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: root });
  return root;
}

test("gate remains non-mutating when legacy fix:true is supplied", async () => {
  const root = createFixture();

  try {
    const result = await gate({
      root,
      base: "HEAD",
      mode: "working-tree",
      fix: true,
      dryRun: true,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 4);
    assert.equal(
      Object.hasOwn(result, "repairs"),
      false,
      "gate must not invoke or report the repair loop"
    );

    const verify = result.phases.find((phase) => phase.phase === "verify");
    assert.equal(verify?.ok, false);
    assert.equal(verify?.failure?.exitCode, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI refuses implicit gate repair and exposes explicit repair", () => {
  const root = createFixture();

  try {
    const legacy = spawnSync(process.execPath, [CLI, "gate", "--fix"], {
      cwd: root,
      encoding: "utf-8",
      env: { ...process.env, JULES_API_KEY: "", AGENT_API_KEY: "" },
    });

    assert.equal(legacy.status, 2);
    assert.match(legacy.stderr, /gate.*non-mutating/i);
    assert.match(legacy.stderr, /agentctl repair/i);

    const explicit = spawnSync(
      process.execPath,
      [CLI, "repair", "--input", "TypeError: boom", "--task", "--json"],
      {
        cwd: root,
        encoding: "utf-8",
        env: { ...process.env, JULES_API_KEY: "", AGENT_API_KEY: "" },
      }
    );

    assert.equal(explicit.status, 0, explicit.stderr || explicit.stdout);
    const planned = JSON.parse(explicit.stdout);
    assert.ok(planned.taskId || planned.id, "repair --task should synthesize an explicit repair task");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
