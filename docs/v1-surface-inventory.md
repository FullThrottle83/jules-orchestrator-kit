# v1 Public Surface Inventory and Deprecation Map

Status: **PROPOSED Candidate Contract Inventory for Issue #38**.
> **Important**: Every classification in this document is a **proposal for human review and decision**. This document is docs-only: it changes no runtime behavior, modifies no code or configuration, and deprecates nothing by itself.

Snapshot reviewed: `main` (`v0.74.0`).

## Product Boundary

The v1 product surface is evaluated against the single core workflow defined in #38:

```text
Task (Authoring / Validation)
  ↓
Provider Dispatch
  ↓
Deterministic Gate (Verification against trusted repository policy)
  ↓
Evidence (Structured report / audit trail)
  ↓
Human or CI Decision
```

Any surface primitive that directly serves this chain is evaluated for `CORE_V1` or `ADVANCED_V1`. Primitives that mutate outside explicit repair, introduce duplicate spellings, expose internal implementation details, or implement peripheral subsystems (e.g. prompt optimization, mutation testing, persistent agent memory) are candidates for `DEPRECATE_PRE_V1`, `INTERNALIZE`, or `REMOVE_CANDIDATE`.

## Proposed Classification Categories

| Category | Meaning |
| --- | --- |
| `CORE_V1` | **PROPOSED**: Essential stable v1 contract. Breaking changes require explicit RFC and migration guidance. |
| `ADVANCED_V1` | **PROPOSED**: Supported v1 feature for advanced/remote lifecycles, but not part of the basic 5-minute mental model. |
| `DEPRECATE_PRE_V1` | **PROPOSED**: Current public spelling/shape should not become the v1 contract. Migration path provided during 0.x. |
| `INTERNALIZE` | **PROPOSED**: Capability remains useful internally within the package, but should be removed from the public export/CLI surface. |
| `REMOVE_CANDIDATE` | **PROPOSED**: Does not belong to the core Task → Dispatch → Gate → Evidence pipeline. Subject to consumer verification before removal/demotion. |

---

## 1. CLI Command Inventory (55 Commands)

Examines all 55 command descriptors registered in `src/ops/command-registry.mjs`.

