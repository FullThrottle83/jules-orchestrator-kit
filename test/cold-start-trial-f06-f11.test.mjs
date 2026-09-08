import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { resolveTrustedPolicy, checkBootstrapPolicyIntegrity } from "../src/config.mjs";
import { gate } from "../src/engine.mjs";
import { isPlaceholderTestScript, isSrcLayout } from "../src/stack-detector.mjs";
import { parseCollectedTests } from "../src/ops/test-collection.mjs";
import { materializeSnapshot } from "../src/git.mjs";

function setupGitRepo(initialBranch = "main") {
  const dir = mkdtempSync(join(tmpdir(), "cst-f06-f11-"));
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: "pipe" });
  git(["init", "-q", "-b", initialBranch]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test User"]);
  git(["config", "core.autocrlf", "false"]);
  return { dir, git };
}

describe("F06 — Uncommitted policy tampering in bootstrap mode", () => {
  it("rejects an uncommitted scaffold that replaces the test command with a placeholder", async () => {
    const { dir, git } = setupGitRepo();
    try {
      writeFileSync(join(dir, "go.mod"), "module example.com/test\n\ngo 1.22\n");
      writeFileSync(join(dir, "main.go"), "package main\n\nfunc Add(a, b int) int { return a + b }\n");
      writeFileSync(join(dir, "main_test.go"), "package main\n\nimport \"testing\"\nfunc TestAdd(t *testing.T) {}\n");
      git(["add", "."]);
      git(["commit", "-qm", "feat: initial go code"]);

      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        "version: 1\nverify:\n  test: 'node -e \"process.exit(0)\"'\n"
      );

      const res = await gate({ root: dir, base: "main", mode: "working-tree" });
      assert.equal(res.ok, false);
      assert.equal(res.code, 3, "must reject with Exit 3 (Scope / Policy rejection)");
      assert.match(res.error, /Bootstrap policy rejected/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an uncommitted scaffold that lowers profile to minimal", async () => {
    const { dir, git } = setupGitRepo();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", scripts: { test: "exit 1" } }));
      git(["add", "."]);
      git(["commit", "-qm", "feat: initial commit"]);

      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        "version: 1\nverify:\n  profile: minimal\n"
      );

      const res = await gate({ root: dir, base: "main", mode: "working-tree" });
      assert.equal(res.ok, false);
      assert.equal(res.code, 3);
      assert.match(res.error, /verify\.profile cannot be lowered to "minimal"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checkBootstrapPolicyIntegrity validates invariants directly", () => {
    const autoVerify = { test: "npm test" };
    assert.equal(
      checkBootstrapPolicyIntegrity("/tmp", { verify: { test: "sh -c :" } }, {}, autoVerify).ok,
      false
    );
    assert.equal(
      checkBootstrapPolicyIntegrity("/tmp", { verify: { required: false } }, {}, autoVerify).ok,
      false
    );
    assert.equal(
      checkBootstrapPolicyIntegrity("/tmp", { evidence: { strict_test_lock: false } }, {}, autoVerify).ok,
      false
    );
    assert.equal(
      checkBootstrapPolicyIntegrity("/tmp", { verify: { test: "npm test" } }, {}, autoVerify).ok,
      true
    );
  });
});

describe("F07 — Staged mode executes staged plan, ignoring untrusted disk edits", () => {
  it("ignores an unstaged no-op config edit in staged mode", async () => {
    const { dir, git } = setupGitRepo();
    try {
      // Base commit with real config
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        "version: 1\nverify:\n  test: 'node -e \"process.exit(1)\"'\n"
      );
      writeFileSync(join(dir, "index.js"), "export const x = 1;\n");
      git(["add", "."]);
      git(["commit", "-qm", "feat: initial with failing test config"]);

      // Stage a production change
      writeFileSync(join(dir, "index.js"), "export const x = 2;\n");
      git(["add", "index.js"]);

      // Adversary puts uncommitted/unstaged no-op test command on disk
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        "version: 1\nverify:\n  test: 'node -e \"process.exit(0)\"'\n"
      );

      // In staged mode against HEAD, trusted policy comes from HEAD, running exit 1
      const res = await gate({ root: dir, base: "HEAD", mode: "staged" });
      assert.equal(res.ok, false);
      assert.equal(res.code, 4, "failing test in HEAD must run and fail with Exit 4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("F08 — Base branch cannot be HEAD in committed mode", () => {
  it("rejects --base HEAD in committed mode to prevent empty diff bypass", () => {
    const policy = resolveTrustedPolicy(process.cwd(), "HEAD", "committed");
    assert.equal(policy.ok, false);
    assert.equal(policy.code, 3);
    assert.match(policy.error, /comparing a revision to itself/);
  });

  it("rejects base_branch: HEAD in scaffold integrity check", () => {
    const integrity = checkBootstrapPolicyIntegrity("/tmp", { base_branch: "HEAD" });
    assert.equal(integrity.ok, false);
    assert.match(integrity.error, /base_branch cannot be set to "HEAD"/);
  });
});

describe("F09 — Empty test collections and placeholder test commands", () => {
  it("recognizes no-op and bypass test scripts", () => {
    assert.equal(isPlaceholderTestScript('node -e "process.exit(0)"'), true);
    assert.equal(isPlaceholderTestScript('python3 -c "import sys; sys.exit(0)"'), true);
    assert.equal(isPlaceholderTestScript("python -c 'pass'"), true);
    assert.equal(isPlaceholderTestScript("pytest --collect-only"), true);
    assert.equal(isPlaceholderTestScript("sh -c :"), true);
    assert.equal(isPlaceholderTestScript("bash -c 'exit 0'"), true);
  });

  it("still accepts legitimate test commands", () => {
    assert.equal(isPlaceholderTestScript("npm test"), false);
    assert.equal(isPlaceholderTestScript("pytest"), false);
    assert.equal(isPlaceholderTestScript("go test ./..."), false);
    assert.equal(isPlaceholderTestScript("cargo test"), false);
  });

  it("parses Go [no tests to run] as 0 tests", () => {
    const output = "ok  \texample.com/pkg\t0.002s [no tests to run]";
    const res = parseCollectedTests(output, "go test ./...");
    assert.equal(res.count, 0);
  });

  it("parses pytest --collect-only zero items as 0 tests", () => {
    const output = "collected 0 items\n\n======================== no tests ran in 0.00s =========================";
    const res = parseCollectedTests(output, "pytest --collect-only");
    assert.equal(res.count, 0);
  });
});

describe("F10 — Materialize snapshot isolation", () => {
  it("staged snapshot contains only staged index, ignoring dirty working tree edits", () => {
    const { dir, git } = setupGitRepo();
    try {
      writeFileSync(join(dir, "app.js"), "const v = 1;\n");
      git(["add", "app.js"]);
      git(["commit", "-qm", "feat: initial"]);

      // Stage modification
      writeFileSync(join(dir, "app.js"), "const v = 2;\n");
      git(["add", "app.js"]);

      // Dirty unstaged modification in working tree
      writeFileSync(join(dir, "app.js"), "const v = 999;\n");
      writeFileSync(join(dir, "dirty-untracked.js"), "polluted\n");

      const snapshot = materializeSnapshot(dir, "staged", "HEAD");
      try {
        const snapContent = readFileSync(join(snapshot.cwd, "app.js"), "utf-8").replace(/\r\n/g, "\n");
        assert.equal(snapContent, "const v = 2;\n", "must match staged index, not dirty working tree");
        assert.equal(existsSync(join(snapshot.cwd, "dirty-untracked.js")), false, "untracked files must not leak");
      } finally {
        snapshot.cleanup();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("committed snapshot checks out target revision", () => {
    const { dir, git } = setupGitRepo();
    try {
      writeFileSync(join(dir, "file.txt"), "rev1\n");
      git(["add", "file.txt"]);
      git(["commit", "-qm", "rev 1"]);

      writeFileSync(join(dir, "file.txt"), "rev2\n");
      git(["add", "file.txt"]);
      git(["commit", "-qm", "rev 2"]);

      const snapshot = materializeSnapshot(dir, "committed", "HEAD~1");
      try {
        const content = readFileSync(join(snapshot.cwd, "file.txt"), "utf-8").replace(/\r\n/g, "\n");
        assert.equal(content, "rev1\n");
      } finally {
        snapshot.cleanup();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("F11 — Python src-layout detection", () => {
  it("detects src-layout repositories when src/ contains python packages", () => {
    const dir = mkdtempSync(join(tmpdir(), "py-layout-"));
    try {
      mkdirSync(join(dir, "src", "mypkg"), { recursive: true });
      writeFileSync(join(dir, "src", "mypkg", "__init__.py"), "");
      writeFileSync(join(dir, "pyproject.toml"), "[build-system]\n");
      assert.equal(isSrcLayout(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false when src does not exist or has no python code", () => {
    const dir = mkdtempSync(join(tmpdir(), "flat-layout-"));
    try {
      writeFileSync(join(dir, "pyproject.toml"), "");
      assert.equal(isSrcLayout(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Staged mode diff & anti-tamper gate integration", () => {
  it("detects staged test tampering in git index when on a feature branch", async () => {
    const { dir, git } = setupGitRepo();
    try {
      // Base on main with passing tests
      mkdirSync(join(dir, "tests"), { recursive: true });
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        "version: 1\nverify:\n  test: 'node --test tests/*.test.js'\n"
      );
      writeFileSync(
        join(dir, "tests", "calc.test.js"),
        "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('math', () => {\n  assert.equal(1, 1);\n});\n"
      );
      git(["add", "."]);
      git(["commit", "-qm", "feat: initial passing suite"]);

      // Create feature branch
      git(["checkout", "-b", "feature/staged-test"]);

      // Legitimate commit on branch
      writeFileSync(
        join(dir, "feature.js"),
        "export const f = 1;\n"
      );
      git(["add", "feature.js"]);
      git(["commit", "-qm", "feat: add feature file"]);

      // Stage an adversarial vacuous assertion change in git index
      writeFileSync(
        join(dir, "tests", "calc.test.js"),
        "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('math', () => {\n  if (false) {\n    assert.equal(1, 1);\n  }\n});\n"
      );
      git(["add", "tests/calc.test.js"]);

      const res = await gate({ root: dir, base: "main", mode: "staged" });
      assert.equal(res.ok, false, "gate must reject staged tampering");
      assert.equal(res.code, 6, "must reject with Exit 6 (Secrets / Anti-Tamper)");
      const secretPhase = res.phases.find((p) => p.phase === "secrets");
      assert.ok(
        secretPhase.findings.some(
          (f) => f.type === "TEST_TAMPERING_DETECTED" && f.description.includes("condition that can never be true")
        ),
        "must report dead condition finding"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
