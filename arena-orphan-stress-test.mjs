#!/usr/bin/env node
/**
 * Process-tree orphan audit for scripts/run-tests.mjs.
 *
 * Standalone Node 20+ ESM, zero dependencies. Nothing in the repository is
 * modified: the runner is executed unchanged, from a throw-away working
 * directory whose test/ folder holds a single wrapper that imports
 * arena-mock-test-hang.mjs. (run-tests.mjs discovers tests from
 * `<cwd>/test/*.test.mjs`, so the cwd is how it is "pointed at" the mock.)
 *
 * For every scenario:
 *   1. start `node scripts/run-tests.mjs` (new process group, like CI does),
 *   2. once the mock tree is up and >= 2s have passed, send the signal to the
 *      runner's pid,
 *   3. sample the tree while it unwinds, wait 10s in total, then look for
 *      survivors via /proc (falls back to `ps` where /proc is missing),
 *   4. check the exit code, that grandchildren sit in the `-child.pid`
 *      process group, and that nothing tagged with this run is still alive,
 *   5. fail-safe: SIGKILL anything left and delete the temp directory.
 *
 * Scenarios marked "documented" describe limitations (uncatchable signals,
 * a grandchild that called setsid). They are reported but never fail the run.
 *
 * Usage:
 *   node arena-orphan-stress-test.mjs [--sequential] [--only=<substring>]
 *        [--signal-after-ms=2000] [--wait-ms=10000] [--report=<file.md>]
 *
 * Exit code: 0 when every "must be clean" scenario is clean, 1 otherwise.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "scripts", "run-tests.mjs");
const MOCK = join(HERE, "arena-mock-test-hang.mjs");

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const SEQUENTIAL = args.includes("--sequential");
const ONLY = opt("only", "");
const SIGNAL_AFTER_MS = Number(opt("signal-after-ms", 2000));
const WAIT_MS = Number(opt("wait-ms", 10_000));
const REPORT = opt("report", "");
const POLL_MS = 50;
const EXPECTED_WORKERS = 3;
// run-tests.mjs escalates to SIGKILL 2s after the first signal; allow slack.
const EXIT_DEADLINE_MS = 2000 + 3000;

// ---------------------------------------------------------------- scenarios
const SCENARIOS = [
  { name: "SIGTERM / baseline", signal: "SIGTERM", mode: "baseline", kind: "handled", expect: "clean" },
  { name: "SIGINT / baseline", signal: "SIGINT", mode: "baseline", kind: "handled", expect: "clean" },
  { name: "SIGHUP / baseline", signal: "SIGHUP", mode: "baseline", kind: "handled", expect: "clean" },
  { name: "SIGTERM / reparented worker", signal: "SIGTERM", mode: "reparented", kind: "handled", expect: "clean" },
  { name: "SIGTERM / setsid escapee", signal: "SIGTERM", mode: "escape", kind: "handled", expect: "escapee" },
  { name: "SIGINT / setsid escapee", signal: "SIGINT", mode: "escape", kind: "handled", expect: "escapee" },
  { name: "SIGHUP / setsid escapee", signal: "SIGHUP", mode: "escape", kind: "handled", expect: "escapee" },
  { name: "SIGQUIT / baseline (unhandled)", signal: "SIGQUIT", mode: "baseline", kind: "unhandled", expect: "all" },
  { name: "SIGKILL / baseline (uncatchable)", signal: "SIGKILL", mode: "baseline", kind: "unhandled", expect: "all" },
].filter((s) => s.name.toLowerCase().includes(ONLY.toLowerCase()));

// ------------------------------------------------------------ fail-safe state
const activeRuns = new Map(); // runId -> { tracked:Set<number>, dir }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (p) => p.state !== "Z" && p.state !== "X";

// -------------------------------------------------------- process inspection
const HAVE_PROC = existsSync("/proc/self/stat");
const envVerdict = new Map(); // pid -> boolean (cached once environ was readable)

function listProcs() {
  return HAVE_PROC ? listProcsFromProc() : listProcsFromPs();
}

function listProcsFromProc() {
  const out = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const f = stat.slice(close + 2).split(" ");
      let cmd = "";
      try { cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim(); } catch { /* gone */ }
      out.push({ pid, state: f[0], ppid: Number(f[1]), pgid: Number(f[2]), sid: Number(f[3]), cmd });
    } catch { /* exited while listing */ }
  }
  return out;
}

