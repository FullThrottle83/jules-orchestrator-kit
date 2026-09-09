# Contributing to Jules Orchestrator Kit

Thank you for contributing to **Jules Orchestrator Kit**! This document provides guidelines and best practices for human developers and automated AI agents contributing code to this repository.

This project is a human-led, agent-assisted open-source project. Attribution and provenance are governed by [`CONTRIBUTORS.md`](CONTRIBUTORS.md); by contributing you agree to have your work recorded there and in git author metadata.

---

## 🏗️ Core Engineering Directives

All contributions must strictly follow these core invariants:

1. **Zero Runtime Dependencies:**
   - The orchestrator has **0 third-party npm runtime dependencies**.
   - Use ONLY native Node.js built-in ESM modules (`node:fs`, `node:path`, `node:crypto`, `node:child_process`, `node:util`).

2. **Read-Before-Write (Zero Hallucination):**
   - Inspect exact symbol definitions and method signatures before editing existing files.
   - Do not guess internal API structures.

3. **Cross-Platform Normalization:**
   - Always normalize Windows backslashes (`\`) to POSIX slashes (`/`) for paths and glob patterns using `normalizePath()`.

4. **100% Verification Suite:**
   - Every PR must pass 100% of unit tests (`npm test`) and 0 ESLint errors (`npm run lint`).
   - Never weaken assertions, swallow errors, or delete failing tests to force a pass.

---

## 🌿 Branch & Pull Request Flow

`main` is the protected trunk. Development is **PR-based**:

1. **Branch** from the latest `origin/main` with a type/area prefix, e.g. `docs/P13-provenance-governance`, `fix/engine-…`, `feat/roles-…`.
2. **Commit** on your branch following the commit conventions and signing rules below.
3. **Rebase before PR**: `git fetch origin && git rebase origin/main`, then re-run the verification suite. If the rebase leaves an empty diff, the work already landed — do NOT open the PR.
4. **Open the PR** with a Conventional Commit title, attach full terminal output of `npm test` and `npm run lint`, and reference any related issues.
5. **CI gates** run on every PR: unit suite, ESLint, doc-sync, agent scope guard, stale-base gate (> 25 commits behind `origin/main` is rejected), and asset integrity. Once green, the PR is merged per the risk-tier review requirements below (maintainer review for `R1`–`R3`, auto-merge eligible for `R0`).
6. **Do not push to `main`.** Direct `main` pushes are reserved for maintainers executing the release protocol in `AGENTS.md` § 7 (release commits are pushed to `main` first so CI verifies the exact commit that will be tagged; the pipeline refuses to release a commit CI has not verified).
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
npm install
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

# Run pre-flight self-audit
node scripts/jules-self-audit.mjs --preflight
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
| **`R2`** | **Consequential** | Core engine updates (`engine.mjs`), CLI changes. | 1 Maintainer Review |
| **`R3`** | **Restricted** | Security modules (`security.mjs`, `execution_envelope.mjs`), CI workflows. | Security Review Required |

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

- [`CONTRIBUTORS.md`](CONTRIBUTORS.md) is the attribution ledger: human maintainers, autonomous coding agents (`jules-agent`, Arena Agent), and per-identity statistics from `git log`.
- **Never rewrite history or authorship.** Do not change `Author`/`Committer` metadata, do not squash away `Co-authored-by:` trailers, and do not amend agent commits to hide their origin.
- Agent contributors do not self-attest; maintainers record agent work from the verified commit metadata and PR audit trail.

---

## 🐛 Reporting Bugs & Vulnerabilities

- **General Bugs & Feature Requests:** Open a [GitHub Issue](https://github.com/FullThrottle83/jules-orchestrator-kit/issues) with reproduction steps and environment metadata.
- **Security Vulnerabilities:** See [SECURITY.md](SECURITY.md) to submit a private disclosure via GitHub Security Advisories.
