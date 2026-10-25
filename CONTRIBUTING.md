# Contributing to Jules Orchestrator Kit

Thank you for contributing to **Jules Orchestrator Kit**! This document provides guidelines and best practices for human developers and automated AI agents contributing code to this repository.

This project is a human-led, agent-assisted open-source project. Attribution and provenance are governed by [`CONTRIBUTORS.md`](CONTRIBUTORS.md); by contributing you agree to have your work recorded there and in git author metadata.

---

## Repository rules

[AGENTS.md](AGENTS.md) is the authoritative source for scope, compatibility,
dependencies and verification rules. This guide covers contribution mechanics,
review and attribution.

---

## 🌿 Branch & Pull Request Flow

`main` is the trunk and development is **PR-based**. Whether GitHub enforces that
(rulesets, required checks) is a repository setting, not a file in this repository;
[docs/repository-protection.md](docs/repository-protection.md) records the intended
configuration and what to compare it against.

The steps:

1. **Branch** from the latest `origin/main` with a type/area prefix, e.g. `docs/P13-provenance-governance`, `fix/engine-…`, `feat/roles-…`.
2. **Commit** on your branch following the commit conventions and signing rules below.
3. **Rebase before PR**: `git fetch origin && git rebase origin/main`, then re-run the verification suite. If the rebase leaves an empty diff, the work already landed — do NOT open the PR.
4. **Open the PR** with a Conventional Commit title, attach full terminal output of `npm test` and `npm run lint`, and reference any related issues.
5. **CI gates** run on every PR: the unit suite on Linux, macOS and Windows with Node 22 and 24 (which includes ESLint and the self-audit), doc-sync, a GitHub Actions security audit (zizmor) and the agent scope guard. A change to a path listed in `.agent/protected-paths.json` fails the scope guard and the self-audit until a maintainer applies a head-SHA-bound `allow-p:<sha>` waiver label after reading that exact diff (see [docs/repository-protection.md](docs/repository-protection.md#waivers)). The stale-base check (`npm run jules:check-stale-base`, more than 25 commits behind `origin/main`) and the asset-integrity check (`npm run jules:check-asset-integrity`) are scripts to run before opening a PR; CI does not run them. Review is by the maintainer; the tiers below are expectations, not settings GitHub enforces, and auto-merge is not enabled.
6. **Do not push to `main`.** A release commit (version, changelog, documentation) reaches `main` through a pull request like any other change. `npm run release` from a clean, already-merged `main` then verifies that exact commit, tags it and pushes the tag; its push of the verified SHA to `main` changes nothing when `main` already contains it. See `docs/releasing.md`.
7. **Keep the diff small**: stay under the 75 KB diff payload budget (`git diff | wc -c`).

---

## ✍️ Commit Conventions (Conventional Commits)

Every commit message must follow the **Conventional Commits** specification:

```
<type>(<optional scope>): <imperative subject, lowercase, ≤ 72 chars>

<body: why the change exists + evidence>

<footer: BREAKING CHANGE: … or issue/PR references>
```

**Allowed types** (used across this repository's history):

| Type | Meaning |
| :--- | :--- |
| `feat:` | New capability (may add a feature-scoped scope, e.g. `feat(engine):`) |
| `fix:` | Bug or regression fix (e.g. `fix(roles):`, `fix(security):`) |
| `docs:` | Documentation only |
| `test:` | Test additions/assertions |
| `style:` | Formatting, no behavior change |
| `refactor:` | Behavior-preserving restructure |
| `perf:` | Performance improvement |
| `ci:` | CI/workflow changes |
| `chore:` | Maintenance, scaffolding, release prep (`chore(release):`) |
| `release:` | Version-tag release commits |

- **Breaking changes** are marked with `!` after type/scope (`feat!:`) or a `BREAKING CHANGE:` footer, and trigger a major version bump.
- **One logical change per commit**; scopes name the affected module (`engine`, `roles`, `security`, `release`, …) or task track (e.g. `P05`, `P06`).
- Automated merge/integration commits may use `merge:`/`chore:` with `Co-authored-by:` trailers naming every author (see `CONTRIBUTORS.md` § 4).

---

## 🔏 Commit Signing

Provenance governance requires that every **new** commit be **signed**, so authorship (human vs. autonomous agent) is cryptographically verifiable end-to-end:

```bash
# Configure signing once
git config --global user.signingkey <KEY-ID>      # GPG, or ssh: gpg.format=ssh
git config --global commit.gpgsign true

# Commit with an explicit signature
git commit -S -m "fix(engine): …"

# Verify a signature
git log --show-signature
```

- Release tags are signed as well (`git tag -s`).
- **History is permanent and will not be rewritten.** The 448 commits that predate this policy (2026-07-26 → 2026-09-09) are unsigned and remain exactly as authored; do NOT rebase, filter, or force-push to backfill signatures. The policy applies to commits created from now on.

---

## 🔄 Development & Testing Workflow

### 1. Setup Environment
```bash
# Clone repository
git clone https://github.com/FullThrottle83/jules-orchestrator-kit.git
cd jules-orchestrator-kit

# Install dev dependencies (ESLint)
npm ci
```

### 2. Run Verification Suite
Before opening a PR, execute the verification suite required by [`AGENTS.md`](AGENTS.md):
```bash
# Run unit tests
npm test

# Run ESLint linter
npm run lint

# Run documentation/version consistency gate
npm run jules:doc-sync

# Run agent rule budget check
npm run jules:rules-lint

# Run pre-flight self-audit
node scripts/jules-self-audit.mjs --preflight

# For packaging or guard changes, also run:
npm run package-integrity
npm run guard-reach
```

### 3. Subscription Tier Testing (`JULES_TIER`)
When introducing features that affect rate limits, session budgets, or OODA repair loops, verify behavior across subscription tiers:
```bash
# Test Free Tier budget limits (15 tasks/day, 1 repair attempt)
JULES_TIER=free npm test

# Test Pro Tier budget limits (100 tasks/day)
JULES_TIER=pro npm test
```

---

## 🛡️ Risk Tiers & PR Guidelines

Every Pull Request is categorized into a **Risk Tier**:

| Tier | Category | Description | Review expectation |
| :--- | :--- | :--- | :--- |
| **`R0`** | **Cosmetic** | Documentation, markdown formatting, SVG assets. | Maintainer merges after CI |
| **`R1`** | **Routine** | Isolated package logic with unit tests. | 1 Standard Review |
| **`R2`** | **Consequential** | Core engine updates (`src/engine.mjs`), CLI changes. | 1 Maintainer Review |
| **`R3`** | **Restricted** | The gate, scope, evidence and release modules and scripts listed in `.agent/protected-paths.json`, `src/execution-envelope.mjs`, CI workflows. | Security review; protected paths also need the waiver above |

### Pull Request Checklist
- [ ] Branch pushed from latest `origin/main`; never committed directly to `main`.
- [ ] Conventional Commit title per the [commit conventions](#commit-conventions-conventional-commits) above.
- [ ] Every commit signed (`git log --show-signature` clean).
- [ ] Attached full terminal output of `npm test` and `npm run lint` (and `npm run jules:doc-sync` for doc changes).
- [ ] Verified CBEE execution envelope compliance (no forbidden path modifications).
- [ ] Added or updated unit tests in `test/` for new functionality.
- [ ] Attribution recorded: humans added to `CONTRIBUTORS.md` (optional but encouraged); agent authorship left intact in git metadata.

---

## 🙋 Attribution & Provenance

- [`CONTRIBUTORS.md`](CONTRIBUTORS.md) is the attribution and provenance record for human maintainers and autonomous coding agents (`jules-agent`, Arena Agent, and Claude co-author trailers).
- **Never rewrite history or authorship.** Do not change `Author`/`Committer` metadata, do not squash away `Co-authored-by:` trailers, and do not amend agent commits to hide their origin.
- Agent contributors do not self-attest; maintainers record agent work from the verified commit metadata and PR audit trail.

---

## 🐛 Reporting Bugs & Vulnerabilities

- **General Bugs & Feature Requests:** Open a [GitHub Issue](https://github.com/FullThrottle83/jules-orchestrator-kit/issues) with reproduction steps and environment metadata.
- **Security Vulnerabilities:** See [SECURITY.md](SECURITY.md) to submit a private disclosure via GitHub Security Advisories.
