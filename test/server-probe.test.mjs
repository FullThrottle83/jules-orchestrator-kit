import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeDevServer } from "../src/engine.mjs";

test("Live Dev Server & SSR Hydration Smoke Probing", async (t) => {
  await t.test("a) probes healthy live HTTP dev server successfully", async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>App Loaded Cleanly</h1></body></html>");
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      const res = await probeDevServer(
        {
          command: `node -e "require('http').createServer((req,res)=>{res.end('ok')}).listen(${port})"`,
          url: `http://127.0.0.1:${port}`,
          timeoutMs: 3000,
        },
        process.cwd()
      );

      assert.equal(res.ok, true);
      assert.equal(res.status, 200);
    } finally {
      server.close();
    }
  });

  await t.test("b) detects SSR hydration panic error in response text", async () => {
    const server = createServer((req, res) => {
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end("<div>Error: Text content did not match server-rendered HTML. Hydration failed.</div>");
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      const res = await probeDevServer(
        {
          command: `node -e "require('http').createServer((req,res)=>{res.end('panic')}).listen(${port})"`,
          url: `http://127.0.0.1:${port}`,
          timeoutMs: 3000,
        },
        process.cwd()
      );

      assert.equal(res.ok, false);
      assert.ok(res.error.includes("SSR Hydration Smoke Probe Failure"));
    } finally {
      server.close();
    }
  });

  await t.test("c) handles server startup timeout gracefully", async () => {
    // The command must *hang*, so that the probe times out rather than the
    // process exiting on its own. Three previous attempts at this fixture
    // passed the hanging program as `node -e "<code>"`, and `probeDevServer`
    // runs commands through `cmd.exe /d /s /c` on Windows, which re-parses the
    // quoting: node then received a fragment, exited 1 on a syntax error, and
    // the probe reported that exit instead of a timeout — `1 !== 504`, on
    // Windows only, release after release.
    //
    // A script file removes the shell from the question entirely: no quotes to
    // survive re-parsing, and no argument that cmd.exe can split.
    const dir = mkdtempSync(join(tmpdir(), "jok-probe-"));
    const sleeper = join(dir, "sleeper.mjs");
    writeFileSync(sleeper, "setTimeout(() => {}, 30000);\n");

    try {
      const res = await probeDevServer(
        {
          command: `node ${sleeper}`,
          url: "http://127.0.0.1:59999", // Unused port
          timeoutMs: 800,
        },
        process.cwd()
      );

      assert.equal(res.ok, false);
      assert.equal(res.status, 504, `expected a timeout, got exit ${res.status}: ${res.error}`);
      assert.ok(res.error.includes("timed out"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
