#!/usr/bin/env node

/**
 * Self-audit CLI entrypoint.
 *
 * All audit logic lives in src/self-audit.mjs (P04 shim cleanup); this file
 * is only the executable gate that CI (`jules-audit.yml`) invokes. The
 * re-export below preserves the historical `scripts/jules-self-audit.mjs`
 * import surface for external consumers.
 */

export * from "../src/self-audit.mjs";

import { runSelfAudit } from "../src/self-audit.mjs";

if (process.argv[1] && process.argv[1].endsWith("jules-self-audit.mjs")) {
  runSelfAudit()
    .then((res) => {
      if (!res.ok) {
        if (res.code === 3) {
          console.error("❌ RESTRICTED FILE VIOLATION");
        } else if (res.code === 6) {
          console.error("❌ SECRET LEAK PREVENTED");
        } else {
          console.error(`❌ Self Audit Failed (Exit ${res.code})`);
        }
        process.exit(res.code);
      }
      console.log("Audit Complete: PASSED");
      process.exit(0);
    })
    .catch((err) => {
      console.error(`Audit Failure: ${err.message}`);
      process.exit(err.code || 1);
    });
}
