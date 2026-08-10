import { test } from "node:test";
import assert from "node:assert/strict";
import {
  levenshteinDistance,
  extractPathTokens,
  scorePromptFalsifiability,
  optimizeTaskPrompt
} from "../src/task-optimizer.mjs";
import { handleMcpRequest } from "../src/mcp.mjs";

test("levenshteinDistance calculates string distances accurately", () => {
  assert.equal(levenshteinDistance("auth", "auth"), 0);
  assert.equal(levenshteinDistance("src/auth.js", "src/auth.mjs"), 1);
  assert.equal(levenshteinDistance("kitty", "kitchen"), 4);
  assert.equal(levenshteinDistance("", "abc"), 3);
});

test("extractPathTokens extracts path-like tokens from prompt text", () => {
  const prompt = "Fix issue in src/security.mjs and update test/security.test.mjs for auth";
  const tokens = extractPathTokens(prompt);
  assert.ok(tokens.includes("src/security.mjs"));
  assert.ok(tokens.includes("test/security.test.mjs"));
  assert.equal(tokens.length, 2);
});

test("scorePromptFalsifiability scores empty and vague prompts with low grades", () => {
  const emptyRes = scorePromptFalsifiability("");
  assert.equal(emptyRes.score, 0);
  assert.equal(emptyRes.grade, "F");
  assert.equal(emptyRes.isFalsifiable, false);

  const vagueRes = scorePromptFalsifiability("clean up code and make faster with various fixes");
  assert.ok(vagueRes.score < 50);
  assert.equal(vagueRes.isFalsifiable, false);
  assert.ok(vagueRes.issues.some((i) => i.type === "VAGUE_WORDING"));
});

test("scorePromptFalsifiability scores concrete prompts with high grades & detects typos", () => {
  const res = scorePromptFalsifiability(
    "Fix JWT secret parsing in src/security.js when handling multiline RSA private keys. Run npm test.",
    { rootDir: process.cwd(), verifyCmd: "npm test" }
  );

  assert.ok(res.score >= 70);
  assert.equal(res.isFalsifiable, true);
  assert.equal(res.oracle.command, "npm test");
  assert.ok(res.paths.found.some((p) => p.token === "src/security.js" && p.suggestion === "src/security.mjs"));
});

test("scorePromptFalsifiability flags scope violations and trivial verification commands", () => {
  const scopeRes = scorePromptFalsifiability(
    "Modify .github/workflows/ci.yml to update runner version. Verify with true.",
    { rootDir: process.cwd(), verifyCmd: "true" }
  );

  assert.equal(scopeRes.isFalsifiable, false);
  assert.ok(scopeRes.issues.some((i) => i.type === "SCOPE_VIOLATION"));
  assert.ok(scopeRes.issues.some((i) => i.type === "TRIVIAL_ORACLE"));
});

test("optimizeTaskPrompt synthesizes structured task envelope", () => {
  const opt = optimizeTaskPrompt(
    "Fix JWT secret parsing in src/security.js when handling multiline RSA private keys.",
    { rootDir: process.cwd(), verifyCmd: "npm test" }
  );

  assert.ok(opt.optimizedPrompt.includes("# TASK: Fix JWT secret parsing"));
  assert.ok(opt.optimizedPrompt.includes("`npm test`"));
  assert.ok(opt.optimizedPrompt.includes("Standard Guardrails"));
  assert.ok(opt.optimizedPrompt.includes("src/security.mjs"));
});

test("optimize_jules_prompt MCP tool handles prompt optimization requests", async () => {
  const req = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "optimize_jules_prompt",
      arguments: {
        prompt: "Refactor error handling in src/provider.mjs and run npm test",
        fix: true,
        verifyCmd: "npm test",
      },
    },
  };

  const res = await handleMcpRequest(req, { root: process.cwd() });
  assert.equal(res.jsonrpc, "2.0");
  assert.ok(res.result);
  const content = JSON.parse(res.result.content[0].text);
  assert.ok(content.optimizedPrompt);
  assert.ok(content.analysis);
  assert.ok(content.analysis.score >= 70);
});