function listProcsFromPs() {
  const ret = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,command="], { encoding: "utf8" });
  const out = [];
  for (const line of (ret.stdout || "").split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (m) out.push({ pid: +m[1], ppid: +m[2], pgid: +m[3], sid: 0, state: m[4][0], cmd: m[5] });
  }
  return out;
}

function carriesMarker(proc, runId) {
  if (proc.cmd.includes(`--arena-run=${runId}`) || proc.cmd.includes(`arena-orphan-${runId}`)) return true;
  if (!HAVE_PROC) return false;
  if (envVerdict.has(proc.pid)) return envVerdict.get(proc.pid);
  try {
    const env = readFileSync(`/proc/${proc.pid}/environ`, "utf8");
    if (!env) return false; // kernel thread or not yet exec'd: look again next time
    const hit = env.includes(`ARENA_ORPHAN_RUN=${runId}\0`);
    envVerdict.set(proc.pid, hit);
    return hit;
  } catch {
    return false;
  }
}

/**
 * Every process that belongs to `runId`: anything tagged with the run marker
 * (argv or environment, which survives setsid and re-parenting), anything
 * descended from a member in this snapshot, and anything seen earlier.
 */
function membersOf(runId, procs = listProcs()) {
  const state = activeRuns.get(runId);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const members = new Set();
  for (const p of procs) {
    if (p.pid === process.pid) continue;
    if (state.tracked.has(p.pid) || carriesMarker(p, runId)) members.add(p.pid);
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const p of procs) {
      if (p.pid !== process.pid && !members.has(p.pid) && members.has(p.ppid)) {
        members.add(p.pid);
        grew = true;
      }
    }
  }
  for (const pid of members) state.tracked.add(pid);
  return [...members].map((pid) => byPid.get(pid)).filter(Boolean);
}

function roleOf(p, runnerPid) {
  if (p.cmd.includes("--arena-role=worker")) return "grandchild worker";
  if (p.cmd.includes("--arena-role=escapee")) return "grandchild worker (setsid escapee)";
  if (p.cmd.includes("--arena-role=reparented")) return "grandchild worker (re-parented)";
  if (p.cmd.includes("--arena-role=intermediate")) return "intermediate (exits at once)";
  if (p.pid === runnerPid) return "run-tests.mjs runner";
  if (p.ppid === runnerPid) return "node --test (child, pgid leader)";
  if (p.cmd.includes("hang.test.mjs")) return "test-file process (mock)";
  return "other";
}

/** Fail-safe: SIGKILL every member and every group one of them leads. */
function killRun(runId) {
  const state = activeRuns.get(runId);
  if (!state) return;
  for (let round = 0; round < 4; round++) {
    const live = membersOf(runId).filter(isAlive);
    if (!live.length) return;
    for (const p of live) {
      if (p.pgid === p.pid && p.pid > 1) { try { process.kill(-p.pid, "SIGKILL"); } catch { /* gone */ } }
      try { process.kill(p.pid, "SIGKILL"); } catch { /* gone */ }
    }
    spawnSync("sleep", ["0.1"]);
  }
}

function killEverything() {
  for (const runId of activeRuns.keys()) killRun(runId);
}

process.on("exit", killEverything);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    console.error(`\n${sig} received: fail-safe cleanup of spawned processes`);
    killEverything();
    process.exit(130);
  });
}
process.on("uncaughtException", (err) => {
  console.error(err);
  killEverything();
  process.exit(1);
});

