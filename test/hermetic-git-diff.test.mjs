import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { gate } from "../src/engine.mjs";
import {
  diffText,
  parseRawDiff,
  changedFiles,
  gitlinkChanges,
  binaryDiffEntries,
  resolveBase,
  PINNED_DIFF_CONFIG,
  PINNED_DIFF_FLAGS,
} from "../src/git.mjs";
import { BUILTIN_PROTECT } from "../src/config.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(initialBranch = "main") {
  const dir = mkdtempSync(join(tmpdir(), "jok-hermetic-"));
  git(dir, ["init", "-q", "-b", initialBranch]);
  git(dir, ["config", "user.name", "Tester"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "test-pkg", scripts: { test: "node --test" } }, null, 2)
  );
  mkdirSync(join(dir, ".agent"), { recursive: true });
  writeFileSync(join(dir, ".agent", "config.yml"), "version: 1\nverify:\n  test: 'node --test'\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

describe("P0-02 & P0-12: Hermetic Committed Diff & Rename Invariants", () => {
  // 1. .gitattributes with test/** -diff cannot blind test tamper detection
  it("1 & Scenario A: .gitattributes with test/** -diff cannot blind test tamper detection", async () => {
    const dir = initRepo();
    try {
      writeFileSync(join(dir, ".gitattributes"), "test/** -diff\n");
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(
        join(dir, "test", "a.test.mjs"),
        'import assert from "node:assert";\nimport test from "node:test";\ntest("adds", () => {\n  assert.equal(1 + 1, 2);\n});\n'
      );
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "add test"]);
      const baseSha = git(dir, ["rev-parse", "HEAD"]);

      // Tamper: remove assertion
      writeFileSync(
        join(dir, "test", "a.test.mjs"),
        'import assert from "node:assert";\nimport test from "node:test";\ntest("adds", () => {\n});\n'
      );
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "tamper test"]);
      const headSha = git(dir, ["rev-parse", "HEAD"]);

      const res = await gate({ root: dir, mode: "committed", baseSha, head: headSha });
      assert.equal(res.ok, false);
      assert.equal(res.code, 6, "Tamper detector must flag assertion deletion despite -diff");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 2. binary attribute cannot blind it
  it("2 & Scenario B: gitattributes binary attribute cannot blind test tamper detection", async () => {
    const dir = initRepo();
    try {
      writeFileSync(join(dir, ".gitattributes"), "test/*.test.mjs binary\n");
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(
        join(dir, "test", "b.test.mjs"),
        'import assert from "node:assert";\nimport test from "node:test";\ntest("sub", () => {\n  assert.equal(2 - 1, 1);\n});\n'
      );
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "add test"]);
      const baseSha = git(dir, ["rev-parse", "HEAD"]);

      // Tamper: weaken assertion
      writeFileSync(
        join(dir, "test", "b.test.mjs"),
        'import assert from "node:assert";\nimport test from "node:test";\ntest("sub", () => {\n});\n'
      );
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "tamper test"]);
      const headSha = git(dir, ["rev-parse", "HEAD"]);

      const bins = binaryDiffEntries(dir, baseSha, "committed", headSha);
      assert.equal(bins.length, 0, "Text test file marked binary in .gitattributes must not be treated as binary payload");

      const res = await gate({ root: dir, mode: "committed", baseSha, head: headSha });
      assert.equal(res.ok, false);
      assert.equal(res.code, 6, "Tamper detector must flag assertion deletion despite binary attribute");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 3. diff=<driver> cannot blind it
  it("3. diff=<custom-driver> in .gitattributes cannot blind diff rendering or tamper guard", async () => {
    const dir = initRepo();
    try {
      writeFileSync(join(dir, ".gitattributes"), "test/** diff=customdriver\n");
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(
        join(dir, "test", "c.test.mjs"),
        'import assert from "node:assert";\nimport test from "node:test";\ntest("c", () => {\n  assert.equal(Boolean("hello"), true);\n});\n'
      );
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "add test"]);
      const baseSha = git(dir, ["rev-parse", "HEAD"]);

      writeFileSync(
        join(dir, "test", "c.test.mjs"),
        'import assert from "node:assert";\nimport test from "node:test";\ntest("c", () => {\n});\n'
      );
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "tamper test"]);
      const headSha = git(dir, ["rev-parse", "HEAD"]);

      const res = await gate({ root: dir, mode: "committed", baseSha, head: headSha });
      assert.equal(res.ok, false);
      assert.equal(res.code, 6, "Custom diff driver attribute must not blind tamper detection");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 4. custom textconv is not trusted/executed
  it("4. custom textconv command is disabled by --no-textconv and not executed", async () => {
    const dir = initRepo();
    const sentinelFile = join(dir, "sentinel-textconv-ran.txt");
    try {
      git(dir, ["config", "diff.customdriver.textconv", `touch "${sentinelFile}"`]);
      writeFileSync(join(dir, ".gitattributes"), "*.txt diff=customdriver\n");
      writeFileSync(join(dir, "doc.txt"), "before\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "add doc"]);
      const baseSha = git(dir, ["rev-parse", "HEAD"]);

      writeFileSync(join(dir, "doc.txt"), "after\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "edit doc"]);
      const headSha = git(dir, ["rev-parse", "HEAD"]);

      const diff = diffText(dir, baseSha, "committed", headSha);
      assert.match(diff, /-before/);
      assert.match(diff, /\+after/);
      assert.equal(existsSync(sentinelFile), false, "textconv sentinel script must never be executed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 5. diff.external cannot influence the result
  it("5 & Scenario C: diff.external helper is neutralized and not executed", async () => {
    const dir = initRepo();
    const sentinelExt = join(dir, "sentinel-external-ran.txt");
    try {
      git(dir, ["config", "diff.external", `touch "${sentinelExt}"`]);
      writeFileSync(join(dir, "file.txt"), "alpha\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "add file"]);
      const baseSha = git(dir, ["rev-parse", "HEAD"]);

      writeFileSync(join(dir, "file.txt"), "beta\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "modify file"]);
      const headSha = git(dir, ["rev-parse", "HEAD"]);

      const diff = diffText(dir, baseSha, "committed", headSha);
      assert.match(diff, /-alpha/);
      assert.match(diff, /\+beta/);
      assert.equal(existsSync(sentinelExt), false, "diff.external sentinel helper must not execute");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 6. hostile diff.noprefix cannot break patch parsing
  it("6 & Scenario D: hostile diff.noprefix=true does not break prefix pinning or parsing", async () => {
    const dir = initRepo();
    try {
      git(dir, ["config", "diff.noprefix", "true"]);
      writeFileSync(join(dir, "prefix.txt"), "line 1\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "add prefix file"]);
      const baseSha = git(dir, ["rev-parse", "HEAD"]);

      writeFileSync(join(dir, "prefix.txt"), "line 2\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "mod prefix file"]);
      const headSha = git(dir, ["rev-parse", "HEAD"]);

      const diff = diffText(dir, baseSha, "committed", headSha);
      assert.match(diff, /--- a\/prefix\.txt/, "Diff must preserve a/ prefix despite diff.noprefix");
      assert.match(diff, /\+\+\+ b\/prefix\.txt/, "Diff must preserve b/ prefix despite diff.noprefix");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 7. hostile color.ui=always cannot contaminate parsing
  it("7 & Scenario E: hostile color.ui=always does not contaminate diff text with ANSI escape codes", async () => {
    const dir = initRepo();
    try {
      git(dir, ["config", "color.ui", "always"]);
      git(dir, ["config", "color.diff", "always"]);
      writeFileSync(join(dir, "color.txt"), "red\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "add color file"]);
      const baseSha = git(dir, ["rev-parse", "HEAD"]);

      writeFileSync(join(dir, "color.txt"), "green\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "mod color file"]);
      const headSha = git(dir, ["rev-parse", "HEAD"]);

      const diff = diffText(dir, baseSha, "committed", headSha);
      // ANSI escape sequence is \u001b[...
      assert.doesNotMatch(diff, /\u001b\[[0-9;]*m/, "Diff text must not contain ANSI escape codes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 8. pinned a/ and b/ prefixes remain stable
  it("8. diff.mnemonicPrefix=true does not replace standard a/ and b/ prefixes", async () => {
    const dir = initRepo();
    try {
      git(dir, ["config", "diff.mnemonicPrefix", "true"]);
      writeFileSync(join(dir, "mnemonic.txt"), "start\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "add mnemonic"]);
      const baseSha = git(dir, ["rev-parse", "HEAD"]);

      writeFileSync(join(dir, "mnemonic.txt"), "finish\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "edit mnemonic"]);
      const headSha = git(dir, ["rev-parse", "HEAD"]);

      const diff = diffText(dir, baseSha, "committed", headSha);
      assert.match(diff, /--- a\/mnemonic\.txt/);
      assert.match(diff, /\+\+\+ b\/mnemonic\.txt/);
      assert.doesNotMatch(diff, /--- c\/mnemonic\.txt/);
      assert.doesNotMatch(diff, /\+\+\+ w\/mnemonic\.txt/);

      assert.ok(PINNED_DIFF_CONFIG.includes("core.quotePath=false"));
      assert.ok(PINNED_DIFF_CONFIG.includes("diff.external="));
      assert.ok(PINNED_DIFF_FLAGS.includes("--text"));
      assert.ok(PINNED_DIFF_FLAGS.includes("--no-ext-diff"));
      assert.ok(PINNED_DIFF_FLAGS.includes("--no-textconv"));
      assert.ok(PINNED_DIFF_FLAGS.includes("--no-color"));
      assert.ok(PINNED_DIFF_FLAGS.includes("--no-renames"));
      assert.ok(PINNED_DIFF_FLAGS.includes("--src-prefix=a/"));
      assert.ok(PINNED_DIFF_FLAGS.includes("--dst-prefix=b/"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 9. rename-out of deny retains old path
  it("9. rename-out of denied path retains source path and blocks on deny", async () => {
    const dir = initRepo();
    try {
      // Add a secret or denied file
      writeFileSync(join(dir, ".env"), "SECRET=val\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "add .env"]);
      const baseSha = git(dir, ["rev-parse", "HEAD"]);

      // Rename .env -> safe.txt
      git(dir, ["mv", ".env", "safe.txt"]);
      git(dir, ["commit", "-qm", "rename .env to safe.txt"]);
      const headSha = git(dir, ["rev-parse", "HEAD"]);

      const files = changedFiles(dir, baseSha, "committed", headSha);
      assert.ok(files.includes(".env"), "Old denied path .env must remain in changedFiles");
      assert.ok(files.includes("safe.txt"), "New destination path safe.txt must also be in changedFiles");

      const res = await gate({ root: dir, mode: "committed", baseSha, head: headSha });
      assert.equal(res.ok, false);
      assert.equal(res.code, 3);
      const scopePhase = res.phases.find((p) => p.phase === "scope");
      assert.ok(scopePhase.violations.some((v) => v.file === ".env" && v.rule === "deny"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 10. rename-out of protect retains old path
  it("10 & Scenario F: rename-out of protected path retains old path as violation", async () => {
    const dir = initRepo();
    try {
      const baseSha = git(dir, ["rev-parse", "HEAD"]);

      // Rename protected package.json to harmless harmless.json
      git(dir, ["mv", "package.json", "harmless.json"]);
      git(dir, ["commit", "-qm", "rename package.json"]);
      const headSha = git(dir, ["rev-parse", "HEAD"]);

      const files = changedFiles(dir, baseSha, "committed", headSha);
      assert.ok(files.includes("package.json"), "package.json must be preserved in changedFiles");
      assert.ok(files.includes("harmless.json"), "harmless.json must be in changedFiles");

      const raw = parseRawDiff(dir, baseSha, "committed", headSha);
      assert.ok(raw.some((r) => r.file === "package.json" && r.status === "D"));
      assert.ok(raw.some((r) => r.file === "harmless.json" && r.status === "A"));

      const res = await gate({ root: dir, mode: "committed", baseSha, head: headSha });
      assert.equal(res.ok, false);
      assert.equal(res.code, 3);
      const scopePhase = res.phases.find((p) => p.phase === "scope");
      assert.ok(scopePhase.violations.some((v) => v.file === "package.json" && v.rule === "protect"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 11. rename-in to deny/protect exposes new path
  it("11. rename-in from allowed file into protected or denied path triggers protection", async () => {
    const dir = initRepo();
    try {
      writeFileSync(join(dir, "draft.json"), '{"name":"draft"}\n');
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "add draft"]);
      const baseSha = git(dir, ["rev-parse", "HEAD"]);

      // Rename draft.json -> sub/package.json (which matches **/package.json in BUILTIN_PROTECT)
      mkdirSync(join(dir, "sub"), { recursive: true });
      git(dir, ["mv", "draft.json", "sub/package.json"]);
      git(dir, ["commit", "-qm", "rename into sub/package.json"]);
      const headSha = git(dir, ["rev-parse", "HEAD"]);

      const files = changedFiles(dir, baseSha, "committed", headSha);
      assert.ok(files.includes("sub/package.json"), "Destination sub/package.json must be exposed");

      const res = await gate({ root: dir, mode: "committed", baseSha, head: headSha });
      assert.equal(res.ok, false);
      assert.equal(res.code, 3);
      const scopePhase = res.phases.find((p) => p.phase === "scope");
      assert.ok(scopePhase.violations.some((v) => v.file === "sub/package.json" && v.rule === "protect"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 12. direct deletion of deny/protect remains visible
  it("12. direct deletion of protected file remains visible and blocks", async () => {
    const dir = initRepo();
    try {
      const baseSha = git(dir, ["rev-parse", "HEAD"]);

      git(dir, ["rm", "package.json"]);
      git(dir, ["commit", "-qm", "delete package.json"]);
      const headSha = git(dir, ["rev-parse", "HEAD"]);

      const files = changedFiles(dir, baseSha, "committed", headSha);
      assert.ok(files.includes("package.json"), "Deleted package.json must be in changedFiles");

      const res = await gate({ root: dir, mode: "committed", baseSha, head: headSha });
      assert.equal(res.ok, false);
      assert.equal(res.code, 3);
      const scopePhase = res.phases.find((p) => p.phase === "scope");
      assert.ok(scopePhase.violations.some((v) => v.file === "package.json" && v.rule === "protect"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 13. .gitattributes itself is protected/visible
  it("13. .gitattributes is in BUILTIN_PROTECT and triggers scope protection", async () => {
    assert.ok(BUILTIN_PROTECT.includes(".gitattributes"));
    const dir = initRepo();
    try {
      const baseSha = git(dir, ["rev-parse", "HEAD"]);
      writeFileSync(join(dir, ".gitattributes"), "* text\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "add .gitattributes"]);
      const headSha = git(dir, ["rev-parse", "HEAD"]);

      const res = await gate({ root: dir, mode: "committed", baseSha, head: headSha });
      assert.equal(res.ok, false);
      assert.equal(res.code, 3);
      const scopePhase = res.phases.find((p) => p.phase === "scope");
      assert.ok(scopePhase.violations.some((v) => v.file === ".gitattributes" && v.rule === "protect"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 14. nested **/.gitattributes is protected
  it("14. nested **/.gitattributes is in BUILTIN_PROTECT and triggers scope protection", async () => {
    assert.ok(BUILTIN_PROTECT.includes("**/.gitattributes"));
    const dir = initRepo();
    try {
      const baseSha = git(dir, ["rev-parse", "HEAD"]);
      mkdirSync(join(dir, "src", "nested"), { recursive: true });
      writeFileSync(join(dir, "src", "nested", ".gitattributes"), "* text\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "add nested .gitattributes"]);
      const headSha = git(dir, ["rev-parse", "HEAD"]);

      const res = await gate({ root: dir, mode: "committed", baseSha, head: headSha });
      assert.equal(res.ok, false);
      assert.equal(res.code, 3);
      const scopePhase = res.phases.find((p) => p.phase === "scope");
      assert.ok(scopePhase.violations.some((v) => v.file === "src/nested/.gitattributes" && v.rule === "protect"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 15. .gitmodules is protected/visible
  it("15. .gitmodules is in BUILTIN_PROTECT and triggers scope protection", async () => {
    assert.ok(BUILTIN_PROTECT.includes(".gitmodules"));
    const dir = initRepo();
    try {
      const baseSha = git(dir, ["rev-parse", "HEAD"]);
      writeFileSync(join(dir, ".gitmodules"), '[submodule "test"]\npath = test\nurl = https://example.com/repo\n');
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "add .gitmodules"]);
      const headSha = git(dir, ["rev-parse", "HEAD"]);

      const res = await gate({ root: dir, mode: "committed", baseSha, head: headSha });
      assert.equal(res.ok, false);
      assert.equal(res.code, 3);
      const scopePhase = res.phases.find((p) => p.phase === "scope");
      assert.ok(scopePhase.violations.some((v) => v.file === ".gitmodules" && v.rule === "protect"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 16. .lfsconfig is protected/visible
  it("16. .lfsconfig is in BUILTIN_PROTECT and triggers scope protection", async () => {
    assert.ok(BUILTIN_PROTECT.includes(".lfsconfig"));
    const dir = initRepo();
    try {
      const baseSha = git(dir, ["rev-parse", "HEAD"]);
      writeFileSync(join(dir, ".lfsconfig"), '[lfs]\nurl = "https://example.com/lfs"\n');
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "add .lfsconfig"]);
      const headSha = git(dir, ["rev-parse", "HEAD"]);

      const res = await gate({ root: dir, mode: "committed", baseSha, head: headSha });
      assert.equal(res.ok, false);
      assert.equal(res.code, 3);
      const scopePhase = res.phases.find((p) => p.phase === "scope");
      assert.ok(scopePhase.violations.some((v) => v.file === ".lfsconfig" && v.rule === "protect"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 17. gitlink pointer changes remain visible/protected
  it("17 & Scenario G: gitlink pointer additions and modifications trigger protection", async () => {
    const dir = initRepo();
    try {
      const dummySha1 = "1111111111111111111111111111111111111111";
      const dummySha2 = "2222222222222222222222222222222222222222";
      git(dir, ["update-index", "--add", "--cacheinfo", "160000", dummySha1, "sub/mod"]);
      git(dir, ["commit", "-qm", "add submodule pointer"]);
      const baseSha = git(dir, ["rev-parse", "HEAD"]);

      // Modify gitlink pointer
      git(dir, ["update-index", "--add", "--cacheinfo", "160000", dummySha2, "sub/mod"]);
      git(dir, ["commit", "-qm", "update submodule pointer"]);
      const headSha = git(dir, ["rev-parse", "HEAD"]);

      const gls = gitlinkChanges(dir, baseSha, "committed", headSha);
      assert.equal(gls.length, 1);
      assert.equal(gls[0].file, "sub/mod");
      assert.equal(gls[0].status, "M");

      const res = await gate({ root: dir, mode: "committed", baseSha, head: headSha });
      assert.equal(res.ok, false);
      assert.equal(res.code, 3);
      const scopePhase = res.phases.find((p) => p.phase === "scope");
      assert.ok(scopePhase.violations.some((v) => v.file === "sub/mod" && v.rule === "BUILTIN_PROTECT"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 18. spaces/quotes in paths do not break extraction
  it("18. legal filenames with spaces, quotes, and punctuation are preserved by -z and quotePath=false", async () => {
    const dir = initRepo();
    try {
      const baseSha = git(dir, ["rev-parse", "HEAD"]);
      const filename1 = "dir with spaces/my file.txt";
      const filename2 = "weird'quote'name.txt";
      const filename3 = "-leading-dash.txt";
      mkdirSync(join(dir, "dir with spaces"), { recursive: true });
      writeFileSync(join(dir, filename1), "hello 1\n");
      writeFileSync(join(dir, filename2), "hello 2\n");
      writeFileSync(join(dir, filename3), "hello 3\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "add strange names"]);
      const headSha = git(dir, ["rev-parse", "HEAD"]);

      const files = changedFiles(dir, baseSha, "committed", headSha);
      assert.ok(files.includes(filename1), "Path with spaces must be preserved");
      assert.ok(files.includes(filename2), "Path with quotes must be preserved");
      assert.ok(files.includes(filename3), "Path with leading dash must be preserved");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 19. ordinary committed diffs remain compatible
  it("19. ordinary committed edits remain compatible and pass cleanly", async () => {
    const dir = initRepo();
    try {
      const baseSha = git(dir, ["rev-parse", "HEAD"]);
      writeFileSync(join(dir, "feature.js"), "export const add = (a, b) => a + b;\n");
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(
        join(dir, "test", "feature.test.mjs"),
        'import assert from "node:assert";\nimport test from "node:test";\nimport { add } from "../feature.js";\ntest("adds", () => {\n  assert.equal(add(1, 2), 3);\n});\n'
      );
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "add feature with test"]);
      const headSha = git(dir, ["rev-parse", "HEAD"]);

      const res = await gate({ root: dir, mode: "committed", baseSha, head: headSha });
      assert.equal(res.ok, true, `Committed check must pass cleanly:\n${JSON.stringify(res, null, 2)}`);
      assert.equal(res.code, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 20. staged/working-tree rename regression closed
  it("20. staged and working-tree modes detect rename-out of protected files without masking", async () => {
    const dir = initRepo();
    try {
      // Staged mode rename
      git(dir, ["mv", "package.json", "pkg-staged.json"]);
      const stagedFiles = changedFiles(dir, "HEAD", "staged");
      assert.ok(stagedFiles.includes("package.json"), "Staged mode must include source package.json");
      assert.ok(stagedFiles.includes("pkg-staged.json"), "Staged mode must include destination pkg-staged.json");

      // Commit that rename and test working-tree rename
      git(dir, ["commit", "-qm", "commit rename"]);
      git(dir, ["mv", "pkg-staged.json", "pkg-working.json"]);
      const workingFiles = changedFiles(dir, "HEAD", "working-tree");
      assert.ok(workingFiles.includes("pkg-staged.json"), "Working-tree mode must include source of rename");
      assert.ok(workingFiles.includes("pkg-working.json"), "Working-tree mode must include destination of rename");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 21. P0-01 explicit trusted-base tests remain invariant
  it("21. committed verification strictly requires 40-character baseSha", async () => {
    const dir = initRepo();
    try {
      const res = await gate({ root: dir, mode: "committed", base: "main" });
      assert.equal(res.ok, false);
      assert.equal(res.code, 1);
      assert.match(res.error, /committed verification requires an explicit trusted baseline sha/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 22. missing committed base object fails closed without implicit fetch/network activity
  it("22 & Scenario H: missing baseSha fails closed without attempting git fetch", async () => {
    const dir = initRepo();
    try {
      // Configure origin remote pointing to a non-existent or sentinel address
      git(dir, ["remote", "add", "origin", "https://invalid.example.com/nonexistent/repo.git"]);

      const missingSha = "a".repeat(40);

      // Verify that resolveBase fails closed without network fetch
      assert.throws(
        () => resolveBase(dir, missingSha, { allowFetch: false }),
        /Cannot resolve base commit SHA/
      );

      // Verify that gate fails closed with code 1
      const res = await gate({ root: dir, mode: "committed", baseSha: missingSha, head: "HEAD" });
      assert.equal(res.ok, false);
      assert.equal(res.code, 1);
      assert.match(res.error, /Cannot resolve trusted base commit SHA/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
