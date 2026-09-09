#!/usr/bin/env node

/**
 * Task dispatch entrypoint: deprecated CLI shim that delegates to the
 * dispatch pipeline. All logic (guardrails, attachments, argv parsing,
 * dispatchTask) lives in src/dispatch.mjs (P04 shim cleanup).
 *
 * The re-export below preserves the historical
 * `scripts/jules-dispatch.mjs` import surface for external consumers,
 * and — deliberately — keeps argv parsing OUT of module scope: importing
 * this file must never consume the importer's process.argv (D10).
 */

export * from "../src/dispatch.mjs";

import { dispatchTask, parseDispatchArgs } from "../src/dispatch.mjs";

if (process.argv[1] && (process.argv[1].endsWith("jules-dispatch.mjs") || process.argv[1].endsWith("jules-dispatch"))) {
  process.emitWarning(
    "scripts/jules-dispatch.mjs is deprecated and will be removed in v1.0.0. Use 'agentctl dispatch' or the programmatic SDK.",
    "DeprecationWarning"
  );

  dispatchTask(parseDispatchArgs(process.argv.slice(2)))
    .then((session) => {
      console.log(`[Shim] Task dispatched session: ${session.id}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[Shim] Dispatch failed: ${err.message}`);
      process.exit(typeof err.code === "number" ? err.code : 1);
    });
}
