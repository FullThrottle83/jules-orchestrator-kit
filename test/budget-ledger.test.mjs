/**
 * Budget ledger — the domain suite for the append-only accounting that caps
 * and audits agent work:
 *
 *   - the SHA-256 hash-chained daily ledger (src/state.mjs): chaining,
 *     verification, and every tamper/torn-write failure mode;
 *   - daily budget limits: learned ceilings, quota classification, certainty-
 *     gated enforcement, the rolling 24-hour window, concurrency against the
 *     plan ceiling, multi-user attribution and reconciliation;
 *   - VFS mutex / lock concurrency safety that serialises ledger writes;
 *   - the repair-turn oscillation circuit breaker (a limit, like a budget);
 *   - CRLF-normalised rule-file budgets and snake_case limit config.
 *
 * Formed in P08 by merging: budget, kernel-hardening, whack-a-mole, the P-12
 * section of critical-hardening and the CONFIG-001 section of p0-remediation,
 * plus new hash-chain tamper-evidence tests. Bodies moved verbatim.
 */
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmdirSync, rmSync, existsSync, readFileSync, writeFileSync, symlinkSync, renameSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import {
  reserveBudget,
  commitBudgetReservation,
  rollbackBudgetReservation,
  getDailyLedgerPath,
  getLedgerPathsInWindow,
  scanBudgetWindow,
  verifyLedgerIntegrity,
  appendLedger,
  checkDailyBudget,
  reserveDailyBudget,
  ROLLING_WINDOW_MS,
} from "../src/state.mjs";
import { loadConfig, TIER_PRESETS } from "../src/config.mjs";
import { dispatch } from "../src/engine.mjs";
import {
  withVfsMutex,
  MutexTimeoutError,
  isPidAlive,
  getProcessStartTime,
  acquireLock,
  getLockDir,
  reserveBudgetAtomic,
  BudgetError,
} from "../index.mjs";
import { createWhackAMoleDetector } from "../src/remediation.mjs";
import { checkRulesBudget } from "../src/rules-budget.mjs";

