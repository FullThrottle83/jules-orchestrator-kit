# SDK and MCP

The ESM SDK and stdio MCP server use the same dispatch and verification core as
the CLI. Imports come from `jules-orchestrator-kit`; there are no third-party
runtime dependencies. Pin the package version for integrations during 0.x and
review the changelog before upgrading. The existing export list is broader than
the proposed long-term API; see the [surface inventory](v1-surface-inventory.md).

## Verify candidate changes

Run this in an initialized repository with reviewed, committed policy and
installed verification dependencies:

```javascript
import { gate } from "jules-orchestrator-kit";

const result = await gate({ root: process.cwd() });
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.code;
```

`result.ok` and `result.code` describe the independent gate outcome. `phases`
contains diagnostics, and `evidence` is present when verification reaches that
phase. Gate execution runs configured project commands and may write runtime
state and evidence; it does not dispatch repair.

`result.ok` is a verdict on the repository policy. Pass
`gate({ root, task: "<path to task envelope>" })` to also apply that task's
`scope.allow` / `scope.deny`; `result.taskScope.checked` says whether it ran, and
`result.commitProvenance` lists author, committer and signature status as
observation only. See [Task scope and commit provenance](architecture.md#task-scope-and-commit-provenance).

## Dispatch one task

```javascript
import { dispatch } from "jules-orchestrator-kit";

const result = await dispatch(
  { title: "Handle empty input", prompt: "Make parseRows handle empty input and add a regression test." },
  { root: process.cwd() }
);
console.log(result.kind, result.provider, result.id, result.status);
```

`kind: "local-result"` means a local CLI finished; candidate changes are in the
checkout. `kind: "remote-session"` means hosted work continues elsewhere. Inspect
and retrieve that result before invoking `gate()` on the candidate revision.
Dispatch can consume provider quota or incur charges. Its completion status is
separate from independent verification and merge approval.

The [threat model](../SECURITY.md) also applies to SDK and MCP use. Verification
commands execute with the runner account's OS permissions.

---

## Optional provider failover (`createFailoverProvider`)

```javascript
import { createFailoverProvider, loadConfig } from "jules-orchestrator-kit";

const config = loadConfig(process.cwd());
const provider = createFailoverProvider(["jules", "claude-code"], config);

const result = await provider.dispatch(
  { title: "Repair failing tests", prompt: "Fix the failing test suite." },
  { root: process.cwd() }
);
```

## Optional task routing (`resolveRoutedProvider`)

Routes mechanical tasks to a lightweight "fast" tier and reserves the primary model for complex work. Requires `router.enabled: true` in `.agent/config.yml` (see [Configuration Reference](configuration.md#agent-configyml-reference)).

```javascript
import { resolveRoutedProvider, loadConfig } from "jules-orchestrator-kit";

const config = loadConfig(process.cwd()); // router.enabled must be true in .agent/config.yml
const { provider, classification } = resolveRoutedProvider(
  { title: "Fix typo", prompt: "Fix a typo in the README." },
  config
);
console.log(classification.tier); // "fast" | "complex"
```

## Optional syntax checks for local fast providers (`createSyntaxVerifiedProvider`)

`resolveRoutedProvider()` already wraps the FAST tier with this; use it directly only when composing your own provider cascade.

```javascript
import { createProvider, createSyntaxVerifiedProvider, loadConfig } from "jules-orchestrator-kit";

const config = loadConfig(process.cwd());
const fast = createSyntaxVerifiedProvider(
  createProvider("gemini-flash", config),
  createProvider("jules", config),
  config
);

// If gemini-flash leaves broken .js/.mjs/.cjs on disk, this transparently
// re-dispatches through "jules" instead of returning the broken result.
const result = await fast.dispatch({ prompt: "Fix a typo." }, { root: process.cwd() });
```

## MCP Server

`agentctl mcp` starts a stdio Model Context Protocol server for Claude, Cursor, and Antigravity; `agentctl mcp init [--target cursor|vscode|claude|all]` scaffolds the client configuration (`.cursor/mcp.json`, VS Code `tasks.json`, Claude Desktop).

### Provider-neutral MCP tool aliases

The MCP server advertises and accepts `agent_*` aliases alongside all existing names. Every `jules_*` tool has an equivalent `agent_*` name (for example, `jules_list_sessions` → `agent_list_sessions` and `jules_send_message` → `agent_send_message`). The other provider-branded tools map as follows:

| Existing name | Provider-neutral alias |
| :-- | :-- |
| `dispatch_jules_task` | `agent_dispatch_task` |
| `audit_jules_gate` | `agent_audit_gate` |
| `get_jules_status` | `agent_get_status` |
| `optimize_jules_prompt` | `agent_optimize_prompt` |

Aliases use identical input schemas, handlers, and safety checks. Existing clients need no changes. Naming is provider-neutral; actual capabilities still depend on the configured provider, and an alias does not make a Jules-specific operation supported by every provider.

## Related

- [CLI Command Reference](COMMAND_REFERENCE.md) — the full `agentctl` surface, including `mcp` and `mcp init`.
- [Architecture & Pipeline Flow](architecture.md) — provider execution models (hosted REST vs local CLI).
