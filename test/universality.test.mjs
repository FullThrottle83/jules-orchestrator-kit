import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PROVIDER_DESCRIPTORS,
  PROVIDER_PREFERENCE,
  whichBinary,
  probeProvider,
  detectAvailableProviders,
  suggestProvider,
} from "../src/provider-readiness.mjs";
import { ENV_ALIASES, applyEnvAliases, describeEnvVar } from "../src/env-aliases.mjs";
import { PROFILE_NAMES, buildProfileStages, buildDefaultStages, describeProfilePlan } from "../src/profiles.mjs";
import { setVerificationProfile } from "../src/config-edit.mjs";
import { buildCiWorkflow, writeCiWorkflow, CI_TARGETS } from "../src/ci-templates.mjs";
import { loadConfig, BUILTIN_DENY } from "../src/config.mjs";
import { checkScope, isEnvTemplateException } from "../src/security.mjs";

const IS_WIN = process.platform === "win32";

/** A PATH containing exactly one fake executable, so probes are deterministic. */
function pathWith(binName) {
  const dir = mkdtempSync(join(tmpdir(), "jok-bin-"));
  const file = join(dir, IS_WIN ? `${binName}.CMD` : binName);
  writeFileSync(file, IS_WIN ? "@echo off\r\n" : "#!/bin/sh\n", { mode: 0o755 });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("provider readiness is a property of the selected provider", () => {
  it("resolves an executable through PATH, honouring PATHEXT on Windows", () => {
    const { dir, cleanup } = pathWith("madeupagent");
    try {
      const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
      assert.ok(whichBinary("madeupagent", env), "the planted binary is found");
      assert.equal(whichBinary("definitely-not-here", env), null);
    } finally {
      cleanup();
    }
  });

  it("never throws on an unreadable or empty PATH", () => {
    assert.equal(whichBinary("claude", {}), null);
    assert.equal(whichBinary("", { PATH: "/nope" }), null);
    assert.equal(whichBinary(null, { PATH: "/nope" }), null);
  });

  it("gates the hosted provider on a credential, not a binary", () => {
    const withKey = probeProvider("jules", { env: { JULES_API_KEY: "k" } });
    assert.equal(withKey.ready, true);
    assert.equal(withKey.keySource, "JULES_API_KEY");

    const without = probeProvider("jules", { env: {} });
    assert.equal(without.ready, false);
    assert.match(without.remedy, /JULES_API_KEY/);
  });

  it("gates a local CLI provider on the binary, and never asks it for an API key", () => {
    const { dir, cleanup } = pathWith("claude");
    try {
      const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
      const probe = probeProvider("claude-code", { env });
      assert.equal(probe.ready, true, "a CLI on PATH is ready with no key at all");
      assert.equal(probe.keySource, null);
      assert.equal(probe.kind, "exec");

      const missing = probeProvider("claude-code", { env: { PATH: "" } });
      assert.equal(missing.ready, false);
      assert.doesNotMatch(missing.remedy, /API_KEY/, "a missing binary is not fixed by exporting a key");
    } finally {
      cleanup();
    }
  });

  it("reports an unknown provider without pretending to have checked it", () => {
    const probe = probeProvider("some-inhouse-agent", { env: {} });
    assert.equal(probe.known, false);
    assert.equal(probe.ready, false);
    assert.match(probe.reason, /not a built-in provider preset/);
  });

  it("orders detection ready-first, and falls back to the hosted default offline", () => {
    const { dir, cleanup } = pathWith("codex");
    try {
      const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
      const found = detectAvailableProviders({ env });
      assert.equal(found[0].name, "codex");
      assert.equal(suggestProvider({ env }), "codex");

      assert.equal(suggestProvider({ env: { PATH: "" } }), "jules");
    } finally {
      cleanup();
    }
  });

  it("keeps every preference entry describable", () => {
    for (const name of PROVIDER_PREFERENCE) {
      assert.ok(PROVIDER_DESCRIPTORS[name], `${name} has a descriptor`);
      assert.equal(probeProvider(name, { env: {} }).known, true);
    }
  });
});

describe("vendor-neutral environment spellings", () => {
  it("fills the legacy name from the AGENT_* alias", () => {
    const env = { AGENT_API_KEY: "abc", AGENT_SWARM_CONCURRENCY: "4" };
    const applied = applyEnvAliases(env);
    assert.equal(env.JULES_API_KEY, "abc");
    assert.equal(env.JULES_SWARM_CONCURRENCY, "4");
    assert.ok(applied.includes("JULES_API_KEY"));
  });

  it("never overwrites a value already set under the legacy name", () => {
    const env = { AGENT_API_KEY: "new", JULES_API_KEY: "existing" };
    applyEnvAliases(env);
    assert.equal(env.JULES_API_KEY, "existing", "an established setup cannot be changed by adding an alias");
  });

  it("treats a blank alias as unset", () => {
    const env = { AGENT_REPO: "   " };
    applyEnvAliases(env);
    assert.equal(env.JULES_REPO, undefined);
  });

  it("maps every alias to a JULES_-prefixed canonical name", () => {
    for (const [alias, canonical] of Object.entries(ENV_ALIASES)) {
      assert.match(alias, /^AGENT_/);
      assert.match(canonical, /^JULES_/);
      assert.equal(describeEnvVar(canonical).alias, alias);
    }
  });
});

describe("verification profiles", () => {
  it("always emits the whole pipeline, because stages replace it wholesale", () => {
    const plan = buildProfileStages("max", {
      stack: "node",
      verify: { setup: "npm ci", lint: "npm run lint", test: "npm test", build: "npm run build" },
    });
    const ids = plan.stages.map((s) => s.id);
    assert.deepEqual(ids.slice(0, 5), ["setup", "lint", "unit", "build", "anti-tamper"]);
    assert.ok(ids.includes("mutation"));
    assert.ok(ids.includes("stability"));
  });

  it("only asks for V8 diff coverage where the test command produces it", () => {
    const node = buildProfileStages("max", { stack: "node", verify: { test: "npm test" } });
    assert.ok(node.stages.some((s) => s.assert === "diff-coverage"));

    for (const stack of ["cargo", "python", "go", "deno", "bun"]) {
      const other = buildProfileStages("max", { stack, verify: { test: "x" } });
      assert.equal(
        other.stages.some((s) => s.assert === "diff-coverage"),
        false,
        `${stack} cannot emit NODE_V8_COVERAGE, so the gate must not demand it`
      );
      assert.ok(other.skipped.some((s) => s.id === "diff-coverage"), "and must say why it was skipped");
    }
  });

  it("runs tests only at the minimal end", () => {
    const plan = buildProfileStages("minimal", {
      stack: "node",
      verify: { setup: "npm ci", lint: "npm run lint", test: "npm test", build: "npm run build" },
    });
    assert.deepEqual(plan.stages.map((s) => s.id), ["setup", "unit"]);
  });

  it("reports a missing test command instead of emitting an empty gate", () => {
    const plan = buildProfileStages("standard", { stack: "unknown", verify: {} });
    assert.equal(plan.stages.some((s) => s.id === "unit"), false);
    assert.ok(plan.skipped.some((s) => s.id === "unit"));
  });

  it("falls back to the everyday profile for an unknown name", () => {
    assert.equal(buildProfileStages("paranoid", { stack: "node", verify: { test: "t" } }).profile, "standard");
    for (const n of PROFILE_NAMES) assert.equal(buildProfileStages(n, { stack: "node", verify: { test: "t" } }).profile, n);
  });

  it("describes the default pipeline the gate runs when no profile is set", () => {
    const stages = buildDefaultStages({ setup: "s", lint: "l", test: "t", build: "b" });
    assert.deepEqual(stages.map((x) => x.id), ["setup", "lint", "unit", "build"]);
    assert.equal(describeProfilePlan({ stages }), "setup → lint → unit → build");
  });
});

describe("profile persistence", () => {
  function repo(yaml) {
    const dir = mkdtempSync(join(tmpdir(), "jok-profile-"));
    mkdirSync(join(dir, ".agent"), { recursive: true });
    writeFileSync(join(dir, ".agent", "config.yml"), yaml);
    return dir;
  }

  it("replaces an existing profile key without disturbing the rest of the file", () => {
    const dir = repo("# a comment\nversion: 1\nverify:\n  profile: standard\n  test: \"npm test\"\n");
    try {
      const res = setVerificationProfile(dir, "max");
      assert.equal(res.ok, true);
      const out = readFileSync(join(dir, ".agent", "config.yml"), "utf-8");
      assert.match(out, /profile: max/);
      assert.match(out, /# a comment/, "comments survive — this is a file a human maintains");
      assert.match(out, /test: "npm test"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("inserts the key into an existing verify block that lacks it", () => {
    const dir = repo("version: 1\nverify:\n  test: \"pytest\"\n");
    try {
      assert.equal(setVerificationProfile(dir, "minimal").ok, true);
      assert.equal(loadConfig(dir).verify.profile, "minimal");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends a verify block when there is none", () => {
    const dir = repo("version: 1\nprovider: codex\n");
    try {
      assert.equal(setVerificationProfile(dir, "max").ok, true);
      const cfg = loadConfig(dir);
      assert.equal(cfg.verify.profile, "max");
      assert.equal(cfg.provider, "codex");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an unknown profile and a repo with no manifest", () => {
    const dir = repo("version: 1\n");
    try {
      assert.equal(setVerificationProfile(dir, "turbo").ok, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const bare = mkdtempSync(join(tmpdir(), "jok-noconfig-"));
    try {
      const res = setVerificationProfile(bare, "max");
      assert.equal(res.ok, false);
      assert.match(res.error, /agentctl init/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("config expands a profile into stages at load time", () => {
  it("turns one word into the full gate, stack-aware", () => {
    const dir = mkdtempSync(join(tmpdir(), "jok-cfgprofile-"));
    try {
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = \"x\"\n");
      writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\nverify:\n  profile: max\n  test: \"cargo test\"\n");

      const cfg = loadConfig(dir);
      assert.equal(cfg.verify.profile, "max");
      const ids = cfg.verify.stages.map((s) => s.id);
      assert.ok(ids.includes("unit"));
      assert.ok(ids.includes("mutation"));
      assert.equal(ids.includes("diff-coverage"), false, "a Cargo repo is not asked for V8 coverage");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets hand-written stages win over a profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "jok-cfgstages-"));
    try {
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(
        join(dir, ".agent", "config.yml"),
        "version: 1\nverify:\n  profile: max\n  stages:\n    - id: only\n      kind: test\n      cmd: \"make check\"\n"
      );
      const cfg = loadConfig(dir);
      assert.equal(cfg.verify.stages.length, 1);
      assert.equal(cfg.verify.stages[0].cmd, "make check");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the built-in pipeline alone when no profile is named", () => {
    const dir = mkdtempSync(join(tmpdir(), "jok-cfgnoprofile-"));
    try {
      mkdirSync(join(dir, ".agent"), { recursive: true });
      writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\nverify:\n  test: \"npm test\"\n");
      const cfg = loadConfig(dir);
      assert.equal(cfg.verify.profile, null);
      assert.equal(cfg.verify.stages, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("generated CI belongs to the repository it is generated for", () => {
  it("installs the project's own toolchain, not just Node", () => {
    const py = buildCiWorkflow({ target: "github", stack: { stack: "python" }, config: { baseBranch: "main" } });
    assert.match(py.content, /actions\/setup-python/);
    assert.match(py.content, /actions\/setup-node/, "agentctl is a Node CLI regardless of the project");

    const go = buildCiWorkflow({ target: "github", stack: { stack: "go" } });
    assert.match(go.content, /actions\/setup-go/);

    const rust = buildCiWorkflow({ target: "github", stack: { stack: "cargo" } });
    assert.doesNotMatch(rust.content, /setup-python|setup-go|setup-java/);
  });

  it("never emits this kit's own private script paths", () => {
    for (const stack of ["python", "cargo", "go", "node", "dotnet"]) {
      const wf = buildCiWorkflow({ target: "github", stack: { stack } });
      assert.doesNotMatch(wf.content, /jules-self-audit|lock-manager/);
      assert.match(wf.content, /agentctl|jules-orchestrator-kit/);
    }
  });

  it("targets the repository's own base branch", () => {
    const wf = buildCiWorkflow({ target: "github", stack: { stack: "node" }, config: { baseBranch: "develop" } });
    assert.match(wf.content, /branches: \[ develop \]/);
    assert.match(wf.content, /origin\/develop/);
  });

  it("emits a GitLab job on a stack-appropriate image", () => {
    const gl = buildCiWorkflow({ target: "gitlab", stack: { stack: "cargo" } });
    assert.equal(gl.file, ".gitlab-ci.agent-gate.yml");
    assert.match(gl.content, /image: rust:latest/);
    assert.match(gl.content, /command -v node/, "a non-Node image still has to obtain the Node CLI");
  });

  it("does not clobber an existing workflow unless forced", () => {
    const dir = mkdtempSync(join(tmpdir(), "jok-ci-"));
    try {
      const first = writeCiWorkflow(dir, { target: "github", stack: { stack: "node" } });
      assert.equal(first.written, true);

      writeFileSync(join(dir, first.file), "# hand-edited\n");
      const second = writeCiWorkflow(dir, { target: "github", stack: { stack: "node" } });
      assert.equal(second.written, false);
      assert.equal(readFileSync(join(dir, first.file), "utf-8"), "# hand-edited\n");

      const forced = writeCiWorkflow(dir, { target: "github", stack: { stack: "node" }, force: true });
      assert.equal(forced.written, true);
      assert.match(readFileSync(join(dir, first.file), "utf-8"), /Agent Safety Gate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown CI target instead of silently writing GitHub", () => {
    const res = writeCiWorkflow(mkdtempSync(join(tmpdir(), "jok-ci-bad-")), { target: "jenkins" });
    assert.equal(res.ok, false);
    assert.match(res.error, new RegExp(CI_TARGETS.join("|")));
  });
});

describe("committed environment templates are documentation, not credentials", () => {
  const scope = { deny: [...BUILTIN_DENY], allow: [], protect: [] };

  it("lets an agent edit the file every project uses to document its variables", () => {
    for (const f of [".env.example", ".env.sample", ".env.template", ".env.dist", "apps/web/.env.example", ".env.production.example"]) {
      assert.equal(checkScope([f], scope).ok, true, `${f} must be editable`);
    }
  });

  it("still denies every real environment file", () => {
    for (const f of [".env", ".env.local", ".env.production", "config/.env.staging", "apps/api/.env"]) {
      assert.equal(checkScope([f], scope).ok, false, `${f} must stay denied`);
    }
  });

  it("does not exempt templates from a repository's own broader deny rule", () => {
    const strict = { deny: ["**/.env*"], allow: [], protect: [] };
    assert.equal(checkScope([".env.example"], strict).ok, false);
    assert.equal(isEnvTemplateException(".env.example", "**/.env*"), false);
  });

  it("never exempts a path just because it matched some other rule", () => {
    assert.equal(isEnvTemplateException(".env.example", ".github/**"), false);
    assert.equal(isEnvTemplateException(".env.local", "**/.env.*"), false);
  });
});