| Command | Category | Proposed Classification | Rationale (Tied to Task → Dispatch → Gate → Evidence) |
| --- | --- | --- | --- |
| `agentctl task` | Create | `CORE_V1` | Top-level command group for task envelope management. |
| `agentctl task create` | Create | `CORE_V1` | Primary human-reviewable task authoring primitive (Task step). |
| `agentctl task validate` | Inspect | `CORE_V1` | Pre-flight validation of task envelopes against versioned schema without dispatching. |
| `agentctl dispatch` | Operate | `CORE_V1` | Primary explicit provider dispatch primitive (Dispatch step). |
| `agentctl gate` | Inspect | `CORE_V1` | Canonical deterministic acceptance boundary; strict non-mutating verification (Gate step). |
| `agentctl repair` | Repair | `CORE_V1` | The single explicit mutating repair entrypoint for failure traces (Repair step). |
| `agentctl evidence` | Inspect | `CORE_V1` | Audit evidence inspection and verification (Evidence step). |
| `agentctl doctor` | Repair | `CORE_V1` | Core diagnostic surface for environment, toolchain, and provider readiness. |
| `agentctl providers` | Inspect | `CORE_V1` | Provider readiness discovery and connectivity verification. |
| `agentctl init` | Configure | `CORE_V1` | Minimal project configuration setup (writes `.agent/config.yml`). |
| `agentctl uninstall` | Configure | `ADVANCED_V1` | Reversible removal of kit-owned configuration assets. |
| `agentctl migrate` | Configure | `ADVANCED_V1` | Deterministic migration of legacy 0.x configuration and task envelopes to v1 format. |
| `agentctl bootstrap` | Configure | `ADVANCED_V1` | Explicit onboarding for zero-test repositories with verification oracle generation. |
| `agentctl session get` | Inspect | `ADVANCED_V1` | Inspection of remote provider session status and lifecycle. |
| `agentctl session list` | Inspect | `ADVANCED_V1` | Listing of remote provider sessions. |
| `agentctl plan approve` | Operate | `ADVANCED_V1` | Human approval of agent execution plans where provider requires approval. |
| `agentctl resume` | Operate | `ADVANCED_V1` | Continuation of paused warm agent sessions. |
| `agentctl provider` | Configure | `ADVANCED_V1` | Explicit active provider selection and inspection. |
| `agentctl profile` | Configure | `ADVANCED_V1` | Verification profile configuration (minimal, standard, max). |
| `agentctl ci init` | Configure | `ADVANCED_V1` | Stack-aware CI workflow template generator (`.github/workflows/agent-gate.yml`). |
| `agentctl clean` | Operate | `ADVANCED_V1` | Maintenance cleanup for kit-generated state, locks, and temporary directories. |
| `agentctl mcp` | Configure | `ADVANCED_V1` | Stdio MCP server startup and optional IDE configuration helper. |
| `agentctl check` | Inspect | `DEPRECATE_PRE_V1` | Legacy alias for `agentctl gate`; propose deprecating alias in favor of `gate`. |
| `agentctl audit` | Inspect | `DEPRECATE_PRE_V1` | Legacy alias for `agentctl gate`; propose deprecating alias in favor of `gate`. |
| `agentctl status` | Inspect | `DEPRECATE_PRE_V1` | Overlaps with `agentctl doctor`; propose consolidating status output into `doctor --json`. |
| `agentctl queue` | Operate | `DEPRECATE_PRE_V1` | Propose folding implicit queue execution into explicit `dispatch --queue`. |
| `agentctl swarm` | Operate | `DEPRECATE_PRE_V1` | Propose replacing swarm metaphor with explicit queue concurrency flags in `dispatch`. |
| `agentctl fix` | Repair | `DEPRECATE_PRE_V1` | Shortcut/alias for `agentctl repair`; propose standardizing on `repair`. |
| `agentctl mutation` | Inspect | `DEPRECATE_PRE_V1` | Alias for `mutate`; follows classification of `mutate`. |
| `agentctl stability` | Inspect | `DEPRECATE_PRE_V1` | Alias for `probe`; follows classification of `probe`. |
| `agentctl event-loop` | Inspect | `DEPRECATE_PRE_V1` | Alias for `perf`; follows classification of `perf`. |
| `agentctl review-repair` | Repair | `DEPRECATE_PRE_V1` | Propose routing PR review comments into the standard `repair` entrypoint instead of a separate tool. |
| `agentctl lock` | Operate | `INTERNALIZE` | Coordination primitive needed for queue correctness; propose internalizing rather than exposing as public CLI API. |
| `agentctl budget` | Inspect | `INTERNALIZE` | Quota management primitive used internally by dispatch; propose keeping diagnostic details internal. |
| `agentctl patch` | Operate | `INTERNALIZE` | Patch extraction/application helper used internally during remote result materialization. |
| `agentctl retry` | Operate | `INTERNALIZE` | Session retry logic should be integrated into `repair` / session lifecycle rather than standalone top-level command. |
| `agentctl rollback` | Repair | `INTERNALIZE` | Safety checkpoint rollback used internally by repair/gate; propose internalizing. |
| `agentctl assert` | Inspect | `REMOVE_CANDIDATE` | Custom assertion DSL is peripheral to core gate verification; prefer standard test framework. |
| `agentctl task template` | Create | `REMOVE_CANDIDATE` | Generic web task templates belong in documentation or host-agent skills, not orchestrator core. |
| `agentctl task optimize` | Inspect | `REMOVE_CANDIDATE` | Prompt scoring/rewriting is an agent authoring concern, not core orchestrator primitive. |
| `agentctl dashboard` | Inspect | `REMOVE_CANDIDATE` | Local web dashboard is outside core Task → Dispatch → Gate pipeline; text/JSON diagnostics suffice. |
| `agentctl escalate` | Operate | `REMOVE_CANDIDATE` | Generic webhook escalation/notification engine is outside core pipeline. |
| `agentctl flaky` | Repair | `REMOVE_CANDIDATE` | Flaky test quarantine/healing subsystem belongs in external test tooling/recipes. |
| `agentctl handover` | Operate | `REMOVE_CANDIDATE` | Proprietary baton-pass session handover protocol is outside core pipeline. |
| `agentctl mutate` | Inspect | `REMOVE_CANDIDATE` | Diff mutation testing harness belongs in external quality tooling or optional verification recipes. |
| `agentctl coverage` | Inspect | `REMOVE_CANDIDATE` | V8 diff coverage engine belongs in external quality tooling or optional verification recipes. |
| `agentctl probe` | Inspect | `REMOVE_CANDIDATE` | Test stability probe harness belongs in external quality tooling. |
| `agentctl perf` | Inspect | `REMOVE_CANDIDATE` | Node.js event-loop lag monitoring belongs in external performance tooling. |
| `agentctl pr harvest` | Operate | `REMOVE_CANDIDATE` | Auto-merge PR harvesting is an external CI/CD workflow concern. |
| `agentctl harvest` | Operate | `REMOVE_CANDIDATE` | System memory failure harvesting belongs to host-agent instruction systems. |
| `agentctl prune` | Operate | `REMOVE_CANDIDATE` | Remote session pruning/archiving housekeeping is vendor-specific administration. |
| `agentctl scan` | Inspect | `REMOVE_CANDIDATE` | Codebase TODO/FIXME scanner is peripheral to core verification. |
| `agentctl test-gen` | Create | `REMOVE_CANDIDATE` | TDD test generator belongs to coding agent capabilities, not orchestrator acceptance boundary. |
| `agentctl hydrate` | Inspect | `REMOVE_CANDIDATE` | Prepending system learnings/handover to prompts belongs in host-agent skill layers. |
| `agentctl learning` | Operate | `REMOVE_CANDIDATE` | SPORE persistent system learning memory belongs in repository/agent instruction files (e.g. `AGENTS.md`). |
| `agentctl rules` | Inspect | `REMOVE_CANDIDATE` | Rule token budget auditor/compiler belongs in developer tooling/scripts rather than public CLI contract. |

