import { Transform } from "node:stream";
import { loadConfig, resolveRoot, detectStack } from "./config.mjs";
import { gate, dispatch } from "./engine.mjs";
import { classifyRiskTier } from "./risk.mjs";
import { checkDailyBudget, lockStatus } from "./state.mjs";
import { reapOrphanedIntents, reapStaleMutexDirs } from "./journal.mjs";
import { readTelemetry } from "./telemetry.mjs";
import { ProgressBus } from "./mcp-progress.mjs";

export const MCP_SERVER_INFO = {
  name: "jules-orchestrator-kit",
  version: "0.28.2",
};

export const MAX_MCP_FRAME_SIZE = 4 * 1024 * 1024; // 4 MB memory safety ceiling

/**
 * Memory-bounded MCP Frame Decoder supporting both Content-Length headers and line-delimited JSON-RPC messages.
 */
export class McpFrameDecoder extends Transform {
  constructor(options = {}) {
    super({ ...options, readableObjectMode: true });
    this.buffer = Buffer.alloc(0);
    this.maxFrameSize = options.maxFrameSize || MAX_MCP_FRAME_SIZE;
  }

  _transform(chunk, encoding, callback) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    if (this.buffer.length > this.maxFrameSize * 2) {
      this.emit("error", new Error(`MCP Stdio buffer exceeded max limit of ${this.maxFrameSize} bytes`));
      this.buffer = Buffer.alloc(0);
      return callback();
    }

    while (this.buffer.length > 0) {
      const str = this.buffer.toString("utf-8");
      const headerMatch = /Content-Length:\s*(\d+)\r?\n\r?\n/i.exec(str);

      if (headerMatch) {
        const contentLength = parseInt(headerMatch[1], 10);
        if (contentLength > this.maxFrameSize) {
          this.emit("error", new Error(`Frame Content-Length (${contentLength}) exceeds limit (${this.maxFrameSize})`));
          this.buffer = Buffer.alloc(0);
          return callback();
        }

        const headerLength = headerMatch.index + headerMatch[0].length;
        const totalFrameLength = headerLength + contentLength;

        if (this.buffer.length >= totalFrameLength) {
          const payloadBuf = this.buffer.subarray(headerLength, totalFrameLength);
          this.buffer = this.buffer.subarray(totalFrameLength);
          try {
            const parsed = JSON.parse(payloadBuf.toString("utf-8"));
            this.push(parsed);
          } catch (err) {
            this.emit("error", new Error(`Malformed JSON payload in framed message: ${err.message}`));
          }
          continue;
        } else {
          break;
        }
      }

      const newlineIndex = this.buffer.indexOf(0x0a);
      if (newlineIndex !== -1) {
        const lineBuf = this.buffer.subarray(0, newlineIndex);
        this.buffer = this.buffer.subarray(newlineIndex + 1);

        const lineStr = lineBuf.toString("utf-8").trim();
        if (!lineStr) continue;

        if (/^Content-Length:\s*\d+/i.test(lineStr)) continue;

        try {
          const parsed = JSON.parse(lineStr);
          this.push(parsed);
        } catch (err) {
          this.emit("error", new Error(`Malformed JSON in line-delimited message: ${err.message}`));
        }
        continue;
      }

      break;
    }

    callback();
  }
}

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
  {
    name: "telemetry_tail",
    description: "Query the last N telemetry events from the orchestrator telemetry spine.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of telemetry events to retrieve (default 50, max 500)" },
      },
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
    return null;
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
        if (!args || !args.files || !Array.isArray(args.files)) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Invalid parameters: 'files' must be an array" },
          };
        }
        if (args.files.some(f => typeof f !== "string")) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Invalid parameters: 'files' must be an array of strings" },
          };
        }
        if (args.diffLines !== undefined && typeof args.diffLines !== "number") {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Invalid parameters: 'diffLines' must be a number" },
          };
        }
        const tierResult = classifyRiskTier(args.files, { diffLines: args.diffLines || 0 });
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

      if (toolName === "telemetry_tail") {
        if (args.limit !== undefined && (typeof args.limit !== "number" || args.limit < 1)) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Invalid parameters: 'limit' must be a positive number" },
          };
        }
        const limit = Math.min(args.limit || 50, 500);
        const events = readTelemetry(root, limit);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(events, null, 2) }],
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

