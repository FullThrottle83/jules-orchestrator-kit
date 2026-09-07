import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { detectStackOracles } from "../src/wizard-oracle.mjs";
import { parseCollectedTests } from "../src/ops/test-collection.mjs";
import { gate } from "../src/engine.mjs";
import { getCommandDescriptor } from "../src/ops/command-registry.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const AGENTCTL = join(ROOT, "bin", "agentctl.mjs");

function setupGitRepo(initialBranch = "main") {
  const dir = mkdtempSync(join(tmpdir(), "cst-f13-f22-"));
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: "pipe" });
  git(["init", "-q", "-b", initialBranch]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test User"]);
  return { dir, git };
}

describe("F13 — Markdown EOF hygiene", () => {
  it("JULES_RULES_TEMPLATE.md ends with a single newline, not multiple trailing blanks", () => {
    const content = readFileSync(join(ROOT, "JULES_RULES_TEMPLATE.md"), "utf-8");
    assert.ok(content.endsWith("\n"), "file must end with a newline");
    assert.ok(!content.endsWith("\n\n"), "file must not end with trailing blank lines");
  });

  it(".agent/rules/jules-protocol.md ends with a single newline, not multiple trailing blanks", () => {
    const content = readFileSync(join(ROOT, ".agent", "rules", "jules-protocol.md"), "utf-8");
    assert.ok(content.endsWith("\n"), "file must end with a newline");
    assert.ok(!content.endsWith("\n\n"), "file must not end with trailing blank lines");
  });
});