---

## 2. Root SDK Export Surface Inventory (250 Frozen Symbols)

`test/api-surface.test.mjs` freezes 250 symbols exported at package root (`index.mjs`). v1 proposes contracting the public SDK root surface down to a small target contract (~15–25 core symbols) while internalizing or deprecating implementation helpers.

### Summary by Functional Family

| Export Family | Symbol Count | Proposed Classification | Proposed Direction |
| --- | --- | --- | --- |
| **Core Operations** | 5 | `CORE_V1` | Keep `dispatch`, `dispatchTask`, `gate`, `repair`, `run`. |
| **Config & Environment** | 10 | `CORE_V1` / `INTERNALIZE` | Keep `loadConfig`, `planInit`; internalize helpers (`ENV_ALIASES`, `applyEnvAliases`, `describeEnvVar`, etc.). |
| **Task Envelope & Authoring** | 8 | `CORE_V1` / `INTERNALIZE` | Keep `buildAgentEnvelope`, `planTaskCreate`, `validateEnvelope`; internalize wizards and prompt optimizers. |
| **Provider Core & Errors** | 15 | `CORE_V1` / `ADVANCED_V1` | Keep provider factory (`createProvider`) and explicit error classes (`BudgetError`, `MissingApiKeyError`, `ProviderRateLimitError`, `ProviderUnavailableError`); internalize preset literals. |
| **Verification Profiles** | 7 | `ADVANCED_V1` / `INTERNALIZE` | Keep `buildProfileStages`, `describeProfilePlan`; internalize raw constant arrays. |
| **Evidence & Integrity** | 7 | `CORE_V1` / `ADVANCED_V1` | Keep `generateEvidenceManifest`, `verifyEvidenceManifest`; internalize formatting/hashing details. |
| **Scope & Security Guards** | 12 | `INTERNALIZE` | Internalize `checkScope`, `redactSecrets`, `hasEncodedSecret`, `shannonEntropy`, `checkTestTampering`, `assertTestIntegrity`, etc. |
| **Git & Process Utilities** | 15 | `INTERNALIZE` | Internalize `git`, `canonicalizePath`, `changedFiles`, `isPidAlive`, `withVfsMutex`, `runCmd`, etc. |
| **State, Budget, Locks & Journal** | 20 | `INTERNALIZE` | Internalize `acquireLock`, `releaseLock`, `lockStatus`, `checkDailyBudget`, `reserveBudget`, `journalDone`, etc. |
| **Stack Oracle & Detection** | 8 | `INTERNALIZE` / `ADVANCED_V1` | Keep `detectStack` if required by downstream tooling; internalize `detectStackOracles`, `bootstrapZeroTestRepo`. |
| **Mutation & Diff Coverage** | 12 | `REMOVE_CANDIDATE` | Propose removing `runMutationTest`, `assertMutation`, `assertDiffCoverage`, `calculateDiffCoverage` from root SDK. |
| **Stability & Perf Monitoring** | 6 | `REMOVE_CANDIDATE` | Propose removing `runStabilityProbe`, `measureEventLoopDelay`, `assertEventLoopLag` from root SDK. |
| **Assertions DSL** | 8 | `REMOVE_CANDIDATE` | Propose removing `assertDirSize`, `assertFileExists`, `assertFileSize`, `assertFilePatterns`, etc. |
| **Queue & DAG Engine** | 6 | `INTERNALIZE` | Internalize `executeQueueDag`, `DagExecutor`, `classifyQueueFailure`. |
| **Session Operations & Patching** | 10 | `ADVANCED_V1` / `INTERNALIZE` | Keep high-level session lifecycle functions (`extractSessionPatch`, `applySessionPatch`, `retrySession`, `pruneSessions`); internalize helpers. |
| **Webhooks & Escalation** | 10 | `REMOVE_CANDIDATE` | Propose removing webhook server and escalation digest exports (`bufferEscalationIncident`, `createWebhookServer`, etc.). |
| **Flaky Quarantine & Healing** | 8 | `REMOVE_CANDIDATE` | Propose removing flaky ledger and healing swarm exports (`listQuarantinedTests`, `synthesizeFlakyHealingTask`, etc.). |
| **SPORE Memory & Learnings** | 6 | `REMOVE_CANDIDATE` | Propose removing system learning exports (`recordLearning`, `hydratePrompt`, `loadLearnings`, etc.). |
| **TDD Generator** | 5 | `REMOVE_CANDIDATE` | Propose removing TDD generator exports (`scaffoldTddTest`, `runTddCycle`, `TddError`). |
| **Handover & Checkpoints** | 8 | `INTERNALIZE` / `REMOVE_CANDIDATE` | Internalize or remove `createHandover`, `loadHandover`, `createCheckpoint`, `restoreCheckpoint`. |
| **UI & TUI Primitives** | 12 | `INTERNALIZE` | Internalize prompt/UI primitives (`select`, `confirm`, `input`, `spinner`, `styleText`, `ANSI`, etc.). |
| **MCP & Transport Helpers** | 4 | `INTERNALIZE` | Internalize `isolateMcpStdout`, `writeMcpFrame`. |
| **Web Task Templates** | 5 | `REMOVE_CANDIDATE` | Propose removing web template exports (`listWebTemplates`, `synthesizeWebEnvelope`, etc.). |
| **IDE Scaffolding** | 4 | `ADVANCED_V1` / `INTERNALIZE` | Keep `scaffoldIdeConfig` as advanced convenience or internalize. |
| **Constants & Error Classes** | 20 | `CORE_V1` / `INTERNALIZE` | Keep `KIT_VERSION`, `GUARDRAIL_FOOTER`, core error classes; internalize minor constants (`CEILING_FILE`, `ROLLING_WINDOW_MS`, etc.). |

