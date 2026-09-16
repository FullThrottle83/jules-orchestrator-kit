# Documentation Sitemap

Start here. Find the page that matches what you are trying to do; every path is relative to the repository root.

---

## I want to…

### …get started / onboard a repository
- **[README → Quickstart](../README.md#quickstart)** — the `init` → review/commit → task → dispatch → verify flow, provider probe, and verification-profile selection.
- [EXAMPLES.md](../EXAMPLES.md) — production task envelope recipes to copy.

### …configure an agent, provider, or the gate
- **[docs/configuration.md](configuration.md)** — `.agent/config.yml` reference (verify commands, scope rules, plan tiers, risk model, limits, cost router), provider setup (`agentctl providers`, `agentctl provider set`), `AGENT_*`/`JULES_*` environment variables, and the 26+ detected ecosystems.

### …add a verification gate (or make the gate stricter)
- **[README → Verification Profiles](../README.md#verification-profiles)** — `minimal` / `standard` / `max` stage tables and when to use each.
- [docs/architecture.md → Verification Gate Phases](architecture.md) — what each gate phase actually checks, and the OODA repair loop.
- [docs/COMMAND_REFERENCE.md](COMMAND_REFERENCE.md) — flags for `check`/`gate`, `mutate`, `coverage`, `probe`, `perf`, `assert`, and `evidence`.

### …dispatch tasks and run the queue
- [README → Key Workflows](../README.md#key-workflows) — everyday commands and task selection (what to dispatch vs. keep human-in-the-loop).
- [docs/COMMAND_REFERENCE.md](COMMAND_REFERENCE.md) — `task create`, `task template`, `dispatch`, `queue`, `swarm`, `retry`, `pr harvest`.
- [EXAMPLES.md](../EXAMPLES.md) — envelope formats, roles, and templates.

### …understand how the system works
- **[docs/architecture.md](architecture.md)** — the two-pipeline model (Dispatch vs Verification), provider execution models, sequence diagrams, exit codes, and what the orchestrator deliberately does not do.
- [docs/assets/](assets) — SVG diagrams (hero flow, architecture layers, OODA loop, monorepo resolver, swarm topology, silence governor, flaky-healing swarm).

### …use the SDK or MCP server programmatically
- **[docs/sdk.md](sdk.md)** — `createFailoverProvider`, `resolveRoutedProvider`, `createSyntaxVerifiedProvider`, the MCP server, and provider-neutral `agent_*` tool aliases.

### …look up a CLI flag or exit code
- **[docs/COMMAND_REFERENCE.md](COMMAND_REFERENCE.md)** — generated from the same registry that powers `agentctl --help`; always current.
- [Architecture → Exit Code Registry](architecture.md#exit-code-registry) — exit codes `0`–`8` (+`188`) and remediation for each.

### …set the rules an autonomous worker follows
- **[AGENTS.md](../AGENTS.md)** — authoritative contributor instructions for this repository.
- [JULES_RULES_TEMPLATE.md](../JULES_RULES_TEMPLATE.md) — the scaffold master `agentctl init` copies into target repositories; the shared working rules are kept byte-identical to `AGENTS.md` (between the `SYNC-CORE` anchors).
- [Jules provider notes](providers/jules.md) — setup, approval handling and operational limitations. The legacy protocol file is a compatibility reference only.

### …remove the kit from a repository
- **[docs/uninstall.md](uninstall.md)** — full inventory of scaffolded assets and runtime state, and the removal procedure.

### …contribute, report, or release
- [CONTRIBUTING.md](../CONTRIBUTING.md) — PR-based contribution flow, Conventional Commits, and commit-signing rules.
- [CONTRIBUTORS.md](../CONTRIBUTORS.md) — attribution ledger: human maintainers and autonomous coding agents.
- [SECURITY.md](../SECURITY.md) — supported versions and vulnerability disclosure.
- [Release procedure](releasing.md) — changelog-first version bumps and `npm run release` gates.
- [npm payload audit](package-payload.md) — file reachability and packed-package verification.
- [Historical reports](archive/README.md) — earlier audits retained for traceability.

### …read history and plans
- [CHANGELOG.md](../CHANGELOG.md) — full release history (Keep a Changelog format), including archived roadmap milestone summaries for v0.20.0–v0.65.0.
- [ROADMAP_V1.md](../ROADMAP_V1.md) — current priorities and prerequisites for v1.0.

---

## Maintenance notes for doc authors

- `docs/COMMAND_REFERENCE.md` is **generated** — regenerate with `node scripts/generate-command-reference.mjs`, never hand-edit.
- `npm run jules:doc-sync` enforces README/ROADMAP/CHANGELOG/SECURITY agreement with `package.json` and the real test counts; `npm run jules:rules-lint` enforces the agent rule-file budgets.
- Keep released behavior and version history in `CHANGELOG.md`; use the roadmap for current priorities.
