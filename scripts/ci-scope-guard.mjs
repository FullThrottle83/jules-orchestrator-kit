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
import { normalizePath, canonicalizePath } from "../src/config.mjs";

/** Exit code 3 in the kit's registry: scope violation. */
const EXIT_SCOPE_VIOLATION = 3;
const EXIT_ERROR = 1;

/**
 * Primary label prefix that lets a human consciously land a protected-path change bound to commit SHA.
 * Conforms to GitHub's 50-character maximum label limit: "allow-p:<40-hex-SHA>" is 48 characters.
 */
export const BYPASS_LABEL = "allow-p";
export const LEGACY_BYPASS_LABEL = "allow-protected-paths";

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

/** Where a symlink at `link` pointing at `target` lands, as a repo-relative or absolute path. */
export function resolveLinkTarget(link, target) {
  const normLink = normalizePath(link);
  const normTarget = normalizePath(target);
  if (normTarget.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(target)) {
    return normTarget;
  }
  const linkDir = normLink.split("/").slice(0, -1).join("/");
  return canonicalizePath(linkDir ? `${linkDir}/${normTarget}` : normTarget);
}

/**
 * Parses `git diff --raw -z` output into structured file change entries.
 *
 * Each record emitted by `--raw -z` is:
 *   ":<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0"
 * (or two paths if renames were enabled). With `--no-renames`, it is always 1 path.
 *
 * For symlinks (mode 120000), retrieves the link target blob via `git cat-file blob <dstSha>`
 * without checking out the branch to disk.
 *
 * @param {string} raw - raw stdout from git diff --raw -z
 * @param {string} [root] - repo root cwd
 * @returns {Array<{ file: string, srcMode: string, dstMode: string, srcSha: string, dstSha: string, status: string, symlinkTarget?: string, symlinkUnreadable?: boolean }>}
 */
export function parseRawDiffEntries(raw, root = process.cwd()) {
  if (!raw || typeof raw !== "string") return [];
  const fields = raw.split("\0").filter((f) => f !== "");
  const entries = [];

  for (let i = 0; i < fields.length; i++) {
    const meta = fields[i];
    if (!meta.startsWith(":")) continue;
    const parts = meta.slice(1).split(/\s+/);
    const file = fields[i + 1];
    i += 1;
    if (!file) continue;

    const srcMode = parts[0] || "";
    const dstMode = parts[1] || "";
    const srcSha = parts[2] || "";
    const dstSha = parts[3] || "";
    const status = (parts[4] || "").charAt(0);

    let symlinkTarget = null;
    let symlinkUnreadable = false;

    if (dstMode === "120000") {
      if (dstSha && !/^0+$/.test(dstSha)) {
        try {
          const rawTarget = execFileSync("git", ["cat-file", "blob", dstSha], {
            cwd: root,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
          }).trim();
          if (rawTarget) {
            symlinkTarget = resolveLinkTarget(file, rawTarget);
          } else {
            symlinkUnreadable = true;
          }
        } catch (_) {
          symlinkUnreadable = true;
        }
      } else {
        symlinkUnreadable = true;
      }
    }

    entries.push({
      file: normalizePath(file),
      srcMode,
      dstMode,
      srcSha,
      dstSha,
      status,
      symlinkTarget,
      symlinkUnreadable,
    });
  }

  return entries;
}

/**
 * Lists the paths a pull request changes.
 *
 * Inspects `git diff --raw -z --no-renames` to capture all paths while
 * preserving spaces and non-ASCII characters without quoting corruption.
 *
 * @param {{ baseSha: string, headSha: string, root?: string }} opts
 * @returns {string[]}
 */
export function listChangedFiles(opts = {}) {
  return listChangedEntries(opts).map((e) => e.file);
}

/**
 * Returns raw diff entries including blob mode and symlink resolution.
 *
 * @param {{ baseSha: string, headSha: string, root?: string }} opts
 * @returns {Array<{ file: string, srcMode: string, dstMode: string, srcSha: string, dstSha: string, status: string, symlinkTarget?: string, symlinkUnreadable?: boolean }>}
 */
export function listChangedEntries(opts = {}) {
  const root = opts.root || process.cwd();
  const raw = execFileSync(
    "git",
    ["-c", "core.quotePath=false", "diff", "-z", "--raw", "--no-renames", opts.baseSha, opts.headSha],
    { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 }
  );
  return parseRawDiffEntries(raw, root);
}

/**
 * Pure evaluation core, so the decision is testable without a git repository.
 *
 * Evaluates changed files and entries against protected patterns:
 * - Rejects Git submodules (mode 160000)
 * - Evaluates symlinks (mode 120000): rejects traversal / root escape, fails closed on unreadable targets,
 *   and fails if the resolved symlink target points to a protected file.
 *
 * @param {Array<string|object>} filesOrEntries
 * @param {string[]} patterns
 * @param {{ labels?: string[], headSha?: string, symlinks?: Array<{ link: string, target: string }> }} [opts]
 * @returns {{ ok: boolean, bypassed: boolean, violations: Array<object> }}
 */