---

## 3. MCP Tool & Resource Inventory

Examines tools registered in `src/mcp.mjs` (`MCP_TOOLS`, `MCP_TOOL_ALIASES`, and resources).

### Tools (`MCP_TOOLS`)

| Tool Name | Proposed Classification | Rationale (Tied to Task → Dispatch → Gate → Evidence) |
| --- | --- | --- |
| `dispatch_jules_task` / `agent_dispatch_task` | `CORE_V1` | Primary task dispatch tool mapping directly to core `dispatch` function. |
| `audit_jules_gate` / `agent_audit_gate` | `CORE_V1` | Primary gate verification tool mapping directly to core `gate` function (strictly non-mutating in v1). |
| `get_jules_status` / `agent_get_status` | `CORE_V1` | Core diagnostic and status tool reporting budget, locks, provider readiness, and gate profile. |
| `check_risk_tier` | `INTERNALIZE` | Risk tier classification is an internal gate policy detail; propose internalizing rather than exposing as standalone MCP tool. |
| `telemetry_tail` | `REMOVE_CANDIDATE` | Telemetry tail inspection is outside the core Task → Dispatch → Gate pipeline. |
| `optimize_jules_prompt` / `agent_optimize_prompt` | `REMOVE_CANDIDATE` | Prompt optimization is a host-agent authoring concern, not core orchestrator primitive. |
| `get_web_task_template` | `REMOVE_CANDIDATE` | Web task templates belong in documentation or host-agent skills. |
| `record_system_learning` | `REMOVE_CANDIDATE` | SPORE persistent memory belongs in repository/agent instruction files. |
| `jules_list_sessions` / `agent_list_sessions` | `ADVANCED_V1` | Remote session listing for provider-aware lifecycle management. |
| `jules_list_activities` / `agent_list_activities` | `ADVANCED_V1` | Inspection of execution logs and activities for a remote session. |
| `jules_get_session_output` / `agent_get_session_output` | `ADVANCED_V1` | Remote session patch extraction and PR metadata retrieval. |
| `jules_archive_session` / `agent_archive_session` | `ADVANCED_V1` | Remote session archiving. |
| `jules_delete_session` / `agent_delete_session` | `ADVANCED_V1` | Remote session deletion. |
| `jules_retry_session` / `agent_retry_session` | `ADVANCED_V1` | Session retry with failure trace injection. |
| `jules_apply_patch` / `agent_apply_patch` | `ADVANCED_V1` | Remote session patch materialization and verification. |
| `jules_list_sources` / `agent_list_sources` | `ADVANCED_V1` | Listing connected repository sources for Jules provider. |
| `jules_prune_sessions` / `agent_prune_sessions` | `ADVANCED_V1` | Session cleanup and pruning. |
| `jules_approve_plan` / `agent_approve_plan` | `ADVANCED_V1` | Plan approval for sessions requiring human confirmation. |
| `jules_send_message` / `agent_send_message` | `ADVANCED_V1` | Sending feedback/steering messages to warm sessions. |
| `jules_wait_for_session` / `agent_wait_for_session` | `ADVANCED_V1` | Synchronous polling for remote session completion. |

