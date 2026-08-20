/**
 * Zero-Dependency Local Telemetry & Audit HTTP Dashboard for jules-orchestrator-kit (v0.27.0).
 * Uses node:http to serve real-time HTML/CSS dark mode visualizer and REST JSON endpoints.
 */

import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { readTelemetry, verifyTelemetryIntegrity } from "./telemetry.mjs";
import { readVerifyRuns, flakyVerdict } from "./flaky-ledger.mjs";
import { lockStatus } from "./state.mjs";
import { KIT_VERSION } from "./version.mjs";

const pkgVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8")).version;

export function getDashboardHtml(root = process.cwd()) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>jules-orchestrator-kit Dashboard</title>
  <style>
    body { background-color: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 24px; }
    h1 { color: #58a6ff; font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #8b949e; font-size: 14px; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
    .card h2 { font-size: 16px; color: #f0f6fc; margin-top: 0; border-bottom: 1px solid #21262d; padding-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid #21262d; }
    th { color: #8b949e; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; }
    .badge-success { background: rgba(46, 160, 67, 0.15); color: #3fb950; border: 1px solid rgba(46, 160, 67, 0.4); }
    .badge-warn { background: rgba(210, 153, 34, 0.15); color: #d29922; border: 1px solid rgba(210, 153, 34, 0.4); }
    code { font-family: monospace; background: #21262d; padding: 2px 4px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>🚀 jules-orchestrator-kit Dashboard (v${pkgVersion})</h1>
  <div class="subtitle">Repository: <code>${root}</code></div>

  <div class="grid">
    <div class="card">
      <h2>🛡️ SHA-256 Telemetry Integrity</h2>
      <div id="telemetry-status">Loading...</div>
    </div>
    <div class="card">
      <h2>⚖️ Wilson-Score Flaky Ledger</h2>
      <div id="flaky-status">Loading...</div>
    </div>
    <div class="card">
      <h2>🔒 Active VFS Mutex Locks</h2>
      <div id="locks-status">Loading...</div>
    </div>
  </div>

  <script>
    async function updateDashboard() {
      try {
        const [telRes, flakyRes, locksRes] = await Promise.all([
          fetch('/api/telemetry?limit=10').then(r => r.json()),
          fetch('/api/flaky').then(r => r.json()),
          fetch('/api/locks').then(r => r.json())
        ]);

        document.getElementById('telemetry-status').innerHTML = (telRes.integrity?.ok || telRes.integrity?.valid)
          ? '<span class="badge badge-success">✓ SHA-256 Hash Chain Valid</span> <p>Events logged: ' + telRes.events.length + '</p>'
          : '<span class="badge badge-warn">⚠ Check Telemetry Logs</span>';

        document.getElementById('flaky-status').innerHTML = '<p>Verdict: <code>' + (flakyRes.verdict?.verdict || flakyRes.verdict?.action || 'CLEAN') + '</code></p><p>Tracked test runs: ' + flakyRes.count + '</p>';
        document.getElementById('locks-status').innerHTML = '<p>Active VFS Locks: <code>' + locksRes.count + '</code></p>';
      } catch (err) {
        console.error("Dashboard update failed:", err);
      }
    }
    updateDashboard();
    setInterval(updateDashboard, 5000);
  </script>
</body>
</html>`;
}

export function createDashboardServer({ root = process.cwd(), port: _port = 4100 } = {}) {
  return http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(getDashboardHtml(root));
    }

    if (url.pathname === "/api/status") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true, version: KIT_VERSION, root, ts: new Date().toISOString() }));
    }

    if (url.pathname === "/api/telemetry") {
      const limit = Number(url.searchParams.get("limit") || "50");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(
        JSON.stringify({
          ok: true,
          count: limit,
          integrity: verifyTelemetryIntegrity(root),
          events: readTelemetry(root, limit),
        })
      );
    }

    if (url.pathname === "/api/flaky") {
      const runs = readVerifyRuns(root);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true, count: runs.length, verdict: flakyVerdict(runs), runs }));
    }

    if (url.pathname === "/api/locks") {
      const locks = lockStatus(root);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true, count: locks.length, locks }));
    }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "Not Found", path: url.pathname }));
  });
}

export function startDashboardServer(port = 4100, root = process.cwd(), host = "127.0.0.1") {
  const server = createDashboardServer({ root, port });
  server.listen(port, host, () => {
    console.log(`🚀 jules-orchestrator-kit Dashboard running at http://${host}:${port}`);
  });
  return server;
}
