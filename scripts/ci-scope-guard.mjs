#!/usr/bin/env node
/**
 * CI Agent Scope Guard.
 *
 * Evaluates the files a pull request touches against the protected-paths
 * manifest and fails the job when an agent has edited one of them.
 *
 * This exists as a Node entry point rather than inline shell because the shell
 * version had to reimplement glob matching, and its glob-to-regex `sed`
 * expression was invalid (`s/\*​/[^/]*​/g` — the `/` inside the character class
 * closes the substitution). Under `bash -e` that aborted the step on the first
 * modified file, so the guard never actually evaluated anything. Reusing
 * `checkScope` removes the second implementation entirely: deny/protect
 * matching now behaves identically in CI and locally, including the deliberate
 * case-folding that a hand-rolled bash regex did not have.
 */
import { execFileSync } from "node:child_process";
import { checkScope } from "../src/security.mjs";
import { normalizePath } from "../src/config.mjs";

/** Exit code 3 in the kit's registry: scope violation. */
const EXIT_SCOPE_VIOLATION = 3;
const EXIT_ERROR = 1;

/** Label that lets a human consciously land a protected-path change. */
export const BYPASS_LABEL = "allow-protected-paths";

function gitShow(ref, path, cwd) {
  return execFileSync("git", ["show", `${ref}:${path}`], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Reads the protected-paths manifest from the PR's *base* commit.
 *
 * Reading it from the head would let a pull request delete its own guard in the
 * same diff it uses to edit a protected file, so the base commit is the only
 * safe source. `baseSha` is preferred over `origin/<branch>` because the branch
 * ref can advance mid-run while the SHA is pinned to what this PR targets.
 *
 * @param {{ baseSha?: string, baseRef?: string, root?: string }} opts
 * @returns {string[]}
 */
export function loadProtectedPatterns(opts = {}) {
  const root = opts.root || process.cwd();
  const manifestPath = ".agent/protected-paths.json";
  const refs = [opts.baseSha, opts.baseRef ? `origin/${opts.baseRef}` : "", opts.baseRef].filter(Boolean);

  let lastErr = null;
  for (const ref of refs) {
    try {
      const parsed = JSON.parse(gitShow(ref, manifestPath, root));
      const patterns = Array.isArray(parsed.protected) ? parsed.protected.filter((p) => typeof p === "string" && p) : [];
      if (patterns.length === 0) {
        throw new Error(`${manifestPath} at ${ref} lists no protected patterns`);
      }
      return patterns;
    } catch (err) {
      lastErr = err;
    }
  }

  // Fail closed: an unreadable manifest means the guard cannot make a decision,
  // and "cannot decide" must never render as "approved".
  throw new Error(
    `Unable to read ${manifestPath} from any of [${refs.join(", ")}]: ${lastErr ? lastErr.message : "no refs supplied"}`
  );
}

/**
 * Lists the paths a pull request changes.
 *
 * `-z` and `core.quotePath=false` matter here: without them git splits on
 * whitespace and octal-escapes non-ASCII names, so `docs/min plan.md` and
 * `säkerhet/nyckel.pem` arrive as tokens that match no pattern — a protected
 * file walking past the guard because of how it is spelled.
 *
 * @param {{ baseSha: string, headSha: string, root?: string }} opts
 * @returns {string[]}
 */
export function listChangedFiles(opts = {}) {
  const root = opts.root || process.cwd();
  const raw = execFileSync(
    "git",
    ["-c", "core.quotePath=false", "diff", "-z", "--name-only", opts.baseSha, opts.headSha],
    { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 }
  );
  return raw.split("\0").map(normalizePath).filter(Boolean);
}

/**
 * Pure evaluation core, so the decision is testable without a git repository.
 *
 * @param {string[]} files
 * @param {string[]} patterns
 * @param {{ labels?: string[] }} [opts]
 * @returns {{ ok: boolean, bypassed: boolean, violations: Array<object> }}
 */
export function evaluateScopeGuard(files = [], patterns = [], opts = {}) {
  const labels = (opts.labels || []).map((l) => String(l).toLowerCase().trim());
  const bypassed = labels.includes(BYPASS_LABEL);

  // Matching always runs at full strength; the label only decides whether a
  // match blocks. Passing `allowProtected` into checkScope instead would make
  // a bypassed run report zero violations, and the job log is the record of
  // what a human waved through.
  const res = checkScope(files, { protect: patterns }, { allowProtected: false });
  return { ok: bypassed || res.ok, bypassed, violations: res.violations };
}

/**
 * Parses the labels payload GitHub Actions exposes for a pull request.
 * Accepts the raw `toJSON(...labels)` array or a plain comma-separated string.
 *
 * @param {string} raw
 * @returns {string[]}
 */
export function parseLabels(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((l) => (typeof l === "string" ? l : l && l.name) || "").filter(Boolean);
    }
  } catch (_) {}
  return text.split(",").map((s) => s.trim()).filter(Boolean);
}

function main() {
  const root = process.cwd();
  const baseSha = (process.env.BASE_SHA || "").trim();
  const headSha = (process.env.HEAD_SHA || "").trim();
  const baseRef = (process.env.BASE_REF || "").trim();

  if (!baseSha || !headSha) {
    console.error("::error::BASE_SHA and HEAD_SHA must be set. This guard only runs on pull_request events.");
    process.exit(EXIT_ERROR);
  }

  let patterns;
  let files;
  try {
    patterns = loadProtectedPatterns({ baseSha, baseRef, root });
    files = listChangedFiles({ baseSha, headSha, root });
  } catch (err) {
    console.error(`::error::Agent Scope Guard could not evaluate this pull request: ${err.message}`);
    process.exit(EXIT_ERROR);
  }

  const labels = parseLabels(process.env.PR_LABELS);
  const result = evaluateScopeGuard(files, patterns, { labels });

  console.log(`Protected patterns (${patterns.length}): ${patterns.join(", ")}`);
  console.log(`Changed files (${files.length}):`);
  for (const f of files) console.log(`  ${f}`);

  if (result.bypassed && result.violations.length > 0) {
    for (const v of result.violations) {
      console.log(`::warning file=${v.file}::Protected path modified under "${BYPASS_LABEL}": ${v.reason}`);
    }
    console.log(`\nLabel "${BYPASS_LABEL}" is present — ${result.violations.length} protected-path match(es) allowed by human review.`);
    process.exit(0);
  }

  if (result.ok) {
    console.log("\nScope check passed. No protected files were modified.");
    process.exit(0);
  }

  for (const v of result.violations) {
    console.error(`::error file=${v.file}::Protected path violation: ${v.reason}`);
  }
  console.error(
    `::error::PR modifies ${result.violations.length} protected file(s). ` +
      `Apply the "${BYPASS_LABEL}" label after human review to land this intentionally.`
  );
  process.exit(EXIT_SCOPE_VIOLATION);
}

if (process.argv[1] && process.argv[1].endsWith("ci-scope-guard.mjs")) {
  main();
}
