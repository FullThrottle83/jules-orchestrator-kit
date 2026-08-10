import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProvider,
  ProviderRateLimitError,
  ProviderUnavailableError,
  ProviderSchemaError,
  parseRetryAfter,
} from "../src/provider.mjs";
import { dispatch, repair } from "../src/engine.mjs";
import { checkDailyBudget } from "../src/state.mjs";

test("Provider Failure Domain Taxonomy & Hardening", async (t) => {
  await t.test("a) HTTP 429 response from mock provider throws ProviderRateLimitError with parsed retryAfterMs", async () => {
    let server;
    try {
      server = createServer((req, res) => {
        res.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": "120",
        });
        res.end(JSON.stringify({ error: "Rate limit exceeded" }));
      });

      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}/session`;

      const provider = createProvider({ type: "http", url });

      await assert.rejects(
        async () => {
          await provider.dispatch({ prompt: "test prompt" });
        },
        (err) => {
          assert.ok(err instanceof ProviderRateLimitError);
          assert.equal(err.status, 429);
          assert.equal(err.retryAfterMs, 120000);
          assert.match(err.message, /Rate limit exceeded/);
          return true;
        }
      );
    } finally {
      if (server) server.close();
    }
  });

  await t.test("HTTP date Retry-After parsing helper test", () => {
    assert.equal(parseRetryAfter("60"), 60000);
    assert.equal(parseRetryAfter(null), null);
    const futureDate = new Date(Date.now() + 30000).toUTCString();
    const parsed = parseRetryAfter(futureDate);
    assert.ok(parsed >= 28000 && parsed <= 32000, `Expected around 30000ms, got ${parsed}`);
  });

  await t.test("HTTP 5xx response throws ProviderUnavailableError", async () => {
    let server;
    try {
      server = createServer((req, res) => {
        res.writeHead(503, {
          "Content-Type": "application/json",
          "Retry-After": "30",
        });
        res.end(JSON.stringify({ error: "Service Unavailable" }));
      });

      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}/session`;

      const provider = createProvider({ type: "http", url });

      await assert.rejects(
        async () => {
          await provider.dispatch({ prompt: "test prompt" });
        },
        (err) => {
          assert.ok(err instanceof ProviderUnavailableError);
          assert.equal(err.status, 503);
          assert.equal(err.retryAfterMs, 30000);
          return true;
        }
      );
    } finally {
      if (server) server.close();
    }
  });

  await t.test("Invalid JSON response throws ProviderSchemaError", async () => {
    let server;
    try {
      server = createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html>Bad Gateway Html</html>");
      });

      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}/session`;

      const provider = createProvider({ type: "http", url });

      await assert.rejects(
        async () => {
          await provider.dispatch({ prompt: "test prompt" });
        },
        (err) => {
          assert.ok(err instanceof ProviderSchemaError);
          return true;
        }
      );
    } finally {
      if (server) server.close();
    }
  });

  await t.test("b) ProviderRateLimitError causes budget reservation rollback and bypasses repair() entirely", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "jules-provider-test-"));
    let server;
    try {
      server = createServer((req, res) => {
        res.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": "45",
        });
        res.end(JSON.stringify({ error: "Quota exceeded" }));
      });

      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}/session`;

      const providerSpec = { type: "http", url };
      const config = { provider: providerSpec, limits: { repairAttempts: 3, dailyTasks: 300 } };

      const initialBudget = checkDailyBudget(tmpDir, 300);

      // Call repair directly
      const repairRes = await repair(
        { command: "npm test", stderr: "Test failure" },
        { root: tmpDir, config }
      );

      assert.equal(repairRes.ok, false);
      assert.equal(repairRes.finalStatus, "PROVIDER_INFRASTRUCTURE_FAILURE");
      assert.equal(repairRes.providerError, true);
      assert.equal(repairRes.retryAfterMs, 45000);
      assert.equal(repairRes.attempts.length, 1);

      // Verify budget was rolled back and used count matches initial
      const budgetAfter = checkDailyBudget(tmpDir, 300);
      assert.equal(budgetAfter.used, initialBudget.used);

      // Also call dispatch directly
      const dispatchRes = await dispatch({ title: "Test", prompt: "Hello" }, { root: tmpDir, config });
      assert.equal(dispatchRes.ok, false);
      assert.equal(dispatchRes.status, "RATE_LIMITED");
      assert.equal(dispatchRes.providerError, true);
      assert.equal(dispatchRes.retryAfterMs, 45000);

      const budgetFinal = checkDailyBudget(tmpDir, 300);
      assert.equal(budgetFinal.used, initialBudget.used);
    } finally {
      if (server) server.close();
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  await t.test("c) Socket timeout correctly aborts fetch after configured duration", async () => {
    let server;
    try {
      server = createServer((_req, _res) => {
        // Deliberately hold request open without ending it
      });

      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}/session`;

      const provider = createProvider({ type: "http", url, timeoutMs: 50 });

      const startTime = Date.now();
      await assert.rejects(
        async () => {
          await provider.dispatch({ prompt: "timeout test" }, { timeoutMs: 50 });
        },
        (err) => {
          assert.ok(err instanceof ProviderUnavailableError);
          assert.equal(err.status, 504);
          assert.match(err.message, /Provider HTTP Timeout/);
          return true;
        }
      );
      const elapsed = Date.now() - startTime;
      assert.ok(elapsed < 3000, `Expected quick timeout abort (<3s), took ${elapsed}ms`);
    } finally {
      if (server) server.close();
    }
  });

  await t.test("d) Warm session resumption dispatches to sendMessage endpoint and handles fail-soft fallback on 404", async () => {
    let server;
    try {
      let sendMessageCalled = false;
      let dispatchCalled = false;

      server = createServer((req, res) => {
        if (req.url.includes(":sendMessage")) {
          sendMessageCalled = true;
          // Simulate expired/closed remote session with 404
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session closed or not found" }));
        } else {
          dispatchCalled = true;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "fallback-cold-session", state: "active" }));
        }
      });

      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}/sessions`;

      const provider = createProvider({ type: "http", url });

      // Warm resume with task fallback object provided
      const res = await provider.resume(
        "session-123",
        "Fix test error on line 42",
        {},
        { title: "Fallback Task", prompt: "Cold prompt" }
      );

      assert.ok(sendMessageCalled, "Expected sendMessage endpoint to be called first");
      assert.ok(dispatchCalled, "Expected fail-soft fallback to call cold dispatch on 404");
      assert.equal(res.id, "fallback-cold-session");
      assert.equal(res._warmFallback, true);
      assert.equal(res._warmErrorStatus, 404);
    } finally {
      if (server) server.close();
    }
  });
});

