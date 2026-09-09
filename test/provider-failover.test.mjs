/**
 * Provider failover — the domain suite for getting work to a provider and
 * surviving its failures:
 *
 *   - the failure-domain taxonomy (429 rate limits with Retry-After parsing,
 *     5xx unavailability, schema errors) against loopback mock servers;
 *   - token-pool rotation, quarantine and cooldown;
 *   - HTTP retry/backoff semantics of getSession (404 / 429 / 5xx);
 *   - the failover router's ordering, recoverable-error classification and
 *     attempt-trail telemetry;
 *   - the Jules REST v1alpha alignment and queue retry semantics regressions.
 *
 * Formed in P08 by merging: provider-hardening, the P0-01 / P0-06 sections of
 * p0-remediation and the P-08 section of critical-hardening, plus new
 * failover-router and retry-backoff tests. All network I/O targets 127.0.0.1.
 */
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProvider,
  createFailoverProvider,
  createSyntaxVerifiedProvider,
  MissingApiKeyError,
  ProviderRateLimitError,
  ProviderUnavailableError,
  ProviderSchemaError,
  parseRetryAfter,
  TokenPool,
} from "../src/provider.mjs";
import { dispatch, repair, run } from "../src/engine.mjs";
import { checkDailyBudget } from "../src/state.mjs";

