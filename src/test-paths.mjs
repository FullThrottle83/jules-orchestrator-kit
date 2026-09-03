/**
 * One answer to "is this path a test file?".
 *
 * There were five, in five modules, and they disagreed with each other:
 *
 *   - `security.mjs`  matched the substring `/test/`, so a file in the
 *     repository's own root-level `tests/` directory had no leading slash and
 *     was not a test file. The entire tamper guard — skip injection, vacuous
 *     assertions, commented-out assertions, removal, weakening, expectation
 *     rewrites — was therefore switched off for the standard pytest layout
 *     (`tests/test_calc.py`), the standard Rust integration layout
 *     (`tests/integration.rs`) and every RSpec suite (`spec/`).
 *   - `mutation.mjs`  had the same substring bug, in the opposite direction:
 *     those same files were not excluded, so the harness mutated operators
 *     inside the tests themselves and scored the result.
 *   - `engine.mjs`    never looked for `_test.`, so `strictTestLock` did not
 *     consider a Go test file to be a test file.
 *   - `coverage.mjs`  and `evidence.mjs` each had a third and fourth spelling.
 *
 * A predicate this load-bearing cannot have five definitions. This is the one
 * they all use.
 *
 * The classification errs toward "yes". Four of the five callers get stricter
 * when it does — the tamper guard applies, the integrity hash covers more, the
 * lock triggers — and the fifth (mutation) has nothing to lose, because
 * mutating an operator inside a test proves nothing about the code under test.
 */

/**
 * Directory names that mean "everything below here is a test".
 *
 * Matched as whole path segments, not substrings: `latest/` is not `test/`,
 * and `myspec/` is not `spec/`.
 */
const TEST_DIR_SEGMENTS = new Set(["test", "tests", "spec", "specs", "__tests__", "__test__"]);

/**
 * True when `file` names a test file under any convention the kit supports.
 *
 * Covers, by directory: `test/`, `tests/`, `spec/`, `specs/`, `__tests__/` at
 * any depth including the repository root. By filename: `foo.test.js`,
 * `foo.spec.ts`, `foo_test.go`, `foo_spec.rb`, `test_calc.py` (pytest),
 * `spec_helper.rb`, and Foundry's `Foo.t.sol` / `FooTest.sol`.
 *
 * @param {string} file - Repo-relative path, either separator.
 * @returns {boolean}
 */
export function isTestPath(file) {
  if (!file || typeof file !== "string") return false;
  const segments = file.replace(/\\/g, "/").toLowerCase().split("/").filter(Boolean);
  if (segments.length === 0) return false;

  for (let i = 0; i < segments.length - 1; i++) {
    if (TEST_DIR_SEGMENTS.has(segments[i])) return true;
  }

  const base = segments[segments.length - 1];
  return (
    base.includes(".test.") ||
    base.includes(".spec.") ||
    base.includes("_test.") ||
    base.includes("_spec.") ||
    base.startsWith("test_") ||
    base.startsWith("spec_") ||
    base.endsWith("test.sol") ||
    base.endsWith(".t.sol")
  );
}
