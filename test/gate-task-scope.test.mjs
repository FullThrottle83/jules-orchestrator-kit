import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { computeEvidenceHash, generateEvidenceManifest } from "../src/evidence.mjs";

const CLI = fileURLToPath(new URL("../bin/agentctl.mjs", import.meta.url));

const ENVELOPE = (allow, id = "TASK-SCOPE") => [
  "---",
  "version: agentctl.task/v1",
  "kind: Task",
  `id: ${id}`,
  "scope:",
  "  allow:",
  ...allow.map((p) => `    - ${p}`),
  "---",
  "",
  "# Task",
  "",
].join("\n");

// A repository with a passing oracle, a trusted base on `main`, and a
// candidate branch checked out on top of it. Commits are deliberately unsigned.
function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "jules-task-scope-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe", encoding: "utf-8" });
  const write = (rel, content) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Base Author");
  git("config", "user.email", "base@example.com");
  git("config", "commit.gpgsign", "false");
  write(".agent/config.yml", "version: 1\nbase_branch: main\nverify:\n  test: node --test --test-reporter=spec fixture.test.mjs\n");
  write("src/feature.mjs", "export const add = (a, b) => a + b;\n");
  write("fixture.test.mjs", [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { add } from "./src/feature.mjs";',
    'test("addition", () => assert.equal(add(2, 3), 5));',
    "",
  ].join("\n"));
  write("README.md", "# Fixture\n");
  write("docs/providers/jules.md", "# Jules\n");
  write("tasks/TASK-SCOPE.md", ENVELOPE(["src/feature.mjs"]));
  git("add", ".");
  git("commit", "-qm", "test: establish trusted base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  const baseSha = git("rev-parse", "HEAD").trim();
  git("checkout", "-q", "-b", "candidate");
  return {
    root,
    baseSha,
    write,
    // The candidate's commit, authored and committed by someone other than the
    // agent that did the work, and not signed — the shape the Jules branches had.
    commit(message = "feat: candidate") {
      git("add", "-A");
      execFileSync("git", ["commit", "-qm", message], {
        cwd: root,
        stdio: "pipe",
        env: { ...process.env, GIT_COMMITTER_NAME: "Human Committer", GIT_COMMITTER_EMAIL: "human@example.com" },
      });
    },
  };
}

// Committed mode only trusts an explicit base SHA, so every run pins it.
function runGate(fx, args) {
  const res = spawnSync(process.execPath, [CLI, "gate", "--json", "--committed", "--base-sha", fx.baseSha, ...args], { cwd: fx.root, encoding: "utf-8" });
  let report = null;
  try {
    report = JSON.parse(res.stdout);
  } catch (_) {}
  return { exitCode: res.status, report, stderr: res.stderr, stdout: res.stdout };
}

function outsideEnvelope(allow) {
  const dir = mkdtempSync(join(tmpdir(), "jules-task-envelope-"));
  const path = join(dir, "TASK-SCOPE.md");
  writeFileSync(path, ENVELOPE(allow));
  return { dir, path };
}

const phase = (report, name) => report.phases.find((p) => p.phase === name);

