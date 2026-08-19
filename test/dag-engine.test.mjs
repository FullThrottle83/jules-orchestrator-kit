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
});