// ═══════════════════════════════════════════════════════════════════════════
// From: test/provider-hardening.test.mjs
// Moved verbatim by the P08 test consolidation; scoped to its own block.
// ═══════════════════════════════════════════════════════════════════════════
{
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

  await t.test("e) Insecure {token} interpolation in URL templates is rejected with critical security error", () => {
    assert.throws(
      () => {
        createProvider({
          type: "http",
          url: "https://api.example.com/sessions?apiKey={token}",
        });
      },
      (err) => {
        assert.match(err.message, /Insecure token interpolation in provider URL template/);
        return true;
      }
    );

    assert.throws(
      () => {
        createProvider({
          type: "http",
          url: "https://api.example.com/sessions",
          sendMessageUrl: "https://api.example.com/sessions/{sessionId}?token={token}",
        });
      },
      (err) => {
        assert.match(err.message, /Insecure token interpolation in provider sendMessageUrl template/);
        return true;
      }
    );
  });

  await t.test("f) TokenPool rotates keys round-robin and masks sensitive secrets in inventory", () => {
    const pool = new TokenPool(["secret-key-1-abcdef", "secret-key-2-ghijkl"]);
    assert.equal(pool.size, 2);

    assert.equal(pool.getNextToken(), "secret-key-1-abcdef");
    assert.equal(pool.getNextToken(), "secret-key-2-ghijkl");
    assert.equal(pool.getNextToken(), "secret-key-1-abcdef");

    const inv = pool.getInventory();
    assert.equal(inv.length, 2);
    assert.equal(inv[0].maskedToken, "secr...cdef");
    assert.equal(inv[1].maskedToken, "secr...ijkl");
    assert.equal(inv[0].isPrimary, true);
    assert.equal(inv[1].isPrimary, false);
  });

  await t.test("g) HTTP provider automatically rotates and fails over to secondary token upon HTTP 429", async () => {
    let server;
    let requestCount = 0;
    const receivedTokens = [];

    try {
      server = createServer((req, res) => {
        requestCount++;
        const authHeader = req.headers["x-goog-api-key"] || req.headers["authorization"] || "";
        receivedTokens.push(authHeader);

        if (authHeader === "token-primary") {
          res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
          res.end(JSON.stringify({ error: "Primary quota exceeded" }));
        } else if (authHeader === "token-secondary") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "session-secondary-ok", state: "active" }));
        } else {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unknown token" }));
        }
      });

      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}/sessions`;

      const pool = new TokenPool(["token-primary", "token-secondary"]);
      const provider = createProvider({
        type: "http",
        url,
        headers: { "X-Goog-Api-Key": "{token}" },
      }, { tokenPool: pool });

      const result = await provider.dispatch({ prompt: "test prompt" }, { tokenPool: pool });

      assert.equal(requestCount, 2);
      assert.deepEqual(receivedTokens, ["token-primary", "token-secondary"]);
      assert.equal(result.id, "session-secondary-ok");
      assert.equal(result.status, "active");
    } finally {
      if (server) server.close();
    }
  });

  await t.test("h) Optimistic schema degradation strips deprecated parameters and retries upon HTTP 400", async () => {
    let server;
    let requestCount = 0;
    const receivedBodies = [];

    try {
      server = createServer((req, res) => {
        requestCount++;
        let data = "";
        req.on("data", (chunk) => {
          data += chunk;
        });
        req.on("end", () => {
          const body = JSON.parse(data || "{}");
          receivedBodies.push(body);
          if (body.temperature !== undefined || body.thinking_budget !== undefined) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid argument: unrecognized field temperature" }));
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ id: "session-degraded-ok", state: "active" }));
          }
        });
      });

      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}/sessions`;

      const pool = new TokenPool(["mock-token"]);
      const provider = createProvider({
        type: "http",
        url,
        headers: { "X-Goog-Api-Key": "{token}" },
        bodyTemplate: {
          prompt: "{prompt}",
          temperature: 0.7,
          thinking_budget: 2048,
        },
      }, { tokenPool: pool });

      const result = await provider.dispatch({ prompt: "Fix bug" }, { tokenPool: pool });

      assert.equal(requestCount, 2, "Must retry exactly once with sanitized payload");
      assert.equal(receivedBodies[0].temperature, 0.7);
      assert.equal(receivedBodies[1].temperature, undefined);
      assert.equal(receivedBodies[1].thinking_level, "high");
      assert.equal(result.id, "session-degraded-ok");
    } finally {
      if (server) server.close();
    }
  });

  await t.test("i) createSyntaxVerifiedProvider escalates to the primary provider when the FAST tier leaves broken JS on disk", async () => {
    const root = mkdtempSync(join(tmpdir(), "jok-syntax-gate-"));
    try {
      execSync("git init -q -b main", { cwd: root });
      writeFileSync(join(root, "broken.js"), "const x = ;\n");

      const fastProvider = { name: "fake-fast", dispatch: async () => ({ id: "fast-session" }) };
      const complexProvider = { name: "fake-complex", dispatch: async () => ({ id: "complex-session-escalated" }) };
      const verified = createSyntaxVerifiedProvider(fastProvider, complexProvider, {});

      const result = await verified.dispatch({ prompt: "fix a typo" }, { root });

      assert.equal(result.id, "complex-session-escalated");
      assert.equal(result._syntaxEscalated, true);
      assert.equal(result._syntaxEscalationFile, "broken.js");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("j) createSyntaxVerifiedProvider passes the FAST tier's result through untouched when its output parses cleanly", async () => {
    const root = mkdtempSync(join(tmpdir(), "jok-syntax-gate-ok-"));
    try {
      execSync("git init -q -b main", { cwd: root });
      writeFileSync(join(root, "valid.js"), "const x = 1;\nmodule.exports = { x };\n");

      const fastProvider = { name: "fake-fast", dispatch: async () => ({ id: "fast-session-ok" }) };
      const complexProvider = { name: "fake-complex", dispatch: async () => { throw new Error("must not escalate"); } };
      const verified = createSyntaxVerifiedProvider(fastProvider, complexProvider, {});

      const result = await verified.dispatch({ prompt: "fix a typo" }, { root });

      assert.equal(result.id, "fast-session-ok");
      assert.equal(result._syntaxEscalated, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("k) createSyntaxVerifiedProvider is a no-op when the FAST tier leaves no local working-tree diff (e.g. a remote HTTP provider)", async () => {
    const root = mkdtempSync(join(tmpdir(), "jok-syntax-gate-remote-"));
    try {
      execSync("git init -q -b main", { cwd: root });

      const fastProvider = { name: "fake-remote-fast", dispatch: async () => ({ id: "remote-session" }) };
      const complexProvider = { name: "fake-complex", dispatch: async () => { throw new Error("must not escalate"); } };
      const verified = createSyntaxVerifiedProvider(fastProvider, complexProvider, {});

      const result = await verified.dispatch({ prompt: "fix a typo" }, { root });

      assert.equal(result.id, "remote-session");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("l) createSyntaxVerifiedProvider skips verification entirely on a dry run", async () => {
    const root = mkdtempSync(join(tmpdir(), "jok-syntax-gate-dry-"));
    try {
      execSync("git init -q -b main", { cwd: root });
      writeFileSync(join(root, "broken.js"), "const x = ;\n");

      const fastProvider = { name: "fake-fast", dispatch: async () => ({ id: "dry-run-session" }) };
      const complexProvider = { name: "fake-complex", dispatch: async () => { throw new Error("must not escalate"); } };
      const verified = createSyntaxVerifiedProvider(fastProvider, complexProvider, {});

      const result = await verified.dispatch({ prompt: "fix a typo" }, { root, dryRun: true });

      assert.equal(result.id, "dry-run-session");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("m) createProvider('jules').dispatch auto-resolves source from git remote origin", async () => {
    const root = mkdtempSync(join(tmpdir(), "jok-remote-origin-"));
    try {
      execSync("git init -q -b main", { cwd: root });
      execSync("git remote add origin git@github.com:my-org/my-project.git", { cwd: root });

      const p = createProvider("jules");
      const session = await p.dispatch({ prompt: "do something" }, { root, dryRun: true });
      assert.equal(session.data.source, "sources/github/my-org/my-project");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("n) listActivities correctly queries session activities endpoint", async () => {
    let requestedUrl = "";
    const server = createServer((req, res) => {
      requestedUrl = req.url;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ activities: [{ id: "act-1", originator: "agent" }] }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/sessions`;

    try {
      const p = createProvider({ type: "http", url });
      const result = await p.listActivities("sess-123");
      assert.equal(result.activities.length, 1);
      assert.equal(result.activities[0].id, "act-1");
      assert.ok(requestedUrl.includes("/sess-123/activities"));
    } finally {
      server.close();
    }
  });

  await t.test("o) TokenPool balances tokens by lowest quota utilization", () => {
    // primary token: default limit 100
    // secondary token: default limit 15
    const pool = new TokenPool(["key-primary", "key-secondary"]);
    pool.recordUsage("key-primary"); // 1/100 = 0.01
    pool.recordUsage("key-secondary"); // 1/15 = 0.067

    // Key-primary has lower utilization (0.01 < 0.067), so it should be chosen next
    assert.equal(pool.getNextToken(), "key-primary");

    const inv = pool.getInventory();
    assert.equal(inv[0].limit, 100);
    assert.equal(inv[1].limit, 15);
    assert.equal(inv[0].usage, 1);
    assert.equal(inv[1].usage, 1);
  });

  await t.test("p) TokenPool.fromEnv supports JULES_MAIN_TOKEN and JULES_SECONDARY_TOKENS", () => {
    const prevMain = process.env.JULES_MAIN_TOKEN;
    const prevSec = process.env.JULES_SECONDARY_TOKENS;
    const prevPrimary = process.env.JULES_API_KEY;
    const prevKeys = process.env.JULES_API_KEYS;

    try {
      delete process.env.JULES_API_KEY;
      delete process.env.JULES_API_KEYS;
      delete process.env.JULES_API_KEY_SECONDARY;
      process.env.JULES_MAIN_TOKEN = "main-token-123456";
      process.env.JULES_SECONDARY_TOKENS = "sec-token-1,sec-token-2";

      const pool = TokenPool.fromEnv();
      assert.equal(pool.size, 3);
      assert.equal(pool.tokens[0], "main-token-123456");
      assert.equal(pool.tokens[1], "sec-token-1");
      assert.equal(pool.tokens[2], "sec-token-2");
    } finally {
      if (prevMain !== undefined) process.env.JULES_MAIN_TOKEN = prevMain;
      else delete process.env.JULES_MAIN_TOKEN;
      if (prevSec !== undefined) process.env.JULES_SECONDARY_TOKENS = prevSec;
      else delete process.env.JULES_SECONDARY_TOKENS;
      if (prevPrimary !== undefined) process.env.JULES_API_KEY = prevPrimary;
      else delete process.env.JULES_API_KEY;
      if (prevKeys !== undefined) process.env.JULES_API_KEYS = prevKeys;
      else delete process.env.JULES_API_KEYS;
    }
  });
});
}

// ═══════════════════════════════════════════════════════════════════════════
// From: test/p0-remediation.test.mjs — P0-01 Jules REST alignment
// Moved verbatim by the P08 test consolidation; scoped to its own block.
// ═══════════════════════════════════════════════════════════════════════════
{
test("P0-01: Jules REST v1alpha Provider Alignment", async (t) => {
  await t.test("throws MissingApiKeyError when JULES_API_KEY is missing for non-dryRun jules provider", async () => {
    const oldKey = process.env.JULES_API_KEY;
    const oldGeminiKey = process.env.GEMINI_API_KEY;
    delete process.env.JULES_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      const provider = createProvider("jules");
      await assert.rejects(
        async () => {
          await provider.dispatch({ prompt: "hello" });
        },
        (err) => {
          assert.ok(err instanceof MissingApiKeyError);
          assert.equal(err.status, 401);
          return true;
        }
      );
    } finally {
      if (oldKey) process.env.JULES_API_KEY = oldKey;
      if (oldGeminiKey) process.env.GEMINI_API_KEY = oldGeminiKey;
    }
  });

  await t.test("formats request URL, X-Goog-Api-Key, and sourceContext according to v1alpha REST spec", async () => {
    let capturedReq = null;
    let capturedBody = null;
    let server;

    try {
      server = createServer((req, res) => {
        capturedReq = req;
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => {
          capturedBody = JSON.parse(data);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ name: "sessions/12345", state: "ACTIVE" }));
        });
      });

      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;
      const customSpec = {
        name: "jules",
        type: "http",
        url: `http://127.0.0.1:${port}/v1alpha/sessions`,
        headers: {
          "X-Goog-Api-Key": "{token}",
          "Content-Type": "application/json",
        },
        bodyTemplate: {
          title: "{title}",
          prompt: "{prompt}",
          sourceContext: {
            source: "{source}",
            githubRepoContext: {
              startingBranch: "{branch}",
            },
          },
        },
      };

      const provider = createProvider(customSpec);
      const oldKey = process.env.JULES_API_KEY;
      process.env.JULES_API_KEY = "test-api-key-123";

      try {
        const res = await provider.dispatch(
          { prompt: "Fix authentication bug", title: "Task Title" },
          { source: "sources/github/owner/repo", branch: "feature/fix" }
        );

        assert.equal(capturedReq.headers["x-goog-api-key"], "test-api-key-123");
        assert.equal(capturedBody.title, "Task Title");
        assert.equal(capturedBody.prompt, "Fix authentication bug");
        assert.equal(capturedBody.sourceContext.source, "sources/github/owner/repo");
        assert.equal(capturedBody.sourceContext.githubRepoContext.startingBranch, "feature/fix");
        assert.equal(res.id, "sessions/12345");
      } finally {
        if (oldKey) process.env.JULES_API_KEY = oldKey;
        else delete process.env.JULES_API_KEY;
      }
    } finally {
      if (server) server.close();
    }
  });

  await t.test("defaults startingBranch to config.baseBranch or main and attaches autoPr / requirePlanApproval", async () => {
    let capturedBody = null;
    let server;

    try {
      server = createServer((req, res) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => {
          capturedBody = JSON.parse(data);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ name: "sessions/test-defaults" }));
        });
      });

      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;

      const provider = createProvider({
        name: "jules",
        type: "http",
        url: `http://127.0.0.1:${port}/v1alpha/sessions`,
        headers: { "X-Goog-Api-Key": "{token}" },
        bodyTemplate: {
          title: "{title}",
          prompt: "{prompt}",
          sourceContext: {
            source: "{source}",
            githubRepoContext: { startingBranch: "{branch}" },
          },
        },
      });

      process.env.JULES_API_KEY = "test-key";
      await provider.dispatch(
        { prompt: "Test default branch", source: "owner/repo", autoPr: true, requirePlanApproval: true },
        { dryRun: false, baseBranch: "main" }
      );

      assert.equal(capturedBody.sourceContext.githubRepoContext.startingBranch, "main");
      assert.equal(capturedBody.automationMode, "AUTO_CREATE_PR");
      assert.equal(capturedBody.requirePlanApproval, true);
    } finally {
      if (server) server.close();
    }
  });

  await t.test("throws error when repository source is missing for live non-repoless dispatch", async () => {
    const oldKey = process.env.JULES_API_KEY;
    const oldRepo = process.env.JULES_REPO;
    process.env.JULES_API_KEY = "test-key";
    delete process.env.JULES_REPO;
    const tmpEmpty = mkdtempSync(join(tmpdir(), "jules-no-repo-"));

    try {
      const provider = createProvider("jules");
      await assert.rejects(
        async () => {
          await provider.dispatch({ prompt: "missing source" }, { root: tmpEmpty, dryRun: false });
        },
        (err) => {
          assert.match(err.message, /Missing connected Jules repository source/);
          return true;
        }
      );
    } finally {
      if (oldKey) process.env.JULES_API_KEY = oldKey;
      if (oldRepo) process.env.JULES_REPO = oldRepo;
      rmSync(tmpEmpty, { recursive: true, force: true });
    }
  });

  await t.test("omits sourceContext when repoless mode is true", async () => {
    let capturedBody = null;
    let server;

    try {
      server = createServer((req, res) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => {
          capturedBody = JSON.parse(data);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ name: "sessions/repoless-1" }));
        });
      });

      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;
      const customSpec = {
        name: "jules",
        type: "http",
        url: `http://127.0.0.1:${port}/v1alpha/sessions`,
        headers: { "X-Goog-Api-Key": "{token}" },
        bodyTemplate: {
          title: "{title}",
          prompt: "{prompt}",
          sourceContext: { source: "{source}" },
        },
      };

      const provider = createProvider(customSpec);
      process.env.JULES_API_KEY = "test-key";

      await provider.dispatch(
        { prompt: "Repoless script generation", repoless: true },
        { dryRun: false }
      );

      assert.equal(capturedBody.sourceContext, undefined);
    } finally {
      if (server) server.close();
    }
  });
});
}

// ═══════════════════════════════════════════════════════════════════════════
// From: test/p0-remediation.test.mjs — P0-06 queue retry semantics
// Moved verbatim by the P08 test consolidation; scoped to its own block.
// ═══════════════════════════════════════════════════════════════════════════
{
test("P0-06: Queue Retry Semantics on Provider Error", async (t) => {
  await t.test("does not move task file to completed when provider returns rate-limit failure", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "jules-queue-test-"));
    try {
      const queueDir = join(tmpDir, ".agent", "jules-queue");
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, "TASK-100.md"), "Task content");

      // Custom provider returning rate limit
      const failProvider = {
        name: "fail-provider",
        async dispatch() {
          return { ok: false, status: "RATE_LIMITED", error: "Rate limit hit" };
        },
        validate() {
          return true;
        },
      };

      const res = await run({
        root: tmpDir,
        config: {
          provider: failProvider,
          limits: { concurrency: 1, dailyTasks: 10 },
        },
        dryRun: false,
      });

      assert.equal(res.processed, 1);
      assert.equal(res.results[0].ok, false);
      assert.equal(res.results[0].status, "RATE_LIMITED");

      // Task file must still remain in queueDir (not moved to completed)
      assert.ok(existsSync(join(queueDir, "TASK-100.md")));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
}

// ═══════════════════════════════════════════════════════════════════════════
// From: test/critical-hardening.test.mjs — P-08 exec providers
// Moved verbatim by the P08 test consolidation; scoped to its own block.
// ═══════════════════════════════════════════════════════════════════════════
{
describe("P-08: exec CLI providers spawn through the same Windows shim path", () => {
  it("exec provider still runs a CLI-style command on POSIX", async () => {
    const provider = createProvider({
      name: "claude-code",
      type: "exec",
      command: process.execPath,
      args: ["-e", "process.stdout.write('cli-ok')"],
      promptViaStdin: true,
    });
    const res = await provider.dispatch({ prompt: "hello" });
    assert.equal(res.status, "completed");
    assert.equal(res.output, "cli-ok");
  });
});
}

// ═══════════════════════════════════════════════════════════════════════════
// New: failover routing and HTTP retry backoff
// Written new in P08 for offline coverage of the merged domain.
// ═══════════════════════════════════════════════════════════════════════════
/**
 * P08 addition: failover ordering and HTTP retry-backoff, exercised against
 * in-process providers and a loopback-only mock server — zero live egress.
 */

test("createFailoverProvider routes dispatches across an ordered provider list", async (t) => {
  await t.test("a healthy primary answers with routing metadata and no failover", async () => {
    const calls = [];
    const provider = createFailoverProvider([
      { name: "primary", dispatch: async () => { calls.push("primary"); return { id: "s1", status: "pending" }; } },
      { name: "secondary", dispatch: async () => { calls.push("secondary"); return { id: "s2", status: "pending" }; } },
    ]);

    assert.equal(provider.name, "failover:primary->secondary", "the router is named for its chain");
    const res = await provider.dispatch({ prompt: "hello" });
    assert.equal(res.id, "s1");
    assert.equal(res._routedProvider, "primary");
    assert.equal(res._failoverAttempts, 0);
    assert.deepEqual(calls, ["primary"], "the secondary must never be contacted when the primary answers");
  });

  await t.test("a recoverable rate limit fails over to the next provider", async () => {
    let secondaryCalls = 0;
    const provider = createFailoverProvider([
      {
        name: "limited",
        dispatch: async () => {
          throw new ProviderRateLimitError("Provider HTTP Error (429)", { retryAfterMs: 1, status: 429 });
        },
      },
      {
        name: "backup",
        dispatch: async () => {
          secondaryCalls += 1;
          return { id: "s2", status: "pending" };
        },
      },
    ]);

    const res = await provider.dispatch({ prompt: "hello" });
    assert.equal(res._routedProvider, "backup");
    assert.equal(res._failoverAttempts, 1, "exactly one provider was skipped");
    assert.equal(secondaryCalls, 1);
  });

  await t.test("a non-recoverable error fails fast without contacting the next provider", async () => {
    let secondaryCalls = 0;
    const provider = createFailoverProvider([
      {
        name: "broken",
        dispatch: async () => {
          const err = new Error("4xx: bad request");
          err.status = 400;
          throw err;
        },
      },
      { name: "backup", dispatch: async () => { secondaryCalls += 1; return { id: "s2" }; } },
    ]);

    await assert.rejects(() => provider.dispatch({ prompt: "hello" }), /bad request/);
    assert.equal(secondaryCalls, 0, "a 4xx is a caller problem — retrying elsewhere would double-dispatch");
  });

  await t.test("exhausting every provider rethrows the last error with the full attempt trail", async () => {
    const provider = createFailoverProvider([
      { name: "a", dispatch: async () => { throw new ProviderUnavailableError("down-a", { status: 503 }); } },
      { name: "b", dispatch: async () => { throw new ProviderRateLimitError("429-b", { retryAfterMs: 1, status: 429 }); } },
    ]);

    await assert.rejects(
      () => provider.dispatch({ prompt: "hello" }),
      (err) => {
        assert.ok(err instanceof ProviderRateLimitError, "the last provider's error is the one rethrown");
        assert.ok(Array.isArray(err._failoverErrors));
        assert.equal(err._failoverErrors.length, 2);
        assert.equal(err._failoverErrors[0].provider, "a");
        assert.equal(err._failoverErrors[0].error instanceof ProviderUnavailableError, true);
        assert.equal(err._failoverErrors[1].provider, "b");
        return true;
      }
    );
  });

  await t.test("resume walks the same ordered chain", async () => {
    let liveCalls = 0;
    // Specs must carry a dispatch to be recognised as provider objects —
    // otherwise the router rebuilds them from the spec via createProvider.
    const provider = createFailoverProvider([
      {
        name: "dead",
        dispatch: async () => ({ id: "unused", status: "pending" }),
        resume: async () => { throw new ProviderUnavailableError("session gone", { status: 503 }); },
      },
      {
        name: "live",
        dispatch: async () => ({ id: "unused", status: "pending" }),
        resume: async () => { liveCalls += 1; return { id: "r1", status: "active" }; },
      },
    ]);

    const res = await provider.resume("sess-1", "continue");
    assert.equal(res.id, "r1");
    assert.equal(res._routedProvider, "live");
    assert.equal(res._failoverAttempts, 1);
    assert.equal(liveCalls, 1);
  });
});

test("HTTP getSession retries transient failures with backoff before succeeding", async (t) => {
  // The retry loop lives in getSession (listSources reuses it as an
  // authenticated GET), honours ctx.maxRetries / ctx.initialDelayMs, and
  // retries 404, 429 and 5xx while passing other statuses straight through.

  await t.test("503, 503, then 200 retries twice and returns the session", async () => {
    const oldKey = process.env.JULES_API_KEY;
    process.env.JULES_API_KEY = "test-key-offline";
    let server;
    try {
      let hits = 0;
      server = createServer((req, res) => {
        hits += 1;
        if (hits <= 2) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "temporarily unavailable" }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ name: "sess-1", state: "ACTIVE" }));
        }
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const provider = createProvider({ type: "http", name: "mock-jules", url: `http://127.0.0.1:${server.address().port}` });

      const res = await provider.getSession("sess-1", { maxRetries: 3, initialDelayMs: 1 });
      assert.equal(res.id, "sess-1");
      assert.equal(res.status, "ACTIVE");
      assert.equal(hits, 3, "two 503s were retried, the third attempt succeeded");
    } finally {
      if (server) server.close();
      if (oldKey === undefined) delete process.env.JULES_API_KEY;
      else process.env.JULES_API_KEY = oldKey;
    }
  });

  await t.test("persistent 503 exhausts maxRetries and throws ProviderUnavailableError", async () => {
    const oldKey = process.env.JULES_API_KEY;
    process.env.JULES_API_KEY = "test-key-offline";
    let server;
    try {
      let hits = 0;
      server = createServer((req, res) => {
        hits += 1;
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "still down" }));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const provider = createProvider({ type: "http", name: "mock-jules", url: `http://127.0.0.1:${server.address().port}` });

      await assert.rejects(
        () => provider.getSession("sess-1", { maxRetries: 2, initialDelayMs: 1 }),
        (err) => {
          assert.ok(err instanceof ProviderUnavailableError);
          assert.equal(err.status, 503);
          return true;
        }
      );
      assert.equal(hits, 3, "the initial attempt plus maxRetries retries were made, then it gave up");
    } finally {
      if (server) server.close();
      if (oldKey === undefined) delete process.env.JULES_API_KEY;
      else process.env.JULES_API_KEY = oldKey;
    }
  });
});
