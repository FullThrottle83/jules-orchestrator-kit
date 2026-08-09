import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseReviewComments, createReviewRepairTask } from "../src/review-repair.mjs";
import { createFailoverProvider, ProviderRateLimitError } from "../src/provider.mjs";
import { createDashboardServer } from "../src/dashboard.mjs";

test("parseReviewComments & createReviewRepairTask - filters praise/noise and creates repair task", () => {
  const comments = [
    { id: "c1", body: "LGTM!", state: "APPROVED" },
    { id: "c2", body: "Great work, thanks!", isResolved: true },
    { id: "c3", path: "src/auth.ts", line: 42, body: "Please add null check for token header", author: "alice" },
  ];

  const actionable = parseReviewComments(comments);
  assert.equal(actionable.length, 1);
  assert.equal(actionable[0].id, "c3");
  assert.equal(actionable[0].path, "src/auth.ts");
  assert.equal(actionable[0].line, 42);

  const task = createReviewRepairTask(actionable[0]);
  assert.equal(task.id, "repair-c3");
  assert.equal(task.targetFiles[0], "src/auth.ts");
  assert.ok(task.prompt.includes("alice"));
});

test("createFailoverProvider - intercepts rate limits and falls back to secondary provider", async () => {
  let p1Called = false;
  let p2Called = false;

  const mockP1 = {
    name: "primary-http",
    async dispatch() {
      p1Called = true;
      throw new ProviderRateLimitError("Rate limit 429", { status: 429 });
    },
    validate() { return true; },
  };

  const mockP2 = {
    name: "secondary-exec",
    async dispatch() {
      p2Called = true;
      return { id: "p2-session", status: "completed" };
    },
    validate() { return true; },
  };

  const router = createFailoverProvider([mockP1, mockP2]);
  const res = await router.dispatch({ prompt: "Fix bug" }, { dryRun: false });

  assert.ok(p1Called);
  assert.ok(p2Called);
  assert.equal(res._routedProvider, "secondary-exec");
  assert.equal(res._failoverAttempts, 1);
});

test("createDashboardServer - responds to HTML and REST API endpoints", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "dash-test-"));
  try {
    const server = createDashboardServer({ root: tmp, port: 0 });
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    const port = server.address().port;

    const base = `http://127.0.0.1:${port}`;

    // GET /
    const htmlRes = await fetch(`${base}/`);
    assert.equal(htmlRes.status, 200);
    const htmlText = await htmlRes.text();
    assert.ok(htmlText.includes("jules-orchestrator-kit Dashboard"));

    // GET /api/status
    const statusRes = await fetch(`${base}/api/status`);
    assert.equal(statusRes.status, 200);
    const statusJson = await statusRes.json();
    assert.equal(statusJson.ok, true);
    assert.ok(statusJson.version);

    // GET /api/locks
    const locksRes = await fetch(`${base}/api/locks`);
    assert.equal(locksRes.status, 200);
    const locksJson = await locksRes.json();
    assert.equal(locksJson.ok, true);

    await new Promise((res) => server.close(res));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
