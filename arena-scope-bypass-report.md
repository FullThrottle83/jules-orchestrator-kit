# Scope Guard Bypass Audit — `arena-scope-bypass-report.md`

**Repository:** `FullThrottle83/jules-orchestrator-kit`
**Base commit:** `1d176f85c9c42de548e74ac6fdf87c3fbae330cb` (`main`)
**Date:** 2026-09-30
**Runtime:** Node.js v22.22.3 (ESM, zero dependencies), git 2.39.5, Linux
**Probe:** `node arena-scope-bypass-test.mjs` → exit 0, 32/32 cases matched predictions (0 unexpected, 0 skipped)
**Regression check:** `npm test` → green (no existing file modified; this probe is not part of `test/`)

---

## 1. Scope & method

The audit targets the path validation behind `scripts/ci-scope-guard.mjs`:

```
raw `git diff -z --name-only <base> <head>`
  → raw.split("\0").map(normalizePath).filter(Boolean)          [listChangedFiles, ci-scope-guard.mjs:95]
  → checkScope(files, { protect: patterns }, { allowProtected: false })   [evaluateScopeGuard]
  → matchesGlob(file, pattern, { caseInsensitive: true })        [src/scope-guard.mjs:132]
      ↳ canonicalizePath() on both sides                          [src/config.mjs:266]
      ↳ matchGlobSegment() — regex-free greedy-star DP            [src/scope-guard.mjs:49, 101]
```

* Protect patterns: the real 14-pattern list from `.agent/protected-paths.json` (read-only; never modified).
* Each vector is fed a **mocked git diff output** (NUL-joined string) through a byte-for-byte replica of
  `listChangedFiles`' parsing, then into `checkScope` — imported from `src/security.mjs`, as are
  `matchesGlob` (direct probes). Where mock output alone cannot prove pipeline behaviour, the probe
  builds a throwaway git repository under `os.tmpdir()` and runs the guard's **exact** command
  (`git -c core.quotePath=false diff -z --name-only <base> <head>`).
* Vectors the pure-ASCII manifest cannot express (NFC/NFD, full case folding) are additionally probed
  against clearly-labelled **synthetic** patterns: `docs/café.md` (NFC), `security/Straße.md`,
  `docs/İstanbul.md`. These are *not* in the manifest; they document latent matcher behaviour.
* Verdict key: **CAUGHT** = `checkScope` rejected the spelling (correct rejection);
  **BYPASSED** = the guard passed it.
* **No existing file was changed.** The only additions are this report and `arena-scope-bypass-test.mjs`.

---

## 2. Pass/fail matrix

### Vector a — Symlink traversal (diff name ≠ protected target)

| Case | Input spelling (diff name) | Target | Verdict | Matched rule |
|---|---|---|---|---|
| a1 | `docs/manifest-link.json` (symlink) | `.agent/protected-paths.json` | **BYPASSED** | — (no pattern matched; `matchesGlob(name, target-pattern)=false`) |
| a2 | `guard/workflows/agent-scope-guard.yml` (`guard` → `.github/`) | `.github/workflows/agent-scope-guard.yml` ∈ `.github/**` | **BYPASSED** | — (realpath of target *would* match `.github/**`) |
| a3 — real git | edit **through** `docs/link.json` → `../package.json`, guard's exact diff cmd | `package.json` | **CAUGHT** | `protect:package.json` (git reported `["package.json"]`) |

**Reading:** `src/scope-guard.mjs` performs no filesystem access (its only import beyond `./config.mjs`
is `basename` from `node:path`), so link targets are never resolved — a1/a2 are genuine function-layer
bypasses. But git itself reports the *real* path when a file's content changes through a link (a3), so
the production CI pipeline self-corrects. Residual risk sits with the other `checkScope` callers that
accept agent-supplied paths (`src/envelope.mjs:106`, `src/task-optimizer.mjs:201`, `src/engine.mjs:203`),
where no git re-reporting exists.

### Vector b — Unicode normalisation (NFC/NFD)

| Case | Input (file) | Pattern | Verdict | Note |
|---|---|---|---|---|
| b1 | `docs/café.md` **NFD** | `docs/café.md` NFC (synthetic) | **BYPASSED** | `matchesGlob(NFD, NFC)=false` |
| b2 | `docs/café.md` NFC (control) | same (synthetic) | **CAUGHT** | `protect:docs/café.md` |
| b3 | `package.json` NFD-normalised | real manifest | **CAUGHT** | `protect:package.json` — ASCII is NFC==NFD, the current manifest is structurally immune |

