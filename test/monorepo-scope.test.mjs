import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { gate } from "../src/engine.mjs";
import { loadConfig } from "../src/config.mjs";
import { planInit } from "../src/wizard-init.mjs";

const git = (dir, args) => execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: "pipe" });

/**
 * A workspace where pkg-a passes and pkg-b fails, so which suite ran is visible
 * in the verdict rather than only in the logs.
 */
function workspace(verifyBlock) {
  const dir = mkdtempSync(join(tmpdir(), "jok-mono-"));
  git(dir, ["init", "-q", "-b", "main"]);
  mkdirSync(join(dir, "packages", "pkg-a"), { recursive: true });
  mkdirSync(join(dir, "packages", "pkg-b"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"], scripts: { test: "npm test --workspaces" } })
  );
  for (const p of ["pkg-a", "pkg-b"]) {
    writeFileSync(
      join(dir, "packages", p, "package.json"),
      JSON.stringify({ name: p, version: "1.0.0", type: "module", scripts: { test: "node --test" } })
    );
  }
  writeFileSync(join(dir, "packages", "pkg-a", "a.test.mjs"), 'import {test} from "node:test";\ntest("a ok",()=>{});\n');
  writeFileSync(
    join(dir, "packages", "pkg-b", "b.test.mjs"),
    'import {test} from "node:test";\nimport assert from "node:assert/strict";\ntest("b broken",()=>{assert.equal(1,2);});\n'
  );
  writeFileSync(join(dir, ".gitignore"), ".agent/state/\n.agent/evidence/\n.agent/history/\n");
  mkdirSync(join(dir, ".agent"), { recursive: true });
  writeFileSync(join(dir, ".agent", "config.yml"), `version: 1\nbase_branch: main\n${verifyBlock}`);
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  return dir;
}

describe("a one-package change does not run every package's suite", () => {
  it("runs only the affected project when scope is affected", async () => {
    const dir = workspace('verify:\n  scope: affected\n  test: "npm test --workspaces"\n');
    try {
      writeFileSync(join(dir, "packages", "pkg-a", "index.mjs"), "export const x = 1;\n");

      const res = await gate({ root: dir, config: loadConfig(dir), base: "main", mode: "working-tree" });
      const ran = (res.phases.find((p) => p.phase === "verify")?.executionRecords || []).map((r) => r.cmd);
      assert.ok(ran.some((c) => c.includes("packages/pkg-a")), `pkg-a's suite must run: ${ran.join(" | ")}`);
      assert.equal(res.ok, true, "pkg-b is broken and untouched, so it must not decide this verdict");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps running everything by default", async () => {
    const dir = workspace('verify:\n  test: "npm test --workspaces"\n');
    try {
      writeFileSync(join(dir, "packages", "pkg-a", "index.mjs"), "export const x = 1;\n");

      const res = await gate({ root: dir, config: loadConfig(dir), base: "main", mode: "working-tree" });
      assert.equal(res.ok, false, "narrowing what runs must never happen without being asked for");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("widens again when the change reaches the root", async () => {
    const dir = workspace('verify:\n  scope: affected\n  test: "npm test --workspaces"\n');
    try {
      // A file outside any package resolves to the root project, so the root
      // command joins the run — a narrower gate that misses the breakage is
      // worse than a slow one.
      writeFileSync(join(dir, "shared.mjs"), "export const y = 1;\n");

      const res = await gate({ root: dir, config: loadConfig(dir), base: "main", mode: "working-tree" });
      const ran = (res.phases.find((p) => p.phase === "verify")?.executionRecords || []).map((r) => r.cmd).join(" ");
      assert.match(ran, /npm test --workspaces|npm test/, "the root suite must be part of the run");
      assert.equal(res.ok, false, "and pkg-b's failure must surface");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hands a monorepo the affected scope at init, and a single project the global one", () => {
    const mono = workspace('verify:\n  test: "npm test"\n');
    try {
      assert.equal(planInit(mono, { env: { PATH: "" } }).verifyScope, "affected");
    } finally {
      rmSync(mono, { recursive: true, force: true });
    }

    const single = mkdtempSync(join(tmpdir(), "jok-single-"));
    try {
      git(single, ["init", "-q", "-b", "main"]);
      writeFileSync(join(single, "package.json"), JSON.stringify({ name: "s", version: "1.0.0", scripts: { test: "node --test" } }));
      assert.equal(planInit(single, { env: { PATH: "" } }).verifyScope, "global");
    } finally {
      rmSync(single, { recursive: true, force: true });
    }
  });
});
