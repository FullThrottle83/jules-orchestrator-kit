# v1 public surface inventory

Status: **candidate contract inventory for issue #38**. This document changes no runtime behavior and does not deprecate anything by itself.

Snapshot reviewed: `main` at `8fe06c2835eb32b283c6e9339844361550c4ffbb` (`v0.73.1`).

## Product boundary

The v1 product should optimize for one understandable flow:

```text
Task
  ↓
Provider dispatch
  ↓
Agent-produced changes
  ↓
Deterministic gate using trusted repository policy
  ↓
Evidence/report
  ↓
Human or CI decision
```

A provider reporting success is not verification. `gate` is the independent acceptance boundary and should become strictly non-mutating before v1.

The inventory deliberately distinguishes current implementation from the surface that should be stabilized. Removal candidates are not instructions to delete code immediately; first stop treating them as stable product commitments, verify internal consumers, then remove or demote them in scoped follow-up PRs.

## Classification

| Class | Meaning |
| --- | --- |
| `CORE_V1` | Small stable v1 contract. Breaking changes require migration guidance. |
| `ADVANCED_V1` | Supported v1 feature, but not part of the five-minute mental model. |
| `DEPRECATE_PRE_V1` | Current public spelling/shape should not become the v1 contract. Provide a migration path during 0.x. |
| `INTERNALIZE` | Capability may remain useful internally, but should not be a stable top-level public primitive. |
| `REMOVE_CANDIDATE` | Does not clearly belong to Task → Dispatch → Gate → Evidence. Verify consumers before deletion/demotion. |

## CLI inventory

`src/ops/command-registry.mjs` currently contains **52 command descriptors**. The classification below is the candidate target for v1, not current behavior.

