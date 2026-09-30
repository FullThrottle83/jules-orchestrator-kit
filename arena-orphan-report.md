# Process-tree orphan audit: `scripts/run-tests.mjs`

Audit of whether the process reaper in `scripts/run-tests.mjs` terminates every descendant
(children and grandchildren) when the runner is signalled. Nothing in `src/`, `scripts/`, `bin/`,
`test/`, `.agent/`, `.github/` or `package*.json` was touched.

| File | Purpose |
|---|---|
| `arena-orphan-stress-test.mjs` | Standalone harness. Runs the scenarios below, checks for survivors, and cleans up after itself. |
| `arena-mock-test-hang.mjs` | Mock test that spawns three grandchildren, each ignoring SIGTERM for 5 s, then hangs. |
| `arena-orphan-report.md` | This report. |

## Summary

* **Handled signals (SIGINT, SIGHUP, SIGTERM) leave no orphans** when every grandchild stays in the
  process group that `run-tests.mjs` created. This includes a grandchild that was re-parented to
  init (its parent exited) but did not leave the group. `kill(-child.pid)` reaches all of them.
* **A grandchild that calls `setsid` (`spawn(..., { detached: true })`) escapes the group and survives**
  all three signals. `run-tests.mjs` has no way to find it once the group kill has been sent.
* **SIGKILL and SIGQUIT sent to the runner orphan the whole tree**, including `node --test` itself.
  The runner only installs handlers for SIGINT, SIGTERM and SIGHUP, and SIGKILL cannot be handled.
* **Exit code is `1`, not `130`, on every handled signal.** The `process.exit(130)` path is never reached here.
  See "Exit codes and the grace period".
* `npm test` passes (1650 tests, 0 failures). The audit file is not named `*.test.mjs`, so the runner does not pick it up.

## How the audit works

1. `run-tests.mjs` discovers tests from `<cwd>/test/*.test.mjs` and accepts no path arguments. To "point"
   it at the mock without editing it, the harness creates a temporary directory whose `test/hang.test.mjs`
   is a one-line wrapper importing `arena-mock-test-hang.mjs`, and runs `node scripts/run-tests.mjs` from there.
2. The runner is started in its own process group (as CI does). The harness waits until the mock tree is up
   and at least 2 s have passed, then sends the signal **to the runner's pid only**.
3. The tree is sampled every 50 ms. After 10 s in total it is checked via `/proc` (`ps` is the fallback where `/proc` is missing).
   Membership is decided by a run marker found in argv or the environment (`ARENA_ORPHAN_RUN`, which survives `setsid`
   and re-parenting), by descent from a member, or by having been seen earlier. The survivor check therefore does not depend on ppid.
4. Checks per scenario: (c) no survivors after 10 s, (e) every grandchild has `pgid == child.pid`, i.e. it sits in the `-child.pid`
   group that the reaper signals, (f) the runner exits on its own with a non-zero code in under 5 s.
5. A separate probe starts a detached parent with three SIGTERM-ignoring children and checks `kill(-pid, SIGTERM)` and `kill(-pid, SIGKILL)` directly.
6. Fail-safe: after each scenario, and from `exit`/SIGINT/SIGTERM/SIGHUP/uncaughtException handlers, every process carrying the run marker
   is SIGKILLed (with its group, if it leads one) and the temp directory is removed.

Process tree seen by the runner (baseline):

```
run-tests.mjs              pgid = own pid          (receives the signal)
└─ node --test             pgid = its own pid      (= child.pid, group leader, target of kill(-child.pid))
   └─ hang.test.mjs        same group
      ├─ worker            same group, ignores SIGTERM for 5 s
      ├─ worker
      └─ worker
```

Scenarios: `baseline` (3 workers), `reparented` (+1 worker whose parent exits at once), `escape` (+1 worker started with `detached: true`).
Scenarios marked DOCUMENTED describe known limits and never fail the harness; PASS means "must be clean, and was".

## Results

Run parameters: Detection via /proc | signal sent 2000ms after start | wait 10000ms | Node v22.22.3 | linux

## Matrix

