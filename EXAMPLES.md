# Workflow examples

Start with the [quickstart](README.md#quickstart). These examples assume reviewed,
committed configuration and installed test dependencies. The `agentctl` spelling
requires an installed package; the equivalent one-off command is
`npx jules-orchestrator-kit@0.76.3 <command>`.

## Verify a local change without a provider

Make a small source change in your own repository, then run:

```bash
agentctl gate --json
agentctl evidence show
```

The gate checks scope, diff size, secrets, test integrity and configured commands.
A failure produces a nonzero exit code and diagnostics. Evidence is written when
verification reaches that phase and persistence is enabled; an early scope or
secret failure may have no new manifest. Inspect the report and diff before
accepting the change.

## Dispatch one scoped task

Use a concrete acceptance condition and your project's actual test command:

```bash
agentctl providers
agentctl task create --title "Handle empty input" \
  --prompt "Make parseRows return an empty array for empty input. Add a regression test and preserve existing non-empty behavior." \
  --verify "npm test"
agentctl queue --dry-run
```

Review the envelope under `.agent/jules-queue/`. Substitute its actual filename
below; dispatch can consume provider quota or incur charges:

```bash
agentctl dispatch ".agent/jules-queue/TASK-<id>.md"
```

A local CLI provider leaves changes in your checkout. Hosted Jules returns a
session handle and continues remotely; inspect it with
`agentctl session get <sessionId>`, then fetch and check out the resulting branch.
Plan approval may be required. See the [Jules notes](docs/providers/jules.md).

Once the candidate changes are local:

```bash
agentctl gate
git diff
agentctl evidence show
```

Dispatch completion alone does not run verification or approve a merge.

## Repair a test failure explicitly

When a gate failure is caused by failing tests, capture the failure and request
bounded repair. Scope, secret and test-integrity violations need their own
investigation. This shell example uses POSIX `sh`/Bash:

```bash
fail_log="$(mktemp)"
trap 'rm -f "$fail_log"' EXIT
if ! npm test >"$fail_log" 2>&1; then
  cat "$fail_log" >&2
  agentctl repair --file "$fail_log" --cmd "npm test" || exit $?
fi
agentctl gate
```

Repair can edit code and dispatch paid work. Attempts are bounded by repository
configuration and stop on repeated failure fingerprints. Review the final diff
and independent gate result.

## Add verification to CI

Generate and review a workflow suited to your repository:

```bash
agentctl ci init --dry-run
```

Inspect checkout, toolchain setup, dependency installation, base branch,
permissions and the gate invocation before writing or enabling it. Pin the kit
version used by CI. Tests execute candidate code, so use disposable runners and
keep production credentials out of pull-request jobs. Make the gate a required
check in branch rules if it should block merging.

## Connect an MCP client

Use `agentctl mcp init --target <client> --dry-run` to preview client configuration
for `cursor`, `vscode` or `claude`. Review tool inputs and client approval settings:
exposed operations can dispatch work and apply changes. Put credentials in the
client environment rather than checked-in configuration.

See the [SDK and MCP guide](docs/sdk.md) for provider lifecycles and aliases.

## Additional operations

Queues, routing, specialist roles, task templates and quality probes are listed
in the generated [command reference](docs/COMMAND_REFERENCE.md). Configure them
against your repository and toolchain before unattended use.

For a task that benefits from the packaged testing instructions, add
`--role testing` to dispatch and review the role's prompt alongside your task.

For removal, preview `agentctl uninstall --dry-run`, inspect the ownership report,
then use `agentctl uninstall --yes`. The [removal guide](docs/uninstall.md) describes
legacy scaffold assets and user-owned files that need separate review.
