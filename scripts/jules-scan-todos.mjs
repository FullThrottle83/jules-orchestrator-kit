#!/usr/bin/env node

/**
 * TODO/FIXME scanner CLI entrypoint.
 *
 * The scanner itself (extension allowlist, size/binary limits, .gitignore
 * awareness) lives in src/todo-scanner.mjs (P04 shim cleanup). The re-export
 * below preserves the historical `scripts/jules-scan-todos.mjs` import
 * surface for external consumers.
 */

export * from "../src/todo-scanner.mjs";

import { runScanner } from "../src/todo-scanner.mjs";

if (process.argv[1] && process.argv[1].endsWith("jules-scan-todos.mjs")) {
  const { count } = runScanner(process.env.JULES_PROJECT_ROOT || process.cwd());
  console.log(`[Shim] TODO Scanner complete. Found ${count} annotation(s).`);
  process.exit(0);
}