| Scenario | Signal | Runner exit | Exit after signal | Processes tracked | Survivors after wait | Survivor PIDs | Verdict |
|---|---|---|---|---|---|---|---|
| SIGTERM / baseline | SIGTERM | code 1 (exit 1, not 130) | 17 ms | 6 | 0 | - | PASS |
| SIGINT / baseline | SIGINT | code 1 (exit 1, not 130) | 93 ms | 6 | 0 | - | PASS |
| SIGHUP / baseline | SIGHUP | code 1 (exit 1, not 130) | 81 ms | 6 | 0 | - | PASS |
| SIGTERM / reparented worker | SIGTERM | code 1 (exit 1, not 130) | 49 ms | 7 | 0 | - | PASS |
| SIGTERM / setsid escapee | SIGTERM | code 1 (exit 1, not 130) | 14 ms | 7 | 1 | 2829 | DOCUMENTED |
| SIGINT / setsid escapee | SIGINT | code 1 (exit 1, not 130) | 81 ms | 7 | 1 | 2907 | DOCUMENTED |
| SIGHUP / setsid escapee | SIGHUP | code 1 (exit 1, not 130) | 72 ms | 7 | 1 | 2762 | DOCUMENTED |
| SIGQUIT / baseline (unhandled) | SIGQUIT | signal SIGQUIT | 56 ms | 6 | 5 | 2669, 2740, 2929, 2940, 2943 | DOCUMENTED |
| SIGKILL / baseline (uncatchable) | SIGKILL | signal SIGKILL | 38 ms | 6 | 5 | 2642, 2690, 2812, 2823, 2828 | DOCUMENTED |

## PID traces

### SIGTERM / baseline

Runner pid 2551, runner's child (group leader) 2630, signal sent at +2023 ms after start.

| PID | Role | PPID before -> after | PGID | SID | Died after signal | Survived 10s |
|---|---|---|---|---|---|---|
| 2551 | run-tests.mjs runner | 2544 -> 2544 | 2551 | 2551 | +3 ms (zombie) | no |
| 2630 | node --test (child, pgid leader) | 2551 -> 2551 | 2630 (= -child.pid) | 2630 | +3 ms | no |
| 2689 | test-file process (mock) | 2630 -> 2630 | 2630 (= -child.pid) | 2630 | +3 ms | no |
| 2810 | grandchild worker | 2689 -> 2689 | 2630 (= -child.pid) | 2630 | +3 ms | no |
| 2813 | grandchild worker | 2689 -> 2689 | 2630 (= -child.pid) | 2630 | +3 ms | no |
| 2820 | grandchild worker | 2689 -> 2689 | 2630 (= -child.pid) | 2630 | +3 ms | no |

### SIGINT / baseline

Runner pid 2552, runner's child (group leader) 2632, signal sent at +2045 ms after start.

| PID | Role | PPID before -> after | PGID | SID | Died after signal | Survived 10s |
|---|---|---|---|---|---|---|
| 2552 | run-tests.mjs runner | 2544 -> 2544 | 2552 | 2552 | +166 ms | no |
| 2632 | node --test (child, pgid leader) | 2552 -> 2552 | 2632 (= -child.pid) | 2632 | +166 ms | no |
| 2691 | test-file process (mock) | 2632 -> 2632 | 2632 (= -child.pid) | 2632 | +0 ms (zombie) | no |
| 2818 | grandchild worker | 2691 -> 2691 | 2632 (= -child.pid) | 2632 | +166 ms | no |
| 2824 | grandchild worker | 2691 -> 2691 | 2632 (= -child.pid) | 2632 | +166 ms | no |
| 2835 | grandchild worker | 2691 -> 2691 | 2632 (= -child.pid) | 2632 | +166 ms | no |

### SIGHUP / baseline

Runner pid 2553, runner's child (group leader) 2604, signal sent at +2056 ms after start.

| PID | Role | PPID before -> after | PGID | SID | Died after signal | Survived 10s |
|---|---|---|---|---|---|---|
| 2553 | run-tests.mjs runner | 2544 -> 2544 | 2553 | 2553 | +15 ms (zombie) | no |
| 2604 | node --test (child, pgid leader) | 2553 -> 2553 | 2604 (= -child.pid) | 2604 | +15 ms | no |
| 2629 | test-file process (mock) | 2604 -> 2604 | 2604 (= -child.pid) | 2604 | +15 ms | no |
| 2693 | grandchild worker | 2629 -> 2629 | 2604 (= -child.pid) | 2604 | +15 ms | no |
| 2695 | grandchild worker | 2629 -> 2629 | 2604 (= -child.pid) | 2604 | +15 ms | no |
| 2700 | grandchild worker | 2629 -> 2629 | 2604 (= -child.pid) | 2604 | +15 ms | no |

