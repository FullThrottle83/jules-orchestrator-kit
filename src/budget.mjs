import { existsSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { join } from "node:path";
import { resolveRoot } from "./config.mjs";
import {
  getStateDir,
  ensureDir,
  appendLedger,
  checkDailyBudget,
  scanBudgetWindow,
  ROLLING_WINDOW_MS,
} from "./state.mjs";

/**
 * Where the observed quota ceiling lives, outside the ledger so it survives
 * rotation.
 *
 * Deliberately short-lived. The local ledger only counts tasks dispatched from
 * *this* checkout, while the account's quota is also spent from the web UI and
 * other machines, so the local count at the moment of a refusal is a lower
 * bound on the real allowance — not the allowance. Treated as permanent it
 * would hard-block the operator below their own quota, which is the exact
 * failure this whole mechanism exists to prevent.
 *
 * What it does mean is precise and useful: within the last 24 hours the
 * provider started refusing, so stop asking until that refusal ages out.
 */
export const CEILING_FILE = "budget-ceiling.json";

/** Local calendar day, retained as the fallback key for pre-0.34 records. */
function today() {
  return new Date().toISOString().split("T")[0];
}

/**
 * Signals that a provider rejection means "you are out of quota for today"
 * rather than "you are going too fast right now". A 429 alone cannot tell the
 * two apart, and learning a ceiling from a per-minute throttle would pin the
 * daily limit to whatever burst happened to trip it.
 */
const DAILY_QUOTA_HINT = /resource[_\s-]?exhausted|daily|per[\s-]?day|quota/i;
const TRANSIENT_HINT = /per[\s-]?minute|per[\s-]?second|too many requests|slow down|retry[\s-]?after/i;

/**
 * Decide whether a provider error is evidence of a daily quota ceiling.
 *
 * Deliberately conservative: an unrecognised rejection teaches nothing. A
 * missed lesson costs one wasted API call, whereas a ceiling learned from a
 * burst throttle would be recorded as certain and would then hard-block the
 * operator well below their real allowance.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isDailyQuotaRejection(err) {
  if (!err || typeof err !== "object") return false;
  const status = /** @type {any} */ (err).status;
  if (status !== 429 && status !== 403) return false;
  const text = `${/** @type {any} */ (err).message || ""} ${/** @type {any} */ (err).body || ""}`;
  if (TRANSIENT_HINT.test(text)) return false;
  return DAILY_QUOTA_HINT.test(text);
}

function writeAtomic(filePath, content) {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  const fd = openSync(tmpPath, "w");
  try {
    writeFileSync(fd, content, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, filePath);
}

/**
 * Read the stored ceiling, whenever it was observed.
 *
 * A refusal expires 24 hours after it happened, matching the window the quota
 * itself resets on. Expiring it at midnight instead — as this did before —
 * either freed the operator hours before the provider would, or kept them
 * blocked hours after it already had.
 *
 * @param {string} [root]
 * @param {number} [now] - Epoch ms; injectable for tests.
 * @returns {{ ceiling: number, day: string, observedAt: string, source: string, stale: boolean, expiresAt: string, msRemaining: number } | null}
 */
export function readObservedCeiling(root = resolveRoot(), now = Date.now()) {
  const filePath = join(getStateDir(root), CEILING_FILE);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    if (!parsed || typeof parsed.ceiling !== "number" || !Number.isFinite(parsed.ceiling)) return null;
    if (parsed.ceiling < 0) return null;
    const day = typeof parsed.day === "string" ? parsed.day : String(parsed.observedAt || "").slice(0, 10);
    const observedAt = typeof parsed.observedAt === "string" ? parsed.observedAt : "";

    // Records written before 0.34.0 carry only a day. Falling back to the old
    // calendar comparison keeps them honest rather than reviving a ceiling
    // whose age cannot be established.
    const observedMs = Date.parse(observedAt);
    const dated = Number.isFinite(observedMs);
    const age = dated ? now - observedMs : Number.POSITIVE_INFINITY;
    const stale = dated ? age >= ROLLING_WINDOW_MS : day !== today();

    return {
      ceiling: Math.floor(parsed.ceiling),
      day,
      observedAt,
      source: typeof parsed.source === "string" ? parsed.source : "provider-rejection",
      stale,
      expiresAt: dated ? new Date(observedMs + ROLLING_WINDOW_MS).toISOString() : "",
      msRemaining: dated ? Math.max(0, ROLLING_WINDOW_MS - age) : 0,
    };
  } catch (_) {
    return null;
  }
}

/**
 * The ceiling only if it still applies — i.e. observed today.
 * @param {string} [root]
 */
