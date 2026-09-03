import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { acquireLock, releaseLock, isLockLive } from "../src/state.mjs";
import { hasHighEntropyToken, checkTestTampering, checkScope } from "../src/security.mjs";
import { symlinkChanges, diffText } from "../src/git.mjs";
import { BUILTIN_DENY, BUILTIN_PROTECT, normalizeScope } from "../src/config.mjs";
import { computeDirectoryHash } from "../src/evidence.mjs";
import { detectPolyglotStack, pytestCmd } from "../src/stack-detector.mjs";

/**
 * A second cold review found seven ways the gate's answer was weaker than the
 * claim printed beside it. Every case below was reproduced against the shipped
 * CLI before it was fixed; each one fails loudly if the hole reopens.
 */

const CLI = fileURLToPath(new URL("../bin/agentctl.mjs", import.meta.url));
const git = (dir, args) => execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: "pipe" });

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "jok-cr2-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "index.js"), "export const x = 1;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  return dir;
}

const runCli = (dir, args) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf-8" });

describe("F1: a lock taken from the CLI actually excludes a second agent", () => {
  it("refuses a second acquire on an overlapping path", () => {
    const dir = tempRepo();
    try {
      // The holder process exits the instant it has written the record. Testing
      // *its* pid for liveness therefore always answered "dead", the lock was
      // reaped as abandoned, and both agents were told they held index.js.
      const first = runCli(dir, ["lock", "acquire", "agent-1", "task-100", "index.js"]);
      assert.equal(first.status, 0, first.stdout + first.stderr);

      const second = runCli(dir, ["lock", "acquire", "agent-2", "task-101", "index.js"]);
      assert.equal(second.status, 1, `second acquire must fail:\n${second.stdout}`);
      assert.match(second.stdout, /Lock conflict/);
      assert.match(second.stdout, /index\.js/, "the conflict must name the contested path");

      const status = runCli(dir, ["lock", "status"]);
      assert.equal((status.stdout.match(/taskId/g) || []).length, 1, "only one lock may exist");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still allows disjoint paths, and releasing frees the lock", () => {
    const dir = tempRepo();
    try {
      assert.equal(runCli(dir, ["lock", "acquire", "a", "t1", "index.js"]).status, 0);
      assert.equal(runCli(dir, ["lock", "acquire", "b", "t2", "other.js"]).status, 0);
      assert.equal(runCli(dir, ["lock", "release", "t1"]).status, 0);
      assert.equal(runCli(dir, ["lock", "acquire", "c", "t3", "index.js"]).status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps pid liveness for an in-process holder, so a crash cannot wedge the repo", () => {
    const dir = tempRepo();
    try {
      // No `lease` flag: the caller says it will stay alive, so a dead pid still
      // means an abandoned lock.
      const res = acquireLock("engine", "t-inproc", ["index.js"], dir);
      assert.equal(res.ok, true);
      assert.equal(isLockLive({ pid: 0x7ffffff0, acquiredAt: new Date().toISOString() }), false);
      assert.equal(
        isLockLive({ pid: 0x7ffffff0, leased: true, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
        true,
        "a lease outlives the process that wrote it"
      );
      assert.equal(
        isLockLive({ leased: true, expiresAt: new Date(Date.now() - 1000).toISOString() }),
        false,
        "an expired lease is not held"
      );
      releaseLock("t-inproc", dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("F2: a URL on the line no longer switches off entropy analysis", () => {
  const cases = [
    ["secret beside a URL comment", `const s = "eKt7W1jP9qLm3sV5xR8uN2yB4zQ6wA1c"; // https://api.internal/auth`, true],
    ["the same secret alone", `const s = "eKt7W1jP9qLm3sV5xR8uN2yB4zQ6wA1c";`, true],
    ["secret in a query parameter", `fetch("https://api.example.com/v1?api_key=eKt7W1jP9qLm3sV5xR8uN2yB4zQ6wA1c");`, true],
    ["secret in URL userinfo", `const dsn = "postgres://admin:eKt7W1jP9qLm3sV5xR8uN2yB4zQ6wA1c@db.example.com/app";`, true],
    ["CDN path with a content hash", `import x from "https://cdn.example.com/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8/app.js";`, false],
    ["subresource integrity", `  "integrity": "sha512-Ck6vT9lD9nH2mQ8xW3kF1jP0qR7sT4uV5wX6yZ8aB9cD0eF1gH2iJ3kL4mN5oP6qR7sT8uV9wX0yZ1aB2c=="`, false],
    ["inline data URI", `const i = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQ==";`, false],
    ["prose containing a link", `// See https://example.com/docs/getting-started for the walkthrough.`, false],
  ];

  for (const [name, line, expected] of cases) {
    it(`${expected ? "flags" : "ignores"}: ${name}`, () => {
      assert.equal(hasHighEntropyToken(line, "config.js"), expected);
    });
  }
});

describe("F3: an untracked symlink is judged by what it points at", () => {
  const skip = process.platform === "win32";

  it("resolves untracked links in working-tree mode", { skip }, () => {
    const dir = tempRepo();
    try {
      symlinkSync("/etc/os-release", join(dir, "leak.txt"));
      const links = symlinkChanges(dir, "main", "working-tree");
      assert.deepEqual(links, [{ link: "leak.txt", target: "/etc/os-release" }]);

      // The gate feeds each resolved target into checkScope alongside the link
      // itself; before this fix the list was empty and only "leak.txt" was
      // judged, which is a perfectly ordinary name.
      const scope = normalizeScope({ deny: [], allow: [], protect: [] });
      const res = checkScope(["leak.txt", ...links.map((l) => l.target)], scope);
      assert.equal(res.ok, false, "a link escaping the repo root must be denied");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders the link, never the contents of what it points at", { skip }, () => {
    const dir = tempRepo();
    try {
      writeFileSync(join(dir, "secret-target.txt"), "TOP_SECRET_MARKER\n");
      git(dir, ["add", "-A"]);
      git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "target"]);
      symlinkSync(join(dir, "secret-target.txt"), join(dir, "notes.md"));

      const diff = diffText(dir, "main", "working-tree");
      assert.ok(!diff.includes("TOP_SECRET_MARKER"), "reading through the link exfiltrates the target");
      assert.match(diff, /new file mode 120000/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("F4: rewriting what a test expects is reported", () => {
  const rewrite = [
    "--- a/test/add.test.js",
    "+++ b/test/add.test.js",
    "@@ -1,3 +1,3 @@",
    "-assert.equal(add(1, 2), 3);",
    "+assert.equal(add(1, 2), -1);",
  ].join("\n");

  it("flags an expectation changed to match broken output", () => {
    const res = checkTestTampering(rewrite);
    assert.equal(res.ok, false);
    assert.equal(res.violations.length, 1, JSON.stringify(res.violations));
    assert.equal(res.violations[0].type, "ASSERTION_EXPECTATION_CHANGED");
  });

  it("reports it once, not also as a removal or a weakening", () => {
    const types = checkTestTampering(rewrite).violations.map((v) => v.type);
    assert.deepEqual(types, ["ASSERTION_EXPECTATION_CHANGED"]);
  });

  it("says nothing when a test is added rather than rewritten", () => {
    const added = [
      "--- a/test/add.test.js",
      "+++ b/test/add.test.js",
      "@@ -1,2 +1,3 @@",
      " assert.equal(add(1, 2), 3);",
      "+assert.equal(add(-1, -2), -3);",
    ].join("\n");
    assert.equal(checkTestTampering(added).ok, true, JSON.stringify(checkTestTampering(added).violations));
  });

  it("is silenced by allowTestModifications, which the CLI now exposes", () => {
    assert.equal(checkTestTampering(rewrite, { allowTestModifications: true }).ok, true);
    const help = spawnSync(process.execPath, [CLI, "check", "--allow-test-modifications", "--help"], {
      cwd: process.cwd(),
      encoding: "utf-8",
    });
    assert.ok(
      !/Unknown option|unknown option/.test(`${help.stdout}${help.stderr}`),
      "the gate must accept --allow-test-modifications"
    );
  });
});

describe("F5: a standard Python layout is not rejected on first contact", () => {
  it("runs pytest as a module so the working directory is importable", () => {
    const dir = tempRepo();
    try {
      writeFileSync(join(dir, "calc.py"), "def add(a, b):\n    return a + b\n");
      mkdirSync(join(dir, "tests"), { recursive: true });
      writeFileSync(join(dir, "tests", "test_calc.py"), "from calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n");
      writeFileSync(join(dir, "requirements.txt"), "pytest\n");

      const detected = detectPolyglotStack(dir);
      assert.equal(detected.stack, "python");
      // Bare `pytest` does not put "." on sys.path, so the import above fails at
      // collection and a green suite is reported as exit 4.
      assert.equal(detected.testCmd, pytestCmd());
      assert.match(pytestCmd(), /-m pytest$/, "an interpreter is on PATH here, so pytest must run as a module");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let a test runner's own cache read as tampering", () => {
    const dir = tempRepo();
    try {
      mkdirSync(join(dir, "tests", "__pycache__"), { recursive: true });
      writeFileSync(join(dir, "tests", "test_calc.py"), "def test_add():\n    assert True\n");
      const before = computeDirectoryHash(dir, { testOnly: true }).treeHash;

      // What pytest writes on collection. It must not move the hash.
      writeFileSync(join(dir, "tests", "__pycache__", "test_calc.cpython-312.pyc"), "\0\0compiled\0\0");
      const after = computeDirectoryHash(dir, { testOnly: true }).treeHash;

      assert.equal(after, before, "a bytecode cache is not a test file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("F6: the scope guard covers more than one forge and one runner", () => {
  const scope = normalizeScope({ deny: [], allow: [], protect: [] });
  const denied = [".gitlab-ci.yml", ".circleci/config.yml", "Jenkinsfile", ".travis.yml", "azure-pipelines.yml"];
  const protectedPaths = ["setup.py", "conftest.py", "jest.config.js", "build.rs", "Dockerfile"];

  for (const file of denied) {
    it(`denies ${file}, as it already denied .github/**`, () => {
      assert.equal(checkScope([file], scope).ok, false);
    });
  }

  for (const file of protectedPaths) {
    it(`protects ${file}`, () => {
      const res = checkScope([file], scope);
      assert.equal(res.ok, false);
      assert.equal(res.violations[0].rule, "protect");
    });
  }

  it("keeps the builtin lists non-empty and merged, not replaced", () => {
    assert.ok(BUILTIN_DENY.includes(".github/**"));
    assert.ok(BUILTIN_DENY.includes(".gitlab-ci.yml"));
    assert.ok(BUILTIN_PROTECT.includes("package.json"));
  });
});

describe("F7: the evidence manifest does not claim to be signed", () => {
  it("prints a digest, because there is no key anywhere in the system", () => {
    const dir = tempRepo();
    try {
      const res = runCli(dir, ["evidence", "generate"]);
      const out = `${res.stdout}${res.stderr}`;
      assert.ok(!/Signature/.test(out), `"Signature" promises authorship a bare SHA-256 cannot give:\n${out}`);
      assert.match(out, /Digest/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