### Vector c — Case folding

| Case | Input | Pattern | Verdict | Note |
|---|---|---|---|---|
| c1 | `PACKAGE.JSON` | `package.json` (real) | **CAUGHT** | `protect:package.json` |
| c2 | `.GitHub/workflows/agent-scope-guard.yml` | `.github/**` (real) | **CAUGHT** | `protect:.github/**` |
| c3 | `SCRIPTS\CI-SCOPE-GUARD.MJS` (case + separator) | `scripts/ci-scope-guard.mjs` (real) | **CAUGHT** | `protect:scripts/ci-scope-guard.mjs` |
| c4 | `security/STRASSE.md` | `security/Straße.md` (synthetic) | **BYPASSED** | `toLowerCase()` ≠ full case fold: `"strasse" !== "straße"` |
| c5 | `docs/istanbul.md` | `docs/İstanbul.md` (synthetic) | **BYPASSED** | `"İstanbul".toLowerCase() === "i̇stanbul"` (i + U+0307) ≠ `"istanbul"` |

**Reading:** ASCII case folding works exactly as designed (deny/protect fold, allow stays
case-sensitive). The gap is *Unicode* full case folding (ß↔SS, dotted İ), latent behind the ASCII-only
manifest.

### Vector d — Path separators (backslash vs slash)

| Case | Input | Pattern (real manifest) | Verdict |
|---|---|---|---|
| d1 | `scripts\ci-scope-guard.mjs` | `scripts/ci-scope-guard.mjs` | **CAUGHT** |
| d2 | `.github\workflows\ci.yml` | `.github/**` | **CAUGHT** |
| d3 | `.agent\protected-paths.json` | `.agent/protected-paths.json` | **CAUGHT** |
| d4 | `..\.agent\protected-paths.json` | (traversal) | **CAUGHT** — `deny:<traversal>` |
| d5 | direct `matchesGlob("scripts\\ci-scope-guard.mjs", "scripts/ci-scope-guard.mjs", {caseInsensitive:true})` | — | **CAUGHT** (`true`) |

**No bypass found.** `normalizePath` (`src/config.mjs:223`) folds `\`→`/` inside `listChangedFiles`,
and `canonicalizePath` folds it again inside `checkScope` **and** inside `matchesGlob` on both
arguments — the separator is neutralised at three independent layers.

### Vector e — Dot-dot traversal

| Case | Input | Verdict | Matched rule |
|---|---|---|---|
| e1 | `foo/../.agent/protected-paths.json` | **CAUGHT** | `protect:.agent/protected-paths.json` (resolved first) |
| e2 | `../.agent/protected-paths.json` | **CAUGHT** | `deny:<traversal>` (leading `..` preserved → escape) |
| e3 | `.agent/jules.yml/../../package.json` | **CAUGHT** | `protect:package.json` (resolved first) |
| e4 | `./package.json` | **CAUGHT** | `protect:package.json` |
| e5 | `.agent//protected-paths.json` | **CAUGHT** | `protect:.agent/protected-paths.json` |
| e6 | `package.json/..` → canonicalises to `""` | **BYPASSED** | — (no rule rejects the empty path) |

**Reading:** lexical resolution in `canonicalizePath` closes the mandated `foo/../…` vector completely.
e6 is an edge case: `checkScope` has no `file === ""` rejection, and `filter(Boolean)` in
`listChangedFiles` runs *before* canonicalisation (so `.` and `x/..` survive it). git never emits these
spellings, so it is unreachable through the CI pipeline — recorded for completeness.

### Vector f — NUL-byte injection

| Case | Shape | Verdict | Note |
|---|---|---|---|
| f1 | `"package.json\u0000.md"` fed **directly** to `checkScope` (non-git caller shape: `src/envelope.mjs:106`, `src/task-optimizer.mjs:201`) | **BYPASSED** | NUL is an ordinary character — no C-style truncation, no rejection. Exploitation needs a downstream NUL-truncating consumer; git cannot produce such a name (NUL is impossible in git pathnames). |
| f2 | raw diff **stream** `docs/ok.mjs\0package.json\0src/thing.mjs` | **CAUGHT** | `protect:package.json` — splitting on `\0` can only *create* entries, never hide a protected name after an injected NUL. |
| f3 | raw stream `\0\0package.json\0` | **CAUGHT** | empty tokens are dropped by `filter(Boolean)`; the protected name survives. |

### Vector g — git `core.quotePath` exploitation