### MCP Resources

| Resource URI | Proposed Classification | Rationale |
| --- | --- | --- |
| `jules://status` | `CORE_V1` | Machine-readable status resource for daily budget, locks, provider readiness, and gate profile. |
| `jules://sources` | `ADVANCED_V1` | Provider connected repository sources listing. |
| `jules://sessions` | `ADVANCED_V1` | Recent sessions snapshot resource. |

---

## 4. Scaffolding and Init Output Inventory

Examines files and configuration written by `bin/init.js`, `agentctl init`, `src/scaffold.mjs`, and `src/wizard-init.mjs`.

| Output Asset | Proposed Classification | Rationale & Proposed Direction |
| --- | --- | --- |
| `.agent/config.yml` | `CORE_V1` | Single canonical project configuration file. |
| `.agent/jules.yml` | `DEPRECATE_PRE_V1` | Legacy 0.x configuration file; read for migration compatibility, then omitted from default `init` output. |
| `.gitignore` entries | `CORE_V1` | Essential runtime ignore entries (locks, temporary state, evidence caches). |
| `.github/workflows/agent-gate.yml` | `ADVANCED_V1` | Stack-aware CI gate workflow generator; opt-in or created via `agentctl ci init`. |
| `AGENTS.md` | `INTERNALIZE` / `REMOVE_CANDIDATE` | Currently written during legacy `init`; propose making default `init` write config only, leaving `AGENTS.md` as opt-in or user-owned. |
| `.agent/prompts/*` (12 specialist roles) | `REMOVE_CANDIDATE` | Propose omitting heavy prompt assets from default `init`; serve from kit defaults or host-agent skill packs. |
| `.agent/rules/*` (rule sentinels) | `REMOVE_CANDIDATE` | Propose omitting rule budget files from default `init` unless explicitly requested. |
| `.agent/workflows/*` | `REMOVE_CANDIDATE` | Propose omitting generic workflows from default `init`. |
| `.agent/JULES_WEB_SETUP.md` | `ADVANCED_V1` | Encoded Jules web UI setup preset token; generated when provider is Jules or via explicit flag. |
| `package.json` `agent:*` scripts | `ADVANCED_V1` | Convenience scripts injected into target `package.json` during `init`. |
| `.env` additions (`JULES_REPO`, `BASE_BRANCH`) | `ADVANCED_V1` | Configuration values written to `.env` during interactive setup. |

