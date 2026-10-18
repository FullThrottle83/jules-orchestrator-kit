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

  await t.test("d) reaps SIGTERM-ignoring server and watcher child and frees TCP port before returning", async () => {
    if (process.platform === "win32") return;

    const portAlloc = createServer();
    await new Promise((resolve) => portAlloc.listen(0, "127.0.0.1", resolve));
    const port = portAlloc.address().port;
    await new Promise((resolve) => portAlloc.close(resolve));

    const dir = mkdtempSync(join(tmpdir(), "jok-probe-reap-"));
    const pidFile = join(dir, "pids.json");
    const watcherScript = join(dir, "watcher.mjs");
    const serverScript = join(dir, "server.mjs");

    writeFileSync(
      watcherScript,
      `
process.on("SIGTERM", () => {});
setInterval(() => {}, 200);
`
    );

    writeFileSync(
      serverScript,
      `
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

process.on("SIGTERM", () => {});
const watcher = spawn(process.execPath, [${JSON.stringify(watcherScript)}], {
  stdio: "ignore",
});
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({
  serverPid: process.pid,
  watcherPid: watcher.pid,
}));
const srv = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<html><body>ok</body></html>");
});
srv.listen(${port}, "127.0.0.1");
setInterval(() => {}, 200);
`
    );

    const isPidAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    try {
      const res = await probeDevServer(
        {
          command: `${JSON.stringify(process.execPath)} ${JSON.stringify(serverScript)}`,
          url: `http://127.0.0.1:${port}`,
          timeoutMs: 4000,
          _teardownOptions: { gracePeriodMs: 150, pollIntervalMs: 20 },
        },
        dir
      );

      assert.equal(res.ok, true);
      assert.equal(res.status, 200);

      const { readFileSync } = await import("node:fs");
      const { serverPid, watcherPid } = JSON.parse(readFileSync(pidFile, "utf-8"));
      assert.equal(isPidAlive(serverPid), false, "SIGTERM-ignoring server should be dead after probeDevServer returns");
      assert.equal(isPidAlive(watcherPid), false, "SIGTERM-ignoring watcher child should be dead after probeDevServer returns");

      const rebindServer = createServer();
      await new Promise((resolve, reject) => {
        rebindServer.once("error", reject);
        rebindServer.listen(port, "127.0.0.1", resolve);
      });
      await new Promise((resolve) => rebindServer.close(resolve));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("e) observes Windows taskkill /F /T completion and surfaces cleanup failure without replacing probe result", async () => {
    const { reapProcessTree } = await import("../src/process-tree.mjs");
    const calls = [];
    const winOk = await reapProcessTree(4242, {
      platform: "win32",
      spawnSyncFn: (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        return { status: 0 };
      },
    });
    assert.equal(winOk.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "taskkill");
    assert.deepEqual(calls[0].args, ["/F", "/T", "/PID", "4242"]);

    const winNotFound = await reapProcessTree(4242, {
      platform: "win32",
      spawnSyncFn: () => ({ status: 128 }),
    });
    assert.equal(winNotFound.ok, true);

    const winFail = await reapProcessTree(4242, {
      platform: "win32",
      spawnSyncFn: () => ({ status: 5 }),
    });
    assert.equal(winFail.ok, false);
    assert.match(winFail.error, /taskkill exited with status 5/);
  });
});

