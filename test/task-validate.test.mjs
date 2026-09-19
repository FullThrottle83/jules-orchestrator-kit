import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const CLI = fileURLToPath(new URL("../bin/agentctl.mjs", import.meta.url));

function tempDir() {
  return mkdtempSync(join(tmpdir(), "jules-task-validate-"));
}

function runValidate(cwd, args) {
  return spawnSync(process.execPath, [CLI, "task", "validate", ...args], {
    cwd,
    encoding: "utf-8",
  });
}

const VALID_MD = `---
kind: Task
version: agentctl.task/v1
id: TASK-001
title: Fix authentication session edge cases
intent: Fix the token expiration handler in auth controller
verification:
  commands:
    - npm test
---
# Task
Fix the token expiration handler.
`;

const INVALID_MD_MISSING_PROMPT = `---
kind: Task
version: agentctl.task/v1
id: TASK-BAD
verification:
  commands:
    - npm test
---
# Empty premise
`;

const INVALID_MD_EMPTY_ORACLE = `---
kind: Task
version: agentctl.task/v1
id: TASK-BAD-ORACLE
title: Has title but empty verification oracle
intent: Something to do
verification:
  commands: []
---
# Task
`;

test("agentctl task validate", async (t) => {
  await t.test("valid .md envelope with YAML frontmatter exits 0", () => {
    const dir = tempDir();
    try {
      const file = join(dir, "TASK-001.md");
      writeFileSync(file, VALID_MD);
      const res = runValidate(dir, [file]);
      assert.equal(res.status, 0, `stderr=${res.stderr}\nstdout=${res.stdout}`);
      assert.match(res.stdout, /validated successfully/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("invalid envelope missing prompt/intent exits 1", () => {
    const dir = tempDir();
    try {
      const file = join(dir, "TASK-BAD.md");
      writeFileSync(file, INVALID_MD_MISSING_PROMPT);
      const res = runValidate(dir, [file]);
      assert.equal(res.status, 1, `stderr=${res.stderr}\nstdout=${res.stdout}`);
      assert.match(`${res.stderr}${res.stdout}`, /intent|VALIDATION FAILED/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("invalid envelope with empty verification oracle exits 1", () => {
    const dir = tempDir();
    try {
      const file = join(dir, "TASK-BAD-ORACLE.md");
      writeFileSync(file, INVALID_MD_EMPTY_ORACLE);
      const res = runValidate(dir, [file]);
      assert.equal(res.status, 1, `stderr=${res.stderr}\nstdout=${res.stdout}`);
      assert.match(`${res.stderr}${res.stdout}`, /verification\.commands|VALIDATION FAILED/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("missing target file exits 1", () => {
    const dir = tempDir();
    try {
      const res = runValidate(dir, [join(dir, "does-not-exist.md")]);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /not found/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("missing positional argument exits 1 with usage", () => {
    const dir = tempDir();
    try {
      const res = runValidate(dir, []);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /Usage:.*task validate/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("--json emits valid JSON with ok, file, errors, warnings", () => {
    const dir = tempDir();
    try {
      const file = join(dir, "TASK-001.md");
      writeFileSync(file, VALID_MD);
      const okRes = runValidate(dir, [file, "--json"]);
      assert.equal(okRes.status, 0, `stderr=${okRes.stderr}\nstdout=${okRes.stdout}`);
      const okParsed = JSON.parse(okRes.stdout);
      assert.equal(okParsed.ok, true);
      assert.ok(typeof okParsed.file === "string");
      assert.ok(Array.isArray(okParsed.errors));
      assert.ok(Array.isArray(okParsed.warnings));
      assert.equal(okParsed.errors.length, 0);

      const bad = join(dir, "TASK-BAD.md");
      writeFileSync(bad, INVALID_MD_MISSING_PROMPT);
      const badRes = runValidate(dir, [bad, "--json"]);
      assert.equal(badRes.status, 1);
      const badParsed = JSON.parse(badRes.stdout);
      assert.equal(badParsed.ok, false);
      assert.ok(Array.isArray(badParsed.errors));
      assert.ok(badParsed.errors.length > 0);
      assert.ok(Array.isArray(badParsed.warnings));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("valid JSON envelope exits 0", () => {
    const dir = tempDir();
    try {
      const file = join(dir, "task.json");
      writeFileSync(
        file,
        JSON.stringify({
          intent: "Refactor helpers",
          acceptance_criteria: ["Tests pass"],
        })
      );
      const res = runValidate(dir, [file, "--json"]);
      assert.equal(res.status, 0, `stderr=${res.stderr}\nstdout=${res.stdout}`);
      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed.ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
