import test from "node:test";
import assert from "node:assert/strict";
import { createWhackAMoleDetector } from "../src/remediation.mjs";

test("Whack-a-Mole Test-Oscillation Cycle Detector", async (t) => {
  await t.test("allows progressing non-repeating test outcomes", () => {
    const detector = createWhackAMoleDetector({ threshold: 2 });

    const r1 = detector.recordTestOutcome(["TestAuth", "TestOrder"]);
    assert.equal(r1.whackAMole, false);

    const r2 = detector.recordTestOutcome(["TestPayment"]);
    assert.equal(r2.whackAMole, false);

    const r3 = detector.recordTestOutcome([]);
    assert.equal(r3.whackAMole, false);
  });

  await t.test("detects alternating test failure oscillation (TestA -> TestB -> TestA)", () => {
    const detector = createWhackAMoleDetector({ threshold: 2 });

    // Repair turn 1: Test A fails
    const r1 = detector.recordTestOutcome(["TestA"]);
    assert.equal(r1.whackAMole, false);

    // Repair turn 2: Test A fixed, but Test B broke
    const r2 = detector.recordTestOutcome(["TestB"]);
    assert.equal(r2.whackAMole, false);

    // Repair turn 3: Test B fixed, but Test A broke again (Whack-a-Mole!)
    const r3 = detector.recordTestOutcome(["TestA"]);
    assert.equal(r3.whackAMole, true);
    assert.equal(r3.occurrences, 2);
    assert.equal(r3.cycleLength, 2);
    assert.ok(r3.oscillatingTests.includes("TestA"));
    assert.ok(r3.oscillatingTests.includes("TestB"));
    assert.match(r3.promptDirective, /WHACK_A_MOLE_WARNING/);
    assert.match(r3.promptDirective, /TestA <-> TestB|TestB <-> TestA/);
  });

  await t.test("handles multi-test set oscillation and array/string normalization", () => {
    const detector = createWhackAMoleDetector({ threshold: 2 });

    detector.recordTestOutcome("TestUser::test_login");
    detector.recordTestOutcome("TestCart::test_checkout");

    const r3 = detector.recordTestOutcome("TestUser::test_login");
    assert.equal(r3.whackAMole, true);
    assert.ok(r3.oscillatingTests.includes("TestUser::test_login"));
    assert.ok(r3.oscillatingTests.includes("TestCart::test_checkout"));
  });

  await t.test("reset() clears history and restores detector", () => {
    const detector = createWhackAMoleDetector({ threshold: 2 });

    detector.recordTestOutcome(["TestX"]);
    detector.recordTestOutcome(["TestY"]);
    detector.reset();

    const r = detector.recordTestOutcome(["TestX"]);
    assert.equal(r.whackAMole, false);
  });
});
