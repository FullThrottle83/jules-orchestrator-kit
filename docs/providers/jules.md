# Google Jules provider notes

These notes describe this kit's Jules integration and the safe, hands-off Google-first Jules operating flow. Contributor instructions live in the repository's root `AGENTS.md`.

## Google-first operating flow

The safe, hands-off Jules operating flow is structured as follows:

1. **Native Issue-Label Trigger**:
   - A GitHub issue carrying the standard task contract receives the case-insensitive `jules` label (e.g. `jules` or `Jules`).
   - The native Google Jules GitHub App detects the label and starts a task execution session.
   - Note: The native issue-label trigger (`jules` label on an Issue) starts a new Jules task, whereas `@Jules` comments on a PR provide targeted repair feedback in Reactive Mode. These two mechanisms are distinct.

2. **Implementation PR Creation**:
   - Jules autonomously explores the repository, creates a plan, executes changes, and opens an implementation Pull Request against `main`.

3. **Independent Read-Only CI & Safety Gatekeeping**:
   - Repository CI remains independent and strictly read-only.
   - Independent read-only checks such as `Jules PR Audit & Test Gatekeeper` and `Agent Scope Guard` evaluate PR compliance and safety boundaries without assuming or claiming to be required GitHub branch-protection checks.

4. **Reactive Mode PR Feedback & Repair Loop**:
   - If CI checks, unit tests, or scope audits fail, targeted repair guidance is posted as an explicit `@Jules` comment on the PR thread in Reactive Mode.
   - **Retry Budget**: Maximum of **2 repair rounds per PR**.

5. **Stop & Escalation Policy**:
   - If the 2-round repair budget is exhausted, or if a PR touches protected paths (`.github/**`, `.agent/jules.yml`, `.agent/protected-paths.json`, lockfiles), raises security/credential concerns, or requests unauthorized production side effects, automated feedback stops immediately and requests human review.

6. **Manual Merge & Close**:
   - Auto-merge, auto-close, self-approval, and production side effects are strictly forbidden and disabled.
   - Passing CI checks and green audit gates are necessary conditions for merging, but they are NOT sufficient for merge.
   - Merging or closing a PR is strictly a manual action performed by a authorized human maintainer.
   - Branch protection settings and Jules Reactive Mode settings are authenticated GitHub/Jules administrative settings and are not modified by repository tasks.

## Setup and dispatch

Run `agentctl providers` to check provider readiness. Configure authentication and
provider selection using the [configuration reference](../configuration.md).
Review a task envelope before dispatching it. `agentctl dispatch` sends work to
the provider; `agentctl gate` is a separate verification step.

Plan approval can pause an unattended session. The CLI supports
`--auto-approve-plans` (alias `--auto-approve`) for dispatches where automatic plan
approval is intended. Review the consequences before enabling it; this flag does
not replace local verification or PR review.

## Operational limits

- The kit defaults to a 75 KB diff limit. Split larger tasks and inspect the full
  diff before review. This configured limit is not a guarantee about a provider's
  current API payload limits.
- Check the actual session's memory, disk space, available services and network
  access when diagnosing failures. Earlier sandbox measurements are not platform
  guarantees. Do not change working product code to compensate for an unexplained
  infrastructure failure.
- Cloud sessions may lack credentials and services needed by integration tests.
  Use the project's documented fixtures and headless test setup where appropriate.
- Put essential task context in the task envelope and root instructions. Do not
  rely on undocumented assumptions about which IDE-specific files a provider reads.
- Refresh the base branch and review the merge diff before integrating remote work.

## Prompt transformations

The kit's `sanitizePromptVocabulary()` rewrites some operational terms in prose
before dispatch. Fenced code and inline code are preserved. Substitutions can
change meaning: SIGTERM and SIGKILL are not equivalent. Review transformed text
when exact commands matter. Prompt rewriting is not a security boundary and does
not guarantee provider acceptance.

For CLI flags, see the [command reference](../COMMAND_REFERENCE.md). For current
provider behavior, consult [Google Jules documentation](https://jules.google/docs/).