| Current command | Candidate | v1 direction |
| --- | --- | --- |
| `agentctl assert` | `REMOVE_CANDIDATE` | Prefer explicit user verification commands; do not maintain a parallel assertion DSL unless a core use case survives. |
| `agentctl doctor` | `CORE_V1` | Canonical diagnostics surface, including machine-readable output. |
| `agentctl queue` | `DEPRECATE_PRE_V1` | Fold into explicit `dispatch --queue`; no hidden queue consumption. |
| `agentctl swarm` | `DEPRECATE_PRE_V1` | Replace product metaphor with explicit queue concurrency. |
| `agentctl task` | `CORE_V1` | Keep as task command group. |
| `agentctl task create` | `CORE_V1` | Stable human-reviewable task authoring. |
| `agentctl task template` | `REMOVE_CANDIDATE` | Move generic/web templates to docs or host-agent skills if still useful. |
| `agentctl task optimize` | `REMOVE_CANDIDATE` | Prompt scoring/rewriting should not be a required orchestrator primitive. |
| `agentctl init` | `CORE_V1` | Radically reduce default writes; config first, extra integration assets opt-in. |
| `agentctl dashboard` | `REMOVE_CANDIDATE` | Text/JSON diagnostics are sufficient for the core CLI. |
| `agentctl budget` | `INTERNALIZE` | Provider quota hints may remain diagnostic, but vendor-plan accounting is not a stable cross-provider contract. |
| `agentctl status` | `DEPRECATE_PRE_V1` | Collapse overlapping health/status output into `doctor [--json]`. |
| `agentctl escalate` | `REMOVE_CANDIDATE` | Generic webhook/notification orchestration is outside core. |
| `agentctl flaky` | `REMOVE_CANDIDATE` | Prefer external test tooling or verification recipes; no healing subsystem in core. |
| `agentctl handover` | `REMOVE_CANDIDATE` | Do not make a proprietary baton-pass protocol part of v1 without demonstrated cross-provider need. |
| `agentctl mutate` | `REMOVE_CANDIDATE` | Mutation testing can be an external verification command. |
| `agentctl mutation` | `DEPRECATE_PRE_V1` | Alias adds surface; follows the fate of `mutate`. |
| `agentctl coverage` | `REMOVE_CANDIDATE` | Diff coverage can be an external verification command. |
| `agentctl gate` | `CORE_V1` | Keep; remove mutating `--fix` semantics from the stable contract. |
| `agentctl check` | `DEPRECATE_PRE_V1` | Alias → `gate`. |
| `agentctl audit` | `DEPRECATE_PRE_V1` | Alias → `gate`. |
| `agentctl probe` | `REMOVE_CANDIDATE` | Flakiness probing belongs in external verification tooling/recipes unless proven otherwise. |
| `agentctl stability` | `DEPRECATE_PRE_V1` | Alias of a removal candidate; do not stabilize. |
| `agentctl perf` | `REMOVE_CANDIDATE` | Node event-loop diagnostics are not a general coding-agent acceptance primitive. |
| `agentctl event-loop` | `DEPRECATE_PRE_V1` | Alias of `perf`; do not stabilize. |
| `agentctl dispatch` | `CORE_V1` | Stable explicit provider dispatch; no implicit provider/tier surprises. |
| `agentctl bootstrap` | `ADVANCED_V1` | Keep only as explicit zero-test-repo onboarding; must remain fail-closed. |
| `agentctl pr harvest` | `REMOVE_CANDIDATE` | Auto-merge ownership should remain outside the verification core. |
| `agentctl harvest` | `REMOVE_CANDIDATE` | Coupled to proprietary persistent memory; do not stabilize. |
| `agentctl session get` | `ADVANCED_V1` | Useful remote-provider lifecycle operation; semantics must be explicit and provider-aware. |
| `agentctl session list` | `ADVANCED_V1` | Same: supported lifecycle tooling, not core mental model. |
| `agentctl plan approve` | `ADVANCED_V1` | Retain only for providers that expose plan approval; do not fake support elsewhere. |
| `agentctl lock` | `INTERNALIZE` | Coordination primitive should support queue/runtime correctness, not become a broad public lock API by default. |
| `agentctl evidence` | `ADVANCED_V1` | Keep verification/report inspection, with modest integrity claims. |
| `agentctl fix` | `DEPRECATE_PRE_V1` | Converge on explicit `agentctl repair`; repair is mutating, gate is not. |
| `agentctl patch` | `INTERNALIZE` | Remote result materialization may be needed internally; avoid a Jules-specific stable top-level contract. |
| `agentctl retry` | `INTERNALIZE` | Fold failure retry semantics into explicit repair/provider lifecycle behavior. |
| `agentctl prune` | `REMOVE_CANDIDATE` | Jules account/session housekeeping is not core orchestrator behavior. |
| `agentctl clean` | `ADVANCED_V1` | Keep narrowly scoped maintenance for state created by the tool. |
| `agentctl provider` | `ADVANCED_V1` | Explicit provider selection/configuration is useful; avoid hidden routing. |
| `agentctl providers` | `CORE_V1` | Canonical readiness/discovery surface. |
| `agentctl profile` | `ADVANCED_V1` | Verification profiles can remain if they stay small and command-oriented. |
| `agentctl ci init` | `ADVANCED_V1` | Useful convenience generator; keep opt-in and reversible. |
| `agentctl review-repair` | `DEPRECATE_PRE_V1` | Findings should feed the same explicit `repair` primitive rather than a separate repair product. |
| `agentctl scan` | `REMOVE_CANDIDATE` | TODO/FIXME scanning is not core. |
| `agentctl rollback` | `INTERNALIZE` | Preserve repair safety using Git-native artifacts; avoid stabilizing a proprietary checkpoint framework. |
| `agentctl resume` | `ADVANCED_V1` | Provider-aware continuation can remain where the provider supports it. |
| `agentctl test-gen` | `REMOVE_CANDIDATE` | Test generation belongs to coding agents; this tool verifies the result. |
| `agentctl mcp` | `ADVANCED_V1` | Keep a thin stdio adapter over the same core operations as CLI/SDK. IDE scaffolding remains opt-in. |
| `agentctl hydrate` | `REMOVE_CANDIDATE` | Coupled to proprietary memory/handover state. |
| `agentctl learning` | `REMOVE_CANDIDATE` | Persistent agent memory is better owned by repository/host-agent instruction systems. |
| `agentctl rules` | `REMOVE_CANDIDATE` | Rule budget/compilation is useful only if it survives as a demonstrated project-policy need; otherwise docs/recipe. |