export function readActiveCeiling(root = resolveRoot(), now = Date.now()) {
  const rec = readObservedCeiling(root, now);
  return rec && !rec.stale ? rec : null;
}

/**
 * Record that the provider refused further work after `usedAtRejection` tasks
 * were dispatched locally inside the current window.
 *
 * Zero is a legitimate value: it means the quota was already spent elsewhere
 * (the web UI, another machine) before this checkout dispatched anything.
 *
 * @param {number} usedAtRejection - Tasks reserved locally when the refusal came.
 * @param {string} [root]
 * @param {object} [meta]
 * @returns {{ ceiling: number, day: string, observedAt: string, source: string } | null}
 */
export function recordObservedCeiling(usedAtRejection, root = resolveRoot(), meta = {}) {
  const ceiling = Math.floor(Number(usedAtRejection));
  if (!Number.isFinite(ceiling) || ceiling < 0) return null;

  const stateDir = getStateDir(root);
  ensureDir(stateDir);
  const record = {
    ceiling,
    day: today(),
    observedAt: new Date().toISOString(),
    source: meta.source || "provider-rejection",
  };
  writeAtomic(join(stateDir, CEILING_FILE), JSON.stringify(record, null, 2) + "\n");

  // Mirrored into the hash-chained ledger so the change is auditable; the JSON
  // file above is only a cheap index that survives ledger rotation.
  try {
    appendLedger({ event: "budget_ceiling_observed", ceiling, source: record.source }, root);
  } catch (_) {}

  return record;
}

/**
 * Resolve today's effective task limit *and how much we trust it*.
 *
 * Precedence, most to least authoritative:
 *   1. `limits.daily_tasks` written explicitly in .agent/config.yml, or
 *      JULES_DAILY_BUDGET — the operator stating their own plan.
 *   2. A ceiling the provider demonstrated by refusing work.
 *   3. The tier preset — a guess, and marked as one.
 *
 * `certain` is what callers must branch on: an uncertain limit may warn but
 * must not hard-block, because refusing a request the provider would have
 * accepted breaks the tool for anyone whose plan we guessed wrong.
 *
 * @param {object} config - A config from loadConfig().
 * @param {string} [root]
 * @returns {{ limit: number, source: "config"|"env"|"learned"|"tier"|"default", certain: boolean, note: string }}
 */
export function resolveDailyLimit(config, root = resolveRoot()) {
  const provenance = config?.provenance?.dailyTasks || "default";
  const configured = Number(config?.limits?.dailyTasks);

  // `>= 0`, not `> 0`: a limit of zero is a deliberate "dispatch nothing", and
  // treating it as absent would silently fall through to a permissive estimate.
  if ((provenance === "config" || provenance === "env") && Number.isFinite(configured) && configured >= 0) {
    return {
      limit: configured,
      source: provenance,
      certain: true,
      note: provenance === "env" ? "set via JULES_DAILY_BUDGET" : "set in .agent/config.yml",
    };
  }

  // Only a refusal from the last 24 hours may enforce. An older one says
  // nothing about the remaining quota, and carrying it forward would keep the
  // operator locked out after the window had already reset.
  const learned = readActiveCeiling(root);
  if (learned) {
    const hours = Math.max(1, Math.round(learned.msRemaining / 3600000));
    return {
      limit: learned.ceiling,
      source: "learned",
      certain: true,
      note: `the provider refused further work after ${learned.ceiling} local task(s); that refusal ages out in ~${hours}h`,
    };
  }

  const fallback = Number.isFinite(configured) && configured > 0 ? configured : 300;
  return {
    limit: fallback,
    source: provenance === "tier" ? "tier" : "default",
    certain: false,
    note: `estimated from tier "${config?.tier || "unknown"}" — set limits.daily_tasks to make this exact`,
  };
}

/**
 * Resolve how many workers may run at once, and against what ceiling.
 *
 * The same provenance rule as {@link resolveDailyLimit}: a figure the operator
 * stated is authoritative, a tier preset is a default. The difference is that
 * exceeding this one is not the kit's call to refuse — the provider enforces
 * its own slot limit, and an operator pooling several accounts legitimately
 * runs past any single plan's ceiling. So an overrun is reported, never
 * blocked.
 *
 * @param {object} config - A config from loadConfig().
 * @returns {{ concurrency: number, ceiling: number, source: "config"|"tier", overCeiling: boolean, note: string }}
 */