| Case | Input | Pattern | Verdict |
|---|---|---|---|
| g1 | `"package.json"` (git-quoted spelling) | `package.json` (real) | **BYPASSED** — the matcher never unquotes |
| g2 | `"docs/caf\303\251.md"` (octal-escaped, as `quotePath=true` emits) | `docs/café.md` NFC (synthetic) | **BYPASSED** |
| g2b | `docs/café.md` verbatim (control) | same | **CAUGHT** |
| g3a — real git | plain `git diff --name-only` (default quotePath, no `-z`) on a protected unicode name → `"docs/caf\303\251.md"` | synthetic | **BYPASSED** |
| g3b — real git | the guard's exact command (`-c core.quotePath=false -z`) → `docs/café.md` | synthetic | **CAUGHT** |

**Reading:** `checkScope`/`matchesGlob` contain **no unquoting step**, so any quoted/octal spelling that
reaches them passes. The production pipeline is protected *upstream*: `listChangedFiles`
(`ci-scope-guard.mjs:92`) passes both `-z` (git then emits paths verbatim, quoting never happens —
verified g3b) and `core.quotePath=false` (defence in depth for any non-`-z` consumer). Additionally,
all 14 real manifest patterns are plain ASCII without quotes/backslashes/control characters, which
git never quotes even at `quotePath=true`.

### Vector h (bonus) — Rename-away from a protected path — **OPEN PIPELINE FINDING**

| Case | Command | Verdict | git reported |
|---|---|---|---|
| h1 | guard's exact cmd, git's default rename detection **on**: `git mv package.json docs/renamed.json` | **BYPASSED** | `["docs/renamed.json"]` — the protected source name never appears |
| h2 | same range with `--no-renames` (control) | **CAUGHT** | `["docs/renamed.json","package.json"]` → `protect:package.json` |

Observed while building the mandated vectors (not requested, but verified end-to-end with the exact
production command). `git diff --name-only` with rename detection — git's default since 2.9, and not
disabled anywhere in `ci-scope-guard.mjs` — reports **only the destination** of a rename, so *moving a
protected file out of its protected path sails through the guard*. Notably, `src/git.mjs:591–622`
passes `--no-renames` on every comparable listing, so the codebase already knows about this class of
bug; the CI guard simply lacks the flag.

---

## 3. Exact patterns that missed

`matchesGlob` is deliberately **regex-free** (its docstring: the regex translation of `**` caused
catastrophic backtracking — SEC-01), so there is no regex source to quote; the failing comparisons are
literal glob/segment matches. For each bypass, the precise miss:

| # | Missed protect pattern | Input that got through | Why it missed | Location |
|---|---|---|---|---|
| 1 | `.agent/protected-paths.json`, `.github/**` (any pattern) | `docs/manifest-link.json`, `guard/workflows/…` (symlinks) | No filesystem access anywhere in the matcher — `src/scope-guard.mjs` imports only `basename` + config helpers; link targets are never resolved | `src/scope-guard.mjs:132` (`matchesGlob`), `:254` (`checkScope`) |
| 2 | `docs/café.md` (NFC, synthetic) | `docs/café.md` NFD (`cafe\u0301`) | `canonicalizePath` normalises separators/`.`/`..` but performs **no Unicode normalisation**; segment compare is raw code-unit equality: `matchGlobSegment("cafe\u0301.md","café.md")` → false | `src/config.mjs:266`, `src/scope-guard.mjs:49` |
| 3 | `security/Straße.md`, `docs/İstanbul.md` (synthetic), with `caseInsensitive: true` | `security/STRASSE.md`, `docs/istanbul.md` | Case folding is `String.prototype.toLowerCase()` only — not Unicode full case folding: `"STRASSE".toLowerCase()="strasse" ≠ "straße"`; `"İstanbul".toLowerCase()="i̇stanbul" ≠ "istanbul"` | `src/scope-guard.mjs:57–58` |
| 4 | `package.json` | `"package.json"` (quoted), `"\160\141\143\153\141\147\145.json"` (octal) | Matcher is literal; no unquote/`core.quotePath` decoder exists in `checkScope`/`matchesGlob` | `src/scope-guard.mjs:132`, `:254` |
| 5 | `package.json` | `package.json\u0000.md` | NUL is not special: not truncated, not rejected, no rule inspects for `\u0000` | `src/scope-guard.mjs:49`, `:254` |
| 6 | all (via empty canonical path) | `package.json/..`, `.` → `""` | `canonicalizePath` can return `""`; `checkScope` has no empty-path rejection and `matchesGlob` returns `false` for falsy input | `src/config.mjs:266`, `src/scope-guard.mjs:133` |
| 7 | `package.json` (pipeline-level) | destination path of `git mv package.json docs/renamed.json` | `listChangedFiles` runs `git diff -z --name-only` **without `--no-renames`**; rename detection omits the source side | `scripts/ci-scope-guard.mjs:92` (contrast `src/git.mjs:591`) |

