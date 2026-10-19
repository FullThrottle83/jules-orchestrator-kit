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

`main` is the protected trunk. Development is **PR-based**:

1. **Branch** from the latest `origin/main` with a type/area prefix, e.g. `docs/P13-provenance-governance`, `fix/engine-…`, `feat/roles-…`.
2. **Commit** on your branch following the commit conventions and signing rules below.
3. **Rebase before PR**: `git fetch origin && git rebase origin/main`, then re-run the verification suite. If the rebase leaves an empty diff, the work already landed — do NOT open the PR.
4. **Open the PR** with a Conventional Commit title, attach full terminal output of `npm test` and `npm run lint`, and reference any related issues.
5. **CI gates** run on every PR: unit suite, ESLint, doc-sync, agent scope guard, stale-base gate (> 25 commits behind `origin/main` is rejected), and asset integrity. Once green, the PR is merged per the risk-tier review requirements below (maintainer review for `R1`–`R3`, auto-merge eligible for `R0`).
6. **Do not push to `main`.** Direct `main` pushes are reserved for maintainers executing the release protocol in `docs/releasing.md` (release commits are pushed to `main` first so CI verifies the exact commit that will be tagged; the pipeline refuses to release a commit CI has not verified).
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

Commit signing (GPG or SSH) is encouraged for local commits and release tags, and GitHub automatically signs squash/merge commits performed through the GitHub review interface:

```bash
# Configure signing once
git config --global user.signingkey <KEY-ID>      # GPG, or ssh: gpg.format=ssh
git config --global commit.gpgsign true

# Commit with an explicit signature
git commit -S -m "fix(engine): …"

# Verify a signature
git log --show-signature
```

- **History is permanent and is never rewritten.** Historical unsigned commits (including autonomous agent commits produced in ephemeral sandboxes without signing keys) remain as authored; do not rebase, filter, or force-push to backfill signatures.

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
Before opening a PR, execute the complete verification suite:
```bash
# Run unit tests
npm test

# Run ESLint linter
npm run lint

# Run documentation/version consistency gate
npm run jules:doc-sync

# Run agent rule budget check, package integrity, and guard reachability
npm run jules:rules-lint
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

| Tier | Category | Description | Review Requirements |
| :--- | :--- | :--- | :--- |
| **`R0`** | **Cosmetic** | Documentation, markdown formatting, SVG assets. | Auto-merge eligible |
| **`R1`** | **Routine** | Isolated package logic with unit tests. | 1 Standard Review |
| **`R2`** | **Consequential** | Core engine updates (`src/engine.mjs`), CLI changes. | 1 Maintainer Review |
| **`R3`** | **Restricted** | Security modules (`src/security.mjs`, `src/execution-envelope.mjs`), CI workflows. | Security Review Required |

### Pull Request Checklist
- [ ] Branch pushed from latest `origin/main`; never committed directly to `main`.
- [ ] Conventional Commit title per the [commit conventions](#commit-conventions-conventional-commits) above.
- [ ] Attached full terminal output of `npm test` and `npm run lint` (and `npm run jules:doc-sync` for doc changes).
- [ ] Verified CBEE execution envelope compliance (no unauthorized protected-path modifications).
- [ ] Added or updated unit tests in `test/` for new functionality.
- [ ] Attribution preserved per [`CONTRIBUTORS.md`](CONTRIBUTORS.md).

---

## 🙋 Attribution & Provenance

- [`CONTRIBUTORS.md`](CONTRIBUTORS.md) documents the project's provenance and authorship rules for human maintainers and autonomous coding agents.
- **Never rewrite history or authorship.** Do not falsify `Author`/`Committer` metadata or rewrite published commits.
- Agent contributors do not self-attest; maintainers review and merge agent work from verified PR diffs and CI checks.

---

## 🐛 Reporting Bugs & Vulnerabilities

- **General Bugs & Feature Requests:** Open a [GitHub Issue](https://github.com/FullThrottle83/jules-orchestrator-kit/issues) with reproduction steps and environment metadata.
- **Security Vulnerabilities:** See [SECURITY.md](SECURITY.md) to submit a private disclosure via GitHub Security Advisories.
