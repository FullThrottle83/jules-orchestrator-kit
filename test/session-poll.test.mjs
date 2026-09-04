import test from "node:test";
import assert from "node:assert/strict";
import {
  pollSessionState,
  TERMINAL_SESSION_STATES,
  BLOCKING_SESSION_STATES,
} from "../src/engine.mjs";

/**
 * Contract for the poll that every re-verification gate depends on.
 *
 * The function decides whether an agent session is believed to have finished
 * writing. `pollSessionState` previously returned `COMPLETED` for every
 * non-terminal exit, so a session sitting in `AWAITING_USER_FEEDBACK` and one
 * still `IN_PROGRESS` when the budget expired were both indistinguishable from
 * success — and it had no test at all, which is how that survived.
 *
 * Every state below is a value of the documented `SessionState` enum:
 * https://jules.google/docs/api/reference/types#sessionstate
 */

const FAST = { pollIntervalMs: 1, maxPollAttempts: 4, pollTimeoutMs: 5000 };

/** A provider whose `getSession` walks a fixed list of states, then repeats the last. */
function providerOverStates(states, hooks = {}) {
  let i = 0;
  const seen = [];
  const approvePlanCalls = [];
  return {
    seen,
    approvePlanCalls,
    async getSession(id) {
      seen.push(id);
      const state = states[Math.min(i, states.length - 1)];
      i += 1;
      return { id, state };
    },
    async approvePlan(...args) {
      approvePlanCalls.push(args);
      if (hooks.approvePlanThrows) throw new Error("approvePlan refused: quota");
      return {};
    },
  };
}

