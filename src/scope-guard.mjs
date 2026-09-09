/**
 * Scope policy: which paths an agent may touch.
 *
 * Split out of src/security.mjs (P05). The glob matcher, the deny/protect
 * matching and checkScope() form one job — deciding whether a path is inside the
 * allowed scope — and none of it reads a diff or looks for a secret. The glob
 * matcher is deliberately regex-free and is imported by assertions.mjs, risk.mjs,
 * router.mjs and self-audit.mjs as well as by the scope rules below.
 */

import { basename } from "node:path";
import { canonicalizePath, isWindowsAbsolutePath } from "./config.mjs";

/**
 * Glob matcher.
 *
 * `caseInsensitive` exists because the same repository is checked out on
 * Linux, macOS and Windows. On APFS and NTFS, `.GitHub/` and `.github/` are
 * the *same directory*, but git records whichever case was committed — so a
 * case-sensitive deny rule can be walked straight past on two of the three
 * target platforms. Deny and protect matching therefore folds case; allow
 * matching deliberately does not, so that a case mismatch fails closed
 * (unmatched by allow = violation) rather than opening a hole.
 *
 * @param {string} filePath
 * @param {string} globPattern
 * @param {{ caseInsensitive?: boolean }} [opts]
 */
/**
 * Matches one `/`-free glob segment against one `/`-free path segment.
 *
 * Only `*` (zero or more characters) and `?` (exactly one) are special; every
 * other character — including regex metacharacters like `(`, `+`, `.`, `[` —
 * is matched literally, preserving the escaping behaviour the old regex
 * translation had. A segment that is exactly `*` keeps its historical one-or-
 * more semantics, so `*` cannot match an empty segment.
 *
 * Implemented with the classic greedy-star wildcard algorithm rather than a
 * compiled regex: a segment like `*a*a*a*a*a*a*b` translated to
 * `^[^/]*a[^/]*a…$` and backtracked exponentially on a long run of `a`s, so
 * this path must never build a regex. The algorithm scans each character a
 * bounded number of times and cannot blow up the way the regex could.
 *
 * @param {string} str
 * @param {string} pattern
 * @param {boolean} [caseInsensitive]
 * @returns {boolean}
 */
function matchGlobSegment(str, pattern, caseInsensitive = false) {
  if (pattern === "*") return str.length > 0;

  let s = caseInsensitive ? str.toLowerCase() : str;
  let p = caseInsensitive ? pattern.toLowerCase() : pattern;

  let si = 0;
  let pi = 0;
  let star = -1;
  let matchIdx = 0;

  while (si < s.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === s[si])) {
      si++;
      pi++;
    } else if (pi < p.length && p[pi] === "*") {
      star = pi;
      matchIdx = si;
      pi++;
    } else if (star !== -1) {
      pi = star + 1;
      matchIdx++;
      si = matchIdx;
    } else {
      return false;
    }
  }

  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}

/**
 * Linear-time glob matcher over `/`-split segments.
 *
 * `**` matches zero or more whole segments; every other pattern segment
 * matches exactly one path segment via `matchGlobSegment`. This is a
 * bottom-up dynamic program with a rolling array: O(n·m) time and O(m) memory
 * for n path and m pattern segments, and it builds no regex at all.
 *
 * The previous implementation translated `**` into overlapping dot-star and
 * start-anchored `(?: … |^)` alternations (`SEC-01`). Anchored against `$`, a
 * pattern like `*a*a*a*a*a*a*a*a*b` or a chain of globstars caused catastrophic
 * backtracking — the match time grew exponentially with input length and a
 * hostile deny rule or file list could stall the dispatch gate. The DP
 * replaces every one of those constructs with a bounded scan.
 *
 * @param {string[]} pathSegs
 * @param {string[]} patSegs
 * @param {boolean} [caseInsensitive]
 * @returns {boolean}
 */
function matchGlobSegments(pathSegs, patSegs, caseInsensitive = false) {
  const n = pathSegs.length;
  const m = patSegs.length;

  // next[j] answers "does pathSegs[i+1..] match patSegs[j..]?". Seeded for the
  // empty-path row (i = n): only true when every remaining pattern segment is
  // `**`, since those are the only segments that can match zero path segments.
  let next = new Array(m + 1).fill(false);
  next[m] = true;
  for (let j = m - 1; j >= 0; j--) {
    next[j] = patSegs[j] === "**" && next[j + 1];
  }

  for (let i = n - 1; i >= 0; i--) {
    const cur = new Array(m + 1).fill(false);
    // cur[m] stays false: a path segment remains but the pattern is exhausted.
    for (let j = m - 1; j >= 0; j--) {
      if (patSegs[j] === "**") {
        // Consume this segment and keep `**` (next[j]), or match zero segments
        // and move on (cur[j + 1]).
        cur[j] = next[j] || cur[j + 1];
      } else if (matchGlobSegment(pathSegs[i], patSegs[j], caseInsensitive)) {
        cur[j] = next[j + 1];
      }
    }
    next = cur;
  }

  return next[0];
}

