#!/usr/bin/env node
/**
 * arena-toctou-test.mjs — VFS mutex / lock TOCTOU race-condition audit harness.
 *
 * Stresstests the lock and mutex machinery in src/state.mjs under high
 * parallelism and reports (never fixes) race conditions:
 *
 *   Test A — 50 child_process workers race acquireLock() on the SAME taskId
 *            with overlapping file sets (small lock records).
 *   Test B — same race with multi-megabyte lock records, which widens the
 *            non-atomic create→write publish window so it can be observed and
 *            exploited; also directly observes partially-published records.
 *   Test C — workers race acquireLock() on DIFFERENT taskIds claiming the SAME
 *            files (cross-task file-exclusivity check-then-act race).
 *   Test D — 20 child workers race appendLedger() into one daily ledger, then
 *            the SHA-256 hash chain is validated (verifyLedgerIntegrity plus an
 *            independent chain walker that detects forks/lost updates).
 *   Test E — 220 worker_threads hammer withVfsMutex() (mkdirSync spin-wait)
 *            under extreme contention and check mutual exclusion of the
 *            critical section via an enter/exit log.
 *   Test F — deterministic probes for specific TOCTOU/correctness defects:
 *            F1: withVfsMutex re-executes fn when fn throws err.code=EEXIST
 *            F2: stale/blocked mutex dir wedges forever (no reaper)
 *            F3: unconditional mutex release (no ownership token) breaks
 *                mutual exclusion once the dir is externally cleaned up
 *            F4: re-entrant withVfsMutex on the same dir self-deadlocks
 *            F5: entry.hash schema collision invalidates its own chain entry
 *
 * The harness imports directly from ./src/state.mjs (relative to the repo
 * root) and never modifies existing files. All state is written under a
 * private temp root passed explicitly to every call. Zero third-party
 * dependencies: only node:child_process, node:fs, node:path, node:crypto,
 * node:os, node:worker_threads.
 *
 * Usage:  node arena-toctou-test.mjs
 * Exit:   0 when the audit ran to completion (races found are FINDINGS, not
 *         harness failures); 1 on harness error. No unhandled rejections.
 */

import { fork } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

import {
  withVfsMutex,
  MutexTimeoutError,
  appendLedger,
  verifyLedgerIntegrity,
  readLedger,
  acquireLock,
  releaseLock,
  getDailyLedgerPath,
} from "./src/state.mjs";

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

const scriptPath = decodeURIComponent(new URL(import.meta.url).pathname);
const repoRoot = dirname(scriptPath);

const LOCK_WORKERS = 50; // requirement 2a
const LEDGER_WORKERS = 20; // requirement 2b
const MUTEX_WORKERS = 220; // requirement 2e ("200+")
const ROUNDS_SMALL = 24;
const ROUNDS_LARGE = 10;
const ROUNDS_OVERLAP = 6;
const ROUNDS_LEDGER = 12;
const START_LEAD_MS = 150; // barrier lead time before simultaneous action
const ROUND_TIMEOUT_MS = 30000;

const SUMMARY = {
  tests: [],
  doubleGrants: { small: 0, large: 0, crossTask: 0, totalRounds: 0 },
  corruptedChains: 0,
  findings: [],
};

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function log(msg) {
  console.log(msg);
}

function section(title) {
  console.log("");
  console.log(`=== ${title} ===`);
}