### SIGTERM / reparented worker

Runner pid 2560, runner's child (group leader) 2578, signal sent at +2076 ms after start.

| PID | Role | PPID before -> after | PGID | SID | Died after signal | Survived 10s |
|---|---|---|---|---|---|---|
| 2560 | run-tests.mjs runner | 2544 -> 2544 | 2560 | 2560 | +20 ms (zombie) | no |
| 2578 | node --test (child, pgid leader) | 2560 -> 2560 | 2578 (= -child.pid) | 2578 | +20 ms | no |
| 2670 | test-file process (mock) | 2578 -> 2578 | 2578 (= -child.pid) | 2578 | +20 ms | no |
| 2733 | grandchild worker | 2670 -> 2670 | 2578 (= -child.pid) | 2578 | +20 ms | no |
| 2735 | grandchild worker | 2670 -> 2670 | 2578 (= -child.pid) | 2578 | +20 ms | no |
| 2738 | grandchild worker | 2670 -> 2670 | 2578 (= -child.pid) | 2578 | +20 ms | no |
| 2904 | grandchild worker (re-parented) | 1 -> 1 | 2578 (= -child.pid) | 2578 | +20 ms | no |

### SIGTERM / setsid escapee

Runner pid 2562, runner's child (group leader) 2636, signal sent at +2108 ms after start.

| PID | Role | PPID before -> after | PGID | SID | Died after signal | Survived 10s |
|---|---|---|---|---|---|---|
| 2562 | run-tests.mjs runner | 2544 -> 2544 | 2562 | 2562 | +108 ms | no |
| 2636 | node --test (child, pgid leader) | 2562 -> 2562 | 2636 (= -child.pid) | 2636 | +108 ms | no |
| 2692 | test-file process (mock) | 2636 -> 2636 | 2636 (= -child.pid) | 2636 | +0 ms (zombie) | no |
| 2819 | grandchild worker | 2692 -> 2692 | 2636 (= -child.pid) | 2636 | +108 ms | no |
| 2822 | grandchild worker | 2692 -> 2692 | 2636 (= -child.pid) | 2636 | +108 ms | no |
| 2827 | grandchild worker | 2692 -> 2692 | 2636 (= -child.pid) | 2636 | +108 ms | no |
| 2829 | grandchild worker (setsid escapee) | 2692 -> 1 | 2829 | 2829 | never | YES |

- escapee survived as predicted

### SIGINT / setsid escapee

Runner pid 2576, runner's child (group leader) 2644, signal sent at +2116 ms after start.

| PID | Role | PPID before -> after | PGID | SID | Died after signal | Survived 10s |
|---|---|---|---|---|---|---|
| 2576 | run-tests.mjs runner | 2544 -> 2544 | 2576 | 2576 | +98 ms | no |
| 2644 | node --test (child, pgid leader) | 2576 -> 2576 | 2644 (= -child.pid) | 2644 | +98 ms | no |
| 2727 | test-file process (mock) | 2644 -> 2644 | 2644 (= -child.pid) | 2644 | +0 ms (zombie) | no |
| 2897 | grandchild worker | 2727 -> 1 | 2644 (= -child.pid) | 2644 | +98 ms | no |
| 2901 | grandchild worker | 2727 -> 1 | 2644 (= -child.pid) | 2644 | +98 ms | no |
| 2903 | grandchild worker | 2727 -> 1 | 2644 (= -child.pid) | 2644 | +98 ms | no |
| 2907 | grandchild worker (setsid escapee) | 2727 -> 1 | 2907 | 2907 | never | YES |

- escapee survived as predicted

### SIGHUP / setsid escapee

Runner pid 2580, runner's child (group leader) 2613, signal sent at +2097 ms after start.

