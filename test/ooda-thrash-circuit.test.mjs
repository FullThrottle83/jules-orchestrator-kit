import test from "node:test";
import assert from "node:assert/strict";
import { createThrashDetector } from "../src/remediation.mjs";

test("OODA Thrash Cycle Breaker", async (t) => {
  await t.test("allows distinct non-repeating repair attempts", () => {
    const detector = createThrashDetector({ threshold: 2 });

    const step1 = detector.recordAttempt({ diff: "+ const a = 1;", symptom: "TypeError: a is undefined" });
    assert.equal(step1.thrash, false);

    const step2 = detector.recordAttempt({ diff: "+ const b = 2;", symptom: "ReferenceError: b not found" });
    assert.equal(step2.thrash, false);

    const step3 = detector.recordAttempt({ diff: "+ const c = 3;", symptom: "SyntaxError: unexpected token" });
    assert.equal(step3.thrash, false);
  });

  await t.test("trips circuit breaker on repeating ping-pong state (A -> B -> A)", () => {
    const detector = createThrashDetector({ threshold: 2 });

    const stateA = { diff: "+ return x === 1;", symptom: "AssertionError: expected true" };
    const stateB = { diff: "+ return x == 1;", symptom: "LintError: eqeqeq" };

    const res1 = detector.recordAttempt(stateA);
    assert.equal(res1.thrash, false);

    const res2 = detector.recordAttempt(stateB);
    assert.equal(res2.thrash, false);

    // Reverting back to State A (OODA loop cycle)
    const res3 = detector.recordAttempt(stateA);
    assert.equal(res3.thrash, true);
    assert.equal(res3.occurrences, 2);
    assert.equal(res3.cycleLength, 2);
    assert.match(res3.reason, /OODA Thrash Circuit Tripped/);
  });

  await t.test("reset() clears history and restores circuit breaker", () => {
    const detector = createThrashDetector({ threshold: 2 });
    const stateA = { diff: "+ const x = 10;" };

    detector.recordAttempt(stateA);
    detector.reset();
    assert.deepEqual(detector.getHistory(), []);

    const res = detector.recordAttempt(stateA);
    assert.equal(res.thrash, false);
    assert.equal(res.occurrences, 1);
  });
});
