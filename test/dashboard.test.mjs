import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createDashboardServer, getDashboardHtml } from "../src/dashboard.mjs";
import { getCommandDescriptor } from "../src/ops/command-registry.mjs";
import { KIT_VERSION } from "../src/version.mjs";

const CLI = fileURLToPath(new URL("../bin/agentctl.mjs", import.meta.url));
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Starts `agentctl dashboard ...` and waits until it either reports a running
 * URL or exits. The child is always killed before resolving so no test leaves
 * a server behind.
 */
function runDashboard(args, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, "dashboard", ...args], {
      cwd: ROOT,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch (_) {}
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ started: false, timedOut: true, stdout, stderr, status: null }),
      timeoutMs
    );
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (/Dashboard running at/.test(stdout)) {
        finish({ started: true, timedOut: false, stdout, stderr, status: null });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      finish({ started: /Dashboard running at/.test(stdout), timedOut: false, stdout, stderr, status: code });
    });
    child.on("error", (err) => {
      finish({ started: false, timedOut: false, stdout, stderr: stderr + String(err), status: null });
    });
  });
}

test("dashboard port handling (D1/D2/D3)", async (t) => {
  await t.test("accepts a positional port: agentctl dashboard <port>", async () => {
    const port = await getFreePort();
    const res = await runDashboard([String(port)]);
    assert.equal(res.started, true, `expected a running dashboard, got stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(res.stdout, new RegExp(`:${port}\\b`));
  });

  await t.test("accepts the flag form: agentctl dashboard --port <port>", async () => {
    const port = await getFreePort();
    const res = await runDashboard(["--port", String(port)]);
    assert.equal(res.started, true, `expected a running dashboard, got stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(res.stdout, new RegExp(`:${port}\\b`));
  });

  await t.test("defaults to port 4100 with no arguments", async () => {
    const res = await runDashboard([]);
    assert.equal(res.started, true, `expected a running dashboard, got stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(res.stdout, /:4100\b/);
  });

  await t.test("rejects a non-numeric port with exit 1 and a clean error (no uncaught exception)", () => {
    const res = spawnSync("node", [CLI, "dashboard", "abc"], {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 15000,
    });
    const out = `${res.stdout || ""}${res.stderr || ""}`;
    assert.equal(res.status, 1, `expected exit 1, got status=${res.status} output=${out}`);
    assert.match(out, /invalid port/i);
    assert.doesNotMatch(out, /FATAL ERROR/);
  });

  await t.test("rejects out-of-range ports (below 1024, above 65535) with exit 1", () => {
    for (const bad of ["80", "1023", "65536", "99999", "0", "-1"]) {
      const res = spawnSync("node", [CLI, "dashboard", bad], {
        cwd: ROOT,
        encoding: "utf-8",
        timeout: 15000,
      });
      const out = `${res.stdout || ""}${res.stderr || ""}`;
      assert.equal(res.status, 1, `port ${bad}: expected exit 1, got status=${res.status} output=${out}`);
      assert.match(out, /invalid port/i, `port ${bad}: expected a clean invalid-port error, got: ${out}`);
      assert.doesNotMatch(out, /FATAL ERROR/, `port ${bad}: must not throw an uncaught exception`);
    }
  });

  await t.test("rejects an out-of-range --port flag value with exit 1", () => {
    const res = spawnSync("node", [CLI, "dashboard", "--port", "99999"], {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 15000,
    });
    const out = `${res.stdout || ""}${res.stderr || ""}`;
    assert.equal(res.status, 1, `expected exit 1, got status=${res.status} output=${out}`);
    assert.match(out, /invalid port/i);
    assert.doesNotMatch(out, /FATAL ERROR/);
  });
});

test("createDashboardServer honours the configured port (D2)", async (t) => {
  await t.test("exposes the port on the server and in /api/status", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "dash-port-test-"));
    try {
      const server = createDashboardServer({ root: tmp, port: 4321 });
      assert.equal(server.dashboardPort, 4321);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const livePort = server.address().port;
        const statusRes = await fetch(`http://127.0.0.1:${livePort}/api/status`);
        assert.equal(statusRes.status, 200);
        const body = await statusRes.json();
        assert.equal(body.port, 4321);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

test("dashboard default port agreement: registry, CLI and README say 4100 (D3)", async (t) => {
  await t.test("command registry advertises default port 4100", () => {
    const desc = getCommandDescriptor("dashboard");
    assert.ok(desc, "dashboard descriptor must exist");
    const portFlag = (desc.flags || []).find((f) => f.name === "port");
    assert.ok(portFlag, "dashboard descriptor must declare a --port flag");
    assert.match(portFlag.description, /4100/);
  });

  await t.test("README documents the dashboard default port 4100", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
    const row = readme.split("\n").find((line) => line.startsWith("| `dashboard`"));
    assert.ok(row, "README must document agentctl dashboard");
    assert.match(row, /4100/, `README dashboard row must agree on default port 4100, got: ${row}`);
  });
});

test("dashboard uses KIT_VERSION instead of re-reading package.json (D11)", async (t) => {
  await t.test("src/dashboard.mjs has no direct package.json read", () => {
    const source = readFileSync(join(ROOT, "src", "dashboard.mjs"), "utf-8");
    assert.doesNotMatch(source, /package\.json/, "dashboard must reuse KIT_VERSION, not read the manifest again");
    assert.match(source, /KIT_VERSION/);
  });

  await t.test("rendered HTML reports KIT_VERSION", () => {
    const html = getDashboardHtml("/tmp/example-root");
    assert.ok(html.includes(KIT_VERSION), "dashboard HTML must contain the kit version");
  });
});
