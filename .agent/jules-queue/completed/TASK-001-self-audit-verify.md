---
title: "Self-Audit & Zero Dependency Verification"
type: "jules_dispatch"
---
# Self-Audit & Zero Dependency Verification

Your task is to act as the Self-Auditor for `jules-orchestrator-kit`.
We want to "eat our own dogfood" by letting Jules evaluate the Jules repo.

1. Read through `AGENTS.md` and verify that the latest changes in `scripts/utils.mjs`, `scripts/jules-queue-runner.mjs`, and `scripts/jules-dispatch.mjs` respect the "Lean Engineering Protocol" (zero external dependencies).
2. Verify that none of the files contain unnecessary console.logs that should have been replaced with our central DX-logger (`log.info`, `log.success`, etc).
3. If you find code that breaks the pattern, refactor it!
4. Finally, ensure that you can successfully run the verification suite.

This is an important step to confirm that "The 5-Minute Drop-off" issue is gone.