// ═══════════════════════════════════════════════════════════════════════════
// From: test/budget.test.mjs
// Moved verbatim by the P08 test consolidation; scoped to its own block.
// ═══════════════════════════════════════════════════════════════════════════
{
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
      // Exactly what older kit versions wrote through the scripts/utils.mjs shim.
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

  it("a live dispatch() attributes its budget reservation to task.author, not just the unit-level reserveBudget() call", async () => {
    // Guards against a regression where the CLI's --author flag (and
    // resolveAmbientIdentity) were wired up and unit-tested in isolation, but
    // never actually threaded through engine.mjs's real dispatch() ->
    // withBudget() call — so agentctl budget --by-user silently attributed
    // every real task to the same default identity no matter who ran it.
    const root = makeRoot("jok-dispatch-attr-");
    try {
      const config = { provider: "jules", scope: { deny: [] }, limits: { promptKb: 50, dailyTasks: 300 }, router: { enabled: false } };
      const mockProvider = { dispatch: async () => ({ id: "sess-live-1" }) };

      await dispatch({ title: "T", prompt: "Fix a typo.", author: "alice" }, { root, config, provider: mockProvider });

      const status = budgetStatus(loadConfig(root), root);
      assert.equal(status.used, 1);
      assert.equal(status.byUser.alice.tasks, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
}

// ═══════════════════════════════════════════════════════════════════════════
// From: test/kernel-hardening.test.mjs
// Moved verbatim by the P08 test consolidation; scoped to its own block.
// ═══════════════════════════════════════════════════════════════════════════
{
describe("Kernel Hardening & Concurrency Safety", () => {
  test("a) withVfsMutex throws MutexTimeoutError on timeout and DOES NOT execute callback", () => {
    const testDir = join(process.cwd(), ".agent/test-mutex-timeout-" + Date.now());
    mkdirSync(testDir, { recursive: true });
    const mutexDir = join(testDir, ".test.mutex");
    mkdirSync(mutexDir); // Simulate mutex lock already held by another process

    let callbackExecuted = false;

    try {
      assert.throws(
        () => {
          withVfsMutex(
            mutexDir,
            () => {
              callbackExecuted = true;
            },
            { maxRetries: 5, retryDelayMs: 2 }
          );
        },
        (err) => err instanceof MutexTimeoutError && err.name === "MutexTimeoutError"
      );

      assert.strictEqual(callbackExecuted, false, "Callback must NOT execute when mutex acquisition times out");
    } finally {
      try { rmdirSync(mutexDir); } catch (_) {}
      try { rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  test("b) Stale lock with recycled/mismatched PID starttime is successfully reaped", () => {
    const testDir = join(process.cwd(), ".agent/test-stale-lock-" + Date.now());
    mkdirSync(testDir, { recursive: true });
    const lockDir = getLockDir(testDir);
    const taskId = "task-stale-pid-test";
    const lockFile = join(lockDir, `${taskId}.json`);

    try {
      // Create a lock payload with alive process.pid but a mismatched starttime
      const mismatchedPayload = {
        agent: "stale-worker",
        taskId,
        files: ["src/state.mjs"],
        pid: process.pid,
        processStartTime: "999999999",
        starttime: "999999999",
        nonce: "stale-nonce-12345",
        hostname: "localhost",
        acquiredAt: new Date().toISOString(),
      };
      writeFileSync(lockFile, JSON.stringify(mismatchedPayload, null, 2), "utf-8");

      // Verify isPidAlive returns false for process.pid when expectedStartTime is mismatched on Linux/macOS
      if (process.platform === "linux" || process.platform === "darwin") {
        const alive = isPidAlive(process.pid, "999999999");
        assert.strictEqual(alive, false, "isPidAlive must return false for mismatched PID starttime");
      }

      // acquireLock must detect stale PID starttime, reap the lock file, and acquire lock successfully
      if (process.platform === "linux" || process.platform === "darwin") {
        const res = acquireLock("new-worker", taskId, ["src/state.mjs"], testDir);
        assert.strictEqual(res.ok, true, "acquireLock should succeed after reaping stale lock");
        assert.strictEqual(res.lockFile, lockFile);

        // Verify new lock contents
        const newLock = JSON.parse(readFileSync(lockFile, "utf-8"));
        assert.strictEqual(newLock.agent, "new-worker");
        assert.strictEqual(newLock.pid, process.pid);
        assert.ok(newLock.nonce, "Lock payload must contain a random UUID nonce");

        if (process.platform === "linux") {
          const actualStart = getProcessStartTime(process.pid);
          assert.strictEqual(String(newLock.processStartTime), String(actualStart));
        }
      }
    } finally {
      try { rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  test("c) 20 concurrent reservation calls against budget limit 3 results in exactly 3 successes and 17 rejections", async () => {
    const testDir = join(process.cwd(), ".agent/test-concurrent-budget-" + Date.now());
    mkdirSync(testDir, { recursive: true });
    const limit = 3;

    try {
      const tasks = Array.from({ length: 20 }, () => {
        return new Promise((resolve) => {
          setImmediate(() => {
            try {
              const res = reserveBudgetAtomic(testDir, limit);
              resolve({ ok: true, value: res });
            } catch (err) {
              resolve({ ok: false, error: err });
            }
          });
        });
      });

      const results = await Promise.all(tasks);
      const successes = results.filter((r) => r.ok);
      const failures = results.filter((r) => !r.ok);

      assert.strictEqual(successes.length, 3, "Exactly 3 reservations must succeed");
      assert.strictEqual(failures.length, 17, "Exactly 17 reservations must be rejected");

      for (const failure of failures) {
        assert.ok(failure.error instanceof BudgetError, "Failure error must be an instance of BudgetError");
        assert.strictEqual(failure.error.code, 7, "BudgetError code must be 7");
      }

      // Verify ledger file integrity and entry count
      const dateStr = new Date().toISOString().split("T")[0];
      const ledgerPath = join(testDir, ".agent/state", `ledger-${dateStr}.jsonl`);
      assert.strictEqual(existsSync(ledgerPath), true, "Ledger file must exist");

      const lines = readFileSync(ledgerPath, "utf-8").split("\n").filter(Boolean);
      assert.strictEqual(lines.length, 3, "Ledger must contain exactly 3 reservation entries");

      const integrity = verifyLedgerIntegrity(ledgerPath);
      assert.strictEqual(integrity.ok, true, "Ledger hash-chain integrity must pass verification");
      assert.strictEqual(integrity.count, 3);
    } finally {
      try { rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
    }
  });
});
}

// ═══════════════════════════════════════════════════════════════════════════
// From: test/kernel-hardening.test.mjs — test (d), added on main by P04
// (60300c2) after this file was consolidated; ported verbatim.
// ═══════════════════════════════════════════════════════════════════════════
{
describe("Kernel Hardening & Concurrency Safety", () => {
  test("d) verifyLedgerIntegrity fails closed on unhashed, truncated, and tampered lines", () => {
    const testDir = join(process.cwd(), ".agent/test-ledger-fail-closed-" + Date.now());
    const ledgerPath = join(testDir, "ledger.jsonl");
    mkdirSync(testDir, { recursive: true });

    try {
      // An unhashed line is exactly what the deleted scripts/utils.mjs shim
      // used to bless with { ok: true, lastHash: "sha256-verified" }. It must
      // now fail closed: no hash fields, no verdict of "intact".
      writeFileSync(ledgerPath, JSON.stringify({ timestamp: new Date().toISOString(), event: "budget_reserved" }) + "\n");
      let res = verifyLedgerIntegrity(ledgerPath);
      assert.strictEqual(res.ok, false, "Unhashed ledger entries must NOT pass verification");
      assert.strictEqual(res.error, "MISSING_HASH_FIELDS");
      assert.strictEqual(res.line, 1);

      // A genuine hash chain, built through the kit's own appendLedger.
      rmSync(ledgerPath);
      const first = appendLedger({ event: "budget_reserved", key: "alpha" }, testDir);
      const second = appendLedger({ event: "session_dispatched", key: "alpha" }, testDir);
      const chainedPath = getDailyLedgerPath(testDir);
      res = verifyLedgerIntegrity(chainedPath);
      assert.strictEqual(res.ok, true, "clean chain must verify");
      assert.strictEqual(res.count, 2);
      assert.strictEqual(second.prevHash, first.hash, "second entry links to the first hash");
      assert.strictEqual(res.lastHash, second.hash);

      const lines = readFileSync(chainedPath, "utf-8").split("\n").filter(Boolean);

      // A truncated (torn) final line after an otherwise valid chain must
      // fail closed as corruption, not be skipped as an incomplete append.
      appendFileSync(chainedPath, '{"timestamp":"2020-01-01T00:00:00.000Z","event":"bud');
      res = verifyLedgerIntegrity(chainedPath);
      assert.strictEqual(res.ok, false, "Truncated ledger line must not pass verification");
      assert.strictEqual(res.error, "TORN_WRITE_CORRUPTION");
      assert.strictEqual(res.line, 3);
      writeFileSync(chainedPath, lines.join("\n") + "\n");
      assert.strictEqual(verifyLedgerIntegrity(chainedPath).ok, true, "restored chain verifies again");

      // Tampering: flip a payload field on the head line, keep it valid JSON.
      const head = JSON.parse(lines[0]);
      head.event = "budget_rolled_back";
      writeFileSync(chainedPath, JSON.stringify(head) + "\n" + lines.slice(1).join("\n") + "\n");
      res = verifyLedgerIntegrity(chainedPath);
      assert.strictEqual(res.ok, false, "Edited payload must break the recomputed SHA-256");
      assert.strictEqual(res.error, "CORRUPTED_ENTRY_HASH");

      // Truncation of a valid chain (drop the head, orphan the tail) must fail closed.
      writeFileSync(chainedPath, lines.slice(1).join("\n") + "\n");
      res = verifyLedgerIntegrity(chainedPath);
      assert.strictEqual(res.ok, false, "Removed ledger line must break prevHash linkage");
      assert.strictEqual(res.error, "BROKEN_PREV_HASH");

      // Regression guard: the bypass must never come back. scripts/utils.mjs
      // may not re-implement verification — it may only forward to the secure
      // implementation in src/state.mjs (or be gone entirely).
      const utilsPath = fileURLToPath(new URL("../scripts/utils.mjs", import.meta.url));
      if (existsSync(utilsPath)) {
        const utilsSrc = readFileSync(utilsPath, "utf-8");
        assert.ok(
          !/function\s+verifyLedgerIntegrity\b/.test(utilsSrc),
          "scripts/utils.mjs must not define its own verifyLedgerIntegrity"
        );
        assert.ok(
          /export\s*\{[^}]*verifyLedgerIntegrity[^}]*\}\s*from\s*"\.\.\/src\/state\.mjs"/.test(utilsSrc),
          "scripts/utils.mjs must re-export verifyLedgerIntegrity from src/state.mjs"
        );
      }
    } finally {
      try { rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
    }
  });
});

}
// ═══════════════════════════════════════════════════════════════════════════
// From: test/whack-a-mole.test.mjs — repair-turn oscillation circuit breaker
// Moved verbatim by the P08 test consolidation; scoped to its own block.
// ═══════════════════════════════════════════════════════════════════════════
{
test("Whack-a-Mole Test-Oscillation Cycle Detector", async (t) => {
  await t.test("allows progressing non-repeating test outcomes", () => {
    const detector = createWhackAMoleDetector({ threshold: 2 });

    const r1 = detector.recordTestOutcome(["TestAuth", "TestOrder"]);
    assert.equal(r1.whackAMole, false);

    const r2 = detector.recordTestOutcome(["TestPayment"]);
    assert.equal(r2.whackAMole, false);

    const r3 = detector.recordTestOutcome([]);
    assert.equal(r3.whackAMole, false);
  });

  await t.test("detects alternating test failure oscillation (TestA -> TestB -> TestA)", () => {
    const detector = createWhackAMoleDetector({ threshold: 2 });

    // Repair turn 1: Test A fails
    const r1 = detector.recordTestOutcome(["TestA"]);
    assert.equal(r1.whackAMole, false);

    // Repair turn 2: Test A fixed, but Test B broke
    const r2 = detector.recordTestOutcome(["TestB"]);
    assert.equal(r2.whackAMole, false);

    // Repair turn 3: Test B fixed, but Test A broke again (Whack-a-Mole!)
    const r3 = detector.recordTestOutcome(["TestA"]);
    assert.equal(r3.whackAMole, true);
    assert.equal(r3.occurrences, 2);
    assert.equal(r3.cycleLength, 2);
    assert.ok(r3.oscillatingTests.includes("TestA"));
    assert.ok(r3.oscillatingTests.includes("TestB"));
    assert.match(r3.promptDirective, /Test Oscillation Circuit Breaker Activated/);
    assert.match(r3.promptDirective, /<UNTRUSTED>(TestA <-> TestB|TestB <-> TestA)<\/UNTRUSTED>/);
  });

  await t.test("handles multi-test set oscillation and array/string normalization", () => {
    const detector = createWhackAMoleDetector({ threshold: 2 });

    detector.recordTestOutcome("TestUser::test_login");
    detector.recordTestOutcome("TestCart::test_checkout");

    const r3 = detector.recordTestOutcome("TestUser::test_login");
    assert.equal(r3.whackAMole, true);
    assert.ok(r3.oscillatingTests.includes("TestUser::test_login"));
    assert.ok(r3.oscillatingTests.includes("TestCart::test_checkout"));
  });

  await t.test("reset() clears history and restores detector", () => {
    const detector = createWhackAMoleDetector({ threshold: 2 });

    detector.recordTestOutcome(["TestX"]);
    detector.recordTestOutcome(["TestY"]);
    detector.reset();

    const r = detector.recordTestOutcome(["TestX"]);
    assert.equal(r.whackAMole, false);
  });
});
}

// ═══════════════════════════════════════════════════════════════════════════
// From: test/critical-hardening.test.mjs — P-12 rules budget
// Moved verbatim by the P08 test consolidation; scoped to its own block.
// ═══════════════════════════════════════════════════════════════════════════
{
describe("P-12: CRLF normalisation before rules budget accounting", () => {
  it("counts a CRLF file by its LF-normalised length", () => {
    const dir = mkdtempSync(join(tmpdir(), "rules-crlf-"));
    try {
      // 10 letters + 9 newlines = 19 chars once CRLF is normalised to LF; the
      // raw CRLF form is 28 chars and would have falsely tripped a 19-char cap.
      const crlf = "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\ni\r\nj";
      writeFileSync(join(dir, "AGENTS.md"), crlf, "utf-8");
      const res = checkRulesBudget(dir, { maxChars: 19, maxLines: 100 });
      assert.equal(res.ok, true);
      assert.equal(res.violations.length, 0);

      // The same content as LF measures identically, proving the two dialects
      // no longer disagree.
      const lfDir = mkdtempSync(join(tmpdir(), "rules-lf-"));
      try {
        writeFileSync(join(lfDir, "AGENTS.md"), crlf.replace(/\r\n/g, "\n"), "utf-8");
        assert.equal(checkRulesBudget(lfDir, { maxChars: 19, maxLines: 100 }).ok, true);
      } finally {
        rmSync(lfDir, { recursive: true, force: true });
      }

      // A file one character over the budget still fails, and the reported
      // charCount is the normalised one.
      writeFileSync(join(dir, "AGENTS.md"), crlf.replace(/j$/, "jj"), "utf-8");
      const over = checkRulesBudget(dir, { maxChars: 19, maxLines: 100 });
      assert.equal(over.ok, false);
      assert.equal(over.violations[0].charCount, 20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});}

// ═══════════════════════════════════════════════════════════════════════════
// From: test/p0-remediation.test.mjs — CONFIG-001
// Moved verbatim by the P08 test consolidation; scoped to its own block.
// ═══════════════════════════════════════════════════════════════════════════
{
test("CONFIG-001: Snake-Case Config Limit Support", async (t) => {
  await t.test("loadConfig maps snake_case limits to camelCase correctly", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "jules-config-test-"));
    try {
      const agentDir = join(tmpDir, ".agent");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, "config.yml"),
        `limits:\n  diff_kb: 42\n  daily_tasks: 19\n  repair_attempts: 5\n`
      );

      const cfg = loadConfig(tmpDir);
      assert.equal(cfg.limits.diffKb, 42);
      assert.equal(cfg.limits.dailyTasks, 19);
      assert.equal(cfg.limits.repairAttempts, 5);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});}

// ═══════════════════════════════════════════════════════════════════════════
// New: hash-chain tamper evidence and daily limit enforcement
// Written new in P08 for offline coverage of the merged domain.
// ═══════════════════════════════════════════════════════════════════════════
/**
 * P08 addition: the SHA-256 hash chain is the ledger's tamper evidence, so the
 * failure branches of `verifyLedgerIntegrity` are themselves a safety gate —
 * a verifier that always said "ok" would bless a forged ledger.
 */

describe("src/state.mjs — SHA-256 hash-chain tamper evidence", () => {
  it("chains entries by prevHash and verifies clean end-to-end", () => {
    const root = mkdtempSync(join(tmpdir(), "jok-chain-clean-"));
    try {
      const e1 = appendLedger({ event: "probe", n: 1 }, root);
      const e2 = appendLedger({ event: "probe", n: 2 }, root);
      const e3 = appendLedger({ event: "probe", n: 3 }, root);

      assert.equal(e1.prevHash, "0".repeat(64), "the genesis entry chains from 64 zeroes");
      assert.equal(e2.prevHash, e1.hash, "each entry chains from its predecessor");
      assert.equal(e3.prevHash, e2.hash);

      const verdict = verifyLedgerIntegrity(getDailyLedgerPath(root));
      assert.equal(verdict.ok, true);
      assert.equal(verdict.count, 3);
      assert.equal(verdict.lastHash, e3.hash, "the reported chain head is the last append");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags a mutated middle entry as CORRUPTED_ENTRY_HASH at its line", () => {
    const root = mkdtempSync(join(tmpdir(), "jok-chain-mutate-"));
    try {
      appendLedger({ event: "a", n: 1 }, root);
      appendLedger({ event: "b", n: 2 }, root);
      appendLedger({ event: "c", n: 3 }, root);

      const path = getDailyLedgerPath(root);
      const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
      const forged = JSON.parse(lines[1]);
      forged.event = "forged-after-the-fact";
      lines[1] = JSON.stringify(forged);
      writeFileSync(path, lines.join("\n") + "\n", "utf-8");

      const verdict = verifyLedgerIntegrity(path);
      assert.equal(verdict.ok, false, "an edited payload must break its entry hash");
      assert.equal(verdict.error, "CORRUPTED_ENTRY_HASH");
      assert.equal(verdict.line, 2, "the report names the forged line");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags a deleted middle entry as BROKEN_PREV_HASH", () => {
    const root = mkdtempSync(join(tmpdir(), "jok-chain-delete-"));
    try {
      appendLedger({ event: "a", n: 1 }, root);
      appendLedger({ event: "b", n: 2 }, root);
      appendLedger({ event: "c", n: 3 }, root);

      const path = getDailyLedgerPath(root);
      const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
      lines.splice(1, 1); // erase the middle entry — the history now lies
      writeFileSync(path, lines.join("\n") + "\n", "utf-8");

      const verdict = verifyLedgerIntegrity(path);
      assert.equal(verdict.ok, false, "removing an entry must break the successor's prevHash");
      assert.equal(verdict.error, "BROKEN_PREV_HASH");
      assert.equal(verdict.line, 2);
      assert.equal(verdict.actual, JSON.parse(lines[1]).prevHash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags a torn write (truncated trailing line) as TORN_WRITE_CORRUPTION", () => {
    const root = mkdtempSync(join(tmpdir(), "jok-chain-torn-"));
    try {
      appendLedger({ event: "a", n: 1 }, root);
      const path = getDailyLedgerPath(root);
      const raw = readFileSync(path, "utf-8");
      // Half a JSON line is what a process killed mid-append leaves behind.
      writeFileSync(path, raw + JSON.stringify({ event: "torn", prevHash: "x" }).slice(0, 18), "utf-8");

      const verdict = verifyLedgerIntegrity(path);
      assert.equal(verdict.ok, false, "a torn final line must not verify as clean");
      assert.equal(verdict.error, "TORN_WRITE_CORRUPTION");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags an entry stripped of its hash fields as MISSING_HASH_FIELDS", () => {
    const root = mkdtempSync(join(tmpdir(), "jok-chain-strip-"));
    try {
      appendLedger({ event: "a", n: 1 }, root);
      const path = getDailyLedgerPath(root);
      const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
      const stripped = JSON.parse(lines[0]);
      delete stripped.hash;
      delete stripped.prevHash;
      lines.push(JSON.stringify(stripped));
      writeFileSync(path, lines.join("\n") + "\n", "utf-8");

      const verdict = verifyLedgerIntegrity(path);
      assert.equal(verdict.ok, false, "a hand-written entry without hashes must be rejected");
      assert.equal(verdict.error, "MISSING_HASH_FIELDS");
      assert.equal(verdict.line, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to append through a symbolic link", () => {
    const root = mkdtempSync(join(tmpdir(), "jok-chain-symlink-"));
    try {
      appendLedger({ event: "a", n: 1 }, root);
      const path = getDailyLedgerPath(root);
      const victim = join(root, "victim.jsonl");
      renameSync(path, victim);
      symlinkSync(victim, path);

      assert.throws(
        () => appendLedger({ event: "b", n: 2 }, root),
        /Refusing to append to symbolic link/,
        "a symlinked ledger would let one file redirect every future audit entry"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports FILE_NOT_FOUND for a ledger that does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "jok-chain-missing-"));
    try {
      const verdict = verifyLedgerIntegrity(join(root, "absent.jsonl"));
      assert.deepEqual(verdict, { ok: false, count: 0, error: "FILE_NOT_FOUND" });
      assert.equal(existsSync(join(root, "absent.jsonl")), false, "verification must not create the file");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("daily budget limit enforcement on the ledger", () => {
  it("stops reserving at the daily limit, and rejected attempts leave the chain verifiable", () => {
    const root = mkdtempSync(join(tmpdir(), "jok-daily-cap-"));
    try {
      const first = reserveBudget(root, 2);
      const second = reserveBudget(root, 2);
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      assert.equal(second.remaining, 0, "the second reservation exhausts a limit of 2");

      assert.throws(
        () => reserveBudget(root, 2),
        (err) => err instanceof BudgetError && /Daily budget exhausted \(2\/2/.test(err.message)
      );

      assert.equal(checkDailyBudget(root, 300).used, 2, "the rejected third attempt consumed no slot");
      const verdict = verifyLedgerIntegrity(getDailyLedgerPath(root));
      assert.equal(verdict.ok, true, "rejections happen before any append, so the chain stays intact");
      assert.equal(verdict.count, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
