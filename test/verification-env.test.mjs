import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildVerificationEnv, runCmd, NET_GUARD_FLAG } from "../src/git.mjs";
import { gate } from "../src/engine.mjs";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

describe("P0-11: Verification Subprocess Environment Isolation", () => {
  describe("Unit: buildVerificationEnv Construction Logic", () => {
    it("starts from an empty object and omits arbitrary unknown ambient variables", () => {
      const ambient = {
        PATH: "/usr/bin:/bin",
        TOTALLY_UNKNOWN_SECRET_84721: "sentinel_value_123",
        MY_RANDOM_VALUE: "super-secret-sentinel",
        SOME_INTERNAL_FLAG: "do_not_leak",
      };

      const env = buildVerificationEnv({ ambientEnv: ambient, platform: "linux" });

      assert.equal(env.TOTALLY_UNKNOWN_SECRET_84721, undefined);
      assert.equal(env.MY_RANDOM_VALUE, undefined);
      assert.equal(env.SOME_INTERNAL_FLAG, undefined);
      assert.equal(env.PATH, "/usr/bin:/bin");
      assert.equal(env.CI, "true");
    });

    it("omits all known cloud, package, database, and provider secrets by default", () => {
      const ambient = {
        PATH: "/usr/bin",
        JULES_API_KEY: "jules_secret",
        JULES_TOKEN: "jules_token",
        GITHUB_TOKEN: "gh_secret",
        GH_TOKEN: "gh_token",
        NPM_TOKEN: "npm_secret",
        NODE_AUTH_TOKEN: "node_auth_secret",
        AWS_ACCESS_KEY_ID: "akid",
        AWS_SECRET_ACCESS_KEY: "sak",
        AWS_SESSION_TOKEN: "stok",
        CLOUDFLARE_API_TOKEN: "cf_token",
        OPENAI_API_KEY: "oai_key",
        ANTHROPIC_API_KEY: "ant_key",
        GEMINI_API_KEY: "gem_key",
        DATABASE_URL: "postgres://user:pass@localhost:5432/db",
        CUSTOM_PRIVATE_TOKEN: "custom_tok",
        INTERNAL_DEPLOY_SECRET: "internal_sec",
      };

      const env = buildVerificationEnv({ ambientEnv: ambient, platform: "linux" });

      assert.equal(env.JULES_API_KEY, undefined);
      assert.equal(env.JULES_TOKEN, undefined);
      assert.equal(env.GITHUB_TOKEN, undefined);
      assert.equal(env.GH_TOKEN, undefined);
      assert.equal(env.NPM_TOKEN, undefined);
      assert.equal(env.NODE_AUTH_TOKEN, undefined);
      assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
      assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
      assert.equal(env.AWS_SESSION_TOKEN, undefined);
      assert.equal(env.CLOUDFLARE_API_TOKEN, undefined);
      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
      assert.equal(env.GEMINI_API_KEY, undefined);
      assert.equal(env.DATABASE_URL, undefined);
      assert.equal(env.CUSTOM_PRIVATE_TOKEN, undefined);
      assert.equal(env.INTERNAL_DEPLOY_SECRET, undefined);
    });

    it("preserves POSIX baseline execution variables when present in ambient", () => {
      const ambient = {
        PATH: "/usr/local/bin:/usr/bin",
        TMPDIR: "/custom/tmp",
        LANG: "en_US.UTF-8",
        LC_ALL: "C.UTF-8",
        LC_CTYPE: "UTF-8",
        TERM: "xterm-256color",
        NODE_ENV: "production",
      };

      const env = buildVerificationEnv({ ambientEnv: ambient, platform: "linux" });

      assert.equal(env.PATH, "/usr/local/bin:/usr/bin");
      assert.equal(env.TMPDIR, "/custom/tmp");
      assert.equal(env.LANG, "en_US.UTF-8");
      assert.equal(env.LC_ALL, "C.UTF-8");
      assert.equal(env.LC_CTYPE, "UTF-8");
      assert.equal(env.TERM, "xterm-256color");
      assert.equal(env.CI, "true");
      assert.equal(env.NODE_ENV, "production");
    });

    it("falls back to safe defaults on POSIX when PATH or TMPDIR are missing in ambient", () => {
      const env = buildVerificationEnv({ ambientEnv: {}, platform: "linux" });

      assert.equal(env.PATH, "/usr/local/bin:/usr/bin:/bin");
      assert.equal(env.TMPDIR, "/tmp");
      assert.equal(env.CI, "true");
    });

    it("handles Windows baseline variables and normalizes case-insensitivity without duplicate keys", () => {
      const ambient = {
        Path: "C:\\Node;C:\\Windows\\system32",
        systemroot: "C:\\WindowsCustom",
        comspec: "C:\\WindowsCustom\\system32\\cmd.exe",
        pathext: ".EXE;.CMD;.BAT",
        windir: "C:\\WindowsCustom",
        systemdrive: "D:",
        temp: "C:\\Temp",
        tmp: "C:\\Tmp",
        MY_SECRET: "secret",
      };

      const env = buildVerificationEnv({ ambientEnv: ambient, platform: "win32" });

      assert.equal(env.PATH, "C:\\Node;C:\\Windows\\system32");
      assert.equal(env.SystemRoot, "C:\\WindowsCustom");
      assert.equal(env.ComSpec, "C:\\WindowsCustom\\system32\\cmd.exe");
      assert.equal(env.PATHEXT, ".EXE;.CMD;.BAT");
      assert.equal(env.WINDIR, "C:\\WindowsCustom");
      assert.equal(env.SystemDrive, "D:");
      assert.equal(env.TEMP, "C:\\Temp");
      assert.equal(env.TMP, "C:\\Tmp");
      assert.equal(env.CI, "true");

      assert.equal(env.Path, undefined);
      assert.equal(env.systemroot, undefined);
      assert.equal(env.comspec, undefined);
      assert.equal(env.MY_SECRET, undefined);
    });

    it("falls back to Windows execution defaults when optional Windows primitives are missing", () => {
      const env = buildVerificationEnv({ ambientEnv: {}, platform: "win32" });

      assert.equal(env.PATH, "");
      assert.equal(env.SystemRoot, "C:\\Windows");
      assert.equal(env.ComSpec, "C:\\Windows\\system32\\cmd.exe");
      assert.equal(env.PATHEXT, ".COM;.EXE;.BAT;.CMD");
      assert.equal(env.SystemDrive, "C:");
      assert.equal(env.CI, "true");
    });

    it("does not inherit HOME or USERPROFILE by default (operator credential isolation)", () => {
      const ambient = {
        PATH: "/bin",
        HOME: "/home/operator",
        USERPROFILE: "C:\\Users\\operator",
      };

      const posixEnv = buildVerificationEnv({ ambientEnv: ambient, platform: "linux" });
      assert.equal(posixEnv.HOME, undefined);
      assert.equal(posixEnv.USERPROFILE, undefined);

      const winEnv = buildVerificationEnv({ ambientEnv: ambient, platform: "win32" });
      assert.equal(winEnv.HOME, undefined);
      assert.equal(winEnv.USERPROFILE, undefined);
    });

    it("supports explicit isolated home when opts.home is provided", () => {
      const isolatedHome = "/tmp/jules-isolated-home";
      const env = buildVerificationEnv({ home: isolatedHome, platform: "linux" });
      assert.equal(env.HOME, isolatedHome);

      const winEnv = buildVerificationEnv({ home: "C:\\Temp\\jules-home", platform: "win32" });
      assert.equal(winEnv.HOME, "C:\\Temp\\jules-home");
      assert.equal(winEnv.USERPROFILE, "C:\\Temp\\jules-home");
    });

    it("injects NET_GUARD_FLAG into NODE_OPTIONS when netGuard: true without inheriting ambient NODE_OPTIONS", () => {
      const ambient = {
        PATH: "/bin",
        NODE_OPTIONS: "--require /malicious/exfil.js --max-old-space-size=4096",
      };

      const env = buildVerificationEnv({ ambientEnv: ambient, netGuard: true, platform: "linux" });
      assert.equal(env.NODE_OPTIONS, NET_GUARD_FLAG);
      assert.ok(!env.NODE_OPTIONS.includes("/malicious/exfil.js"));
    });

    it("strips test runner context and ambient gate waiver variables unconditionally", () => {
      const ambient = {
        PATH: "/bin",
        NODE_TEST_CONTEXT: "child-test-context-123",
        NODE_CHANNEL_FD: "4",
        PR_LABELS: '["allow-p:xxx"]',
        HEAD_SHA: "1111111111111111111111111111111111111111",
        BASE_SHA: "2222222222222222222222222222222222222222",
        JULES_BASE_SHA: "2222222222222222222222222222222222222222",
        JULES_ALLOW_COMMAND_FILE_CHANGES: "true",
        AGENT_ALLOW_COMMAND_FILE_CHANGES: "1",
      };

      const extraEnv = {
        EXTRA_SAFE_VAR: "ok",
        NODE_TEST_CONTEXT: "accidental-extra",
        JULES_ALLOW_CUSTOM: "accidental-waiver",
      };

      const env = buildVerificationEnv({ ambientEnv: ambient, extraEnv, platform: "linux" });

      assert.equal(env.EXTRA_SAFE_VAR, "ok");
      assert.equal(env.NODE_TEST_CONTEXT, undefined);
      assert.equal(env.NODE_CHANNEL_FD, undefined);
      assert.equal(env.PR_LABELS, undefined);
      assert.equal(env.HEAD_SHA, undefined);
      assert.equal(env.BASE_SHA, undefined);
      assert.equal(env.JULES_BASE_SHA, undefined);
      assert.equal(env.JULES_ALLOW_COMMAND_FILE_CHANGES, undefined);
      assert.equal(env.AGENT_ALLOW_COMMAND_FILE_CHANGES, undefined);
      assert.equal(env.JULES_ALLOW_CUSTOM, undefined);
    });
  });

  describe("Integration: Subprocess Execution & Adversarial Reproductions", () => {
    it("Reproduction A: arbitrary ambient secret is undefined in verification child", () => {
      const secretKey = "TOTALLY_UNKNOWN_SECRET_84721";
      const sentinel = "sentinel-leak-check-48921";
      process.env[secretKey] = sentinel;

      try {
        const vEnv = buildVerificationEnv();
        const code = `console.log(typeof process.env.${secretKey} === "undefined" ? "ABSENT" : "LEAKED:" + process.env.${secretKey})`;
        const res = runCmd([process.execPath, "-e", code], { env: vEnv });

        assert.equal(res.status, 0);
        assert.equal(res.stdout.trim(), "ABSENT");
      } finally {
        delete process.env[secretKey];
      }
    });

    it("Reproduction B: common cloud/package credentials are absent in verification child", () => {
      const fakeSecrets = {
        AWS_SECRET_ACCESS_KEY: "fake-aws-key",
        CLOUDFLARE_API_TOKEN: "fake-cf-token",
        NPM_TOKEN: "fake-npm-token",
        DATABASE_URL: "postgres://secret:pw@db/prod",
        MY_RANDOM_VALUE: "super-secret-sentinel",
      };

      for (const [k, v] of Object.entries(fakeSecrets)) {
        process.env[k] = v;
      }

      try {
        const vEnv = buildVerificationEnv();
        const code = `
          const checked = ${JSON.stringify(Object.keys(fakeSecrets))};
          const found = checked.filter(k => typeof process.env[k] !== "undefined");
          console.log(found.length === 0 ? "ALL_ABSENT" : "LEAKED:" + found.join(","));
        `;
        const res = runCmd([process.execPath, "-e", code], { env: vEnv });

        assert.equal(res.status, 0);
        assert.equal(res.stdout.trim(), "ALL_ABSENT");
      } finally {
        for (const k of Object.keys(fakeSecrets)) {
          delete process.env[k];
        }
      }
    });

    it("Reproduction C: nested child and grandchild cannot recover parent secret", () => {
      const secretKey = "SENTINEL_NESTED_SECRET_999";
      process.env[secretKey] = "nested-sentinel-value";

      try {
        const vEnv = buildVerificationEnv();
        const grandchildCode = `process.stdout.write(typeof process.env.${secretKey} === "undefined" ? "GRANDCHILD_CLEAN" : "GRANDCHILD_LEAK")`;
        const childCode = `
          const cp = require("node:child_process");
          const res = cp.spawnSync(process.execPath, ["-e", ${JSON.stringify(grandchildCode)}]);
          const childSeen = typeof process.env.${secretKey} === "undefined" ? "CHILD_CLEAN" : "CHILD_LEAK";
          console.log(childSeen + " + " + res.stdout.toString().trim());
        `;

        const res = runCmd([process.execPath, "-e", childCode], { env: vEnv });
        assert.equal(res.status, 0);
        assert.equal(res.stdout.trim(), "CHILD_CLEAN + GRANDCHILD_CLEAN");
      } finally {
        delete process.env[secretKey];
      }
    });

    it("Reproduction D: normal node test execution succeeds under isolated environment", () => {
      const vEnv = buildVerificationEnv();
      const tmp = mkdtempSync(join(tmpdir(), "jules-node-test-"));
      try {
        const testFile = join(tmp, "sample.test.js");
        const code = `
          const test = require("node:test");
          const assert = require("node:assert");
          test("normal isolated test", () => {
            assert.equal(1 + 1, 2);
          });
        `;
        writeFileSync(testFile, code, "utf-8");
        const res = runCmd([process.execPath, "--test", testFile], { env: vEnv });
        assert.equal(res.status, 0);
        assert.match(res.stdout, /pass 1/);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("Reproduction E: executable lookup on PATH resolves node successfully", () => {
      const vEnv = buildVerificationEnv();
      const res = runCmd(["node", "-e", "console.log('resolved-from-path')"], { env: vEnv });
      assert.equal(res.status, 0);
      assert.equal(res.stdout.trim(), "resolved-from-path");
    });

    it("Reproduction F: temporary directory creation and write works in child", () => {
      const vEnv = buildVerificationEnv();
      const code = `
        const os = require("node:os");
        const fs = require("node:fs");
        const path = require("node:path");
        const t = fs.mkdtempSync(path.join(os.tmpdir(), "jules-v-test-"));
        fs.writeFileSync(path.join(t, "witness.txt"), "hello", "utf-8");
        const content = fs.readFileSync(path.join(t, "witness.txt"), "utf-8");
        fs.rmSync(t, { recursive: true, force: true });
        console.log(content === "hello" ? "TMP_OK" : "TMP_FAIL");
      `;

      const res = runCmd([process.execPath, "-e", code], { env: vEnv });
      assert.equal(res.status, 0);
      assert.equal(res.stdout.trim(), "TMP_OK");
    });

    it("Repository printing full environment reveals only allowed baseline/JOK keys", () => {
      const canaryKey = "CANARY_SECRET_VARIABLE_EXFIL";
      process.env[canaryKey] = "canary_payload";

      try {
        const vEnv = buildVerificationEnv();
        const code = `
          const keys = Object.keys(process.env).sort();
          console.log(JSON.stringify(keys));
        `;

        const res = runCmd([process.execPath, "-e", code], { env: vEnv });
        assert.equal(res.status, 0);
        const childKeys = JSON.parse(res.stdout);

        assert.ok(!childKeys.includes(canaryKey));
        assert.ok(childKeys.includes("PATH") || childKeys.includes("Path"));
        assert.ok(childKeys.includes("CI"));

        const forbiddenPattern = /TOKEN|SECRET|KEY|PASSWORD|AUTH|CREDENTIAL/i;
        for (const k of childKeys) {
          assert.ok(!forbiddenPattern.test(k), `Subprocess environment contained suspicious key: ${k}`);
        }
      } finally {
        delete process.env[canaryKey];
      }
    });

    it("Failing verification command does not leak parent environment in error diagnostics", () => {
      const sentinel = "SECRET_THAT_MUST_NEVER_APPEAR_IN_DIAGNOSTICS";
      process.env.DIAG_SECRET = sentinel;

      try {
        const vEnv = buildVerificationEnv();
        const res = runCmd([process.execPath, "-e", "console.error('Deliberate fail'); process.exit(42)"], {
          env: vEnv,
          ignoreError: true,
        });

        assert.equal(res.status, 42);
        assert.ok(!res.stderr.includes(sentinel));
        assert.ok(!res.stdout.includes(sentinel));
      } finally {
        delete process.env.DIAG_SECRET;
      }
    });

    it("gate() executes verification suite under isolated environment preventing secret access", async () => {
      const sentinelKey = "LEAK_PROBE_SECRET_9876";
      process.env[sentinelKey] = "probe-secret-value";

      const tmp = mkdtempSync(join(tmpdir(), "gate-env-iso-"));
      try {
        execSync("git init -b main", { cwd: tmp, stdio: "ignore" });
        execSync("git config user.name 'Test'", { cwd: tmp, stdio: "ignore" });
        execSync("git config user.email 'test@test.com'", { cwd: tmp, stdio: "ignore" });
        execSync("git commit --allow-empty -m 'initial'", { cwd: tmp, stdio: "ignore" });

        mkdirSync(join(tmp, ".agent"), { recursive: true });
        mkdirSync(join(tmp, "test"), { recursive: true });
        writeFileSync(join(tmp, "test", "witness.test.js"), "assert.equal(2 + 2, 4);", "utf-8");

        const witnessFlag = join(tmp, "witness.done").replace(/\\/g, "/");

        // Verification command confirms sentinelKey is undefined in process.env
        const yaml = `
verify:
  unit: node -e "if (process.env.${sentinelKey}) { process.exit(1); } require('fs').writeFileSync('${witnessFlag}', 'isolated'); console.log('collected 1 items')"
`;
        writeFileSync(join(tmp, ".agent", "jules.yml"), yaml, "utf-8");
        execSync('git add . && git commit -m "setup gate"', { cwd: tmp, stdio: "ignore" });

        const res = await gate({ root: tmp, base: "main" });
        assert.equal(res.ok, true, `Gate should pass when secret is not visible: ${res.error}`);
        assert.equal(res.code, 0);

        // Verification record in evidence must not contain the environment block
        assert.ok(res.evidence);
        assert.equal(res.evidence.executionRecords.length, 1);
        assert.equal(res.evidence.executionRecords[0].id, "unit");
        assert.equal(res.evidence.executionRecords[0].env, undefined);
      } finally {
        delete process.env[sentinelKey];
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("normal npm test verification passes under isolated environment in package fixture", () => {
      const tmp = mkdtempSync(join(tmpdir(), "jules-npm-test-"));
      try {
        const pkg = {
          name: "fixture-npm-test",
          version: "1.0.0",
          scripts: {
            test: "node -e \"console.log('from-npm-test'); assert.equal(process.env.SECRET_CANARY, undefined)\""
          }
        };
        writeFileSync(join(tmp, "package.json"), JSON.stringify(pkg, null, 2), "utf-8");

        process.env.SECRET_CANARY = "leaked";
        const vEnv = buildVerificationEnv();
        const res = runCmd("npm test", { cwd: tmp, env: vEnv });
        assert.equal(res.status, 0);
        assert.ok(res.stdout.includes("from-npm-test"));
      } finally {
        delete process.env.SECRET_CANARY;
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("Candidate-controlled config cannot request ambient secret through command expansion", async () => {
      const secretKey = "HOST_CI_SIGNING_KEY";
      process.env[secretKey] = "super-private-signing-key";

      const tmp = mkdtempSync(join(tmpdir(), "gate-cfg-injection-"));
      try {
        execSync("git init -b main", { cwd: tmp, stdio: "ignore" });
        execSync("git config user.name 'Test'", { cwd: tmp, stdio: "ignore" });
        execSync("git config user.email 'test@test.com'", { cwd: tmp, stdio: "ignore" });
        execSync("git commit --allow-empty -m 'initial'", { cwd: tmp, stdio: "ignore" });

        mkdirSync(join(tmp, ".agent"), { recursive: true });
        mkdirSync(join(tmp, "test"), { recursive: true });
        writeFileSync(join(tmp, "test", "witness.test.js"), "assert.equal(2 + 2, 4);", "utf-8");

        // Attempting to read or exfiltrate secret
        const yaml = `
verify:
  unit: node -e "if (process.env['${secretKey}']) { process.exit(5); } console.log('collected 1 items')"
`;
        writeFileSync(join(tmp, ".agent", "jules.yml"), yaml, "utf-8");
        execSync('git add . && git commit -m "candidate config"', { cwd: tmp, stdio: "ignore" });

        const res = await gate({ root: tmp, base: "main" });
        assert.equal(res.ok, true);
        assert.equal(res.code, 0);
      } finally {
        delete process.env[secretKey];
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("handles lowercase 'path' in ambient on Windows correctly", () => {
      const ambient = {
        path: "C:\\Lowercase\\bin",
        SYSTEMROOT: "C:\\Windows",
      };

      const env = buildVerificationEnv({ ambientEnv: ambient, platform: "win32" });
      assert.equal(env.PATH, "C:\\Lowercase\\bin");
      assert.equal(env.path, undefined);
    });

    it("extraEnv merges trusted custom variables while scrubbing forbidden waivers", () => {
      const env = buildVerificationEnv({
        extraEnv: {
          JULES_SANDBOX_OFFLINE: "1",
          PYTHONPATH: "/custom/src",
          NODE_V8_COVERAGE: "/tmp/cov",
          JULES_ALLOW_COMMAND_FILE_CHANGES: "true",
          AGENT_ALLOW_COMMAND_FILE_CHANGES: "true",
        },
        platform: "linux",
      });

      assert.equal(env.JULES_SANDBOX_OFFLINE, "1");
      assert.equal(env.PYTHONPATH, "/custom/src");
      assert.equal(env.NODE_V8_COVERAGE, "/tmp/cov");
      assert.equal(env.JULES_ALLOW_COMMAND_FILE_CHANGES, undefined);
      assert.equal(env.AGENT_ALLOW_COMMAND_FILE_CHANGES, undefined);
    });
  });
});