test("Session state polling never reports an unfinished session as COMPLETED", async (t) => {
  await t.test("the state sets match the documented SessionState enum", () => {
    assert.deepEqual([...TERMINAL_SESSION_STATES].sort(), ["COMPLETED", "FAILED"]);
    assert.deepEqual([...BLOCKING_SESSION_STATES].sort(), [
      "AWAITING_PLAN_APPROVAL",
      "AWAITING_USER_FEEDBACK",
      "PAUSED",
    ]);
  });

  await t.test("COMPLETED is terminal and costs one poll", async () => {
    const provider = providerOverStates(["COMPLETED"]);
    const res = await pollSessionState(provider, { id: "s1" }, FAST);
    assert.equal(res.status, "COMPLETED");
    assert.equal(res.terminal, true);
    assert.equal(res.polls, 1);
    assert.equal(res.timedOut, undefined);
  });

  await t.test("FAILED is terminal and is reported as FAILED, not as an error", async () => {
    const provider = providerOverStates(["FAILED"]);
    const res = await pollSessionState(provider, { id: "s1" }, FAST);
    assert.equal(res.status, "FAILED");
    assert.equal(res.terminal, true);
  });

  await t.test("AWAITING_USER_FEEDBACK blocks instead of burning the poll budget", async () => {
    const provider = providerOverStates(["AWAITING_USER_FEEDBACK"]);
    const res = await pollSessionState(provider, { id: "s1" }, FAST);
    assert.equal(res.status, "AWAITING_USER_FEEDBACK");
    assert.equal(res.terminal, false);
    assert.equal(res.blockedOn, "AWAITING_USER_FEEDBACK");
    assert.equal(res.polls, 1, "a state that needs a human should not be polled four times");
    assert.notEqual(res.status, "COMPLETED");
  });

  await t.test("PAUSED blocks and names what it is blocked on", async () => {
    const provider = providerOverStates(["PAUSED"]);
    const res = await pollSessionState(provider, { id: "s1" }, FAST);
    assert.equal(res.blockedOn, "PAUSED");
    assert.equal(res.terminal, false);
  });

  await t.test("AWAITING_PLAN_APPROVAL blocks when nobody was asked to approve it", async () => {
    const provider = providerOverStates(["AWAITING_PLAN_APPROVAL"]);
    const res = await pollSessionState(provider, { id: "s1" }, FAST);
    assert.equal(res.blockedOn, "AWAITING_PLAN_APPROVAL");
    assert.equal(res.terminal, false);
  });

  await t.test("AWAITING_PLAN_APPROVAL is resolved in-session when auto-approval was requested", async () => {
    const provider = providerOverStates(["AWAITING_PLAN_APPROVAL", "COMPLETED"]);
    const res = await pollSessionState(provider, { id: "s1" }, { ...FAST, autoApprovePlan: true });
    assert.equal(res.status, "COMPLETED");
    assert.equal(res.terminal, true);
    assert.equal(provider.approvePlanCalls.length, 1);
    assert.equal(provider.approvePlanCalls[0][0], "s1");
  });

  await t.test("a refused plan approval is reported, not swallowed", async () => {
    const provider = providerOverStates(["AWAITING_PLAN_APPROVAL"], { approvePlanThrows: true });
    const res = await pollSessionState(provider, { id: "s1" }, { ...FAST, autoApprovePlan: true });
    assert.equal(res.status, "AWAITING_PLAN_APPROVAL");
    assert.equal(res.terminal, false);
    assert.equal(res.blockedOn, "AWAITING_PLAN_APPROVAL");
    assert.match(res.approvePlanError, /quota/);
  });

  await t.test("an auto-approval request on the session object is honoured too", async () => {
    const provider = providerOverStates(["AWAITING_PLAN_APPROVAL", "COMPLETED"]);
    const res = await pollSessionState(provider, { id: "s1", autoApprovePlan: true }, FAST);
    assert.equal(res.terminal, true);
    assert.equal(provider.approvePlanCalls.length, 1);
  });

  await t.test("a session that never terminates times out as itself", async () => {
    const provider = providerOverStates(["IN_PROGRESS"]);
    const res = await pollSessionState(provider, { id: "s1" }, FAST);
    assert.equal(res.status, "IN_PROGRESS");
    assert.equal(res.terminal, false);
    assert.equal(res.timedOut, true);
    assert.notEqual(res.status, "COMPLETED", "the fail-open this file exists to prevent");
  });

  await t.test("QUEUED then COMPLETED waits for the work to start", async () => {
    const provider = providerOverStates(["QUEUED", "COMPLETED"]);
    const res = await pollSessionState(provider, { id: "s1" }, FAST);
    assert.equal(res.status, "COMPLETED");
    assert.equal(res.terminal, true);
    assert.equal(res.polls, 2);
  });

  await t.test("PLANNING is in-progress, not finished", async () => {
    const provider = providerOverStates(["PLANNING"]);
    const res = await pollSessionState(provider, { id: "s1" }, FAST);
    assert.equal(res.status, "PLANNING");
    assert.equal(res.timedOut, true);
    assert.equal(res.terminal, false);
  });

  await t.test("STATE_UNSPECIFIED times out as UNKNOWN rather than as a pass", async () => {
    const provider = providerOverStates(["STATE_UNSPECIFIED"]);
    const res = await pollSessionState(provider, { id: "s1" }, FAST);
    assert.equal(res.status, "STATE_UNSPECIFIED");
    assert.equal(res.terminal, false);
  });

  await t.test("a session with no state at all reports UNKNOWN, not COMPLETED", async () => {
    const provider = { async getSession(id) { return { id }; } };
    const res = await pollSessionState(provider, { id: "s1" }, FAST);
    assert.equal(res.status, "UNKNOWN");
    assert.equal(res.terminal, false);
    assert.equal(res.timedOut, true);
  });

  await t.test("every non-terminal documented state is distinguishable from success", async () => {
    const nonTerminal = [
      "STATE_UNSPECIFIED",
      "QUEUED",
      "PLANNING",
      "AWAITING_PLAN_APPROVAL",
      "AWAITING_USER_FEEDBACK",
      "IN_PROGRESS",
      "PAUSED",
    ];
    for (const state of nonTerminal) {
      const res = await pollSessionState(providerOverStates([state]), { id: `s-${state}` }, FAST);
      assert.notEqual(res.status, "COMPLETED", `${state} must not read as COMPLETED`);
      assert.equal(res.terminal, false, `${state} must not be terminal`);
    }
  });

  await t.test("a provider that stops answering is reported as unreachable", async () => {
    const provider = { async getSession() { return null; } };
    const res = await pollSessionState(provider, { id: "s1" }, FAST);
    assert.equal(res.unreachable, true);
    assert.equal(res.terminal, false);
    assert.equal(res.status, "UNKNOWN");
  });

  await t.test("a provider that throws on every poll is unreachable, not COMPLETED", async () => {
    const provider = {
      async getSession() {
        throw new Error("network down");
      },
    };
    const res = await pollSessionState(provider, { id: "s1" }, FAST);
    assert.equal(res.unreachable, true);
    assert.equal(res.terminal, false);
  });

  await t.test("a custom pollFn is used when the provider has no getSession", async () => {
    const res = await pollSessionState(
      {},
      { id: "s1" },
      { ...FAST, pollFn: async () => ({ id: "s1", state: "COMPLETED" }) }
    );
    assert.equal(res.terminal, true);
    assert.equal(res.status, "COMPLETED");
  });

  await t.test("a dry run is simulated and makes no calls", async () => {
    let calls = 0;
    const provider = {
      async getSession() {
        calls += 1;
        return { id: "s1", state: "IN_PROGRESS" };
      },
    };
    const res = await pollSessionState(provider, { id: "s1" }, { ...FAST, dryRun: true });
    assert.equal(calls, 0, "a dry run must not spend a poll");
    assert.equal(res.simulated, true);
    assert.equal(res.terminal, true);
    assert.equal(res.polls, 0);
  });

  await t.test("an already-terminal session is returned without polling", async () => {
    let calls = 0;
    const provider = {
      async getSession() {
        calls += 1;
        return { id: "s1", state: "IN_PROGRESS" };
      },
    };
    const res = await pollSessionState(provider, { id: "s1", state: "FAILED" }, FAST);
    assert.equal(calls, 0);
    assert.equal(res.status, "FAILED");
    assert.equal(res.terminal, true);
  });

  await t.test("no session id is not a pass", async () => {
    const res = await pollSessionState({}, null, FAST);
    assert.equal(res.status, "UNKNOWN");
    assert.equal(res.terminal, false);
    assert.equal(res.unpolled, true);
  });

  await t.test("the wall-clock budget ends the loop even with attempts left", async () => {
    const started = Date.now();
    const res = await pollSessionState(providerOverStates(["IN_PROGRESS"]), { id: "s1" }, {
      pollIntervalMs: 20,
      maxPollAttempts: 1000,
      pollTimeoutMs: 60,
    });
    assert.equal(res.timedOut, true);
    assert.ok(Date.now() - started < 2000, "the wall clock, not the attempt count, ended the loop");
  });
});
