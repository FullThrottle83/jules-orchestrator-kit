# Google-First Jules Workflow Contract

This document specifies the safe Google-first Jules operating contract and bounded workflow for repository task execution and automated repair.

## Issue Task Contract Format

Every issue dispatched to Jules must define a structured task contract containing all of the following required elements:

1. **Objective**: A clear, succinct summary of the desired outcome.
2. **Context**: Relevant background information, issue context, and design constraints.
3. **Allowed Paths**: An explicit, exhaustive list of paths permitted to be created or modified.
4. **Forbidden Paths**: An explicit list or description of prohibited files and directories.
5. **Functional Requirements**: Granular, verifiable behavioral requirements.
6. **Acceptance Criteria**: Verifiable statements of success.
7. **Verification Commands**: Unmodified local or CI commands used to validate the change.
8. **Required Evidence**: The mandatory outputs, command exit codes, or test counts required in the PR description.
9. **Retry Budget**: The maximum allowed repair attempts (strictly capped at 2 rounds).
10. **Stop and Escalation Conditions**: Explicit safety triggers that require halting the automated flow immediately and requesting human review.

---

## Workflow Triggers and Modes

### Native Issue-Start Trigger

- The case-insensitive `jules` issue label (e.g. `jules`, `Jules`, `JULES`) acts as the native task-start trigger for starting a task session.
- Applying this label signals Jules to ingest the task contract from the issue body and begin work.

### Reactive Mode PR Feedback

- There is an explicit distinction between the initial issue-label trigger and targeted `@Jules` PR comment feedback in Reactive Mode.
- Applying the `jules` issue label creates an initial session that leads to a pull request.
- Once the pull request is open, subsequent instructions or targeted feedback are delivered via `@Jules` mentions in PR comment threads (Reactive Mode). `@Jules` PR comment feedback does not re-trigger initial task creation.

---

## Execution and Pull Request Flow

1. **PR Creation**: Jules executes the task within the specified scope bounds and opens the implementation PR against the base branch.
2. **Independent Read-Only CI**: Repository CI workflows run independently and read-only against the pull request. CI verifies code quality, linting, and test suites.
3. **Independent Security & Scope Checks**:
   - **Jules PR Audit & Test Gatekeeper** and **Agent Scope Guard** act as independent checks to audit diffs, verify scope boundaries, and detect unauthorized file modifications.
   - Note: These checks operate independently; they are named here as safety gates without claiming they are already required branch-protection checks in GitHub repository settings.
4. **Bounded Repair Flow**:
   - If CI or gatekeeper checks fail, a maximum of **two targeted repair rounds** per PR are permitted.
   - In each repair round, Jules analyzes the specific check failure and applies a targeted fix within allowed paths.
5. **Human Review and Approval**:
   - Passing green CI is **necessary but not sufficient** for merging a pull request.
   - Human review and explicit manual approval are always required prior to merge.

---

## Safety Constraints and Non-Negotiable Rules

- **Immediate Stop Conditions**: Jules must immediately halt operation, refrain from making further changes, and request human review if any of the following occur:
  - Any touch or modification of forbidden or protected paths (e.g., `.agent/**`, `.github/**`, lockfiles, CI workflows, security policies).
  - Scope creep or attempt to edit files outside the explicit allowed paths.
  - Security or credential concerns, including secret leaks or attempted credential access.
  - Any unauthorized production side effects or environment alterations.
  - Exhaustion of the retry budget (more than two failed repair rounds).
- **Prohibited Autonomous Actions**:
  - **No Auto-Merge**: Jules shall never automatically merge pull requests.
  - **No Auto-Close**: Jules shall never automatically close issues or pull requests.
  - **No Self-Approval**: Jules shall never approve its own pull requests.
  - **No Production Side Effects**: Autonomous execution must not perform external deployments, release publishing, or production side effects.

---

## Environment and Repository Settings

- **Authenticated Settings Outside Repository Task**: Configurations such as GitHub branch protection rules, required status checks, secret storage, and Reactive Mode integration settings are authenticated administrative settings configured outside of this repository task and code changes.
