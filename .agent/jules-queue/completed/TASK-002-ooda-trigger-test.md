---
title: "Trigger OODA Auto-Repair Loop"
type: "jules_dispatch"
---
# Trigger OODA Auto-Repair Loop

Your task is to intentionally and temporarily introduce a logical error in the test file `test/kit.test.mjs`.

1. Open `test/kit.test.mjs`.
2. Locate the test `resolves default verification commands from manifest or config`.
3. Change `assert.equal(res.testCmd, "npm test");` to `assert.equal(res.testCmd, "npm BROKEN");`.
4. Save the file and exit.

The goal of this task is to simulate a human error that causes the test suite to fail. Since we have now implemented an autonomous OODA repair loop (Auto-Repair Re-dispatch), the orchestrator will immediately detect the error and send it back to you (or another jules instance) as a new auto-repair task containing the error message, at which point you will autonomously fix the error again.
