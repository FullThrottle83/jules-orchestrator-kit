import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { gate, dispatch } from "../src/engine.mjs";
import { resolveTrustedPolicy } from "../src/config.mjs";
import { resolveTrustedBaseRef, resolveBase } from "../src/git.mjs";
import { handleMcpRequest } from "../src/mcp.mjs";
import { recordDispatchBaseline, verifyLedgerIntegrity } from "../src/state.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(initialBranch = "main") {
  const dir = mkdtempSync(join(tmpdir(), "jok-trusted-base-"));
  git(dir, ["init", "-q", "-b", initialBranch]);
  git(dir, ["config", "user.name", "Tester"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  return dir;
}

describe("P0-01: Trusted Base & Review Range Resolution", () => {
  it("working-tree .agent/config.yml attempts to redirect baseBranch", async () => {
    const dir = initRepo("main");
    try {
      // 1. Initial valid repository on main with test suite and locked policy
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "test-pkg", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
      );
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        "version: 1\nbaseBranch: main\nscope:\n  deny:\n    - 'secrets/**'\nverify:\n  test: 'npm test'\n"
      );
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "init: locked policy on main"]);
      git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

      // 2. Attacker creates an alternate branch with relaxed rules
      git(dir, ["checkout", "-q", "-b", "attacker/evil-base"]);
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        "version: 1\nbaseBranch: attacker/evil-base\nscope:\n  deny: []\nverify:\n  test: 'node -e \"process.exit(0)\"'\n"
      );
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "evil branch"]);

      // 3. Switch back to main and attempt to redirect baseBranch via working-tree config
      git(dir, ["checkout", "-q", "main"]);
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        "version: 1\nbaseBranch: attacker/evil-base\nscope:\n  deny: []\nverify:\n  test: 'node -e \"process.exit(0)\"'\n"
      );
      mkdirSync(join(dir, "secrets"), { recursive: true });
      writeFileSync(join(dir, "secrets", "leak.txt"), "untrusted payload\n");

      // 4. Run gate in working-tree mode without passing --base
      const res = await gate({ root: dir, mode: "working-tree" });

      // Gate must evaluate against trusted base 'main' and NOT 'attacker/evil-base'
      assert.equal(res.ok, false, "Gate must reject untrusted working tree changes");
      assert.equal(res.base, "main", "Trusted base must remain 'main' regardless of working-tree config");
      const scopePhase = res.phases.find((p) => p.phase === "scope");
      assert.ok(scopePhase, "Must have scope phase");
      assert.equal(scopePhase.ok, false, "Scope phase must fail closed on .agent/config.yml tampering");
      assert.ok(
        scopePhase.violations.some((v) => v.file === ".agent/config.yml"),
        "Must flag candidate .agent/config.yml modification under BUILTIN_PROTECT"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("base resolves to the same commit as the candidate head", async () => {
    const dir = initRepo("main");
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "test-pkg", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
      );
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "init"]);
      git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const headSha = git(dir, ["rev-parse", "HEAD"]);

      // Direct unit check on resolveBase
      const resolvedBase = resolveBase(dir, "main");
      assert.equal(resolvedBase, headSha, "resolveBase must return exact commit SHA");

      // Direct unit check on resolveTrustedPolicy
      const directPolicy = resolveTrustedPolicy(dir, "HEAD", "committed");
      assert.equal(directPolicy.ok, false);
      assert.equal(directPolicy.code, 3);
      assert.equal(directPolicy.baseSha, headSha);
      assert.equal(directPolicy.headSha, headSha);

      // Subcase A: Explicit base and head both set to main in committed mode
      const resMain = await gate({ root: dir, mode: "committed", base: "main", head: "main" });
      assert.equal(resMain.ok, false, "Committed diff against self must fail");
      assert.equal(resMain.code, 3, "Exit code must be 3");
      assert.match(resMain.error, /resolve to the same commit|comparing a revision to itself/i);
      assert.equal(resMain.baseSha, headSha);
      assert.equal(resMain.headSha, headSha);

      // Subcase B: base set to HEAD in committed mode
      const resHead = await gate({ root: dir, mode: "committed", base: "HEAD" });
      assert.equal(resHead.ok, false);
      assert.equal(resHead.code, 3);
      assert.match(resHead.error, /resolve to the same commit|comparing a revision to itself/i);
      assert.equal(resHead.baseSha, headSha);
      assert.equal(resHead.headSha, headSha);

      // Subcase C: Explicit identical commit SHA for base and head
      const resSha = await gate({ root: dir, mode: "committed", base: headSha, head: headSha });
      assert.equal(resSha.ok, false);
      assert.equal(resSha.code, 3);
      assert.match(resSha.error, /resolve to the same commit|comparing a revision to itself/i);

      // Subcase D: Committed mode without base fails closed (no implicit fallback to HEAD)
      const resDefault = await gate({ root: dir, mode: "committed" });
      assert.equal(resDefault.ok, false);
      assert.equal(resDefault.code, 1);
      assert.match(resDefault.error, /committed verification requires an explicit trusted baseline sha/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("explicit valid base + head", async () => {
    const dir = initRepo("main");
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "test-pkg", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
      );
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        "version: 1\nverify:\n  test: 'npm test'\n"
      );
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "init base commit"]);
      const mainSha = git(dir, ["rev-parse", "main"]);

      // Create feature branch with a legitimate edit
      git(dir, ["checkout", "-q", "-b", "feature/valid-edit"]);
      writeFileSync(join(dir, "feature.js"), "export const ok = true;\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "feat: add feature module"]);
      const featureSha = git(dir, ["rev-parse", "feature/valid-edit"]);

      // Switch back to main
      git(dir, ["checkout", "-q", "main"]);

      // Gate run specifying explicit base and head
      const res = await gate({
        root: dir,
        mode: "committed",
        base: "main",
        head: "feature/valid-edit",
      });

      assert.equal(res.ok, true, "Gate must approve valid explicit review range");
      assert.equal(res.code, 0);
      assert.equal(res.base, "main");
      assert.equal(res.baseSha, mainSha);
      assert.equal(res.headSha, featureSha);
      assert.notEqual(res.baseSha, res.headSha);
      assert.equal(res.evidence.baseSha, mainSha);
      assert.equal(res.evidence.headSha, featureSha);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("committed-mode comparison against a real parent/base", async () => {
    const dir = initRepo("main");
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "test-pkg", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
      );
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        "version: 1\nverify:\n  test: 'npm test'\n"
      );
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "init parent"]);
      const parentSha = git(dir, ["rev-parse", "HEAD"]);

      writeFileSync(join(dir, "second.js"), "export const step = 2;\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "second commit"]);
      const headSha = git(dir, ["rev-parse", "HEAD"]);

      // Evaluating committed mode with base HEAD~1
      const res = await gate({ root: dir, mode: "committed", base: "HEAD~1" });
      assert.equal(res.ok, true);
      assert.equal(res.code, 0);
      assert.equal(res.base, "HEAD~1");
      assert.equal(res.baseSha, parentSha);
      assert.equal(res.headSha, headSha);
      assert.notEqual(res.baseSha, res.headSha);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repository has no origin/HEAD and no trustworthy main/master/trunk: gate must fail closed and never adopt checked-out branch as base", async () => {
    // Initialise on 'feature/candidate' (no main, no master, no trunk, no origin/HEAD)
    const dir = initRepo("feature/candidate");
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "test-pkg", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
      );
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        "version: 1\nverify:\n  test: 'npm test'\n"
      );
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "candidate initial commit"]);

      writeFileSync(join(dir, "feature.js"), "export const feat = true;\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "candidate second commit"]);

      // 1. resolveTrustedBaseRef must refuse to guess or fall back to currently checked out branch
      const trustedBase = resolveTrustedBaseRef(dir);
      assert.equal(trustedBase, null, "Must return null when no origin/HEAD and no main/master/trunk exist");

      // 2. Gate in committed mode must FAIL CLOSED, not adopt feature/candidate and not produce empty diff
      const resCommitted = await gate({ root: dir, mode: "committed" });
      assert.equal(resCommitted.ok, false, "Must fail closed when no trustworthy base can be established");
      assert.equal(resCommitted.code, 1, "Exit code must be 1 (git_resolution failure)");
      assert.equal(resCommitted.base, null, "Must NOT adopt current checkout branch as trusted base");
      assert.equal(resCommitted.baseSha, null);
      assert.equal(resCommitted.headSha, null);
      assert.match(resCommitted.error, /unable to determine trusted base branch|committed verification requires an explicit trusted baseline sha/i);
      const gitPhase = resCommitted.phases.find((p) => p.phase === "git_resolution");
      assert.ok(gitPhase, "Must fail at git_resolution phase");

      // 3. Gate in working-tree mode must also FAIL CLOSED without --base
      const resWt = await gate({ root: dir, mode: "working-tree" });
      assert.equal(resWt.ok, false, "Working-tree mode must fail closed without trustworthy base");
      assert.equal(resWt.code, 1);
      assert.equal(resWt.base, null);
      assert.match(resWt.error, /unable to determine trusted base branch/i);

      // 4. Operator explicitly providing --base HEAD~1 enables evaluation
      const resExplicit = await gate({ root: dir, mode: "committed", base: "HEAD~1" });
      assert.equal(resExplicit.ok, true, "Explicit operator-supplied base succeeds");
      assert.equal(resExplicit.base, "HEAD~1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repository whose actual origin/HEAD points to non-main branch (trunk, develop) accepts it because it is explicitly the remote default", async () => {
    // Initialise on 'develop' with an explicit remote default
    const dir = initRepo("develop");
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "test-pkg", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
      );
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        "version: 1\nverify:\n  test: 'npm test'\n"
      );
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "develop root commit"]);
      const developSha = git(dir, ["rev-parse", "develop"]);

      // Set refs/remotes/origin/develop and symbolic-ref refs/remotes/origin/HEAD -> refs/remotes/origin/develop
      git(dir, ["update-ref", "refs/remotes/origin/develop", developSha]);
      git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"]);

      // Verify resolveTrustedBaseRef accepts develop because origin/HEAD explicitly points to it
      const detected = resolveTrustedBaseRef(dir);
      assert.equal(detected, "develop", "Must accept develop when explicitly pointed to by origin/HEAD");

      // Checkout feature branch off develop
      git(dir, ["checkout", "-q", "-b", "feature/on-develop"]);
      writeFileSync(join(dir, "dev-feat.js"), "export const dev = true;\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "feature commit"]);
      const featSha = git(dir, ["rev-parse", "HEAD"]);

      // Baseline is captured pre-dispatch from the verified remote default
      recordDispatchBaseline(dir, { baseSha: developSha, branch: "develop" });

      // Unassisted committed gate fails closed without autonomous authority
      const unassisted = await gate({ root: dir, mode: "committed" });
      assert.equal(unassisted.ok, false);
      assert.equal(unassisted.code, 1);
      assert.match(unassisted.error, /committed verification requires an explicit trusted baseline sha/i);

      // Assisted gate with pre-dispatch baseline developSha succeeds
      const res = await gate({ root: dir, mode: "committed", baseSha: developSha });
      assert.equal(res.ok, true);
      assert.equal(res.baseSha, developSha);
      assert.equal(res.headSha, featSha);

      // Verify that local-only develop without origin/HEAD is NOT guessed
      git(dir, ["symbolic-ref", "-d", "refs/remotes/origin/HEAD"]);
      git(dir, ["update-ref", "-d", "refs/remotes/origin/develop"]);
      const unlinkedDetected = resolveTrustedBaseRef(dir);
      assert.equal(unlinkedDetected, null, "Must NOT guess develop merely because it exists locally");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("MCP agent requests audit_jules_gate with base=<candidate branch> → gate must NOT accept that branch merely because the MCP caller supplied it", async () => {
    const dir = initRepo("main");
    try {
      // 1. Initial commit on main
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "test-pkg", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
      );
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        "version: 1\nverify:\n  test: 'npm test'\n"
      );
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "init on main"]);
      git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const mainSha = git(dir, ["rev-parse", "main"]);

      // 2. Candidate branch containing changes
      git(dir, ["checkout", "-q", "-b", "feat/agent-work"]);
      writeFileSync(join(dir, "candidate.js"), "export const candidate = true;\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "candidate changes"]);
      const candidateSha = git(dir, ["rev-parse", "HEAD"]);

      // 3. MCP agent requests audit_jules_gate with base='feat/agent-work'
      // The gate must NOT accept candidate branch as base merely because the MCP caller supplied it
      const mcpBypassRes = await handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 101,
          method: "tools/call",
          params: {
            name: "audit_jules_gate",
            arguments: { base: "feat/agent-work" },
          },
        },
        { root: dir }
      );

      assert.equal(mcpBypassRes.jsonrpc, "2.0");
      assert.equal(mcpBypassRes.id, 101);
      const bypassParsed = JSON.parse(mcpBypassRes.result.content[0].text);
      assert.equal(bypassParsed.ok, false, "Must reject untrusted MCP base override");
      assert.equal(bypassParsed.code, 3, "Exit code must indicate security policy rejection");
      assert.match(bypassParsed.error, /untrusted mcp base override rejected/i);
      assert.notEqual(bypassParsed.base, "feat/agent-work", "Must NOT accept candidate branch as base");

      // 4. MCP agent requests audit_jules_gate with NO base: resolves to trusted repository base 'main'
      const mcpDefaultRes = await handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 102,
          method: "tools/call",
          params: {
            name: "audit_jules_gate",
            arguments: {},
          },
        },
        { root: dir }
      );

      assert.equal(mcpDefaultRes.jsonrpc, "2.0");
      const defaultParsed = JSON.parse(mcpDefaultRes.result.content[0].text);
      assert.equal(defaultParsed.base, "main", "Must evaluate against trusted repository base 'main'");
      assert.equal(defaultParsed.baseSha, mainSha);
      assert.equal(defaultParsed.headSha, candidateSha);

      // 5. MCP agent requests audit_jules_gate with base matching trusted base: accepted
      const mcpValidRes = await handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 103,
          method: "tools/call",
          params: {
            name: "audit_jules_gate",
            arguments: { base: "main" },
          },
        },
        { root: dir }
      );
      assert.equal(mcpValidRes.jsonrpc, "2.0");
      const validParsed = JSON.parse(mcpValidRes.result.content[0].text);
      assert.equal(validParsed.base, "main");
      assert.equal(validParsed.baseSha, mainSha);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("missing/unresolvable base", async () => {
    const dir = initRepo("main");
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "test-pkg", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
      );
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "init"]);

      // Unresolvable base branch name
      const res = await gate({ root: dir, base: "non-existent-base-branch-999" });
      assert.equal(res.ok, false, "Gate must fail closed on unresolvable base");
      assert.equal(res.code, 1, "Exit code must be 1 for git resolution failure");
      assert.match(res.error, /Cannot resolve base reference/i);
      assert.equal(res.baseSha, null);
      const gitPhase = res.phases.find((p) => p.phase === "git_resolution");
      assert.ok(gitPhase, "Must record git_resolution phase");
      assert.equal(gitPhase.ok, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("behavior when the trusted base has no .agent/config.yml", async () => {
    const dir = initRepo("main");
    try {
      // Pristine repository with code and tests, but no .agent configuration in base commit
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "unconfigured-repo", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
      );
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "init without .agent"]);
      git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const mainSha = git(dir, ["rev-parse", "main"]);

      // Operator brings repository under gate via working-tree bootstrap scaffold
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        "version: 1\nverify:\n  test: 'npm test'\n"
      );

      const res = await gate({ root: dir, mode: "working-tree" });
      assert.equal(res.ok, true, "Gate must accept valid initial bootstrap scaffold");
      assert.equal(res.code, 0);
      assert.equal(res.base, "main");
      assert.equal(res.baseSha, mainSha);
      assert.equal(res.headSha, git(dir, ["rev-parse", "HEAD"]));
      assert.ok(res.evidence.baseSha, "Evidence must report baseSha in bootstrap mode");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("candidate modifications to configuration must not widen or redirect trusted policy", async () => {
    const dir = initRepo("main");
    try {
      // 1. Base commit on main establishes strict 50 KB diff ceiling and deny rule
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "test-pkg", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
      );
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        "version: 1\nlimits:\n  diff_kb: 50\nscope:\n  deny:\n    - 'secrets/**'\nverify:\n  test: 'npm test'\n"
      );
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "strict policy on main"]);

      // 2. Feature branch modifies config to loosen limits to 99999 KB and remove deny
      git(dir, ["checkout", "-q", "-b", "feature/bypass-limits"]);
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        "version: 1\nlimits:\n  diff_kb: 99999\nscope:\n  deny: []\nverify:\n  test: 'npm test'\n"
      );

      // Add a 60 KB file (exceeds base 50 KB ceiling)
      const bigContent = "A".repeat(60 * 1024);
      writeFileSync(join(dir, "big-file.txt"), bigContent);
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "attempted limit bypass"]);

      // 3. Evaluate gate with allowProtected: true so .agent/ config edit is permitted in scope
      // but trusted policy limits (50 KB) must still govern from main
      const res = await gate({
        root: dir,
        mode: "committed",
        base: "main",
        head: "feature/bypass-limits",
        allowProtected: true,
      });

      assert.equal(res.ok, false, "Gate must enforce trusted base diff limits");
      assert.equal(res.code, 5, "Exit code must be 5 (Payload ceiling exceeded)");
      const payloadPhase = res.phases.find((p) => p.phase === "payload");
      assert.ok(payloadPhase);
      assert.equal(payloadPhase.ok, false);
      assert.equal(payloadPhase.limitBytes, 50 * 1024, "Diff ceiling must remain locked to trusted 50 KB");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("result/evidence reports the actual immutable base and head commit SHAs", async () => {
    const dir = initRepo("main");
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "test-pkg", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
      );
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        "version: 1\nverify:\n  test: 'npm test'\n"
      );
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "first commit"]);
      const expectedBaseSha = git(dir, ["rev-parse", "HEAD"]);

      writeFileSync(join(dir, "feature.txt"), "feature data\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "second commit"]);
      const expectedHeadSha = git(dir, ["rev-parse", "HEAD"]);

      const res = await gate({ root: dir, mode: "committed", base: "HEAD~1" });
      assert.equal(res.ok, true);

      // Verify SHA format and values on root gate result
      const sha40Regex = /^[0-9a-f]{40}$/i;
      assert.match(res.baseSha, sha40Regex, "res.baseSha must be a 40-char SHA");
      assert.match(res.headSha, sha40Regex, "res.headSha must be a 40-char SHA");
      assert.equal(res.baseSha, expectedBaseSha);
      assert.equal(res.headSha, expectedHeadSha);

      // Verify SHA format and values on evidence manifest
      assert.ok(res.evidence, "Gate result must include evidence manifest");
      assert.equal(res.evidence.baseSha, expectedBaseSha);
      assert.equal(res.evidence.headSha, expectedHeadSha);
      assert.equal(res.evidence.provenance.baseSha, expectedBaseSha);
      assert.equal(res.evidence.provenance.headSha, expectedHeadSha);
      assert.equal(res.evidence.provenance.commitSha, expectedHeadSha);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("local-only main does not become an implicit trusted base", async () => {
    const dir = initRepo("main");
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "test-pkg", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
      );
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\nverify:\n  test: 'npm test'\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "init main"]);

      git(dir, ["checkout", "-q", "-b", "feature/local-work"]);
      writeFileSync(join(dir, "feature.js"), "export const local = true;\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "commit on feature"]);

      // Implicit trust must not adopt local refs/heads/main
      const resolved = resolveTrustedBaseRef(dir);
      assert.equal(resolved, null, "Must not implicitly trust local refs/heads/main");

      const res = await gate({ root: dir, mode: "committed" });
      assert.equal(res.ok, false);
      assert.equal(res.code, 1);
      assert.equal(res.base, null);
      assert.match(res.error, /unable to determine trusted base branch|committed verification requires an explicit trusted baseline sha/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("local-only master does not become an implicit trusted base", async () => {
    const dir = initRepo("master");
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "test-pkg", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
      );
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\nverify:\n  test: 'npm test'\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "init master"]);

      git(dir, ["checkout", "-q", "-b", "feature/local-work"]);
      writeFileSync(join(dir, "feature.js"), "export const local = true;\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "commit on feature"]);

      // Implicit trust must not adopt local refs/heads/master
      const resolved = resolveTrustedBaseRef(dir);
      assert.equal(resolved, null, "Must not implicitly trust local refs/heads/master");

      const res = await gate({ root: dir, mode: "committed" });
      assert.equal(res.ok, false);
      assert.equal(res.code, 1);
      assert.equal(res.base, null);
      assert.match(res.error, /unable to determine trusted base branch|committed verification requires an explicit trusted baseline sha/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("local-only trunk does not become an implicit trusted base", async () => {
    const dir = initRepo("trunk");
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "test-pkg", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
      );
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\nverify:\n  test: 'npm test'\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "init trunk"]);

      git(dir, ["checkout", "-q", "-b", "feature/local-work"]);
      writeFileSync(join(dir, "feature.js"), "export const local = true;\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "commit on feature"]);

      // Implicit trust must not adopt local refs/heads/trunk
      const resolved = resolveTrustedBaseRef(dir);
      assert.equal(resolved, null, "Must not implicitly trust local refs/heads/trunk");

      const res = await gate({ root: dir, mode: "committed" });
      assert.equal(res.ok, false);
      assert.equal(res.code, 1);
      assert.equal(res.base, null);
      assert.match(res.error, /unable to determine trusted base branch|committed verification requires an explicit trusted baseline sha/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("corresponding origin/main, origin/master, or origin/trunk may be selected as the conventional remote fallback", async () => {
    // 1. origin/main fallback
    const dirMain = initRepo("local-scratch");
    try {
      writeFileSync(join(dirMain, "test.txt"), "hello");
      git(dirMain, ["add", "."]);
      git(dirMain, ["commit", "-m", "init"]);
      git(dirMain, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      assert.equal(resolveTrustedBaseRef(dirMain), "main");
    } finally {
      rmSync(dirMain, { recursive: true, force: true });
    }

    // 2. origin/master fallback
    const dirMaster = initRepo("local-scratch");
    try {
      writeFileSync(join(dirMaster, "test.txt"), "hello");
      git(dirMaster, ["add", "."]);
      git(dirMaster, ["commit", "-m", "init"]);
      git(dirMaster, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
      assert.equal(resolveTrustedBaseRef(dirMaster), "master");
    } finally {
      rmSync(dirMaster, { recursive: true, force: true });
    }

    // 3. origin/trunk fallback + gate verification
    const dirTrunk = initRepo("local-scratch");
    try {
      writeFileSync(
        join(dirTrunk, "package.json"),
        JSON.stringify({ name: "test-pkg", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
      );
      mkdirSync(join(dirTrunk, ".agent"), { recursive: true });
      writeFileSync(join(dirTrunk, ".agent", "config.yml"), "version: 1\nverify:\n  test: 'npm test'\n");
      git(dirTrunk, ["add", "."]);
      git(dirTrunk, ["commit", "-m", "init trunk"]);
      const trunkSha = git(dirTrunk, ["rev-parse", "HEAD"]);
      git(dirTrunk, ["update-ref", "refs/remotes/origin/trunk", "HEAD"]);

      assert.equal(resolveTrustedBaseRef(dirTrunk), "trunk");

      git(dirTrunk, ["checkout", "-q", "-b", "feature/trunk-work"]);
      writeFileSync(join(dirTrunk, "trunk-feat.js"), "export const t = 1;\n");
      git(dirTrunk, ["add", "."]);
      git(dirTrunk, ["commit", "-m", "feat on trunk"]);
      const featSha = git(dirTrunk, ["rev-parse", "HEAD"]);

      // Baseline captured pre-dispatch from discoverable origin/trunk
      recordDispatchBaseline(dirTrunk, { baseSha: trunkSha, branch: "trunk" });

      // Unassisted gate fails closed
      const unassisted = await gate({ root: dirTrunk, mode: "committed" });
      assert.equal(unassisted.ok, false);
      assert.equal(unassisted.code, 1);
      assert.match(unassisted.error, /committed verification requires an explicit trusted baseline sha/i);

      // Assisted gate with pre-dispatch baseline trunkSha succeeds
      const res = await gate({ root: dirTrunk, mode: "committed", baseSha: trunkSha });
      assert.equal(res.ok, true);
      assert.equal(res.code, 0);
      assert.equal(res.baseSha, trunkSha);
      assert.equal(res.headSha, featSha);
    } finally {
      rmSync(dirTrunk, { recursive: true, force: true });
    }
  });

  it("explicit --base continues to work in fully local/offline repositories", async () => {
    const dir = initRepo("main"); // Purely local repository with NO remote refs
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "test-pkg", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
      );
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\nverify:\n  test: 'npm test'\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "local base commit"]);
      const mainSha = git(dir, ["rev-parse", "main"]);

      git(dir, ["checkout", "-q", "-b", "feature/offline-work"]);
      writeFileSync(join(dir, "offline.js"), "export const offline = true;\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "offline work"]);
      const featSha = git(dir, ["rev-parse", "HEAD"]);

      // Unassisted gate fails closed because local main is not an implicit remote trust anchor
      assert.equal(resolveTrustedBaseRef(dir), null);
      const unassisted = await gate({ root: dir, mode: "committed" });
      assert.equal(unassisted.ok, false);
      assert.equal(unassisted.code, 1);

      // Explicit trusted operator --base allows evaluation in local/offline repositories
      const assisted = await gate({ root: dir, mode: "committed", base: "main" });
      assert.equal(assisted.ok, true);
      assert.equal(assisted.code, 0);
      assert.equal(assisted.base, "main");
      assert.equal(assisted.baseSha, mainSha);
      assert.equal(assisted.headSha, featSha);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("Adversarial remote-tracking ref manipulation & immutable baseSha", () => {
    it("git update-ref refs/remotes/origin/main <candidate-controlled-sha>: vulnerable without baseSha, neutralized with pre-established baseSha", async () => {
      const dir = initRepo("main");
      try {
        // 1. Trusted baseline commit A contains strict trusted policy
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "adversarial-pkg", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
        );
        mkdirSync(join(dir, ".agent"), { recursive: true });
        writeFileSync(
          join(dir, ".agent", "config.yml"),
          "version: 1\nscope:\n  deny:\n    - 'secrets/**'\nverify:\n  test: 'npm test'\n"
        );
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "A: strict baseline"]);
        const commitA = git(dir, ["rev-parse", "HEAD"]);
        git(dir, ["update-ref", "refs/remotes/origin/main", commitA]);

        // 2. Candidate agent receives shell/git control
        // Agent creates commit B: weakens policy to empty deny list
        writeFileSync(
          join(dir, ".agent", "config.yml"),
          "version: 1\nscope:\n  deny: []\nverify:\n  test: 'npm test'\n"
        );
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "B: weakened policy"]);
        const commitB = git(dir, ["rev-parse", "HEAD"]);

        // Agent creates commit C: commits sensitive secret file
        mkdirSync(join(dir, "secrets"), { recursive: true });
        writeFileSync(join(dir, "secrets", "leak.txt"), "exfiltrated-secret-data\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "C: leak secret file"]);
        const commitC = git(dir, ["rev-parse", "HEAD"]);

        // 3. Agent manipulates local remote-tracking ref refs/remotes/origin/main to point to B
        git(dir, ["update-ref", "refs/remotes/origin/main", commitB]);

        // 4. Security Invariant: An unassisted gate without a pre-established baseline FAILS CLOSED (code 1)
        // instead of silently adopting the tampered origin/main ref (B)
        const unassisted = await gate({ root: dir, mode: "committed" });
        assert.equal(unassisted.ok, false);
        assert.equal(unassisted.code, 1);
        assert.match(unassisted.error, /committed verification requires an explicit trusted baseline sha/i);

        // 5. Neutralization: When pre-established immutable baseSha (commitA) is supplied
        // (captured before dispatch or provided by maintainer/host)
        const assisted = await gate({ root: dir, mode: "committed", baseSha: commitA });
        assert.equal(assisted.ok, false, "Gate must reject attack when anchored to immutable baseSha");
        assert.equal(assisted.code, 3, "Scope violation exit code 3");
        assert.equal(assisted.baseSha, commitA, "baseSha must remain locked to commitA despite ref manipulation");
        assert.equal(assisted.headSha, commitC);

        const scopePhase = assisted.phases.find((p) => p.phase === "scope");
        assert.ok(scopePhase);
        assert.equal(scopePhase.ok, false);
        // Both the config tampering in B and the secret leak in C are caught because diff is A..C
        assert.ok(scopePhase.violations.some((v) => v.file === ".agent/config.yml"), "Must flag config tampering");
        assert.ok(scopePhase.violations.some((v) => v.file === "secrets/leak.txt"), "Must flag forbidden secret leak");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("manipulated refs/remotes/origin/HEAD", async () => {
      const dir = initRepo("main");
      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "test-pkg", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
        );
        mkdirSync(join(dir, ".agent"), { recursive: true });
        writeFileSync(
          join(dir, ".agent", "config.yml"),
          "version: 1\nscope:\n  deny:\n    - 'secrets/**'\nverify:\n  test: 'npm test'\n"
        );
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "commit A"]);
        const commitA = git(dir, ["rev-parse", "HEAD"]);
        git(dir, ["update-ref", "refs/remotes/origin/main", commitA]);
        git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

        // Agent creates attacker branch with relaxed rules
        git(dir, ["checkout", "-q", "-b", "attacker-branch"]);
        writeFileSync(
          join(dir, ".agent", "config.yml"),
          "version: 1\nscope:\n  deny: []\nverify:\n  test: 'npm test'\n"
        );
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "attacker commit"]);
        const attackerSha = git(dir, ["rev-parse", "HEAD"]);
        git(dir, ["update-ref", "refs/remotes/origin/attacker-branch", attackerSha]);

        // Agent redirects refs/remotes/origin/HEAD to attacker-branch
        git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/attacker-branch"]);

        // Candidate work commit
        git(dir, ["checkout", "-q", "-b", "candidate-work"]);
        mkdirSync(join(dir, "secrets"), { recursive: true });
        writeFileSync(join(dir, "secrets", "leak.txt"), "leak\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "candidate leak"]);

        // Gate evaluated with immutable pre-established baseSha: commitA
        const res = await gate({ root: dir, mode: "committed", baseSha: commitA });
        assert.equal(res.ok, false);
        assert.equal(res.code, 3);
        assert.equal(res.baseSha, commitA);

        // If caller passed both base: "origin/HEAD" and baseSha: commitA:
        // Gate detects that origin/HEAD has drifted / been manipulated away from commitA and fails closed
        const resDrift = await gate({ root: dir, mode: "committed", base: "origin/HEAD", baseSha: commitA });
        assert.equal(resDrift.ok, false);
        assert.equal(resDrift.code, 1, "Must fail closed with code 1 on ref tampering / drift");
        assert.match(resDrift.error, /ref tampering or branch drift detected/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("candidate rewriting local history where relevant: gate fails closed if expected base cannot be proven", async () => {
      const dir = initRepo("main");
      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "test-pkg", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
        );
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "root commit"]);
        const commitA = git(dir, ["rev-parse", "HEAD"]);

        // Candidate amends root commit, changing its SHA and detaching original commitA
        writeFileSync(join(dir, "rewritten.txt"), "history rewrite\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "--amend", "-m", "amended root commit"]);
        const amendedSha = git(dir, ["rev-parse", "HEAD"]);
        assert.notEqual(amendedSha, commitA);

        // Garbage collect / prune unreachable objects so commitA cannot be resolved
        git(dir, ["prune"]);

        // Candidate attempts gate against original baseSha commitA
        // If commitA is unreachable / missing from object database, gate must FAIL CLOSED with code 1
        // (or if still present, resolve it cleanly)
        const fakeSha = "0123456789abcdef0123456789abcdef01234567";
        const resMissing = await gate({ root: dir, mode: "committed", baseSha: fakeSha });
        assert.equal(resMissing.ok, false);
        assert.equal(resMissing.code, 1);
        assert.match(resMissing.error, /cannot resolve trusted base commit sha/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("immutable pre-established base SHA remains unchanged despite ref manipulation", async () => {
      const dir = initRepo("main");
      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "test-pkg", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
        );
        mkdirSync(join(dir, ".agent"), { recursive: true });
        writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\nverify:\n  test: 'npm test'\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "init"]);
        const commitA = git(dir, ["rev-parse", "HEAD"]);
        git(dir, ["update-ref", "refs/remotes/origin/main", commitA]);

        // Legitimate feature work
        git(dir, ["checkout", "-q", "-b", "feature/work"]);
        writeFileSync(join(dir, "work.js"), "export const w = 1;\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "work commit"]);
        const headSha = git(dir, ["rev-parse", "HEAD"]);

        // Malicious process updates every local ref
        git(dir, ["update-ref", "refs/remotes/origin/main", headSha]);
        git(dir, ["update-ref", "refs/remotes/origin/trunk", headSha]);
        git(dir, ["update-ref", "refs/heads/main", headSha]);

        // Gate evaluated with pre-established baseSha: commitA
        const res = await gate({ root: dir, mode: "committed", baseSha: commitA });
        assert.equal(res.ok, true);
        assert.equal(res.baseSha, commitA, "res.baseSha must match immutable commitA");
        assert.equal(res.headSha, headSha);
        assert.equal(res.evidence.baseSha, commitA, "evidence.baseSha must match immutable commitA");
        assert.equal(res.evidence.provenance.baseSha, commitA, "provenance.baseSha must match immutable commitA");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("gate fails closed if the expected trusted base cannot be proven", async () => {
      const dir = initRepo("main");
      try {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "init"]);
        const commitA = git(dir, ["rev-parse", "HEAD"]);

        // Subcase 1: Invalid format (not 40-char hex)
        const resFormat = await gate({ root: dir, baseSha: "not-a-valid-sha" });
        assert.equal(resFormat.ok, false);
        assert.equal(resFormat.code, 1);
        assert.match(resFormat.error, /invalid baseSha format/i);

        // Subcase 2: Non-existent 40-char hex SHA
        const resNonExistent = await gate({ root: dir, baseSha: "0000000000000000000000000000000000000000" });
        assert.equal(resNonExistent.ok, false);
        assert.equal(resNonExistent.code, 1);
        assert.match(resNonExistent.error, /cannot resolve trusted base commit sha/i);

        // Subcase 3: Named base ref contradicts expected baseSha
        git(dir, ["checkout", "-q", "-b", "feature/divergent"]);
        writeFileSync(join(dir, "divergent.txt"), "divergent\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "divergent commit"]);
        const divergentSha = git(dir, ["rev-parse", "HEAD"]);
        git(dir, ["update-ref", "refs/remotes/origin/main", divergentSha]);

        const resContradiction = await gate({
          root: dir,
          mode: "committed",
          base: "main",
          baseSha: commitA,
        });
        assert.equal(resContradiction.ok, false);
        assert.equal(resContradiction.code, 1);
        assert.match(resContradiction.error, /ref tampering or branch drift detected/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("Adversarial Trust Model Hardening: Five Invariants (Request 5)", () => {
    it("A. Plain post-agent gate: candidate alters refs/remotes/origin/main, gate uses captured baseline A (or fails closed) and never adopts tampered ref", async () => {
      const dir = initRepo("main");
      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "test-a", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
        );
        mkdirSync(join(dir, ".agent"), { recursive: true });
        writeFileSync(
          join(dir, ".agent", "config.yml"),
          "version: 1\nscope:\n  deny:\n    - 'secrets/**'\nverify:\n  test: 'npm test'\n"
        );
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "A: strict baseline"]);
        const commitA = git(dir, ["rev-parse", "HEAD"]);
        git(dir, ["update-ref", "refs/remotes/origin/main", commitA]);

        // Pre-dispatch: baseline A is recorded in trusted storage before agent runs
        recordDispatchBaseline(dir, { baseSha: commitA, branch: "main" });

        // Agent execution: candidate creates commit B (weakened policy) and commit C (secret leak)
        writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\nscope:\n  deny: []\nverify:\n  test: 'npm test'\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "B: weakened policy"]);
        const commitB = git(dir, ["rev-parse", "HEAD"]);

        mkdirSync(join(dir, "secrets"), { recursive: true });
        writeFileSync(join(dir, "secrets", "leak.txt"), "exfiltrated-secret\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "C: secret leak"]);
        const commitC = git(dir, ["rev-parse", "HEAD"]);

        // Candidate tampers with mutable remote ref
        git(dir, ["update-ref", "refs/remotes/origin/main", commitB]);

        // Operator runs plain gate in committed mode without --base or --base-sha
        // Under Option B, unassisted gate fails closed because persistent local state cannot be an autonomous security authority
        const res = await gate({ root: dir, mode: "committed" });
        assert.equal(res.ok, false);
        assert.equal(res.code, 1, "Exit code must be 1 (fails closed)");
        assert.notEqual(res.baseSha, commitB, "Must NEVER adopt tampered ref B");
        assert.match(res.error, /committed verification requires an explicit trusted baseline sha/i);

        // Operator runs assisted gate with explicit pre-dispatch baseline A: catches scope violation
        const resAssisted = await gate({ root: dir, mode: "committed", baseSha: commitA });
        assert.equal(resAssisted.ok, false);
        assert.equal(resAssisted.code, 3, "Scope violation exit code 3");
        assert.equal(resAssisted.baseSha, commitA, "Must resolve to pre-dispatch baseline A, NEVER tampered ref B");
        assert.equal(resAssisted.headSha, commitC);
        const scopePhase = resAssisted.phases.find((p) => p.phase === "scope");
        assert.ok(scopePhase);
        assert.ok(scopePhase.violations.some((v) => v.file === ".agent/config.yml"), "Must flag config tampering");
        assert.ok(scopePhase.violations.some((v) => v.file === "secrets/leak.txt"), "Must flag forbidden file");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("B. No pre-established SHA in committed mode: plain agentctl gate --committed fails closed with actionable error", async () => {
      const dir = initRepo("main");
      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "test-b", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
        );
        mkdirSync(join(dir, ".agent"), { recursive: true });
        writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\nverify:\n  test: 'npm test'\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "init"]);

        git(dir, ["checkout", "-q", "-b", "candidate/feature"]);
        writeFileSync(join(dir, "feat.js"), "export const f = 1;\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "candidate work"]);

        // Plain gate in committed mode with NO pre-established baseline in storage and NO --base / --base-sha
        const res = await gate({ root: dir, mode: "committed" });
        assert.equal(res.ok, false);
        assert.equal(res.code, 1);
        assert.equal(res.baseSha, null);
        assert.match(res.error, /committed verification requires an explicit trusted baseline sha/i);
        assert.match(res.error, /--base-sha/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("C. Environment spoofing: untrusted candidate setting BASE_SHA cannot bypass the gate", async () => {
      const dir = initRepo("main");
      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "test-c", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
        );
        mkdirSync(join(dir, ".agent"), { recursive: true });
        writeFileSync(
          join(dir, ".agent", "config.yml"),
          "version: 1\nscope:\n  deny:\n    - 'secrets/**'\nverify:\n  test: 'npm test'\n"
        );
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "A: strict"]);
        const commitA = git(dir, ["rev-parse", "HEAD"]);

        // Candidate creates commit B (weakened) and commit C (leak)
        writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\nscope:\n  deny: []\nverify:\n  test: 'npm test'\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "B: weakened"]);
        const commitB = git(dir, ["rev-parse", "HEAD"]);

        mkdirSync(join(dir, "secrets"), { recursive: true });
        writeFileSync(join(dir, "secrets", "leak.txt"), "exfiltrated\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "C: secret"]);

        // Pre-dispatch baseline A in storage
        recordDispatchBaseline(dir, { baseSha: commitA, branch: "main" });

        // Candidate sets unauthenticated environment variables attempting to force base to B
        process.env.BASE_SHA = commitB;
        process.env.JULES_BASE_SHA = commitB;

        try {
          // Unassisted gate fails closed and ignores spoofed env vars
          const res = await gate({ root: dir, mode: "committed" });
          assert.equal(res.ok, false);
          assert.equal(res.code, 1, "Must fail closed without explicit trusted baseline");
          assert.notEqual(res.baseSha, commitB, "Must not adopt spoofed env var B");
          assert.match(res.error, /committed verification requires an explicit trusted baseline sha/i);

          // Assisted gate verifies deterministically against trusted baseline A
          const resAssisted = await gate({ root: dir, mode: "committed", baseSha: commitA });
          assert.equal(resAssisted.ok, false);
          assert.equal(resAssisted.code, 3, "Must fail with scope violation against trusted commitA");
          assert.equal(resAssisted.baseSha, commitA, "Must adhere to verified baseline A, ignoring spoofed env vars");
        } finally {
          delete process.env.BASE_SHA;
          delete process.env.JULES_BASE_SHA;
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("D. Task-envelope & local state file tampering: gate ignores candidate task files and detects ledger tampering", async () => {
      const dir = initRepo("main");
      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "test-d", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
        );
        mkdirSync(join(dir, ".agent"), { recursive: true });
        writeFileSync(
          join(dir, ".agent", "config.yml"),
          "version: 1\nscope:\n  deny:\n    - 'secrets/**'\nverify:\n  test: 'npm test'\n"
        );
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "A: strict"]);
        const commitA = git(dir, ["rev-parse", "HEAD"]);

        // Pre-dispatch baseline A recorded in storage
        recordDispatchBaseline(dir, { baseSha: commitA, branch: "main" });

        // Candidate creates commit B (weakened) and commit C (leak)
        writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\nscope:\n  deny: []\nverify:\n  test: 'npm test'\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "B: weakened"]);
        const commitB = git(dir, ["rev-parse", "HEAD"]);

        mkdirSync(join(dir, "secrets"), { recursive: true });
        writeFileSync(join(dir, "secrets", "leak.txt"), "exfiltrated\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "C: secret"]);

        // Subcase 1: Candidate creates task envelope in working directory claiming base_sha is B
        mkdirSync(join(dir, ".agent", "jules-queue"), { recursive: true });
        writeFileSync(
          join(dir, ".agent", "jules-queue", "task-1.md"),
          `---\ntitle: malicious\nbase_sha: ${commitB}\nbase_commit: ${commitB}\n---\nPrompt content\n`
        );

        // Gate running in committed mode ignores candidate task envelope for trust-anchor resolution
        const resTaskTamper = await gate({
          root: dir,
          mode: "committed",
          task: { baseSha: commitB, base_commit: commitB },
        });
        assert.equal(resTaskTamper.ok, false);
        assert.equal(resTaskTamper.code, 1, "Must fail closed without explicit trusted baseSha");
        assert.notEqual(resTaskTamper.baseSha, commitB, "Must not adopt candidate task baseSha");
        assert.match(resTaskTamper.error, /committed verification requires an explicit trusted baseline sha/i);

        const resAssisted = await gate({
          root: dir,
          mode: "committed",
          baseSha: commitA,
          task: { baseSha: commitB, base_commit: commitB },
        });
        assert.equal(resAssisted.ok, false);
        assert.equal(resAssisted.code, 3, "Must flag scope violation against trusted commitA");
        assert.equal(resAssisted.baseSha, commitA, "Must remain anchored to pre-dispatch baseline A");

        // Subcase 2: Candidate tampers with local ledger file on disk
        const stateDir = join(dir, ".agent", "state");
        const ledgerFiles = readdirSync(stateDir).filter((f) => f.startsWith("ledger-") && f.endsWith(".jsonl"));
        assert.ok(ledgerFiles.length > 0, "Ledger file must exist");
        const ledgerPath = join(stateDir, ledgerFiles[0]);
        const originalContent = readFileSync(ledgerPath, "utf-8");
        // Tamper with baseSha in the ledger file
        writeFileSync(ledgerPath, originalContent.replace(commitA, commitB));

        // Gate must detect SHA-256 hash-chain break and fail closed immediately with security violation
        const resLedgerTamper = await gate({ root: dir, mode: "committed" });
        assert.equal(resLedgerTamper.ok, false);
        assert.equal(resLedgerTamper.code, 1);
        assert.match(resLedgerTamper.error, /ledger integrity check failed|tampered with or corrupted/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("E. Full lifecycle test for async Jules: captures A at dispatch, executes remotely, verifies against A after checkout", async () => {
      const dir = initRepo("main");
      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "test-e", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
        );
        mkdirSync(join(dir, ".agent"), { recursive: true });
        writeFileSync(
          join(dir, ".agent", "config.yml"),
          "version: 1\nscope:\n  allow:\n    - 'src/**'\nverify:\n  test: 'npm test'\n"
        );
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "src", "index.js"), "export const base = 1;\n");
        writeFileSync(join(dir, ".gitignore"), ".agent/state/\nnode_modules/\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "A: baseline"]);
        const commitA = git(dir, ["rev-parse", "HEAD"]);
        git(dir, ["update-ref", "refs/remotes/origin/main", commitA]);

        // Mock Jules provider that simulates remote dispatch
        const mockProvider = {
          name: "mock-jules",
          dispatch: async (_taskObj, _ctx) => {
            return {
              id: "session-async-123",
              status: "PENDING",
              url: "https://jules.google.com/sessions/123",
              ok: true,
            };
          },
        };

        // 1. Maintainer dispatches task on local trusted repo
        const session = await dispatch(
          {
            title: "Async feature development",
            prompt: "Add new feature to src/index.js",
          },
          {
            root: dir,
            provider: mockProvider,
          }
        );
        assert.equal(session.baseSha, commitA, "Dispatch must capture immutable pre-dispatch baseline A");

        // 2. Remote Jules executes asynchronously and produces candidate changes on branch
        git(dir, ["checkout", "-q", "-b", "jules/session-async-123"]);
        writeFileSync(join(dir, "src", "index.js"), "export const base = 1;\nexport const feature = 2;\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "C: candidate feature from remote Jules"]);
        const commitC = git(dir, ["rev-parse", "HEAD"]);

        // 3. Result checkout: Operator checks out candidate branch
        // Unassisted gate fails closed: persistent files cannot serve as autonomous security authority
        const unassisted = await gate({ root: dir, mode: "committed" });
        assert.equal(unassisted.ok, false);
        assert.equal(unassisted.code, 1);
        assert.match(unassisted.error, /committed verification requires an explicit trusted baseline sha/i);

        // Assisted gate using immutable baseline captured at dispatch evaluates deterministically
        const res = await gate({ root: dir, mode: "committed", baseSha: session.baseSha });
        assert.equal(res.ok, true, "Gate must approve clean feature against trusted baseline A");
        assert.equal(res.code, 0);
        assert.equal(res.baseSha, commitA, "Must evaluate against baseline A captured at dispatch");
        assert.equal(res.headSha, commitC, "Must evaluate against candidate head C");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("Adversarial Trust-Model Hardening: Authenticated Provenance vs Unkeyed Consistency", () => {
    it("A. Fully forged ledger: recomputes SHA-256 hash chain so verifyLedgerIntegrity passes, but security layer rejects it as an authority", async () => {
      const dir = initRepo("main");
      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "test-auth-a", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
        );
        mkdirSync(join(dir, ".agent"), { recursive: true });
        writeFileSync(
          join(dir, ".agent", "config.yml"),
          "version: 1\nscope:\n  deny:\n    - 'secrets/**'\nverify:\n  test: 'npm test'\n"
        );
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "A: strict baseline"]);
        const commitA = git(dir, ["rev-parse", "HEAD"]);
        git(dir, ["update-ref", "refs/remotes/origin/main", commitA]);

        // Pre-dispatch: baseline A is recorded in trusted host authority and repo ledger
        recordDispatchBaseline(dir, { baseSha: commitA, branch: "main", lifecycle: "remote-session" });

        // Candidate creates commit B (weakened policy) and commit C (secret leak)
        writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\nscope:\n  deny: []\nverify:\n  test: 'npm test'\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "B: weakened policy"]);
        const commitB = git(dir, ["rev-parse", "HEAD"]);

        mkdirSync(join(dir, "secrets"), { recursive: true });
        writeFileSync(join(dir, "secrets", "leak.txt"), "exfiltrated-secret\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "C: secret leak"]);

        // Candidate modifies stored baseSha to commit B and correctly recomputes the entire SHA-256 hash chain
        const stateDir = join(dir, ".agent", "state");
        const ledgerFiles = readdirSync(stateDir).filter((f) => f.startsWith("ledger-") && f.endsWith(".jsonl"));
        assert.ok(ledgerFiles.length > 0, "Ledger file must exist");
        const ledgerPath = join(stateDir, ledgerFiles[0]);
        const lines = readFileSync(ledgerPath, "utf-8").split("\n").filter(Boolean);
        let prevHash = "0".repeat(64);
        const forgedLines = [];
        for (const line of lines) {
          const obj = JSON.parse(line);
          if (obj.event === "task_dispatch_baseline") {
            obj.baseSha = commitB;
          }
          obj.prevHash = prevHash;
          const { hash: _hash, ...rest } = obj;
          const computedHash = createHash("sha256").update(JSON.stringify(rest)).digest("hex");
          obj.hash = computedHash;
          prevHash = computedHash;
          forgedLines.push(JSON.stringify(obj));
        }
        writeFileSync(ledgerPath, forgedLines.join("\n") + "\n", "utf-8");

        // 1. verifyLedgerIntegrity() itself accepts the forged chain as internally consistent
        const integrity = verifyLedgerIntegrity(ledgerPath);
        assert.equal(integrity.ok, true, "Forged ledger must pass unkeyed hash-chain integrity check");

        // 2. Security layer nevertheless rejects it as an authority:
        // Gate detects conflict with authenticated host authority (or unauthenticated state) and fails closed
        const res = await gate({ root: dir, mode: "committed" });
        assert.equal(res.ok, false, "Gate must reject forged candidate ledger as an authority");
        assert.equal(res.code, 1, "Must fail closed with code 1");
        assert.notEqual(res.baseSha, commitB, "Must NEVER adopt attacker commit B as trusted base");
        assert.match(res.error, /security violation|forged baseline|conflicting with authenticated host authority/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("B. Forged checkpoint + forged ledger: candidate consistently updates both persisted representations, gate rejects attacker baseline", async () => {
      const dir = initRepo("main");
      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "test-auth-b", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
        );
        mkdirSync(join(dir, ".agent"), { recursive: true });
        writeFileSync(
          join(dir, ".agent", "config.yml"),
          "version: 1\nscope:\n  deny:\n    - 'secrets/**'\nverify:\n  test: 'npm test'\n"
        );
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "A: strict baseline"]);
        const commitA = git(dir, ["rev-parse", "HEAD"]);
        git(dir, ["update-ref", "refs/remotes/origin/main", commitA]);

        // Pre-dispatch: baseline A is recorded in host authority, ledger, and checkpoint
        recordDispatchBaseline(dir, { baseSha: commitA, branch: "main", lifecycle: "remote-session" });
        const { createCheckpoint } = await import("../src/ops/checkpoint.mjs");
        createCheckpoint("dispatch-preflight", { root: dir, baseSha: commitA });

        // Candidate creates commit B and C
        writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\nscope:\n  deny: []\nverify:\n  test: 'npm test'\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "B: weakened policy"]);
        const commitB = git(dir, ["rev-parse", "HEAD"]);

        mkdirSync(join(dir, "secrets"), { recursive: true });
        writeFileSync(join(dir, "secrets", "leak.txt"), "exfiltrated-secret\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "C: secret leak"]);

        // Candidate updates ledger and recomputes hash chain to commit B
        const stateDir = join(dir, ".agent", "state");
        const ledgerFiles = readdirSync(stateDir).filter((f) => f.startsWith("ledger-") && f.endsWith(".jsonl"));
        const ledgerPath = join(stateDir, ledgerFiles[0]);
        const lines = readFileSync(ledgerPath, "utf-8").split("\n").filter(Boolean);
        let prevHash = "0".repeat(64);
        const forgedLines = [];
        for (const line of lines) {
          const obj = JSON.parse(line);
          if (obj.event === "task_dispatch_baseline") obj.baseSha = commitB;
          obj.prevHash = prevHash;
          const { hash: _hash, ...rest } = obj;
          const computedHash = createHash("sha256").update(JSON.stringify(rest)).digest("hex");
          obj.hash = computedHash;
          prevHash = computedHash;
          forgedLines.push(JSON.stringify(obj));
        }
        writeFileSync(ledgerPath, forgedLines.join("\n") + "\n", "utf-8");

        // Candidate updates all checkpoint files in .agent/state/checkpoints
        const cpDir = join(stateDir, "checkpoints");
        for (const f of readdirSync(cpDir).filter((f) => f.endsWith(".json"))) {
          const cpPath = join(cpDir, f);
          const cpData = JSON.parse(readFileSync(cpPath, "utf-8"));
          cpData.baseSha = commitB;
          writeFileSync(cpPath, JSON.stringify(cpData, null, 2), "utf-8");
        }

        // Gate must reject forged representations and fail closed
        const res = await gate({ root: dir, mode: "committed" });
        assert.equal(res.ok, false);
        assert.equal(res.code, 1);
        assert.notEqual(res.baseSha, commitB, "Must NOT adopt attacker commit B");
        assert.match(res.error, /security violation|forged baseline/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("C. Delete trusted state: candidate deletes repository-local baseline state, gate fails closed and does NOT rediscover trust from mutable refs", async () => {
      const dir = initRepo("main");
      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "test-auth-c", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
        );
        mkdirSync(join(dir, ".agent"), { recursive: true });
        writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\nverify:\n  test: 'npm test'\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "init"]);
        const commitA = git(dir, ["rev-parse", "HEAD"]);
        git(dir, ["update-ref", "refs/remotes/origin/main", commitA]);

        // Pre-dispatch baseline recorded
        recordDispatchBaseline(dir, { baseSha: commitA, branch: "main", lifecycle: "remote-session" });

        // Candidate creates new branch and work
        git(dir, ["checkout", "-q", "-b", "candidate/feature"]);
        writeFileSync(join(dir, "feat.js"), "export const f = 1;\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "candidate work"]);
        const commitC = git(dir, ["rev-parse", "HEAD"]);

        // Candidate deletes repository-local baseline state (.agent/state)
        rmSync(join(dir, ".agent", "state"), { recursive: true, force: true });

        // Candidate manipulates remote-tracking ref to candidate head C
        git(dir, ["update-ref", "refs/remotes/origin/main", commitC]);

        // 1. Unassisted gate MUST fail closed (code 1) and MUST NOT rediscover trust from mutable refs
        const unassisted = await gate({ root: dir, mode: "committed" });
        assert.equal(unassisted.ok, false);
        assert.equal(unassisted.code, 1);
        assert.notEqual(unassisted.baseSha, commitC, "Must NOT adopt candidate commit C from mutable ref");
        assert.notEqual(unassisted.base, commitC);
        assert.match(unassisted.error, /repository baseline state is missing or was deleted|committed verification requires an explicit trusted baseline sha/i);

        // 2. Explicit operator-provided --base-sha allows evaluation deterministically against baseline A
        const assisted = await gate({ root: dir, mode: "committed", baseSha: commitA });
        assert.equal(assisted.ok, true);
        assert.equal(assisted.code, 0);
        assert.equal(assisted.baseSha, commitA);
        assert.equal(assisted.headSha, commitC);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("D. Remote Jules lifecycle: baseline authority lives in host authority store outside repo, remote worker cannot alter it, gate verifies against host authority", async () => {
      const dir = initRepo("main");
      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "test-auth-d", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
        );
        mkdirSync(join(dir, ".agent"), { recursive: true });
        writeFileSync(
          join(dir, ".agent", "config.yml"),
          "version: 1\nscope:\n  allow:\n    - 'src/**'\nverify:\n  test: 'npm test'\n"
        );
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "src", "index.js"), "export const base = 1;\n");
        writeFileSync(join(dir, ".gitignore"), ".agent/state/\nnode_modules/\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "A: baseline"]);
        const commitA = git(dir, ["rev-parse", "HEAD"]);
        git(dir, ["update-ref", "refs/remotes/origin/main", commitA]);

        // Mock remote Jules provider (lifecycle: remote-session)
        const mockRemoteProvider = {
          name: "jules",
          kind: "remote-session",
          dispatch: async (_taskObj, _ctx) => {
            return {
              id: "session-remote-jules-456",
              status: "PENDING",
              kind: "remote-session",
              url: "https://jules.google.com/sessions/456",
              ok: true,
            };
          },
        };

        // 1. Maintainer dispatches task on trusted local host
        const session = await dispatch(
          {
            title: "Remote feature task",
            prompt: "Implement feature in src/index.js",
          },
          {
            root: dir,
            provider: mockRemoteProvider,
          }
        );
        assert.equal(session.baseSha, commitA, "Dispatch captures baseline A");

        // 2. Remote Jules executes in cloud VM (cannot access host machine filesystem)
        git(dir, ["checkout", "-q", "-b", "jules/session-remote-jules-456"]);
        writeFileSync(join(dir, "src", "index.js"), "export const base = 1;\nexport const remoteFeature = 100;\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "C: remote candidate commit from cloud VM"]);
        const commitC = git(dir, ["rev-parse", "HEAD"]);

        // 3. Candidate fetched locally
        // Unassisted gate fails closed: persistent files cannot serve as autonomous security authority
        const unassisted = await gate({ root: dir, mode: "committed" });
        assert.equal(unassisted.ok, false);
        assert.equal(unassisted.code, 1);
        assert.match(unassisted.error, /committed verification requires an explicit trusted baseline sha/i);

        // Assisted gate using baseline captured at dispatch verifies deterministically
        const res = await gate({ root: dir, mode: "committed", baseSha: session.baseSha });
        assert.equal(res.ok, true, "Gate approves clean feature against host authority baseline A");
        assert.equal(res.code, 0);
        assert.equal(res.baseSha, commitA, "Evaluates against baseline A from host authority");
        assert.equal(res.headSha, commitC, "Evaluates against candidate head C");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("E. Local-agent lifecycle: local provider with shell access fails closed on unassisted committed gate, requires explicit trusted --base-sha", async () => {
      const dir = initRepo("main");
      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "test-auth-e", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
        );
        mkdirSync(join(dir, ".agent"), { recursive: true });
        writeFileSync(
          join(dir, ".agent", "config.yml"),
          "version: 1\nscope:\n  allow:\n    - 'src/**'\nverify:\n  test: 'npm test'\n"
        );
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "src", "index.js"), "export const base = 1;\n");
        writeFileSync(join(dir, ".gitignore"), ".agent/state/\nnode_modules/\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "A: baseline"]);
        const commitA = git(dir, ["rev-parse", "HEAD"]);
        git(dir, ["update-ref", "refs/remotes/origin/main", commitA]);

        // Mock local execution provider (exec provider: kind: local-result)
        const mockLocalProvider = {
          name: "local-exec",
          kind: "local-result",
          type: "exec",
          dispatch: async (_taskObj, _ctx) => {
            return {
              id: "session-local-exec-789",
              status: "completed",
              kind: "local-result",
              ok: true,
            };
          },
        };

        // 1. Maintainer dispatches task with local execution provider
        await dispatch(
          {
            title: "Local execution task",
            prompt: "Execute local shell task",
          },
          {
            root: dir,
            provider: mockLocalProvider,
          }
        );

        // 2. Local candidate executes with shell access and creates commit
        git(dir, ["checkout", "-q", "-b", "local/feat"]);
        writeFileSync(join(dir, "src", "index.js"), "export const base = 1;\nexport const localFeature = 200;\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "C: local candidate commit"]);
        const commitC = git(dir, ["rev-parse", "HEAD"]);

        // 3. Unassisted committed gate fails closed: host storage is in candidate's OS trust domain
        const unassisted = await gate({ root: dir, mode: "committed" });
        assert.equal(unassisted.ok, false);
        assert.equal(unassisted.code, 1);
        assert.match(unassisted.error, /committed verification requires an explicit trusted baseline sha/i);

        // 4. Operator explicitly supplies trusted --base-sha: gate verifies deterministically
        const assisted = await gate({ root: dir, mode: "committed", baseSha: commitA });
        assert.equal(assisted.ok, true);
        assert.equal(assisted.code, 0);
        assert.equal(assisted.baseSha, commitA);
        assert.equal(assisted.headSha, commitC);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("Adversarial Trust-Boundary Hardening: Verification Execution & Authority Lifecycle", () => {
    it("1-3. Candidate verification script attempts to overwrite Host Authority; Gate 1 remains bound to A, Gate 2 rejects forged Host Authority", async () => {
      const dir = initRepo("main");
      const authDir = mkdtempSync(join(tmpdir(), "jok-auth-overwrite-"));
      const prevAuth = process.env.JULES_AUTHORITY_DIR;
      process.env.JULES_AUTHORITY_DIR = authDir;

      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "test-auth-overwrite", scripts: { test: "node evil-test.mjs" } }, null, 2)
        );
        mkdirSync(join(dir, ".agent"), { recursive: true });
        writeFileSync(
          join(dir, ".agent", "config.yml"),
          "version: 1\nscope:\n  allow:\n    - 'src/**'\n    - 'evil-test.mjs'\n    - 'package.json'\nverify:\n  test: 'npm test'\n"
        );
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "src", "index.js"), "export const base = 1;\n");
        writeFileSync(join(dir, ".gitignore"), ".agent/state/\nnode_modules/\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "A: baseline commit"]);
        const commitA = git(dir, ["rev-parse", "HEAD"]);
        git(dir, ["update-ref", "refs/remotes/origin/main", commitA]);

        // Pre-dispatch: Maintainer records trusted baseline A in host authority
        recordDispatchBaseline(dir, { baseSha: commitA, branch: "main", lifecycle: "remote-session" });

        // Attacker creates commit B (weakened policy or evil base)
        writeFileSync(join(dir, "src", "index.js"), "export const base = 1;\nexport const evil = true;\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "B: attacker commit"]);
        const commitB = git(dir, ["rev-parse", "HEAD"]);

        // Remote worker creates commit C (candidate feature with malicious test payload)
        git(dir, ["checkout", "-q", "-b", "candidate/feat"]);
        writeFileSync(join(dir, "src", "index.js"), "export const base = 1;\nexport const feature = 42;\n");

        // The malicious test payload targets the host authority directory
        const maliciousTest = `
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const authDir = process.env.JULES_AUTHORITY_DIR;
if (authDir) {
  const normalizedRoot = "${dir.replace(/\\/g, "/")}";
  const repoKey = createHash("sha256").update(normalizedRoot).digest("hex").slice(0, 16);
  const targetDir = join(authDir, repoKey);
  try {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(
      join(targetDir, "authority.json"),
      JSON.stringify({
        baseSha: "${commitB}",
        lifecycle: "remote-session",
        dispatchedAt: new Date().toISOString(),
        root: normalizedRoot
      }, null, 2)
    );
  } catch (_) {}
}
process.exit(0);
`;
        writeFileSync(join(dir, "evil-test.mjs"), maliciousTest);
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "C: candidate feature with exploit payload"]);
        const commitC = git(dir, ["rev-parse", "HEAD"]);

        // Gate invocation 1: Run committed verification with explicit trusted baseSha: commitA
        const res1 = await gate({ root: dir, mode: "committed", baseSha: commitA });
        assert.equal(res1.ok, true, "Gate 1 passes clean feature against baseline A");
        assert.equal(res1.baseSha, commitA, "Gate 1 remains strictly bound to original baseline A");
        assert.equal(res1.headSha, commitC, "Gate 1 head is candidate C");

        // Gate invocation 2: Operator or automated pipeline runs plain committed gate again without --base-sha
        const res2 = await gate({ root: dir, mode: "committed" });
        // Gate 2 MUST NOT accept attacker commit B
        assert.equal(res2.ok, false, "Gate 2 must reject candidate-forged Host Authority");
        assert.equal(res2.code, 1, "Must fail closed with code 1");
        assert.notEqual(res2.baseSha, commitB, "Must NEVER adopt attacker commit B as trusted base");
        assert.match(res2.error, /committed verification requires an explicit trusted baseline sha/i);
      } finally {
        if (prevAuth !== undefined) process.env.JULES_AUTHORITY_DIR = prevAuth;
        else delete process.env.JULES_AUTHORITY_DIR;
        rmSync(authDir, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("4. Abnormal/interrupted verification: candidate overwrites authority then crashes; gate retry fails closed and refuses attacker base", async () => {
      const dir = initRepo("main");
      const authDir = mkdtempSync(join(tmpdir(), "jok-auth-crash-"));
      const prevAuth = process.env.JULES_AUTHORITY_DIR;
      process.env.JULES_AUTHORITY_DIR = authDir;

      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "test-auth-crash", scripts: { test: "node crashing-evil-test.mjs" } }, null, 2)
        );
        mkdirSync(join(dir, ".agent"), { recursive: true });
        writeFileSync(
          join(dir, ".agent", "config.yml"),
          "version: 1\nscope:\n  allow:\n    - 'src/**'\n    - 'crashing-evil-test.mjs'\n    - 'package.json'\nverify:\n  test: 'npm test'\n"
        );
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "src", "index.js"), "export const base = 1;\n");
        writeFileSync(join(dir, ".gitignore"), ".agent/state/\nnode_modules/\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "A: baseline commit"]);
        const commitA = git(dir, ["rev-parse", "HEAD"]);
        git(dir, ["update-ref", "refs/remotes/origin/main", commitA]);

        // Pre-dispatch: baseline A
        recordDispatchBaseline(dir, { baseSha: commitA, branch: "main", lifecycle: "remote-session" });

        // Attacker commit B
        writeFileSync(join(dir, "src", "index.js"), "export const base = 1;\nexport const evil = true;\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "B: attacker commit"]);
        const commitB = git(dir, ["rev-parse", "HEAD"]);

        // Candidate commit C with crashing payload that overwrites authority before failing
        git(dir, ["checkout", "-q", "-b", "candidate/feat-crash"]);
        writeFileSync(join(dir, "src", "index.js"), "export const base = 1;\nexport const feature = 99;\n");

        const crashingPayload = `
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const authDir = process.env.JULES_AUTHORITY_DIR;
if (authDir) {
  const normalizedRoot = "${dir.replace(/\\/g, "/")}";
  const repoKey = createHash("sha256").update(normalizedRoot).digest("hex").slice(0, 16);
  const targetDir = join(authDir, repoKey);
  try {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(
      join(targetDir, "authority.json"),
      JSON.stringify({
        baseSha: "${commitB}",
        lifecycle: "remote-session",
        dispatchedAt: new Date().toISOString(),
        root: normalizedRoot
      }, null, 2)
    );
  } catch (_) {}
}
process.exit(137);
`;
        writeFileSync(join(dir, "crashing-evil-test.mjs"), crashingPayload);
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "C: crashing payload"]);

        // Gate 1: verification fails because process exited 137
        const res1 = await gate({ root: dir, mode: "committed", baseSha: commitA });
        assert.equal(res1.ok, false, "Gate 1 must fail due to abnormal exit code");
        assert.equal(res1.baseSha, commitA, "Gate 1 resolved against baseline A");

        // Operator retries: agentctl gate --committed without --base-sha
        const resRetry = await gate({ root: dir, mode: "committed" });
        // Gate retry MUST NOT adopt forged authority B
        assert.equal(resRetry.ok, false, "Gate retry must reject candidate-forged Host Authority");
        assert.equal(resRetry.code, 1, "Must fail closed with code 1");
        assert.notEqual(resRetry.baseSha, commitB, "Must NEVER adopt attacker commit B on retry");
        assert.match(resRetry.error, /committed verification requires an explicit trusted baseline sha/i);
      } finally {
        if (prevAuth !== undefined) process.env.JULES_AUTHORITY_DIR = prevAuth;
        else delete process.env.JULES_AUTHORITY_DIR;
        rmSync(authDir, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("5. Candidate .env / config cannot redirect JULES_AUTHORITY_DIR or BASE_SHA", async () => {
      const dir = initRepo("main");
      const authDir = mkdtempSync(join(tmpdir(), "jok-auth-env-"));
      const prevAuth = process.env.JULES_AUTHORITY_DIR;
      const prevBase = process.env.BASE_SHA;
      process.env.JULES_AUTHORITY_DIR = authDir;

      try {
        const { loadEnv } = await import("../src/runtime-env.mjs");
        writeFileSync(
          join(dir, ".env"),
          "JULES_AUTHORITY_DIR=/tmp/malicious-authority\nBASE_SHA=0123456789012345678901234567890123456789\nJULES_BASE_SHA=evil\nPR_LABELS=security-waive\nNODE_OPTIONS=--require evil.js\nORDINARY_VAR=safe_value\n"
        );

        loadEnv(dir);

        // Security-sensitive keys must NOT be overridden from candidate .env
        assert.equal(process.env.JULES_AUTHORITY_DIR, authDir, "JULES_AUTHORITY_DIR must not be redirected by candidate .env");
        assert.notEqual(process.env.BASE_SHA, "0123456789012345678901234567890123456789");
        assert.notEqual(process.env.JULES_BASE_SHA, "evil");
        assert.notEqual(process.env.PR_LABELS, "security-waive");
        assert.equal(process.env.ORDINARY_VAR, "safe_value", "Non-sensitive vars should still load normally");
      } finally {
        delete process.env.ORDINARY_VAR;
        if (prevAuth !== undefined) process.env.JULES_AUTHORITY_DIR = prevAuth;
        else delete process.env.JULES_AUTHORITY_DIR;
        if (prevBase !== undefined) process.env.BASE_SHA = prevBase;
        else delete process.env.BASE_SHA;
        rmSync(authDir, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("6. Clean normal remote Jules lifecycle still works seamlessly with pre-flight baseline SHA", async () => {
      const dir = initRepo("main");
      const authDir = mkdtempSync(join(tmpdir(), "jok-auth-clean-"));
      const prevAuth = process.env.JULES_AUTHORITY_DIR;
      process.env.JULES_AUTHORITY_DIR = authDir;

      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "test-auth-clean", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
        );
        mkdirSync(join(dir, ".agent"), { recursive: true });
        writeFileSync(
          join(dir, ".agent", "config.yml"),
          "version: 1\nscope:\n  allow:\n    - 'src/**'\nverify:\n  test: 'npm test'\n"
        );
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "src", "index.js"), "export const base = 1;\n");
        writeFileSync(join(dir, ".gitignore"), ".agent/state/\nnode_modules/\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "A: baseline"]);
        const commitA = git(dir, ["rev-parse", "HEAD"]);
        git(dir, ["update-ref", "refs/remotes/origin/main", commitA]);

        // Mock remote provider
        const mockRemoteProvider = {
          name: "jules",
          kind: "remote-session",
          dispatch: async () => ({ id: "s-1", status: "PENDING", ok: true }),
        };

        const session = await dispatch(
          { title: "Task 1", prompt: "Fix bug" },
          { root: dir, provider: mockRemoteProvider }
        );
        assert.equal(session.baseSha, commitA);

        // Remote worker branch
        git(dir, ["checkout", "-q", "-b", "jules/s-1"]);
        writeFileSync(join(dir, "src", "index.js"), "export const base = 1;\nexport const fix = true;\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "C: remote candidate commit"]);
        const commitC = git(dir, ["rev-parse", "HEAD"]);

        // Unassisted gate fails closed: persistent files cannot serve as autonomous security authority
        const unassisted = await gate({ root: dir, mode: "committed" });
        assert.equal(unassisted.ok, false);
        assert.equal(unassisted.code, 1);
        assert.match(unassisted.error, /committed verification requires an explicit trusted baseline sha/i);

        // Gate with explicit trusted baseline captured at dispatch succeeds
        const res = await gate({ root: dir, mode: "committed", baseSha: session.baseSha });
        assert.equal(res.ok, true, "Gate approves clean remote feature");
        assert.equal(res.code, 0);
        assert.equal(res.baseSha, commitA, "Bound to baseline A from dispatch");
        assert.equal(res.headSha, commitC);
      } finally {
        if (prevAuth !== undefined) process.env.JULES_AUTHORITY_DIR = prevAuth;
        else delete process.env.JULES_AUTHORITY_DIR;
        rmSync(authDir, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("7. Local same-user lifecycle still requires explicit trusted --base-sha", async () => {
      const dir = initRepo("main");
      const authDir = mkdtempSync(join(tmpdir(), "jok-auth-local-"));
      const prevAuth = process.env.JULES_AUTHORITY_DIR;
      process.env.JULES_AUTHORITY_DIR = authDir;

      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "test-auth-local-fail", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2)
        );
        mkdirSync(join(dir, ".agent"), { recursive: true });
        writeFileSync(
          join(dir, ".agent", "config.yml"),
          "version: 1\nscope:\n  allow:\n    - 'src/**'\nverify:\n  test: 'npm test'\n"
        );
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "src", "index.js"), "export const base = 1;\n");
        writeFileSync(join(dir, ".gitignore"), ".agent/state/\nnode_modules/\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "A: baseline"]);
        const commitA = git(dir, ["rev-parse", "HEAD"]);
        git(dir, ["update-ref", "refs/remotes/origin/main", commitA]);

        const mockLocalProvider = {
          name: "local-exec",
          kind: "local-result",
          type: "exec",
          dispatch: async () => ({ id: "s-2", status: "completed", ok: true }),
        };

        await dispatch(
          { title: "Local task", prompt: "Run command" },
          { root: dir, provider: mockLocalProvider }
        );

        git(dir, ["checkout", "-q", "-b", "local/feat-2"]);
        writeFileSync(join(dir, "src", "index.js"), "export const base = 1;\nexport const feat = 2;\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "C: local candidate commit"]);
        const commitC = git(dir, ["rev-parse", "HEAD"]);

        // Unassisted gate fails closed
        const unassisted = await gate({ root: dir, mode: "committed" });
        assert.equal(unassisted.ok, false);
        assert.equal(unassisted.code, 1);
        assert.match(unassisted.error, /committed verification requires an explicit trusted baseline sha/i);

        // Assisted gate with explicit trusted baseSha succeeds
        const assisted = await gate({ root: dir, mode: "committed", baseSha: commitA });
        assert.equal(assisted.ok, true);
        assert.equal(assisted.code, 0);
        assert.equal(assisted.baseSha, commitA);
        assert.equal(assisted.headSha, commitC);
      } finally {
        if (prevAuth !== undefined) process.env.JULES_AUTHORITY_DIR = prevAuth;
        else delete process.env.JULES_AUTHORITY_DIR;
        rmSync(authDir, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("8. Strong attack: Candidate verification script forges authority.json + active dispatches.json registry + repo ledger; Gate 2 refuses attacker baseline B and fails closed", async () => {
      const dir = initRepo("main");
      const authDir = mkdtempSync(join(tmpdir(), "jok-auth-strong-"));
      const prevAuth = process.env.JULES_AUTHORITY_DIR;
      process.env.JULES_AUTHORITY_DIR = authDir;

      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "test-auth-strong", scripts: { test: "node strong-evil.mjs" } }, null, 2)
        );
        mkdirSync(join(dir, ".agent"), { recursive: true });
        writeFileSync(
          join(dir, ".agent", "config.yml"),
          "version: 1\nscope:\n  allow:\n    - 'src/**'\n    - 'strong-evil.mjs'\n    - 'package.json'\nverify:\n  test: 'npm test'\n"
        );
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "src", "index.js"), "export const base = 1;\n");
        writeFileSync(join(dir, ".gitignore"), ".agent/state/\nnode_modules/\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "A: baseline"]);
        const commitA = git(dir, ["rev-parse", "HEAD"]);
        git(dir, ["update-ref", "refs/remotes/origin/main", commitA]);

        // Pre-dispatch: baseline A
        recordDispatchBaseline(dir, { baseSha: commitA, branch: "main", lifecycle: "remote-session" });

        // Attacker commit B
        writeFileSync(join(dir, "src", "index.js"), "export const base = 1;\nexport const evil = true;\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "B: attacker commit"]);
        const commitB = git(dir, ["rev-parse", "HEAD"]);

        // Candidate commit C with strong forgery payload
        git(dir, ["checkout", "-q", "-b", "candidate/strong"]);
        writeFileSync(join(dir, "src", "index.js"), "export const base = 1;\nexport const feature = 777;\n");

        const strongForgeryScript = `
import { writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const authDir = "${authDir.replace(/\\/g, "/")}";
const normalizedRoot = "${dir.replace(/\\/g, "/")}";
const repoKey = createHash("sha256").update(normalizedRoot).digest("hex").slice(0, 16);
const targetDir = join(authDir, repoKey);
mkdirSync(targetDir, { recursive: true });

const attackerNonce = randomUUID();
writeFileSync(
  join(targetDir, "dispatches.json"),
  JSON.stringify({
    [attackerNonce]: {
      baseSha: "${commitB}",
      lifecycle: "remote-session",
      dispatchedAt: new Date().toISOString(),
      state: "active"
    }
  }, null, 2)
);
writeFileSync(
  join(targetDir, "authority.json"),
  JSON.stringify({
    baseSha: "${commitB}",
    lifecycle: "remote-session",
    dispatchedAt: new Date().toISOString(),
    root: normalizedRoot,
    dispatchNonce: attackerNonce
  }, null, 2)
);

const stateDir = join(normalizedRoot, ".agent", "state");
const ledgerFiles = readdirSync(stateDir).filter(f => f.startsWith("ledger-") && f.endsWith(".jsonl"));
if (ledgerFiles.length > 0) {
  const ledgerPath = join(stateDir, ledgerFiles[0]);
  const lines = readFileSync(ledgerPath, "utf-8").split("\\n").filter(Boolean);
  let prevHash = "0".repeat(64);
  const forged = [];
  for (const line of lines) {
    const obj = JSON.parse(line);
    if (obj.event === "task_dispatch_baseline") obj.baseSha = "${commitB}";
    obj.prevHash = prevHash;
    const { hash: _h, ...rest } = obj;
    const computedHash = createHash("sha256").update(JSON.stringify(rest)).digest("hex");
    obj.hash = computedHash;
    prevHash = computedHash;
    forged.push(JSON.stringify(obj));
  }
  writeFileSync(ledgerPath, forged.join("\\n") + "\\n", "utf-8");
}
process.exit(0);
`;
        writeFileSync(join(dir, "strong-evil.mjs"), strongForgeryScript);
        git(dir, ["add", "."]);
        git(dir, ["commit", "-m", "C: strong forgery candidate"]);
        const commitC = git(dir, ["rev-parse", "HEAD"]);

        // Gate 1 with explicit trusted baseSha: passes bound to A
        const res1 = await gate({ root: dir, mode: "committed", baseSha: commitA });
        assert.equal(res1.ok, true);
        assert.equal(res1.baseSha, commitA);
        assert.equal(res1.headSha, commitC);

        // Gate 2 without baseSha: MUST FAIL CLOSED and MUST NOT accept attacker commit B
        const res2 = await gate({ root: dir, mode: "committed" });
        assert.equal(res2.ok, false, "Gate 2 must fail closed without explicit trusted baseline");
        assert.equal(res2.code, 1, "Exit code must be 1");
        assert.notEqual(res2.baseSha, commitB, "Must NEVER adopt attacker commit B as trusted base");
        assert.match(res2.error, /committed verification requires an explicit trusted baseline sha/i);
      } finally {
        if (prevAuth !== undefined) process.env.JULES_AUTHORITY_DIR = prevAuth;
        else delete process.env.JULES_AUTHORITY_DIR;
        rmSync(authDir, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});