### Planned v1 CLI gaps

These are not current commands and should be handled in later scoped PRs:

- `agentctl repair` — the single explicit mutating repair entrypoint.
- `agentctl task validate` — validate the versioned task contract without dispatching it.
- `agentctl migrate` — deterministic migration of supported 0.x config/task state.
- `agentctl uninstall --dry-run` / `agentctl uninstall` — remove only assets the tool can prove it owns.

## SDK inventory by export family

`test/api-surface.test.mjs` currently freezes the package root at **250 symbols**. v1 should freeze a deliberately small SDK instead of implementation details.

| Current root export family | Candidate | Direction |
| --- | --- | --- |
| Config loading/validation | `CORE_V1` + `INTERNALIZE` | Stabilize high-level load/validate operations; keep parser/path/default helpers internal. |
| `gate`, `dispatch`, `repair` engine operations | `CORE_V1` | These are the main programmatic contract candidates. Do not stabilize generic `run` if it obscures effects. |
| Task/envelope validation | `CORE_V1` | Version the task schema and stabilize validation/normalization. |
| Provider creation/errors/readiness | `CORE_V1` + `ADVANCED_V1` | Keep a small provider contract and explicit error model; internalize presets/failover wrappers where possible. |
| Evidence read/verify | `ADVANCED_V1` | Stabilize report verification, not every hashing/formatting helper. |
| Security scanners and scope helpers | `INTERNALIZE` | Gate owns these invariants; avoid making detector internals permanent public APIs. |
| Git/process helpers | `INTERNALIZE` | Implementation detail. |
| State, budget, locks, journal | `INTERNALIZE` | Runtime correctness primitives, not root SDK product surface. |
| Profiles/stack detection/onboarding | `INTERNALIZE` + `ADVANCED_V1` | Public surface only where a documented integration genuinely needs it. |
| Router/tier heuristics | `REMOVE_CANDIDATE` | Explicit provider/model choice is preferable to hidden routing. |
| Risk/remediation heuristics | `INTERNALIZE` | Keep only where required by core policy/repair; do not freeze helpers. |
| Mutation/coverage/stability/perf/assertions | `REMOVE_CANDIDATE` | Prefer external verification commands. |
| DAG/swarm/coordination helpers | `INTERNALIZE` | Keep only the minimum necessary for supported queue semantics. |
| TODO scanner/web task templates/task optimizer | `REMOVE_CANDIDATE` | Not part of the v1 control-layer contract. |
| TUI/wizard primitives | `INTERNALIZE` | UI implementation detail. |
| Checkpoint/handover | `INTERNALIZE` / `REMOVE_CANDIDATE` | Keep only Git-native repair safety that proves necessary. |
| Webhook/escalation | `REMOVE_CANDIDATE` | Generic notification engine is outside core. |
| TDD generator | `REMOVE_CANDIDATE` | Agent authoring concern, not acceptance control. |
| SPORE memory | `REMOVE_CANDIDATE` | Host agent/repository instructions own persistent knowledge. |
| IDE scaffolding | `ADVANCED_V1` / docs | Keep optional integration convenience, not core SDK. |
| Flaky ledger/healing | `REMOVE_CANDIDATE` | External test tooling/recipe. |
| Jules session operations | `ADVANCED_V1` + `INTERNALIZE` | Expose only lifecycle operations that the provider-neutral contract needs; do not mirror the whole Jules API at package root. |
| MCP frame internals | `INTERNALIZE` | MCP transport implementation, not SDK contract. |