Patterns that **never missed** (all spellings CAUGHT): every ASCII case-folding variant, every
backslash-separator variant, every resolvable `..`/`.`/`//` variant, and NUL-padded diff streams.

---

## 4. Difficulty rating per vector

Difficulty = effort for an attacker to get a *protected-file modification* past the **production CI
pipeline** (not just past the pure function).

| Vector | Function-layer verdict | Pipeline verdict (real git) | Attacker difficulty | Severity if exploited | Status |
|---|---|---|---|---|---|
| **a** Symlink | BYPASSED (lexical) | **CAUGHT** (git reports real target path, a3) | **High** — needs a caller that reports the link path (non-git `checkScope` consumers) | Medium | Design-limited; mitigated in CI |
| **b** NFC/NFD | BYPASSED (synthetic) | CAUGHT today (manifest is ASCII) | **Medium** — requires a non-ASCII protect pattern *and* an NFD spelling (macOS/HFS+ checkout) | Medium once preconditions exist | Latent |
| **c** ASCII case | CAUGHT (all) | CAUGHT | Trivial attempt, **blocked** | — | Sound |
| **c** Unicode case fold | BYPASSED (synthetic) | Latent (same precondition as b) | **Medium** | Medium once preconditions exist | Latent |
| **d** Separators | CAUGHT (all 5) | CAUGHT | Trivial attempt, **blocked** (3 layers) | — | Sound |
| **e** Dot-dot | CAUGHT (e6 edge bypass) | CAUGHT (e6 unreachable via git) | **High** (no realistic input) | Info | Sound; e6 fail-open edge |
| **f** NUL | BYPASSED direct / CAUGHT stream | CAUGHT (git pathnames cannot contain NUL) | **High** — needs a NUL-truncating consumer of agent-supplied paths | Low–Medium | Pipeline sound; direct callers should reject `\u0000` |
| **g** quotePath | BYPASSED (unquoted forms) | **CAUGHT** (`-z` + `quotePath=false`, g3b) | **High** vs current guard; **Medium** vs a naive re-parser that drops `-z` (g3a) | High if `-z` ever removed | Mitigated upstream — keep the flags |
| **h** Rename-away | n/a | **BYPASSED** (h1) | **Trivial** — a plain `git mv` | **High** — silently removes/relocates a protected file under a green guard | **OPEN — recommended fix** |

---

## 5. Recommendations (observations only — no code was changed by this audit)

1. **Add `--no-renames` to `listChangedFiles`** (`scripts/ci-scope-guard.mjs:92`), aligning it with
   `src/git.mjs:591`. This closes the only *open, trivially exploitable* finding (vector h).
2. **Normalise Unicode** in `canonicalizePath` (`.normalize("NFC")` on both file and pattern) so
   NFC/NFD spellings converge (vector b) — cheap because every comparison already flows through it.
3. **Fail closed on degenerate input** in `checkScope`: reject paths that contain `\u0000` or that
   canonicalise to `""` (vectors f1, e6) — one guard clause each.
4. **Keep the manifest ASCII-only**, ideally enforced by a lint, *or* implement Unicode full case
   folding in `caseInsensitive` matching if non-ASCII patterns are ever allowed (vectors b, c4, c5).
5. **Never drop `-z` / `core.quotePath=false` from the diff command** (vector g): `checkScope` cannot
   decode quoted output, and the flags are the *only* reason quoted spellings never arrive.
6. Symlink resolution is deliberately absent (paths may not exist locally). If that ever changes,
   resolve `realpath` for entries that exist before matching, and document that the lexical-only
   contract protects only callers whose path source re-reports real paths (i.e., git) — vector a.

---

## 6. Reproduction

```bash
node arena-scope-bypass-test.mjs   # 32 cases, exit 0 = audit reproduced; exit 1 = guard drifted
npm test                           # existing suite stays green (no existing file touched)
```

The probe writes only to `os.tmpdir()` and reads `.agent/protected-paths.json`;
it never modifies the repository.
