import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  getWebTemplate,
  listWebTemplates,
  synthesizeWebEnvelope
} from "../src/web-templates.mjs";
import { planTaskCreate } from "../src/wizard-task.mjs";
import { handleMcpRequest } from "../src/mcp.mjs";

test("listWebTemplates returns all registered web templates", () => {
  const templates = listWebTemplates();
  assert.ok(Array.isArray(templates));
  assert.ok(templates.length >= 20);
  const ids = templates.map((t) => t.id);
  assert.ok(ids.includes("web-cwv"));
  assert.ok(ids.includes("web-wcag"));
  assert.ok(ids.includes("web-seo"));
  assert.ok(ids.includes("web-playwright"));
  assert.ok(ids.includes("web-flaky-heal"));
  assert.ok(ids.includes("web-i18n"));
  assert.ok(ids.includes("web-ai-access"));
  assert.ok(ids.includes("agent-qa-mutation"));
  assert.ok(ids.includes("agent-ci-falsify"));
  assert.ok(ids.includes("agent-service-isolate"));
  assert.ok(ids.includes("agent-error-paths"));
  assert.ok(ids.includes("agent-security-audit"));
  assert.ok(ids.includes("agent-dep-audit"));
  assert.ok(ids.includes("agent-doc-drift"));
  assert.ok(ids.includes("agent-config-audit"));
  assert.ok(ids.includes("agent-api-contract"));
  assert.ok(ids.includes("deep-debug"));
  assert.ok(ids.includes("deep-feature"));
  assert.ok(ids.includes("deep-optimize"));
  assert.ok(ids.includes("deep-harden"));
});

test("getWebTemplate retrieves specific template by id case-insensitively", () => {
  const cwv = getWebTemplate("WEB-CWV");
  assert.ok(cwv);
  assert.equal(cwv.id, "web-cwv");
  assert.equal(cwv.category, "Performance");
  assert.ok(cwv.criticFocus.length > 0);

  const i18n = getWebTemplate("WEB-I18N");
  assert.ok(i18n);
  assert.equal(i18n.id, "web-i18n");
  assert.equal(i18n.category, "Internationalization & SEO");
  assert.ok(i18n.criticFocus.length > 0);

  const aiAccess = getWebTemplate("WEB-AI-ACCESS");
  assert.ok(aiAccess);
  assert.equal(aiAccess.id, "web-ai-access");
  assert.equal(aiAccess.category, "Crawler Policy & AI Access");
  assert.ok(aiAccess.criticFocus.length > 0);

  const nonExistent = getWebTemplate("invalid-template");
  assert.equal(nonExistent, null);
});

test("web-ai-access defaults to preserving the operator's existing crawler posture", () => {
  // Allowing or blocking GPTBot has licensing and editorial consequences, and
  // blocking is frequently deliberate. A universal template must not ship a
  // default that quietly opens a site up — so the unparameterised envelope has
  // to instruct the agent to leave the posture alone.
  const env = synthesizeWebEnvelope("web-ai-access", {});
  assert.match(env.prompt, /Do not change the posture/);
  assert.match(env.prompt, /most restrictive existing directive/);
  assert.doesNotMatch(
    env.prompt,
    /has decided to \*\*allow\*\*/,
    "the default envelope must not assert an allow decision the operator never made"
  );

  const deny = synthesizeWebEnvelope("web-ai-access", { aiAccessPolicy: "deny" });
  assert.match(deny.prompt, /has decided to \*\*block\*\*/);

  const allow = synthesizeWebEnvelope("web-ai-access", { aiAccessPolicy: "allow" });
  assert.match(allow.prompt, /has decided to \*\*allow\*\*/);
});

test("web-ai-access refuses to promise unverifiable AI visibility gains", () => {
  // Every other template carries a real verification oracle. This one governs a
  // convention whose consumption by AI systems is unconfirmed, so the envelope
  // must forbid the agent from writing a ranking claim it cannot falsify — that
  // is the whole reason the template is scoped to file integrity instead of
  // "generative engine optimization".
  const env = synthesizeWebEnvelope("web-ai-access", {});
  assert.match(env.prompt, /proposal, not a ratified standard/);
  assert.match(env.prompt, /Do \*\*not\*\* claim improved visibility, ranking, or citation/);
  assert.match(env.prompt, /do not fetch the live web from the verification step/);

  // Structured data stays with web-seo; two owners of the same markup drift.
  assert.match(env.prompt, /belongs to the `web-seo` template/);
});

