# jules-orchestrator-kit

Task dispatch and local verification for coding agents. Requires Node.js 22+ and
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

The current release is **v0.76.2**, a **0.x preview for selected developers**
working in Git repositories with existing tests. Start with one small task and
one provider. Review the changelog before upgrading and pin the package version
in repeatable workflows. The CLI, SDK and MCP surfaces are being refined toward a
[smaller long-term contract](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/ROADMAP_V1.md).

## Preview scope

The recommended workflow is task authoring, single-provider dispatch, independent
verification, evidence inspection and human review. The gate also works on changes
you made yourself, without any provider credentials.

The CI matrix runs on Linux, macOS and Windows with Node.js 22 and 24. Stack
detection is broader than the packed-package integration coverage, which currently
uses a Node.js consumer. Detection does not establish end-to-end compatibility
with every framework, provider version or external service.

Queue concurrency, routing, specialist prompts, dashboards and additional quality
probes remain available for existing users. Evaluate them separately after the
basic workflow succeeds.

## Quickstart

Start in an existing Git repository with working tests. Commit or stash unrelated
changes so that you can review exactly what setup adds. Node.js runs the kit;
your project's own runtime and test tools must also be installed.

### 1. Configure the repository

```bash
npx jules-orchestrator-kit@0.76.2 init
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
npx jules-orchestrator-kit@0.76.2 providers
```

This checks local prerequisites: credential presence for hosted Jules and CLI
discovery for local providers. It does not validate credentials, account access
or quota. Remote Jules dispatch needs valid credentials; local CLI providers need
their installed, authenticated CLI. Follow the
[configuration reference](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/docs/configuration.md).
Never commit API keys.

### 3. Create and review a task

```bash
npx jules-orchestrator-kit@0.76.2 task create \
  --prompt "Refactor invoice calculation without changing totals" \
  --verify "npm test"
```

Replace the example objective and test command with your project's requirements.
A task envelope is a Markdown file under `.agent/jules-queue/` containing the
objective, scope and verification command. Review it before sending it to an agent.

```bash
# Preview queued work without dispatching it
npx jules-orchestrator-kit@0.76.2 queue --dry-run

# Send the reviewed task, using the path printed by task create
npx jules-orchestrator-kit@0.76.2 dispatch ".agent/jules-queue/TASK-<id>.md"
```

Replace `TASK-<id>.md` with the actual filename. Dispatch can use provider quota
or incur provider costs. Jules can pause for plan approval; see the
[Jules notes](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/docs/providers/jules.md).

### 4. Verify and review the changes

Once the provider's changes are available on your local branch:

```bash
npx jules-orchestrator-kit@0.76.2 gate
```

Inspect the gate report and the complete diff before merging. For hosted Jules,
fetch and check out the resulting branch first; local CLI providers leave changes
in the working tree. Creating or dispatching an envelope does not verify the result.

For direct `agentctl` commands, install globally with
`npm install -g jules-orchestrator-kit@0.76.2`. All examples above also work as
`agentctl <command>` after installation.

## Key workflows

|Command | Description |
| --- | --- |
| `menu` | Interactive terminal navigation hub (`agentctl menu` or `agentctl -i`). |
| `providers` | Check configured and available agent providers (`agentctl providers`). |
| `task create` | Author a scoped task envelope (`agentctl task create`). |
| `queue` | Preview (`agentctl queue --dry-run`), list (`agentctl queue list`), or dispatch queued tasks. |
| `dispatch` | Send a single task or envelope to the configured provider (`agentctl dispatch`). |
| `gate` | Run configured scope, secret, payload, and test checks locally (`agentctl gate`). |
| `evidence show` | Inspect the latest verification evidence (`agentctl evidence show`). |
| `repair` | Run an explicit bounded repair workflow (`agentctl repair --input "<failure>" --task`). |
| `doctor` | Diagnose repository, oracle, and provider setup (`agentctl doctor`). |
| `dashboard` | Local telemetry viewer; default port 4100. Set another port with `--port <n>`. |
| `help <command>` | Inspect a command's flags and examples (`agentctl help <command>`). |

The [command reference](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/docs/COMMAND_REFERENCE.md)
is generated from the registry used by `--help`. It covers dispatch, queues,
verification, evidence, diagnostics and the supported aliases.

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

The recorded baseline is **1882 unit tests across 229 suites**. Doc-sync compares
that count with an actual run. Counts do not establish correctness for every
provider or project. See
[contributing](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/CONTRIBUTING.md)
for the review process.

## Documentation

- [Documentation index](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/docs/README.md)
- [Configuration](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/docs/configuration.md)
- [Command reference](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/docs/COMMAND_REFERENCE.md)
- [Changelog](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/CHANGELOG.md)
- [Security policy](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/SECURITY.md)

## Complete Uninstall / Removing the Kit (Undo Init)

`agentctl clean` performs operational maintenance; it is not an uninstaller.
Use `agentctl uninstall --dry-run` to preview removal or `agentctl uninstall --yes`
to remove the default minimal setup (`.agent/config.yml` and the kit's
runtime-state block in `.gitignore`) while preserving unrelated project files.

Repositories that previously used the legacy full scaffold may also contain
`AGENTS.md`, prompts, rules, workflows and contract files; remove those only
after confirming ownership in Git history. See the
[uninstall and generated-file inventory](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/docs/uninstall.md)
for the complete removal steps.

## Limitations and attribution

Verification runs project code with the operating-system permissions of the
account running the kit. The verification snapshot and filtered environment are
not an OS sandbox. Use a disposable runner without production credentials when
evaluating untrusted changes. See the
[threat model](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/SECURITY.md)
for the boundary and detection limits. Prompt substitutions can change meaning;
put exact operational commands in code spans or fenced blocks and review them.

For preview feedback, report package, Node, OS and provider CLI versions, the
command, expected result and a minimal reproduction in a
[GitHub issue](https://github.com/FullThrottle83/jules-orchestrator-kit/issues).
Remove credentials and private source. Report vulnerabilities privately using
the security policy.

Maintained by Jonas Pudas with agent-assisted contributions recorded in Git history
and the [contributors ledger](https://github.com/FullThrottle83/jules-orchestrator-kit/blob/main/CONTRIBUTORS.md).
Licensed under MIT. This independent project is not affiliated with or endorsed by
Google; Google and Google Jules are trademarks of their respective owners.