| PID | Role | PPID before -> after | PGID | SID | Died after signal | Survived 10s |
|---|---|---|---|---|---|---|
| 2580 | run-tests.mjs runner | 2544 -> 2544 | 2580 | 2580 | +93 ms | no |
| 2613 | node --test (child, pgid leader) | 2580 -> 2580 | 2613 (= -child.pid) | 2613 | +93 ms | no |
| 2664 | test-file process (mock) | 2613 -> 2613 | 2613 (= -child.pid) | 2613 | +1 ms (zombie) | no |
| 2737 | grandchild worker | 2664 -> 2664 | 2613 (= -child.pid) | 2613 | +93 ms | no |
| 2747 | grandchild worker | 2664 -> 2664 | 2613 (= -child.pid) | 2613 | +93 ms | no |
| 2749 | grandchild worker | 2664 -> 2664 | 2613 (= -child.pid) | 2613 | +93 ms | no |
| 2762 | grandchild worker (setsid escapee) | 2664 -> 1 | 2762 | 2762 | never | YES |

- escapee survived as predicted

### SIGQUIT / baseline (unhandled)

Runner pid 2586, runner's child (group leader) 2669, signal sent at +2108 ms after start.

| PID | Role | PPID before -> after | PGID | SID | Died after signal | Survived 10s |
|---|---|---|---|---|---|---|
| 2586 | run-tests.mjs runner | 2544 -> 2544 | 2586 | 2586 | +0 ms (zombie) | no |
| 2669 | node --test (child, pgid leader) | 2586 -> 1 | 2669 (= -child.pid) | 2669 | never | YES |
| 2740 | test-file process (mock) | 2669 -> 2669 | 2669 (= -child.pid) | 2669 | never | YES |
| 2929 | grandchild worker | 2740 -> 2740 | 2669 (= -child.pid) | 2669 | never | YES |
| 2940 | grandchild worker | 2740 -> 2740 | 2669 (= -child.pid) | 2669 | never | YES |
| 2943 | grandchild worker | 2740 -> 2740 | 2669 (= -child.pid) | 2669 | never | YES |

- whole tree orphaned as predicted (runner could not run its handler)

### SIGKILL / baseline (uncatchable)

Runner pid 2597, runner's child (group leader) 2642, signal sent at +2118 ms after start.

| PID | Role | PPID before -> after | PGID | SID | Died after signal | Survived 10s |
|---|---|---|---|---|---|---|
| 2597 | run-tests.mjs runner | 2544 -> 2544 | 2597 | 2597 | +1 ms (zombie) | no |
| 2642 | node --test (child, pgid leader) | 2597 -> 1 | 2642 (= -child.pid) | 2642 | never | YES |
| 2690 | test-file process (mock) | 2642 -> 2642 | 2642 (= -child.pid) | 2642 | never | YES |
| 2812 | grandchild worker | 2690 -> 2690 | 2642 (= -child.pid) | 2642 | never | YES |
| 2823 | grandchild worker | 2690 -> 2690 | 2642 (= -child.pid) | 2642 | never | YES |
| 2828 | grandchild worker | 2690 -> 2690 | 2642 (= -child.pid) | 2642 | never | YES |

- whole tree orphaned as predicted (runner could not run its handler)

## kill(-pid) probe

- children 5479, 5486, 5487 all in group -5470: true
- kill(-5470, SIGTERM): leader dead, 3/3 SIGTERM-ignoring children alive
- kill(-5470, SIGKILL): 0/3 children alive

## Signal type vs orphan survival (condensed)

| Signal sent to runner | Runner handles it? | Workers in group survive? | Re-parented worker in group survives? | `setsid` escapee survives? | Runner exit |
|---|---|---|---|---|---|
| SIGTERM | yes | no (0/3) | no | **yes (1/1)** | code 1 |
| SIGINT | yes | no (0/3) | not run | **yes (1/1)** | code 1 |
| SIGHUP | yes | no (0/3) | not run | **yes (1/1)** | code 1 |
| SIGQUIT | no (default action) | **yes (3/3), plus `node --test` and the test process** | n/a | n/a | killed by SIGQUIT |
| SIGKILL | cannot be handled | **yes (3/3), plus `node --test` and the test process** | n/a | n/a | killed by SIGKILL |

The PIDs behind each cell are in the matrix and PID traces above.

