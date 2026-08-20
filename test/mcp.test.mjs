import test from "node:test";
import assert from "node:assert/strict";
import { handleMcpRequest, startMcpServer, MCP_SERVER_INFO, MCP_TOOLS } from "../src/mcp.mjs";
import { BudgetError } from "../src/state.mjs";
import { KIT_VERSION } from "../src/version.mjs";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";

test("Model Context Protocol (MCP) Server", async (t) => {
  await t.test("handles ping request", async () => {
    const res = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "ping" });
    assert.deepEqual(res, { jsonrpc: "2.0", id: 1, result: {} });
  });

  await t.test("handles initialize request", async () => {
    const res = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "initialize" });
    assert.equal(res.jsonrpc, "2.0");
    assert.equal(res.id, 2);
    assert.equal(res.result.protocolVersion, "2024-11-05");
    assert.deepEqual(res.result.serverInfo, MCP_SERVER_INFO);
  });

  await t.test("lists available tools via tools/list", async () => {
    const res = await handleMcpRequest({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    assert.equal(res.jsonrpc, "2.0");
    assert.equal(res.id, 3);
    assert.equal(Array.isArray(res.result.tools), true);
    assert.equal(res.result.tools.length, 8);
    assert.deepEqual(res.result.tools, MCP_TOOLS);
    const names = res.result.tools.map((t) => t.name);
    assert.deepEqual(names, [
      "dispatch_jules_task",
      "audit_jules_gate",
      "check_risk_tier",
      "get_jules_status",
      "telemetry_tail",
      "optimize_jules_prompt",
      "get_web_task_template",
      "record_system_learning",
    ]);
  });

  await t.test("executes check_risk_tier tool call", async () => {
    const res = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "check_risk_tier",
        arguments: { files: ["README.md"], diffLines: 5 },
      },
    });
    assert.equal(res.jsonrpc, "2.0");
    assert.equal(res.id, 4);
    assert.equal(res.result.content.length, 1);
    const parsed = JSON.parse(res.result.content[0].text);
    assert.equal(parsed.tier, "R0_COSMETIC");
  });

  await t.test("executes get_jules_status tool call", async () => {
    const res = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "get_jules_status", arguments: {} },
    });
    assert.equal(res.jsonrpc, "2.0");
    assert.equal(res.id, 5);
    const parsed = JSON.parse(res.result.content[0].text);
    // Asserted against the manifest rather than a literal: this test used to
    // pin 0.29.1 and kept passing while the CLI banner moved on to 0.32.x.
    assert.equal(parsed.version, KIT_VERSION);
    assert.equal(typeof parsed.budget.used, "number");
  });

  await t.test("executes record_system_learning tool call", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpDir = mkdtempSync(join(tmpdir(), "jules-mcp-learning-"));
    try {
      const res = await handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 55,
          method: "tools/call",
          params: {
            name: "record_system_learning",
            arguments: {
              trigger: "Vercel Edge Buffer crash",
              solution: "Use Uint8Array instead of Buffer in Edge runtime",
              category: "EDGE",
            },
          },
        },
        { root: tmpDir }
      );
      assert.equal(res.jsonrpc, "2.0");
      assert.equal(res.id, 55);
      const parsed = JSON.parse(res.result.content[0].text);
      assert.equal(parsed.ok, true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("returns error for unknown method", async () => {
    const res = await handleMcpRequest({ jsonrpc: "2.0", id: 6, method: "non_existent_method" });
    assert.equal(res.jsonrpc, "2.0");
    assert.equal(res.id, 6);
    assert.equal(res.error.code, -32601);
  });

  await t.test("runs startMcpServer stdio stream loop", async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    startMcpServer(input, output);

    let outputData = "";
    output.on("data", (chunk) => {
      outputData += chunk.toString();
    });

    input.write(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "ping" }) + "\n");

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(outputData, /"result":\{\}/);
  });

  await t.test("BudgetError assigns code 7", () => {
    const err = new BudgetError("Exhausted");
    assert.equal(err.code, 7);
    assert.equal(err.name, "BudgetError");
  });

  await t.test("BudgetError exit code propagation in agentctl dispatch", () => {
    // A live dispatch fails at the budget gate before any provider call, so this
    // needs no API key and makes no network request.
    const res = spawnSync("node", ["bin/agentctl.mjs", "dispatch", "-p", "test"], {
      env: { ...process.env, JULES_DAILY_BUDGET: "0" }
    });
    assert.equal(res.status, 7);
  });

  await t.test("--dry-run succeeds even when the daily budget is exhausted", () => {
    // Previously this exited 7: a dry run reserved a real slot before deciding it
    // had nothing to do, so previewing a task could be blocked by (and consume)
    // the operator's quota.
    const res = spawnSync("node", ["bin/agentctl.mjs", "dispatch", "-p", "test", "--dry-run"], {
      env: { ...process.env, JULES_DAILY_BUDGET: "0" }
    });
    assert.equal(res.status, 0);
  });

  await t.test("handles unrecognized JSON-RPC method names gracefully with JSON-RPC error response -32601", async () => {
    // Unrecognized method
    const res1 = await handleMcpRequest({ jsonrpc: "2.0", id: 101, method: "non_existent_method" });
    assert.equal(res1.jsonrpc, "2.0");
    assert.equal(res1.id, 101);
    assert.equal(res1.error.code, -32601);

    // Unrecognized tool name under tools/call
    const res2 = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 102,
      method: "tools/call",
      params: { name: "invalid_tool_name_xyz" },
    });
    assert.equal(res2.jsonrpc, "2.0");
    assert.equal(res2.id, 102);
    assert.equal(res2.error.code, -32601);
  });

  await t.test("handles invalid/malformed parameters passed to check_risk_tier tool", async () => {
    // files missing completely
    const resMissingFiles = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 201,
      method: "tools/call",
      params: { name: "check_risk_tier", arguments: {} },
    });
    assert.equal(resMissingFiles.jsonrpc, "2.0");
    assert.equal(resMissingFiles.id, 201);
    assert.equal(resMissingFiles.error.code, -32602);
    assert.match(resMissingFiles.error.message, /files' must be an array/);

    // files not being an array (string)
    const resStringFiles = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 202,
      method: "tools/call",
      params: { name: "check_risk_tier", arguments: { files: "not-an-array" } },
    });
    assert.equal(resStringFiles.jsonrpc, "2.0");
    assert.equal(resStringFiles.id, 202);
    assert.equal(resStringFiles.error.code, -32602);

    // files contains non-string elements
    const resNonStringElem = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 203,
      method: "tools/call",
      params: { name: "check_risk_tier", arguments: { files: ["valid.txt", 123] } },
    });
    assert.equal(resNonStringElem.jsonrpc, "2.0");
    assert.equal(resNonStringElem.id, 203);
    assert.equal(resNonStringElem.error.code, -32602);

    // diffLines parameter is not a number
    const resInvalidDiffLines = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 204,
      method: "tools/call",
      params: {
        name: "check_risk_tier",
        arguments: { files: ["valid.txt"], diffLines: "not-a-number" },
      },
    });
    assert.equal(resInvalidDiffLines.jsonrpc, "2.0");
    assert.equal(resInvalidDiffLines.id, 204);
    assert.equal(resInvalidDiffLines.error.code, -32602);
  });
});
