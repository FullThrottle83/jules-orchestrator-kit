import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
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
    const res = await probeDevServer(
      {
        command: 'node -e "setTimeout(()=>{}, 10000)"',
        url: "http://127.0.0.1:59999", // Unused port
        timeoutMs: 800,
      },
      process.cwd()
    );

    assert.equal(res.ok, false);
    assert.equal(res.status, 504);
    assert.ok(res.error.includes("timed out"));
  });
});
