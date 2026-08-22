import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyTaskComplexity, resolveRoutedProvider, ROUTE_TIERS } from "../src/router.mjs";
import { dispatch } from "../src/engine.mjs";

const BASE_CONFIG = { provider: "jules", scope: { deny: [] }, router: { enabled: false } };

describe("src/router.mjs — Dynamic Complexity & Cost Router", () => {
  it("classifies a trivial lockfile bump / typo fix as FAST tier", () => {
    const res = classifyTaskComplexity(
      { title: "Fix typo in README", prompt: "Fix a typo in the README.md file, no code changes." },
      BASE_CONFIG
    );
    assert.equal(res.tier, ROUTE_TIERS.FAST);
    assert.equal(res.forced, false);
  });

  it("classifies a multi-file architectural refactor as COMPLEX tier", () => {
    const res = classifyTaskComplexity(
      {
        title: "Refactor API request architecture",
        prompt:
          "Refactor the API request architecture across src/api/handler.mjs, src/api/router.mjs, src/api/middleware.mjs and src/api/validator.mjs to fix a race condition under concurrency.",
      },
      BASE_CONFIG
    );
    assert.equal(res.tier, ROUTE_TIERS.COMPLEX);
    assert.equal(res.forced, false);
    assert.ok(res.score > 0);
  });

  it("honors an explicit task.tier override regardless of prompt content", () => {
    const fast = classifyTaskComplexity({ prompt: "Migrate the whole database schema.", tier: "fast" }, BASE_CONFIG);
    assert.equal(fast.tier, ROUTE_TIERS.FAST);
    assert.equal(fast.forced, true);

    const complex = classifyTaskComplexity({ prompt: "Fix a typo.", tier: "complex" }, BASE_CONFIG);
    assert.equal(complex.tier, ROUTE_TIERS.COMPLEX);
    assert.equal(complex.forced, true);
  });

  it("force-routes to COMPLEX when the prompt references a sensitive path, even with trivial wording", () => {
    const res = classifyTaskComplexity(
      { title: "Typo fix", prompt: "Fix a typo in src/auth/session.mjs." },
      BASE_CONFIG
    );
    assert.equal(res.tier, ROUTE_TIERS.COMPLEX);
    assert.equal(res.forced, true);
    assert.match(res.reason, /sensitive path/i);
  });

  it("force-routes to COMPLEX when the task touches a path matching config.scope.deny", () => {
    const res = classifyTaskComplexity(
      { title: "Bump version", prompt: "Bump the version.", targetFiles: ["keys/prod.pem"] },
      { ...BASE_CONFIG, scope: { deny: ["keys/**"] } }
    );
    assert.equal(res.tier, ROUTE_TIERS.COMPLEX);
    assert.equal(res.forced, true);
  });

  it("always force-routes the 'sentinel' role to COMPLEX regardless of wording", () => {
    const res = classifyTaskComplexity({ role: "sentinel", prompt: "Fix a typo." }, BASE_CONFIG);
    assert.equal(res.tier, ROUTE_TIERS.COMPLEX);
    assert.equal(res.forced, true);
  });

  it("nudges 'janitor' and 'bolt' roles toward FAST for otherwise-neutral prompts", () => {
    const janitor = classifyTaskComplexity({ role: "janitor", prompt: "Remove unused helper function from src/utils.mjs." }, BASE_CONFIG);
    assert.equal(janitor.tier, ROUTE_TIERS.FAST);

    const bolt = classifyTaskComplexity({ role: "bolt", prompt: "Trim redundant allocations in the hot loop." }, BASE_CONFIG);
    assert.equal(bolt.tier, ROUTE_TIERS.FAST);
  });

  it("escalates to COMPLEX when a prompt references 4 or more distinct files", () => {
    const res = classifyTaskComplexity(
      {
        prompt: "Update src/a.mjs, src/b.mjs, src/c.mjs and src/d.mjs consistently.",
      },
      BASE_CONFIG
    );
    assert.equal(res.tier, ROUTE_TIERS.COMPLEX);
  });

  it("respects a custom config.router.threshold", () => {
    const task = { prompt: "Refactor the module for clarity." }; // scores +2 (one complex keyword)
    const lenient = classifyTaskComplexity(task, { ...BASE_CONFIG, router: { enabled: true, threshold: 5 } });
    assert.equal(lenient.tier, ROUTE_TIERS.FAST);

    const strict = classifyTaskComplexity(task, { ...BASE_CONFIG, router: { enabled: true, threshold: -1 } });
    assert.equal(strict.tier, ROUTE_TIERS.COMPLEX);
  });
});