export function resolveConcurrency(config) {
  const concurrency = Math.max(1, Math.floor(Number(config?.limits?.concurrency) || 1));
  const ceiling = Math.floor(Number(config?.limits?.maxConcurrency) || 0);
  const source = config?.provenance?.concurrency === "config" ? "config" : "tier";
  const overCeiling = ceiling > 0 && concurrency > ceiling;
  const tier = config?.tier || "unknown";

  let note;
  if (overCeiling) {
    note = `${concurrency} workers exceeds what the "${tier}" plan allows (${ceiling}); sessions past the ${ceiling}th will be refused unless the account pools several plans`;
  } else if (source === "config") {
    note = ceiling > 0 ? `set in .agent/config.yml (plan allows up to ${ceiling})` : "set in .agent/config.yml";
  } else {
    note = ceiling > 0
      ? `tier default for "${tier}" — the plan allows up to ${ceiling}, held back to leave slots for sessions this ledger cannot see`
      : `tier default for "${tier}"`;
  }
  return { concurrency, ceiling, source, overCeiling, note };
}

/**
 * List reservations the rolling 24-hour window still counts as spent.
 *
 * A reservation is open until a `budget_rolled_back` or `budget_released` entry
 * names it. `budget_committed` deliberately does not close one — a committed
 * dispatch really did consume quota — so the open set is "everything reserved
 * inside the window that was not given back".
 *
 * Anonymous reservations (no `reservationId`, as older kit versions wrote them)
 * appear as records with `reservationId: null`. They must, or a reconcile would
 * silently leave them charged: the counter counts them, and with no id there is
 * nothing a targeted release could name.
 *
 * @param {string} [root]
 * @param {object} [opts] - Forwarded to scanBudgetWindow (`now`, `windowMs`).
 * @returns {{ reservationId: string|null, timestamp: string, committed: boolean }[]}
 */
export function listOpenReservations(root = resolveRoot(), opts = {}) {
  return scanBudgetWindow(root, opts).open;
}

/**
 * Give the window's open reservations back, by appending `budget_released` entries.
 *
 * The ledger is append-only and hash-chained, so a miscounted day is corrected
 * forwards — never by editing or deleting the file, which would break the chain
 * and destroy the audit trail the ledger exists to provide.
 *
 * This is an operator override, not an inference. The kit cannot tell a
 * reservation that reached the provider from one whose process died first, so
 * only the operator knows whether the local count still reflects reality.
 *
 * @param {object} [opts]
 * @param {string} [opts.root]
 * @param {string} [opts.reason] - Recorded on every released entry.
 * @param {boolean} [opts.dryRun] - Report what would be released, write nothing.
 * @returns {{ released: number, committed: number, uncommitted: number, ids: string[], dryRun: boolean }}
 */
export function releaseOpenReservations(opts = {}) {
  const root = opts.root || resolveRoot();
  const openRecords = listOpenReservations(root);
  const committed = openRecords.filter((r) => r.committed).length;

  const result = {
    released: openRecords.length,
    committed,
    uncommitted: openRecords.length - committed,
    anonymous: openRecords.filter((r) => !r.reservationId).length,
    ids: openRecords.map((r) => r.reservationId).filter(Boolean),
    dryRun: Boolean(opts.dryRun),
  };
  if (opts.dryRun || openRecords.length === 0) return result;

  for (const rec of openRecords) {
    const entry = { event: "budget_released", reason: opts.reason || "operator-reconcile" };
    if (rec.reservationId) {
      entry.reservationId = rec.reservationId;
    } else {
      // An anonymous reservation is released by an equally anonymous entry —
      // naming an id here would leave the original charged and subtract from
      // someone else's total instead. The timestamp pins which one it cancels,
      // so the pair does not drift apart as the rolling window advances past
      // the reservation but not yet past its release.
      entry.releasedTimestamp = rec.timestamp;
    }
    appendLedger(entry, root);
  }
  return result;
}

/**
 * Human-readable budget status for the CLI, dashboard and MCP surface.
 * @param {object} config
 * @param {string} [root]
 */
export function budgetStatus(config, root = resolveRoot()) {
  const resolved = resolveDailyLimit(config, root);
  const check = checkDailyBudget(root, resolved.limit);
  return {
    used: check.used,
    limit: resolved.limit,
    remaining: check.remaining,
    tier: config?.tier || "unknown",
    source: resolved.source,
    certain: resolved.certain,
    note: resolved.note,
    // The count is a rolling 24h window, not a calendar day — surfaced so a
    // caller reporting "used today" cannot quietly mean something else.
    windowStart: check.windowStart || "",
    windowHours: ROLLING_WINDOW_MS / 3600000,
    // Only a limit we actually know may stop a dispatch.
    enforced: resolved.certain,
    exhausted: check.used >= resolved.limit,
  };
}
