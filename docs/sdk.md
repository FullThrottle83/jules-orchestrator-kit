# SDK & MCP Integrations

Programmatic usage of `jules-orchestrator-kit` from Node.js, plus the Model Context Protocol (MCP) server surface. All exports come from the package root (`index.mjs`) and carry zero runtime dependencies.

---

## Multi-Provider Failover SDK (`createFailoverProvider`)

```javascript
import { createFailoverProvider, loadConfig } from "jules-orchestrator-kit";

const config = loadConfig(process.cwd());
const provider = createFailoverProvider(["jules", "claude-code"], config);

const result = await provider.dispatch(
  { title: "Repair failing tests", prompt: "Fix the failing test suite." },
  { root: process.cwd() }
);
```

## Cost Router SDK (`resolveRoutedProvider`)

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

## Syntax-Verified FAST Tier (`createSyntaxVerifiedProvider`)

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