describe("F14 — Cargo lint oracle defaults without -D warnings", () => {
  it("generates cargo clippy candidate without forcing -D warnings", () => {
    const dir = mkdtempSync(join(tmpdir(), "cst-f14-"));
    try {
      writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "test-pkg"\nversion = "0.1.0"\n');
      const oracles = detectStackOracles(dir);
      assert.ok(oracles.candidates.lintCmd, "lint oracle must be detected for Cargo");
      assert.ok(
        oracles.candidates.lintCmd.startsWith("cargo clippy"),
        `lint command should be cargo clippy, got: ${oracles.candidates.lintCmd}`
      );
      assert.ok(
        !oracles.candidates.lintCmd.includes("-D warnings"),
        `cargo clippy must not enforce -D warnings by default: ${oracles.candidates.lintCmd}`
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("F15 — Multi-target Cargo test count aggregation", () => {
  it("aggregates test counts across all Cargo compilation targets (0 unit + 58 integration = 58)", () => {
    const multiTargetOutput = `
     Running unittests src/lib.rs (target/debug/deps/my_lib-abc)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/integration.rs (target/debug/deps/integration-def)

running 58 tests
test test_parse ... ok
test test_render ... ok
test result: ok. 58 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.05s
`;
    const res = parseCollectedTests(multiTargetOutput);
    assert.equal(res.count, 58, "must sum across all target test runners");
    assert.equal(res.runner, "cargo", "runner must be cargo");
  });
});

describe("F16 — Lockfile scope violation and supply chain remediation hint", () => {
  it("prints informative supply chain hint and suggests --allow-protected on lockfile modification", () => {
    const { dir, git } = setupGitRepo();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", scripts: { test: "node -e 'process.exit(0)'" } }));
      writeFileSync(join(dir, "package-lock.json"), "{}");
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\nverify:\n  test: node -e 'process.exit(0)'\n");
      git(["add", "."]);
      git(["commit", "-qm", "feat: initial commit"]);

      // Modify lockfile
      writeFileSync(join(dir, "package-lock.json"), '{"name": "app", "version": "1.0.0"}');

      let stdout = "";
      let stderr = "";
      let exitCode = 0;
      try {
        stdout = execFileSync(process.execPath, [AGENTCTL, "check", "--base", "main"], {
          cwd: dir,
          encoding: "utf-8",
          stdio: "pipe",
        });
      } catch (err) {
        exitCode = err.status;
        stdout = err.stdout || "";
        stderr = err.stderr || "";
      }

      assert.equal(exitCode, 3, "must exit 3 on lockfile tamper");
      const out = stdout + stderr;
      assert.ok(out.includes("supply-chain tampering"), "output should explain lockfile supply-chain protection");
      assert.ok(out.includes("--allow-protected"), "output should suggest --allow-protected");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("F17 — CLI parsing accepts --strict-locks", () => {
  it("agentctl check accepts --strict-locks flag without unknown option error", () => {
    const { dir, git } = setupGitRepo();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", scripts: { test: "node -e 'console.log(\"# tests 1\\n# pass 1\")'" } }));
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\nverify:\n  test: node -e 'console.log(\"# tests 1\\n# pass 1\")'\n");
      git(["add", "."]);
      git(["commit", "-qm", "feat: initial commit"]);

      const out = execFileSync(
        process.execPath,
        [AGENTCTL, "check", "--base", "main", "--strict-locks"],
        { cwd: dir, encoding: "utf-8", stdio: "pipe" }
      );
      assert.ok(!out.includes("Unknown option: --strict-locks"), "should not fail with unknown option");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("F18 & F19 — Active waivers, overrides banner, and truthful messaging", () => {
  it("tracks active waivers in gate result overrides", () => {
    const { dir, git } = setupGitRepo();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", scripts: { test: "node -e 'console.log(\"# tests 1\\n# pass 1\")'" } }));
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        "version: 1\nverify:\n  test: node -e 'console.log(\"# tests 1\\n# pass 1\")'\n  minTests: 0\n"
      );
      git(["add", "."]);
      git(["commit", "-qm", "feat: initial commit"]);

      const origEnv = process.env.JULES_ALLOW_COMMAND_FILE_CHANGES;
      process.env.JULES_ALLOW_COMMAND_FILE_CHANGES = "1";
      try {
        let stdout = "";
        try {
          stdout = execFileSync(
            process.execPath,
            [AGENTCTL, "check", "--base", "main", "--json"],
            { cwd: dir, encoding: "utf-8", stdio: "pipe" }
          );
        } catch (err) {
          stdout = err.stdout || "";
        }
        const parsed = JSON.parse(stdout);
        assert.ok(Array.isArray(parsed.overrides), "parsed.overrides should be an array");
        assert.ok(
          parsed.overrides.some((o) => o.includes("JULES_ALLOW_COMMAND_FILE_CHANGES")),
          "should record environment waiver"
        );
        assert.ok(
          parsed.overrides.some((o) => o.includes("minTests: 0")),
          "should record minTests waiver"
        );
      } finally {
        if (origEnv === undefined) {
          delete process.env.JULES_ALLOW_COMMAND_FILE_CHANGES;
        } else {
          process.env.JULES_ALLOW_COMMAND_FILE_CHANGES = origEnv;
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("formats verify.required: false accurately as permitting verification failures rather than nothing executed", () => {
    const { dir, git } = setupGitRepo();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", scripts: { test: "node -e 'process.exit(0)'" } }));
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        "version: 1\nverify:\n  required: false\n  test: node -e 'process.exit(0)'\n"
      );
      git(["add", "."]);
      git(["commit", "-qm", "feat: initial commit"]);

      const out = execFileSync(
        process.execPath,
        [AGENTCTL, "check", "--base", "main"],
        { cwd: dir, encoding: "utf-8", stdio: "pipe" }
      );
      assert.ok(
        out.includes("verification failures and empty test suites permitted"),
        "should display accurate warning for verify.required: false"
      );
      assert.ok(!out.includes("nothing is executed"), "should not falsely claim nothing is executed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("F20 — Dry-run suppression and simulation markers", () => {
  it("suppresses evidence manifest creation when dryRun is active", async () => {
    const { dir, git } = setupGitRepo();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", scripts: { test: "node -e 'console.log(\"# tests 1\\n# pass 1\")'" } }));
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\nverify:\n  test: node -e 'console.log(\"# tests 1\\n# pass 1\")'\n");
      git(["add", "."]);
      git(["commit", "-qm", "feat: initial commit"]);

      // Gate run with dryRun: true
      const res = await gate({ root: dir, base: "main", mode: "working-tree", dryRun: true });
      assert.equal(res.ok, true);

      const evidenceDir = join(dir, ".agent", "evidence");
      if (existsSync(evidenceDir)) {
        const files = readdirSync(evidenceDir);
        assert.equal(files.length, 0, "no evidence files should be written on dryRun");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("agentctl plan approve and session get show [DRY-RUN] markers during simulation", () => {
    const planOut = execFileSync(
      process.execPath,
      [AGENTCTL, "plan", "approve", "session-123", "--dry-run"],
      { encoding: "utf-8", stdio: "pipe" }
    );
    assert.ok(planOut.includes("[DRY-RUN]"), "plan approve output must contain [DRY-RUN]");

    const sessionOut = execFileSync(
      process.execPath,
      [AGENTCTL, "session", "get", "session-123", "--dry-run"],
      { encoding: "utf-8", stdio: "pipe" }
    );
    assert.ok(sessionOut.includes("[DRY-RUN]"), "session get output must contain [DRY-RUN]");
  });
});

describe("F21 — Subcommand help routing", () => {
  it("command-registry exports descriptors for pr harvest, session get, and plan approve", () => {
    assert.ok(getCommandDescriptor("pr harvest"), "pr harvest descriptor must exist");
    assert.ok(getCommandDescriptor("session get"), "session get descriptor must exist");
    assert.ok(getCommandDescriptor("plan approve"), "plan approve descriptor must exist");
  });

  it("agentctl pr harvest --help outputs targeted flags including --allow-no-checks", () => {
    const out = execFileSync(
      process.execPath,
      [AGENTCTL, "pr", "harvest", "--help"],
      { encoding: "utf-8", stdio: "pipe" }
    );
    assert.ok(out.includes("--allow-no-checks"), "must document --allow-no-checks");
    assert.ok(!out.includes("Core Capabilities"), "must not dump full root help");
  });

  it("agentctl help check outputs targeted help for the check command", () => {
    const out = execFileSync(
      process.execPath,
      [AGENTCTL, "help", "check"],
      { encoding: "utf-8", stdio: "pipe" }
    );
    assert.ok(out.includes("agentctl gate"), "must include canonical agentctl gate usage");
    assert.ok(!out.includes("agentctl help <command>"), "must be focused command help");
  });
});

describe("F22 — Complete uninstall and undo init documentation", () => {
  it("README.md contains complete uninstall / removing the kit documentation", () => {
    const content = readFileSync(join(ROOT, "README.md"), "utf-8");
    assert.match(
      content,
      /Complete Uninstall \/ Removing the Kit \(Undo Init\)/i,
      "README.md must have uninstall / undo init section"
    );
    assert.match(
      content,
      /git rm -rf --ignore-unmatch.*\.agent.*AGENTS\.md.*SPEC\.md/s,
      "README.md must document git rm command for tracked scaffold assets"
    );
    assert.match(
      content,
      /rm -rf \.agent \.agentctl/,
      "README.md must document runtime state cleanup"
    );
    assert.match(
      content,
      /clean.*maintenance.*not an uninstaller/i,
      "README.md must clarify that clean is maintenance not uninstaller"
    );
  });
});
