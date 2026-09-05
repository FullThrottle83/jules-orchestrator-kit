import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { gate } from "../src/engine.mjs";
import { resolveTrustedPolicy, generateReferenceScaffold, diffObeyedFields } from "../src/trusted-policy.mjs";
import { materialiseRevision } from "../src/revision-snapshot.mjs";
import { checkSourceBinding } from "../src/source-binding.mjs";
import { isPlaceholderTestScript, describeIncapableTestCommand } from "../src/stack-detector.mjs";
import {
  INCAPABLE_ORACLES,
  CAPABLE_ORACLES,
  TRUSTED_FIELDS,
  VERIFIED_REVISIONS,
  SOURCE_BINDING_CASES,
} from "../src/guard-policy.mjs";

/**
 * The trusted-policy and verified-revision findings from the 5 September 2026
 * cold-start trial: F06, F07, F08, F09, F10, F11.
 *
 * Every one of them is the same two questions asked of different code paths.
 * Is the policy the gate obeys separable from the diff the gate is judging?
 * Is the code the gate runs the revision it attests? Before this change the
 * answer to both was no, in five places, and the fixtures below are the ones
 * the trial used, reduced to a Node repository so they run without a Go or
 * Rust toolchain.
 *
 * Each test was confirmed to fail against v0.71.0 before the fix landed.
 */

const CLI = fileURLToPath(new URL("../bin/agentctl.mjs", import.meta.url));

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" });
}

/**
 * A small honest repository: a function, a test that would catch it breaking,
 * and a scaffolded `.agent/`.
 *
 * `committed: false` leaves the scaffold uncommitted, which is the first-install
 * shape F06 is about.
 */
function fixture({ committed = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "jok-trusted-"));
  git(dir, ["init", "-q", "-b", "master", "."]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "Tester"]);

  writeFileSync(join(dir, "calc.js"), "export function add(a, b) { return a + b; }\n");
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(
    join(dir, "test", "calc.test.js"),
    'import test from "node:test";\n' +
      'import assert from "node:assert/strict";\n' +
      'import { add } from "../calc.js";\n' +
      'test("add", () => { assert.equal(add(2, 2), 4); });\n'
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fx", version: "1.0.0", type: "module", scripts: { test: "node --test test/*.test.js" } }, null, 2) + "\n"
  );
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "init"]);

  const init = spawnSync(process.execPath, [CLI, "init", "--yes"], { cwd: dir, encoding: "utf-8" });
  assert.equal(init.status, 0, `init failed: ${init.stderr || init.stdout}`);

  if (committed) {
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "chore: add agent config"]);
  }
  return dir;
}

/** Rewrite one `verify:` scalar in the scaffolded config. */
function setConfig(dir, key, value) {
  const p = join(dir, ".agent", "config.yml");
  const src = readFileSync(p, "utf-8");
  const re = new RegExp(`^  ${key}:.*$`, "m");
  assert.ok(re.test(src), `config has no verify.${key} to rewrite`);
  writeFileSync(p, src.replace(re, `  ${key}: ${value}`));
}

function setTopLevel(dir, key, value) {
  const p = join(dir, ".agent", "config.yml");
  const src = readFileSync(p, "utf-8");
  const re = new RegExp(`^${key}:.*$`, "m");
  assert.ok(re.test(src), `config has no ${key} to rewrite`);
  writeFileSync(p, src.replace(re, `${key}: ${value}`));
}

function breakProduction(dir) {
  writeFileSync(join(dir, "calc.js"), "export function add(a, b) { return a - b; }\n");
}

function healProduction(dir) {
  writeFileSync(join(dir, "calc.js"), "export function add(a, b) { return a + b; }\n");
}

/**
 * Run the fixture's own suite, honestly.
 *
 * NODE_TEST_CONTEXT and NODE_CHANNEL_FD have to be stripped or the child
 * switches into child-reporter mode and its failures stop reaching the exit
 * code — this suite would then see exit 0 from a red suite. `gate()` strips
 * exactly these for exactly this reason; a control that does not is not a
 * control.
 */
function runSuite(dir) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("NODE_TEST_") || key.startsWith("NODE_CHANNEL_")) delete env[key];
  }
  return spawnSync(process.execPath, ["--test", "test/calc.test.js"], { cwd: dir, encoding: "utf-8", env });
}