test("web-ai-access cites the llms.txt spec without a fetchable scheme", async () => {
  // The egress allowlist test treats any https?://host literal in src/ as a
  // destination the kit might contact. A citation is not a destination, and a
  // previous release tripped this exact guard, so pin the schemeless form.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/web-templates.mjs", import.meta.url), "utf-8");
  assert.match(source, /llmstxt\.org/, "the spec should still be cited for a reader");
  assert.doesNotMatch(source, /https?:\/\/llmstxt\.org/, "but never as a resolvable URL literal");
});

test("synthesizeWebEnvelope generates structured envelope with exploration budget & critic focus", () => {
  const env = synthesizeWebEnvelope("web-cwv", {
    targetPage: "/checkout",
    lcpMaxMs: 1000,
    clsMax: 0.02,
  }, { verifyCmd: "npm run test:e2e" });

  assert.equal(env.templateId, "web-cwv");
  assert.equal(env.verifyCmd, "npm run test:e2e");
  assert.ok(env.fullEnvelope.includes("# [Performance] Core Web Vitals & Lighthouse Budget Guard"));
  assert.ok(env.fullEnvelope.includes("Google Labs Exploration Budget Protocol (3-Phase Discovery)"));
  assert.ok(env.fullEnvelope.includes("PHASE 1: DISCOVERY & SYMBOL TRACING"));
  assert.ok(env.fullEnvelope.includes("Internal Critic Agent Focus Areas"));
  assert.ok(env.fullEnvelope.includes("/checkout"));
  assert.ok(env.fullEnvelope.includes("< 1000ms"));
  assert.ok(env.fullEnvelope.includes("< 0.02"));
});

test("synthesizeWebEnvelope works for web-wcag, web-seo, web-playwright, web-flaky-heal, and web-i18n", () => {
  const wcagEnv = synthesizeWebEnvelope("web-wcag", { targetComponentOrRoute: "Navbar & Modal dialogs" });
  assert.ok(wcagEnv.fullEnvelope.includes("Navbar & Modal dialogs"));
  assert.ok(wcagEnv.fullEnvelope.includes("Accessibility Hard Invariants"));

  const seoEnv = synthesizeWebEnvelope("web-seo", { schemaType: "Product, BreadcrumbList" });
  assert.ok(seoEnv.fullEnvelope.includes("Product, BreadcrumbList"));
  assert.ok(seoEnv.fullEnvelope.includes("Structured Data (JSON-LD)"));

  const i18nEnv = synthesizeWebEnvelope("web-i18n", { targetLocales: "en, sv, no, da" });
  assert.ok(i18nEnv.fullEnvelope.includes("en, sv, no, da"));
  assert.ok(i18nEnv.fullEnvelope.includes("Symmetric Hreflang Alternate Links"));

  const pwEnv = synthesizeWebEnvelope("web-playwright", { targetFeature: "Cart checkout flow" });
  assert.ok(pwEnv.fullEnvelope.includes("Cart checkout flow"));
  assert.ok(pwEnv.fullEnvelope.includes("Multi-Viewport Coverage"));

  const flakyEnv = synthesizeWebEnvelope("web-flaky-heal", { repetitionCount: 10 });
  assert.ok(flakyEnv.fullEnvelope.includes("10 consecutive runs"));
  assert.ok(flakyEnv.fullEnvelope.includes("Anti-Flakiness Rules"));
});