export function matchesGlob(filePath, globPattern, opts = {}) {
  if (!filePath || !globPattern) return false;
  const file = canonicalizePath(filePath);
  const pattern = canonicalizePath(globPattern);
  const caseInsensitive = Boolean(opts.caseInsensitive);

  if (caseInsensitive ? file.toLowerCase() === pattern.toLowerCase() : file === pattern) return true;

  return matchGlobSegments(file.split("/"), pattern.split("/"), caseInsensitive);
}

export function isForbiddenPath(filePath, config = {}) {
  const normFile = canonicalizePath(filePath);
  const forbidden = config.scope?.deny || config.forbidden_paths || [];
  return forbidden.some((pattern) => matchesGlob(normFile, pattern, { caseInsensitive: true }));
}

/**
 * The builtin deny patterns that exist to keep credentials out of a diff, and
 * the documented template filenames those patterns must not catch.
 *
 * The recursive dot-env glob is correct for `.env.local` and `.env.production`
 * and wrong for `.env.example` — a file nearly every repository commits
 * precisely so the environment can be documented without the values. Denying it
 * meant no agent could ever be asked to document a new variable, in any project.
 *
 * The exemption is deliberately narrow. It applies only when one of the two
 * *builtin* patterns matched: a repository that writes its own broader dot-env
 * deny rule blocks templates too, because the pattern string is not one of
 * these. And the diff secret scanner runs over every changed file regardless of
 * scope, so a real credential pasted into a template still fails on exit 6.
 */
const BUILTIN_ENV_DENY_PATTERNS = new Set(["**/.env", "**/.env.*"]);
export const ENV_TEMPLATE_BASENAMES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.dist",
  ".env.defaults",
]);

/**
 * True when a deny hit is the builtin credential rule catching a committed
 * environment *template* rather than an environment file.
 *
 * @param {string} file - canonicalised repo-relative path
 * @param {string} pattern - the deny pattern that matched
 * @returns {boolean}
 */
export function isEnvTemplateException(file, pattern) {
  if (!BUILTIN_ENV_DENY_PATTERNS.has(pattern)) return false;
  const name = basename(file).toLowerCase();
  if (ENV_TEMPLATE_BASENAMES.has(name)) return true;
  // `.env.production.example`, `.env.test.sample`, ... — the documented-template
  // suffix is what matters, not how many environment segments precede it.
  return /^\.env\..+\.(example|sample|template|dist|defaults)$/.test(name);
}

export function checkScope(files = [], scope = {}, opts = {}) {
  const violations = [];
  const deny = scope.deny || [];
  const allow = scope.allow || [];
  const protect = scope.protect || [];

  for (const rawFile of files) {
    // Canonicalised so that "./x", "a/../x" and "a//x" cannot present the same
    // file under a spelling the deny patterns do not literally match.
    const file = canonicalizePath(rawFile);

    // A path that climbs out of the repository root can never be legitimate and
    // must not be silently pattern-matched against repo-relative rules. This
    // covers every spelling: POSIX absolute (`/etc/passwd`) and traversal
    // (`../`, `..`), Windows drive-qualified and drive-relative (`C:\...`,
    // `C:/...`, `C:foo`), and UNC (`\\server\share`, `//server/share`). The raw
    // spelling is checked as well as the canonical one, because canonicalisation
    // folds a leading `//` UNC into `/` and the check must fail on both.
    if (
      file === ".." ||
      file.startsWith("../") ||
      file.startsWith("/") ||
      isWindowsAbsolutePath(rawFile) ||
      isWindowsAbsolutePath(file)
    ) {
      violations.push({ file, reason: "Path escapes the repository root", rule: "deny", pattern: "<traversal>" });
      continue;
    }

    // Deny folds case: on macOS/Windows ".GitHub/" resolves to the same
    // directory as ".github/", so a case-sensitive deny is bypassable there.
    const matchedDeny = deny.find((pat) => matchesGlob(file, pat, { caseInsensitive: true }));
    if (matchedDeny && !isEnvTemplateException(file, matchedDeny)) {
      violations.push({ file, reason: `Forbidden path restriction matched pattern "${matchedDeny}"`, rule: "deny", pattern: matchedDeny });
      continue;
    }

    // Allow stays case-sensitive on purpose: a case mismatch here yields "not
    // allowed" (a violation), which is the fail-closed direction.
    if (allow.length > 0) {
      const isExplicitlyAllowed = allow.some((pat) => matchesGlob(file, pat));
      if (!isExplicitlyAllowed) {
        violations.push({ file, reason: "Path not included in allowed paths list", rule: "allow" });
        continue;
      }
    }

    if (!opts.allowProtected) {
      const matchedProtect = protect.find((pat) => matchesGlob(file, pat, { caseInsensitive: true }));
      if (matchedProtect) {
        violations.push({ file, reason: `Protected file modification restriction matched pattern "${matchedProtect}"`, rule: "protect", pattern: matchedProtect });
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}
