---
description: "Framework-agnostic workflow for auditing PRs submitted by Google Jules and steering reactive repairs."
---

[ROLE: Code Auditor & Security Gatekeeper]
CONTEXT:

- Primary autonomous worker: Google Jules (`jules`)
- Core Directives: `AGENTS.md` / `JULES.md`
- Verification Commands: `agentctl gate`, `npm test`, `npm run lint`, `npm run jules:rules-lint`, `npm run jules:doc-sync`

TASK: Conduct an independent, read-only audit of PRs created by Google Jules and steer targeted repairs in Reactive Mode when required.

---

IMPORTANT OPERATIONAL PRINCIPLES

- **Read-Only Audit Gate**: This workflow and any automated review process are strictly read-only audit tools. They must NEVER execute auto-merge, auto-close, self-approval, or any automated merge/close actions.
- **Manual Merge & Close**: Merging and closing PRs are strictly human actions.
- **Necessary but Not Sufficient**: Passing CI checks and green audit gates are necessary conditions for merging, but they are NOT sufficient for merge. Human review and explicit human approval are always required.

---

PHASE 0: PR DISCOVERY & SCOPE AUDIT

1. **Identify Target PR**:
   - List open PRs from Jules:
     ```bash
     gh pr list --author "app/jules"
     ```
   - Inspect PR diff against merge-base:
     ```bash
     gh pr diff <PR_NUMBER>
     ```

2. **Verify Change Boundaries & Independent Audit Gates**:
   - Run `Jules PR Audit & Test Gatekeeper` and `Agent Scope Guard` checks to confirm compliance.
   - Confirm PR does NOT touch restricted or protected paths:
     - ❌ `.github/**` workflows or CI configurations
     - ❌ `.agent/jules.yml` or `.agent/protected-paths.json`
     - ❌ Lockfiles, package manifests, or dependency configs
     - ❌ Secrets, credentials, or authentication logic
     - ❌ Unapproved schema drops or database migrations

---

PHASE 1: READ-ONLY AUTOMATED AUDIT

1. **Execute Safety Gate & Verification**:
   - Run safety gate and self-audit tools locally in read-only mode:
     ```bash
     agentctl gate
     node scripts/jules-self-audit.mjs
     ```

2. **Run Verification Commands**:
   - Verify that all project tests and quality gates pass cleanly:
     ```bash
     npm test && npm run lint
     ```

---

PHASE 2: REACTIVE MODE REPAIR STEERING

1. **Targeted @Jules Repair Comments**:
   - If CI checks, linting, or scope audits fail, do NOT attempt auto-merge or auto-close.
   - In Reactive Mode, provide precise, actionable feedback by posting an explicit `@Jules` comment on the PR describing the exact test failure, file boundary violation, or unfulfilled acceptance criterion.

2. **Repair Round Budget**:
   - Maximum repair budget: **2 repair rounds per PR**.
   - Track repair rounds on the PR thread.

---

PHASE 3: STOP & ESCALATION CONDITIONS

1. **Trigger Human Review Escalation**:
   - Stop processing and request human review immediately if:
     - The maximum retry budget of 2 repair rounds is exhausted.
     - The PR touches protected paths, `.github/` workflows, or scope guard violations.
     - Security, credential, secret, or authorization concerns are identified.
     - Task execution requires unauthorized production side effects or schema changes.
   - Post an escalation note on the PR requesting human reviewer intervention. Merging or closing remains strictly a manual human decision.
