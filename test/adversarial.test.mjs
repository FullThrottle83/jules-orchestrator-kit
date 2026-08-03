import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createProvider } from "../src/provider.mjs";
import { gate } from "../src/engine.mjs";
import { checkScope, matchesGlob } from "../src/security.mjs";
import { parseYaml } from "../src/config.mjs";
import { acquireLock, releaseLock } from "../src/state.mjs";

describe("Adversarial Security Test Suite (Audit Remediations)", () => {
  it("C1: Prevents shell command injection in exec provider (CWE-77)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jules-adv-rce-"));
    const pwnedFile = path.join(tmpDir, "PWNED");
    try {
      const customProvider = {
        name: "test-exec",
        type: "exec",
        command: "node",
        args: ["-e", "process.stdout.write('safe')"],
        promptViaStdin: true,
      };
      const provider = createProvider(customProvider, { _root: tmpDir });

      // Malicious prompt attempting command injection
      const maliciousPrompt = `fix"; touch "${pwnedFile}"; echo "hacked`;
      const res = await provider.dispatch({ prompt: maliciousPrompt });

      assert.equal(res.status, "completed");
      assert.equal(fs.existsSync(pwnedFile), false, "Command injection payload MUST NOT execute");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("C2: Fails closed when git base branch cannot be resolved", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jules-adv-git-"));
    try {
      // Non-git directory or unresolvable base ref
      const res = await gate({ root: tmpDir, base: "nonexistent_branch_xyz" });
      assert.equal(res.ok, false, "Gate MUST NOT return ok:true on unresolvable base branch");
      assert.equal(res.code, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("C3: Evaluates Deny rules BEFORE Allow rules unconditionally (CWE-183)", () => {
    const scope = {
      deny: [".github/**", "**/.env", "**/*.pem"],
      allow: ["**"],
      protect: [],
    };
    const res = checkScope([".github/workflows/ci.yml", ".env", "src/index.js"], scope);

    assert.equal(res.ok, false, "Deny rules MUST take precedence over Allow rules");
    assert.equal(res.violations.length, 2);
    assert.equal(res.violations[0].file, ".github/workflows/ci.yml");
    assert.equal(res.violations[1].file, ".env");
  });

  it("C4: Parses nested YAML list structure correctly", () => {
    const yaml = `
version: 1
scope:
  deny:
    - ".github/**"
    - "**/.env"
  allow:
    - "src/**"
limits:
  diffKb: 75
`;
    const parsed = parseYaml(yaml);
    assert.equal(parsed.version, 1);
    assert.ok(parsed.scope);
    assert.deepEqual(parsed.scope.deny, [".github/**", "**/.env"]);
    assert.deepEqual(parsed.scope.allow, ["src/**"]);
    assert.equal(parsed.limits?.diffKb, 75);
  });

  it("C5: Blocks prototype pollution keys in YAML parser (CWE-1321)", () => {
    const maliciousYaml = `
__proto__:
  polluted: true
`;
    assert.throws(
      () => parseYaml(maliciousYaml),
      (err) => err.message.includes("Illegal prototype key")
    );
    assert.equal(({}).polluted, undefined, "Object.prototype MUST NOT be polluted");
  });

  it("C6: Redacts secret token in dry-run output objects", async () => {
    const originalToken = process.env.JULES_API_KEY;
    try {
      process.env.JULES_API_KEY = "sk-SUPERSECRET-KEY-12345";
      const provider = createProvider("jules");
      const res = await provider.dispatch({ prompt: "test prompt" }, { dryRun: true });

      assert.equal(res.data.token, "[REDACTED]", "API token MUST be masked in output objects");
      assert.equal(JSON.stringify(res).includes("sk-SUPERSECRET-KEY-12345"), false);
    } finally {
      if (originalToken !== undefined) process.env.JULES_API_KEY = originalToken;
      else delete process.env.JULES_API_KEY;
    }
  });

  it("H1 & H2: Lock manager handles atomic creation and release cleanly without ESM require errors", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jules-adv-lock-"));
    try {
      const lock1 = acquireLock("Worker1", "task-100", ["src/main.js"], tmpDir);
      assert.equal(lock1.ok, true);

      // Concurrent acquire attempt for same task should fail
      const lock2 = acquireLock("Worker2", "task-100", ["src/main.js"], tmpDir);
      assert.equal(lock2.ok, false);
      assert.equal(lock2.holder, "Worker1");

      // Release lock should succeed cleanly without ReferenceError
      const released = releaseLock("task-100", tmpDir);
      assert.equal(released, true);

      // Re-acquiring after release should succeed
      const lock3 = acquireLock("Worker2", "task-100", ["src/main.js"], tmpDir);
      assert.equal(lock3.ok, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("H7: Escapes regex metacharacters in matchesGlob", () => {
    assert.equal(matchesGlob("app/(admin)/page.tsx", "app/(admin)/**"), true);
    assert.equal(matchesGlob("src/c++/x.h", "src/c++/**"), true);
    assert.equal(matchesGlob("src/index.js", "app/(admin)/**"), false);
  });
});
