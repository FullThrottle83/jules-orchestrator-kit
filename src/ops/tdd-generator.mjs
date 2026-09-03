import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
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

  // The generated oracle has to be written in the language its runner speaks.
  //
  // This used to emit a Node test file for every stack and then, in a Python
  // project, run `pytest generated-x.test.mjs`. pytest exits 4 on a file it
  // cannot collect, and the cycle read any non-zero exit as RED — so it
  // reported a verified failing test, and locked an uncollectable file into
  // scope.deny, having proven nothing at all.
  const identifier = title.replace(/-/g, "_");

  // The one string that must appear in the runner's output for the failure to
  // be the *assertion* failing rather than the file never being collected.
  const redMarker = `TDD Assertion Failed: Requirement '${title}' is not yet implemented.`;
  const comment = (prefix) => details.split("\n").map((line) => `${prefix} ${line}`).join("\n");

  let relDir = "test";
  let fileName = `generated-${title}.test.mjs`;
  let codeContent;
  let testCmdParts;
  let testCmdStr;

  if (stack.stack === "python" || stack.stack === "django") {
    fileName = `test_generated_${identifier}.py`;
    codeContent = `def test_tdd_oracle_${identifier}():
    # REQUIREMENT SPECIFICATION:
${comment("    #")}
    is_implemented = False
    assert is_implemented, "${redMarker}"
`;
    testCmdParts = ["pytest", `${relDir}/${fileName}`];
    testCmdStr = `pytest ${relDir}/${fileName}`;
  } else if (stack.stack === "cargo") {
    // Cargo discovers integration tests in tests/, not test/.
    relDir = "tests";
    fileName = `generated_${identifier}.rs`;
    codeContent = `#[test]
fn tdd_oracle_${identifier}() {
    // REQUIREMENT SPECIFICATION:
${comment("    //")}
    let is_implemented = false;
    assert!(is_implemented, "${redMarker}");
}
`;
    testCmdParts = ["cargo", "test", "--test", `generated_${identifier}`];
    testCmdStr = `cargo test --test generated_${identifier}`;
  } else if (stack.stack === "go") {
    fileName = `generated_${identifier}_test.go`;
    codeContent = `package ${relDir}

import "testing"

func TestTddOracle${identifier.replace(/_/g, "")}(t *testing.T) {
	// REQUIREMENT SPECIFICATION:
${comment("\t//")}
	isImplemented := false
	if !isImplemented {
		t.Fatalf("${redMarker}")
	}
}
`;
    testCmdParts = ["go", "test", `./${relDir}/`];
    testCmdStr = `go test ./${relDir}/`;
  } else {
    codeContent = `import test from "node:test";
import assert from "node:assert/strict";

test("TDD Oracle: ${title}", () => {
  // REQUIREMENT SPECIFICATION:
${comment("  //")}

  const isImplemented = false;
  assert.equal(isImplemented, true, "${redMarker}");
});
`;
    testCmdParts = ["node", "--test", join(root, relDir, fileName)];
    testCmdStr = `node --test ${relDir}/${fileName}`;
  }

  const testDir = join(root, relDir);
  try {
    mkdirSync(testDir, { recursive: true });
  } catch (_) {}

  const filePath = join(testDir, fileName);
  writeFileSync(filePath, codeContent, "utf-8");

  return {
    filePath,
    relativePath: `${relDir}/${fileName}`,
    codeContent,
    testCmd: testCmdParts,
    testCmdStr,
    stack: stack.stack,
    redMarker,
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
      `TDD RED check failed: Test '${scaffolded.relativePath}' passed initially! TDD tests must be falsifiable and fail before implementation.`
    );
  }

  // A non-zero exit is not proof the assertion ran. `pytest` exits 4 on a file
  // it cannot collect and 5 when it collects nothing; a runner pointed at a
  // file it does not understand exits non-zero for that reason alone. Reading
  // either as RED is how a Node test file in a Python project came to be
  // reported as a verified failing oracle. The generated assertion carries a
  // marker; if the runner never reached it, the marker is not in the output.
  const redText = `${redOutput.stdout || ""}\n${redOutput.stderr || ""}`;
  if (scaffolded.redMarker && !redText.includes(scaffolded.redMarker)) {
    throw new TddError(
      `TDD RED check inconclusive: '${scaffolded.testCmdStr}' exited ${redOutput.status} without reaching the generated assertion, so nothing was proven falsifiable. ` +
        `The runner most likely could not collect '${scaffolded.relativePath}' (detected stack: ${scaffolded.stack}). Output:\n${redText.trim().slice(0, 500)}`
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
