/**
 * Does the suite exercise the code under review, or a copy of it?
 *
 * Finding F11. On a src-layout Python repository with the package installed as
 * a wheel, a configured `python3 -m pytest` imports from site-packages: `-m`
 * puts the working directory on `sys.path`, `src/` is not the working
 * directory, so `import pkg` falls through to the installed copy. 297 tests
 * passed against the installed library while the working source returned the
 * wrong answer, and the gate approved the source diff.
 *
 * This is the same question constraint 2 asks — is the code being executed the
 * code being judged? — one layer down. Materialising the snapshot fixes *which
 * checkout* runs; it does nothing about an interpreter that ignores the
 * checkout and imports something else. Both have to hold.
 *
 * ## Why this is a probe and not a pattern
 *
 * The report is careful about the distinction it draws: v0.71.0 fixed what
 * `init` *chooses* (`pytestCmd` emits `PYTHONPATH=src` for a src layout), and
 * did not touch a command already sitting in a config. So the rule cannot be
 * "the command lacks PYTHONPATH" — plenty of correct setups bind the source
 * some other way: an editable install, a `tox.ini`, `pythonpath` in
 * `pyproject.toml`, a `conftest.py` at the root, a `PYTHONPATH` already in the
 * environment. Rejecting all of those would fail correct work on a guess.
 *
 * So it asks the interpreter instead: run the *configured* command's
 * interpreter, in the same directory and environment the stage will run in,
 * and print where each changed package actually resolves from. If the answer
 * is a path inside the audited tree, the binding holds and nothing is
 * reported. If it is site-packages while the diff edits the source, the suite
 * demonstrably tested a different copy.
 *
 * One-sided, like every other rule here. Anything the probe cannot establish —
 * no interpreter, an import error, an unrecognised command shape, a package
 * name that cannot be derived — yields `null`, and null is not a finding.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/** Is the configured command a Python test run? */
const PYTHON_TEST = /(?:^|\s|\/)(?:pytest|py\.test)\b|(?:^|\s)-m\s+(?:pytest|unittest|nose2)\b/;

/**
 * The interpreter the command uses, and the environment assignments in front
 * of it. `runCmd` already peels leading `KEY=value` into the child env, so the
 * probe has to do the same or it measures a different environment than the
 * stage runs in.
 */
function parseCommand(cmd) {
  const tokens = String(cmd).trim().split(/\s+/).filter(Boolean);
  const env = {};
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
    const eq = tokens[i].indexOf("=");
    env[tokens[i].slice(0, eq)] = tokens[i].slice(eq + 1).replace(/^["']|["']$/g, "");
    i++;
  }
  const program = tokens[i] || "";
  const isInterpreter = /^(?:\S*[/\\])?(?:python[\d.]*|py)$/.test(program);
  return { env, interpreter: isInterpreter ? program : null, rest: tokens.slice(i + 1) };
}

/** Python packages living under `src/`, which is the layout at issue. */
function srcPackages(root) {
  const src = join(root, "src");
  if (!existsSync(src)) return [];
  try {
    return readdirSync(src, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(src, e.name, "__init__.py")))
      .map((e) => e.name);
  } catch (_) {
    return [];
  }
}

/**
 * Check that the packages the diff edits are the ones the suite imports.
 *
 * @param {object} opts
 * @param {string} opts.cwd - the directory the verification stage runs in.
 *   In staged/committed mode this is the materialised snapshot, so "inside the
 *   audited tree" and "inside cwd" are the same statement.
 * @param {string} opts.command - the configured verification command
 * @param {string[]} opts.files - changed paths, repo-relative
 * @param {object} [opts.env] - the environment the stage will run in
 * @returns {{ ok: boolean, reason: string|null, detail: object|null }}
 *   `ok: true` with `reason: null` means either the binding was confirmed or
 *   nothing could be established. Only a proven mismatch is `ok: false`.
 */
export function checkSourceBinding(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const command = opts.command || "";
  const files = opts.files || [];
  const baseEnv = opts.env || process.env;

  if (!PYTHON_TEST.test(command)) return { ok: true, reason: null, detail: null };

  const packages = srcPackages(cwd);
  if (packages.length === 0) return { ok: true, reason: null, detail: null };

  // Only the packages this diff actually edits. A binding problem in a package
  // the change does not touch is not this change's problem.
  const edited = packages.filter((name) =>
    files.some((f) => String(f).replace(/\\/g, "/").startsWith(`src/${name}/`))
  );
  if (edited.length === 0) return { ok: true, reason: null, detail: null };

  const { env: cmdEnv, interpreter } = parseCommand(command);
  if (!interpreter) return { ok: true, reason: null, detail: null };

  const probeEnv = { ...baseEnv, ...cmdEnv };
  const program =
    "import importlib.util,json,sys\n" +
    "out={}\n" +
    "for name in sys.argv[1:]:\n" +
    "    try:\n" +
    "        spec=importlib.util.find_spec(name)\n" +
    "        out[name]=spec.origin if spec else None\n" +
    "    except Exception:\n" +
    "        out[name]=None\n" +
    "print(json.dumps(out))\n";

  let parsed;
  try {
    const stdout = execFileSync(interpreter, ["-c", program, ...edited], {
      cwd,
      env: probeEnv,
      encoding: "utf-8",
      shell: false,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    parsed = JSON.parse(String(stdout).trim());
  } catch (_) {
    // No interpreter, an import that raises, anything at all: this is an
    // absence of evidence, not evidence. Say nothing.
    return { ok: true, reason: null, detail: null };
  }

  const auditedRoot = resolve(cwd);
  const mismatches = [];
  for (const name of edited) {
    const origin = parsed[name];
    // Not importable at all is not a binding failure — the suite will say so
    // itself, loudly, and reporting it here would double-count a real error.
    if (!origin || typeof origin !== "string") continue;

    // The test is not "inside the checkout" but "is the audited file".
    //
    // A virtualenv usually lives *in* the repository — `.venv/` at the root is
    // the near-universal convention — so `site-packages/pkg/__init__.py` is
    // inside the checkout while being precisely the installed copy F11 is
    // about. Anchoring on the source path instead is both stricter and
    // simpler: the package the diff edits must resolve to the file the diff
    // edits.
    const abs = resolve(origin);
    const expected = resolve(join(auditedRoot, "src", name));
    const rel = relative(expected, abs);
    const isAuditedSource = rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
    if (!isAuditedSource) mismatches.push({ package: name, resolvedTo: abs, expectedUnder: expected });
  }

  if (mismatches.length === 0) return { ok: true, reason: null, detail: null };

  const first = mismatches[0];
  return {
    ok: false,
    reason:
      `The verification command imports \`${first.package}\` from ${first.resolvedTo}, which is outside the ` +
      `code under review. The diff edits src/${first.package}/, so the suite exercised a different copy of ` +
      `this package — an installed one — and its result says nothing about this change. ` +
      `Bind the command to the source: prefix it with PYTHONPATH=src, install the package editable ` +
      `(pip install -e .), or set pythonpath = ["src"] under [tool.pytest.ini_options].`,
    detail: { mismatches },
  };
}