// ------------------------------------------------------------ one scenario
async function runScenario(sc) {
  const runId = randomBytes(4).toString("hex");
  const dir = mkdtempSync(join(tmpdir(), `arena-orphan-${runId}-`));
  activeRuns.set(runId, { tracked: new Set(), dir });
  const res = {
    sc, runId, problems: [], trace: [], exit: null, signalSentAtMs: null,
    leaderPid: null, runnerPid: null, expectedWorkers: EXPECTED_WORKERS + (sc.mode === "baseline" ? 0 : 1),
  };

  try {
    mkdirSync(join(dir, "test"));
    writeFileSync(
      join(dir, "test", "hang.test.mjs"),
      `await import(${JSON.stringify(pathToFileURL(MOCK).href)});\n`,
    );

    const env = { ...process.env, ARENA_ORPHAN_RUN: runId, ARENA_MOCK_MODE: sc.mode, JULES_TEST_CONCURRENCY: "1" };
    delete env.NODE_TEST_CONTEXT;
    const t0 = Date.now();
    const runner = spawn(process.execPath, [RUNNER], {
      cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    res.runnerPid = runner.pid;
    activeRuns.get(runId).tracked.add(runner.pid);
    let output = "";
    runner.stdout.on("data", (d) => { output += d; });
    runner.stderr.on("data", (d) => { output += d; });
    const exited = new Promise((resolve) => {
      runner.on("exit", (code, signal) => {
        res.exit = { code, signal, atMs: Date.now() - (res.signalSentAtMs === null ? t0 : res.signalSentAtMs + t0) };
        resolve();
      });
    });
    runner.on("error", (err) => res.problems.push(`runner failed to start: ${err.message}`));

    // 1) wait until the mock tree is up, but never signal earlier than the requested delay
    await sleep(SIGNAL_AFTER_MS);
    const readyDeadline = Date.now() + 10_000;
    let pre;
    for (;;) {
      pre = membersOf(runId);
      const workers = pre.filter((p) => /--arena-role=(worker|escapee|reparented)/.test(p.cmd) && isAlive(p));
      if (workers.length >= res.expectedWorkers || Date.now() > readyDeadline) break;
      await sleep(100);
    }

    // 2) snapshot before the signal
    const before = new Map();
    for (const p of pre) {
      before.set(p.pid, {
        pid: p.pid, role: roleOf(p, runner.pid), ppid0: p.ppid, pgid0: p.pgid, sid0: p.sid,
        ppidNow: p.ppid, pgidNow: p.pgid, state: p.state, diedAtMs: null, zombie: false,
      });
    }
    const leader = pre.find((p) => p.ppid === runner.pid);
    res.leaderPid = leader ? leader.pid : null;
    const workersBefore = pre.filter((p) => /--arena-role=(worker|escapee|reparented)/.test(p.cmd));
    if (workersBefore.length < res.expectedWorkers) {
      res.problems.push(`mock tree incomplete before signal: ${workersBefore.length}/${res.expectedWorkers} workers`);
    }

    // 3) send the signal to the runner only (what CI cancellation / a harness does)
    const tSig = Date.now();
    res.signalSentAtMs = tSig - t0;
    try { process.kill(runner.pid, sc.signal); } catch (err) { res.problems.push(`kill(${sc.signal}) failed: ${err.message}`); }

    // 4) sample while it unwinds; the last sample at +WAIT_MS is the verdict
    let lastSeen = pre;
    for (;;) {
      const elapsed = Date.now() - tSig;
      lastSeen = membersOf(runId);
      const nowByPid = new Map(lastSeen.map((p) => [p.pid, p]));
      for (const rec of before.values()) {
        const p = nowByPid.get(rec.pid);
        if (p) { rec.ppidNow = p.ppid; rec.pgidNow = p.pgid; rec.state = p.state; }
        if (rec.diedAtMs === null && (!p || !isAlive(p))) {
          rec.diedAtMs = elapsed;
          rec.zombie = Boolean(p);
        }
      }
      for (const p of lastSeen) { // processes that appeared only after the signal
        if (!before.has(p.pid)) {
          before.set(p.pid, {
            pid: p.pid, role: roleOf(p, runner.pid), ppid0: p.ppid, pgid0: p.pgid, sid0: p.sid,
            ppidNow: p.ppid, pgidNow: p.pgid, state: p.state, diedAtMs: isAlive(p) ? null : elapsed,
            zombie: !isAlive(p), lateSpawn: true,
          });
        }
      }
      if (elapsed >= WAIT_MS) break;
      await sleep(Math.min(POLL_MS, WAIT_MS - elapsed));
    }
    await Promise.race([exited, sleep(100)]);

    res.trace = [...before.values()].sort((a, b) => a.pid - b.pid);
    res.survivors = res.trace.filter((r) => r.diedAtMs === null && r.pid !== runner.pid);
    res.output = output;

    evaluate(res);
  } catch (err) {
    res.problems.push(`harness error: ${err.stack || err}`);
  } finally {
    killRun(runId); // fail-safe: nothing we started may outlive the scenario
    try { process.kill(-res.runnerPid, "SIGKILL"); } catch { /* gone */ }
    const leftovers = membersOf(runId).filter(isAlive);
    if (leftovers.length) res.problems.push(`fail-safe could not kill: ${leftovers.map((p) => p.pid).join(", ")}`);
    rmSync(dir, { recursive: true, force: true });
    activeRuns.delete(runId);
  }
  return res;
}

function evaluate(res) {
  const { sc } = res;
  const workers = res.trace.filter((r) => /grandchild worker/.test(r.role) && !r.lateSpawn);
  const escapees = workers.filter((r) => r.role.includes("escapee"));
  const inGroup = workers.filter((r) => !r.role.includes("escapee"));
  const survivors = res.survivors;
  const survivorWorkers = survivors.filter((r) => /grandchild worker/.test(r.role));

  // (f) exit codes
  res.exitNote = "";
  if (!res.exit) {
    res.problems.push(`runner still running ${WAIT_MS}ms after ${sc.signal}`);
  } else if (sc.kind === "handled") {
    const { code, signal } = res.exit;
    if (signal !== null) res.problems.push(`runner died from ${signal} instead of handling ${sc.signal}`);
    else if (code === 0) res.problems.push(`runner exited 0 after ${sc.signal}`);
    if (res.exit.atMs > EXIT_DEADLINE_MS) res.problems.push(`runner took ${res.exit.atMs}ms to exit (limit ${EXIT_DEADLINE_MS}ms)`);
    if (code !== null && code !== 130) res.exitNote = `exit ${code}, not 130`;
  } else if (res.exit.signal !== sc.signal) {
    res.problems.push(`expected runner to die from ${sc.signal}, got code=${res.exit.code} signal=${res.exit.signal}`);
  }

  // (e) the -child.pid group reaches grandchildren
  if (sc.kind === "handled") {
    if (res.leaderPid === null) {
      res.problems.push("could not identify the runner's child (group leader)");
    } else {
      const leaderRec = res.trace.find((r) => r.pid === res.leaderPid);
      if (!leaderRec || leaderRec.pgid0 !== res.leaderPid) {
        res.problems.push(`runner's child ${res.leaderPid} is not a process-group leader`);
      }
      for (const w of inGroup) {
        if (w.pgid0 !== res.leaderPid) res.problems.push(`worker ${w.pid} has pgid ${w.pgid0}, not -${res.leaderPid}`);
      }
      for (const w of escapees) {
        if (w.pgid0 === res.leaderPid) res.problems.push(`escapee ${w.pid} unexpectedly still in group -${res.leaderPid}`);
      }
    }
  }

  // (c) orphan check
  res.escapeePids = escapees.map((e) => e.pid);
  if (sc.expect === "clean") {
    if (survivors.length) res.problems.push(`orphans survived: ${survivors.map((s) => s.pid).join(", ")}`);
  } else if (sc.expect === "escapee") {
    const extra = survivors.filter((s) => !escapees.some((e) => e.pid === s.pid));
    if (extra.length) res.problems.push(`unexpected survivors besides the escapee: ${extra.map((s) => s.pid).join(", ")}`);
    res.documented = escapees.length > 0 && survivors.some((s) => escapees.some((e) => e.pid === s.pid))
      ? "escapee survived as predicted"
      : "escapee did NOT survive (limitation no longer reproduces)";
  } else if (sc.expect === "all") {
    res.documented = survivorWorkers.length === workers.length
      ? "whole tree orphaned as predicted (runner could not run its handler)"
      : `only ${survivorWorkers.length}/${workers.length} workers survived`;
  }
}

// -------------------------------------- independent check of kill(-pid) itself
/**
 * Start a detached parent with three SIGTERM-ignoring children, then show that
 * kill(-parent.pid, SIGTERM) is ignored by them while kill(-parent.pid,
 * SIGKILL) removes every one, even after the group leader is already dead.
 */
async function groupKillProbe() {
  const runId = randomBytes(4).toString("hex");
  activeRuns.set(runId, { tracked: new Set(), dir: "" });
  const out = { problems: [], steps: [] };
  const kidSrc = "process.on('SIGTERM',()=>{});setTimeout(()=>{},30000)";
  const parentSrc = `
    const { spawn } = require('node:child_process');
    const pids = [];
    for (let i = 0; i < 3; i++) {
      pids.push(spawn(process.execPath, ['-e', ${JSON.stringify(kidSrc)}, '--', '--arena-run=${runId}'], { stdio: 'ignore' }).pid);
    }
    console.log(JSON.stringify(pids));
    setTimeout(() => {}, 30000);`;
  try {
    const parent = spawn(process.execPath, ["-e", parentSrc, "--", `--arena-run=${runId}`], {
      detached: true, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, ARENA_ORPHAN_RUN: runId },
    });
    let text = "";
    parent.stdout.on("data", (d) => { text += d; });
    const parentGone = new Promise((r) => parent.on("exit", r));
    for (let i = 0; i < 50 && !text.includes("]"); i++) await sleep(100);
    const kids = JSON.parse(text.trim() || "[]");
    await sleep(300);
    const state = (pid) => listProcs().find((p) => p.pid === pid);
    const aliveKids = () => kids.filter((k) => { const p = state(k); return p && isAlive(p); });
    const groupOk = kids.length === 3 && kids.every((k) => state(k)?.pgid === parent.pid);
    out.steps.push(`children ${kids.join(", ")} all in group -${parent.pid}: ${groupOk}`);
    if (!groupOk) out.problems.push("probe children are not in the parent's process group");

    process.kill(-parent.pid, "SIGTERM"); // leader dies (default action), kids ignore it
    await parentGone;
    await sleep(500);
    const afterTerm = aliveKids().length;
    out.steps.push(`kill(-${parent.pid}, SIGTERM): leader dead, ${afterTerm}/3 SIGTERM-ignoring children alive`);
    if (afterTerm !== 3) out.problems.push(`expected 3 children to ignore SIGTERM, ${afterTerm} alive`);

    process.kill(-parent.pid, "SIGKILL"); // group outlives its dead leader
    await sleep(500);
    const afterKill = aliveKids().length;
    out.steps.push(`kill(-${parent.pid}, SIGKILL): ${afterKill}/3 children alive`);
    if (afterKill !== 0) out.problems.push(`kill(-pid, SIGKILL) left ${afterKill} children alive`);
  } catch (err) {
    out.problems.push(`probe error: ${err.message}`);
  } finally {
    killRun(runId);
    activeRuns.delete(runId);
  }
  return out;
}

// ---------------------------------------------------------------- reporting
const fmtExit = (r) => (r.exit ? (r.exit.signal ? `signal ${r.exit.signal}` : `code ${r.exit.code}`) : "still running");
const verdict = (r) => {
  if (r.problems.length) return "FAIL";
  return r.sc.expect === "clean" ? "PASS" : "DOCUMENTED";
};
const pidList = (rows) => (rows.length ? rows.map((x) => x.pid).join(", ") : "-");

function markdown(results, probe) {
  const lines = [];
  lines.push(`Detection: ${HAVE_PROC ? "/proc" : "ps"} | signal sent ${SIGNAL_AFTER_MS}ms after start | wait ${WAIT_MS}ms | Node ${process.version} | ${process.platform}`, "");
  lines.push("### Matrix", "");
  lines.push("| Scenario | Signal | Runner exit | Exit after signal | Processes tracked | Survivors after wait | Survivor PIDs | Verdict |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    lines.push(
      `| ${r.sc.name} | ${r.sc.signal} | ${fmtExit(r)}${r.exitNote ? ` (${r.exitNote})` : ""} | ` +
      `${r.exit ? `${r.exit.atMs} ms` : "-"} | ${r.trace.length} | ${r.survivors.length} | ${pidList(r.survivors)} | ${verdict(r)} |`,
    );
  }
  lines.push("", "### PID traces", "");
  for (const r of results) {
    lines.push(`#### ${r.sc.name}`, "");
    lines.push(`Runner pid ${r.runnerPid}, runner's child (group leader) ${r.leaderPid}, signal sent at +${r.signalSentAtMs} ms after start.`, "");
    lines.push("| PID | Role | PPID before -> after | PGID | SID | Died after signal | Survived 10s |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const t of r.trace) {
      const died = t.diedAtMs === null ? "never" : `+${t.diedAtMs} ms${t.zombie ? " (zombie)" : ""}`;
      lines.push(
        `| ${t.pid} | ${t.role} | ${t.ppid0} -> ${t.ppidNow} | ${t.pgid0}${t.pgid0 === r.leaderPid ? " (= -child.pid)" : ""} | ${t.sid0} | ${died} | ${t.diedAtMs === null ? "YES" : "no"} |`,
      );
    }
    if (r.problems.length) lines.push("", ...r.problems.map((p) => `- PROBLEM: ${p}`));
    if (r.documented) lines.push("", `- ${r.documented}`);
    lines.push("");
  }
  lines.push("### kill(-pid) probe", "", ...probe.steps.map((s) => `- ${s}`), ...probe.problems.map((p) => `- PROBLEM: ${p}`), "");
  return lines.join("\n");
}