test("synthesizeWebEnvelope works for agent hardening templates", () => {
  const qaEnv = synthesizeWebEnvelope("agent-qa-mutation", { targetTestDir: "test/unit/" });
  assert.equal(qaEnv.templateId, "agent-qa-mutation");
  assert.ok(qaEnv.fullEnvelope.includes("test/unit/"));
  assert.ok(qaEnv.fullEnvelope.includes("Mutation Falsification"));
  assert.ok(qaEnv.fullEnvelope.includes("Internal Critic Agent Focus Areas"));
  assert.ok(qaEnv.criticFocus.some((f) => f.includes("mutated")));

  const ciEnv = synthesizeWebEnvelope("agent-ci-falsify", { workflowPath: ".github/workflows/ci.yml" });
  assert.equal(ciEnv.templateId, "agent-ci-falsify");
  assert.ok(ciEnv.fullEnvelope.includes(".github/workflows/ci.yml"));
  assert.ok(ciEnv.fullEnvelope.includes("Zero Swallowed Exit Codes"));

  const isolateEnv = synthesizeWebEnvelope("agent-service-isolate", { targetServices: "Postgres and Redis" });
  assert.equal(isolateEnv.templateId, "agent-service-isolate");
  assert.ok(isolateEnv.fullEnvelope.includes("Postgres and Redis"));
  assert.ok(isolateEnv.fullEnvelope.includes("Sandbox Decoupling"));

  const errorEnv = synthesizeWebEnvelope("agent-error-paths", { targetModules: "src/ops/" });
  assert.equal(errorEnv.templateId, "agent-error-paths");
  assert.ok(errorEnv.fullEnvelope.includes("src/ops/"));
  assert.ok(errorEnv.fullEnvelope.includes("Execute Every Catch Block"));

  const secEnv = synthesizeWebEnvelope("agent-security-audit", { diffRange: "origin/main..HEAD" });
  assert.equal(secEnv.templateId, "agent-security-audit");
  assert.ok(secEnv.fullEnvelope.includes("origin/main..HEAD"));
  assert.ok(secEnv.fullEnvelope.includes("Zero Transport & TLS Bypasses"));
});

test("planTaskCreate incorporates web template when --template flag is used", () => {
  const plan = planTaskCreate(process.cwd(), {
    template: "web-seo",
    templateParams: { targetRoutes: "/pricing, /features" },
    verifyCmd: "npm test",
  });

  assert.ok(plan.ok);
  assert.ok(plan.title.includes("Structured Data"));
  assert.ok(plan.fullPrompt.includes("/pricing, /features"));
  assert.ok(plan.fullPrompt.includes("Google Labs Exploration Budget Protocol"));
  assert.ok(plan.taskFileContent.includes("JULES_TASK_ENVELOPE"));
});

test("MCP tool get_web_task_template lists templates and synthesizes envelopes", async () => {
  // 1. List templates
  const listReq = {
    jsonrpc: "2.0",
    id: 101,
    method: "tools/call",
    params: {
      name: "get_web_task_template",
      arguments: {},
    },
  };
  const listRes = await handleMcpRequest(listReq, { root: process.cwd() });
  assert.equal(listRes.jsonrpc, "2.0");
  const listBody = JSON.parse(listRes.result.content[0].text);
  assert.ok(listBody.ok);
  assert.ok(listBody.templates.length >= 5);

  // 2. Synthesize specific template
  const synthReq = {
    jsonrpc: "2.0",
    id: 102,
    method: "tools/call",
    params: {
      name: "get_web_task_template",
      arguments: {
        template: "web-wcag",
        params: { targetComponentOrRoute: "LoginForm" },
        verifyCmd: "npm test",
      },
    },
  };
  const synthRes = await handleMcpRequest(synthReq, { root: process.cwd() });
  assert.equal(synthRes.jsonrpc, "2.0");
  const synthBody = JSON.parse(synthRes.result.content[0].text);
  assert.ok(synthBody.ok);
  assert.equal(synthBody.templateId, "web-wcag");
  assert.ok(synthBody.fullEnvelope.includes("LoginForm"));
});

test("synthesizeWebEnvelope generates structured envelopes for Deep Think templates", () => {
  const deepDebug = synthesizeWebEnvelope("deep-debug", {
    targetPath: "src/state.mjs",
    issueSummary: "Deadlock in directory mutex allocation",
  });
  assert.ok(deepDebug.fullEnvelope.includes("Deep Debug Protocol"));
  assert.ok(deepDebug.fullEnvelope.includes("src/state.mjs"));
  assert.ok(deepDebug.criticFocus.some((f) => f.includes("mutation falsification")));

  const deepFeature = synthesizeWebEnvelope("deep-feature", {
    featureName: "Streaming Logger",
    targetModule: "src/logger.mjs",
  });
  assert.ok(deepFeature.fullEnvelope.includes("Deep Feature TDD Protocol"));
  assert.ok(deepFeature.fullEnvelope.includes("Streaming Logger"));

  const deepOptimize = synthesizeWebEnvelope("deep-optimize", {
    targetModule: "src/engine.mjs",
    metricTarget: ">=25% throughput improvement",
  });
  assert.ok(deepOptimize.fullEnvelope.includes("Benchmark-Gated Optimization Protocol"));
  assert.ok(deepOptimize.fullEnvelope.includes(">=25% throughput improvement"));

  const deepHarden = synthesizeWebEnvelope("deep-harden", {
    targetSubsystem: "src/security.mjs",
    threatFocus: "Unicode Bidi and zero-width smuggling",
  });
  assert.ok(deepHarden.fullEnvelope.includes("Adversarial Hardening Protocol"));
  assert.ok(deepHarden.fullEnvelope.includes("Unicode Bidi and zero-width smuggling"));
});

