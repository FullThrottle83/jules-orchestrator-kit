#!/usr/bin/env node
/**
 * Mock "hanging" test used by arena-orphan-stress-test.mjs.
 *
 * It plays two roles, chosen by argv:
 *
 *   (no role)              The test itself. Registers a node:test case that
 *                          spawns three grandchild workers and then hangs.
 *   --arena-role=worker    A grandchild: ignores SIGTERM for 5 seconds, then
 *                          restores the default disposition and idles until
 *                          its own lifetime cap, so a leak is observable but
 *                          can never be permanent.
 *
 * Extra processes are spawned only when ARENA_MOCK_MODE asks for them, to
 * reproduce ways a grandchild can leave the runner's process group:
 *
 *   baseline    3 workers in the test's own process group.
 *   escape      baseline + 1 worker started with `detached: true` (setsid),
 *               i.e. a new session and process group.
 *   reparented  baseline + 1 worker whose parent exits immediately, so it is
 *               re-parented to init/subreaper but stays in the same group.
 *
 * Every spawned process carries `--arena-run=<ARENA_ORPHAN_RUN>` in argv so
 * the stress test can find it with ps as well as /proc.
 */
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const RUN_ID = process.env.ARENA_ORPHAN_RUN || "standalone";
const MODE = process.env.ARENA_MOCK_MODE || "baseline";
const IGNORE_SIGTERM_MS = 5_000;
const LIFETIME_MS = Number(process.env.ARENA_MOCK_LIFETIME_MS) || 45_000;

const roleArg = process.argv.find((a) => a.startsWith("--arena-role="));
const role = roleArg ? roleArg.slice("--arena-role=".length) : "test";

function launch(childRole, options = {}) {
  const child = spawn(
    process.execPath,
    [SELF, `--arena-role=${childRole}`, `--arena-run=${RUN_ID}`],
    { stdio: "ignore", env: process.env, ...options },
  );
  child.unref();
  return child;
}

function idleUntilLifetimeCap() {
  // A ref'd timer keeps the event loop (and therefore the process) alive.
  setTimeout(() => process.exit(0), LIFETIME_MS);
}

if (role === "worker" || role === "escapee" || role === "reparented") {
  // Ignore SIGTERM for the first 5 seconds, then fall back to the default
  // action (terminate) for any later SIGTERM. SIGKILL cannot be ignored.
  process.on("SIGTERM", () => {});
  setTimeout(() => process.removeAllListeners("SIGTERM"), IGNORE_SIGTERM_MS).unref();
  idleUntilLifetimeCap();
} else if (role === "intermediate") {
  // Spawn the real worker and exit at once: the worker is re-parented but
  // remains in the process group it inherited.
  launch("reparented");
  process.exit(0);
} else {
  test("arena mock: hangs with three SIGTERM-ignoring grandchildren", async () => {
    for (let i = 0; i < 3; i++) launch("worker");
    if (MODE === "escape") launch("escapee", { detached: true });
    if (MODE === "reparented") launch("intermediate");

    // Hang: the runner has to be interrupted to get out of here.
    await new Promise((resolve) => setTimeout(resolve, LIFETIME_MS));
  });
}