// --------------------------------------------------------------------- main
async function main() {
  for (const f of [RUNNER, MOCK]) {
    if (!existsSync(f)) { console.error(`missing ${f}`); return 1; }
  }
  if (process.platform === "win32") {
    console.log("SKIP: POSIX process groups are required; this audit does not run on Windows.");
    return 0;
  }
  console.log(`Orphan audit: ${SCENARIOS.length} scenario(s), ${SEQUENTIAL ? "sequential" : "parallel"}, ` +
    `signal at ${SIGNAL_AFTER_MS}ms, wait ${WAIT_MS}ms, detection via ${HAVE_PROC ? "/proc" : "ps"}`);

  const results = [];
  if (SEQUENTIAL) {
    for (const sc of SCENARIOS) results.push(await runScenario(sc));
  } else {
    results.push(...(await Promise.all(SCENARIOS.map(runScenario))));
  }
  const probe = await groupKillProbe();

  console.log("");
  for (const r of results) {
    const tag = verdict(r);
    console.log(
      `${tag.padEnd(10)} ${r.sc.name.padEnd(36)} exit=${fmtExit(r)}${r.exitNote ? ` (${r.exitNote})` : ""} ` +
      `tracked=${r.trace.length} survivors=[${pidList(r.survivors)}]`,
    );
    for (const p of r.problems) console.log(`           - ${p}`);
    if (r.documented) console.log(`           * ${r.documented}`);
    if (r.problems.length && r.output) console.log(`           runner output tail: ${r.output.trim().split("\n").slice(-5).join(" | ")}`);
  }
  console.log(`${probe.problems.length ? "FAIL      " : "PASS      "} kill(-pid) probe`);
  for (const s of probe.steps) console.log(`           ${s}`);
  for (const p of probe.problems) console.log(`           - ${p}`);

  if (REPORT) {
    writeFileSync(REPORT, markdown(results, probe));
    console.log(`\nMarkdown data written to ${REPORT}`);
  }

  const failed = results.filter((r) => r.problems.length).length + (probe.problems.length ? 1 : 0);
  console.log(`\n${failed ? `FAILED: ${failed} scenario(s) with problems` : "OK: no unexpected orphans, exit codes and groups as expected"}`);
  return failed ? 1 : 0;
}

process.exitCode = await main();
