# Roadmap

v0.73.1 (Current Stable) is the current release. The package remains pre-1.0;
planned work below is not a delivery commitment or a claim of enterprise compliance.
The runtime will continue to prefer Node.js built-ins without third-party runtime
dependencies.

## V1 direction

V1 is a **contraction and contract release**, not a feature-count milestone.

The product boundary is:

```text
Task → provider dispatch → agent-produced changes → deterministic gate → evidence → human/CI decision
```

Provider completion is not approval. The gate must independently evaluate the
result using trusted repository policy that the candidate change cannot widen.

Issue [#38](https://github.com/FullThrottle83/jules-orchestrator-kit/issues/38)
tracks the v1 contraction. The candidate CLI/SDK/MCP classification is recorded in
[`docs/v1-surface-inventory.md`](docs/v1-surface-inventory.md).

Until that contract work is complete, avoid adding new top-level subsystems, public
SDK exports, command aliases, agent personas, memory systems or provider-specific
API mirrors.

## Shipped milestones (v0.66.0 – v0.73.1)

Recent releases improved test-tamper detection, session-state handling, verification
isolation, CLI onboarding and command documentation. v0.73.0 split the security
module while preserving its public exports and consolidated specialist role aliases.

Release details, including earlier milestone summaries, are in
[CHANGELOG.md](CHANGELOG.md).

## P0 — contract the product before more features

1. **Inventory and deprecation map**
   - classify every public CLI command and the SDK/MCP families;
   - stop treating implementation helpers as accidental long-term contracts;
   - keep removals staged and migration-aware rather than deleting features in bulk.

2. **Make `gate` strictly non-mutating**
   - deprecate `gate --fix` and equivalent aliases;
   - make automated code mutation an explicit `repair` operation;
   - preserve failure fingerprints/non-convergence protection where useful to repair.

3. **Minimize `init`**
   - default setup should write the minimum project configuration required to dispatch
     and verify;
   - project instructions, specialist prompts, generic workflows and generated product
     contracts must be opt-in rather than default-owned assets.

4. **Choose one canonical config**
   - `.agent/config.yml` becomes the v1 source of truth;
   - `.agent/jules.yml` remains a 0.x legacy reader with deterministic migration guidance,
     but is no longer generated as a parallel source of truth.

## P1 — before v1

- **Version the task-envelope contract.** Tasks may narrow trusted repository scope and
  add verification, but must never widen policy or remove required verification.
- **Move ephemeral runtime state out of the working tree** where practical so normal
  execution does not require an expanding `.gitignore` ownership footprint.
- **Define the provider lifecycle contract.** Model local synchronous completion and
  remote asynchronous sessions explicitly instead of pretending every provider has the
  same lifecycle.
- **Reduce the verification core.** Keep hard acceptance invariants small and precise;
  document heuristics as heuristics and prefer external verification commands for
  specialized quality tooling.
- **Shrink the root SDK.** Replace the current broad frozen export surface with a small,
  intentionally documented v1 API and migration guidance.
- **Shrink MCP to a thin adapter** over the same core operations as CLI/SDK; do not
  stabilize provider-branded mirrors of external APIs.
- **Add packed-package downstream fixtures** across representative stacks and supported
  platforms for `init → task → dispatch(fake provider) → gate → uninstall`.
- **Add deterministic migration/uninstall paths** so the pre-v1 contraction is reversible
  and does not delete user-owned files.
- **Rewrite the primary docs around the product mental model** rather than historical
  subsystem accumulation.

## Reliability work that survives the contraction

These remain worthwhile, but should be implemented against the smaller v1 contract:

- ensure timed-out commands clean up child process trees on supported platforms;
- evaluate remaining Unicode and mixed-script detection gaps with reproducible tests;
- make first-run setup and verification failures easier to diagnose across toolchains;
- retain failed repair-attempt diffs/diagnostics so explicit repair can be reviewed;
- validate concurrency and resource use with reproducible benchmarks after queue
  semantics are finalized;
- improve stale-lock recovery only to the extent required by the supported queue/process
  model. Do not grow a distributed lease system without a demonstrated multi-process
  consumer requirement.

## After v1 candidates

### Deterministic advisory review planning

Evaluate a lightweight review-planning layer only after the task/dispatch/gate contract
is stable:

- select changed files with deterministic engineering logic;
- group related files within explicit, observable budgets;
- resolve path-aware rules from trusted repository policy;
- delegate review reasoning to the existing provider layer;
- emit structured advisory findings;
- keep review output advisory and completely separate from the deterministic gate.

Do not add a dedicated review-model runtime dependency, viewer, comment platform or
LLM endpoint configuration solely for this feature.

### Evidence-driven extensions

- monorepo affected planning, if real large repositories show global verification cost
  is a material problem;
- an external provider extension point, only when third-party provider demand exists;
- more stable machine-readable schemas for CI integrations once the v1 core schemas are
  fixed.

## Research only

The following need a concrete user/verifier before implementation:

- signed evidence / remote attestation;
- durable parallel queues beyond the supported local-process model;
- provider-independent resume semantics across providers with materially different APIs;
- cross-repository coordination;
- visual regression orchestration;
- telemetry-driven task creation;
- broader structural parsing.

Existing evidence manifests establish integrity observations, not regulatory compliance,
hermetic execution or certification.
