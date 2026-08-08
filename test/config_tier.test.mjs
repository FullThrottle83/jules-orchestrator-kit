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

  it("applies Free tier limits when JULES_TIER=free", () => {
    const origTier = process.env.JULES_TIER;
    process.env.JULES_TIER = "free";
    try {
      const cfg = loadConfig(resolve("."));
      assert.equal(cfg.tier, "free");
      assert.equal(cfg.limits.dailyTasks, 15);
      assert.equal(cfg.limits.repairAttempts, 1);
      assert.equal(cfg.limits.concurrency, 1);
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
      assert.equal(cfg.limits.concurrency, 2);
    } finally {
      if (origTier !== undefined) process.env.JULES_TIER = origTier;
      else delete process.env.JULES_TIER;
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
