import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  createProvider,
  createFailoverProvider,
  createSyntaxVerifiedProvider,
  ProviderAmbiguousOutcomeError,
  PlanMismatchError,
  ProviderUnavailableError,
  ProviderRateLimitError,
} from "../src/provider.mjs";
import { MCP_TOOLS, MCP_TOOL_ALIASES } from "../src/mcp.mjs";
import { COMMAND_REGISTRY } from "../src/ops/command-registry.mjs";

const AGENTCTL = join(process.cwd(), "bin", "agentctl.mjs");

function createMockServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => {
          if (typeof server.closeAllConnections === "function") {
            server.closeAllConnections();
          }
          return new Promise((done) => server.close(done));
        },
      });
    });
  });
}

describe("Provider Lifecycle Contract & Result Kinds", () => {
  it("HTTP provider dispatch returns kind: 'remote-session' and provider name", async () => {
    const provider = createProvider("jules");
    const res = await provider.dispatch({ prompt: "audit" }, { dryRun: true });
    assert.equal(res.kind, "remote-session");
    assert.equal(res.provider, "jules");
    assert.equal(res.status, "pending");
  });

  it("Exec provider dispatch returns kind: 'local-result' and provider name", async () => {
    const provider = createProvider("claude-code");
    const res = await provider.dispatch({ prompt: "audit" }, { dryRun: true });
    assert.equal(res.kind, "local-result");
    assert.equal(res.provider, "claude-code");
  });

  it("Exec provider strictly rejects approvePlan", async () => {
    const provider = createProvider("claude-code");
    await assert.rejects(
      async () => provider.approvePlan("session-remote-123"),
      /does not support remote plan approval/
    );
  });

  it("Exec provider strictly rejects getSession for remote session IDs", async () => {
    const provider = createProvider("claude-code");
    await assert.rejects(
      async () => provider.getSession("session-remote-123"),
      /cannot inspect remote session/
    );
  });

  it("Exec provider strictly rejects resume for remote or completed sessions", async () => {
    const provider = createProvider("claude-code");
    await assert.rejects(
      async () => provider.resume("session-remote-123", "continue"),
      /cannot resume remote session/
    );
    await assert.rejects(
      async () => provider.resume("exec-session-9999", "continue"),
      /completed locally \(local-result\) and cannot be resumed/
    );
  });
});

describe("Provider Affinity in createFailoverProvider", () => {
  it("prevents cross-provider failover during approvePlan when primary fails", async () => {
    let backupApproveCalls = 0;
    const provider = createFailoverProvider([
      {
        name: "jules-mock",
        dispatch: async () => ({ id: "sess-jules-1", status: "pending" }),
        approvePlan: async () => {
          throw new ProviderUnavailableError("Jules 503 Service Unavailable", { status: 503 });
        },
      },
      {
        name: "claude-code-mock",
        dispatch: async () => ({ id: "sess-claude-2", status: "completed" }),
        approvePlan: async () => {
          backupApproveCalls++;
          return { id: "sess-jules-1", status: "approved", approved: true };
        },
      },
    ]);

    await assert.rejects(
      async () => provider.approvePlan("sess-jules-1"),
      /Jules 503 Service Unavailable/
    );
    assert.equal(backupApproveCalls, 0, "approvePlan must never fail over to backup provider");
  });

  it("prevents cross-provider failover during getSession and resume when primary fails", async () => {
    let backupGetCalls = 0;
    const provider = createFailoverProvider([
      {
        name: "jules-mock",
        dispatch: async () => ({ id: "sess-jules-1", status: "pending" }),
        getSession: async () => {
          throw new ProviderRateLimitError("Quota exceeded", { status: 429 });
        },
      },
      {
        name: "backup-mock",
        dispatch: async () => ({ id: "sess-backup-2", status: "pending" }),
        getSession: async () => {
          backupGetCalls++;
          return { id: "sess-jules-1", status: "active" };
        },
      },
    ]);

    await assert.rejects(
      async () => provider.getSession("sess-jules-1"),
      /Quota exceeded/
    );
    assert.equal(backupGetCalls, 0, "getSession must never fail over to backup provider");
  });

  it("binds subsequent operations to the provider that won failover during dispatch", async () => {
    const provider = createFailoverProvider([
      {
        name: "flaky-p1",
        dispatch: async () => { throw new ProviderRateLimitError("429 limit", { status: 429 }); },
        getSession: async () => { throw new Error("p1 should not be called for p2 session"); },
      },
      {
        name: "steady-p2",
        dispatch: async () => ({ id: "sess-steady-42", status: "pending" }),
        getSession: async (id) => ({ id, status: "in_progress", provider: "steady-p2" }),
      },
    ]);

    const dispatchRes = await provider.dispatch({ prompt: "work" });
    assert.equal(dispatchRes._routedProvider, "steady-p2");
    assert.equal(dispatchRes.id, "sess-steady-42");

    const getRes = await provider.getSession("sess-steady-42");
    assert.equal(getRes.id, "sess-steady-42");
    assert.equal(getRes.status, "in_progress");
    assert.equal(getRes._routedProvider, "steady-p2");
  });
});

