import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  resolveDailyLimit,
  readObservedCeiling,
  readActiveCeiling,
  recordObservedCeiling,
  isDailyQuotaRejection,
  budgetStatus,
  listOpenReservations,
  releaseOpenReservations,
  resolveConcurrency,
  CEILING_FILE,
} from "../src/budget.mjs";
import { loadConfig, TIER_PRESETS } from "../src/config.mjs";
import { dispatch } from "../src/engine.mjs";
import {
  checkDailyBudget,
  BudgetError,
  reserveBudget,
  commitBudgetReservation,
  rollbackBudgetReservation,
  getDailyLedgerPath,
  getLedgerPathsInWindow,
  scanBudgetWindow,
  verifyLedgerIntegrity,
  appendLedger,
  ROLLING_WINDOW_MS,
} from "../src/state.mjs";
import { reserveDailyBudget } from "../scripts/utils.mjs";

/** An isolated repo root so nothing here touches the operator's real ledger. */
function makeRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, ".agent", "state"), { recursive: true });
  return root;
}

function writeConfig(root, yaml) {
  writeFileSync(join(root, ".agent", "config.yml"), yaml, "utf-8");
}

/**
 * Seed a ledger file with backdated entries, hash-chained exactly as
 * appendLedger would have written them.
 *
 * Backdating is the whole point: the rolling window can only be tested across a
 * day boundary, and waiting for one is not a test.
 *
 * @param {string} root
 * @param {Array<{ at: string, payload: object }>} entries - `at` is an ISO timestamp.
 */
function seedLedger(root, entries) {
  /** @type {Map<string, string[]>} */
  const byDay = new Map();
  /** @type {Map<string, string>} */
  const chainHead = new Map();

  for (const { at, payload } of entries) {
    const day = at.split("T")[0];
    const prevHash = chainHead.get(day) || "0".repeat(64);
    const raw = { timestamp: at, ...payload, prevHash };
    const hash = createHash("sha256").update(JSON.stringify(raw)).digest("hex");
    chainHead.set(day, hash);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(JSON.stringify({ ...raw, hash }));
  }

  for (const [day, lines] of byDay) {
    writeFileSync(join(root, ".agent", "state", `ledger-${day}.jsonl`), lines.join("\n") + "\n", "utf-8");
  }
}

/** Shorthand for a reservation `n` hours before `now`. */
function reservedHoursAgo(now, hours, reservationId) {
  return {
    at: new Date(now - hours * 3600000).toISOString(),
    payload: reservationId ? { event: "budget_reserved", reservationId } : { event: "budget_reserved" },
  };
}

