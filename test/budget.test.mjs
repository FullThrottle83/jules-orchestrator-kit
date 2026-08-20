import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveDailyLimit,
  readObservedCeiling,
  readActiveCeiling,
  recordObservedCeiling,
  isDailyQuotaRejection,
  budgetStatus,
  listOpenReservations,
  releaseOpenReservations,
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
  verifyLedgerIntegrity,
  appendLedger,
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
