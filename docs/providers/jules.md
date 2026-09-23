# Google Jules provider notes

These notes describe this kit's Jules integration. Contributor instructions live
in the repository's root `AGENTS.md`.

## Setup and dispatch

Run `agentctl providers` to check provider readiness. Configure authentication and
provider selection using the [configuration reference](../configuration.md).
Review a task envelope before dispatching it. `agentctl dispatch` sends work to
the provider; `agentctl gate` is a separate verification step.

Plan approval can pause an unattended session. The CLI supports
`--auto-approve-plans` (alias `--auto-approve`) for dispatches where automatic plan
approval is intended. Review the consequences before enabling it; this flag does
not replace local verification or PR review.

## Jules Remote Session Lifecycle

Jules operates as a hosted, asynchronous HTTP provider (`type: "http"` in `src/provider.mjs`). Dispatches and follow-ups follow an explicit remote session lifecycle:

```text
POST /v1alpha/sessions (dispatch)
  ↓
Session State: AWAITING_PLAN_APPROVAL | ACTIVE
  ↓ (optional)
POST /v1alpha/sessions/{id}:approvePlan (plan approval)
  ↓
Session State: COMPLETED / IN_PROGRESS
  ↓ (follow-up)
POST /v1alpha/sessions/{id}:sendMessage (warm resumption)
```

1. **Source Context Requirement**: Dispatches require a connected GitHub repository source (`sources/github/<owner>/<repo>`), resolved from `JULES_REPO`, `source` in config, or `git remote origin`.
2. **Server-Side PR Creation**: When `autoPr: true` (or `--auto-pr`) is passed, the dispatch payload includes `automationMode: "AUTO_CREATE_PR"`. Jules executes server-side on Google Cloud and opens the PR directly.
3. **Plan Approval**: If `requirePlanApproval: true` is configured, the session pauses at `AWAITING_PLAN_APPROVAL`. Resume execution via `agentctl plan approve <sessionId>` or MCP tool `agent_approve_plan`.
4. **Warm Resumption (`resume`)**: Send follow-up prompts or steering to active sessions via `agentctl resume <sessionId> --response "..."` (`POST /v1alpha/sessions/{id}:sendMessage`). If the remote session is expired or closed (HTTP 400/404), the kit fails soft and falls back to a cold dispatch.
5. **Session Management**: Programmatically inspect or prune sessions using `agentctl session get`, `agentctl session list`, and `agentctl session prune` (or corresponding MCP `agent_*_session` tools).

## Google-first Jules workflow

The Google-first Jules workflow uses GitHub issues labeled with `jules` as native task-start triggers. Jules processes structured task contracts in issues, generates implementation branches, and opens pull requests. Independent read-only CI and gatekeeper checks validate PR diffs and scope boundaries. Any targeted follow-up uses `@Jules` comments in Reactive Mode, subject to a bounded two-round repair budget.

For full contract specifications, safety bounds, and operational rules, see the [Google-First Jules Workflow Contract](../jules-workflow.md).

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
