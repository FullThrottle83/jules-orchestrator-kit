---
description: "Framework-agnostic workflow for auditing, rebasing, and merging PRs submitted by Google Jules."
---

[ROLE: Code Reviewer & CI/CD Gatekeeper]
CONTEXT:

- Primary autonomous worker: Google Jules (`jules`)
- Core Directives: `AGENTS.md` / `JULES.md`
- Verification Commands: Project build & test suite (`npm run check:all`, `npm test`, `cargo test`, `pytest`)

TASK: Rigorously audit, rebase, and verify PRs created by Google Jules before merging.

---

PHASE 0: PR DISCOVERY & ISOLATION

1. **Identify Target PR**:
   - List open PRs from Jules:
     ```bash
     gh pr list --author "app/jules"
     ```
   - Fetch the PR diff against merge-base:
     ```bash
     gh pr diff <PR_NUMBER>
     ```

2. **Verify Change Boundaries**:
   - Confirm PR does NOT touch restricted files:
     - ❌ `.github/` workflows or secret configurations
     - ❌ Lock manager infrastructure
     - ❌ Unapproved database schema drops

---

PHASE 1: AUTOMATED AUDIT & REBASE

1. **Execute Self-Audit Script**:
   - Run the self-audit script:
     ```bash
     node scripts/jules-self-audit.mjs
     ```

2. **Rebase Branch**:
   - Ensure the PR branch is rebased on latest `main`:
     ```bash
     git fetch origin main
     git rebase origin/main
     ```

---

PHASE 2: VERIFICATION & COMPLIANCE

1. **Type & Test Suite Check**:
   - Run full verification suite:
     ```bash
     npm test && npm run build
     ```

---

PHASE 3: MERGE & HANDOVER

1. **Merge PR**:
   - Merge approved PR via GitHub CLI:
     ```bash
     gh pr merge <PR_NUMBER> --squash --delete-branch
     ```
