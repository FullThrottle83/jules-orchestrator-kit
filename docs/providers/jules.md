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
