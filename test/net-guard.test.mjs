import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

describe("Hermetic Network Egress Guard", () => {
  it("blocks outbound fetch to un-allowlisted host and exits with code 188", () => {
    const res = spawnSync(
      "node",
      ["--import", "./src/preload-net-guard.mjs", "-e", "fetch('https://example.com')"],
      {
        cwd: process.cwd(),
        encoding: "utf-8",
      }
    );

    assert.equal(res.status, 188);
    assert.ok(res.stderr.includes("[FATAL] ERR_UNMOCKED_NET: example.com"));
  });

  it("passes guard check for loopback fetch to 127.0.0.1:3000", () => {
    const res = spawnSync(
      "node",
      ["--import", "./src/preload-net-guard.mjs", "-e", "fetch('http://127.0.0.1:3000').catch(() => {})"],
      {
        cwd: process.cwd(),
        encoding: "utf-8",
      }
    );

    assert.equal(res.status, 0);
    assert.equal(res.stderr.includes("[FATAL] ERR_UNMOCKED_NET"), false);
  });

  it("blocks node:http and node:https requests to un-allowlisted hosts", () => {
    const resHttp = spawnSync(
      "node",
      ["--import", "./src/preload-net-guard.mjs", "-e", "import http from 'node:http'; http.get('http://example.com');"],
      {
        cwd: process.cwd(),
        encoding: "utf-8",
      }
    );
    assert.equal(resHttp.status, 188);
    assert.ok(resHttp.stderr.includes("[FATAL] ERR_UNMOCKED_NET: example.com"));

    const resHttps = spawnSync(
      "node",
      ["--import", "./src/preload-net-guard.mjs", "-e", "import https from 'node:https'; https.request('https://api.github.com');"],
      {
        cwd: process.cwd(),
        encoding: "utf-8",
      }
    );
    assert.equal(resHttps.status, 188);
    assert.ok(resHttps.stderr.includes("[FATAL] ERR_UNMOCKED_NET: api.github.com"));
  });

  it("allows loopback hosts localhost and ::1", () => {
    const resLocal = spawnSync(
      "node",
      ["--import", "./src/preload-net-guard.mjs", "-e", "fetch('http://localhost:3000').catch(() => {}); fetch('http://[::1]:3000').catch(() => {});"],
      {
        cwd: process.cwd(),
        encoding: "utf-8",
      }
    );
    assert.equal(resLocal.status, 0);
    assert.equal(resLocal.stderr.includes("[FATAL] ERR_UNMOCKED_NET"), false);
  });
});