test("universal templates are stack-neutral and carry falsifiable oracles", () => {
  // These templates ship to Cargo, go.mod, pyproject, composer, Gemfile, Maven
  // and .NET repositories via `agentctl init`, so they must not bake in npm,
  // npx, node, or a single language's tooling. The verify command is supplied
  // by the caller from config.verify.test (already resolved by the stack
  // detector), so it can be `cargo test`, `go test ./...`, `pytest`, etc.
  const source = readFileSync(new URL("../src/web-templates.mjs", import.meta.url), "utf-8");

  // Isolate the block of universal templates so a coincidental npm reference
  // elsewhere in the file cannot make this test pass accidentally. The
  // per-template defaultVerifyCmd line is the framework's placeholder, which
  // callers override from the target repo's stack config — strip it so the
  // check measures the prompt text a Rust/Go/Python project would actually
  // receive, not the harness default.
  const universalBlockStart = source.indexOf('"agent-dep-audit"');
  const universalBlock = source
    .slice(universalBlockStart)
    .replace(/^\s*defaultVerifyCmd:[^\n]*$/gm, "");
  const forbidden = [/\bnpm (?:test|run|install|ci|audit)\b/, /\bnpx\b/, /\bnode_modules\b/, /\bpackage\.json\b/];
  for (const pattern of forbidden) {
    assert.doesNotMatch(
      universalBlock,
      pattern,
      "universal (agent-dep-*) templates must not hardcode Node/JS tooling"
    );
  }

  // Each universal template must still name a real, locally-falsifiable oracle
  // rather than a "best practice" claim no test can exercise.
  const dep = synthesizeWebEnvelope("agent-dep-audit", {});
  assert.equal(dep.templateId, "agent-dep-audit");
  assert.ok(dep.prompt.includes("Offline Verification Oracle"));
  assert.ok(dep.prompt.includes("fail on a hand-broken fixture"));
  assert.ok(dep.criticFocus.some((f) => /cve|advisory|network/i.test(f)));

  const drift = synthesizeWebEnvelope("agent-doc-drift", {});
  assert.equal(drift.templateId, "agent-doc-drift");
  assert.ok(drift.prompt.includes("Command & Flag Inventory"));
  assert.ok(drift.criticFocus.some((f) => /\.env\.example|environment variables/i.test(f)));

  const cfg = synthesizeWebEnvelope("agent-config-audit", {});
  assert.equal(cfg.templateId, "agent-config-audit");
  assert.ok(cfg.prompt.includes("fail closed"));
  assert.ok(cfg.prompt.includes("redact"));
  assert.ok(cfg.criticFocus.some((f) => /fail[- ]open|truthy/i.test(f)));

  const api = synthesizeWebEnvelope("agent-api-contract", {});
  assert.equal(api.templateId, "agent-api-contract");
  assert.ok(api.prompt.includes("Route/Handler Parity"));
  assert.ok(api.prompt.includes("stack trace"));
  assert.ok(api.criticFocus.some((f) => /orphan|unhandled/i.test(f)));

  // verifyCmd is overridable for non-Node stacks without editing the template.
  const rust = synthesizeWebEnvelope("agent-dep-audit", {}, { verifyCmd: "cargo test --workspace" });
  assert.equal(rust.verifyCmd, "cargo test --workspace");
  assert.ok(rust.fullEnvelope.includes("cargo test --workspace"));
});

test("universal templates resolve through planTaskCreate for a non-Node verify command", () => {
  const plan = planTaskCreate(process.cwd(), {
    template: "agent-config-audit",
    verifyCmd: "pytest",
    allowUnverifiable: false,
  });
  assert.ok(plan.ok, `plan should be accepted: ${plan.error || ""}`);
  assert.ok(plan.fullPrompt.includes("fail closed"));
  assert.ok(plan.taskFileContent.includes("pytest"));
  assert.ok(!plan.fullPrompt.includes("npm test"));
});
