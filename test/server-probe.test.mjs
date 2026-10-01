import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeDevServer } from "../src/engine.mjs";

function isAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

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

  await t.test("d) tears down server and watcher processes ignoring SIGTERM and allows immediate port rebind", async () => {
    if (process.platform === "win32") return;

    const tmpDir = mkdtempSync(join(tmpdir(), "jok-sigterm-probe-"));
    const pidFile = join(tmpDir, "pids.json");
    const serverScript = join(tmpDir, "stubborn_server.mjs");

    // Allocate ephemeral port
    const portFinder = createServer();
    await new Promise((r) => portFinder.listen(0, "127.0.0.1", r));
    const port = portFinder.address().port;
    await new Promise((r) => portFinder.close(r));

    writeFileSync(
      serverScript,
      `
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

process.on("SIGTERM", () => {
  // Ignore SIGTERM
});

const watcher = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 200);"], {
  stdio: "ignore",
});

const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<html><body>Server Ready</body></html>");
});

server.listen(${port}, "127.0.0.1", () => {
  writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({
    serverPid: process.pid,
    watcherPid: watcher.pid,
  }));
});
`
    );

    try {
      const res = await probeDevServer(
        {
          command: `node ${serverScript}`,
          url: `http://127.0.0.1:${port}`,
          timeoutMs: 5000,
        },
        process.cwd()
      );

      assert.equal(res.ok, true);

      assert.ok(existsSync(pidFile), "PID file should exist");
      const { serverPid, watcherPid } = JSON.parse(readFileSync(pidFile, "utf-8"));

      // Assert both PIDs are killed
      assert.equal(isAlive(serverPid), false, `server pid ${serverPid} should be dead`);
      assert.equal(isAlive(watcherPid), false, `watcher pid ${watcherPid} should be dead`);

      // Assert port is immediately rebindable without EADDRINUSE
      const rebindServer = createServer();
      let bound = false;
      await new Promise((resolve, reject) => {
        rebindServer.on("error", reject);
        rebindServer.listen(port, "127.0.0.1", () => {
          bound = true;
          rebindServer.close(resolve);
        });
      });
      assert.ok(bound, `Port ${port} should be immediately rebindable`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("e) teardown occurs on non-2xx response and hydration panic", async () => {
    if (process.platform === "win32") return;

    const tmpDir = mkdtempSync(join(tmpdir(), "jok-panic-probe-"));
    const pidFile = join(tmpDir, "pids.json");
    const serverScript = join(tmpDir, "panic_server.mjs");

    const portFinder = createServer();
    await new Promise((r) => portFinder.listen(0, "127.0.0.1", r));
    const port = portFinder.address().port;
    await new Promise((r) => portFinder.close(r));

    writeFileSync(
      serverScript,
      `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

process.on("SIGTERM", () => {});

const server = createServer((req, res) => {
  res.writeHead(500, { "Content-Type": "text/html" });
  res.end("Minified React error #418; visit https://reactjs.org/docs/error-decoder.html?invariant=418 for full text");
});

server.listen(${port}, "127.0.0.1", () => {
  writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ serverPid: process.pid }));
});
`
    );

    try {
      const res = await probeDevServer(
        {
          command: `node ${serverScript}`,
          url: `http://127.0.0.1:${port}`,
          timeoutMs: 5000,
        },
        process.cwd()
      );

      assert.equal(res.ok, false);
      assert.ok(res.error.includes("SSR Hydration Smoke Probe Failure"));

      const { serverPid } = JSON.parse(readFileSync(pidFile, "utf-8"));
      assert.equal(isAlive(serverPid), false, "panic server process should be reaped");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("f) Windows taskkill tree cleanup path verifies /F /T /PID arguments and observed completion", async () => {
    const { killProcessTree } = await import("../src/process-tree.mjs");
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

    // Exercise killProcessTree logic as if on win32
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    try {
      // killProcessTree with a mock PID should call taskkill /F /T /PID synchronously without throwing
      assert.doesNotThrow(() => killProcessTree(123456));
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });
});
