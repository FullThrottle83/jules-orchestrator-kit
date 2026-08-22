import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

import { scaffoldRepoAssets, ensureGitignore, RUNTIME_GITIGNORE_ENTRIES } from "../src/scaffold.mjs";

const CLI = fileURLToPath(new URL("../bin/agentctl.mjs", import.meta.url));

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "jules-scaffold-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "d", version: "1.0.0", type: "module", scripts: { test: "true" } }),
    "utf-8"
  );
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

test("src/scaffold.mjs", async (t) => {
  await t.test("scaffolds the assets the documented features depend on", () => {
    const dir = tempRepo();
    try {
      const res = scaffoldRepoAssets(dir);
      // `--role bolt` resolves against .agent/prompts/. Without it the flag is
      // a hard error on `task create` and a silent downgrade on `dispatch`.
      assert.ok(existsSync(join(dir, ".agent/prompts/Bolt.md")), "role prompts must exist");
      assert.ok(existsSync(join(dir, "AGENTS.md")), "the agent must be able to read the protocol");
      assert.ok(existsSync(join(dir, ".agent/rules/dynamic-guardrails.json")));
      assert.ok(existsSync(join(dir, ".agent/jules-queue")));
      assert.ok(res.created.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("appends to an existing AGENTS.md instead of replacing it", () => {
    const dir = tempRepo();
    try {
      writeFileSync(join(dir, "AGENTS.md"), "# House rules\n\nAlways rebase.\n", "utf-8");
      scaffoldRepoAssets(dir);
      const content = readFileSync(join(dir, "AGENTS.md"), "utf-8");
      assert.match(content, /Always rebase/, "existing briefing must survive");
      assert.match(content, /<MCP_DIRECTIVE>/, "kit directives must be added");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("gitignore is idempotent and orders the queue negation last", () => {
    const dir = tempRepo();
    try {
      const first = ensureGitignore(dir);
      assert.equal(first.length, RUNTIME_GITIGNORE_ENTRIES.length);
      assert.deepEqual(ensureGitignore(dir), [], "a second run must add nothing");

      const lines = readFileSync(join(dir, ".gitignore"), "utf-8").split("\n");
      // git applies the last matching pattern, so re-including README.md only
      // works if the negation follows the glob that swallowed it.
      assert.ok(
        lines.indexOf(".agent/jules-queue/*.md") < lines.indexOf("!.agent/jules-queue/README.md"),
        "the negation must come after the pattern it re-includes"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("does not clobber local edits without force", () => {
    const dir = tempRepo();
    try {
      mkdirSync(join(dir, ".agent/prompts"), { recursive: true });
      writeFileSync(join(dir, ".agent/prompts/Bolt.md"), "my own bolt\n", "utf-8");
      scaffoldRepoAssets(dir);
      assert.equal(readFileSync(join(dir, ".agent/prompts/Bolt.md"), "utf-8"), "my own bolt\n");

      scaffoldRepoAssets(dir, { force: true });
      assert.notEqual(readFileSync(join(dir, ".agent/prompts/Bolt.md"), "utf-8"), "my own bolt\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("init leaves no kit runtime state loose in the working tree", () => {
    // The gate audits the working tree. Every ledger, evidence manifest and
    // telemetry line the kit writes used to land there untracked and get read
    // as an agent edit — first as a scope violation, then, once enough
    // accumulated, as a CRITICAL secret verdict. A new user hit both before
    // dispatching anything.
    const dir = tempRepo();
    try {
      const env = { ...process.env };
      delete env.JULES_API_KEY;
      delete env.GEMINI_API_KEY;
      const run = (args) => spawnSync("node", [CLI, ...args], { cwd: dir, env, encoding: "utf-8" });

      assert.equal(run(["init"]).status, 0);
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-qm", "agent config"], { cwd: dir });

      assert.equal(
        run(["task", "create", "--title", "T", "--prompt", "Change slugify in src/m.mjs. Verify with: npm test"]).status,
        0
      );
      run(["doctor"]);
      run(["evidence", "generate"]);

      const stray = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
        cwd: dir,
        encoding: "utf-8",
      })
        .split("\n")
        .filter((f) => f.startsWith(".agent/"));

      assert.deepEqual(stray, [], `kit runtime state must not reach the gate: ${stray.join(", ")}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