describe("src/budget.mjs — limit provenance", () => {
  it("treats an explicit limits.daily_tasks as certain and lets it beat the tier preset", () => {
    const root = makeRoot("jok-budget-cfg-");
    try {
      writeConfig(root, "version: 1\ntier: ultra\nlimits:\n  daily_tasks: 42\n");
      const resolved = resolveDailyLimit(loadConfig(root), root);

      assert.equal(resolved.limit, 42);
      assert.equal(resolved.source, "config");
      assert.equal(resolved.certain, true, "an operator-stated limit is authoritative");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks a tier-derived limit as uncertain", () => {
    const root = makeRoot("jok-budget-tier-");
    try {
      writeConfig(root, "version: 1\ntier: free\n");
      const resolved = resolveDailyLimit(loadConfig(root), root);

      assert.equal(resolved.limit, TIER_PRESETS.free.dailyTasks);
      assert.equal(resolved.source, "tier");
      assert.equal(resolved.certain, false, "a preset is a guess about the vendor's plan, not a fact");
      assert.match(resolved.note, /limits\.daily_tasks/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honours an explicit limit of zero instead of falling through to an estimate", () => {
    const root = makeRoot("jok-budget-zero-");
    try {
      writeConfig(root, "version: 1\ntier: ultra\nlimits:\n  daily_tasks: 0\n");
      const resolved = resolveDailyLimit(loadConfig(root), root);

      assert.equal(resolved.limit, 0, "zero is a deliberate freeze, not a missing value");
      assert.equal(resolved.certain, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("src/budget.mjs — learned ceiling", () => {
  it("round-trips an observed ceiling and mirrors it into the ledger", () => {
    const root = makeRoot("jok-budget-learn-");
    try {
      const rec = recordObservedCeiling(87, root);
      assert.equal(rec.ceiling, 87);

      assert.ok(existsSync(join(root, ".agent", "state", CEILING_FILE)));
      assert.equal(readObservedCeiling(root).ceiling, 87);

      const ledgerDir = join(root, ".agent", "state");
      const ledger = readFileSync(
        join(ledgerDir, `ledger-${new Date().toISOString().split("T")[0]}.jsonl`),
        "utf-8"
      );
      assert.match(ledger, /budget_ceiling_observed/, "the change must stay auditable in the hash chain");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers a learned ceiling over a tier guess and treats it as certain", () => {
    const root = makeRoot("jok-budget-learn2-");
    try {
      writeConfig(root, "version: 1\ntier: ultra\n");
      assert.equal(resolveDailyLimit(loadConfig(root), root).limit, TIER_PRESETS.ultra.dailyTasks);

      recordObservedCeiling(60, root);
      const resolved = resolveDailyLimit(loadConfig(root), root);

      assert.equal(resolved.limit, 60, "what the provider demonstrated outranks what the preset assumed");
      assert.equal(resolved.source, "learned");
      assert.equal(resolved.certain, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never outranks a limit the operator stated explicitly", () => {
    const root = makeRoot("jok-budget-learn3-");
    try {
      writeConfig(root, "version: 1\ntier: ultra\nlimits:\n  daily_tasks: 25\n");
      recordObservedCeiling(60, root);

      assert.equal(resolveDailyLimit(loadConfig(root), root).limit, 25);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a ceiling of zero, meaning the quota was spent outside this checkout", () => {
    const root = makeRoot("jok-budget-zero-ceiling-");
    try {
      // The ledger only sees tasks dispatched from here; the web UI and other
      // machines spend the same quota invisibly. A refusal before this checkout
      // dispatched anything is exactly that case, and must still stop the day.
      assert.equal(recordObservedCeiling(0, root).ceiling, 0);
      assert.equal(readActiveCeiling(root).ceiling, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects nonsensical ceilings rather than persisting them", () => {
    const root = makeRoot("jok-budget-learn4-");
    try {
      assert.equal(recordObservedCeiling(-5, root), null);
      assert.equal(recordObservedCeiling(Number.NaN, root), null);
      assert.equal(readObservedCeiling(root), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops enforcing a ceiling observed on an earlier day", () => {
    const root = makeRoot("jok-budget-stale-");
    try {
      writeConfig(root, "version: 1\ntier: ultra\n");
      writeFileSync(
        join(root, ".agent", "state", CEILING_FILE),
        JSON.stringify({ ceiling: 3, day: "2000-01-01", observedAt: "2000-01-01T00:00:00.000Z" }),
        "utf-8"
      );

      assert.equal(readObservedCeiling(root).stale, true);
      assert.equal(readActiveCeiling(root), null);

      // Carrying yesterday's refusal forward would keep the operator locked out
      // after the quota had already reset.
      const resolved = resolveDailyLimit(loadConfig(root), root);
      assert.equal(resolved.source, "tier");
      assert.equal(resolved.limit, TIER_PRESETS.ultra.dailyTasks);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores a corrupt ceiling file instead of throwing", () => {
    const root = makeRoot("jok-budget-corrupt-");
    try {
      writeFileSync(join(root, ".agent", "state", CEILING_FILE), "{not json", "utf-8");
      assert.equal(readObservedCeiling(root), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("src/budget.mjs — quota rejection classification", () => {
  it("recognises a daily quota refusal", () => {
    assert.equal(
      isDailyQuotaRejection({ status: 429, message: "RESOURCE_EXHAUSTED: daily task quota exceeded" }),
      true
    );
    assert.equal(isDailyQuotaRejection({ status: 403, message: "Quota exceeded for tasks per day" }), true);
  });

  it("does not learn a ceiling from a burst throttle", () => {
    // Learning here would pin the daily allowance to whatever short burst
    // tripped the per-minute limiter — far below the operator's real quota.
    assert.equal(
      isDailyQuotaRejection({ status: 429, message: "Too Many Requests: 60 per minute, retry-after 30" }),
      false
    );
  });

  it("ignores unrelated failures", () => {
    assert.equal(isDailyQuotaRejection({ status: 500, message: "quota" }), false);
    assert.equal(isDailyQuotaRejection({ status: 429, message: "upstream connection reset" }), false);
    assert.equal(isDailyQuotaRejection(null), false);
    assert.equal(isDailyQuotaRejection("429 quota daily"), false);
  });
});

describe("budget enforcement is gated on certainty", () => {
  it("blocks a dispatch once a known limit is spent", async () => {
    const root = makeRoot("jok-budget-hard-");
    try {
      writeConfig(root, "version: 1\ntier: ultra\nlimits:\n  daily_tasks: 0\n");
      const provider = { dispatch: async () => ({ id: "s", status: "pending" }) };

      await assert.rejects(
        () => dispatch({ title: "T", prompt: "p" }, { root, provider }),
        (err) => err instanceof BudgetError
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets a dispatch through when the spent limit was only an estimate", async () => {
    const root = makeRoot("jok-budget-soft-");
    try {
      // tier free = 15/day, but nothing here states that is the real allowance.
      writeConfig(root, "version: 1\ntier: free\n");
      const limit = TIER_PRESETS.free.dailyTasks;
      const provider = { dispatch: async () => ({ id: "s", status: "pending" }) };

      for (let i = 0; i < limit; i++) {
        await dispatch({ title: `T${i}`, prompt: "p" }, { root, provider });
      }
      assert.equal(checkDailyBudget(root, limit).used, limit, "the estimate is now fully spent");

      // Refusing here would break the tool for anyone whose plan we guessed low.
      const session = await dispatch({ title: "over", prompt: "p" }, { root, provider });
      assert.equal(session.id, "s", "an uncertain ceiling warns but must not block");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("starts enforcing the estimate once the provider has taught us the real ceiling", async () => {
    const root = makeRoot("jok-budget-after-learn-");
    try {
      writeConfig(root, "version: 1\ntier: free\n");
      const provider = { dispatch: async () => ({ id: "s", status: "pending" }) };

      await dispatch({ title: "first", prompt: "p" }, { root, provider });
      recordObservedCeiling(1, root);

      await assert.rejects(
        () => dispatch({ title: "second", prompt: "p" }, { root, provider }),
        (err) => err instanceof BudgetError,
        "a demonstrated ceiling is enforced where a guessed one was not"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records the ceiling when the provider refuses for daily quota", async () => {
    const root = makeRoot("jok-budget-record-");
    try {
      writeConfig(root, "version: 1\ntier: ultra\n");
      const provider = {
        dispatch: async () => {
          const err = new Error("RESOURCE_EXHAUSTED: daily task quota exceeded");
          err.status = 429;
          throw err;
        },
      };

      await dispatch({ title: "T", prompt: "p" }, { root, provider }).catch(() => {});

      const learned = readActiveCeiling(root);
      assert.ok(learned, "a daily-quota refusal must stop further dispatches today");
      assert.equal(learned.source, "provider-rejection");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("budgetStatus reports what it knows", () => {
  it("exposes provenance and whether the limit is enforced", () => {
    const root = makeRoot("jok-budget-status-");
    try {
      writeConfig(root, "version: 1\ntier: pro\n");
      const guessed = budgetStatus(loadConfig(root), root);
      assert.equal(guessed.certain, false);
      assert.equal(guessed.enforced, false, "an estimate must never be presented as a hard gate");
      assert.equal(guessed.source, "tier");

      writeConfig(root, "version: 1\ntier: pro\nlimits:\n  daily_tasks: 10\n");
      const stated = budgetStatus(loadConfig(root), root);
      assert.equal(stated.limit, 10);
      assert.equal(stated.enforced, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("reconciling a local count that no longer reflects reality", () => {
  it("treats a committed reservation as still spent", () => {
    const root = makeRoot("jok-budget-open-");
    try {
      const a = reserveBudget(root, 100);
      const b = reserveBudget(root, 100);
      commitBudgetReservation(root, a.reservationId);

      const open = listOpenReservations(root);
      assert.equal(open.length, 2, "a commit records success, it does not give quota back");
      assert.equal(open.filter((r) => r.committed).length, 1);
      assert.ok(open.some((r) => r.reservationId === b.reservationId));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes reservations that were already rolled back", () => {
    const root = makeRoot("jok-budget-open-rb-");
    try {
      const a = reserveBudget(root, 100);
      rollbackBudgetReservation(root, a.reservationId);
      assert.equal(listOpenReservations(root).length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports without writing when asked for a dry run", () => {
    const root = makeRoot("jok-budget-dry-");
    try {
      reserveBudget(root, 100);
      reserveBudget(root, 100);

      const res = releaseOpenReservations({ root, dryRun: true });
      assert.equal(res.released, 2);
      assert.equal(res.dryRun, true);
      assert.equal(checkDailyBudget(root, 100).used, 2, "a dry run must leave the count alone");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("zeroes the count by appending, leaving the hash chain verifiable", () => {
    const root = makeRoot("jok-budget-release-");
    try {
      for (let i = 0; i < 5; i++) reserveBudget(root, 100);
      assert.equal(checkDailyBudget(root, 100).used, 5);

      const before = readFileSync(getDailyLedgerPath(root), "utf-8").split("\n").filter(Boolean).length;
      const res = releaseOpenReservations({ root, reason: "operator-reconcile" });

      assert.equal(res.released, 5);
      assert.equal(checkDailyBudget(root, 100).used, 0);

      const after = readFileSync(getDailyLedgerPath(root), "utf-8").split("\n").filter(Boolean).length;
      assert.equal(after, before + 5, "corrections are appended, never edited in place");
      assert.equal(
        verifyLedgerIntegrity(getDailyLedgerPath(root)).ok,
        true,
        "the audit chain must survive the correction"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps reservations that demonstrably reached the provider", () => {
    // A committed reservation carries proof that a session exists on Jules'
    // side, so the quota really was spent. Giving it back makes the local count
    // understate reality — and understating is the direction that gets the next
    // dispatch refused, which is exactly what the ledger exists to prevent.
    const root = makeRoot("jok-budget-keep-committed-");
    try {
      const a = reserveBudget(root, 100);
      reserveBudget(root, 100);
      reserveBudget(root, 100);
      commitBudgetReservation(root, a.reservationId);

      const res = releaseOpenReservations({ root });
      assert.equal(res.released, 2);
      assert.equal(res.kept, 1);
      assert.equal(res.committed, 1);
      assert.equal(res.includeCommitted, false);
      assert.ok(!res.ids.includes(a.reservationId), "the committed one must not be released");

      assert.equal(checkDailyBudget(root, 100).used, 1, "the confirmed dispatch is still charged");
      assert.equal(listOpenReservations(root)[0].reservationId, a.reservationId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("releases the committed ones too when the operator asks for --all", () => {
    const root = makeRoot("jok-budget-all-");
    try {
      const a = reserveBudget(root, 100);
      reserveBudget(root, 100);
      commitBudgetReservation(root, a.reservationId);

      const res = releaseOpenReservations({ root, includeCommitted: true });
      assert.equal(res.released, 2);
      assert.equal(res.kept, 0);
      assert.equal(checkDailyBudget(root, 100).used, 0);
      assert.equal(
        verifyLedgerIntegrity(getDailyLedgerPath(root)).ok,
        true,
        "the override still corrects forwards, never in place"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes nothing when every open reservation is a committed one", () => {
    const root = makeRoot("jok-budget-all-committed-");
    try {
      const a = reserveBudget(root, 100);
      commitBudgetReservation(root, a.reservationId);
      const before = readFileSync(getDailyLedgerPath(root), "utf-8").split("\n").filter(Boolean).length;

      const res = releaseOpenReservations({ root });
      assert.equal(res.released, 0);
      assert.equal(res.kept, 1);

      const after = readFileSync(getDailyLedgerPath(root), "utf-8").split("\n").filter(Boolean).length;
      assert.equal(after, before, "a reset with nothing to release must not touch the ledger");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still releases legacy id-less reservations, which can never be committed", () => {
    // `budget_committed` names a reservationId, so an anonymous reservation can
    // never acquire one. It always reads as uncommitted — which is right: it is
    // exactly the phantom the default reset is meant to clear.
    const root = makeRoot("jok-budget-anon-default-");
    try {
      appendLedger({ event: "budget_reserved", key: "legacy-a" }, root);
      appendLedger({ event: "budget_reserved", key: "legacy-b" }, root);

      const res = releaseOpenReservations({ root });
      assert.equal(res.released, 2);
      assert.equal(res.kept, 0);
      assert.equal(res.anonymous, 2);
      assert.equal(checkDailyBudget(root, 100).used, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is a no-op on a ledger with nothing outstanding", () => {
    const root = makeRoot("jok-budget-noop-");
    try {
      const res = releaseOpenReservations({ root });
      assert.equal(res.released, 0);
      assert.equal(existsSync(getDailyLedgerPath(root)), false, "nothing to correct writes nothing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("legacy reservations written without an id", () => {
  it("counts and releases them, since nothing else ever could", () => {
    const root = makeRoot("jok-budget-anon-");
    try {
      // Exactly what older kit versions and scripts/utils.mjs used to write.
      appendLedger({ event: "budget_reserved", key: "legacy-a" }, root);
      appendLedger({ event: "budget_reserved", key: "legacy-b" }, root);
      const withId = reserveBudget(root, 100);

      assert.equal(checkDailyBudget(root, 100).used, 3);
      const open = listOpenReservations(root);
      assert.equal(open.length, 3, "an unnamed reservation still spends budget");
      assert.equal(open.filter((r) => !r.reservationId).length, 2);

      const res = releaseOpenReservations({ root });
      assert.equal(res.anonymous, 2);
      assert.deepEqual(res.ids, [withId.reservationId], "only real ids are reported as ids");
      assert.equal(checkDailyBudget(root, 100).used, 0, "the day must actually come back to zero");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("no longer produces them", () => {
    const root = makeRoot("jok-budget-anon-fixed-");
    try {
      const res = reserveDailyBudget(100, "k", root);
      assert.ok(res.reservationId, "every reservation must be nameable to be releasable");
      assert.equal(listOpenReservations(root).every((r) => r.reservationId), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("src/state.mjs — the rolling 24-hour window", () => {
  // Jules resets the daily allowance on a rolling 24-hour window, not at
  // midnight. The ledger's `ledger-<date>.jsonl` rotation invites counting per
  // calendar day, which is wrong in both directions — these tests pin both.
  const NOW = Date.parse("2026-05-10T00:30:00.000Z");

  it("counts a reservation from 23 hours ago, even though it lives in yesterday's file", () => {
    const root = makeRoot("jok-window-yesterday-");
    try {
      seedLedger(root, [reservedHoursAgo(NOW, 23, "res-old")]);
      const scan = scanBudgetWindow(root, { now: NOW });

      assert.equal(scan.used, 1, "23 hours ago is inside a 24-hour window");
      assert.equal(scan.open[0].reservationId, "res-old");
      assert.equal(
        existsSync(join(root, ".agent", "state", "ledger-2026-05-09.jsonl")),
        true,
        "the entry really is in a different file from today's"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops counting a reservation once it ages past the window", () => {
    const root = makeRoot("jok-window-expired-");
    const now = Date.parse("2026-05-10T12:00:00.000Z");
    try {
      seedLedger(root, [
        reservedHoursAgo(now, 30, "res-expired"),
        reservedHoursAgo(now, 23, "res-live"),
      ]);
      const scan = scanBudgetWindow(root, { now });

      assert.equal(scan.used, 1, "only the reservation inside the window is still spent");
      assert.deepEqual(scan.open.map((r) => r.reservationId), ["res-live"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not hand back a fresh allowance at midnight for a batch dispatched at 23:00", () => {
    // The regression this whole change exists for. Counting per calendar day,
    // an operator who spent their quota at 23:00 saw a clean slate at 00:01 and
    // dispatched again into a provider that refused every one.
    const root = makeRoot("jok-window-midnight-");
    try {
      seedLedger(root, [
        { at: "2026-05-09T23:00:00.000Z", payload: { event: "budget_reserved", reservationId: "res-a" } },
        { at: "2026-05-09T23:05:00.000Z", payload: { event: "budget_reserved", reservationId: "res-b" } },
        { at: "2026-05-09T23:10:00.000Z", payload: { event: "budget_reserved", reservationId: "res-c" } },
      ]);

      const check = checkDailyBudget(root, 3, { now: NOW });
      assert.equal(check.used, 3, "the allowance is still spent 90 minutes later");
      assert.equal(check.ok, false);
      assert.equal(check.remaining, 0);
      assert.equal(
        existsSync(join(root, ".agent", "state", "ledger-2026-05-10.jsonl")),
        false,
        "today's file is empty — a calendar-day count would have reported zero used"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a reservation when yesterday's tasks already fill the window", () => {
    const root = makeRoot("jok-window-refuse-");
    try {
      seedLedger(root, [reservedHoursAgo(NOW, 2, "res-a"), reservedHoursAgo(NOW, 1, "res-b")]);
      assert.throws(() => reserveBudget(root, 2, { now: NOW }), BudgetError);

      // The same ledger a day later must let the work through again.
      const later = NOW + 25 * 3600000;
      const res = reserveBudget(root, 2, { now: later });
      assert.equal(res.ok, true);
      assert.equal(res.used, 1, "the earlier pair has aged out; only this one is spent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps an anonymous release paired to the reservation it cancelled", () => {
    // Legacy id-less reservations can only be matched by position. Recording
    // the released timestamp stops the pair drifting apart when the window
    // advances past the reservation but not yet past its release, which would
    // otherwise silently discount an unrelated, still-live reservation.
    const root = makeRoot("jok-window-anon-pair-");
    try {
      const old = new Date(NOW - 23 * 3600000).toISOString();
      seedLedger(root, [
        { at: old, payload: { event: "budget_reserved" } },
        { at: new Date(NOW - 1 * 3600000).toISOString(), payload: { event: "budget_reserved" } },
        {
          at: new Date(NOW - 30 * 60000).toISOString(),
          payload: { event: "budget_released", releasedTimestamp: old },
        },
      ]);

      assert.equal(scanBudgetWindow(root, { now: NOW }).used, 1, "the named one is released, the other is not");

      // Two hours on, the released reservation has aged out but its release has
      // not. Without the pairing the release would subtract from the survivor.
      const later = NOW + 2 * 3600000;
      assert.equal(scanBudgetWindow(root, { now: later }).used, 1, "the surviving reservation stays charged");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("releaseOpenReservations records that pairing for id-less reservations", () => {
    const root = makeRoot("jok-window-anon-write-");
    try {
      appendLedger({ event: "budget_reserved" }, root);
      const res = releaseOpenReservations({ root });

      assert.equal(res.anonymous, 1);
      const lines = readFileSync(getDailyLedgerPath(root), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const release = lines.find((l) => l.event === "budget_released");
      assert.equal(release.releasedTimestamp, lines[0].timestamp);
      assert.equal(checkDailyBudget(root, 10).used, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads only the files the window can touch", () => {
    const root = makeRoot("jok-window-files-");
    try {
      seedLedger(root, [
        { at: "2026-05-01T10:00:00.000Z", payload: { event: "budget_reserved", reservationId: "ancient" } },
        reservedHoursAgo(NOW, 23, "res-old"),
      ]);
      const paths = getLedgerPathsInWindow(root, NOW).map((p) => p.split(/[\\/]/).pop());

      assert.deepEqual(paths, ["ledger-2026-05-09.jsonl"], "oldest first, and nothing older than the window");
      assert.equal(scanBudgetWindow(root, { now: NOW }).used, 1, "the ancient file is never even opened");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("expires a learned ceiling 24 hours after the refusal, not at midnight", () => {
    const root = makeRoot("jok-window-ceiling-");
    try {
      const observedAt = new Date(NOW - 23 * 3600000).toISOString();
      writeFileSync(
        join(root, ".agent", "state", CEILING_FILE),
        JSON.stringify({ ceiling: 7, day: observedAt.split("T")[0], observedAt, source: "provider-rejection" })
      );

      // 23 hours old and on the previous calendar day: the old rule called this
      // stale and would have unblocked an operator the provider still refuses.
      const live = readObservedCeiling(root, NOW);
      assert.equal(live.stale, false);
      assert.equal(readActiveCeiling(root, NOW).ceiling, 7);
      assert.equal(live.expiresAt, new Date(Date.parse(observedAt) + ROLLING_WINDOW_MS).toISOString());

      const afterExpiry = readObservedCeiling(root, NOW + 2 * 3600000);
      assert.equal(afterExpiry.stale, true, "25 hours on, the refusal says nothing about the current window");
      assert.equal(readActiveCeiling(root, NOW + 2 * 3600000), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("src/budget.mjs — concurrency against the plan ceiling", () => {
  it("reports the tier default as a default, and names the ceiling it holds back from", () => {
    const root = makeRoot("jok-conc-tier-");
    try {
      writeConfig(root, "version: 1\ntier: pro\n");
      const slots = resolveConcurrency(loadConfig(root));

      assert.equal(slots.concurrency, TIER_PRESETS.pro.concurrency);
      assert.equal(slots.ceiling, 15);
      assert.equal(slots.source, "tier");
      assert.equal(slots.overCeiling, false);
      assert.match(slots.note, /allows up to 15/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports an operator figure above the plan ceiling without refusing it", () => {
    // The provider enforces its own slot limit, and a pooled account
    // legitimately exceeds any single plan's. Warning is the kit's business;
    // blocking is not.
    const root = makeRoot("jok-conc-over-");
    try {
      writeConfig(root, "version: 1\ntier: pro\nlimits:\n  concurrency: 40\n");
      const slots = resolveConcurrency(loadConfig(root));

      assert.equal(slots.concurrency, 40, "the stated figure is preserved, not clamped");
      assert.equal(slots.source, "config");
      assert.equal(slots.overCeiling, true);
      assert.match(slots.note, /exceeds what the "pro" plan allows \(15\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("claims no ceiling for the non-vendor enterprise profile", () => {
    const root = makeRoot("jok-conc-ent-");
    try {
      writeConfig(root, "version: 1\ntier: enterprise\nlimits:\n  concurrency: 40\n");
      const slots = resolveConcurrency(loadConfig(root));

      assert.equal(slots.ceiling, 0);
      assert.equal(slots.overCeiling, false, "a pool the kit cannot size cannot be exceeded");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("src/budget.mjs — Multi-User Attribution & Identity", () => {
  it("resolves and sanitizes CLI override correctly (stripping PII / domain)", async () => {
    const { resolveAmbientIdentity } = await import("../src/budget.mjs");
    assert.equal(resolveAmbientIdentity("Alice.Developer@company.com!"), "alice.developer");
  });

  it("prioritizes GITHUB_ACTOR when ambiently running in CI", async () => {
    const { resolveAmbientIdentity } = await import("../src/budget.mjs");
    const orig = process.env.GITHUB_ACTOR;
    try {
      process.env.GITHUB_ACTOR = "JulesReviewer_Bot";
      assert.equal(resolveAmbientIdentity(), "ci-julesreviewer_bot");
    } finally {
      process.env.GITHUB_ACTOR = orig;
    }
  });

  it("records author on budget reservation and aggregates in byUser", () => {
    const root = makeRoot("jok-user-attr-");
    try {
      reserveBudget(root, 300, { author: "alice", enforce: false });
      reserveBudget(root, 300, { author: "bob", enforce: false });
      reserveBudget(root, 300, { author: "alice", enforce: false });

      const status = budgetStatus(loadConfig(root), root);
      assert.equal(status.used, 3);
      assert.equal(status.byUser.alice.tasks, 2);
      assert.equal(status.byUser.bob.tasks, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