A later SDK-contraction PR should produce an explicit candidate export list (roughly 8–20 high-level operations/types), update the API-surface test to freeze only that list, and provide migration guidance for removed root exports.

## MCP inventory by tool family

The current MCP server advertises a broad surface and aliases Jules-branded tools to `agent_*` names. v1 should make MCP a thin adapter over the same core operations as CLI/SDK rather than a second product API.

| Current tool family | Candidate | Direction |
| --- | --- | --- |
| Task dispatch | `CORE_V1` | Provider-neutral `agent_dispatch_task` over the core dispatch function. |
| Gate/audit | `CORE_V1` | Provider-neutral gate tool; no mutating `fix` option. |
| Status/diagnostics | `CORE_V1` / `ADVANCED_V1` | Small machine-readable status/doctor surface. |
| Evidence verification | `ADVANCED_V1` | Add only if it maps directly to the same core evidence verifier. |
| Risk classification | `INTERNALIZE` | Internal policy detail, not a standalone stable MCP product. |
| Telemetry tail | `REMOVE_CANDIDATE` | Diagnostics can be surfaced through bounded status/report output. |
| Prompt optimization | `REMOVE_CANDIDATE` | Host-agent concern. |
| Web task templates | `REMOVE_CANDIDATE` | Docs/skills concern. |
| Persistent system learning | `REMOVE_CANDIDATE` | Host-agent/repository instruction concern. |
| `jules_*` session/source/patch/prune lifecycle mirror | `DEPRECATE_PRE_V1` | Do not stabilize a second copy of the Jules API. Keep the minimum lifecycle actions needed by the provider adapter and expose provider-neutral operations only where semantics are real. |
| `agent_*` aliases of provider-specific lifecycle calls | `DEPRECATE_PRE_V1` | Renaming a Jules-only behavior does not make it provider-neutral. |

Target v1 MCP size should be small enough to explain as a direct adapter, not a parallel API taxonomy.

## Configuration and generated surface

Candidate v1 rules:

- `.agent/config.yml` becomes the single canonical project config.
- `.agent/jules.yml` is read only for 0.x migration compatibility, then removed from generated output.
- default `init` should create the minimum config required to dispatch and verify.
- `AGENTS.md`, specialist prompts, generic workflows, `SPEC.md`, `CONSTRAINTS.md`, and `DESIGN.md` are not default-owned v1 assets.
- ephemeral state, ledgers, evidence caches and provider receipts should move out of the working tree where practical.
- task metadata should gain an explicit schema version before v1.

## Work order

Tracked by #38.

1. **Docs-only public-surface inventory** — this document.
2. **Gate/repair split** — `gate` cannot trigger provider mutation; add one explicit repair surface.
3. **Minimal init** — reduce default downstream writes.
4. **Canonical config** — `.agent/config.yml` + deterministic legacy migration.
5. **Task schema v1** — task can narrow trusted policy/add verification, never widen/remove it.
6. **Runtime state cleanup** — move ephemeral state outside the working tree.
7. **Provider lifecycle contract** — explicit local `completed` vs remote `session` results.
8. **SDK/MCP contraction** — freeze only the intended v1 operations.
9. **Verification-core reduction** — distinguish hard deterministic invariants from heuristics and external quality tools.
10. **v1-rc packaging/migration/docs** — packed-artifact fixtures, uninstall, cross-platform downstream validation.

## Explicit non-goals before that sequence completes

- no AI code-review engine
- no new top-level subsystem
- no new agent-memory/persona framework
- no distributed scheduler
- no hosted dashboard/observability product
- no plugin marketplace/capability taxonomy
- no signed/compliance evidence work without a concrete verifier use case
- no mass deletion without verifying current consumers and migration cost