describe("gate --task: a repository pass is not a task-scope pass", () => {
  // PR #144: the task allowed two files, the candidate also rewrote README.md.
  // The repository policy allows README.md, so the plain gate exited 0.
  it("README.md outside scope.allow: repository gate passes, task scope rejects at exit 3", () => {
    const fx = createFixture();
    const env = outsideEnvelope(["src/feature.mjs"]);
    try {
      fx.write("src/feature.mjs", "// candidate\nexport const add = (a, b) => a + b;\n");
      fx.write("README.md", "# Fixture\n\nUnrelated edit.\n");
      fx.commit();

      const plain = runGate(fx, []);
      assert.equal(plain.exitCode, 0, plain.stderr || plain.stdout);
      assert.deepEqual(plain.report.taskScope, {
        checked: false,
        reason: "NO_TASK_ENVELOPE",
        note: plain.report.taskScope.note,
      });
      assert.equal(phase(plain.report, "task_scope"), undefined);

      const scoped = runGate(fx, ["--task", env.path]);
      assert.equal(scoped.exitCode, 3, scoped.stderr || scoped.stdout);
      assert.equal(phase(scoped.report, "scope").ok, true, "the repository policy still passes");
      const taskPhase = phase(scoped.report, "task_scope");
      assert.equal(taskPhase.ok, false);
      assert.deepEqual(taskPhase.violations.map((v) => [v.file, v.rule, v.source]), [["README.md", "allow", "task"]]);
      assert.equal(scoped.report.taskScope.checked, true);
      assert.equal(scoped.report.taskScope.ok, false);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  // PR #141: the provider's changeSet.gitPatch scratch file rode along with the
  // one documentation file the task allowed.
  it("scratch file next to the allowed file is rejected", () => {
    const fx = createFixture();
    const env = outsideEnvelope(["docs/providers/jules.md"]);
    try {
      fx.write("docs/providers/jules.md", "# Jules\n\nClarified.\n");
      fx.write("changeSet.gitPatch", "diff --git a/x b/x\n");
      fx.commit();

      assert.equal(runGate(fx, []).exitCode, 0);
      const scoped = runGate(fx, ["--task", env.path]);
      assert.equal(scoped.exitCode, 3, scoped.stderr || scoped.stdout);
      assert.deepEqual(phase(scoped.report, "task_scope").violations.map((v) => v.file), ["changeSet.gitPatch"]);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it("a candidate inside the envelope passes and the evidence records which envelope was applied", () => {
    const fx = createFixture();
    const env = outsideEnvelope(["src/feature.mjs"]);
    try {
      fx.write("src/feature.mjs", "// candidate\nexport const add = (a, b) => a + b;\n");
      fx.commit();

      const scoped = runGate(fx, ["--task", env.path]);
      assert.equal(scoped.exitCode, 0, scoped.stderr || scoped.stdout);
      const digest = createHash("sha256").update(readFileSync(env.path)).digest("hex");
      assert.equal(scoped.report.taskScope.checked, true);
      assert.equal(scoped.report.taskScope.ok, true);
      assert.equal(scoped.report.taskScope.envelope.sha256, digest);
      assert.equal(scoped.report.taskScope.envelope.source, "file");
      assert.equal(scoped.report.taskScope.taskId, "TASK-SCOPE");
      assert.equal(phase(scoped.report, "task_scope").ok, true);
      assert.deepEqual(scoped.report.evidence.taskScope, scoped.report.taskScope);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it("without --task the evidence manifest says task scope was not checked", () => {
    const fx = createFixture();
    try {
      fx.write("src/feature.mjs", "// candidate\nexport const add = (a, b) => a + b;\n");
      fx.commit();
      const plain = runGate(fx, []);
      assert.equal(plain.exitCode, 0, plain.stderr || plain.stdout);
      assert.equal(plain.report.evidence.taskScope.checked, false);
      const persisted = JSON.parse(readFileSync(join(fx.root, ".agent", "evidence", "manifest.v1.json"), "utf-8"));
      assert.equal(persisted.taskScope.checked, false);
      assert.equal(persisted.taskScope.reason, "NO_TASK_ENVELOPE");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it("an envelope that names no paths is reported as unconstrained rather than as a narrowed pass", () => {
    const fx = createFixture();
    const dir = mkdtempSync(join(tmpdir(), "jules-task-envelope-"));
    const path = join(dir, "TASK-OPEN.md");
    writeFileSync(path, "---\nversion: agentctl.task/v1\nkind: Task\nid: TASK-OPEN\n---\n\n# Task\n");
    try {
      fx.write("src/feature.mjs", "// candidate\nexport const add = (a, b) => a + b;\n");
      fx.commit();
      const scoped = runGate(fx, ["--task", path]);
      assert.equal(scoped.exitCode, 0, scoped.stderr || scoped.stdout);
      assert.equal(scoped.report.taskScope.unconstrained, true);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gate --task: the candidate cannot supply the contract", () => {
  it("rejects an envelope that the candidate itself rewrote to cover its own changes", () => {
    const fx = createFixture();
    try {
      fx.write("tasks/TASK-SCOPE.md", ENVELOPE(["src/feature.mjs", "README.md"]));
      fx.write("README.md", "# Fixture\n\nUnrelated edit.\n");
      fx.commit();

      const scoped = runGate(fx, ["--task", "tasks/TASK-SCOPE.md"]);
      assert.equal(scoped.exitCode, 3, scoped.stderr || scoped.stdout);
      assert.equal(scoped.report.taskScope.code, "TASK_ENVELOPE_IN_CANDIDATE");
      assert.equal(phase(scoped.report, "task_scope").ok, false);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it("reads a tracked envelope from the trusted base, not from the working tree", () => {
    const fx = createFixture();
    try {
      fx.write("README.md", "# Fixture\n\nUnrelated edit.\n");
      fx.commit();
      // Widened after the commit, on disk only. The base version still governs.
      writeFileSync(join(fx.root, "tasks", "TASK-SCOPE.md"), ENVELOPE(["src/feature.mjs", "README.md"]));

      const scoped = runGate(fx, ["--task", "tasks/TASK-SCOPE.md"]);
      assert.equal(scoped.report.taskScope.envelope.source, "base");
      assert.deepEqual(scoped.report.taskScope.allow, ["src/feature.mjs"]);
      assert.equal(scoped.exitCode, 3, scoped.stderr || scoped.stdout);
      assert.deepEqual(phase(scoped.report, "task_scope").violations.map((v) => v.file), ["README.md"]);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it("fails closed on a missing or malformed envelope instead of skipping the check", () => {
    const fx = createFixture();
    const dir = mkdtempSync(join(tmpdir(), "jules-task-envelope-"));
    const malformed = join(dir, "TASK-BAD.md");
    writeFileSync(malformed, "no frontmatter here\n");
    try {
      fx.write("src/feature.mjs", "// candidate\nexport const add = (a, b) => a + b;\n");
      fx.commit();

      const missing = runGate(fx, ["--task", join(dir, "absent.md")]);
      assert.equal(missing.exitCode, 3, missing.stderr || missing.stdout);
      assert.equal(missing.report.taskScope.code, "TASK_ENVELOPE_UNREADABLE");

      const bad = runGate(fx, ["--task", malformed]);
      assert.equal(bad.exitCode, 3, bad.stderr || bad.stdout);
      assert.equal(bad.report.taskScope.code, "TASK_ENVELOPE_INVALID");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gate: commit provenance is observed, not enforced", () => {
  it("reports author, committer and signature status, and an unsigned commit does not change the exit code", () => {
    const fx = createFixture();
    try {
      fx.write("src/feature.mjs", "// candidate\nexport const add = (a, b) => a + b;\n");
      fx.commit();
      const res = runGate(fx, []);
      assert.equal(res.exitCode, 0, res.stderr || res.stdout);
      const prov = res.report.commitProvenance;
      assert.equal(prov.observed, true);
      assert.equal(prov.commits.length, 1);
      const [commit] = prov.commits;
      assert.equal(commit.author.name, "Base Author");
      assert.equal(commit.committer.name, "Human Committer");
      assert.deepEqual([commit.signature.code, commit.signature.status], ["N", "unsigned"]);
      assert.deepEqual(res.report.evidence.commitProvenance, prov);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

describe("evidence integrity covers the new fields", () => {
  it("changing taskScope or commitProvenance invalidates the manifest hash", () => {
    const root = mkdtempSync(join(tmpdir(), "jules-task-evidence-"));
    try {
      const manifest = generateEvidenceManifest(root, {
        taskScope: { checked: false, reason: "NO_TASK_ENVELOPE" },
        commitProvenance: { observed: true, commits: [] },
      });
      assert.equal(manifest.evidenceHash, computeEvidenceHash(manifest));
      assert.notEqual(computeEvidenceHash({ ...manifest, taskScope: { checked: true, ok: true } }), manifest.evidenceHash);
      assert.notEqual(computeEvidenceHash({ ...manifest, commitProvenance: { observed: false } }), manifest.evidenceHash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a manifest written before these fields existed still hashes to the value it was sealed with", () => {
    const legacy = {
      schema: "agentctl/evidence-manifest-v1",
      manifestId: "EVD-legacy",
      generatedAt: "2026-01-01T00:00:00.000Z",
      status: "passed",
      intent: { taskId: "t", title: "T", promptHash: "sha256:empty", promptExcerpt: "" },
      provenance: { commitSha: "a".repeat(40), baseSha: "b".repeat(40), headSha: "a".repeat(40), baseRef: "main", headRef: "HEAD", branch: "x", dirty: false, repository: "local" },
      testIntegrity: { preTestHash: "h", postTestHash: "h", tamperDetected: false, testFileCount: 1, fileHashes: {} },
      sourceIntegrity: { treeHash: "s", fileCount: 2 },
      executionRecords: [],
      securityChecks: { secretScanOk: true, diffKb: 1, maxDiffKb: 75, protectedScopeOk: true },
    };
    // Computed with the v0.76.3 implementation, before taskScope existed.
    assert.equal(computeEvidenceHash(legacy), "sha256:797f95811babc05c849e7c467682f8f911e969f8289d19090d1b7d915f3c7b6a");
  });
});
