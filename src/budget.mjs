import { existsSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { join } from "node:path";
import { resolveRoot } from "./config.mjs";
import { getStateDir, getDailyLedgerPath, ensureDir, appendLedger, checkDailyBudget } from "./state.mjs";

/**
 * Where the observed quota ceiling lives, outside the ledger so it survives
 * rotation.
 *
 * Deliberately scoped to the day it was observed. The local ledger only counts
 * tasks dispatched from *this* checkout, while the account's quota is also
 * spent from the web UI and other machines, so the local count at the moment of
 * a refusal is a lower bound on the real allowance — not the allowance. Treated
 * as permanent it would hard-block the operator below their own quota, which is
 * the exact failure this whole mechanism exists to prevent.
 *
 * What it does mean is precise and useful: *today* the provider has started
 * refusing, so stop asking until tomorrow.
 */
export const CEILING_FILE = "budget-ceiling.json";

/** Local calendar day, matching the ledger's own rotation key. */
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
 * @param {string} [root]
 * @returns {{ ceiling: number, day: string, observedAt: string, source: string, stale: boolean } | null}
 */
export function readObservedCeiling(root = resolveRoot()) {
  const filePath = join(getStateDir(root), CEILING_FILE);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    if (!parsed || typeof parsed.ceiling !== "number" || !Number.isFinite(parsed.ceiling)) return null;
    if (parsed.ceiling < 0) return null;
    const day = typeof parsed.day === "string" ? parsed.day : String(parsed.observedAt || "").slice(0, 10);
    return {
      ceiling: Math.floor(parsed.ceiling),
      day,
      observedAt: typeof parsed.observedAt === "string" ? parsed.observedAt : "",
      source: typeof parsed.source === "string" ? parsed.source : "provider-rejection",
      stale: day !== today(),
    };
  } catch (_) {
    return null;
  }
}

/**
 * The ceiling only if it still applies — i.e. observed today.
 * @param {string} [root]
 */
export function readActiveCeiling(root = resolveRoot()) {
  const rec = readObservedCeiling(root);
  return rec && !rec.stale ? rec : null;
}

/**
 * Record that the provider refused further work after `usedAtRejection` tasks
 * were dispatched locally today.
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

  // Only today's observation may enforce. Yesterday's refusal says nothing
  // about today's remaining quota, and carrying it forward would keep the
  // operator locked out after the quota reset.
  const learned = readActiveCeiling(root);
  if (learned) {
    return {
      limit: learned.ceiling,
      source: "learned",
      certain: true,
      note: `the provider refused further work today after ${learned.ceiling} local task(s); resets tomorrow`,
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
 * List reservations that today's ledger still counts as spent.
 *
 * A reservation is open until a `budget_rolled_back` or `budget_released` entry
 * names it. `budget_committed` deliberately does not close one — a committed
 * dispatch really did consume quota — so the open set is "everything reserved
 * today that was not given back".
 *
 * Anonymous reservations (no `reservationId`, as older kit versions and
 * scripts/utils.mjs wrote them) are counted too, as records with
 * `reservationId: null`. They must be, or a reconcile would silently leave them
 * charged against the day: `checkDailyBudget` counts them, and with no id there
 * is nothing a targeted release could name. They are matched by count, the same
 * way the counter itself treats them.
 *
 * @param {string} [root]
 * @returns {{ reservationId: string|null, timestamp: string, committed: boolean }[]}
 */
export function listOpenReservations(root = resolveRoot()) {
  const filePath = getDailyLedgerPath(root);
  if (!existsSync(filePath)) return [];

  /** @type {Map<string, { reservationId: string, timestamp: string, committed: boolean }>} */
  const open = new Map();
  /** @type {{ reservationId: null, timestamp: string, committed: boolean }[]} */
  const anonymous = [];
  let raw = "";
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (_) {
    return [];
  }

  for (const line of raw.split("\n").filter(Boolean)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (!entry || !entry.event) continue;

    if (entry.event === "budget_reserved") {
      if (entry.reservationId) {
        open.set(entry.reservationId, {
          reservationId: entry.reservationId,
          timestamp: entry.timestamp || "",
          committed: false,
        });
      } else {
        anonymous.push({ reservationId: null, timestamp: entry.timestamp || "", committed: false });
      }
    } else if (entry.event === "budget_committed") {
      const rec = entry.reservationId ? open.get(entry.reservationId) : null;
      if (rec) rec.committed = true;
    } else if (entry.event === "budget_rolled_back" || entry.event === "budget_released") {
      if (entry.reservationId) open.delete(entry.reservationId);
      else anonymous.pop();
    }
  }

  return [...open.values(), ...anonymous];
}

/**
 * Give today's open reservations back, by appending `budget_released` entries.
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
    // An anonymous reservation is released by an equally anonymous entry: the
    // counter decrements those by count, so naming an id here would leave the
    // original charged and subtract from someone else's total instead.
    if (rec.reservationId) entry.reservationId = rec.reservationId;
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
    // Only a limit we actually know may stop a dispatch.
    enforced: resolved.certain,
    exhausted: check.used >= resolved.limit,
  };
}