describe("Reconciliation on Mutating API Timeouts", () => {
  it("recovers existing session when dispatch times out but session landed on provider", async () => {
    let postReceived = 0;
    let listReceived = 0;
    const server = await createMockServer((req, res) => {
      if (req.method === "POST" && req.url === "/sessions") {
        postReceived++;
        // Hang connection to simulate timeout
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/sessions")) {
        listReceived++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            sessions: [
              {
                id: "sess-reconciled-123",
                name: "sessions/sess-reconciled-123",
                title: "Reconcile Task",
                state: "IN_PROGRESS",
                createTime: new Date().toISOString(),
                sourceContext: {
                  githubRepoContext: {
                    startingBranch: "main",
                  },
                },
              },
            ],
          })
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    try {
      const provider = createProvider({
        name: "jules",
        type: "http",
        url: `${server.url}/sessions`,
        headers: { "X-Goog-Api-Key": "{token}" },
        bodyTemplate: { title: "{title}", prompt: "{prompt}" },
      });

      process.env.JULES_API_KEY = "test-token";
      const result = await provider.dispatch(
        { prompt: "do something", title: "Reconcile Task", branch: "main" },
        { timeoutMs: 500, reconcile: true }
      );

      assert.equal(result.id, "sess-reconciled-123");
      assert.equal(result.status, "IN_PROGRESS");
      assert.equal(result._reconciled, true);
      assert.equal(result.kind, "remote-session");
      assert.equal(postReceived, 1);
      assert.equal(listReceived, 1);
    } finally {
      delete process.env.JULES_API_KEY;
      await server.close();
    }
  });

  it("throws clean ProviderUnavailableError when timeout occurs and 0 sessions exist", async () => {
    const server = await createMockServer((req, res) => {
      if (req.method === "POST" && req.url === "/sessions") {
        // Hang connection
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/sessions")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ sessions: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    try {
      const provider = createProvider({
        name: "jules",
        type: "http",
        url: `${server.url}/sessions`,
        headers: { "X-Goog-Api-Key": "{token}" },
      });

      process.env.JULES_API_KEY = "test-token";
      await assert.rejects(
        async () =>
          provider.dispatch(
            { prompt: "do something", title: "Nonexistent Task", branch: "main" },
            { timeoutMs: 500, reconcile: true }
          ),
        (err) => {
          assert.ok(err instanceof ProviderUnavailableError);
          assert.equal(err.status, 504);
          return true;
        }
      );
    } finally {
      delete process.env.JULES_API_KEY;
      await server.close();
    }
  });

  it("throws ProviderAmbiguousOutcomeError and blocks failover when multiple candidate sessions exist", async () => {
    const server = await createMockServer((req, res) => {
      if (req.method === "POST" && req.url === "/sessions") {
        return; // Hang
      }
      if (req.method === "GET" && req.url?.startsWith("/sessions")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            sessions: [
              { id: "cand-1", title: "Ambiguous Task", createTime: new Date().toISOString() },
              { id: "cand-2", title: "Ambiguous Task", createTime: new Date().toISOString() },
            ],
          })
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    try {
      const p1 = createProvider({
        name: "jules",
        type: "http",
        url: `${server.url}/sessions`,
        headers: { "X-Goog-Api-Key": "{token}" },
      });
      let backupCalled = false;
      const p2 = {
        name: "backup",
        dispatch: async () => {
          backupCalled = true;
          return { id: "backup-sess", status: "completed" };
        },
      };

      const failover = createFailoverProvider([p1, p2]);
      process.env.JULES_API_KEY = "test-token";

      await assert.rejects(
        async () =>
          failover.dispatch(
            { prompt: "test", title: "Ambiguous Task" },
            { timeoutMs: 200, reconcile: true }
          ),
        (err) => {
          assert.ok(err instanceof ProviderAmbiguousOutcomeError);
          assert.equal(err.candidates.length, 2);
          return true;
        }
      );
      assert.equal(backupCalled, false, "Ambiguous outcome must fail closed and never fail over");
    } finally {
      delete process.env.JULES_API_KEY;
      await server.close();
    }
  });

  it("reconciles approvePlan timeout when session state transitioned to IN_PROGRESS", async () => {
    const server = await createMockServer((req, res) => {
      if (req.method === "POST" && req.url?.includes(":approvePlan")) {
        return; // Hang
      }
      if (req.method === "GET" && req.url === "/sessions/sess-100") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "sess-100", state: "IN_PROGRESS" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    try {
      const provider = createProvider({
        name: "jules",
        type: "http",
        url: `${server.url}/sessions`,
        headers: { "X-Goog-Api-Key": "{token}" },
      });

      process.env.JULES_API_KEY = "test-token";
      const res = await provider.approvePlan("sess-100", { timeoutMs: 200, reconcile: true });
      assert.equal(res.id, "sess-100");
      assert.equal(res.approved, true);
      assert.equal(res.status, "IN_PROGRESS");
      assert.equal(res._reconciled, true);
    } finally {
      delete process.env.JULES_API_KEY;
      await server.close();
    }
  });
});

describe("Scoped Plan Approval (expectedPlanId & PlanMismatchError)", () => {
  it("rejects approval if latest plan in activities differs from expectedPlanId", async () => {
    const server = await createMockServer((req, res) => {
      if (req.method === "GET" && req.url === "/sessions/sess-scope-1/activities") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            activities: [
              {
                id: "act-1",
                planGenerated: {
                  plan: {
                    id: "plan-version-2",
                    steps: [{ description: "new step" }],
                  },
                },
              },
            ],
          })
        );
        return;
      }
      if (req.method === "POST" && req.url?.includes(":approvePlan")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "sess-scope-1", state: "approved" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    try {
      const provider = createProvider({
        name: "jules",
        type: "http",
        url: `${server.url}/sessions`,
        headers: { "X-Goog-Api-Key": "{token}" },
      });

      process.env.JULES_API_KEY = "test-token";
      await assert.rejects(
        async () =>
          provider.approvePlan("sess-scope-1", { expectedPlanId: "plan-version-1" }),
        (err) => {
          assert.ok(err instanceof PlanMismatchError);
          assert.equal(err.expectedPlanId, "plan-version-1");
          assert.equal(err.actualPlanId, "plan-version-2");
          assert.match(err.message, /Plan changed since review/);
          return true;
        }
      );
    } finally {
      delete process.env.JULES_API_KEY;
      await server.close();
    }
  });

  it("approves plan when latest planGenerated.plan.id matches expectedPlanId", async () => {
    let approveCalled = false;
    const server = await createMockServer((req, res) => {
      if (req.method === "GET" && req.url === "/sessions/sess-scope-2/activities") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            activities: [
              {
                id: "act-1",
                planGenerated: {
                  plan: {
                    id: "plan-target-1",
                  },
                },
              },
            ],
          })
        );
        return;
      }
      if (req.method === "POST" && req.url?.includes(":approvePlan")) {
        approveCalled = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "sess-scope-2", state: "approved" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    try {
      const provider = createProvider({
        name: "jules",
        type: "http",
        url: `${server.url}/sessions`,
        headers: { "X-Goog-Api-Key": "{token}" },
      });

      process.env.JULES_API_KEY = "test-token";
      const res = await provider.approvePlan("sess-scope-2", { expectedPlanId: "plan-target-1" });
      assert.equal(res.approved, true);
      assert.equal(res.planId, "plan-target-1");
      assert.equal(approveCalled, true);
    } finally {
      delete process.env.JULES_API_KEY;
      await server.close();
    }
  });

  it("CLI agentctl plan approve supports --expected-plan in dry-run mode", () => {
    const out = execFileSync(
      process.execPath,
      [AGENTCTL, "plan", "approve", "sess-test", "--expected-plan", "plan-42", "--dry-run"],
      { encoding: "utf-8", stdio: "pipe" }
    );
    assert.ok(out.includes("[DRY-RUN]"));
    assert.ok(out.includes("Plan ID    : plan-42"));
    assert.ok(out.includes("Session ID : sess-test"));
  });
});

describe("Destructive Session Housekeeping Contraction (Candidate B3)", () => {
  it("standard, failover, and syntax-verified provider adapters do not expose archiveSession or deleteSession", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount += 1;
      throw new Error("unexpected provider network call");
    };

    try {
      const julesProvider = createProvider("jules");
      const claudeProvider = createProvider("claude-code");
      const codexProvider = createProvider("codex");
      const geminiProvider = createProvider("gemini-flash");
      const customHttpProvider = createProvider({
        name: "custom-http",
        type: "http",
        url: "https://example.invalid/v1alpha/sessions",
        archiveUrl: "https://example.invalid/v1alpha/sessions/{sessionId}:archive",
      });
      const failoverProvider = createFailoverProvider(["jules", "claude-code"]);
      const wrappedWithCustom = createFailoverProvider([
        {
          name: "custom-with-housekeeping",
          dispatch: async () => ({ id: "sess-1", status: "pending" }),
          archiveSession: async () => ({ id: "sess-1", archived: true }),
          deleteSession: async () => ({ id: "sess-1", deleted: true }),
        },
      ]);
      const syntaxVerifiedBare = createSyntaxVerifiedProvider(
        { name: "bare-fast", dispatch: async () => ({ id: "fast-1" }) },
        julesProvider,
        {}
      );
      const syntaxVerifiedWithHousekeeping = createSyntaxVerifiedProvider(
        {
          name: "housekeeping-fast",
          dispatch: async () => ({ id: "fast-2" }),
          archiveSession: async () => ({ id: "fast-2", archived: true }),
          deleteSession: async () => ({ id: "fast-2", deleted: true }),
        },
        julesProvider,
        {}
      );

      for (const adapter of [
        julesProvider,
        claudeProvider,
        codexProvider,
        geminiProvider,
        customHttpProvider,
        failoverProvider,
        wrappedWithCustom,
        syntaxVerifiedBare,
        syntaxVerifiedWithHousekeeping,
      ]) {
        assert.equal(Object.hasOwn(adapter, "archiveSession"), false);
        assert.equal(typeof adapter.archiveSession, "undefined");
        assert.equal(Object.hasOwn(adapter, "deleteSession"), false);
        assert.equal(typeof adapter.deleteSession, "undefined");
      }

      // Non-destructive lifecycle surface remains intact across all three factories
      for (const adapter of [julesProvider, failoverProvider, syntaxVerifiedBare]) {
        assert.equal(typeof adapter.dispatch, "function");
        assert.equal(typeof adapter.resume, "function");
        assert.equal(typeof adapter.sendMessage, "function");
        assert.equal(typeof adapter.getSession, "function");
        assert.equal(typeof adapter.approvePlan, "function");
        assert.equal(typeof adapter.listSessions, "function");
        assert.equal(typeof adapter.listActivities, "function");
        assert.equal(typeof adapter.listSources, "function");
        assert.equal(typeof adapter.validate, "function");
      }

      const drySession = await julesProvider.getSession("sess-keep-1", { dryRun: true });
      assert.equal(drySession.status, "active");
      const dryPlan = await failoverProvider.approvePlan("sess-keep-1", { dryRun: true });
      assert.equal(dryPlan.approved, true);
      const dryList = await julesProvider.listSessions({ dryRun: true });
      assert.deepEqual(dryList.sessions, []);
      const dryActs = await failoverProvider.listActivities("sess-keep-1", { dryRun: true });
      assert.deepEqual(dryActs.activities, []);
      const drySources = await julesProvider.listSources({ dryRun: true });
      assert.deepEqual(drySources.sources, []);

      // MCP and CLI registries expose zero remote session archive/delete surfaces
      const mcpNames = MCP_TOOLS.map((t) => t.name);
      for (const toolName of [
        "jules_archive_session",
        "agent_archive_session",
        "jules_delete_session",
        "agent_delete_session",
      ]) {
        assert.equal(mcpNames.includes(toolName), false);
        assert.equal(Object.hasOwn(MCP_TOOL_ALIASES, toolName), false);
      }

      const cliIds = COMMAND_REGISTRY.map((c) => c.id);
      assert.equal(cliIds.includes("prune"), false);
      assert.equal(cliIds.includes("session archive"), false);
      assert.equal(cliIds.includes("session delete"), false);
      assert.equal(fetchCount, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
