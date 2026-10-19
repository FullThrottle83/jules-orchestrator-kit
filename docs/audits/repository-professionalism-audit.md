# Independent Repository Professionalism & Release Quality Audit

- **Repository**: `FullThrottle83/jules-orchestrator-kit`
- **Base Commit Audited**: `71f00a2` (`main`, post-`v0.76.0`)
- **Audit Scope**: Product positioning, documentation accuracy, public API and architecture, project maintenance, user experience, and GitHub contributor attribution.

---

## Executive Summary

`jules-orchestrator-kit` has a clear engineering thesis: separate coding-agent task dispatch from deterministic, non-mutating verification against trusted base-branch policy (`Task → provider dispatch → candidate changes → deterministic verification → evidence → human/CI decision`). Its runtime is dependency-free (Node.js 22+ built-in ESM modules), its CI workflows pin third-party actions to commit SHAs with read-only default permissions, and its release pipeline enforces test, lint, package-integrity, guard-reachability, and doc-sync checks.

However, an external engineer evaluating the repository encounters concrete contradictions left behind by rapid iteration between `v0.50.x` and `v0.76.0`:

1. **Broken or outdated examples in `EXAMPLES.md`**: GitHub Actions workflows specify `node-version: '20'` despite `package.json` requiring `node >= 22.0.0` (dropped in PR #100); Pattern 3 instructs users to run `agentctl merge-swarm` (a command that does not exist in `bin/agentctl.mjs`) and claims the kit executes tasks across isolated git worktrees (which `docs/architecture.md:310` explicitly notes the codebase does not do); Pattern 4 claims `agentctl dispatch` runs an automatic test verification and auto-fix loop (which `docs/architecture.md:8,316` explicitly refutes).
2. **Documentation drift after the `v0.75.9`/`v0.76.0` surface contraction**: PRs #107, #108, and #109 removed `agentctl prune`, `archiveSession()`, `deleteSession()`, and `agent_prune_sessions`, but `docs/architecture.md:48,81-82`, `docs/providers/jules.md:38`, and `docs/configuration.md:103` still document them as active capabilities. Similarly, `docs/architecture.md:316` still states *"The OODA loop is a property of `gate --fix`"* even though `gate --fix` now exits with code `2` (`bin/agentctl.mjs:29`).
3. **Self-hosting configuration dogfooding gap**: The repository's own `.agent/config.yml` is stated as the canonical v1 source of truth (`ROADMAP_V1.md:57`), while `.agent/jules.yml` is deprecated as a read-only 0.x legacy input. Yet this repository itself only tracks `.agent/jules.yml` (`version: 2`) and has no `.agent/config.yml`.
4. **Stale contributor snapshot and unverified signing claims**: `CONTRIBUTORS.md` is frozen at a `2026-09-09 · v0.72.3 · 448 commits` snapshot with line-level agent statistics, omits `Claude Opus 5` / `Claude Sonnet 5` (`<noreply@anthropic.com>`, 78 co-authored commits), and `CONTRIBUTING.md:66,139` claims every commit since `2026-09-09` is signed, whereas 450 of 532 commits on `main` are unsigned and the 82 signed commits are only GitHub web-flow merge commits (`noreply@github.com`).

---

## Classification Legend

Every finding is classified by both **Severity** (`Critical`, `High`, `Medium`, `Low`) and **Finding Type**:

- **Confirmed defect**: Reproducible command failure, broken workflow, or factual contradiction in shipped behavior.
- **Documentation mismatch**: Documentation states behavior, flags, or versions that disagree with the current codebase.
- **User experience problem**: Friction, ambiguity, or surprising behavior during onboarding or daily use.
- **Subjective editorial suggestion**: Tone, concision, or structural improvement that is not a factual error.
- **Historical issue already resolved**: Investigation lead verified to be fixed on `main`.
- **Unsupported claim requiring further evidence**: Claim that cannot be proven from local repository state alone.

---

## Prioritized Findings

### F-01 — `EXAMPLES.md` workflows use unsupported Node.js 20 and fail on `engines.node >= 22.0.0`

- **Severity**: High
- **Category**: README and documentation (`EXAMPLES.md`)
- **Finding Type**: Confirmed defect / Documentation mismatch
- **Location**: `EXAMPLES.md:29`, `EXAMPLES.md:69`, `package.json:63-65`
- **Why it matters**: An external developer copying Pattern 1 or Pattern 2 into `.github/workflows/` runs the kit on Node.js 20, which violates `engines.node: ">=22.0.0"` (Node 20 support was dropped in commit `fb9b859` / PR #100).
- **Evidence**:
  - `package.json:63-65`: `"engines": { "node": ">=22.0.0" }`
  - `EXAMPLES.md:27-29` and `67-69`: `uses: actions/setup-node@v4` with `node-version: '20'`.
- **Recommended change**: Update `node-version` in `EXAMPLES.md` Patterns 1 and 2 to `'22'`.
- **Compatibility / security risk**: None (documentation only).
- **Verification method**: Inspect `EXAMPLES.md` for `node-version` and verify agreement with `package.json` and `.github/workflows/jules-audit.yml`.

---

### F-02 — `EXAMPLES.md` Pattern 3 instructs users to run non-existent `agentctl merge-swarm` and misstates worktree behavior

- **Severity**: High
- **Category**: README and documentation (`EXAMPLES.md`)
- **Finding Type**: Confirmed defect / Documentation mismatch
- **Location**: `EXAMPLES.md:82`, `EXAMPLES.md:107`, `bin/agentctl.mjs`, `docs/architecture.md:310`
- **Why it matters**: Running `agentctl merge-swarm` fails immediately with `Exit Code 1` (`Unknown command: "merge-swarm"`). Furthermore, Pattern 3 claims `agentctl swarm` executes batches *"concurrently across isolated git worktrees"*, which `docs/architecture.md:310` explicitly refutes (*"It does not provision git worktrees... Nothing in the codebase runs `git worktree add`"*).
- **Evidence**:
  - Reproducible command:
    ```text
    $ node bin/agentctl.mjs merge-swarm
    Unknown command: "merge-swarm".
    Run 'agentctl --help' to see all available commands.
    (exit code 1)
    ```
  - `package.json:48` defines `"jules:merge-swarm": "node scripts/jules-merge-swarm.mjs"`, and the CLI command for PR harvesting is `agentctl pr harvest`.
- **Recommended change**: Replace `agentctl merge-swarm` in `EXAMPLES.md` with the actual CLI command (`agentctl pr harvest` or `npm run jules:merge-swarm`) and remove the false claim that `agentctl swarm` provisions isolated git worktrees.
- **Compatibility / security risk**: None.
- **Verification method**: Run every CLI command shown in `EXAMPLES.md` against `node bin/agentctl.mjs <cmd> --help`.

---

### F-03 — `EXAMPLES.md` Pattern 4 falsely claims `agentctl dispatch` runs automatic test verification and auto-repair

- **Severity**: High
- **Category**: Product positioning & documentation (`EXAMPLES.md`)
- **Finding Type**: Documentation mismatch
- **Location**: `EXAMPLES.md:112-126`, `README.md:15-18`, `docs/architecture.md:8,144-147`
- **Why it matters**: Pattern 4 states: *"Dispatch task with automatic test verification and auto-repair: `JULES_DRY_RUN=0 agentctl dispatch ...` If tests fail, the orchestrator feeds `stderr` back into repair attempts"*. In reality, `dispatch` only sends the task to the provider; it never runs verification or repair (`docs/architecture.md:8`: *"`dispatch()` never invokes the gate; `repair()` owns the bounded OODA loop"*). This directly contradicts the core v1 trust boundary stated in `README.md:15`.
- **Evidence**:
  - `src/engine.mjs` `dispatch()` sends the task payload to `provider.dispatch()` and returns the session result without calling `gate()` or `repair()`.
  - `bin/agentctl.mjs:29-31` rejects `gate --fix` and directs users to `agentctl repair`.
- **Recommended change**: Rewrite `EXAMPLES.md` Pattern 4 to show the actual two-step verification and explicit repair workflow (`agentctl gate` followed by `agentctl repair --cmd "npm test"`).
- **Compatibility / security risk**: None.
- **Verification method**: Verify `node bin/agentctl.mjs repair --help` and `node bin/agentctl.mjs gate --help` match the example.

---

### F-04 — `docs/architecture.md`, `docs/providers/jules.md`, and `docs/configuration.md` document removed session pruning/archiving/deletion APIs and removed `gate --fix`

- **Severity**: High
- **Category**: README and documentation (`docs/`)
- **Finding Type**: Documentation mismatch
- **Location**:
  - `docs/architecture.md:48`, `docs/architecture.md:80-82`, `docs/architecture.md:316`
  - `docs/providers/jules.md:38`
  - `docs/configuration.md:103`
- **Why it matters**: PRs #107 (`13cdc9a`), #108 (`c71c236`), and #109 (`6e34e5f`) deliberately removed `agentctl prune`, `archiveSession()`, `deleteSession()`, `jules_prune_sessions`, `agent_prune_sessions`, `jules_archive_session`, and `jules_delete_session` from the CLI, provider adapter, and MCP server. However, the architecture, provider, and configuration docs still instruct users to call them. Additionally, `docs/architecture.md:316` still states *"The OODA loop is a property of `gate --fix`, not of dispatch"*, contradicting line 144 of the same file.
- **Evidence**:
  - `test/cli-surface.test.mjs:1208`: `"prune command is removed from top-level CLI and fails closed"`
  - `src/provider.mjs` `createProvider("jules")` exports `['name', 'dispatch', 'validate', 'resume', 'sendMessage', 'getSession', 'approvePlan', 'listSessions', 'listActivities', 'listSources']` (no `archiveSession` or `deleteSession`).
  - `src/mcp.mjs` `MCP_TOOLS` contains no `prune`, `archive`, or `delete` tools.
- **Recommended change**: Update `docs/architecture.md`, `docs/providers/jules.md`, and `docs/configuration.md` to list only the shipped inspection methods (`getSession()`, `listSessions()`, `listActivities()`, `listSources()`) and state that the OODA loop belongs to explicit `agentctl repair`, not `gate --fix`.
- **Compatibility / security risk**: None.
- **Verification method**: Cross-check documented method and tool names against `Object.keys(createProvider("jules", {}))` and `MCP_TOOLS`.

---

### F-05 — `CONTRIBUTORS.md` and `CONTRIBUTING.md` contain a stale snapshot, omit Claude co-authorship, and overstate commit-signing enforcement

- **Severity**: Medium
- **Category**: Project maintenance & governance (`CONTRIBUTORS.md`, `CONTRIBUTING.md`)
- **Finding Type**: Documentation mismatch
- **Location**: `CONTRIBUTORS.md:11-97`, `CONTRIBUTING.md:64-82,139`
- **Why it matters**:
  1. `CONTRIBUTORS.md` presents a frozen snapshot from `2026-09-09 · v0.72.3 · 448 commits · 110 release tags` with hardcoded commit percentages and line counts that go stale on every commit (currently 532 commits on `main` and 124 tags).
  2. `CONTRIBUTORS.md` omits `Claude Opus 5 <noreply@anthropic.com>` (76 `Co-Authored-By:` trailers on `main`) and `Claude Sonnet 5 <noreply@anthropic.com>` (2 `Co-Authored-By:` trailers on `main`), which is the exact reason GitHub displays `claude` in the repository's Contributors sidebar.
  3. `CONTRIBUTORS.md:84-86` and `CONTRIBUTING.md:66,81` state that all commits after the 448th commit (`2026-09-09`) must be cryptographically signed so human vs. agent authorship is verifiable. In reality, `git log main --format="%G?"` shows 450 unsigned commits (`N`) and 82 signed commits (`U`), where all 82 signed commits are GitHub web-UI merge/squash commits signed by GitHub's key (`GitHub <noreply@github.com>`), not local GPG/SSH developer or agent keys.
- **Evidence**:
  - `git rev-list --count main` → `532`; `git tag | wc -l` → `124`.
  - `git log main --format="%B" | grep -i "^Co-authored-by:" | sort | uniq -c` → `76 Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`, `2 Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
  - `git log main --format="%G? | %cn <%ce>" | grep "^U" | sort -u` → `U | GitHub <noreply@github.com>`.
- **Recommended change**: Simplify `CONTRIBUTORS.md` into an evergreen provenance and governance document that accurately records all human and agent identities (including how `Co-authored-by` trailers map to GitHub accounts) without brittle commit/line-count tables, and align `CONTRIBUTING.md`'s commit-signing section with actual repository practice (recommended/supported for releases and merges rather than claiming every historical commit since September 9 is locally signed).
- **Compatibility / security risk**: None. Preserves full provenance transparency without rewriting Git history.
- **Verification method**: Verify `CONTRIBUTORS.md` and `CONTRIBUTING.md` against `git shortlog -sne main` and `git log main --grep="Co-authored-by" -i`.

---

### F-06 — `README.md` duplicates uninstall guidance and has an vestigial 2-row CLI table

- **Severity**: Medium
- **Category**: README and documentation (`README.md`)
- **Finding Type**: User experience problem / Subjective editorial suggestion
- **Location**: `README.md:153-164`, `README.md:185-205`
- **Why it matters**:
  1. `README.md` links to `docs/uninstall.md` under `## Documentation and removal` (line 189) and immediately follows with a separate `## Complete Uninstall / Removing the Kit (Undo Init)` section (lines 193–204) that repeats `docs/uninstall.md`. (Note: `test/cli-surface.test.mjs:625-647` pins specific phrases in `README.md` for `F22`, including the heading `Complete Uninstall / Removing the Kit (Undo Init)` and minimal vs. legacy scaffold ownership strings.)
  2. Under `## CLI` (`README.md:153-160`), the table lists only `menu` and `dashboard`, because `Key workflows` (lines 110–122) already lists the primary commands and `test/dashboard.test.mjs:165` asserts that `README.md` contains a table row starting with `| \`dashboard\`` and mentioning `4100`. To a new reader, a section titled `## CLI` containing only `menu` and `dashboard` looks truncated.
- **Evidence**:
  - `README.md:110-122` (`## Key workflows`) vs `README.md:153-163` (`## CLI`).
  - `test/dashboard.test.mjs:164-168` and `test/cli-surface.test.mjs:625-647`.
- **Recommended change**:
  - Merge `menu` and `dashboard` into the `## Key workflows` (or `## CLI and key workflows`) table while preserving the exact `| \`dashboard\` | ... 4100 ... |` row required by `test/dashboard.test.mjs:165`, eliminating the orphaned 2-row table.
  - Consolidate the `## Documentation and removal` and `## Complete Uninstall / Removing the Kit (Undo Init)` sections so the uninstall summary and documentation links are presented cleanly once while keeping all regexes asserted by `test/cli-surface.test.mjs:625-647` intact.
- **Compatibility / security risk**: Low — must run `npm test` and `npm run jules:doc-sync` to confirm all README test assertions pass.
- **Verification method**: Run `node --test test/dashboard.test.mjs test/cli-surface.test.mjs` and `npm run jules:doc-sync`.

---

### F-07 — `CODE_OF_CONDUCT.md` and `CONTRIBUTING.md` reference `execution_envelope.mjs` (underscore) instead of `src/execution-envelope.mjs` (hyphen)

- **Severity**: Low
- **Category**: README and documentation (`CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`)
- **Finding Type**: Documentation mismatch
- **Location**: `CONTRIBUTING.md:134`, `CODE_OF_CONDUCT.md:33`
- **Why it matters**: Contributors searching for `execution_envelope.mjs` will not find it; the actual module is `src/execution-envelope.mjs`.
- **Evidence**: `ls src/execution*` → `src/execution-envelope.mjs`.
- **Recommended change**: Update both references to `src/execution-envelope.mjs`.
- **Compatibility / security risk**: None.
- **Verification method**: `grep -rn "execution_envelope" .` returns zero matches outside audit docs.

---

### F-08 — `.github/ISSUE_TEMPLATE/bug_report.md` only offers Jules execution modes and legacy `npm run jules:queue` placeholder

- **Severity**: Low
- **Category**: User experience (`.github/ISSUE_TEMPLATE/bug_report.md`)
- **Finding Type**: User experience problem
- **Location**: `.github/ISSUE_TEMPLATE/bug_report.md:31-47`
- **Why it matters**: The dropdown `Execution Mode` asks *"How are you running Jules?"* with only two options (`API Mode (JULES_API_KEY set)` and `CLI Mode (Local jules binary)`), omitting `claude-code`, `codex`, `gemini-flash`, and local `agentctl gate` (no provider). The bug description placeholder also cites `npm run jules:queue` rather than `agentctl`.
- **Evidence**: `.github/ISSUE_TEMPLATE/bug_report.md:31-47`. Note that `.github/**` is a protected path in `.agent/protected-paths.json`.
- **Recommended change**: Defer to the protected-path approval batch (see Section "Higher-Risk / Protected-Path Improvements Requiring Explicit Approval").
- **Compatibility / security risk**: Modifies `.github/**` (protected path requiring `scope-override-approved` label in CI).
- **Verification method**: Inspect `.github/ISSUE_TEMPLATE/bug_report.md`.

---

### F-09 — `package.json` description is buzzword-heavy compared to `README.md`, and `package.json` ships 21 legacy `jules:*` scripts

- **Severity**: Medium
- **Category**: Product positioning & Public API (`package.json`)
- **Finding Type**: User experience problem / Subjective editorial suggestion (Protected Path)
- **Location**: `package.json:4`, `package.json:38-62`
- **Why it matters**:
  - `README.md:3` states clearly: *"Task dispatch and local verification for coding agents. Requires Node.js 22+ and Git; uses no third-party runtime dependencies."*
  - `package.json:4` still reads: *"Zero-dependency safety gatekeeper, test oracle generator, and multi-agent coordination protocol for autonomous coding agents — Google Jules, Claude Code, Codex and Gemini CLI."*
  - Because `package.json` is listed in `.agent/protected-paths.json`, any edit to `package.json` triggers the CI `Agent Scope Guard` unless explicitly authorized with `scope-override-approved`.
- **Evidence**: `package.json:4`, `.agent/protected-paths.json:3`.
- **Recommended change**: Propose aligning `package.json` `description` with `README.md:3` in a dedicated maintainer-approved protected-path PR.
- **Compatibility / security risk**: Touches `.agent/protected-paths.json` guarded file (`package.json`).
- **Verification method**: `npm run package-integrity` and CI `Agent Scope Guard`.

---

### F-10 — Repository self-hosts legacy `.agent/jules.yml` (`version: 2`) instead of canonical `.agent/config.yml`

- **Severity**: Medium
- **Category**: Project maintenance & architecture (`.agent/jules.yml`)
- **Finding Type**: Confirmed defect (dogfooding inconsistency on protected path)
- **Location**: `.agent/jules.yml:1-14`, `.agent/protected-paths.json:9`, `ROADMAP_V1.md:56-59`
- **Why it matters**: `ROADMAP_V1.md:57-58` states: *"`.agent/config.yml` is the v1 source of truth and sole target for ordinary config mutations; `.agent/jules.yml` remains a read-only 0.x legacy compatibility input"*. However, running `node bin/agentctl.mjs doctor --json` on this repository itself reports `configPath: ".agent/jules.yml"`. Furthermore, `.agent/protected-paths.json` protects `.agent/jules.yml` but does not list `.agent/config.yml`!
- **Evidence**:
  - `ls .agent/*.yml` → `.agent/jules.yml` (no `.agent/config.yml`).
  - `.agent/protected-paths.json:9` lists `".agent/jules.yml"`, not `".agent/config.yml"`.
- **Recommended change**: In a dedicated maintainer-approved R3 PR, run `agentctl migrate` on this repository to replace `.agent/jules.yml` with `.agent/config.yml` and add `.agent/config.yml` to `.agent/protected-paths.json`.
- **Compatibility / security risk**: High (R3 / protected path change affecting CI scope guard and repository self-audit). Must not be bundled into the safe documentation cleanup PR.
- **Verification method**: `node bin/agentctl.mjs migrate --dry-run` and `node scripts/ci-scope-guard.mjs`.

---

### F-11 — Public surface remains broad (55 CLI commands, 248 frozen SDK exports, 30 MCP tool names) pending Issue #38 contraction

- **Severity**: Medium
- **Category**: Public API and architecture (`index.mjs`, `bin/agentctl.mjs`, `src/mcp.mjs`)
- **Finding Type**: User experience problem (tracked in Issue #38)
- **Location**: `index.mjs:1-253`, `test/api-surface.test.mjs:12-320`, `src/ops/command-registry.mjs`, `docs/v1-surface-inventory.md`
- **Why it matters**: While `README.md` focuses on the core workflow (`init`, `providers`, `task create`, `queue`, `dispatch`, `gate`, `repair`, `doctor`), running `agentctl --help` prints 55 commands including peripheral subsystems (`flaky`, `mutate`, `perf`, `event-loop`, `escalate`, `handover`, `hydrate`, `harvest`, `learning`, `test-gen`, `scan`, `assert`). Similarly, `index.mjs` exports 248 symbols (including internal helpers like `parseProcStat`, `ANSI`, `levenshteinDistance`, `CEILING_FILE`) locked by `test/api-surface.test.mjs`.
- **Evidence**: `docs/v1-surface-inventory.md` and `test/api-surface.test.mjs`.
- **Recommended change**: Follow the staged deprecation plan in Issue #38 and `docs/v1-surface-inventory.md` rather than breaking `test/api-surface.test.mjs` unannounced. Update `docs/v1-surface-inventory.md` where items were already decided and shipped (e.g. §5 items 1 and 6: `gate --fix` removal and minimal `init` default were already implemented in PRs #110 and `test/gate-non-mutating.test.mjs`).
- **Compatibility / security risk**: Removing SDK exports or CLI commands is a breaking change requiring explicit owner approval.Updating `docs/v1-surface-inventory.md` to mark resolved questions is safe.
- **Verification method**: `npm test`.

---

### F-12 — Generated CI templates in `src/ci-templates.mjs` use `npx --yes jules-orchestrator-kit check` instead of canonical `gate`

- **Severity**: Low
- **Category**: User experience (`src/ci-templates.mjs`)
- **Finding Type**: User experience problem
- **Location**: `src/ci-templates.mjs:107,146,273`
- **Why it matters**: `docs/v1-surface-inventory.md:67` classifies `agentctl check` as a legacy alias for `agentctl gate` (`DEPRECATE_PRE_V1`), and `README.md` teaches `gate`. However, `agentctl ci init` still generates workflows invoking `check` instead of `gate`.
- **Evidence**: `src/ci-templates.mjs:146`: `run: npx --yes jules-orchestrator-kit check --mode committed --base "origin/${base}"`.
- **Recommended change**: Propose changing `check` to `gate` in `src/ci-templates.mjs` (and updating any matching test assertions in `test/`) in a separate code PR.
- **Compatibility / security risk**: Low, but touches `src/` and test expectations, so keep separate from the documentation batch.
- **Verification method**: `npm test`.

---

## Investigation of GitHub Contributor Identities (Phase 2)

### Why GitHub Displays Each Identity

GitHub populates the repository **Contributors** sidebar and `/graphs/contributors` using two distinct sources:
1. Primary commit `Author` emails on the default branch (`main`) that match a registered GitHub account (including `<id>+<login>@users.noreply.github.com`).
2. `Co-authored-by:` / `Co-Authored-By:` commit message trailers on the default branch whose email address matches a registered GitHub account. (Note: GitHub's REST endpoint `GET /repos/:owner/:repo/contributors` only counts primary commit `Author` metadata, whereas the GitHub web UI Contributors sidebar also includes linked `Co-authored-by:` accounts.)

Inspection of all 532 commits on `main` (`git log main`) and GitHub's User API establishes the exact provenance of every identity:

| Identity | Category | Git Metadata in `main` | Linked GitHub Account | Why Shown / Not Shown in GitHub UI |
| :--- | :--- | :--- | :--- | :--- |
| **FullThrottle83 / Jonas Pudas** | Human maintainer | **Author** on 88 commits (`77` as `Jonas Pudas <110360247+FullThrottle83@users.noreply.github.com>`, `11` as `FullThrottle83 <110360247+FullThrottle83@users.noreply.github.com>`); **Author** on 64 commits as `Jonas <jonas@joid.se>`; **Co-author** on 10 commits | [`@FullThrottle83`](https://github.com/FullThrottle83) (`id: 110360247`, User) | Shown in GitHub Contributors UI (88+ contributions). Note: the 64 commits authored with `jonas@joid.se` appear as `Anonymous` in `contributors?anon=1` unless `jonas@joid.se` is added to the `@FullThrottle83` GitHub account email settings. |
| **jules-agent** | Autonomous agent (Google Jules) | **Author** on 369 commits (`jules-agent <jules@agent.ai>`); **Committer** on 372 commits; **Co-author** on 55 commits | None (`jules@agent.ai` is not linked to a GitHub user account) | **Not shown** in the GitHub Contributors sidebar avatar list (which only renders linked GitHub accounts); returned only by `GET /repos/.../contributors?anon=1` (`type: "Anonymous"`, 369 contributions). |
| **arena-ai-coding-agent[bot]** | GitHub automation account (Bot) | **Author** on 10 commits (`298482267+arena-ai-coding-agent[bot]@users.noreply.github.com`) | [`@arena-ai-coding-agent[bot]`](https://github.com/apps/arena-ai-coding-agent) (`id: 298482267`, Bot) | **Shown** in GitHub Contributors and REST API (`10` contributions) because 10 commits on `main` (e.g. `fcee059`, `12fcbe5`, `010efcc`, `a020e59`, `60300c2`, `e25a9a3`, `af5850a`, `a505a5b`, `5894183`, `a78021a`) have its GitHub noreply address as the Git `Author`. |
| **arena-agent** | Co-author / GitHub User account | **Author** on 0 commits (`Arena Agent <arena@arena.ai>` authored 1 commit `485e0a2`, which is unlinked/anonymous); **Co-author** on 36 commits (`Co-authored-by: arena-agent <297053741+arena-agent@users.noreply.github.com>`) | [`@arena-agent`](https://github.com/arena-agent) (`id: 297053741`, User) | **Shown** in the GitHub web UI Contributors sidebar and `mentionableUsers` because 36 commits on `main` carry `Co-authored-by: arena-agent <297053741+arena-agent@users.noreply.github.com>`, which resolves to GitHub User ID `297053741`. |
| **Claude (`@claude`)** | Co-author (Anthropic model trailer) | **Author** on 0 commits; **Co-author** on 78 commits (`76` as `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`, `2` as `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`) on `2026-09-03` – `2026-09-05` | [`@claude`](https://github.com/claude) (`id: 81847`, User) | **Shown** in the GitHub web UI Contributors sidebar and `mentionableUsers` because the email address `noreply@anthropic.com` is registered on GitHub to the user account `@claude` (`id: 81847`), and GitHub links `Co-Authored-By: ... <noreply@anthropic.com>` trailers to that account. |
| **GitHub (`noreply@github.com`)** | GitHub web-flow committer | **Committer** on 82 commits merged via GitHub UI / API | GitHub system committer | Not counted as an author or co-author. |

### Can `arena-agent`, `arena-ai-coding-agent[bot]`, or `claude` Be Consolidated or Excluded Without Rewriting History?

**No.** Under GitHub's platform architecture, there is **no safe, non-destructive mechanism** to remove or consolidate `arena-agent`, `arena-ai-coding-agent[bot]`, or `claude` from GitHub's Contributors display without rewriting Git history:

1. **Why `.mailmap` does not work**: Git `.mailmap` remaps author names and emails for local `git shortlog` and `git log --use-mailmap`, but GitHub's Contributors graph and sidebar do **not** use `.mailmap` to merge two distinct registered GitHub accounts (`id: 297053741` vs. `id: 298482267`) or to strip `Co-authored-by:` trailers linked to registered GitHub accounts (`id: 81847`).
2. **Why `CONTRIBUTORS.md`, `README.md`, or repository settings do not work**: GitHub computes the repository sidebar Contributors widget strictly from the default branch's Git commit graph (`Author` emails and `Co-authored-by:` trailers). No repository setting, collaborator list change (`@FullThrottle83` is already the sole collaborator), or Markdown file alters that computation.
3. **Why history rewriting is rejected**: Removing those entries from GitHub's UI would require `git filter-repo` / rebase + force-pushing `main` and deleting/re-tagging 124 releases, which violates repository governance (`AGENTS.md`, `CONTRIBUTORS.md`) and breaks commit SHA references across issues, PRs, and npm provenance attestations.

**Note on the human maintainer's own 64 commits (`Jonas <jonas@joid.se>`)**: Those 64 commits ARE consolidatable without touching Git history if the maintainer adds and verifies `jonas@joid.se` under their `@FullThrottle83` GitHub account email settings.

### Recommended Authorship Policy for Future Commits

To prevent accidental creation of new third-party GitHub contributor avatars while keeping provenance truthful:

1. **Human commits**: Always commit using the maintainer's GitHub-linked identity (`Jonas Pudas <110360247+FullThrottle83@users.noreply.github.com>`).
2. **Autonomous agent commits / trailers**:
   - Use a single consistent identity per agent platform.
   - Avoid using `Co-Authored-By: ... <noreply@anthropic.com>` or `<id>+<login>@users.noreply.github.com` trailers for external accounts unless you explicitly want GitHub to link and display that GitHub user account in the Contributors sidebar.
   - Record model/tool assistance transparently in commit body prose or structured provenance fields (e.g., `Agent-Model:` or `Assisted-by:` trailers, which Git does not strip and GitHub does not convert into user account links) when no separate GitHub account attribution is intended.
   - When Arena or Jules opens a PR as a bot account, squash-merging under the reviewing maintainer's author identity (or keeping one canonical bot identity) avoids splitting attribution across both a bot `Author` (`arena-ai-coding-agent[bot]`) and a separate user `Co-authored-by` (`arena-agent`).

---

## Higher-Risk / Protected-Path Improvements Requiring Explicit Approval

The following improvements are **not** bundled into the first safe documentation PR because they modify `.agent/protected-paths.json` guarded files, executable `src/` code, or public contracts:

1. **Migrate repository dogfood config from `.agent/jules.yml` to `.agent/config.yml` (F-10)**:
   - Run `agentctl migrate` to replace `.agent/jules.yml` (`version: 2`) with `.agent/config.yml` (`version: 1`).
   - Add `.agent/config.yml` to `.agent/protected-paths.json`.
   - Requires `scope-override-approved` label on PR.
2. **Simplify `package.json` `description` (F-09)**:
   - Replace the jargon-heavy `description` in `package.json:4` with `"Task dispatch and local verification for coding agents (Google Jules, Claude Code, Codex, and Gemini CLI). Zero runtime dependencies."`
   - Requires `scope-override-approved` label because `package.json` is a protected path.
3. **Update `.github/ISSUE_TEMPLATE/bug_report.md` (F-08)**:
   - Add `claude-code`, `codex`, `gemini-flash`, and `Local gate only (no provider)` to the Execution Mode dropdown and replace `npm run jules:queue` with `agentctl`.
   - Requires `scope-override-approved` label because `.github/**` is a protected path.
4. **Update `src/ci-templates.mjs` to emit `gate` instead of `check` (F-12)**:
   - Update `buildCiWorkflow()` and `buildAutoMergeWorkflow()` in `src/ci-templates.mjs` (and corresponding unit tests) to generate `npx --yes jules-orchestrator-kit gate --mode committed --base ...`.
5. **Execute staged v1 surface contraction (F-11 / Issue #38)**:
   - Deprecate and internalize non-core SDK exports (`test/api-surface.test.mjs`) and peripheral CLI commands according to `docs/v1-surface-inventory.md` once owner decisions are finalized.
