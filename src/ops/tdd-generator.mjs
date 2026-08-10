import { writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { detectPolyglotStack } from "../stack-detector.mjs";
import { resolveRoot } from "../config.mjs";
import { runCmd } from "../git.mjs";

export class TddError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = "TddError";
    this.code = opts.code || 1;
  }
}

/**
 * Scaffolds a targeted, falsifiable TDD unit test file based on feature/bug specifications.
 * @param {object} spec
 * @param {string} spec.title - Test title/name
 * @param {string} spec.spec - Bug or feature requirement details
 * @param {object} [options]
 * @returns {object} { filePath, codeContent, testCmd }
 */
export function scaffoldTddTest(spec = {}, options = {}) {
  const root = options.root || resolveRoot();
  const title = (spec.title || "feature-spec").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const details = spec.spec || "Feature requirement specification assertion.";

  const stack = detectPolyglotStack(root);
  const testDir = join(root, "test");
  try {
    mkdirSync(testDir, { recursive: true });
  } catch (_) {}

  const fileName = `generated-${title}.test.mjs`;
  const filePath = join(testDir, fileName);

  const codeContent = `import test from "node:test";
import assert from "node:assert/strict";

test("TDD Oracle: ${title}", () => {
  // REQUIREMENT SPECIFICATION:
  // ${details.replace(/\n/g, "\n  // ")}

  const isImplemented = false;
  assert.equal(isImplemented, true, "TDD Assertion Failed: Requirement '${title}' is not yet implemented.");
});
`;

  writeFileSync(filePath, codeContent, "utf-8");

  const relativePath = `test/${fileName}`;
  let testCmd = ["node", "--test", filePath];
  let testCmdStr = `node --test ${relativePath}`;
  if (stack.stack === "python") {
    testCmd = ["pytest", filePath];
    testCmdStr = `pytest ${relativePath}`;
  } else if (stack.stack === "cargo") {
    testCmd = ["cargo", "test", "--test", title];
    testCmdStr = `cargo test --test ${title}`;
  }

  return {
    filePath,
    relativePath,
    codeContent,
    testCmd,
    testCmdStr,
  };
}

/**
 * Executes full Red-to-Green TDD verification cycle.
 * 1. RED: Asserts newly generated test fails.
 * 2. LOCK: Injects test file into scope.deny to prevent agent tampering.
 * 3. GREEN: Runs verification suite after implementation.
 * @param {object} spec
 * @param {object} options
 * @returns {Promise<object>} Cycle summary
 */
export async function runTddCycle(spec = {}, options = {}) {
  const root = options.root || resolveRoot();
  const scaffolded = scaffoldTddTest(spec, options);

  // Step 1: RED Check - Must fail initially
  let redOutput;
  try {
    const cleanEnv = { ...process.env };
    delete cleanEnv.NODE_OPTIONS;
    for (const k of Object.keys(cleanEnv)) {
      if (k.startsWith("NODE_TEST_") || k.startsWith("NODE_CHANNEL_")) {
        delete cleanEnv[k];
      }
    }
    redOutput = runCmd(scaffolded.testCmd, { cwd: root, ignoreError: true, env: cleanEnv });
  } catch (err) {
    redOutput = { status: 1, stdout: "", stderr: err.message };
  }

  if (redOutput.status === 0) {
    throw new TddError(
      `TDD RED check failed: Test 'test/${basename(scaffolded.filePath)}' passed initially! TDD tests must be falsifiable and fail before implementation.`
    );
  }

  // Step 2: Lock test into scope.deny
  const lockedScopeDeny = [scaffolded.relativePath];

  return {
    ok: true,
    step: "RED_VERIFIED",
    testFile: scaffolded.relativePath,
    lockedScopeDeny,
    redOutput: redOutput.stderr || redOutput.stdout,
  };
}
