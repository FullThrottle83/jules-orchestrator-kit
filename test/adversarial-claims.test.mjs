/**
 * Adversarial red-team suite for the safety guarantees advertised in README.md.
 *
 * This file is ADDITIVE by contract: it must never modify anything under src/.
 * Its job is to falsify the kernel's own claims, not to refactor them.
 *
 * Tests marked `{ todo: ... }` document a *genuine, reproduced gap*. node:test
 * reports them without failing the run, so CI stays green while the hole stays
 * visible. Do not "fix" a todo by weakening its assertion — either close the
 * gap in src/ and promote it to a normal test, or leave it red.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { checkScope, scanDiff } from "../src/security.mjs";
import { classifyTaskComplexity } from "../src/router.mjs";
import { createProvider } from "../src/provider.mjs";
import { validateEnvelope } from "../src/envelope.mjs";
import { diffBytes } from "../src/git.mjs";
import { gate } from "../src/engine.mjs";

const DENY = [".github/**", "keys/**", "**/*.pem"];

async function withTempRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "adversarial-"));
  try {
    execSync("git init -q && git config user.email a@b.c && git config user.name t", { cwd: dir });
    writeFileSync(join(dir, "seed.txt"), "seed\n", "utf-8");
    execSync("git add -A && git commit -qm seed", { cwd: dir });
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("CLAIM: Fail-closed scope guard evaluates Deny before Allow", () => {
  it("HOLDS — an explicit allow entry cannot re-enable a denied path", () => {
    const res = checkScope([".github/workflows/ci.yml"], {
      deny: DENY,
      allow: [".github/**"], // deliberately re-allowing what deny forbids
    });
    assert.equal(res.ok, false, "deny must win over an overlapping allow");
    assert.equal(res.violations[0].rule, "deny");
  });

  it("HOLDS — deny still wins when the allow list is broader than the deny list", () => {
    const res = checkScope(["keys/prod.pem"], { deny: DENY, allow: ["**"] });
    assert.equal(res.ok, false);
    assert.equal(res.violations[0].rule, "deny");
  });

  it("HOLDS — backslash separators are normalised before matching", () => {
    const res = checkScope([".github\\workflows\\ci.yml"], { deny: DENY });
    assert.equal(res.ok, false, "Windows-style separators must not evade deny");
  });
});

describe("CLAIM: deny patterns are matched against canonical paths", () => {
  // GAP: normalizePath() only swaps separators. It does not resolve `.`/`..`
  // segments nor apply case folding, so deny matching is done on the raw
  // string. Reachable with non-git-derived input — see the envelope test below.

  it("relative-dot prefix must not evade a deny rule", { todo: "normalizePath() does not strip a leading './'" }, () => {
    const res = checkScope(["./.github/workflows/ci.yml"], { deny: DENY });
    assert.equal(res.ok, false);
  });

  it("parent traversal must not evade a deny rule", { todo: "normalizePath() does not resolve '..' segments" }, () => {
    const res = checkScope(["src/../.github/workflows/ci.yml"], { deny: DENY });
    assert.equal(res.ok, false);
  });

  it("case variation must not evade a deny rule on case-insensitive filesystems", { todo: "matchesGlob() is case-sensitive; .GITHUB/ is the same dir on macOS/Windows" }, () => {
    const res = checkScope([".GITHUB/workflows/ci.yml"], { deny: DENY });
    assert.equal(res.ok, false);
  });

  it("REACHABILITY — agent-authored envelope allowed_paths reach checkScope unsanitised", { todo: "same canonicalisation gap, reachable via validateEnvelope()" }, () => {
    const res = validateEnvelope(
      {
        id: "T1",
        title: "t",
        prompt: "p",
        allowed_paths: ["./.github/workflows/deploy.yml"],
      },
      { scopeConfig: { deny: DENY }, skipPremiseCheck: true }
    );
    const leaked = !(res.errors || []).some((e) => /protected scope/i.test(e));
    assert.equal(leaked, false, "envelope must not smuggle a denied path past the gate via './'");
  });
});

describe("CLAIM: 75 KB diff payload governor", () => {
  it("HOLDS — the limit is derived from config.limits.diffKb and applied inclusively", async () => {
    await withTempRepo(async (dir) => {
      writeFileSync(join(dir, "big.txt"), "x".repeat(2048), "utf-8");
      const res = await gate({
        root: dir,
        config: {
          _root: dir,
          provider: "jules",
          limits: { diffKb: 1, promptKb: 50, dailyTasks: 300 },
          scope: { deny: [], allow: [], protect: [] },
          verify: {},
        },
        base: "HEAD",
        mode: "working-tree",
      });
      const payload = (res.phases || []).find((p) => p.phase === "payload");
      assert.ok(payload, "gate must emit a payload phase");
      assert.equal(payload.limitBytes, 1 * 1024, "limit must be diffKb * 1024");
      assert.equal(payload.ok, payload.bytes <= payload.limitBytes, "governor must be an inclusive <= comparison");
    });
  });

  it("HOLDS — payload is measured in bytes, not UTF-16 code units", async () => {
    await withTempRepo(async (dir) => {
      // 200 astral-plane chars: 200 UTF-16 units *pairs*, 800 UTF-8 bytes.
      const emoji = "🔥".repeat(200);
      writeFileSync(join(dir, "multibyte.txt"), emoji, "utf-8");
      const bytes = diffBytes(dir, "HEAD", "working-tree");
      assert.ok(
        bytes >= 800,
        `multi-byte content must be counted as bytes (got ${bytes}); a char-length governor would under-count and let oversized diffs through`
      );
    });
  });
});

describe("CLAIM: secret scanner blocks credentials pre-dispatch", () => {
  const AWS = "AKIA" + "IOSFODNN7EXAMPLE";

  it("HOLDS — a high-confidence key on an added line is flagged", () => {
    const res = scanDiff(`+const k = "${AWS}";`);
    assert.equal(res.ok, false);
    assert.ok(res.findings.some((f) => f.type === "HIGH_CONFIDENCE_SECRET"));
  });

  it("HOLDS — a key on a removed line is correctly ignored (removal is not a leak)", () => {
    const res = scanDiff(`-const k = "${AWS}";`);
    assert.equal(res.ok, true);
  });

  it("HOLDS — the `+++` file header is not mistaken for an added line", () => {
    const res = scanDiff(`+++ b/f.js\n+const k = "${AWS}";`);
    assert.equal(res.ok, false, "the real added line must still be scanned");
  });

  it("a key split across two added lines must still be flagged", { todo: "scanner joins added lines with \\n; regexes cannot span the boundary" }, () => {
    const res = scanDiff(`+const k = "AKIA" +\n+  "IOSFODNN7EXAMPLE";`);
    assert.equal(res.ok, false);
  });

  it("a key with zero-width characters injected must still be flagged", { todo: "no unicode normalisation / zero-width stripping before matching" }, () => {
    const res = scanDiff(`+const k = "AKIA​IOSFODNN7EXAMPLE";`);
    assert.equal(res.ok, false);
  });

  it("a base64-wrapped key must still be flagged", { todo: "scanner does not attempt base64 decoding of added lines" }, () => {
    const res = scanDiff(`+const k = "${Buffer.from(AWS).toString("base64")}";`);
    assert.equal(res.ok, false);
  });
});

describe("CLAIM: router force-routes sensitive paths to the primary provider", () => {
  const cfg = { provider: "jules", scope: { deny: [] }, router: { enabled: true, threshold: 0 } };

  it("HOLDS — a posix auth path in the prompt cannot be talked down to the fast tier", () => {
    const res = classifyTaskComplexity({ title: "Typo", prompt: "Fix a typo in src/auth/session.mjs." }, cfg);
    assert.equal(res.tier, "complex");
    assert.equal(res.forced, true);
  });

  it("HOLDS — traversal in the prompt still trips the sensitive-path guard", () => {
    const res = classifyTaskComplexity({ prompt: "Fix a typo in src/../auth/session.mjs." }, cfg);
    assert.equal(res.tier, "complex");
  });

  it("HOLDS — targetFiles are normalised, so backslash paths are still caught", () => {
    const res = classifyTaskComplexity({ prompt: "Fix a typo.", targetFiles: ["src\\auth\\session.mjs"] }, cfg);
    assert.equal(res.tier, "complex");
    assert.equal(res.forced, true);
  });

  it("HOLDS — migrations and key material force the primary provider", () => {
    for (const p of ["db/migrations/001.sql", "keys/prod.pem"]) {
      assert.equal(classifyTaskComplexity({ prompt: `Fix a typo in ${p}.` }, cfg).tier, "complex", p);
    }
  });

  it("a backslash auth path written in the prompt must force the primary provider", { todo: "extractPathTokens() only recognises '/' as a separator, unlike the targetFiles path" }, () => {
    const res = classifyTaskComplexity({ prompt: "Fix a typo in src\\auth\\session.mjs." }, cfg);
    assert.equal(res.tier, "complex");
  });
});

describe("CLAIM: provider URL token guard (v0.32.5)", () => {
  const mk = (url, extra = {}) => () => createProvider({ name: "x", type: "http", url, ...extra });

  it("HOLDS — {token} is rejected in url, query string and sendMessageUrl", () => {
    assert.throws(mk("https://e.com/{token}/s"), /Insecure token interpolation/);
    assert.throws(mk("https://e.com/s?key={token}"), /Insecure token interpolation/);
    assert.throws(mk("https://e.com/s", { sendMessageUrl: "https://e.com/{token}" }), /Insecure token interpolation/);
  });

  it("SOUND — the guard admits exactly the templates that interpolateString would not substitute", () => {
    // interpolateString matches /\{(\w+)\}/ and resolves against a data object
    // that no longer carries the token. These variants are therefore inert:
    // the guard allowing them is correct, not an oversight.
    const inert = [
      "https://e.com/{ token }/s", // whitespace -> \w+ does not match
      "https://e.com/%7Btoken%7D/s", // percent-encoded -> not a brace pair
      "https://e.com/{TOKEN}/s", // wrong case -> data.TOKEN is undefined
      "https://e.com/{tokens}/s", // different key -> data.tokens is undefined
    ];
    for (const url of inert) {
      assert.doesNotThrow(mk(url), `${url} is inert and must not be rejected`);
      assert.equal(/\{token\}/.test(url), false, `${url} must not contain a substitutable {token}`);
    }
  });

  it("HOLDS — a spec with no token reference builds normally", () => {
    assert.doesNotThrow(mk("https://jules.googleapis.com/v1alpha/sessions"));
  });
});
