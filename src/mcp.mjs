import { createInterface } from "node:readline";
import { loadConfig, resolveRoot, detectStack } from "./config.mjs";
import { gate, dispatch } from "./engine.mjs";
import { classifyRiskTier } from "./risk.mjs";
import { checkDailyBudget, lockStatus } from "./state.mjs";

export const MCP_SERVER_INFO = {
  name: "jules-orchestrator-kit",
  version: "0.10.0",
};

export const MCP_TOOLS = [
  {
    name: "dispatch_jules_task",
    description: "Dispatch an autonomous task to the Jules AI agent provider with security bounds and budget check.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short descriptive title for the task" },
        prompt: { type: "string", description: "Detailed task instructions and prompt" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "audit_jules_gate",
    description: "Run the 4-phase safety gatekeeper (Scope, Payload, Secrets, Verify) against the current workspace branch.",
    inputSchema: {
      type: "object",
      properties: {
        base: { type: "string", description: "Base branch to diff against (defaults to main)" },
        fix: { type: "boolean", description: "Attempt OODA auto-repair loop on verification failure" },
        allowProtected: { type: "boolean", description: "Allow edits to protected files" },
      },
    },
  },
  {
    name: "check_risk_tier",
    description: "Classify changed files into Risk Tiers (R0 Cosmetic, R1 Routine, R2 Consequential, R3 Restricted).",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "List of file paths changed",
        },
        diffLines: { type: "number", description: "Total lines changed in diff" },
      },
      required: ["files"],
    },
  },
  {
    name: "get_jules_status",
    description: "Retrieve orchestrator status including daily task budget, active locks, and stack diagnostics.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

export async function handleMcpRequest(request, opts = {}) {
  const root = opts.root || resolveRoot();
  const config = opts.config || loadConfig(root);
  const { id, method, params } = request;

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
      },
    };
  }

  if (method === "notifications/initialized") {
    return null; // Notifications produce no response
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: MCP_TOOLS },
    };
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const args = params?.arguments || {};

    try {
      if (toolName === "dispatch_jules_task") {
        const session = await dispatch(
          { title: args.title || "MCP Task Dispatch", prompt: args.prompt },
          { root, config }
        );
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ ok: true, session }, null, 2) }],
          },
        };
      }

      if (toolName === "audit_jules_gate") {
        const res = await gate({
          root,
          config,
          base: args.base || config.baseBranch || "main",
          fix: args.fix || false,
          allowProtected: args.allowProtected || false,
        });
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
          },
        };
      }

      if (toolName === "check_risk_tier") {
        const tierResult = classifyRiskTier(args.files || [], { diffLines: args.diffLines || 0 });
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(tierResult, null, 2) }],
          },
        };
      }

      if (toolName === "get_jules_status") {
        const stackInfo = detectStack(root);
        const budget = checkDailyBudget(root, config.limits.dailyTasks);
        const locks = lockStatus(root);
        const status = {
          version: MCP_SERVER_INFO.version,
          root,
          stack: stackInfo.stack,
          budget: { used: budget.used, limit: budget.budget, remaining: budget.budget - budget.used },
          activeLocksCount: locks.length,
          locks,
        };
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
          },
        };
      }

      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown tool: ${toolName}` },
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: err.message }, null, 2) }],
          isError: true,
        },
      };
    }
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

export function startMcpServer(input = process.stdin, output = process.stdout, opts = {}) {
  const rl = createInterface({ input, output: null, terminal: false });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const request = JSON.parse(trimmed);
      const response = await handleMcpRequest(request, opts);
      if (response !== null) {
        output.write(JSON.stringify(response) + "\n");
      }
    } catch (err) {
      output.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: `Parse error: ${err.message}` },
        }) + "\n"
      );
    }
  });
}
