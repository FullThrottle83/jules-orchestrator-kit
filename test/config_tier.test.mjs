import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, TIER_PRESETS } from "../src/config.mjs";
import { resolve } from "node:path";

describe("Subscription Tier Presets (Free / Pro / Ultra)", () => {
  it("exports valid TIER_PRESETS definitions for free, pro, and ultra", () => {
    assert.equal(TIER_PRESETS.free.dailyTasks, 15);
    assert.equal(TIER_PRESETS.free.repairAttempts, 1);
    assert.equal(TIER_PRESETS.pro.dailyTasks, 100);
    assert.equal(TIER_PRESETS.ultra.dailyTasks, 300);
  });

  it("records the vendor concurrency ceiling and never defaults above it", () => {
    // The published per-plan slot limits. Pinned here so a preset edit that
    // drifts past what the plan allows fails loudly instead of dispatching
    // sessions the provider will refuse.
    const ceilings = { free: 3, pro: 15, ultra: 60 };
    for (const [tier, ceiling] of Object.entries(ceilings)) {
      assert.equal(TIER_PRESETS[tier].maxConcurrency, ceiling, `${tier} ceiling`);
      assert.ok(
        TIER_PRESETS[tier].concurrency <= ceiling,
        `${tier} defaults to ${TIER_PRESETS[tier].concurrency} workers against a ceiling of ${ceiling}`
      );
      assert.ok(TIER_PRESETS[tier].concurrency >= 1, `${tier} must dispatch at least one worker`);
    }
    // Not a vendor plan, so it claims no ceiling — the pool's size is whatever
    // the operator's accounts add up to.
    assert.equal(TIER_PRESETS.enterprise.maxConcurrency, 0);
  });

  it("applies Free tier limits when JULES_TIER=free", () => {
    const origTier = process.env.JULES_TIER;
    process.env.JULES_TIER = "free";
    try {
      const cfg = loadConfig(resolve("."));
      assert.equal(cfg.tier, "free");
      assert.equal(cfg.limits.dailyTasks, 15);
      assert.equal(cfg.limits.repairAttempts, 1);
      assert.equal(cfg.limits.concurrency, 3);
      assert.equal(cfg.limits.staggerMs, 3000);
    } finally {
      if (origTier !== undefined) process.env.JULES_TIER = origTier;
      else delete process.env.JULES_TIER;
    }
  });

  it("applies Pro tier limits when JULES_TIER=pro", () => {
    const origTier = process.env.JULES_TIER;
    process.env.JULES_TIER = "pro";
    try {
      const cfg = loadConfig(resolve("."));
      assert.equal(cfg.tier, "pro");
      assert.equal(cfg.limits.dailyTasks, 100);
      assert.equal(cfg.limits.repairAttempts, 2);
      assert.equal(cfg.limits.concurrency, 8);
    } finally {
      if (origTier !== undefined) process.env.JULES_TIER = origTier;
      else delete process.env.JULES_TIER;
    }
  });

  it("documents JULES_TIER (free | pro | ultra) in .env.example (D18)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const example = readFileSync(join(root, ".env.example"), "utf-8");
    assert.match(example, /JULES_TIER\s*=\s*(free|pro|ultra)/);
  });

  it("keeps TIER_PRESETS aligned with VENDOR_TIERS (D18)", async () => {
    const { VENDOR_TIERS } = await import("../src/config.mjs");
    assert.deepEqual([...VENDOR_TIERS].sort(), ["free", "pro", "ultra"]);
    for (const tier of VENDOR_TIERS) {
      const preset = TIER_PRESETS[tier];
      assert.ok(preset, `VENDOR_TIERS entry '${tier}' must exist in TIER_PRESETS`);
      assert.equal(typeof preset.dailyTasks, "number");
      assert.equal(typeof preset.concurrency, "number");
      assert.equal(typeof preset.maxConcurrency, "number");
    }
  });

  it("allows process.env.JULES_DAILY_BUDGET to override tier defaults", () => {
    const origTier = process.env.JULES_TIER;
    const origBudget = process.env.JULES_DAILY_BUDGET;
    process.env.JULES_TIER = "free";
    process.env.JULES_DAILY_BUDGET = "10";
    try {
      const cfg = loadConfig(resolve("."));
      assert.equal(cfg.tier, "free");
      assert.equal(cfg.limits.dailyTasks, 10);
    } finally {
      if (origTier !== undefined) process.env.JULES_TIER = origTier;
      else delete process.env.JULES_TIER;
      if (origBudget !== undefined) process.env.JULES_DAILY_BUDGET = origBudget;
      else delete process.env.JULES_DAILY_BUDGET;
    }
  });
});
