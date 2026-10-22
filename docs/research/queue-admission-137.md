# Queue admission and backlog health: initial inventory

Tracks #137 and complements #38. This is a read-only design investigation, not a new runtime contract.

## Verified in source (2026-10-22)

- `src/engine.mjs` dispatch queue uses `config.limits.concurrency` to batch tasks; a concurrency-group lock can skip a task. This is not evidence of global GitHub PR backlog admission control.
- `src/engine.mjs` `pollSessionState()` exits on either elapsed time or `maxPollAttempts`; its defaults are 30 attempts, 1s interval and 300s timeout.
- `src/dag-engine.mjs` now computes the default `maxPollAttempts` from the selected serialize timeout and poll interval (approximately `ceil(timeout/interval)+1`), rather than using the 1,000-attempt cap described in the original issue. Explicit user-provided `maxPollAttempts` can still end polling earlier. Verify via regression tests before closing the existing issue.
- `docs/configuration.md` documents daily task quotas, concurrency, repair attempts, risk levels and optional complexity/cost routing. Documented configuration is **not** proof that every dispatch path enforces every governor.
- `src/telemetry.mjs` and `src/dashboard.mjs` already exist. Avoid creating a second event store or dashboard.
- `ROADMAP_V1.md` explicitly forbids growing the public CLI/SDK/MCP surface before contract contraction; telemetry-driven task creation remains research-only.

## Evidence gaps

1. Trace every dispatch entrypoint and establish where quotas are reserved and committed, especially failure and retry paths.
2. Confirm whether active remote sessions are counted across processes and whether stale states fail safely.
3. Confirm whether a stable task identity exists for cross-run deduplication. Do not infer identity from similar issue titles.
4. Determine which lifecycle events are observable and reliable: dispatched, provider-completed, independently gated, accepted, merged. Do not treat a merged PR as proof of a passing JOK gate.
5. Check which provider costs are measured versus estimated or unknown. Never present missing costs as zero.

## Proposed narrow decision contract (not implemented)

An internal pure evaluator could return `{decision: "admit" | "defer" | "reject", reasons: string[]}` from **trusted, locally observable inputs**. `defer` covers temporary saturation; `reject` covers invalid or forbidden tasks. Do not add a public command or schema until the v1 contract is settled.

GitHub issue and PR counts are optional context, not authoritative dispatch limits without explicit, fresh synchronization. External nightly probes should produce untrusted candidates, not executable tasks.

## Required tests before implementation

- DAG serialization with a short synthetic clock/interval: timeout remains effective when default polling attempt count would otherwise be exhausted.
- Explicit low `maxPollAttempts` exits early and reports why.
- Local queue at configured concurrency, plus concurrency-group collision.
- Quota exhausted and failed dispatch without double charging.
- Unknown/stale remote session status; duplicate identity; deterministic no-op dry run.
- Simulated 50 issues/25 PRs should not alter decisions unless a configured and trustworthy backlog signal is provided.

## Decision

**GO for evidence gathering and targeted regression tests. NO-GO for new scheduler, browser agent, automatic issue creation, merge automation or additional public APIs.** After verification, implement only a confirmed enforcement gap in existing dispatch/queue code.
