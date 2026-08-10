import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldIdeConfig } from "../src/ops/ide-scaffold.mjs";

test("IDE Native MCP Config Scaffolder", async (t) => {
  let tmpDir;

  t.beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ide-scaffold-test-"));
  });

  t.afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("a) scaffolds Cursor MCP configuration in .cursor/mcp.json", () => {
    const res = scaffoldIdeConfig("cursor", { root: tmpDir });
    assert.equal(res.ok, true);
    const cursorFile = join(tmpDir, ".cursor", "mcp.json");
    assert.ok(existsSync(cursorFile));

    const json = JSON.parse(readFileSync(cursorFile, "utf-8"));
    assert.ok(json.mcpServers["jules-orchestrator-kit"]);
  });

  await t.test("b) scaffolds VS Code tasks in .vscode/tasks.json", () => {
    const res = scaffoldIdeConfig("vscode", { root: tmpDir });
    assert.equal(res.ok, true);
    const vscodeFile = join(tmpDir, ".vscode", "tasks.json");
    assert.ok(existsSync(vscodeFile));

    const json = JSON.parse(readFileSync(vscodeFile, "utf-8"));
    assert.ok(Array.isArray(json.tasks));
    assert.ok(json.tasks.some((t) => t.label.includes("Doctor")));
  });

  await t.test("c) scaffolds Claude snippet in .agent/claude_desktop_config.snippet.json", () => {
    const res = scaffoldIdeConfig("claude", { root: tmpDir });
    assert.equal(res.ok, true);
    const snippetFile = join(tmpDir, ".agent", "claude_desktop_config.snippet.json");
    assert.ok(existsSync(snippetFile));

    const json = JSON.parse(readFileSync(snippetFile, "utf-8"));
    assert.ok(json.mcpServers["jules-orchestrator-kit"]);
  });

  await t.test("d) target 'all' generates configs for all supported IDE targets", () => {
    const res = scaffoldIdeConfig("all", { root: tmpDir });
    assert.equal(res.ok, true);
    assert.equal(res.results.length, 3);
  });
});