## Edge cases where grandchildren escaped the process group

1. **`setsid` / `detached: true` grandchild.** The escapee has its own pgid and sid (both equal to its pid) and is not in
   `-child.pid`, so neither the group SIGTERM nor the group SIGKILL touches it. After the test process dies it is re-parented to PID 1
   (`PPID 2692 -> 1` in the trace) and keeps running. Any test that starts a server or daemon with `detached: true` will leak this way.
   Before the signal its ppid chain was intact, so a descendant walk done *before* signalling (the `pgrep -P` approach in `src/process-tree.mjs`)
   could find it. I did not test that, and it stops working once an intermediate parent has exited.
2. **Uncatchable or unhandled signals.** SIGKILL (OOM killer, `kill -9`, `timeout -s KILL`) and SIGQUIT (Ctrl-backslash) kill the runner without
   running a handler. `node --test`, the test process and all workers are orphaned. The group is still intact (every pgid still equals
   `-child.pid`) and `node --test`'s ppid becomes 1, so an external reaper could still clean it with `kill -- -<pgid>`.
3. **Re-parenting is not an escape.** A worker whose parent exited (ppid 1 before the signal) stayed in the group and was killed.
   The reaper relies on group membership, not ancestry, which is the right mechanism.
4. **Not exercised:** a grandchild that calls `setpgid` to join another group (same effect as case 1), and processes spawned after the
   signal (none were seen: `lateSpawn` would be flagged in the traces).

## Exit codes and the grace period

* After SIGINT, SIGHUP and SIGTERM the runner exits with **code 1** within 15-95 ms, never 130 (or 143 for SIGTERM).
  The reason is in the source: the group gets SIGTERM, `node --test` dies from it, and the `child.on("exit")` handler runs first.
  It sends SIGKILL to the group and calls `process.exit(signal ? 1 : code ?? 1)`. The `setTimeout(..., 2000)` escalation and its
  `process.exit(130)` are only reached if `node --test` survives the SIGTERM.
* Consequence for the SIGTERM-ignoring workers: they were not given 2 s and then killed. They were SIGKILLed 3-170 ms after the signal by the
  exit handler, well inside their 5 s ignore window. No grandchild gets a graceful-shutdown window on any handled signal.
* The kill(-pid) probe confirms the group semantics: `kill(-pid, SIGTERM)` leaves SIGTERM-ignoring children alive, and a later
  `kill(-pid, SIGKILL)` removes all of them even though the group leader was already dead.
* Callers that check for 130/143 will not see those values from this runner. Whether to change that is a design decision; I made no change.

## Related observation in `src/engine.mjs` (source read only, not executed)

The dev-server probe (`spawn(shellBin, shellArgs, { detached: true ... })`, around line 1654) cleans up in a `finally` block with
`process.kill(-child.pid, "SIGTERM")` only. `engine.mjs` registers no `process.on(signal)` handlers. So (a) a server tree that ignores
SIGTERM would survive that cleanup, as the probe shows for any group SIGTERM, and (b) if the orchestrator process itself is killed by a signal,
the `finally` never runs and the server tree is orphaned. The runner in `scripts/run-tests.mjs` avoids (a) by escalating to SIGKILL.

## Measurement notes

* The test-file process shows `+0 ms (zombie)`: it was already dead and waiting to be reaped by `node --test`, which was being killed. Zombies are counted as dead.
* The 10 s wait and 2 s signal delay are the defaults; `--wait-ms` and `--signal-after-ms` change them for quicker iteration.
* Scenarios run in parallel by default (about 14 s in total). `--sequential` runs them one by one (about 2 min).
* Mock workers have a 45 s lifetime cap, so even without the fail-safe nothing survives indefinitely.
* Linux only for the `/proc` path; POSIX with `ps` is best-effort and untested here. On Windows the harness prints SKIP and exits 0.
* After every run the harness found no leftover processes and removed its temp directories.

## Reproduce

```sh
node arena-orphan-stress-test.mjs                      # exit 0 if no unexpected orphans
node arena-orphan-stress-test.mjs --report=/tmp/r.md   # also write the matrix and PID traces
node arena-orphan-stress-test.mjs --only="SIGTERM"     # subset
npm test
```
