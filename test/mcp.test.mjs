import test from "node:test";
import assert from "node:assert/strict";
import { handleMcpRequest, startMcpServer, MCP_SERVER_INFO, MCP_TOOLS } from "../src/mcp.mjs";
import { BudgetError } from "../src/state.mjs";
import { PassThrough } from "node:stream";

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
    assert.equal(res.result.tools.length, 4);
    assert.deepEqual(res.result.tools, MCP_TOOLS);
    const names = res.result.tools.map((t) => t.name);
    assert.deepEqual(names, ["dispatch_jules_task", "audit_jules_gate", "check_risk_tier", "get_jules_status"]);
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
    assert.equal(parsed.version, "0.9.4");
    assert.equal(typeof parsed.budget.used, "number");
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
});