describe("src/router.mjs — resolveRoutedProvider", () => {
  it("returns the plain primary provider, unrouted, when router.enabled is false", () => {
    const { provider, routed, classification } = resolveRoutedProvider(
      { prompt: "Fix a typo." },
      { provider: "jules", router: { enabled: false } }
    );
    assert.equal(routed, false);
    assert.equal(classification, null);
    assert.equal(provider.name, "jules");
  });

  it("returns a failover cascade (fast -> complex) for a FAST-classified task when routing is enabled", () => {
    const { provider, routed, classification } = resolveRoutedProvider(
      { prompt: "Fix a typo in the README." },
      { provider: "jules", scope: { deny: [] }, router: { enabled: true, fast: "gemini-flash", complex: "jules" } }
    );
    assert.equal(routed, true);
    assert.equal(classification.tier, ROUTE_TIERS.FAST);
    assert.equal(provider.name, "failover:gemini-flash->jules");
  });

  it("returns the primary/complex provider directly for a COMPLEX-classified task, no cascade", () => {
    const { provider, routed, classification } = resolveRoutedProvider(
      { prompt: "Refactor the authentication schema migration and fix the race condition across 5 files." },
      { provider: "jules", scope: { deny: [] }, router: { enabled: true, fast: "gemini-flash", complex: "jules" } }
    );
    assert.equal(routed, true);
    assert.equal(classification.tier, ROUTE_TIERS.COMPLEX);
    assert.equal(provider.name, "jules");
  });

  it("the FAST-tier cascade actually verifies syntax and escalates when the fast provider leaves broken JS on disk", async () => {
    const root = mkdtempSync(join(tmpdir(), "jok-router-syntax-gate-"));
    try {
      execSync("git init -q -b main", { cwd: root });
      writeFileSync(join(root, "broken.js"), "const x = ;\n");

      const fakeFast = { name: "fake-fast", dispatch: async () => ({ id: "fast-session" }) };
      const fakeComplex = { name: "fake-complex", dispatch: async () => ({ id: "complex-session-escalated" }) };

      const { provider, classification } = resolveRoutedProvider(
        { prompt: "Fix a typo in the README." },
        { provider: "jules", scope: { deny: [] }, router: { enabled: true, fast: fakeFast, complex: fakeComplex } }
      );
      assert.equal(classification.tier, ROUTE_TIERS.FAST);

      const result = await provider.dispatch({ prompt: "fix a typo" }, { root });
      assert.equal(result.id, "complex-session-escalated");
      assert.equal(result._syntaxEscalated, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Declarative Override: routes to FAST when all targeted files are non-executable formats", () => {
    const res = classifyTaskComplexity(
      {
        title: "Update auth token documentation and localization",
        prompt: "Update documentation in src/auth/README.md and translations in src/auth/locales/en.json.",
        targetFiles: ["src/auth/README.md", "src/auth/locales/en.json"],
      },
      BASE_CONFIG
    );
    assert.equal(res.tier, ROUTE_TIERS.FAST);
    assert.match(res.reason, /declarative asset override/i);
  });

  it("Mechanical Intent Fast-Track: routes chores to FAST despite technical keywords", () => {
    const res = classifyTaskComplexity(
      {
        title: "chore(deps): update jsonwebtoken to patch vulnerability",
        prompt: "Bump jsonwebtoken version in src/deps.mjs.",
        targetFiles: ["src/deps.mjs"],
      },
      BASE_CONFIG
    );
    assert.equal(res.tier, ROUTE_TIERS.FAST);
    assert.ok(res.signals.some((s) => s.includes("mechanical commit prefix")));
  });
});

describe("src/engine.mjs dispatch() — router integration", () => {
  it("does not attach a route tier when router.enabled is false (default, zero behavior change)", async () => {
    const config = { provider: "jules", scope: { deny: [] }, limits: { promptKb: 50, dailyTasks: 300 }, router: { enabled: false } };
    const session = await dispatch({ title: "T", prompt: "Fix a typo." }, { config, dryRun: true });
    assert.equal(session._routeTier, undefined);
  });

  it("attaches _routeTier to the dispatch result when router.enabled is true", async () => {
    const config = {
      provider: "jules",
      scope: { deny: [] },
      limits: { promptKb: 50, dailyTasks: 300 },
      router: { enabled: true, fast: "gemini-flash", complex: "jules" },
    };
    const fast = await dispatch({ title: "T", prompt: "Fix a typo in the README." }, { config, dryRun: true });
    assert.equal(fast._routeTier, ROUTE_TIERS.FAST);

    const complex = await dispatch(
      { title: "T", prompt: "Refactor the authentication schema migration across multiple files." },
      { config, dryRun: true }
    );
    assert.equal(complex._routeTier, ROUTE_TIERS.COMPLEX);
  });
});
