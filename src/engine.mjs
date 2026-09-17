/**
 * Public engine boundary.
 *
 * Verification and mutation are deliberately separate contracts. `gate()` may
 * inspect the repository, execute configured verification commands and persist
 * evidence, but it must never dispatch an agent or modify source code. The
 * implementation module still contains the pre-v1 repair path while migration
 * is in progress; this boundary prevents every normal engine import (CLI, MCP,
 * SDK and internal callers) from enabling it through `fix`.
 *
 * Explicit mutation remains available through `repair()`/the repair CLI path.
 */
import * as impl from "./engine-impl.mjs";

export * from "./engine-impl.mjs";

/**
 * Run deterministic verification without permitting implicit repair.
 *
 * `fix` is intentionally accepted and ignored during the 0.x migration so
 * existing callers keep receiving the real gate verdict instead of turning a
 * verification request into an agent mutation. User-facing aliases can then be
 * deprecated independently without weakening this safety boundary.
 *
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
export async function gate(opts = {}) {
  const safeOpts = opts && typeof opts === "object" ? { ...opts, fix: false } : { fix: false };
  return impl.gate(safeOpts);
}