export function evaluateScopeGuard(filesOrEntries = [], patterns = [], opts = {}) {
  const labels = (opts.labels || []).map((l) => String(l).toLowerCase().trim());
  const headSha = String(opts.headSha || "").trim().toLowerCase();

  let bypassed = false;
  if (headSha) {
    if (/^[0-9a-f]{40}$/i.test(headSha)) {
      const boundLabel = `${BYPASS_LABEL}:${headSha}`;
      const legacyBoundLabel = `${LEGACY_BYPASS_LABEL}:${headSha}`;
      bypassed = labels.includes(boundLabel) || labels.includes(legacyBoundLabel);
    }
  } else {
    bypassed = labels.includes(BYPASS_LABEL) || labels.includes(LEGACY_BYPASS_LABEL);
  }

  const normalizedEntries = [];
  for (const item of filesOrEntries) {
    if (typeof item === "string") {
      normalizedEntries.push({ file: item });
    } else if (item && typeof item === "object") {
      normalizedEntries.push(item);
    }
  }

  if (Array.isArray(opts.symlinks)) {
    for (const s of opts.symlinks) {
      if (s && s.link) {
        normalizedEntries.push({
          file: s.link,
          dstMode: "120000",
          symlinkTarget: s.target || null,
        });
      }
    }
  }

  const explicitViolations = [];
  const scopeCandidates = [];
  const symlinkTargetOf = new Map();

  for (const entry of normalizedEntries) {
    const file = entry.file || "";
    if (file) {
      scopeCandidates.push(file);
    }

    // 1. Refuse Git submodules (mode 160000)
    if (entry.dstMode === "160000") {
      explicitViolations.push({
        file,
        reason: "Git submodule (mode 160000) is forbidden in agent pull requests",
        rule: "deny",
        pattern: "<submodule>",
      });
      continue;
    }

    // 2. Inspect Symlinks (mode 120000)
    if (entry.dstMode === "120000") {
      if (entry.symlinkUnreadable || !entry.symlinkTarget) {
        explicitViolations.push({
          file,
          reason: "Unreadable or empty symlink target cannot be verified",
          rule: "deny",
          pattern: "<unreadable-symlink>",
        });
        continue;
      }

      const target = entry.symlinkTarget;
      scopeCandidates.push(target);
      symlinkTargetOf.set(target, file);
    }
  }

  // Matching always runs at full strength; the label only decides whether a
  // match blocks. Passing `allowProtected` into checkScope instead would make
  // a bypassed run report zero violations, and the job log is the record of
  // what a human waved through.
  const res = checkScope(scopeCandidates, { protect: patterns }, { allowProtected: false });

  const mappedScopeViolations = (res.violations || []).map((v) => {
    const link = symlinkTargetOf.get(v.file);
    if (link) {
      return {
        ...v,
        link,
        file: link,
        target: v.file,
        reason: `Symlink "${link}" -> "${v.file}": ${v.reason}`,
      };
    }
    return v;
  });

  const allViolations = [...explicitViolations, ...mappedScopeViolations];
  return { ok: bypassed || allViolations.length === 0, bypassed, violations: allViolations };
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
  let entries = [];
  try {
    patterns = loadProtectedPatterns({ baseSha, baseRef, root });
    entries = listChangedEntries({ baseSha, headSha, root });
  } catch (err) {
    console.error(`::error::Agent Scope Guard could not evaluate this pull request: ${err.message}`);
    process.exit(EXIT_ERROR);
  }

  const labels = parseLabels(process.env.PR_LABELS);
  const result = evaluateScopeGuard(entries, patterns, { labels, headSha });

  console.log(`Protected patterns (${patterns.length}): ${patterns.join(", ")}`);
  console.log(`Changed files (${entries.length}):`);
  for (const e of entries) {
    if (e.dstMode === "120000") {
      console.log(`  ${e.file} -> ${e.symlinkTarget || "(unresolved)"} [symlink]`);
    } else if (e.dstMode === "160000") {
      console.log(`  ${e.file} [submodule]`);
    } else {
      console.log(`  ${e.file}`);
    }
  }

  const labelName = headSha ? `${BYPASS_LABEL}:${headSha}` : BYPASS_LABEL;
  const legacyLabelName = headSha ? `${LEGACY_BYPASS_LABEL}:${headSha}` : LEGACY_BYPASS_LABEL;
  const activeLabel = labels.includes(labelName)
    ? labelName
    : labels.includes(legacyLabelName)
      ? legacyLabelName
      : labelName;

  if (result.bypassed && result.violations.length > 0) {
    for (const v of result.violations) {
      console.log(`::warning file=${v.file}::Protected path modified under "${activeLabel}": ${v.reason}`);
    }
    console.log(`\nLabel "${activeLabel}" is present — ${result.violations.length} protected-path match(es) allowed by human review.`);
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
      `Apply the "${labelName}" label after human review to land this intentionally.`
  );
  process.exit(EXIT_SCOPE_VIOLATION);
}

if (process.argv[1] && process.argv[1].endsWith("ci-scope-guard.mjs")) {
  main();
}