const ORIGINAL_WRITE_SYMBOL = Symbol("ORIGINAL_WRITE_SYMBOL");
let isAuthorizedMcpWrite = false;

/**
 * Seals process.stdout.write (or targetOutput.write) to isolate stdout from generic writes (like console.log).
 * Generic writes are redirected to process.stderr (or throw an error if configured).
 *
 * @param {import("node:stream").Writable} [targetOutput=process.stdout]
 * @param {Object} [opts={}]
 * @returns {Function} Bound original write function
 */
export function isolateMcpStdout(targetOutput = process.stdout, opts = {}) {
  if (!targetOutput) return null;
  if (targetOutput[ORIGINAL_WRITE_SYMBOL]) {
    return targetOutput[ORIGINAL_WRITE_SYMBOL];
  }

  const originalWrite = targetOutput.write.bind(targetOutput);
  Object.defineProperty(targetOutput, ORIGINAL_WRITE_SYMBOL, {
    value: originalWrite,
    writable: false,
    configurable: false,
  });

  const patchedWrite = function (chunk, encoding, cb) {
    if (isAuthorizedMcpWrite) {
      return originalWrite(chunk, encoding, cb);
    }

    if (opts.onUnauthorizedWrite === "throw") {
      throw new Error("Unauthorized write to stdout during MCP session");
    }

    if (process.stderr && typeof process.stderr.write === "function") {
      return process.stderr.write(chunk, encoding, cb);
    }
  };

  try {
    Object.defineProperty(targetOutput, "write", {
      value: patchedWrite,
      writable: false,
      configurable: false,
    });
  } catch (_) {
    targetOutput.write = patchedWrite;
  }

  return originalWrite;
}

/**
 * Writes authorized framed data directly to the underlying isolated stream.
 *
 * @param {import("node:stream").Writable} targetOutput
 * @param {string|Buffer} data
 * @returns {boolean}
 */
export function writeMcpFrame(targetOutput, data) {
  isAuthorizedMcpWrite = true;
  try {
    const originalWrite = targetOutput[ORIGINAL_WRITE_SYMBOL] || targetOutput.write.bind(targetOutput);
    return originalWrite(data);
  } finally {
    isAuthorizedMcpWrite = false;
  }
}

export function startMcpServer(input = process.stdin, output = process.stdout, opts = {}) {
  const root = opts.root || resolveRoot();
  reapOrphanedIntents(root);
  reapStaleMutexDirs(root);
  isolateMcpStdout(process.stdout, opts);
  if (output && output !== process.stdout) {
    isolateMcpStdout(output, opts);
  }

  const progressBus = opts.progressBus || new ProgressBus(output, opts);
  const decoder = new McpFrameDecoder({ maxFrameSize: opts.maxFrameSize || MAX_MCP_FRAME_SIZE });

  decoder.on("data", async (request) => {
    try {
      const progressToken = request?.params?._meta?.progressToken || request?.params?.progressToken;
      const requestOpts = { ...opts, progressBus, progressToken };
      const response = await handleMcpRequest(request, requestOpts);
      if (response !== null && response !== undefined) {
        writeMcpFrame(output, JSON.stringify(response) + "\n");
      }
    } catch (err) {
      // Panic boundary: Catch unhandled async exceptions and send valid JSON-RPC error
      writeMcpFrame(
        output,
        JSON.stringify({
          jsonrpc: "2.0",
          id: request?.id || null,
          error: { code: -32603, message: `Internal server panic: ${err.message}` },
        }) + "\n"
      );
    }
  });

  decoder.on("error", (err) => {
    writeMcpFrame(
      output,
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: `MCP Stream framing error: ${err.message}` },
      }) + "\n"
    );
  });

  input.pipe(decoder);
}

