import { test } from "node:test";
import assert from "node:assert/strict";
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
  assert.ok(templates.length >= 6);
  const ids = templates.map((t) => t.id);
  assert.ok(ids.includes("web-cwv"));
  assert.ok(ids.includes("web-wcag"));
  assert.ok(ids.includes("web-seo"));
  assert.ok(ids.includes("web-playwright"));
  assert.ok(ids.includes("web-flaky-heal"));
  assert.ok(ids.includes("web-i18n"));
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

  const nonExistent = getWebTemplate("invalid-template");
  assert.equal(nonExistent, null);
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
