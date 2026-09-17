# Roadmap

v0.73.1 (Current Stable) is the current release. The package remains pre-1.0;
planned work below is not a delivery commitment or a claim of enterprise compliance.
The runtime will continue to use Node.js built-ins without third-party dependencies.

## Shipped Milestones (v0.66.0 – v0.73.1)

Recent releases improved test-tamper detection, session-state handling, verification
isolation, CLI onboarding and command documentation. v0.73.0 split the security
module while preserving its public exports and consolidated specialist role aliases.

Release details, including earlier milestone summaries, are in the
[CHANGELOG](CHANGELOG.md).

## Next priorities

- Improve filesystem leases, stale-lock recovery and cancellation of dependent tasks.
- Ensure timed-out commands clean up child process trees on supported platforms.
- Evaluate remaining Unicode and mixed-script detection gaps with reproducible tests.
- Make first-run setup and verification failures easier to diagnose across toolchains.

## Before v1.0

- Define and document compatibility commitments for SDK exports, CLI exit codes and
  configuration schemas, with migration guidance for any breaking changes.
- Validate concurrency and resource use with published, reproducible benchmarks.
- Expand representative multi-language integration fixtures and document coverage gaps.
- Retain repair-attempt diffs and diagnostics so failed automated repairs can be reviewed.
- Evaluate signed audit exports; existing evidence manifests alone do not establish
  regulatory compliance or certification.

## Later candidates

- Evaluate deterministic review planning: select changed files with engineering logic,
  group related files within explicit context budgets, resolve path-aware review rules
  and delegate the resulting review plan to the existing provider layer. AI review must
  remain advisory and separate from the deterministic `gate`; do not make review output
  a gate prerequisite or add a dedicated review-model runtime dependency.
- Cross-repository coordination, visual regression workflows, telemetry-driven task
  creation and broader structural parsing remain exploratory. Scope and dependencies
  need evaluation before these become scheduled work.
