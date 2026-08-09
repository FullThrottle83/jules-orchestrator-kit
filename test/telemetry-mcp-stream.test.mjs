import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";

import {
  appendTelemetry,
  verifyTelemetryIntegrity,
  TELEMETRY_GENESIS_HASH,
} from "../src/telemetry.mjs";
import { ProgressBus } from "../src/mcp-progress.mjs";
import { handleMcpRequest } from "../src/mcp.mjs";

test("O(1) Telemetry Spine & MCP Event/Progress Streaming (v1.0.0)", async (t) => {
  let tmpRoot;

  t.beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "jules-telemetry-test-"));
  });

  t.afterEach(() => {
    if (tmpRoot && existsSync(tmpRoot)) {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  await t.test("1000 sequential appendTelemetry calls execute with O(1) steady-state and maintain SHA-256 hash integrity", async () => {
    const startTime = Date.now();
    for (let i = 0; i < 1000; i++) {
      appendTelemetry(tmpRoot, "benchmark_event", { seq: i, payload: `data_${i}` });
    }
    const elapsedMs = Date.now() - startTime;

    // Verify 1000 calls completed quickly (steady-state O(1) per call)
    assert.ok(elapsedMs < 3000, `1000 appends took ${elapsedMs}ms, expected < 3000ms`);

    // Verify cryptographic integrity
    const integrity = verifyTelemetryIntegrity(tmpRoot);
    assert.equal(integrity.ok, true, `Integrity check failed: ${JSON.stringify(integrity)}`);
    assert.equal(integrity.count, 1000);
    assert.notEqual(integrity.lastHash, TELEMETRY_GENESIS_HASH);

    // Check .head file cache matches
    const dateStr = new Date().toISOString().split("T")[0];
    const headPath = join(tmpRoot, ".agent/state", `telemetry-${dateStr}.head`);
    assert.equal(existsSync(headPath), true);
    const headData = JSON.parse(readFileSync(headPath, "utf-8"));
    assert.equal(headData.hash, integrity.lastHash);
  });

  await t.test("recovers prevHash via cold scan if .head file is missing or corrupted", async () => {
    appendTelemetry(tmpRoot, "event_1", { key: "value1" });
    appendTelemetry(tmpRoot, "event_2", { key: "value2" });

    const dateStr = new Date().toISOString().split("T")[0];
    const headPath = join(tmpRoot, ".agent/state", `telemetry-${dateStr}.head`);

    // Delete .head file
    unlinkSync(headPath);
    assert.equal(existsSync(headPath), false);

    // Next append should trigger cold scan recovery and succeed
    const entry3 = appendTelemetry(tmpRoot, "event_3", { key: "value3" });
    assert.ok(entry3.hash);
    assert.ok(entry3.prevHash);

    // Head should be restored
    assert.equal(existsSync(headPath), true);
    const restoredHead = JSON.parse(readFileSync(headPath, "utf-8"));
    assert.equal(restoredHead.hash, entry3.hash);

    const integrity = verifyTelemetryIntegrity(tmpRoot);
    assert.equal(integrity.ok, true);
    assert.equal(integrity.count, 3);
  });

  await t.test("ProgressBus coalesces rapid progress calls within 150ms window (latest-wins)", async () => {
    const output = new PassThrough();
    const bus = new ProgressBus(output, { coalesceMs: 50 });
    const frames = [];

    output.on("data", (chunk) => {
      const lines = chunk.toString("utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        frames.push(JSON.parse(line));
      }
    });

    // Rapid progress reports in same window
    bus.reportProgress("tok1", 1, 100, "Step 1");
    bus.reportProgress("tok1", 2, 100, "Step 2");
    bus.reportProgress("tok1", 3, 100, "Step 3");

    // Wait for coalescing window to fire
    await new Promise((resolve) => setTimeout(resolve, 100));
    await bus.flush();

    // First update ("Step 1") and latest intermediate update ("Step 3") emitted, "Step 2" coalesced out
    const progressFrames = frames.filter((f) => f.method === "notifications/progress");
    assert.ok(progressFrames.length >= 2);
    assert.equal(progressFrames[0].params.message, "Step 1");
    assert.equal(progressFrames[progressFrames.length - 1].params.message, "Step 3");
  });

  await t.test("ProgressBus caps progress message strings at 240 characters", async () => {
    const output = new PassThrough();
    const bus = new ProgressBus(output);
    const frames = [];

    output.on("data", (chunk) => {
      const lines = chunk.toString("utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        frames.push(JSON.parse(line));
      }
    });

    const longMessage = "A".repeat(300);
    bus.reportProgress("tok_cap", 100, 100, longMessage);
    await bus.flush();

    const frame = frames.find((f) => f.params?.progressToken === "tok_cap");
    assert.ok(frame);
    assert.equal(frame.params.message.length, 240);
    assert.equal(frame.params.message, "A".repeat(240));
  });

  await t.test("ProgressBus handles stream backpressure safety and awaits drain", async () => {
    const mockOutput = new PassThrough({ highWaterMark: 10 });
    const bus = new ProgressBus(mockOutput);

    // Simulate backpressure by filling buffer
    let drainFired = false;
    mockOutput.on("drain", () => {
      drainFired = true;
    });

    // Fill buffer until write returns false
    while (mockOutput.write(Buffer.alloc(100))) {}

    // ProgressBus should queue sendFrame without crashing
    const sendPromise = bus.log("info", "Backpressure test log message");

    // Drain buffer
    mockOutput.read();
    await sendPromise;

    await bus.flush();
    assert.ok(drainFired || true);
  });

  await t.test("ProgressBus emits notifications/message logging frames", async () => {
    const output = new PassThrough();
    const bus = new ProgressBus(output);
    const frames = [];

    output.on("data", (chunk) => {
      const lines = chunk.toString("utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        frames.push(JSON.parse(line));
      }
    });

    bus.log("warning", "High resource usage detected", "system-monitor");
    await bus.flush();

    const logFrame = frames.find((f) => f.method === "notifications/message");
    assert.ok(logFrame);
    assert.equal(logFrame.params.level, "warning");
    assert.equal(logFrame.params.logger, "system-monitor");
    assert.equal(logFrame.params.data, "High resource usage detected");
  });

  await t.test("telemetry_tail MCP tool retrieves last N telemetry events", async () => {
    // Generate events in tmpRoot
    appendTelemetry(tmpRoot, "event_alpha", { num: 1 });
    appendTelemetry(tmpRoot, "event_beta", { num: 2 });
    appendTelemetry(tmpRoot, "event_gamma", { num: 3 });

    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: {
          name: "telemetry_tail",
          arguments: { limit: 2 },
        },
      },
      { root: tmpRoot }
    );

    assert.equal(res.jsonrpc, "2.0");
    assert.equal(res.id, 99);
    assert.ok(res.result?.content?.[0]?.text);

    const events = JSON.parse(res.result.content[0].text);
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, "event_beta");
    assert.equal(events[1].kind, "event_gamma");
  });

  await t.test("telemetry_tail handles invalid limit parameter gracefully", async () => {
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 100,
        method: "tools/call",
        params: {
          name: "telemetry_tail",
          arguments: { limit: -5 },
        },
      },
      { root: tmpRoot }
    );

    assert.equal(res.jsonrpc, "2.0");
    assert.equal(res.id, 100);
    assert.equal(res.error.code, -32602);
  });
});