---

## 5. Ambiguities and Areas Requiring Owner Decision

The following inventory points were identified as ambiguous or requiring explicit owner decision during v1 planning:

1. **`agentctl repair` vs. `agentctl fix`**:
   - `repair` is the registered command ID in `COMMAND_REGISTRY`, while `fix` exists as a shortcut/alias and as a mutating flag on `gate (--fix)`.
   - *Owner Decision Needed*: Should `gate` be strictly non-mutating with `--fix` removed, making `repair` the sole mutating repair primitive, and should the CLI shortcut `fix` be deprecated or retained as a shortcut for `repair`?

2. **Command Consolidation (`queue` / `swarm` vs. `dispatch --queue`)**:
   - `agentctl queue` and `agentctl swarm` currently execute pending tasks.
   - *Owner Decision Needed*: Should `queue` and `swarm` be deprecated as top-level CLI commands in favor of `dispatch --queue [--concurrency N]`, or retained as `ADVANCED_V1` shortcuts?

3. **Prompt Scoring and Task Templates (`task optimize` / `task template`)**:
   - `task optimize` (prompt scoring) and `task template` (web task templates) add significant surface area.
   - *Owner Decision Needed*: Should prompt optimization and templates be removed from the orchestrator core and moved to documentation or host-agent skills?

4. **SDK Contract Contraction Boundary**:
   - `test/api-surface.test.mjs` freezes 250 exports at package root `index.mjs`.
   - *Owner Decision Needed*: Confirm the target v1 root SDK export list (~15–25 symbols) and whether subpath exports (e.g. `jules-orchestrator-kit/errors`, `jules-orchestrator-kit/provider`) should be established for advanced consumers.

5. **`jules_*` vs. `agent_*` MCP Naming**:
   - Current MCP tools support both `jules_*` names and `agent_*` provider-neutral aliases.
   - *Owner Decision Needed*: Should `jules_*` tool names be deprecated in favor of provider-neutral `agent_*` names, or retained for backwards compatibility with existing MCP clients?

6. **Default Init Asset Scope**:
   - Currently `bin/init.js` writes `.agent/config.yml`, `.agent/jules.yml`, `AGENTS.md`, `.agent/prompts/`, `.agent/rules/`, `.agent/workflows/`, `.github/workflows/agent-gate.yml`, and `.agent/JULES_WEB_SETUP.md`.
   - *Owner Decision Needed*: Confirm that minimal v1 `agentctl init` should write *only* `.agent/config.yml` and `.gitignore` entries by default, making all other assets opt-in.
