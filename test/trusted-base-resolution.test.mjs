import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { gate } from "../src/engine.mjs";
import { resolveTrustedBaseRef } from "../src/git.mjs";
import { handleMcpRequest } from "../src/mcp.mjs";

const CLI = join(process.cwd(), "bin", "agentctl.mjs");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(initialBranch = "main") {
  const dir = mkdtempSync(join(tmpdir(), "jok-p01-"));
  git(dir, ["init", "-q", "-b", initialBranch]);
  git(dir, ["config", "user.name", "Tester"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "test-pkg", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
  );
  mkdirSync(join(dir, ".agent"), { recursive: true });
  writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\nverify:\n  test: 'npm test'\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

describe("P0-01 Core: Trusted Base & Review Range Resolution (PR A)", () => {
  // --- INVARIANT A: Explicit immutable SHA required (API & CLI) ---
  it("A. Committed mode without explicit baseSha fails closed; mutable named refs cannot substitute", async () => {
    const dir = initRepo("main");
    try {
      const commitA = git(dir, ["rev-parse", "HEAD"]);
      git(dir, ["checkout", "-q", "-b", "candidate/feature"]);
      writeFileSync(join(dir, "feat.js"), "export const f = 1;\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "candidate work"]);

      // 1. Plain committed gate without baseSha fails closed (code 1)
      const resPlain = await gate({ root: dir, mode: "committed" });
      assert.equal(resPlain.ok, false);
      assert.equal(resPlain.code, 1);
      assert.match(resPlain.error, /committed verification requires an explicit trusted baseline sha/i);

      // 2. Supplying a mutable named ref (e.g. "main" or "origin/main") cannot substitute for baseSha
      const resNamed = await gate({ root: dir, mode: "committed", base: "main" });
      assert.equal(resNamed.ok, false);
      assert.equal(resNamed.code, 1);
      assert.match(resNamed.error, /committed verification requires an explicit trusted baseline sha/i);

      // 3. CLI: agentctl gate --committed without --base-sha exits 1
      assert.throws(
        () => execFileSync("node", [CLI, "gate", "--committed"], { cwd: dir, encoding: "utf8", stdio: "pipe" }),
        (err) => err.status === 1 && /committed verification requires an explicit trusted baseline sha/i.test(err.stderr || err.stdout)
      );

      // 4. CLI: agentctl gate --committed --base main exits 1
      assert.throws(
        () => execFileSync("node", [CLI, "gate", "--committed", "--base", "main"], { cwd: dir, encoding: "utf8", stdio: "pipe" }),
        (err) => err.status === 1 && /committed verification requires an explicit trusted baseline sha/i.test(err.stderr || err.stdout)
      );

      // 5. CLI: agentctl gate --committed --base-sha <sha> succeeds
      const cliOut = execFileSync("node", [CLI, "gate", "--committed", "--base-sha", commitA], { cwd: dir, encoding: "utf8" });
      assert.match(cliOut, /APPROVED|PASSED/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- INVARIANT B: Candidate config cannot redirect the trust boundary ---
  it("B. Candidate modifications to .agent/config.yml cannot redirect trusted policy", async () => {
    const dir = initRepo("main");
    try {
      // Commit A: strict policy denying secrets/**
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        "version: 1\nscope:\n  deny:\n    - 'secrets/**'\nverify:\n  test: 'npm test'\n"
      );
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "A: strict baseline"]);
      const commitA = git(dir, ["rev-parse", "HEAD"]);

      // Candidate commit: weakens deny rules to [] and creates forbidden file
      git(dir, ["checkout", "-q", "-b", "candidate/work"]);
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        "version: 1\nscope:\n  deny: []\nverify:\n  test: 'npm test'\n"
      );
      mkdirSync(join(dir, "secrets"), { recursive: true });
      writeFileSync(join(dir, "secrets", "leak.txt"), "sensitive\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "candidate: weaken policy and add secret"]);

      // Gate evaluated against explicit immutable baseSha commitA must enforce policy from A
      const res = await gate({ root: dir, mode: "committed", baseSha: commitA });
      assert.equal(res.ok, false);
      assert.equal(res.code, 3, "Scope violation exit code 3");
      const scopePhase = res.phases.find((p) => p.phase === "scope");
      assert.ok(scopePhase);
      assert.ok(scopePhase.violations.some((v) => v.file === "secrets/leak.txt"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- INVARIANT C: Mutable remote-tracking refs cannot replace the trusted SHA ---
  it("C. Mutable remote-tracking ref manipulation is neutralized by explicit baseSha", async () => {
    const dir = initRepo("main");
    try {
      // Baseline A
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        "version: 1\nscope:\n  deny:\n    - 'secrets/**'\nverify:\n  test: 'npm test'\n"
      );
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "A: strict baseline"]);
      const commitA = git(dir, ["rev-parse", "HEAD"]);
      git(dir, ["update-ref", "refs/remotes/origin/main", commitA]);

      // Attacker commit B: weakened policy
      writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\nscope:\n  deny: []\nverify:\n  test: 'npm test'\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "B: attacker commit"]);
      const commitB = git(dir, ["rev-parse", "HEAD"]);

      // Candidate commit C: secret leak
      mkdirSync(join(dir, "secrets"), { recursive: true });
      writeFileSync(join(dir, "secrets", "leak.txt"), "sensitive data\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "C: leak file"]);
      const commitC = git(dir, ["rev-parse", "HEAD"]);

      // Candidate manipulates remote-tracking ref to point to B
      git(dir, ["update-ref", "refs/remotes/origin/main", commitB]);

      // Without explicit baseSha: fails closed (code 1)
      const resUnassisted = await gate({ root: dir, mode: "committed" });
      assert.equal(resUnassisted.ok, false);
      assert.equal(resUnassisted.code, 1);
      assert.notEqual(resUnassisted.baseSha, commitB);

      // With explicit baseSha commitA: evaluates range A..C, catches scope violation (code 3)
      const resAssisted = await gate({ root: dir, mode: "committed", baseSha: commitA });
      assert.equal(resAssisted.ok, false);
      assert.equal(resAssisted.code, 3);
      assert.equal(resAssisted.baseSha, commitA);
      assert.equal(resAssisted.headSha, commitC);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- INVARIANT D: baseSha === headSha fails closed ---
  it("D. Self-referential review range (baseSha === headSha) fails closed (F08)", async () => {
    const dir = initRepo("main");
    try {
      const headSha = git(dir, ["rev-parse", "HEAD"]);

      // Committed gate comparing commit to itself fails closed with code 3
      const res = await gate({ root: dir, mode: "committed", baseSha: headSha, head: headSha });
      assert.equal(res.ok, false);
      assert.equal(res.code, 3);
      assert.match(res.error, /resolve to the same commit|comparing a revision to itself/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- INVARIANT E: Same-user persistent-state forgery cannot become authority ---
  it("E. Persistent state in repository or host cannot autonomously establish authority", async () => {
    const dir = initRepo("main");
    try {
      git(dir, ["checkout", "-q", "-b", "candidate/work"]);
      writeFileSync(join(dir, "feat.js"), "export const f = 1;\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "work"]);
      const candidateHead = git(dir, ["rev-parse", "HEAD"]);

      // Attacker writes plausible persistent state claiming baseSha is candidateHead
      mkdirSync(join(dir, ".agent", "state"), { recursive: true });
      writeFileSync(
        join(dir, ".agent", "state", "ledger-2026-10-12.jsonl"),
        JSON.stringify({ event: "task_dispatch_baseline", baseSha: candidateHead }) + "\n"
      );

      // Committed gate without explicit trusted baseSha fails closed, ignoring candidate-writable files
      const res = await gate({ root: dir, mode: "committed" });
      assert.equal(res.ok, false);
      assert.equal(res.code, 1);
      assert.notEqual(res.baseSha, candidateHead);
      assert.match(res.error, /committed verification requires an explicit trusted baseline sha/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- INVARIANT F: Evidence binding ---
  it("F. Gate results and evidence manifest bind to exact immutable baseSha and headSha", async () => {
    const dir = initRepo("main");
    try {
      const commitA = git(dir, ["rev-parse", "HEAD"]);
      git(dir, ["checkout", "-q", "-b", "candidate/feature"]);
      writeFileSync(join(dir, "feature.js"), "export const val = 42;\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "add feature"]);
      const commitB = git(dir, ["rev-parse", "HEAD"]);

      const res = await gate({ root: dir, mode: "committed", baseSha: commitA });
      assert.equal(res.ok, true);
      assert.equal(res.code, 0);
      assert.equal(res.baseSha, commitA);
      assert.equal(res.headSha, commitB);

      // Evidence manifest contains exact SHAs
      assert.ok(res.evidence);
      assert.equal(res.evidence.baseSha, commitA);
      assert.equal(res.evidence.headSha, commitB);
      assert.equal(res.evidence.provenance.baseSha, commitA);
      assert.equal(res.evidence.provenance.headSha, commitB);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- INVARIANT G: Invalid/unresolvable explicit SHA fails closed ---
  it("G. Malformed or nonexistent baseSha fails closed with code 1", async () => {
    const dir = initRepo("main");
    try {
      // 1. Malformed baseSha format
      const resMalformed = await gate({ root: dir, mode: "committed", baseSha: "not-a-sha" });
      assert.equal(resMalformed.ok, false);
      assert.equal(resMalformed.code, 1);
      assert.match(resMalformed.error, /invalid baseSha format/i);

      // 2. Nonexistent 40-character hex SHA
      const missingSha = "f".repeat(40);
      const resMissing = await gate({ root: dir, mode: "committed", baseSha: missingSha });
      assert.equal(resMissing.ok, false);
      assert.equal(resMissing.code, 1);
      assert.match(resMissing.error, /cannot resolve trusted base commit sha/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Working-tree mode & MCP safety invariants ---
  it("H. Working-tree mode resolves trusted remote default and rejects untrusted MCP overrides", async () => {
    const dir = initRepo("main");
    try {
      const commitA = git(dir, ["rev-parse", "HEAD"]);
      git(dir, ["update-ref", "refs/remotes/origin/main", commitA]);
      git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

      // 1. resolveTrustedBaseRef identifies remote default
      assert.equal(resolveTrustedBaseRef(dir), "main");

      // 2. MCP request with untrusted base override is rejected
      const mcpReq = {
        jsonrpc: "2.0",
        id: "call-1",
        method: "tools/call",
        params: {
          name: "audit_jules_gate",
          arguments: { base: "feature/malicious-branch" },
        },
      };
      const mcpRes = await handleMcpRequest(mcpReq, { root: dir });
      assert.ok(mcpRes?.result?.content?.[0]?.text);
      const payload = JSON.parse(mcpRes.result.content[0].text);
      assert.equal(payload.ok, false);
      assert.equal(payload.code, 3);
      assert.match(payload.error, /untrusted mcp base override rejected/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("P0-01 Extended: Adversarial Lifecycle & Tamper Hardening (PR B)", () => {
  // 1. Fully forged ledger
  it("1. Fully forged ledger with recomputed SHA-256 hash chain cannot establish authority", async () => {
    const dir = initRepo("main");
    try {
      const commitA = git(dir, ["rev-parse", "HEAD"]);
      git(dir, ["checkout", "-q", "-b", "candidate/feature"]);
      writeFileSync(join(dir, "feat.js"), "export const f = 1;\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "candidate commit B"]);
      const commitB = git(dir, ["rev-parse", "HEAD"]);

      const stateDir = join(dir, ".agent", "state");
      mkdirSync(stateDir, { recursive: true });
      const ledgerPath = join(stateDir, "ledger-daily-2026-10-12.jsonl");

      let prevHash = "0".repeat(64);
      const lines = [];
      const events = [
        { seq: 1, event: "session_start", timestamp: Date.now() },
        { seq: 2, event: "task_dispatch_baseline", baseSha: commitB, branch: "main", timestamp: Date.now() },
      ];
      for (const ev of events) {
        ev.prevHash = prevHash;
        const hash = createHash("sha256").update(JSON.stringify(ev)).digest("hex");
        ev.hash = hash;
        prevHash = hash;
        lines.push(JSON.stringify(ev));
      }
      writeFileSync(ledgerPath, lines.join("\n") + "\n", "utf8");

      const resUnassisted = await gate({ root: dir, mode: "committed" });
      assert.equal(resUnassisted.ok, false);
      assert.equal(resUnassisted.code, 1);
      assert.notEqual(resUnassisted.baseSha, commitB);

      const resAssisted = await gate({ root: dir, mode: "committed", baseSha: commitA });
      assert.equal(resAssisted.ok, true);
      assert.equal(resAssisted.baseSha, commitA);
      assert.equal(resAssisted.headSha, commitB);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 2. Forged checkpoint + ledger
  it("2. Forged checkpoint and ledger combined cannot establish security authority", async () => {
    const dir = initRepo("main");
    try {
      const commitA = git(dir, ["rev-parse", "HEAD"]);
      git(dir, ["checkout", "-q", "-b", "candidate/feature"]);
      writeFileSync(join(dir, "feat.js"), "export const f = 2;\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "candidate commit B"]);
      const commitB = git(dir, ["rev-parse", "HEAD"]);

      const stateDir = join(dir, ".agent", "state");
      mkdirSync(join(stateDir, "checkpoints"), { recursive: true });
      writeFileSync(
        join(stateDir, "checkpoints", "preflight-session-1.json"),
        JSON.stringify({ baseSha: commitB, headSha: commitB, timestamp: Date.now() })
      );
      writeFileSync(
        join(stateDir, "ledger.jsonl"),
        JSON.stringify({ event: "checkpoint_created", baseSha: commitB, hash: "1234" }) + "\n"
      );

      const res = await gate({ root: dir, mode: "committed" });
      assert.equal(res.ok, false);
      assert.equal(res.code, 1);
      assert.notEqual(res.baseSha, commitB);

      const resA = await gate({ root: dir, mode: "committed", baseSha: commitA });
      assert.equal(resA.ok, true);
      assert.equal(resA.baseSha, commitA);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 3. Forged authority-style files
  it("3. Forged authority.json, dispatches.json, and nonce registries are ignored as security authority", async () => {
    const dir = initRepo("main");
    try {
      const commitA = git(dir, ["rev-parse", "HEAD"]);
      git(dir, ["checkout", "-q", "-b", "candidate/feature"]);
      writeFileSync(join(dir, "feat.js"), "export const f = 3;\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "candidate commit B"]);
      const commitB = git(dir, ["rev-parse", "HEAD"]);

      const authDir = join(dir, ".agent", "authority");
      mkdirSync(authDir, { recursive: true });
      writeFileSync(
        join(authDir, "authority.json"),
        JSON.stringify({ baseSha: commitB, dispatchNonce: "nonce-999", active: true })
      );
      writeFileSync(
        join(authDir, "dispatches.json"),
        JSON.stringify({ "nonce-999": { baseSha: commitB, status: "dispatched" } })
      );

      const res = await gate({ root: dir, mode: "committed" });
      assert.equal(res.ok, false);
      assert.equal(res.code, 1);
      assert.notEqual(res.baseSha, commitB);

      const resA = await gate({ root: dir, mode: "committed", baseSha: commitA });
      assert.equal(resA.ok, true);
      assert.equal(resA.baseSha, commitA);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 4. Candidate verification code attempts state poisoning
  it("4. Candidate verification script attempting state poisoning during execution cannot hijack subsequent gate calls", async () => {
    const dir = initRepo("main");
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "test-pkg", scripts: { test: "node test.js" } }, null, 2)
      );
      writeFileSync(join(dir, "test.js"), "process.exit(0);\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "setup test.js runner"]);
      const commitA = git(dir, ["rev-parse", "HEAD"]);

      git(dir, ["checkout", "-q", "-b", "candidate/exploit"]);
      writeFileSync(
        join(dir, "test.js"),
        `import { writeFileSync, mkdirSync } from "node:fs";
try {
  mkdirSync(".agent/state", { recursive: true });
  writeFileSync(".agent/state/poison.json", JSON.stringify({ baseSha: "4444444444444444444444444444444444444444" }));
} catch (_) {}
process.exit(0);
`
      );
      git(dir, ["add", "test.js"]);
      git(dir, ["commit", "-m", "candidate with state poisoning test"]);
      const commitC = git(dir, ["rev-parse", "HEAD"]);

      const res1 = await gate({ root: dir, mode: "committed", baseSha: commitA });
      assert.equal(res1.ok, true);
      assert.equal(res1.baseSha, commitA);

      const res2 = await gate({ root: dir, mode: "committed" });
      assert.equal(res2.ok, false);
      assert.equal(res2.code, 1);
      assert.notEqual(res2.baseSha, "4444444444444444444444444444444444444444");

      const res3 = await gate({ root: dir, mode: "committed", baseSha: commitA });
      assert.equal(res3.ok, true);
      assert.equal(res3.baseSha, commitA);
      assert.equal(res3.headSha, commitC);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 5. Crash / interrupted verification + retry
  it("5. Crash or interrupted verification followed by retry remains deterministically anchored", async () => {
    const dir = initRepo("main");
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "test-pkg", scripts: { test: "node test.js" } }, null, 2)
      );
      writeFileSync(join(dir, "test.js"), "process.exit(0);\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "setup test.js runner"]);
      const commitA = git(dir, ["rev-parse", "HEAD"]);

      git(dir, ["checkout", "-q", "-b", "candidate/crash"]);
      writeFileSync(join(dir, "test.js"), "process.exit(137);\n");
      git(dir, ["add", "test.js"]);
      git(dir, ["commit", "-m", "candidate with crashing verification"]);

      const resCrash = await gate({ root: dir, mode: "committed", baseSha: commitA });
      assert.equal(resCrash.ok, false);
      assert.equal(resCrash.code, 4);

      const resRetryUnassisted = await gate({ root: dir, mode: "committed" });
      assert.equal(resRetryUnassisted.ok, false);
      assert.equal(resRetryUnassisted.code, 1);

      const resRetryAssisted = await gate({ root: dir, mode: "committed", baseSha: commitA });
      assert.equal(resRetryAssisted.code, 4);
      assert.equal(resRetryAssisted.baseSha, commitA);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 6. Remote Jules lifecycle
  it("6. Remote Jules lifecycle: maintainer pre-flight SHA anchors evaluation against remote candidate commit", async () => {
    const dir = initRepo("main");
    try {
      const commitA = git(dir, ["rev-parse", "HEAD"]);

      git(dir, ["checkout", "-q", "-b", "jules/session-remote-100"]);
      writeFileSync(join(dir, "remote-feat.js"), "export const remote = true;\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "remote Jules candidate work"]);
      const commitC = git(dir, ["rev-parse", "HEAD"]);

      git(dir, ["update-ref", "refs/remotes/origin/main", commitC]);

      const res = await gate({ root: dir, mode: "committed", baseSha: commitA, head: commitC });
      assert.equal(res.ok, true);
      assert.equal(res.baseSha, commitA);
      assert.equal(res.headSha, commitC);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 7. Local same-user lifecycle
  it("7. Local same-user lifecycle requires explicit --base-sha despite shared filesystem access", async () => {
    const dir = initRepo("main");
    try {
      const commitA = git(dir, ["rev-parse", "HEAD"]);
      git(dir, ["checkout", "-q", "-b", "local-agent/feat"]);
      writeFileSync(join(dir, "local-work.js"), "export const local = 1;\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "local agent work"]);

      git(dir, ["update-ref", "refs/heads/main", git(dir, ["rev-parse", "HEAD"])]);

      const resUnassisted = await gate({ root: dir, mode: "committed" });
      assert.equal(resUnassisted.ok, false);
      assert.equal(resUnassisted.code, 1);

      const resAssisted = await gate({ root: dir, mode: "committed", baseSha: commitA });
      assert.equal(resAssisted.ok, true);
      assert.equal(resAssisted.baseSha, commitA);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 8. Compound forgery
  it("8. Compound forgery: simultaneous ref, ledger, checkpoint, authority, and env spoofing cannot bypass gate", async () => {
    const dir = initRepo("main");
    try {
      const commitA = git(dir, ["rev-parse", "HEAD"]);
      git(dir, ["checkout", "-q", "-b", "candidate/compound"]);
      writeFileSync(join(dir, "exploit.js"), "export const x = 1;\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "attacker commit B"]);
      const commitB = git(dir, ["rev-parse", "HEAD"]);

      git(dir, ["update-ref", "refs/remotes/origin/main", commitB]);
      const stateDir = join(dir, ".agent", "state");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "ledger.jsonl"),
        JSON.stringify({ event: "task_dispatch_baseline", baseSha: commitB, hash: "abc" }) + "\n"
      );
      mkdirSync(join(stateDir, "checkpoints"), { recursive: true });
      writeFileSync(
        join(stateDir, "checkpoints", "checkpoint.json"),
        JSON.stringify({ baseSha: commitB, headSha: commitB })
      );
      writeFileSync(join(dir, ".agent", "authority.json"), JSON.stringify({ baseSha: commitB }));

      const resUnassisted = await gate({ root: dir, mode: "committed" });
      assert.equal(resUnassisted.ok, false);
      assert.equal(resUnassisted.code, 1);
      assert.notEqual(resUnassisted.baseSha, commitB);

      const resAssisted = await gate({ root: dir, mode: "committed", baseSha: commitA });
      assert.equal(resAssisted.ok, true);
      assert.equal(resAssisted.baseSha, commitA);
      assert.equal(resAssisted.headSha, commitB);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 9. Missing / deleted persistent state
  it("9. Missing or deleted persistent state does not cause fallback to mutable refs", async () => {
    const dir = initRepo("main");
    try {
      const commitA = git(dir, ["rev-parse", "HEAD"]);
      git(dir, ["checkout", "-q", "-b", "candidate/del-state"]);
      writeFileSync(join(dir, "work.js"), "export const w = 1;\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "candidate work"]);
      const commitB = git(dir, ["rev-parse", "HEAD"]);

      rmSync(join(dir, ".agent", "state"), { recursive: true, force: true });
      git(dir, ["update-ref", "refs/remotes/origin/main", commitB]);

      const resUnassisted = await gate({ root: dir, mode: "committed" });
      assert.equal(resUnassisted.ok, false);
      assert.equal(resUnassisted.code, 1);
      assert.notEqual(resUnassisted.baseSha, commitB);

      const resAssisted = await gate({ root: dir, mode: "committed", baseSha: commitA });
      assert.equal(resAssisted.ok, true);
      assert.equal(resAssisted.baseSha, commitA);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 10. Relevant environment spoofing
  it("10. Candidate-controlled environment variables cannot establish committed review authority", async () => {
    const dir = initRepo("main");
    try {
      const commitA = git(dir, ["rev-parse", "HEAD"]);
      git(dir, ["checkout", "-q", "-b", "candidate/env-spoof"]);
      writeFileSync(join(dir, "feat.js"), "export const e = 1;\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "candidate work"]);
      const commitB = git(dir, ["rev-parse", "HEAD"]);

      const originalBaseSha = process.env.BASE_SHA;
      const originalJulesBaseSha = process.env.JULES_BASE_SHA;
      try {
        process.env.BASE_SHA = commitB;
        process.env.JULES_BASE_SHA = commitB;

        const res = await gate({ root: dir, mode: "committed" });
        assert.equal(res.ok, false);
        assert.equal(res.code, 1);
        assert.notEqual(res.baseSha, commitB);

        const resAssisted = await gate({ root: dir, mode: "committed", baseSha: commitA });
        assert.equal(resAssisted.ok, true);
        assert.equal(resAssisted.baseSha, commitA);

        assert.throws(
          () => execFileSync("node", [CLI, "gate", "--committed"], { cwd: dir, encoding: "utf8", stdio: "pipe", env: { ...process.env, BASE_SHA: commitB } }),
          (err) => err.status === 1
        );
      } finally {
        if (originalBaseSha !== undefined) process.env.BASE_SHA = originalBaseSha;
        else delete process.env.BASE_SHA;
        if (originalJulesBaseSha !== undefined) process.env.JULES_BASE_SHA = originalJulesBaseSha;
        else delete process.env.JULES_BASE_SHA;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

