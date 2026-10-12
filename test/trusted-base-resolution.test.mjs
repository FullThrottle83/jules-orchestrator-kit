import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