function spinUntil(ts) {
  while (Date.now() < ts) {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildFiles(spec) {
  const { count = 3, size = 64, prefix = "src/mod" } = spec;
  return Array.from({ length: count }, (_, i) => `${prefix}-${i}.${"x".repeat(size)}`);
}

function mkTempRoot(name) {
  const root = join(tmpdir(), `arena-toctou-${process.pid}-${name}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function findFinding(id) {
  return SUMMARY.findings.find((f) => f.id === id);
}

function recordFinding(finding) {
  const existing = findFinding(finding.id);
  if (existing) {
    Object.assign(existing, finding);
  } else {
    SUMMARY.findings.push(finding);
  }
}

// ---------------------------------------------------------------------------
// Child process pool (fork + IPC) used by tests A/B/C/D
// ---------------------------------------------------------------------------

function makePool(n, workerMode) {
  const kids = [];
  for (let i = 0; i < n; i++) {
    const child = fork(scriptPath, [`--worker=${workerMode}`], {
      cwd: repoRoot,
      env: { ...process.env, ARENA_WHO: String(i) },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const kid = {
      id: i,
      child,
      waiter: null,
      inbox: [],
      exited: false,
      lastResult: null,
    };
    child.on("message", (m) => {
      kid.inbox.push(m);
      if (kid.waiter) kid.waiter();
    });
    child.on("exit", () => {
      kid.exited = true;
      const w = kid.waiter;
      if (w) {
        kid.waiter = null;
        w({ type: "child-exit", id: i });
      }
    });
    child.on("error", () => {
      kid.exited = true;
    });
    kids.push(kid);
  }
  return kids;
}

function broadcast(kids, msg) {
  for (const k of kids) {
    if (!k.exited) {
      try {
        k.child.send(msg);
      } catch (_) {}
    }
  }
}

function collectResults(kids, timeoutMs, matchType = null) {
  return new Promise((resolve) => {
    const results = new Array(kids.length).fill(null);
    let remaining = kids.length;
    if (remaining === 0) {
      resolve(results);
      return;
    }
    const timer = setTimeout(() => resolve(results), timeoutMs);
    kids.forEach((k, i) => {
      const pump = () => {
        if (results[i] !== null) return true;
        const idx = k.inbox.findIndex((m) => !matchType || m.type === matchType);
        if (idx >= 0) {
          results[i] = k.inbox.splice(idx, 1)[0];
        } else if (k.exited) {
          results[i] = { type: "child-exit", id: i };
        } else {
          return false;
        }
        remaining -= 1;
        if (remaining === 0) {
          clearTimeout(timer);
          resolve(results);
        }
        return true;
      };
      k.waiter = pump;
      pump();
    });
  });
}

function killPool(kids) {
  for (const k of kids) {
    try {
      k.child.kill("SIGKILL");
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Worker modes (child processes and worker threads run this same script)
// ---------------------------------------------------------------------------

function lockWorkerMain() {
  const id = Number(process.env.ARENA_WHO ?? "0");
  process.on("message", (msg) => {
    try {
      if (msg.cmd === "acquire") {
        const files = buildFiles(msg.filesSpec);
        spinUntil(msg.startAt);
        const t0 = Date.now();
        let result;
        try {
          result = acquireLock(msg.agent, msg.taskId, files, msg.root, msg.opts || {});
        } catch (err) {
          result = { ok: false, threw: err.name, error: err.message };
        }
        process.send({
          type: "result",
          round: msg.round,
          id,
          at: Date.now(),
          ms: Date.now() - t0,
          ...result,
        });
      } else if (msg.cmd === "cleanup") {
        let released = false;
        if (msg.taskIds && Array.isArray(msg.taskIds)) {
          for (const tid of msg.taskIds) {
            try {
              if (releaseLock(tid, msg.root)) released = true;
            } catch (_) {}
          }
        } else {
          try {
            released = releaseLock(msg.taskId, msg.root);
          } catch (_) {}
        }
        process.send({ type: "ready", id, released });
      } else if (msg.cmd === "exit") {
        process.exit(0);
      }
    } catch (err) {
      try {
        process.send({ type: "worker-error", id, error: err.message });
      } catch (_) {}
    }
  });
  process.send({ type: "ready", id });
}

function ledgerWorkerMain() {
  const id = Number(process.env.ARENA_WHO ?? "0");
  process.on("message", (msg) => {
    try {
      if (msg.cmd === "append") {
        spinUntil(msg.startAt);
        const t0 = Date.now();
        let result;
        try {
          const payload = appendLedger({ event: "toctou_audit", worker: id, round: msg.round }, msg.root);
          result = { ok: true, hash: payload.hash, prevHash: payload.prevHash };
        } catch (err) {
          result = {
            ok: false,
            threw: err.name,
            isMutexTimeout: err instanceof MutexTimeoutError || err.name === "MutexTimeoutError",
            error: err.message,
          };
        }
        process.send({ type: "ledger-result", round: msg.round, id, ms: Date.now() - t0, ...result });
      } else if (msg.cmd === "exit") {
        process.exit(0);
      }
    } catch (err) {
      try {
        process.send({ type: "worker-error", id, error: err.message });
      } catch (_) {}
    }
  });
  process.send({ type: "ready", id });
}

function mutexThreadMain() {
  const { who, mutexDir, logPath, holdMs, maxRetries, retryDelayMs, gateSab, holdSab } = workerData;
  // Sleep on the gate (no CPU) until the parent releases all threads at once.
  Atomics.wait(gateSab, 0, 0);
  const t0 = Date.now();
  try {
    withVfsMutex(
      mutexDir,
      () => {
        appendFileSync(logPath, `ENTER ${who} ${process.hrtime.bigint()}\n`);
        // CPU-free hold: blocks this thread for holdMs, like an fsync would.
        Atomics.wait(holdSab, 0, 0, holdMs);
        appendFileSync(logPath, `EXIT ${who} ${process.hrtime.bigint()}\n`);
      },
      { maxRetries, retryDelayMs }
    );
    parentPort.postMessage({ who, ok: true, waitedMs: Date.now() - t0 });
  } catch (err) {
    parentPort.postMessage({
      who,
      ok: false,
      waitedMs: Date.now() - t0,
      errorName: err.name,
      isMutexTimeout: err instanceof MutexTimeoutError || err.name === "MutexTimeoutError",
      error: err.message,
    });
  }
}

// ---------------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------------

function analyzeMutexLog(logPath) {
  const events = [];
  for (const line of readFileSync(logPath, "utf-8").split("\n")) {
    if (!line) continue;
    const [kind, who, ts] = line.split(" ");
    events.push({ kind, who, ts: BigInt(ts) });
  }
  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const active = new Map();
  const overlaps = [];
  for (const ev of events) {
    if (ev.kind === "ENTER") {
      for (const [who] of active) {
        if (who !== ev.who) overlaps.push({ inside: who, entered: ev.who });
      }
      active.set(ev.who, ev.ts);
    } else {
      active.delete(ev.who);
    }
  }
  return { eventCount: events.length, overlaps };
}

function analyzeChain(filePath) {
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter(Boolean);
  let expectedPrev = "0".repeat(64);
  const seenPrev = new Map();
  let torn = 0;
  let broken = 0;
  let missing = 0;
  let badHash = 0;
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_) {
      torn += 1;
      continue;
    }
    if (!obj.hash || !obj.prevHash) {
      missing += 1;
      continue;
    }
    seenPrev.set(obj.prevHash, (seenPrev.get(obj.prevHash) || 0) + 1);
    if (obj.prevHash !== expectedPrev) broken += 1;
    const { hash, ...rest } = obj;
    const recomputed = createHash("sha256").update(JSON.stringify(rest)).digest("hex");
    if (recomputed !== hash) badHash += 1;
    expectedPrev = obj.hash;
  }
  let forks = 0;
  for (const c of seenPrev.values()) {
    if (c > 1) forks += c - 1;
  }
  return { total: lines.length, torn, broken, missing, badHash, forks };
}

// ---------------------------------------------------------------------------
// Test A/B: same-taskId acquireLock() double-grant race
// ---------------------------------------------------------------------------

async function runLockRace({ label, root, kids, rounds, filesSpec, taskId }) {
  let doubleGrantRounds = 0;
  let totalOk = 0;
  let maxOkInRound = 0;
  let totalThrown = 0;
  const roundDetails = [];

  for (let round = 0; round < rounds; round++) {
    // Clean slate: no lock may exist at the start of a round.
    try {
      const lf = join(root, ".agent", "state", "locks", `${taskId}.json`);
      if (existsSync(lf)) unlinkSync(lf);
    } catch (_) {}

    const startAt = Date.now() + START_LEAD_MS;
    broadcast(kids, {
      cmd: "acquire",
      round,
      startAt,
      agent: `auditor`,
      taskId,
      filesSpec,
      root,
      opts: {},
    });
    const results = await collectResults(kids, ROUND_TIMEOUT_MS, "result");
    const oks = results.filter((r) => r && r.ok === true);
    const thrown = results.filter((r) => r && r.threw);
    totalOk += oks.length;
    totalThrown += thrown.length;
    if (oks.length > maxOkInRound) maxOkInRound = oks.length;
    if (oks.length > 1) {
      doubleGrantRounds += 1;
      roundDetails.push({ round, okCount: oks.length, winners: oks.map((o) => o.id) });
    }
    broadcast(kids, { cmd: "cleanup", taskIds: [taskId], root });
    await collectResults(kids, ROUND_TIMEOUT_MS, "ready");
    if (round % 5 === 4) log(`  [${label}] round ${round + 1}/${rounds} done (double grants so far: ${doubleGrantRounds})`);
  }

  return { label, rounds, doubleGrantRounds, totalOk, maxOkInRound, totalThrown, roundDetails };
}

// ---------------------------------------------------------------------------
// Test B0: observe the create→write publish window on a live lock record
// ---------------------------------------------------------------------------

async function observePublishWindow(root, kid) {
  const taskId = "publish-probe";
  const filesSpec = { count: 3000, size: 1024, prefix: "probe/file" };
  const lockFile = join(root, ".agent", "state", "locks", `${taskId}.json`);

  const startAt = Date.now() + START_LEAD_MS;
  broadcast([kid], { cmd: "acquire", round: 0, startAt, agent: "probe-writer", taskId, filesSpec, root, opts: {} });

  // Poll the lock record while the child publishes it.
  let notExists = 0;
  let empty = 0;
  let partialInvalid = 0;
  let valid = 0;
  let maxBytes = 0;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const raw = readFileSync(lockFile, "utf-8");
      if (raw.length > maxBytes) maxBytes = raw.length;
      if (raw.length === 0) {
        empty += 1;
      } else {
        try {
          JSON.parse(raw);
          valid += 1;
        } catch (_) {
          partialInvalid += 1;
        }
      }
    } catch (_) {
      notExists += 1;
    }
    if (valid > 0 && Date.now() > startAt + 2000) break;
  }
  const results = await collectResults([kid], ROUND_TIMEOUT_MS, "result");
  broadcast([kid], { cmd: "cleanup", taskIds: [taskId], root });
  await collectResults([kid], ROUND_TIMEOUT_MS, "ready");

  return {
    pollsNotExists: notExists,
    pollsEmpty: empty,
    pollsPartialInvalid: partialInvalid,
    pollsValid: valid,
    maxBytes,
    childOk: results[0]?.ok === true,
  };
}

// ---------------------------------------------------------------------------
// Test C: cross-task file-exclusivity check-then-act race
// ---------------------------------------------------------------------------

async function runCrossTaskOverlap({ root, kids, rounds, filesSpec }) {
  let violationRounds = 0;
  let maxOkInRound = 0;
  const details = [];
  for (let round = 0; round < rounds; round++) {
    for (const k of kids) {
      try {
        const lf = join(root, ".agent", "state", "locks", `overlap-task-${k.id}.json`);
        if (existsSync(lf)) unlinkSync(lf);
      } catch (_) {}
    }
    const startAt = Date.now() + START_LEAD_MS;
    // Per-child taskIds, same file set for everyone.
    for (const k of kids) {
      if (!k.exited) {
        try {
          k.child.send({
            cmd: "acquire",
            round,
            startAt,
            agent: `auditor`,
            taskId: `overlap-task-${k.id}`,
            filesSpec,
            root,
            opts: {},
          });
        } catch (_) {}
      }
    }
    const results = await collectResults(kids, ROUND_TIMEOUT_MS, "result");
    const oks = results.filter((r) => r && r.ok === true);
    if (oks.length > maxOkInRound) maxOkInRound = oks.length;
    if (oks.length > 1) {
      violationRounds += 1;
      details.push({
        round,
        okCount: oks.length,
        winners: oks.map((o) => ({ id: o.id, taskId: o.taskId, conflicting: o.conflictingFiles })),
      });
    }
    broadcast(kids, {
      cmd: "cleanup",
      taskIds: kids.map((k) => `overlap-task-${k.id}`),
      root,
    });
    await collectResults(kids, ROUND_TIMEOUT_MS, "ready");
    log(`  [cross-task] round ${round + 1}/${rounds} done (violations so far: ${violationRounds})`);
  }
  return { rounds, violationRounds, maxOkInRound, details };
}

// ---------------------------------------------------------------------------
// Test D: appendLedger() hash-chain race
// ---------------------------------------------------------------------------

async function runLedgerRace({ root, kids, rounds }) {
  let success = 0;
  let mutexTimeouts = 0;
  let otherErrors = 0;
  for (let round = 0; round < rounds; round++) {
    const startAt = Date.now() + START_LEAD_MS;
    broadcast(kids, { cmd: "append", round, startAt, root });
    const results = await collectResults(kids, ROUND_TIMEOUT_MS, "ledger-result");
    for (const r of results) {
      if (!r) {
        otherErrors += 1;
      } else if (r.ok) {
        success += 1;
      } else if (r.isMutexTimeout) {
        mutexTimeouts += 1;
      } else {
        otherErrors += 1;
      }
    }
    log(`  [ledger] round ${round + 1}/${rounds} done (ok=${success}, timeouts=${mutexTimeouts}, errors=${otherErrors})`);
  }
  return { rounds, success, mutexTimeouts, otherErrors };
}

// ---------------------------------------------------------------------------
// Test E: withVfsMutex extreme contention
// ---------------------------------------------------------------------------

async function runMutexContention({ mutexDir, logPath, holdMs, maxRetries, retryDelayMs, workers }) {
  rmSync(mutexDir, { recursive: true, force: true });
  try {
    unlinkSync(logPath);
  } catch (_) {}
  writeFileSync(logPath, "");

  const gateSab = new Int32Array(new SharedArrayBuffer(4));
  const holdSab = new Int32Array(new SharedArrayBuffer(4));
  const threads = [];
  const results = [];
  const done = new Promise((resolve) => {
    let remaining = workers;
    for (let i = 0; i < workers; i++) {
      const w = new Worker(scriptPath, {
        workerData: {
          mode: "mutex",
          who: `t${i}`,
          mutexDir,
          logPath,
          holdMs,
          maxRetries,
          retryDelayMs,
          gateSab,
          holdSab,
        },
      });
      let settled = false;
      const settle = (r) => {
        if (!settled) {
          settled = true;
          results.push(r);
          remaining -= 1;
          if (remaining === 0) resolve();
        }
      };
      w.on("message", (m) => {
        settle(m);
        w.terminate();
      });
      w.on("error", (err) => settle({ who: `t${i}`, ok: false, errorName: err.name, error: err.message }));
      w.on("exit", () => settle({ who: `t${i}`, ok: false, errorName: "ThreadExit", error: "exited without result" }));
      threads.push(w);
    }
  });

  // Release all threads at the same instant — 220 simultaneous mkdirSync attempts.
  const cpu0 = process.cpuUsage();
  const t0 = Date.now();
  Atomics.store(gateSab, 0, 1);
  Atomics.notify(gateSab, 0, workers);
  await done;
  const wallMs = Date.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  const cpuMs = Math.round((cpu.user + cpu.system) / 1000);

  const logAnalysis = analyzeMutexLog(logPath);
  const ok = results.filter((r) => r.ok).length;
  const timeouts = results.filter((r) => r.isMutexTimeout).length;
  const other = results.length - ok - timeouts;

  return {
    workers,
    holdMs,
    maxRetries,
    retryDelayMs,
    ok,
    mutexTimeouts: timeouts,
    otherErrors: other,
    wallMs,
    cpuMs,
    enterExitEvents: logAnalysis.eventCount,
    mutualExclusionOverlaps: logAnalysis.overlaps,
  };
}

// ---------------------------------------------------------------------------
// Test F: deterministic probes
// ---------------------------------------------------------------------------

function probeFnEexistReexecution(mutexDir) {
  // withVfsMutex treats ANY err.code === "EEXIST" as lock contention, including
  // one thrown by fn itself — so fn is re-executed on every retry.
  const counterFile = join(mutexDir + "-counter.log");
  try {
    unlinkSync(counterFile);
  } catch (_) {}
  rmSync(mutexDir, { recursive: true, force: true });

  let calls = 0;
  let caughtName = null;
  try {
    withVfsMutex(
      mutexDir,
      () => {
        calls += 1;
        appendFileSync(counterFile, `call-${calls}\n`);
        const err = new Error("fn internal EEXIST (e.g. mkdirSync of an existing path)");
        err.code = "EEXIST";
        throw err;
      },
      { maxRetries: 5, retryDelayMs: 5 }
    );
  } catch (err) {
    caughtName = err.name;
  }
  const fileCalls = existsSync(counterFile) ? readFileSync(counterFile, "utf-8").split("\n").filter(Boolean).length : 0;
  rmSync(mutexDir, { recursive: true, force: true });
  try {
    unlinkSync(counterFile);
  } catch (_) {}
  return { calls, fileCalls, caughtName, reexecuted: fileCalls > 1 };
}

function probeStaleMutexWedge(mutexDir) {
  rmSync(mutexDir, { recursive: true, force: true });
  // 1) A crashed holder leaves the mutex dir behind.
  mkdirSync(mutexDir, { recursive: true });
  let firstError = null;
  let firstMs = 0;
  const t0 = Date.now();
  try {
    withVfsMutex(mutexDir, () => "never runs", {});
  } catch (err) {
    firstError = err.name;
    firstMs = Date.now() - t0;
  }
  const stillWedges = existsSync(mutexDir);
  let secondError = null;
  try {
    withVfsMutex(mutexDir, () => "never runs", { maxRetries: 3, retryDelayMs: 5 });
  } catch (err) {
    secondError = err.name;
  }

  // 2) A release that fails (ENOTEMPTY because something landed inside the
  //    mutex dir) is silently swallowed by rmdirSync's catch — also permanent.
  const wedgeDir = mutexDir + "-enotempty";
  rmSync(wedgeDir, { recursive: true, force: true });
  let thirdError = null;
  let ran = false;
  try {
    withVfsMutex(
      wedgeDir,
      () => {
        ran = true;
        writeFileSync(join(wedgeDir, "immovable"), "x"); // poisons the release
      },
      { maxRetries: 5, retryDelayMs: 5 }
    );
  } catch (err) {
    thirdError = err.name;
  }
  const wedgePersists = existsSync(wedgeDir);
  let fourthError = null;
  try {
    withVfsMutex(wedgeDir, () => "never runs", { maxRetries: 3, retryDelayMs: 5 });
  } catch (err) {
    fourthError = err.name;
  }
  rmSync(wedgeDir, { recursive: true, force: true });
  rmSync(mutexDir, { recursive: true, force: true });
  return { firstError, firstMs, stillWedges, secondError, ranFn: ran, thirdError, wedgePersists, fourthError };
}

async function probeUnconditionalRelease({ mutexDir, logPath }) {
  // Demonstrates that withVfsMutex's finally { rmdirSync(mutexDir) } has no
  // ownership token: whatever occupies the dir at release time is removed.
  // Scenario (the documented recovery for a wedged mutex is to delete the dir):
  //   A enters, holds briefly.  Operator/reaper deletes mutexDir (F4 recovery).
  //   B acquires and enters while A is still inside  -> overlap #1.
  //   A releases: its unconditional rmdir removes B's mutex dir.
  //   C acquires and enters while B is still inside  -> overlap #2.
  rmSync(mutexDir, { recursive: true, force: true });
  try {
    unlinkSync(logPath);
  } catch (_) {}
  writeFileSync(logPath, "");

  function runActor(who, holdMs) {
    const g = new Int32Array(new SharedArrayBuffer(4));
    Atomics.store(g, 0, 1); // gate pre-released: sequencing is done by the parent
    const h = new Int32Array(new SharedArrayBuffer(4));
    return new Promise((resolve, reject) => {
      const w = new Worker(scriptPath, {
        workerData: {
          mode: "mutex",
          who,
          mutexDir,
          logPath,
          holdMs,
          maxRetries: 400,
          retryDelayMs: 5,
          gateSab: g,
          holdSab: h,
        },
      });
      w.on("message", (m) => {
        resolve(m);
        w.terminate();
      });
      w.on("error", reject);
      w.on("exit", () => resolve({ who, ok: false, errorName: "ThreadExit" }));
    });
  }

  function logHas(who, kind) {
    try {
      return readFileSync(logPath, "utf-8").split("\n").some((l) => l.startsWith(`${kind} ${who} `));
    } catch (_) {
      return false;
    }
  }

  // Actor A: short hold. It must still be inside when B enters, and must exit
  // (and unconditionally rmdir) while B is still inside.
  const aPromise = runActor("A", 300);
  const t0 = Date.now();
  while (!logHas("A", "ENTER") && Date.now() - t0 < 5000) await sleep(10);
  if (!logHas("A", "ENTER")) return { error: "actor A never entered" };

  // Simulate stale-mutex recovery: delete the dir while A is inside.
  rmSync(mutexDir, { recursive: true, force: true });

  // Actor B enters while A is inside -> overlap #1. Long hold.
  const bPromise = runActor("B", 4000);
  const t1 = Date.now();
  while (!logHas("B", "ENTER") && Date.now() - t1 < 5000) await sleep(10);
  const bEnteredWhileAInside = logHas("A", "ENTER") && !logHas("A", "EXIT");

  // Wait for A to exit; A's finally-rmdir removes B's mutex dir.
  const a = await aPromise;
  const t2 = Date.now();
  while (!logHas("A", "EXIT") && Date.now() - t2 < 6000) await sleep(10);
  await sleep(50); // give A's finally-rmdir a beat

  // Actor C should now be able to acquire while B is still inside -> overlap #2.
  const cPromise = runActor("C", 500);
  const t3 = Date.now();
  while (!logHas("C", "ENTER") && Date.now() - t3 < 5000) await sleep(10);
  const cEnteredWhileBInside = logHas("B", "ENTER") && !logHas("B", "EXIT");

  const [b, c] = await Promise.all([bPromise, cPromise]);
  const analysis = analyzeMutexLog(logPath);
  rmSync(mutexDir, { recursive: true, force: true });

  return {
    a,
    b,
    c,
    bEnteredWhileAInside,
    cEnteredWhileBInside,
    overlaps: analysis.overlaps,
  };
}

function probeReentrantDeadlock(mutexDir) {
  rmSync(mutexDir, { recursive: true, force: true });
  let innerRan = false;
  let caughtName = null;
  let caughtMessage = null;
  const t0 = Date.now();
  try {
    withVfsMutex(
      mutexDir,
      () =>
        withVfsMutex(
          mutexDir,
          () => {
            innerRan = true;
            return "inner";
          },
          { maxRetries: 5, retryDelayMs: 5 }
        ),
      { maxRetries: 5, retryDelayMs: 5 }
    );
  } catch (err) {
    caughtName = err.name;
    caughtMessage = err.message;
  }
  const elapsedMs = Date.now() - t0;
  rmSync(mutexDir, { recursive: true, force: true });
  return { innerRan, caughtName, caughtMessage, elapsedMs };
}

function probeEntryHashCollision(root) {
  // appendLedger merges the caller's entry into the chain payload. An entry
  // that carries its own `hash` field poisons the hashed payload but is then
  // overwritten in the stored record — the entry can never verify again.
  const probeRoot = join(root, "schema-probe");
  mkdirSync(probeRoot, { recursive: true });
  const payload = appendLedger({ event: "schema_collision", hash: "deadbeef", note: "caller-supplied hash" }, probeRoot);
  const filePath = getDailyLedgerPath(probeRoot);
  const verification = verifyLedgerIntegrity(filePath);
  const entries = readLedger(filePath);
  rmSync(probeRoot, { recursive: true, force: true });
  return {
    returnedHash: payload.hash,
    verification,
    entryCount: entries.length,
    broken: verification.ok === false,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  log("VFS Mutex TOCTOU Race Audit");
  log(`repo root : ${repoRoot}`);
  log(`node      : ${process.version}`);
  log(`pid       : ${process.pid}`);
  const t0 = Date.now();

  const tmpRoot = mkTempRoot("run");
  const lockRoot = join(tmpRoot, "locks");
  const ledgerRoot = join(tmpRoot, "ledger");
  const mutexRoot = join(tmpRoot, "mutex");
  mkdirSync(lockRoot, { recursive: true });
  mkdirSync(ledgerRoot, { recursive: true });
  mkdirSync(mutexRoot, { recursive: true });

  let lockKids = null;
  let ledgerKids = null;

  try {
    // ---------------- Test A: same taskId, small records ----------------
    section(`TEST A — ${LOCK_WORKERS} children × ${ROUNDS_SMALL} rounds acquireLock() same taskId (small records)`);
    lockKids = makePool(LOCK_WORKERS, "lock");
    await collectResults(lockKids, 15000, "ready"); // consume boot ready messages
    const smallSpec = { count: 3, size: 64, prefix: "src/mod" };
    const resA = await runLockRace({
      label: "A-small",
      root: lockRoot,
      kids: lockKids,
      rounds: ROUNDS_SMALL,
      filesSpec: smallSpec,
      taskId: "toctou-task-0",
    });
    log(`  rounds                 : ${resA.rounds}`);
    log(`  double-grant rounds    : ${resA.doubleGrantRounds}`);
    log(`  max {ok:true} in a round: ${resA.maxOkInRound}`);
    log(`  thrown errors          : ${resA.totalThrown}`);
    SUMMARY.tests.push({ name: "A-same-taskId-small", ...resA });
    SUMMARY.doubleGrants.small = resA.doubleGrantRounds;
    SUMMARY.doubleGrants.totalRounds += resA.rounds;

    // ---------------- Test B: same taskId, large records ----------------
    section(`TEST B — publish-window observation + ${ROUNDS_LARGE} rounds with ~3MB lock records`);
    const windowObs = await observePublishWindow(lockRoot, lockKids[0]);
    log(`  poll observations: notExists=${windowObs.pollsNotExists} empty=${windowObs.pollsEmpty} partialInvalidJson=${windowObs.pollsPartialInvalid} validJson=${windowObs.pollsValid}`);
    log(`  max record bytes seen during publish: ${windowObs.maxBytes}`);
    log(`  probe child ok: ${windowObs.childOk}`);

    const largeSpec = { count: 3000, size: 1024, prefix: "probe/file" };
    const resB = await runLockRace({
      label: "B-large",
      root: lockRoot,
      kids: lockKids,
      rounds: ROUNDS_LARGE,
      filesSpec: largeSpec,
      taskId: "toctou-task-1",
    });
    log(`  rounds                 : ${resB.rounds}`);
    log(`  double-grant rounds    : ${resB.doubleGrantRounds}`);
    log(`  max {ok:true} in a round: ${resB.maxOkInRound}`);
    SUMMARY.tests.push({ name: "B-same-taskId-large", windowObs, ...resB });
    SUMMARY.doubleGrants.large = resB.doubleGrantRounds;
    SUMMARY.doubleGrants.totalRounds += resB.rounds;

    // ---------------- Test C: cross-task file overlap ----------------
    section(`TEST C — ${LOCK_WORKERS} children, distinct taskIds, same files (${ROUNDS_OVERLAP} rounds)`);
    const resC = await runCrossTaskOverlap({
      root: lockRoot,
      kids: lockKids,
      rounds: ROUNDS_OVERLAP,
      filesSpec: { count: 2, size: 32, prefix: "shared/file" },
    });
    log(`  rounds                     : ${resC.rounds}`);
    log(`  exclusivity-violation rounds: ${resC.violationRounds}`);
    log(`  max {ok:true} in a round   : ${resC.maxOkInRound}`);
    SUMMARY.tests.push({ name: "C-cross-task-overlap", ...resC });
    SUMMARY.doubleGrants.crossTask = resC.violationRounds;
    SUMMARY.doubleGrants.totalRounds += resC.rounds;

    broadcast(lockKids, { cmd: "exit" });
    await sleep(300);
    killPool(lockKids);
    lockKids = null;

    // ---------------- Test D: appendLedger hash chain ----------------
    section(`TEST D — ${LEDGER_WORKERS} children × ${ROUNDS_LEDGER} rounds appendLedger() → hash-chain validation`);
    ledgerKids = makePool(LEDGER_WORKERS, "ledger");
    await collectResults(ledgerKids, 15000, "ready"); // consume boot ready messages
    const resD = await runLedgerRace({ root: ledgerRoot, kids: ledgerKids, rounds: ROUNDS_LEDGER });
    const ledgerPath = getDailyLedgerPath(ledgerRoot);
    const integrity = verifyLedgerIntegrity(ledgerPath);
    const chain = analyzeChain(ledgerPath);
    log(`  appends ok / mutex-timeouts / other errors: ${resD.success} / ${resD.mutexTimeouts} / ${resD.otherErrors}`);
    log(`  verifyLedgerIntegrity     : ${JSON.stringify(integrity)}`);
    log(`  independent chain walk    : ${JSON.stringify(chain)}`);
    const chainBroken =
      integrity.ok !== true || chain.torn > 0 || chain.broken > 0 || chain.forks > 0 || chain.badHash > 0 || chain.missing > 0;
    if (chainBroken) SUMMARY.corruptedChains += 1;
    log(`  hash chain intact         : ${!chainBroken}`);
    SUMMARY.tests.push({ name: "D-appendLedger-chain", ...resD, integrity, chain, chainIntact: !chainBroken });

    broadcast(ledgerKids, { cmd: "exit" });
    await sleep(300);
    killPool(ledgerKids);
    ledgerKids = null;

    // ---------------- Test E: withVfsMutex contention ----------------
    section(`TEST E — ${MUTEX_WORKERS} worker_threads hammer withVfsMutex() (mkdirSync spin-wait)`);
    const mutexDir = join(mutexRoot, ".budget.mutex");
    const logPath = join(mutexRoot, "cs.log");
    const wave1 = await runMutexContention({
      mutexDir,
      logPath,
      holdMs: 2,
      maxRetries: 200,
      retryDelayMs: 10,
      workers: MUTEX_WORKERS,
    });
    log(`  wave 1 (default opts, short hold 2ms)`);
    log(`   ok / mutex-timeouts / other : ${wave1.ok} / ${wave1.mutexTimeouts} / ${wave1.otherErrors}`);
    log(`   wall / cpu time             : ${wave1.wallMs} ms / ${wave1.cpuMs} ms`);
    log(`   critical-section enter/exit events logged: ${wave1.enterExitEvents}`);
    log(`   mutual-exclusion overlaps   : ${wave1.mutualExclusionOverlaps.length}`);
    SUMMARY.tests.push({ name: "E1-mutex-contention-short-hold", ...wave1 });

    // A hold of 25ms stands in for the fsync-heavy critical section of
    // appendLedger(): 220 queued holders × 25ms ≈ 5.5s of queue drain against a
    // nominal 2s spin budget.
    const wave2 = await runMutexContention({
      mutexDir,
      logPath,
      holdMs: 25,
      maxRetries: 200,
      retryDelayMs: 10,
      workers: MUTEX_WORKERS,
    });
    log(`  wave 2 (default opts, fsync-class hold 25ms)`);
    log(`   ok / mutex-timeouts / other : ${wave2.ok} / ${wave2.mutexTimeouts} / ${wave2.otherErrors}`);
    log(`   wall / cpu time             : ${wave2.wallMs} ms / ${wave2.cpuMs} ms`);
    log(`   critical-section enter/exit events logged: ${wave2.enterExitEvents}`);
    log(`   mutual-exclusion overlaps   : ${wave2.mutualExclusionOverlaps.length}`);
    SUMMARY.tests.push({ name: "E2-mutex-contention-fsync-hold", ...wave2 });

    // 100ms holds × 220 contenders ≈ 22s of queue drain — beyond even the
    // CPU-starvation-stretched spin budget. Expect partial collapse.
    const wave3 = await runMutexContention({
      mutexDir,
      logPath,
      holdMs: 100,
      maxRetries: 200,
      retryDelayMs: 10,
      workers: MUTEX_WORKERS,
    });
    log(`  wave 3 (default opts, heavy hold 100ms)`);
    log(`   ok / mutex-timeouts / other : ${wave3.ok} / ${wave3.mutexTimeouts} / ${wave3.otherErrors}`);
    log(`   wall / cpu time             : ${wave3.wallMs} ms / ${wave3.cpuMs} ms`);
    log(`   critical-section enter/exit events logged: ${wave3.enterExitEvents}`);
    log(`   mutual-exclusion overlaps   : ${wave3.mutualExclusionOverlaps.length}`);
    SUMMARY.tests.push({ name: "E3-mutex-contention-heavy-hold", ...wave3 });

    let wave4 = null;
    if (wave3.mutexTimeouts > 0) {
      // Same load with a generous budget: everyone eventually enters; the
      // critical section must still show zero mutual-exclusion overlaps.
      wave4 = await runMutexContention({
        mutexDir,
        logPath,
        holdMs: 100,
        maxRetries: 20000,
        retryDelayMs: 5,
        workers: MUTEX_WORKERS,
      });
      log(`  wave 4 (generous opts: maxRetries=20000, retryDelayMs=5, hold 100ms)`);
      log(`   ok / mutex-timeouts / other : ${wave4.ok} / ${wave4.mutexTimeouts} / ${wave4.otherErrors}`);
      log(`   wall / cpu time             : ${wave4.wallMs} ms / ${wave4.cpuMs} ms`);
      log(`   critical-section enter/exit events logged: ${wave4.enterExitEvents}`);
      log(`   mutual-exclusion overlaps   : ${wave4.mutualExclusionOverlaps.length}`);
      SUMMARY.tests.push({ name: "E4-mutex-contention-generous", ...wave4 });
    }

    // ---------------- Test F: deterministic probes ----------------
    section("TEST F — deterministic TOCTOU / correctness probes");

    const f1 = probeFnEexistReexecution(join(mutexRoot, "probe-fn-eexist"));
    log(`  F1 fn-throws-EEXIST re-execution: fn ran ${f1.fileCalls}× (calls=${f1.calls}, caught=${f1.caughtName}) → reexecuted=${f1.reexecuted}`);
    SUMMARY.tests.push({ name: "F1-fn-EEXIST-reexecution", ...f1 });

    const f2 = probeStaleMutexWedge(join(mutexRoot, "probe-stale"));
    log(`  F2 stale mutex wedge: firstError=${f2.firstError} after ${f2.firstMs}ms, dir persists=${f2.stillWedges}, ENOTEMPTY release swallowed → wedge persists=${f2.wedgePersists}`);
    SUMMARY.tests.push({ name: "F2-stale-mutex-wedge", ...f2 });

    const f3 = await probeUnconditionalRelease({
      mutexDir: join(mutexRoot, "probe-uncond"),
      logPath: join(mutexRoot, "probe-uncond.log"),
    });
    log(`  F3 unconditional release: B entered while A inside=${f3.bEnteredWhileAInside}, C entered while B inside=${f3.cEnteredWhileBInside}, overlaps=${f3.overlaps.length}`);
    SUMMARY.tests.push({ name: "F3-unconditional-release", ...f3 });

    const f4 = probeReentrantDeadlock(join(mutexRoot, "probe-reentrant"));
    log(`  F4 re-entrant self-deadlock: innerRan=${f4.innerRan}, caught=${f4.caughtName} (${f4.elapsedMs}ms)`);
    SUMMARY.tests.push({ name: "F4-reentrant-deadlock", ...f4 });

    const f5 = probeEntryHashCollision(join(tmpRoot, "schema"));
    log(`  F5 entry.hash collision: verifyLedgerIntegrity ok=${f5.verification.ok} error=${f5.verification.error} → broken=${f5.broken}`);
    SUMMARY.tests.push({ name: "F5-entry-hash-collision", ...f5 });

    // ---------------- Findings roll-up ----------------
    recordFinding({
      id: "F1",
      title: "acquireLock() publishes the lock record non-atomically; racers unlink the in-flight record and both win",
      severity: "high",
      reproduced: resA.doubleGrantRounds > 0 || resB.doubleGrantRounds > 0,
      evidence:
        `Test A double-grant rounds: ${resA.doubleGrantRounds}/${resA.rounds} (max ok/round ${resA.maxOkInRound}); ` +
        `Test B double-grant rounds: ${resB.doubleGrantRounds}/${resB.rounds} (max ok/round ${resB.maxOkInRound}); ` +
        `publish-window polls: empty=${windowObs.pollsEmpty} partialInvalidJson=${windowObs.pollsPartialInvalid}`,
    });
    recordFinding({
      id: "F2",
      title: "Cross-task file exclusivity is check-then-act (lockStatus scan then create); overlapping file sets are granted concurrently",
      severity: "high",
      reproduced: resC.violationRounds > 0,
      evidence: `Test C violation rounds: ${resC.violationRounds}/${resC.rounds} (max ok/round ${resC.maxOkInRound})`,
    });
    recordFinding({
      id: "F3",
      title: "withVfsMutex re-executes fn when fn throws err.code === 'EEXIST' (indistinguishable from mkdir contention)",
      severity: "medium",
      reproduced: f1.reexecuted,
      evidence: `fn executed ${f1.fileCalls}× in one withVfsMutex call (maxRetries=5)`,
    });
    recordFinding({
      id: "F4",
      title: "Stale mutex dir wedges forever: no liveness/reaper, and failed releases (ENOTEMPTY) are silently swallowed",
      severity: "medium",
      reproduced: f2.stillWedges && f2.wedgePersists,
      evidence: `default call timed out (${f2.firstError}, ${f2.firstMs}ms) with dir persisting=${f2.stillWedges}; swallowed rmdirSync failure → permanent wedge=${f2.wedgePersists}`,
    });
    recordFinding({
      id: "F5",
      title: "withVfsMutex release is unconditional rmdirSync (no ownership token); external cleanup breaks mutual exclusion",
      severity: "medium",
      reproduced: f3.bEnteredWhileAInside === true && f3.cEnteredWhileBInside === true,
      evidence: `overlaps observed: ${f3.overlaps.length} (B-in-while-A=${f3.bEnteredWhileAInside}, C-in-while-B=${f3.cEnteredWhileBInside})`,
    });
    recordFinding({
      id: "F6",
      title: "Fixed spin budget (maxRetries×retryDelayMs = 2s) and CPU-burning busy-wait collapse under contention",
      severity: "medium",
      reproduced: wave3.mutexTimeouts > 0,
      evidence:
        `Test E wave 3 (100ms holds, 220 contenders, default opts): ${wave3.mutexTimeouts}/${wave3.workers} MutexTimeoutError ` +
        `in ${wave3.wallMs}ms wall (${wave3.cpuMs}ms CPU burned spinning); wave 2 (25ms holds): ${wave2.mutexTimeouts} timeouts; ` +
        `total exclusion overlaps across waves: ` +
        `${wave1.mutualExclusionOverlaps.length + wave2.mutualExclusionOverlaps.length + wave3.mutualExclusionOverlaps.length}`,
    });
    recordFinding({
      id: "F7",
      title: "Re-entrant withVfsMutex on the same dir self-deadlocks and throws MutexTimeoutError",
      severity: "low",
      reproduced: f4.innerRan === false && f4.caughtName === "MutexTimeoutError",
      evidence: `inner fn ran=${f4.innerRan}; caught=${f4.caughtName} after ${f4.elapsedMs}ms`,
    });
    recordFinding({
      id: "F8",
      title: "appendLedger() symlink guard is TOCTOU (existsSync+lstatSync then openSync without O_NOFOLLOW)",
      severity: "low",
      reproduced: false,
      evidence: "analytical: src/state.mjs lines 289-293 — check and open are separate syscalls; window not dynamically hit",
    });
    recordFinding({
      id: "F9",
      title: "lockStatus() silently drops unreadable lock records, hiding live holders from the overlap check",
      severity: "low",
      reproduced: windowObs.pollsPartialInvalid > 0,
      evidence: `partial/invalid lock records observed during publish: ${windowObs.pollsPartialInvalid} polls (src/state.mjs line 779 catch (_))`,
    });
    recordFinding({
      id: "F10",
      title: "Caller-supplied entry.hash poisons the chain payload and invalidates the entry's own verification",
      severity: "informational",
      reproduced: f5.broken,
      evidence: `appendLedger({hash:"deadbeef"}) → verifyLedgerIntegrity ${f5.verification.error}`,
    });

    // ---------------- Summary ----------------
    section("AUDIT SUMMARY");
    log(JSON.stringify(SUMMARY, null, 2));
    log("");
    log(`total runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    log("audit complete");
  } finally {
    if (lockKids) killPool(lockKids);
    if (ledgerKids) killPool(ledgerKids);
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Entry dispatch
// ---------------------------------------------------------------------------

if (!isMainThread && workerData && workerData.mode === "mutex") {
  mutexThreadMain();
} else {
  const mode = process.argv[2] || "";
  if (mode === "--worker=lock") {
    lockWorkerMain();
  } else if (mode === "--worker=ledger") {
    ledgerWorkerMain();
  } else {
    main().then(
      () => {
        process.exitCode = 0;
      },
      (err) => {
        console.error("HARNESS ERROR:", err);
        process.exitCode = 1;
      }
    );
  }
}
