import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { getGitProvenance, generateEvidenceManifest, verifyEvidenceManifest } from "../src/evidence.mjs";
import {
  runCmd,
  resolveBase,
  getCommitSha,
  getCommitParent,
  resolveDiffRange,
  showFromOrigin,
  worktreeRemove,
  materializeSnapshot,
  buildVerificationEnv,
} from "../src/git.mjs";
import { runStabilityProbe } from "../src/stability.mjs";
import { createProvider } from "../src/provider.mjs";

function withTempRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "jules-argv-safe-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Tester"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    writeFileSync(join(dir, "README.md"), "# Init\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "initial commit"], { cwd: dir });
    return fn(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
  }
}

describe("P1-04: Hardened Argv Execution & Shell Injection Defense", () => {
  it("Attack A & Reproduction: malicious Git ref in getGitProvenance cannot execute sentinel command", () => {
    withTempRepo((root) => {
      const sentinel = join(root, "sentinel-ref-attack.txt");
      assert.equal(existsSync(sentinel), false);

      const maliciousRef = `HEAD; touch "${sentinel}"`;
      const prov = getGitProvenance(root, { head: maliciousRef });

      assert.equal(existsSync(sentinel), false, "Sentinel file must NOT be created");
      assert.equal(prov.commitSha, "unknown");
    });
  });

  it("Attack A: malicious Git ref in generateEvidenceManifest & verifyEvidenceManifest cannot execute command", () => {
    withTempRepo((root) => {
      const sentinel = join(root, "sentinel-manifest-attack.txt");
      assert.equal(existsSync(sentinel), false);

      const maliciousRef = `HEAD && touch "${sentinel}"`;
      const manifest = generateEvidenceManifest(root, { head: maliciousRef });

      assert.equal(existsSync(sentinel), false, "Sentinel file must NOT be created");
      assert.equal(manifest.headSha, null);

      const verifyRes = verifyEvidenceManifest(root, manifest, { head: maliciousRef });
      assert.equal(existsSync(sentinel), false, "Sentinel file must NOT be created during verification");
      assert.equal(verifyRes.ok, false);
    });
  });

  it("Attack A: resolveBase rejects refs starting with '-' fail-closed", () => {
    withTempRepo((root) => {
      assert.throws(
        () => resolveBase(root, "--help", { allowFetch: false }),
        /Cannot resolve base reference|Invalid base reference/
      );
      assert.throws(
        () => resolveBase(root, "-n", { allowFetch: false }),
        /Cannot resolve base reference|Invalid base reference/
      );
      assert.throws(
        () => resolveBase(root, "--output=/tmp/evil", { allowFetch: false }),
        /Cannot resolve base reference|Invalid base reference/
      );
    });
  });

  it("Attack A: getCommitSha and getCommitParent return null on option-looking or invalid refs", () => {
    withTempRepo((root) => {
      assert.equal(getCommitSha(root, "--help"), null);
      assert.equal(getCommitSha(root, "-n"), null);
      assert.equal(getCommitSha(root, "--output=foo"), null);
      assert.equal(getCommitParent(root, "--help"), null);
      assert.equal(getCommitParent(root, "-n"), null);
      assert.equal(getCommitParent(root, "--output=foo"), null);
    });
  });

  it("Attack A: resolveDiffRange rejects targetHead starting with '-'", () => {
    withTempRepo((root) => {
      assert.throws(
        () => resolveDiffRange(root, "main", "committed", "--help"),
        /Invalid head reference/
      );
      assert.throws(
        () => resolveDiffRange(root, "main", "committed", "-n"),
        /Invalid head reference/
      );
    });
  });

  it("Attack B: showFromOrigin does not execute metacharacters in filePath", () => {
    withTempRepo((root) => {
      const sentinel = join(root, "sentinel-path-attack.txt");
      const maliciousPath = `file.txt; touch "${sentinel}"`;
      const res = showFromOrigin(root, "main", maliciousPath);

      assert.equal(existsSync(sentinel), false, "Sentinel file must NOT be created");
      assert.equal(res, null);
    });
  });

  it("Attack B: materializeSnapshot rejects targetRef starting with '-'", () => {
    withTempRepo((root) => {
      assert.throws(
        () => materializeSnapshot(root, "committed", "--help"),
        /Invalid target ref/
      );
      assert.throws(
        () => materializeSnapshot(root, "committed", "-n"),
        /Invalid target ref/
      );
    });
  });

  it("Attack C: worktreeRemove uses '--' separator and rejects option-looking paths", () => {
    withTempRepo((root) => {
      const emptyRes = worktreeRemove(root, "");
      assert.equal(emptyRes, "");

      const dashRes = worktreeRemove(root, "--help");
      assert.equal(dashRes, "");

      const wtDir = join(root, "wt-test");
      execFileSync("git", ["worktree", "add", wtDir, "HEAD"], { cwd: root, stdio: "ignore" });
      assert.equal(existsSync(wtDir), true);

      worktreeRemove(root, wtDir);
      assert.equal(existsSync(wtDir), false);
    });
  });

  it("Attack D: newline and shell metacharacters passed in argv array remain pure data", () => {
    withTempRepo((root) => {
      const echoScript = join(root, "echo-args.cjs");
      writeFileSync(
        echoScript,
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n"
      );

      const complexPayloads = [
        "foo; touch /tmp/sentinel",
        "foo && bar || baz",
        "foo | cat",
        "$(echo evil)",
        "`echo evil`",
        "hello\nworld",
        "with 'single' and \"double\" quotes",
        "> output.txt < input.txt",
        "nested (parentheses) & ampersands",
      ];

      for (const payload of complexPayloads) {
        const res = runCmd(["node", echoScript, payload], { cwd: root });
        assert.equal(res.status, 0);
        const parsed = JSON.parse(res.stdout);
        assert.deepEqual(parsed, [payload], `Payload must round-trip exactly: ${payload}`);
      }
    });
  });

  it("Legitimate spaces in argv entries are preserved without token splitting", () => {
    withTempRepo((root) => {
      const echoScript = join(root, "echo-args.cjs");
      writeFileSync(
        echoScript,
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n"
      );

      const spaceArgs = ["first argument with spaces", "second argument", "third   multiple   spaces"];
      const res = runCmd(["node", echoScript, ...spaceArgs], { cwd: root });
      assert.equal(res.status, 0);
      const parsed = JSON.parse(res.stdout);
      assert.deepEqual(parsed, spaceArgs);
    });
  });

  it("Attack E: provider exec command passes session/prompt as structured argv, not shell", async () => {
    await withTempRepo(async (root) => {
      const sentinel = join(root, "sentinel-provider-attack.txt");
      const fakeBin = join(root, "fake-provider.cjs");
      writeFileSync(
        fakeBin,
        "process.stdout.write(JSON.stringify({ args: process.argv.slice(2) }));\n"
      );

      const provider = createProvider(
        {
          type: "exec",
          name: "mockExec",
          command: "node",
          args: [fakeBin, "--session", "{sessionId}", "--model", "{model}", "{prompt}"],
        },
        { _root: root }
      );

      const maliciousPrompt = `Hello; touch "${sentinel}"`;
      const res = await provider.dispatch(
        { prompt: maliciousPrompt },
        { sessionId: "sess-1; touch evil", model: "gpt-4 || touch evil" }
      );

      assert.equal(existsSync(sentinel), false, "Sentinel file must NOT be created");
      assert.equal(res.status, "completed");
      const parsed = JSON.parse(res.output);
      assert.deepEqual(parsed.args, [
        "--session",
        "sess-1; touch evil",
        "--model",
        "gpt-4 || touch evil",
        maliciousPrompt,
      ]);
    });
  });

  it("Attack F: explicit user-authored shell verify commands continue to work", () => {
    withTempRepo((root) => {
      // 1. Chained && command
      const chained = runCmd('node -e "process.stdout.write(\'A\')" && node -e "process.stdout.write(\'B\')"', { cwd: root });
      assert.equal(chained.status, 0);
      assert.equal(chained.stdout, "AB");

      // 2. Output redirection and reading
      const redirected = runCmd('node -e "console.log(\'redirect-ok\')" > out.txt', { cwd: root });
      assert.equal(redirected.status, 0);
      assert.equal(existsSync(join(root, "out.txt")), true);

      // 3. Pipe command
      const piped = runCmd('node -e "console.log(\'line1\\nline2\')" | node -e "let d=\'\';process.stdin.on(\'data\',c=>d+=c);process.stdin.on(\'end\',()=>process.stdout.write(d.split(\'\\n\')[0]))"', { cwd: root });
      assert.equal(piped.status, 0);
      assert.equal(piped.stdout.trim(), "line1");
    });
  });

  it("P0-11 compatibility: benign command prefixes work while reserved control keys are protected", () => {
    withTempRepo((root) => {
      const dumpScript = join(root, "dump-env.cjs");
      writeFileSync(
        dumpScript,
        "process.stdout.write(JSON.stringify({ pypath: process.env.PYTHONPATH, custom: process.env.MY_VAR, opt: process.env.NODE_OPTIONS, ci: process.env.CI }));\n"
      );

      // Benign prefixes work
      const benignRes = runCmd(`PYTHONPATH=custom_src MY_VAR=hello node ${dumpScript}`, { cwd: root });
      assert.equal(benignRes.status, 0);
      const parsedBenign = JSON.parse(benignRes.stdout);
      assert.equal(parsedBenign.pypath, "custom_src");
      assert.equal(parsedBenign.custom, "hello");

      // Reserved keys are stripped from command prefix
      const attackRes = runCmd(`NODE_OPTIONS=--insecure CI=false node ${dumpScript}`, {
        cwd: root,
        env: buildVerificationEnv({ netGuard: true }),
      });
      assert.equal(attackRes.status, 0);
      const parsedAttack = JSON.parse(attackRes.stdout);
      assert.notEqual(parsedAttack.opt, "--insecure");
      assert.equal(parsedAttack.ci, "true");
    });
  });

  it("Stability prober uses runCmd and buildVerificationEnv", () => {
    withTempRepo((root) => {
      const testFile = join(root, "stable-probe.cjs");
      writeFileSync(testFile, "process.stdout.write('PROBE_OK'); process.exit(0);\n");

      const probe = runStabilityProbe(`node ${testFile}`, { root, repeat: 2 });
      assert.equal(probe.ok, true);
      assert.equal(probe.passes, 2);
      assert.equal(probe.failures, 0);
    });
  });
});