/** The control the trial insisted on: the real suite must be red first. */
function realSuiteFails(dir) {
  return runSuite(dir).status !== 0;
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// F06 — first install
// ---------------------------------------------------------------------------

describe("F06: an uncommitted scaffold is not a trusted policy", () => {
  it("refuses a scaffold whose verify.test the same diff replaced with a no-op", async () => {
    const dir = fixture({ committed: false });
    try {
      breakProduction(dir);
      assert.ok(realSuiteFails(dir), "control: the real suite must fail on the broken code");

      setConfig(dir, "test", 'node -e "process.exit(0)"');
      setConfig(dir, "profile", "minimal");

      const res = await gate({ root: dir, base: "master", mode: "working-tree" });

      assert.equal(res.ok, false, "v0.71.0 approved this: the agent supplied its own oracle");
      assert.equal(res.code, 3);

      const scope = res.phases.find((p) => p.phase === "scope");
      assert.ok(scope.setupRefused, "the refusal must be reported, not silent");
      const fields = scope.setupRefused.mismatches.map((m) => m.field);
      assert.ok(fields.includes("verify.test"), `must name the field that differs, got ${fields.join(", ")}`);
      assert.ok(fields.includes("verify.profile"));
      for (const m of scope.setupRefused.mismatches) {
        assert.equal(m.file, ".agent/config.yml", "must name the file");
        assert.match(m.detail, /init.*generates/, "must say what init would have written");
      }
    } finally {
      cleanup(dir);
    }
  });

  it("still approves an honest first install, byte-identical to what init wrote", async () => {
    // The counterweight. A rule that rejects the tampered scaffold by also
    // rejecting the honest one has not fixed anything — it has re-created the
    // "gate refuses its own installation" defect the bootstrap exception was
    // added for.
    const dir = fixture({ committed: false });
    try {
      const res = await gate({ root: dir, base: "master", mode: "working-tree" });
      assert.equal(res.ok, true, "an untouched scaffold must still pass");
      const scope = res.phases.find((p) => p.phase === "scope");
      assert.ok(scope.setup?.length > 0, "and must still be reported as accepted setup");
      assert.ok(!scope.setupRefused);
    } finally {
      cleanup(dir);
    }
  });

  it("names the file and field for a scaffold edited in any obeyed field", async () => {
    const dir = fixture({ committed: false });
    try {
      setTopLevel(dir, "base_branch", "HEAD");
      const policy = await resolveTrustedPolicy({ root: dir, base: "master", config: { verify: {} } });
      assert.equal(policy.trusted, false);
      const m = policy.scaffold.mismatches.find((x) => x.field === "base_branch");
      assert.ok(m, "base_branch is a field the gate obeys and must be reported");
      assert.equal(m.file, ".agent/config.yml");
    } finally {
      cleanup(dir);
    }
  });

  it("regenerates the reference scaffold identically for an unmodified install", async () => {
    const dir = fixture({ committed: false });
    try {
      const ref = await generateReferenceScaffold(dir);
      for (const file of [".agent/config.yml", ".agent/jules.yml"]) {
        assert.equal(
          readFileSync(join(dir, ...file.split("/")), "utf-8"),
          ref[file],
          `${file} must regenerate byte-identically, or every honest install is rejected`
        );
      }
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// F07 — the stage plan
// ---------------------------------------------------------------------------

describe("F07: the stage plan comes from the base, not from an unstaged config edit", () => {
  it("runs the trusted command in staged mode, ignoring an unstaged verify.test", async () => {
    const dir = fixture();
    try {
      breakProduction(dir);
      git(dir, ["add", "calc.js"]);
      // Not staged. The trial's point exactly: excluding a policy file from
      // the diff excluded it from review but not from effect.
      setConfig(dir, "test", 'node -e "process.exit(0)"');
      setConfig(dir, "profile", "minimal");

      const res = await gate({ root: dir, base: "HEAD", mode: "staged" });

      assert.equal(res.ok, false, "v0.71.0 approved this");
      const verify = res.phases.find((p) => p.phase === "verify");
      assert.equal(
        verify.testResult.command,
        "npm test",
        "the executed command must be the one on the base commit"
      );
    } finally {
      cleanup(dir);
    }
  });

  it("expands verify.profile from the base commit, not the working tree", async () => {
    const dir = fixture();
    try {
      // `standard` is committed. An uncommitted `minimal` would drop the
      // anti-tamper stage, which is how the trial's profile edit paid off.
      setConfig(dir, "profile", "minimal");
      const policy = await resolveTrustedPolicy({ root: dir, base: "HEAD", config: { verify: {} } });
      assert.equal(policy.profile, "standard", "the profile must come from the base commit");
    } finally {
      cleanup(dir);
    }
  });

  it("resolves every field the gate obeys from the base commit", async () => {
    // Constraint 1, stated as a loop rather than as a paragraph. Each field
    // is written hostile into the working tree while the base keeps the
    // scaffolded value; none of the hostile values may reach the resolver.
    for (const field of TRUSTED_FIELDS) {
      const dir = fixture();
      try {
        const p = join(dir, ".agent", "config.yml");
        appendFileSync(p, "\n" + field.yaml(field.hostile));

        const policy = await resolveTrustedPolicy({ root: dir, base: "HEAD", config: { verify: {} } });
        const resolved = field.read(policy);
        const hostile = field.hostile;

        if (Array.isArray(resolved)) {
          // The path lists: built-ins must survive, so an emptied list on disk
          // cannot produce an empty resolved list.
          assert.ok(resolved.length > 0, `${field.path}: an emptied list must not empty the trusted one (${field.why})`);
        } else {
          assert.notEqual(
            String(resolved),
            hostile,
            `${field.path} was read from the working tree — ${field.why}`
          );
        }
      } finally {
        cleanup(dir);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// F08 — the trusted base
// ---------------------------------------------------------------------------

describe("F08: a change cannot select the commit that judges it", () => {
  it("refuses committed mode when base_branch resolves to HEAD", async () => {
    const dir = fixture();
    try {
      breakProduction(dir);
      setConfig(dir, "test", 'node -e "process.exit(0)"');
      setTopLevel(dir, "base_branch", "HEAD");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "agent: modify code and gate configuration"]);

      const res = await gate({ root: dir, base: "HEAD", mode: "committed" });

      assert.equal(res.ok, false, "v0.71.0 approved this against its own new commit");
      assert.equal(res.code, 3);
      const phase = res.phases.find((p) => p.phase === "trusted_base");
      assert.ok(phase, "the refusal belongs to its own phase, before anything is read from the base");
      assert.match(phase.error, /the very commit under review/);
    } finally {
      cleanup(dir);
    }
  });

  it("still accepts committed mode against a genuine earlier base", async () => {
    const dir = fixture();
    try {
      const base = git(dir, ["rev-parse", "HEAD"]).trim();
      writeFileSync(join(dir, "calc.js"), "export function add(a, b) { return a + b; }\n// a comment\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "honest: add a comment"]);

      const res = await gate({ root: dir, base, mode: "committed" });
      assert.equal(res.ok, true, "an honest committed change against a real base must still pass");
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// F09 — commands that cannot fail
// ---------------------------------------------------------------------------

describe("F09: a command that cannot fail is not verification", () => {
  it("refuses every recognised incapable oracle", () => {
    for (const c of INCAPABLE_ORACLES) {
      assert.equal(isPlaceholderTestScript(c.command), true, `${c.id}: ${c.why}`);
    }
  });

  it("accepts every real runner, including the ones one token away", () => {
    for (const c of CAPABLE_ORACLES) {
      assert.equal(isPlaceholderTestScript(c.command), false, `${c.id} must not be refused`);
    }
  });

  it("names why a command was refused, rather than only that it was", () => {
    assert.match(describeIncapableTestCommand('node -e "process.exit(0)"'), /cannot fail/);
    assert.match(describeIncapableTestCommand("python3 -m pytest --collect-only"), /without executing/);
    assert.match(describeIncapableTestCommand('go test -run "^$" ./...'), /selection is empty/);
    assert.equal(describeIncapableTestCommand("npm test"), null);
  });

  it("rejects a gate run whose configured command is a no-op, with the reason", async () => {
    const dir = fixture();
    try {
      // Committed, so this is the trusted policy — no scaffold exception, no
      // scope violation. The command itself is the finding.
      setConfig(dir, "test", "sh -c :");
      git(dir, ["add", ".agent/config.yml"]);
      git(dir, ["commit", "-qm", "trial: authorized baseline policy"]);
      breakProduction(dir);

      const res = await gate({ root: dir, base: "HEAD", mode: "working-tree" });

      assert.equal(res.ok, false, "v0.71.0 approved this with an advisory");
      const verify = res.phases.find((p) => p.phase === "verify");
      assert.equal(verify.failure.stageId, "placeholder-oracle");
      assert.match(verify.failure.stderr, /cannot fail/);
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// F10 — the verified revision
// ---------------------------------------------------------------------------

describe("F10: the revision that is judged is the revision that is executed", () => {
  it("tests the staged snapshot, not the restored working copy", async () => {
    const dir = fixture();
    try {
      breakProduction(dir);
      git(dir, ["add", "calc.js"]);
      healProduction(dir);

      // The trap: the working tree is healthy and its suite passes.
      assert.equal(runSuite(dir).status, 0, "control: the working copy must pass, or the fixture proves nothing");

      const res = await gate({ root: dir, base: "HEAD", mode: "staged" });

      assert.equal(res.ok, false, "v0.71.0 approved the broken staged diff by running the healthy working file");
      assert.equal(res.code, 4);
      const verify = res.phases.find((p) => p.phase === "verify");
      assert.match(verify.verifiedRevision, /staged snapshot/);
    } finally {
      cleanup(dir);
    }
  });

  it("tests the committed snapshot, not the restored working copy", async () => {
    const dir = fixture();
    try {
      const base = git(dir, ["rev-parse", "HEAD"]).trim();
      breakProduction(dir);
      git(dir, ["add", "calc.js"]);
      git(dir, ["commit", "-qm", "agent: broken production change"]);
      healProduction(dir);

      const res = await gate({ root: dir, base, mode: "committed" });

      assert.equal(res.ok, false, "v0.71.0 approved the broken commit by running the healthy working file");
      const verify = res.phases.find((p) => p.phase === "verify");
      assert.match(verify.verifiedRevision, /^commit /);
    } finally {
      cleanup(dir);
    }
  });

  it("runs working-tree mode in the root, because there the root is the revision", async () => {
    const dir = fixture();
    try {
      const res = await gate({ root: dir, base: "HEAD", mode: "working-tree" });
      const verify = res.phases.find((p) => p.phase === "verify");
      assert.match(verify.verifiedRevision, /working tree/);
    } finally {
      cleanup(dir);
    }
  });

  it("materialises only the modes that need it", () => {
    const dir = fixture();
    try {
      for (const c of VERIFIED_REVISIONS) {
        const snap = materialiseRevision({
          root: dir,
          mode: c.mode,
          commit: c.mode === "committed" ? git(dir, ["rev-parse", "HEAD"]).trim() : null,
        });
        try {
          assert.equal(snap.ok, true, `${c.mode}: ${snap.error}`);
          assert.equal(Boolean(snap.dir), c.materialised, `${c.mode}: ${c.why}`);
          if (snap.dir) {
            assert.ok(existsSync(join(snap.dir, "calc.js")), `${c.mode}: the snapshot must contain the source`);
          }
        } finally {
          snap.cleanup();
        }
      }
    } finally {
      cleanup(dir);
    }
  });

  it("refuses rather than falling back to the working tree when the snapshot fails", async () => {
    // The whole point of constraint 2: an unattestable revision is not an
    // approved one. Simulated by asking for a commit that does not exist.
    const dir = fixture();
    try {
      const snap = materialiseRevision({ root: dir, mode: "committed", commit: "0".repeat(40) });
      assert.equal(snap.ok, false);
      assert.equal(snap.dir, null, "no half-materialised directory may be left behind or used");
      assert.match(snap.error, /could not materialise/);
    } finally {
      cleanup(dir);
    }
  });

  it("links dependency directories in, so an honest suite is not failed for a missing toolchain", () => {
    // The regression this fix could plausibly have caused. A staged run whose
    // suite needs `node_modules` must still find it.
    const dir = fixture();
    try {
      mkdirSync(join(dir, "node_modules", "left-pad"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
      appendFileSync(join(dir, ".gitignore"), "node_modules/\n");

      const snap = materialiseRevision({ root: dir, mode: "staged" });
      try {
        assert.equal(snap.ok, true);
        assert.ok(
          existsSync(join(snap.dir, "node_modules", "left-pad", "index.js")),
          "installed dependencies must be reachable from the snapshot"
        );
        assert.ok(snap.linked.includes("node_modules"));
      } finally {
        snap.cleanup();
      }
    } finally {
      cleanup(dir);
    }
  });

  it("does not link a directory the repository actually tracks", () => {
    // `vendor/` is committed in plenty of Go repositories. Linking the working
    // tree's copy over the snapshot's would reintroduce F10 by the back door.
    const dir = fixture();
    try {
      mkdirSync(join(dir, "vendor"), { recursive: true });
      writeFileSync(join(dir, "vendor", "marker.txt"), "committed\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "vendor the dependency"]);
      writeFileSync(join(dir, "vendor", "marker.txt"), "working tree only\n");

      const snap = materialiseRevision({ root: dir, mode: "staged" });
      try {
        assert.ok(!snap.linked.includes("vendor"), "a tracked directory must come from the snapshot");
        assert.equal(readFileSync(join(snap.dir, "vendor", "marker.txt"), "utf-8"), "committed\n");
      } finally {
        snap.cleanup();
      }
    } finally {
      cleanup(dir);
    }
  });

  it("leaves no snapshot behind after a gate run", async () => {
    const dir = fixture();
    let seen = null;
    try {
      breakProduction(dir);
      git(dir, ["add", "calc.js"]);
      const res = await gate({ root: dir, base: "HEAD", mode: "staged" });
      seen = res.phases.find((p) => p.phase === "verify")?.verifiedRevision;
      assert.ok(seen);
      // The directory name is not exported, so assert on the tmpdir contents:
      // no agentctl snapshot may survive the call.
      const { readdirSync } = await import("node:fs");
      const leftovers = readdirSync(tmpdir()).filter((n) => n.startsWith("agentctl-snapshot-"));
      assert.equal(leftovers.length, 0, `snapshots leaked: ${leftovers.join(", ")}`);
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// F11 — which copy of the package
// ---------------------------------------------------------------------------

describe("F11: a passing suite must be about the code in the diff", () => {
  it("says nothing when it cannot establish a binding", () => {
    const dir = fixture();
    try {
      for (const c of SOURCE_BINDING_CASES.filter((x) => x.install === "none" || x.command === "npm test")) {
        const res = checkSourceBinding({ cwd: dir, command: c.command, files: ["src/pkg/__init__.py"] });
        assert.equal(res.ok, true, `${c.id}: ${c.why}`);
      }
    } finally {
      cleanup(dir);
    }
  });

  it("reports the mismatch when the edited package resolves outside the audited tree", () => {
    // Constructed rather than pip-installed: the probe's question is only
    // "where did `find_spec` resolve this to", and a directory on PYTHONPATH
    // that shadows `src/` reproduces exactly the site-packages shape without
    // needing a virtualenv in the test suite.
    const dir = mkdtempSync(join(tmpdir(), "jok-binding-"));
    try {
      mkdirSync(join(dir, "src", "pkg"), { recursive: true });
      writeFileSync(join(dir, "src", "pkg", "__init__.py"), "def add(a, b):\n    return a - b\n");

      const installed = join(dir, "site-packages");
      mkdirSync(join(installed, "pkg"), { recursive: true });
      writeFileSync(join(installed, "pkg", "__init__.py"), "def add(a, b):\n    return a + b\n");

      const probe = spawnSync("python3", ["-c", "print(1)"], { encoding: "utf-8" });
      if (probe.status !== 0) return; // no interpreter on this machine

      const unbound = checkSourceBinding({
        cwd: dir,
        command: "python3 -m pytest",
        files: ["src/pkg/__init__.py"],
        env: { ...process.env, PYTHONPATH: installed },
      });
      assert.equal(unbound.ok, false, "v0.71.0 approved this: the suite tested the installed copy");
      assert.match(unbound.reason, /outside the code under review/);
      assert.match(unbound.reason, /PYTHONPATH=src/, "must say how to bind it");
      assert.equal(unbound.detail.mismatches[0].package, "pkg");

      // And the fix the message recommends must actually satisfy the rule.
      const bound = checkSourceBinding({
        cwd: dir,
        command: "PYTHONPATH=src python3 -m pytest",
        files: ["src/pkg/__init__.py"],
        env: { ...process.env, PYTHONPATH: installed },
      });
      assert.equal(bound.ok, true, "the remedy the gate prints must work");
    } finally {
      cleanup(dir);
    }
  });

  it("says nothing about a package the diff does not edit", () => {
    const dir = mkdtempSync(join(tmpdir(), "jok-binding-"));
    try {
      mkdirSync(join(dir, "src", "pkg"), { recursive: true });
      writeFileSync(join(dir, "src", "pkg", "__init__.py"), "x = 1\n");
      const installed = join(dir, "site-packages");
      mkdirSync(join(installed, "pkg"), { recursive: true });
      writeFileSync(join(installed, "pkg", "__init__.py"), "x = 2\n");

      const res = checkSourceBinding({
        cwd: dir,
        command: "python3 -m pytest",
        files: ["README.md"],
        env: { ...process.env, PYTHONPATH: installed },
      });
      assert.equal(res.ok, true, "a binding problem in an untouched package is not this change's finding");
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: the resolver is the only reader
// ---------------------------------------------------------------------------

describe("constraint 1: one resolver, and every consumer calls it", () => {
  it("reports base as the source when the base commit has a config", async () => {
    const dir = fixture();
    try {
      const policy = await resolveTrustedPolicy({ root: dir, base: "HEAD", config: { verify: {} } });
      assert.equal(policy.source, "base");
      assert.equal(policy.trusted, true);
      assert.equal(policy.verify.test, "npm test");
    } finally {
      cleanup(dir);
    }
  });

  it("falls back to built-ins only, never to the working tree, when the base has none", async () => {
    const dir = fixture({ committed: false });
    try {
      setConfig(dir, "test", "true");
      const policy = await resolveTrustedPolicy({ root: dir, base: "master", config: { verify: {} } });
      assert.equal(policy.trusted, false);
      assert.notEqual(policy.verify.test, "true", "the untrusted command must not be adopted");
      assert.ok(policy.scope.deny.length > 0, "built-in deny rules always apply");
      assert.ok(policy.scope.protect.length > 0, "built-in protect rules always apply");
    } finally {
      cleanup(dir);
    }
  });

  it("compares only fields the gate obeys, so a comment change is not a policy change", () => {
    const a = { verify: { test: "npm test", profile: "standard" } };
    const b = { verify: { test: "npm test", profile: "standard" } };
    assert.deepEqual(diffObeyedFields(a, b), []);
    assert.equal(diffObeyedFields(a, { verify: { test: "true", profile: "standard" } }).length, 1);
  });
});
