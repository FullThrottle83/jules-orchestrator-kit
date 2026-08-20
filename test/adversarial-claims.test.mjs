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
 *
 * Probes that read "HOLDS" were once todo gaps and are now closed; they remain
 * here as regression tests. Several encode cross-platform behaviour that cannot
 * be observed on Linux alone — the same repository is checked out on macOS and
 * Windows, where the filesystem is case-insensitive and paths are written with
 * backslashes, so the gate must hold under the most permissive of the three.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { checkScope, scanDiff } from "../src/security.mjs";
import { canonicalizePath } from "../src/config.mjs";
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
  // canonicalizePath() resolves `.`/`..` and collapses separators before
  // matching, and deny/protect fold case. Allow deliberately does not fold
  // case, so a case mismatch there yields "not allowed" — the safe direction.

  it("HOLDS — a relative-dot prefix cannot evade a deny rule", () => {
    const res = checkScope(["./.github/workflows/ci.yml"], { deny: DENY });
    assert.equal(res.ok, false);
  });

  it("HOLDS — parent traversal cannot evade a deny rule", () => {
    const res = checkScope(["src/../.github/workflows/ci.yml"], { deny: DENY });
    assert.equal(res.ok, false);
  });

  it("HOLDS — case variation cannot evade a deny rule (macOS/Windows parity)", () => {
    const res = checkScope([".GITHUB/workflows/ci.yml"], { deny: DENY });
    assert.equal(res.ok, false);
  });

  it("HOLDS — agent-authored envelope allowed_paths are canonicalised before matching", () => {
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

describe("CROSS-PLATFORM: the gate must hold under the most permissive filesystem", () => {
  // A repository authored on Linux is checked out on macOS (APFS) and Windows
  // (NTFS), where paths are case-insensitive. The gate cannot assume the
  // semantics of the host it happens to be running on.

  it("canonicalizePath reduces every spelling of the same path to one form", () => {
    for (const variant of [
      ".github/workflows/ci.yml",
      "./.github/workflows/ci.yml",
      ".github//workflows/ci.yml",
      ".github/./workflows/ci.yml",
      "src/../.github/workflows/ci.yml",
      ".github\\workflows\\ci.yml",
      "./src/../.github//workflows/./ci.yml",
    ]) {
      assert.equal(canonicalizePath(variant), ".github/workflows/ci.yml", variant);
    }
  });

  it("canonicalizePath preserves escaping traversal so callers can reject it", () => {
    assert.equal(canonicalizePath("../../etc/passwd"), "../../etc/passwd");
    assert.equal(canonicalizePath("a/../../b"), "../b");
  });

  it("a path escaping the repository root is rejected outright, not pattern-matched", () => {
    const res = checkScope(["../../etc/passwd"], { deny: DENY });
    assert.equal(res.ok, false);
    assert.equal(res.violations[0].pattern, "<traversal>");
  });

  it("deny folds case for every segment, not just the first", () => {
    for (const variant of [".GITHUB/workflows/ci.yml", ".GitHub/Workflows/CI.yml", "KEYS/prod.PEM"]) {
      assert.equal(checkScope([variant], { deny: DENY }).ok, false, variant);
    }
  });

  it("allow does NOT fold case, so a case mismatch fails closed", () => {
    const res = checkScope(["src/Foo.mjs"], { deny: [], allow: ["src/foo.mjs"] });
    assert.equal(res.ok, false, "an unmatched allow must be a violation, never an implicit pass");
    assert.equal(res.violations[0].rule, "allow");
  });

  it("mixed separators in a single path still canonicalise", () => {
    assert.equal(checkScope(["src\\..\\.github/workflows\\ci.yml"], { deny: DENY }).ok, false);
  });

  it("a Windows-style sensitive path in a prompt forces the primary provider", () => {
    const cfg = { provider: "jules", scope: { deny: [] }, router: { enabled: true, threshold: 0 } };
    for (const p of ["src\\auth\\session.mjs", "db\\migrations\\001.sql", "keys\\prod.pem"]) {
      assert.equal(classifyTaskComplexity({ prompt: `Fix a typo in ${p}.` }, cfg).tier, "complex", p);
    }
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

  it("HOLDS — a key split across two added lines is flagged", () => {
    const res = scanDiff(`+const k = "AKIA" +\n+  "IOSFODNN7EXAMPLE";`);
    assert.equal(res.ok, false);
  });

  it("HOLDS — a key with zero-width characters injected is flagged", () => {
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

  it("HOLDS — a backslash auth path in the prompt forces the primary provider (Windows parity)", () => {
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
