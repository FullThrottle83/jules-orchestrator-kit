import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DagExecutor, DagCycleError, isGlobalContractFile, resolveAffectedTests } from "../src/dag-engine.mjs";

describe("DagExecutor & Interface Fingerprinting", () => {
  let testDir;

  beforeEach(() => {
    testDir = join(tmpdir(), `dag-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("a) Linear DAG A -> B -> C executes in order A, B, C", async () => {
    const executor = new DagExecutor({ concurrency: 2 });
    const executionOrder = [];

    executor.addTask({
      id: "A",
      runner: async () => {
        executionOrder.push("A");
      },
    });

    executor.addTask({
      id: "B",
      dependsOn: ["A"],
      runner: async () => {
        executionOrder.push("B");
      },
    });

    executor.addTask({
      id: "C",
      dependsOn: ["B"],
      runner: async () => {
        executionOrder.push("C");
      },
    });

    const result = await executor.execute();
    assert.deepEqual(executionOrder, ["A", "B", "C"]);
    assert.deepEqual(result.executionHistory, ["A", "B", "C"]);
  });

  it("b) Diamond DAG A -> {B, C} -> D dispatches B and C concurrently, then D", async () => {
    const executor = new DagExecutor({ concurrency: 4 });
    const log = [];
    let bRunning = false;
    let cRunning = false;
    let bcConcurrent = false;

    executor.addTask({
      id: "A",
      runner: async () => {
        log.push("A");
      },
    });

    executor.addTask({
      id: "B",
      dependsOn: ["A"],
      runner: async () => {
        bRunning = true;
        log.push("B-start");
        if (cRunning) bcConcurrent = true;
        await new Promise((r) => setTimeout(r, 50));
        if (cRunning) bcConcurrent = true;
        log.push("B-end");
        bRunning = false;
      },
    });

    executor.addTask({
      id: "C",
      dependsOn: ["A"],
      runner: async () => {
        cRunning = true;
        log.push("C-start");
        if (bRunning) bcConcurrent = true;
        await new Promise((r) => setTimeout(r, 50));
        if (bRunning) bcConcurrent = true;
        log.push("C-end");
        cRunning = false;
      },
    });

    executor.addTask({
      id: "D",
      dependsOn: ["B", "C"],
      runner: async () => {
        log.push("D");
      },
    });

    const result = await executor.execute();
    assert.equal(log[0], "A");
    assert.equal(log[log.length - 1], "D");
    assert.ok(bcConcurrent, "B and C should execute concurrently");
    assert.equal(result.executionHistory.length, 4);
    assert.equal(result.executionHistory[0], "A");
    assert.equal(result.executionHistory[3], "D");
  });

  it("c) Circular graph A -> B -> C -> A throws DagCycleError before executing any task", async () => {
    const executor = new DagExecutor();
    let executedCount = 0;

    executor.addTask({
      id: "A",
      dependsOn: ["C"],
      runner: async () => {
        executedCount++;
      },
    });

    executor.addTask({
      id: "B",
      dependsOn: ["A"],
      runner: async () => {
        executedCount++;
      },
    });

    executor.addTask({
      id: "C",
      dependsOn: ["B"],
      runner: async () => {
        executedCount++;
      },
    });

    await assert.rejects(
      async () => {
        await executor.execute();
      },
      (err) => {
        assert.ok(err instanceof DagCycleError);
        assert.ok(err.message.includes("Circular dependency detected"));
        assert.ok(Array.isArray(err.cyclePath));
        assert.ok(err.cyclePath.length >= 3);
        return true;
      }
    );

    assert.equal(executedCount, 0, "No task runner should be invoked when a cycle exists");
  });

  it("computes SHA-256 interface fingerprints and verifies output gate before dependent task runs", async () => {
    const executor = new DagExecutor();
    const fileA = join(testDir, "outA.txt");

    executor.addTask({
      id: "TaskA",
      outputs: [fileA],
      runner: async () => {
        writeFileSync(fileA, "Hello interface data");
      },
    });

    executor.addTask({
      id: "TaskB",
      dependsOn: ["TaskA"],
      runner: async ({ fingerprints }) => {
        const expectedHash = createHash("sha256").update("Hello interface data").digest("hex");
        assert.equal(fingerprints.get(fileA), expectedHash);
      },
    });

    const result = await executor.execute();
    const expectedHash = createHash("sha256").update("Hello interface data").digest("hex");
    assert.equal(result.fingerprints.get(fileA), expectedHash);
  });

  it("fails verification gate if dependency output file hash is tampered after task completes", async () => {
    const executor = new DagExecutor();
    const fileA = join(testDir, "tampered.txt");

    executor.addTask({
      id: "TaskA",
      outputs: [fileA],
      runner: async () => {
        writeFileSync(fileA, "Original content");
      },
    });

    executor.addTask({
      id: "TaskB",
      dependsOn: ["TaskA"],
      runner: async () => {},
    });

    // We simulate external file tampering by overriding runner execution or post-step
    // Let's modify file after TaskA runner completes by extending task runner
    let taskBExecuted = false;
    const tamperedExecutor = new DagExecutor();
    tamperedExecutor.addTask({
      id: "TaskA",
      outputs: [fileA],
      runner: async () => {
        writeFileSync(fileA, "Original content");
        // Tamper content right after output creation inside TaskA before return
        // Note: Hash is computed post-TaskA execution.
      },
    });

    tamperedExecutor.addTask({
      id: "TaskB",
      dependsOn: ["TaskA"],
      runner: async () => {
        taskBExecuted = true;
      },
    });

    // Execute TaskA, then tamper file on disk before TaskB checks gate
    // Let's test gate failure by registering a intermediate step
    const gateTamperExecutor = new DagExecutor();
    gateTamperExecutor.addTask({
      id: "TaskA",
      outputs: [fileA],
      runner: async () => {
        writeFileSync(fileA, "Initial content");
      },
    });

    gateTamperExecutor.addTask({
      id: "TaskTamper",
      dependsOn: ["TaskA"],
      runner: async () => {
        // Tamper TaskA's output file
        writeFileSync(fileA, "Tampered content!");
      },
    });

    gateTamperExecutor.addTask({
      id: "TaskB",
      dependsOn: ["TaskTamper", "TaskA"], // depends on TaskA whose output was tampered
      runner: async () => {
        taskBExecuted = true;
      },
    });

    await assert.rejects(
      async () => {
        await gateTamperExecutor.execute({ concurrency: 1 });
      },
      /Interface fingerprint mismatch/
    );

    assert.equal(taskBExecuted, false);
  });

  it("lexicographically sorts ready task IDs to guarantee deterministic execution order", async () => {
    const executor = new DagExecutor({ concurrency: 1 });
    const order = [];

    // Add tasks in non-alphabetical order
    executor.addTask({ id: "Z", runner: async () => order.push("Z") });
    executor.addTask({ id: "M", runner: async () => order.push("M") });
    executor.addTask({ id: "A", runner: async () => order.push("A") });
    executor.addTask({ id: "K", runner: async () => order.push("K") });

    const result = await executor.execute();
    assert.deepEqual(order, ["A", "K", "M", "Z"]);
    assert.deepEqual(result.executionHistory, ["A", "K", "M", "Z"]);
  });

  it("isGlobalContractFile identifies global contract files accurately", () => {
    assert.equal(isGlobalContractFile("package.json"), true);
    assert.equal(isGlobalContractFile("package-lock.json"), true);
    assert.equal(isGlobalContractFile("tsconfig.json"), true);
    assert.equal(isGlobalContractFile("schema.prisma"), true);
    assert.equal(isGlobalContractFile("types.d.ts"), true);
    assert.equal(isGlobalContractFile(".env"), true);
    assert.equal(isGlobalContractFile(".agent/rules/jules.md"), true);
    assert.equal(isGlobalContractFile("Cargo.toml"), true);
    assert.equal(isGlobalContractFile("src/auth.mjs"), false);
    assert.equal(isGlobalContractFile("lib/utils.py"), false);
  });

  it("resolveAffectedTests returns null (full suite fallback) on global contract files and resolves selective tests on leaf files", () => {
    // Global contract change -> null
    assert.equal(resolveAffectedTests(["package.json"]), null);
    assert.equal(resolveAffectedTests(["src/auth.mjs", "tsconfig.json"]), null);

    // Test file modified directly -> resolves test file
    assert.deepEqual(resolveAffectedTests(["test/auth.test.mjs"]), ["test/auth.test.mjs"]);

    // Leaf file modified -> maps to known test file matching basename
    const affected = resolveAffectedTests(["src/auth.mjs"], {
      knownTestFiles: ["test/auth.test.mjs", "test/db.test.mjs"],
    });
    assert.deepEqual(affected, ["test/auth.test.mjs"]);
  });

  it("executeQueueDag processes queued tasks honoring dependsOn dependency tree", async () => {
    const { executeQueueDag } = await import("../src/dag-engine.mjs");
    const queueDir = join(testDir, ".agent", "jules-queue");
    mkdirSync(queueDir, { recursive: true });

    // Task 1: Setup DB (no dependencies)
    const task1Content = `<!-- JULES_TASK_ENVELOPE: {"version":1,"id":"TASK-01","title":"Setup DB"} -->
# Setup DB
[TASK INSTRUCTIONS]
Run database migration
[VERIFICATION ORACLE]
Test/Verification Command: npm test
`;
    writeFileSync(join(queueDir, "TASK-01.md"), task1Content);

    // Task 2: Seed Data (depends on TASK-01)
    const task2Content = `<!-- JULES_TASK_ENVELOPE: {"version":1,"id":"TASK-02","title":"Seed Data","dependsOn":["TASK-01"]} -->
# Seed Data
[TASK INSTRUCTIONS]
Seed user accounts
[VERIFICATION ORACLE]
Test/Verification Command: npm test
`;
    writeFileSync(join(queueDir, "TASK-02.md"), task2Content);

    const executionLog = [];
    const mockDispatch = async (task) => {
      executionLog.push(task.id);
      return { id: `session-${task.id}`, ok: true };
    };

    const res = await executeQueueDag(testDir, {
      concurrency: 2,
      dispatchFn: mockDispatch,
    });

    assert.equal(res.processed, 2);
    assert.deepEqual(executionLog, ["TASK-01", "TASK-02"]);
    assert.equal(existsSync(join(queueDir, "completed", "TASK-01.md")), true);
    assert.equal(existsSync(join(queueDir, "completed", "TASK-02.md")), true);
  });

  it("executeQueueDag skips manifests and other non-task JSON in the queue directory", async () => {
    const { executeQueueDag } = await import("../src/dag-engine.mjs");
    const queueDir = join(testDir, ".agent", "jules-queue");
    mkdirSync(queueDir, { recursive: true });

    writeFileSync(
      join(queueDir, "TASK-01.json"),
      JSON.stringify({ id: "TASK-01", title: "Real task", prompt: "Do the thing" })
    );
    // A swarm manifest: valid JSON, no prompt. Dispatching it sent the whole
    // file as the prompt, which blew the payload limit once it grew past ~50 KB.
    writeFileSync(
      join(queueDir, "swarm-300.json"),
      JSON.stringify({ swarmId: "swarm-300", tasks: Array.from({ length: 300 }, (_, i) => ({ id: `T-${i}`, body: "x".repeat(200) })) })
    );
    writeFileSync(join(queueDir, "index.json"), JSON.stringify([{ id: "a" }, { id: "b" }]));
    writeFileSync(join(queueDir, "README.md"), "# Queue\n\nDrop task envelopes here.\n");

    const dispatched = [];
    const res = await executeQueueDag(testDir, {
      dispatchFn: async (task) => {
        dispatched.push({ id: task.id, promptLength: (task.prompt || "").length });
        return { id: `session-${task.id}`, ok: true };
      },
    });

    assert.equal(res.processed, 1, "only the real task envelope may be dispatched");
    assert.deepEqual(dispatched.map((d) => d.id), ["TASK-01"]);
    assert.equal(dispatched[0].promptLength, "Do the thing".length);
    assert.equal(existsSync(join(queueDir, "swarm-300.json")), true, "the manifest must stay put");
    assert.equal(existsSync(join(queueDir, "README.md")), true, "the queue README is not a task");
  });

  it("executeQueueDag with dryRun leaves the queue directory untouched", async () => {
    const { executeQueueDag } = await import("../src/dag-engine.mjs");
    const queueDir = join(testDir, ".agent", "jules-queue");
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(
      join(queueDir, "TASK-01.md"),
      `<!-- JULES_TASK_ENVELOPE: {"version":1,"id":"TASK-01","title":"Setup DB"} -->\n# Setup DB\n`
    );

    const res = await executeQueueDag(testDir, {
      dryRun: true,
      dispatchFn: async (task) => ({ id: `session-${task.id}`, ok: true }),
    });

    assert.equal(res.processed, 1);
    assert.equal(res.results[0].dryRun, true);
    assert.equal(existsSync(join(queueDir, "TASK-01.md")), true, "a dry run must not move the task file");
    assert.equal(existsSync(join(queueDir, "completed", "TASK-01.md")), false);
    assert.equal(existsSync(join(queueDir, "completed")), false, "a dry run must not create completed/ either");
  });

  it("10. Default dispatched: B is dispatched before A's PR is merged, no gh call", async () => {
    const { executeQueueDag } = await import("../src/dag-engine.mjs");
    const queueDir = join(testDir, ".agent", "jules-queue");
    mkdirSync(queueDir, { recursive: true });

    writeFileSync(
      join(queueDir, "TASK-A.json"),
      JSON.stringify({ id: "TASK-A", title: "Task A", prompt: "Work A", targetFiles: ["src/shared.mjs"] })
    );
    writeFileSync(
      join(queueDir, "TASK-B.json"),
      JSON.stringify({ id: "TASK-B", title: "Task B", prompt: "Work B", targetFiles: ["src/shared.mjs"] })
    );

    let ghCalls = 0;
    const events = [];
    const res = await executeQueueDag(testDir, {
      concurrency: 2,
      execGh: async () => {
        ghCalls++;
        return { state: "OPEN", mergedAt: null };
      },
      dispatchFn: async (task) => {
        events.push(`dispatch:${task.id}`);
        return { id: `sess-${task.id}`, status: "RUNNING", outputs: [{ link: "https://github.com/org/repo/pull/1" }] };
      },
    });

    assert.equal(res.processed, 2);
    assert.deepEqual(events, ["dispatch:TASK-A", "dispatch:TASK-B"]);
    assert.equal(ghCalls, 0);
  });

  it("11. completed: A reports RUNNING then COMPLETED. B is dispatched only after. Also fails fast if blockedOn", async () => {
    const { executeQueueDag } = await import("../src/dag-engine.mjs");
    const queueDir = join(testDir, ".agent", "jules-queue");
    mkdirSync(queueDir, { recursive: true });

    writeFileSync(
      join(queueDir, "TASK-A.json"),
      JSON.stringify({ id: "TASK-A", title: "Task A", prompt: "Work A", targetFiles: ["src/shared.mjs"] })
    );
    writeFileSync(
      join(queueDir, "TASK-B.json"),
      JSON.stringify({ id: "TASK-B", title: "Task B", prompt: "Work B", targetFiles: ["src/shared.mjs"] })
    );

    const events = [];
    const pollCounts = new Map();

    const res = await executeQueueDag(testDir, {
      concurrency: 2,
      serialize: "completed",
      pollIntervalMs: 5,
      dispatchFn: async (task) => {
        events.push(`dispatch:${task.id}`);
        return { id: `sess-${task.id}`, status: "IN_PROGRESS" };
      },
      pollFn: async (sessionId) => {
        const c = (pollCounts.get(sessionId) || 0) + 1;
        pollCounts.set(sessionId, c);
        const state = c < 2 ? "RUNNING" : "COMPLETED";
        events.push(`poll:${sessionId}:${state}`);
        return { id: sessionId, status: state };
      },
    });

    assert.equal(res.processed, 2);
    assert.deepEqual(events, [
      "dispatch:TASK-A",
      "poll:sess-TASK-A:RUNNING",
      "poll:sess-TASK-A:COMPLETED",
      "dispatch:TASK-B",
      "poll:sess-TASK-B:RUNNING",
      "poll:sess-TASK-B:COMPLETED",
    ]);

    // JOK-002: the real poller must receive the exact provider selected
    // during dispatch, not an absent options.provider from the CLI.
    const providerRoot = join(testDir, "selected-provider-sub");
    const providerQueue = join(providerRoot, ".agent", "jules-queue");
    mkdirSync(providerQueue, { recursive: true });
    writeFileSync(join(providerQueue, "TASK-REMOTE.json"), JSON.stringify({
      id: "TASK-REMOTE", title: "Remote", prompt: "Poll remote completion",
    }));
    const polledSessions = [];
    const selectedProvider = {
      async getSession(id) {
        polledSessions.push(id);
        return { id, status: "COMPLETED" };
      },
    };
    const providerRes = await executeQueueDag(providerRoot, {
      serialize: "completed",
      pollIntervalMs: 5,
      dispatchFn: async (_task, ctx) => {
        ctx.onProviderResolved(selectedProvider);
        return { id: "live-session", status: "IN_PROGRESS" };
      },
    });
    assert.equal(providerRes.processed, 1);
    assert.deepEqual(polledSessions, ["live-session"]);

    // Also verify blockedOn fails with that status in the message and stops dependents
    const blockedDir = join(testDir, "blocked-sub");
    const blockedQueue = join(blockedDir, ".agent", "jules-queue");
    mkdirSync(blockedQueue, { recursive: true });
    writeFileSync(
      join(blockedQueue, "TASK-A.json"),
      JSON.stringify({ id: "TASK-A", title: "Task A", prompt: "Work A", targetFiles: ["src/shared.mjs"] })
    );
    writeFileSync(
      join(blockedQueue, "TASK-B.json"),
      JSON.stringify({ id: "TASK-B", title: "Task B", prompt: "Work B", targetFiles: ["src/shared.mjs"] })
    );
    const blockedDispatched = [];
    await assert.rejects(
      () =>
        executeQueueDag(blockedDir, {
          concurrency: 2,
          serialize: "completed",
          pollIntervalMs: 5,
          dispatchFn: async (task) => {
            blockedDispatched.push(task.id);
            return { id: `sess-${task.id}`, status: "IN_PROGRESS" };
          },
          pollFn: async (sessionId) => ({ id: sessionId, status: "AWAITING_USER_FEEDBACK" }),
        }),
      /AWAITING_USER_FEEDBACK/
    );
    assert.deepEqual(blockedDispatched, ["TASK-A"]);
  });

  it("12. merged: PR state OPEN, OPEN, MERGED. B is dispatched only after MERGED and not while OPEN", async () => {
    const { executeQueueDag } = await import("../src/dag-engine.mjs");
    const queueDir = join(testDir, ".agent", "jules-queue");
    mkdirSync(queueDir, { recursive: true });

    writeFileSync(
      join(queueDir, "TASK-A.json"),
      JSON.stringify({ id: "TASK-A", title: "Task A", prompt: "Work A", targetFiles: ["src/shared.mjs"] })
    );
    writeFileSync(
      join(queueDir, "TASK-B.json"),
      JSON.stringify({ id: "TASK-B", title: "Task B", prompt: "Work B", targetFiles: ["src/shared.mjs"] })
    );

    const events = [];
    const prSequence = {
      "https://github.com/org/repo/pull/10": ["OPEN", "OPEN", "MERGED"],
      "https://github.com/org/repo/pull/11": ["MERGED"],
    };

    const res = await executeQueueDag(testDir, {
      concurrency: 2,
      serialize: "merged",
      pollIntervalMs: 5,
      dispatchFn: async (task) => {
        events.push(`dispatch:${task.id}`);
        const prNum = task.id === "TASK-A" ? 10 : 11;
        return {
          id: `sess-${task.id}`,
          status: "COMPLETED",
          outputs: [{ pullRequest: { url: `https://github.com/org/repo/pull/${prNum}` } }],
        };
      },
      execGh: async (_cmd, args) => {
        const url = args[1];
        const seq = prSequence[url];
        const state = seq.length > 1 ? seq.shift() : seq[0];
        events.push(`gh:${url}:${state}`);
        return { state, mergedAt: state === "MERGED" ? "2026-10-18T12:00:00Z" : null };
      },
    });

    assert.equal(res.processed, 2);
    assert.deepEqual(events, [
      "dispatch:TASK-A",
      "gh:https://github.com/org/repo/pull/10:OPEN",
      "gh:https://github.com/org/repo/pull/10:OPEN",
      "gh:https://github.com/org/repo/pull/10:MERGED",
      "dispatch:TASK-B",
      "gh:https://github.com/org/repo/pull/11:MERGED",
    ]);
  });

  it("13. PR CLOSED without merge: PR_CLOSED_UNMERGED, B never dispatched, DAG rejects with a clear message", async () => {
    const { executeQueueDag } = await import("../src/dag-engine.mjs");
    const queueDir = join(testDir, ".agent", "jules-queue");
    mkdirSync(queueDir, { recursive: true });

    writeFileSync(
      join(queueDir, "TASK-A.json"),
      JSON.stringify({ id: "TASK-A", title: "Task A", prompt: "Work A", targetFiles: ["src/shared.mjs"] })
    );
    writeFileSync(
      join(queueDir, "TASK-B.json"),
      JSON.stringify({ id: "TASK-B", title: "Task B", prompt: "Work B", targetFiles: ["src/shared.mjs"] })
    );

    const dispatched = [];
    await assert.rejects(
      () =>
        executeQueueDag(testDir, {
          concurrency: 2,
          serialize: "merged",
          pollIntervalMs: 5,
          dispatchFn: async (task) => {
            dispatched.push(task.id);
            return {
              id: `sess-${task.id}`,
              status: "COMPLETED",
              outputs: [{ link: "https://github.com/org/repo/pull/20" }],
            };
          },
          execGh: async () => ({ state: "CLOSED", mergedAt: null }),
        }),
      (err) => {
        assert.match(err.message, /PR_CLOSED_UNMERGED/);
        assert.match(err.message, /https:\/\/github\.com\/org\/repo\/pull\/20/);
        return true;
      }
    );

    assert.deepEqual(dispatched, ["TASK-A"]);
  });

  it("14. Timeout: PR stays OPEN, tiny --serialize-timeout: SERIALIZE_TIMEOUT naming the PR, B never dispatched", async () => {
    const { executeQueueDag } = await import("../src/dag-engine.mjs");
    const queueDir = join(testDir, ".agent", "jules-queue");
    mkdirSync(queueDir, { recursive: true });

    writeFileSync(
      join(queueDir, "TASK-A.json"),
      JSON.stringify({ id: "TASK-A", title: "Task A", prompt: "Work A", targetFiles: ["src/shared.mjs"] })
    );
    writeFileSync(
      join(queueDir, "TASK-B.json"),
      JSON.stringify({ id: "TASK-B", title: "Task B", prompt: "Work B", targetFiles: ["src/shared.mjs"] })
    );

    const dispatched = [];
    await assert.rejects(
      () =>
        executeQueueDag(testDir, {
          concurrency: 2,
          serialize: "merged",
          serializeTimeout: 0.0005, // ~30ms
          pollIntervalMs: 10,
          dispatchFn: async (task) => {
            dispatched.push(task.id);
            return {
              id: `sess-${task.id}`,
              status: "COMPLETED",
              outputs: [{ link: "https://github.com/org/repo/pull/30" }],
            };
          },
          execGh: async () => ({ state: "OPEN", mergedAt: null }),
        }),
      (err) => {
        assert.match(err.message, /SERIALIZE_TIMEOUT/);
        assert.match(err.message, /https:\/\/github\.com\/org\/repo\/pull\/30/);
        return true;
      }
    );

    assert.deepEqual(dispatched, ["TASK-A"]);
  });

  it("15. merged mode, session terminal with no PR: NO_PR_TO_WAIT_FOR", async () => {
    const { executeQueueDag } = await import("../src/dag-engine.mjs");
    const queueDir = join(testDir, ".agent", "jules-queue");
    mkdirSync(queueDir, { recursive: true });

    writeFileSync(
      join(queueDir, "TASK-A.json"),
      JSON.stringify({ id: "TASK-A", title: "Task A", prompt: "Work A", targetFiles: ["src/shared.mjs"] })
    );
    writeFileSync(
      join(queueDir, "TASK-B.json"),
      JSON.stringify({ id: "TASK-B", title: "Task B", prompt: "Work B", targetFiles: ["src/shared.mjs"] })
    );

    const dispatched = [];
    await assert.rejects(
      () =>
        executeQueueDag(testDir, {
          concurrency: 2,
          serialize: "merged",
          pollIntervalMs: 5,
          dispatchFn: async (task) => {
            dispatched.push(task.id);
            return { id: `sess-${task.id}`, status: "COMPLETED", outputs: [] };
          },
        }),
      /NO_PR_TO_WAIT_FOR/
    );

    assert.deepEqual(dispatched, ["TASK-A"]);
  });

  it("16. Independent task C (disjoint files) dispatches without waiting for A's merge, with concurrency 3", async () => {
    const { executeQueueDag } = await import("../src/dag-engine.mjs");
    const queueDir = join(testDir, ".agent", "jules-queue");
    mkdirSync(queueDir, { recursive: true });

    writeFileSync(
      join(queueDir, "TASK-A.json"),
      JSON.stringify({ id: "TASK-A", title: "Task A", prompt: "Work A", targetFiles: ["src/shared.mjs"] })
    );
    writeFileSync(
      join(queueDir, "TASK-B.json"),
      JSON.stringify({ id: "TASK-B", title: "Task B", prompt: "Work B", targetFiles: ["src/shared.mjs"] })
    );
    writeFileSync(
      join(queueDir, "TASK-C.json"),
      JSON.stringify({ id: "TASK-C", title: "Task C", prompt: "Work C", targetFiles: ["src/disjoint.mjs"] })
    );

    const events = [];
    let cDispatched = false;

    const res = await executeQueueDag(testDir, {
      concurrency: 3,
      serialize: "merged",
      pollIntervalMs: 10,
      dispatchFn: async (task) => {
        events.push(`dispatch:${task.id}`);
        if (task.id === "TASK-C") cDispatched = true;
        const prMap = { "TASK-A": 41, "TASK-B": 42, "TASK-C": 43 };
        return {
          id: `sess-${task.id}`,
          status: "COMPLETED",
          outputs: [{ link: `https://github.com/org/repo/pull/${prMap[task.id]}` }],
        };
      },
      execGh: async (_cmd, args) => {
        const url = args[1];
        if (url.endsWith("/41") && !cDispatched) {
          events.push("gh:41:OPEN");
          return { state: "OPEN", mergedAt: null };
        }
        const num = url.split("/").pop();
        events.push(`gh:${num}:MERGED`);
        return { state: "MERGED", mergedAt: "2026-10-18T12:00:00Z" };
      },
    });

    assert.equal(res.processed, 3);
    const dispatchCIdx = events.indexOf("dispatch:TASK-C");
    const merged41Idx = events.indexOf("gh:41:MERGED");
    const dispatchBIdx = events.indexOf("dispatch:TASK-B");
    assert.ok(dispatchCIdx < merged41Idx, "C must dispatch before A's PR is merged");
    assert.ok(merged41Idx < dispatchBIdx, "B must dispatch only after A's PR is merged");
  });

  it("17. Chain A, B, C all overlapping: strictly sequential, each waits for the previous merge", async () => {
    const { executeQueueDag } = await import("../src/dag-engine.mjs");
    const queueDir = join(testDir, ".agent", "jules-queue");
    mkdirSync(queueDir, { recursive: true });

    for (const id of ["TASK-A", "TASK-B", "TASK-C"]) {
      writeFileSync(
        join(queueDir, `${id}.json`),
        JSON.stringify({ id, title: id, prompt: `Work ${id}`, targetFiles: ["src/overlap.mjs"] })
      );
    }

    const events = [];
    const prPollCounts = new Map();

    const res = await executeQueueDag(testDir, {
      concurrency: 3,
      serialize: "merged",
      pollIntervalMs: 5,
      dispatchFn: async (task) => {
        events.push(`dispatch:${task.id}`);
        const num = { "TASK-A": 51, "TASK-B": 52, "TASK-C": 53 }[task.id];
        return {
          id: `sess-${task.id}`,
          status: "COMPLETED",
          outputs: [{ link: `https://github.com/org/repo/pull/${num}` }],
        };
      },
      execGh: async (_cmd, args) => {
        const url = args[1];
        const num = url.split("/").pop();
        const c = (prPollCounts.get(num) || 0) + 1;
        prPollCounts.set(num, c);
        const state = c < 2 ? "OPEN" : "MERGED";
        events.push(`gh:${num}:${state}`);
        return { state, mergedAt: state === "MERGED" ? "2026-10-18T12:00:00Z" : null };
      },
    });

    assert.equal(res.processed, 3);
    assert.deepEqual(events, [
      "dispatch:TASK-A",
      "gh:51:OPEN",
      "gh:51:MERGED",
      "dispatch:TASK-B",
      "gh:52:OPEN",
      "gh:52:MERGED",
      "dispatch:TASK-C",
      "gh:53:OPEN",
      "gh:53:MERGED",
    ]);
  });

  it("18. Resume: A dispatched and recorded as awaiting merge, process restarts, PR still OPEN -> B waits; after MERGED, B dispatches and A is not dispatched again", async () => {
    const { executeQueueDag } = await import("../src/dag-engine.mjs");
    const queueDir = join(testDir, ".agent", "jules-queue");
    mkdirSync(queueDir, { recursive: true });

    writeFileSync(
      join(queueDir, "TASK-A.json"),
      JSON.stringify({ id: "TASK-A", title: "Task A", prompt: "Work A", targetFiles: ["src/shared.mjs"] })
    );
    writeFileSync(
      join(queueDir, "TASK-B.json"),
      JSON.stringify({ id: "TASK-B", title: "Task B", prompt: "Work B", targetFiles: ["src/shared.mjs"] })
    );

    const dispatchCounts = { "TASK-A": 0, "TASK-B": 0 };

    // Run 1: A dispatches, moves to completed/, records awaiting_merge, then process "crashes" during gh poll
    await assert.rejects(
      () =>
        executeQueueDag(testDir, {
          concurrency: 2,
          serialize: "merged",
          pollIntervalMs: 5,
          dispatchFn: async (task) => {
            dispatchCounts[task.id] = (dispatchCounts[task.id] || 0) + 1;
            return {
              id: `sess-${task.id}`,
              status: "COMPLETED",
              outputs: [{ link: "https://github.com/org/repo/pull/61" }],
            };
          },
          execGh: async () => {
            throw new Error("SIMULATED_PROCESS_CRASH");
          },
        }),
      /SIMULATED_PROCESS_CRASH/
    );

    assert.equal(dispatchCounts["TASK-A"], 1);
    assert.equal(dispatchCounts["TASK-B"], 0);
    assert.equal(existsSync(join(queueDir, "completed", "TASK-A.json")), true, "A was already moved to completed/");
    assert.equal(existsSync(join(queueDir, "TASK-B.json")), true, "B is still in queue");

    // Run 2 (restart): PR 61 is still OPEN for 2 polls, then MERGED; B must not dispatch while 61 is OPEN
    const run2Events = [];
    let pr61Polls = 0;
    const res2 = await executeQueueDag(testDir, {
      concurrency: 2,
      serialize: "merged",
      pollIntervalMs: 5,
      dispatchFn: async (task) => {
        dispatchCounts[task.id] = (dispatchCounts[task.id] || 0) + 1;
        run2Events.push(`dispatch:${task.id}`);
        return {
          id: `sess-${task.id}`,
          status: "COMPLETED",
          outputs: [{ link: "https://github.com/org/repo/pull/62" }],
        };
      },
      execGh: async (_cmd, args) => {
        const url = args[1];
        if (url.endsWith("/61")) {
          pr61Polls++;
          const state = pr61Polls < 3 ? "OPEN" : "MERGED";
          run2Events.push(`gh:61:${state}`);
          return { state, mergedAt: state === "MERGED" ? "2026-10-18T12:00:00Z" : null };
        }
        run2Events.push("gh:62:MERGED");
        return { state: "MERGED", mergedAt: "2026-10-18T12:00:01Z" };
      },
    });

    assert.equal(res2.processed, 1);
    assert.equal(dispatchCounts["TASK-A"], 1, "A must not be dispatched a second time");
    assert.equal(dispatchCounts["TASK-B"], 1, "B must be dispatched once after A's merge");
    assert.deepEqual(run2Events, [
      "gh:61:OPEN",
      "gh:61:OPEN",
      "gh:61:MERGED",
      "dispatch:TASK-B",
      "gh:62:MERGED",
    ]);
  });

  it("19. Dry run with serialize=merged: no polling, no gh calls, queue files untouched", async () => {
    const { executeQueueDag } = await import("../src/dag-engine.mjs");
    const queueDir = join(testDir, ".agent", "jules-queue");
    mkdirSync(queueDir, { recursive: true });

    writeFileSync(
      join(queueDir, "TASK-A.json"),
      JSON.stringify({ id: "TASK-A", title: "Task A", prompt: "Work A", targetFiles: ["src/shared.mjs"] })
    );
    writeFileSync(
      join(queueDir, "TASK-B.json"),
      JSON.stringify({ id: "TASK-B", title: "Task B", prompt: "Work B", targetFiles: ["src/shared.mjs"] })
    );

    let pollCalls = 0;
    let ghCalls = 0;

    const res = await executeQueueDag(testDir, {
      concurrency: 2,
      dryRun: true,
      serialize: "merged",
      dispatchFn: async (task) => ({ id: `sess-${task.id}`, status: "IN_PROGRESS" }),
      pollFn: async () => {
        pollCalls++;
        return { status: "COMPLETED" };
      },
      execGh: async () => {
        ghCalls++;
        return { state: "MERGED" };
      },
    });

    assert.equal(res.processed, 2);
    assert.equal(pollCalls, 0);
    assert.equal(ghCalls, 0);
    assert.equal(existsSync(join(queueDir, "TASK-A.json")), true);
    assert.equal(existsSync(join(queueDir, "TASK-B.json")), true);
    assert.equal(existsSync(join(queueDir, "completed")), false);
  });

  it("20. Invalid --serialize value is rejected with the list of valid values", async () => {
    const { executeQueueDag } = await import("../src/dag-engine.mjs");
    await assert.rejects(
      () => executeQueueDag(testDir, { serialize: "bogus" }),
      (err) => {
        assert.match(err.message, /Invalid --serialize mode 'bogus'/);
        assert.match(err.message, /dispatched, completed, merged/);
        return true;
      }
    );

    const { spawnSync } = await import("node:child_process");
    const cliRes = spawnSync(
      process.execPath,
      [join(process.cwd(), "bin", "agentctl.mjs"), "queue", "--dag", "--serialize", "bogus"],
      { cwd: testDir, encoding: "utf-8" }
    );
    assert.notEqual(cliRes.status, 0);
    assert.match(cliRes.stderr, /dispatched, completed, merged/);
  });

  it("21. COMMAND_REFERENCE.md matches formatRegistryMarkdown() generator output", async () => {
    const { readFileSync } = await import("node:fs");
    const { formatRegistryMarkdown } = await import("../src/ops/command-registry.mjs");
    const disk = readFileSync(join(process.cwd(), "docs", "COMMAND_REFERENCE.md"), "utf-8").replace(/\r\n/g, "\n");
    const generated = (`${formatRegistryMarkdown()}`.replace(/\s+$/, "") + "\n").replace(/\r\n/g, "\n");
    assert.equal(disk, generated);
    assert.match(disk, /--serialize/);
    assert.match(disk, /--serialize-timeout/);
  });
});



