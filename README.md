# jules-orchestrator-kit

Task dispatch and local verification for coding agents. Requires Node.js 20+ and
Git; uses no third-party runtime dependencies.

[![npm version](https://img.shields.io/npm/v/jules-orchestrator-kit.svg)](https://www.npmjs.com/package/jules-orchestrator-kit)
[![CI](https://github.com/FullThrottle83/jules-orchestrator-kit/actions/workflows/jules-audit.yml/badge.svg)](https://github.com/FullThrottle83/jules-orchestrator-kit/actions/workflows/jules-audit.yml)

## Overview

Use the kit to describe a scoped coding task, send it to Google Jules or an
installed Claude Code, Codex or Gemini CLI, and verify the resulting changes.
You can also run local checks without connecting an agent provider.

**Dispatch, verification and repair are explicit.** Dispatch sends the task;
`gate` runs configured checks without mutating the working tree. Use
`agentctl repair` explicitly for repair workflows. Provider output and passing
checks still need review before merging.

The current release is **v0.73.1**, a pre-1.0 release. A long-term stability policy is a
[v1.0 goal](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/ROADMAP_V1.md).

## Quickstart

Start in an existing Git repository with working tests. Commit or stash unrelated
changes so that you can review exactly what setup adds. Node.js runs the kit;
your project's own runtime and test tools must also be installed.

### 1. Configure the repository

```bash
npx jules-orchestrator-kit init
```

The wizard detects the project and asks about provider and verification settings.
Use `init --yes` to accept defaults. By default it writes only the canonical
`.agent/config.yml` plus runtime-state entries in `.gitignore` when they are
missing. Inspect the generated configuration and diff, especially the test
command and protected paths. Use `init --dry-run` to preview the exact writes
without changing the repository.

The historical full scaffold (AGENTS.md, specialist prompts, rules, workflows and
contract templates) remains available through `agentctl init --force` and the
legacy `jules-init` entry point during the 0.x migration window; it is no longer
default-owned by `agentctl init`.

```bash
git diff
git status --short
```

Stage the generated files you reviewed, then commit them. The committed
configuration establishes the trusted base policy used by verification. On an
already initialized repository, back up and review `.agent/config.yml` before
rerunning `init`. Existing legacy `.agent/jules.yml` files are left untouched
by the default path. `--force` deliberately opts back into the legacy full scaffold.

### 2. Check provider readiness

```bash
npx jules-orchestrator-kit providers
```

This reports which providers are available and what setup is missing. Remote
Jules dispatch needs credentials; local CLI providers need their installed,
authenticated CLI. Follow the
[configuration reference](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/docs/configuration.md).
Never commit API keys.

### 3. Create and review a task

```bash
npx jules-orchestrator-kit task create \
  --prompt "Refactor invoice calculation without changing totals" \
  --verify "npm test"
```

Replace the example objective and test command with your project's requirements.
A task envelope is a Markdown file under `.agent/jules-queue/` containing the
objective, scope and verification command. Review it before sending it to an agent.

```bash
# Preview queued work without dispatching it
npx jules-orchestrator-kit queue --dry-run

# Send the reviewed task, using the path printed by task create
npx jules-orchestrator-kit dispatch ".agent/jules-queue/TASK-<id>.md"
```

Replace `TASK-<id>.md` with the actual filename. Dispatch can use provider quota
or incur provider costs. Jules can pause for plan approval; see the
[Jules notes](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/docs/providers/jules.md).

### 4. Verify and review the changes

Once the provider's changes are available on your local branch:

```bash
npx jules-orchestrator-kit gate
```

Inspect the gate report and the complete diff before merging. For hosted Jules,
fetch and check out the resulting branch first; local CLI providers leave changes
in the working tree. Creating or dispatching an envelope does not verify the result.

For direct `agentctl` commands, install globally with
`npm install -g jules-orchestrator-kit`. All examples above also work as
`agentctl <command>` after installation.

## Key workflows

| Goal | Command |
| --- | --- |
| Inspect provider setup | `agentctl providers` |
| Create a scoped task | `agentctl task create` |
| Preview queued work | `agentctl queue --dry-run` |
| Check changes locally | `agentctl gate` |
| Start an explicit repair workflow | `agentctl repair --input "<failure>" --task` |
| Diagnose setup | `agentctl doctor` |
| Inspect a command's flags | `agentctl help <command>` |

Start with small changes and an observable acceptance condition. Visual decisions,
production credentials and integration environments need explicit human setup.
See [task examples](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/EXAMPLES.md).

## Verification profiles

| Profile | Verification stages |
| --- | --- |
| `minimal` | Setup and tests |
| `standard` | Setup, lint, tests, build and diff anti-tamper checks |
| `max` | Standard stages plus mutation scoring, Node V8 diff coverage and flakiness probes |

Select with `agentctl profile --set standard`. Stages depend on the detected stack
and configuration; unsupported checks are reported. Review those diagnostics
rather than assuming every profile runs every check on every language.

Local checks do not require a provider API key. The project's configured commands
may themselves need dependencies, services or network access. Automated repairs
require a provider.

## Architecture

The dispatch pipeline builds task context and calls a provider. The verification
pipeline evaluates scope, payload, security findings and configured commands.
The repository and local state connect them. The package exposes an ESM SDK and a
stdio MCP server alongside the CLI.

See [architecture and exit codes](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/docs/architecture.md)
and [SDK/MCP integration](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/docs/sdk.md).

## CLI

| Command | Description |
| --- | --- |
| `dashboard` | Local telemetry viewer; default port 4100. Set another port with `--port <n>`. |


The [command reference](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/docs/COMMAND_REFERENCE.md)
is generated from the registry used by `--help`. It covers dispatch, queues,
verification, evidence, diagnostics and the supported aliases.

## Development and verification

Clone this repository to run its tests; the npm package excludes the test suite.

```bash
npm ci
npm test
npm run lint
npm run jules:doc-sync
npm run jules:rules-lint
npm run package-integrity
npm run guard-reach
```

The recorded baseline is **1547 unit tests across 204 suites**. Doc-sync compares
that count with an actual run. Counts do not establish correctness for every
provider or project. See
[contributing](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/CONTRIBUTING.md)
for the review process.

## Documentation and removal

- [Documentation index](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/docs/README.md)
- [Configuration](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/docs/configuration.md)
- [Uninstall and generated-file inventory](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/docs/uninstall.md)
- [Changelog](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/CHANGELOG.md)
- [Security policy](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/SECURITY.md)

## Complete Uninstall / Removing the Kit (Undo Init)

`agentctl clean` performs operational maintenance; it is not an uninstaller.
First identify which files setup created and which files already belonged to your
project. For shared files, remove only the kit's additions using Git history.

For the default minimal setup, remove `.agent/config.yml` and the kit's
runtime-state block from `.gitignore`. Repositories that previously used the
legacy full scaffold may also contain AGENTS.md, prompts, rules, workflows and
contract files; remove those only after confirming ownership.

See the uninstall guide for the complete inventory and legacy cleanup steps.

## Limitations and attribution

Secret scanning, test-tamper detection and prompt transformations are checks with
coverage limits, not a security guarantee. Prompt substitutions can change meaning;
review exact operational instructions. See the Jules notes for details.

Maintained by Jonas Pudas with agent-assisted contributions recorded in Git history
and the [contributors ledger](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/CONTRIBUTORS.md).
Licensed under MIT. This independent project is not affiliated with or endorsed by
Google; Google and Google Jules are trademarks of their respective owners.
