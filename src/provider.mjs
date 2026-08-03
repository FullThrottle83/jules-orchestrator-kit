import { spawnSync } from "node:child_process";

export const JULES_PRESET = {
  name: "jules",
  type: "http",
  url: "https://jules.googleapis.com/v1/projects/{project}/sessions",
  headers: {
    "Authorization": "Bearer {token}",
    "Content-Type": "application/json",
  },
  bodyTemplate: {
    prompt: "{prompt}",
    title: "{title}",
    branch: "{branch}",
  },
};

export const CLAUDE_PRESET = {
  name: "claude-code",
  type: "exec",
  command: "claude",
  args: ["--print", "-p", "{prompt}"],
  promptViaStdin: true,
};

export const CODEX_PRESET = {
  name: "codex",
  type: "exec",
  command: "codex",
  args: ["exec", "{prompt}"],
  promptViaStdin: false,
};

function interpolateString(template, data) {
  if (typeof template !== "string") return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => data[key] ?? "");
}

function interpolateDeep(node, data) {
  if (typeof node === "string") return interpolateString(node, data);
  if (Array.isArray(node)) return node.map((item) => interpolateDeep(item, data));
  if (node && typeof node === "object") {
    const res = {};
    for (const [k, v] of Object.entries(node)) {
      res[k] = interpolateDeep(v, data);
    }
    return res;
  }
  return node;
}

/**
 * Creates an HTTP or Exec provider adapter based on spec/config.
 */
export function createProvider(spec = "jules", config = {}) {
  const providerSpec = typeof spec === "string"
    ? (spec === "claude-code" ? CLAUDE_PRESET : spec === "codex" ? CODEX_PRESET : JULES_PRESET)
    : spec;

  return {
    name: providerSpec.name || "custom-provider",

    async dispatch(task, ctx = {}) {
      const rawToken = process.env.JULES_API_KEY || process.env.GEMINI_API_KEY || "";
      const data = {
        prompt: task.prompt || "",
        title: task.title || "Agent Task",
        branch: task.branch || (config.branchPrefix ? config.branchPrefix + "task" : "agent/task"),
        project: process.env.JULES_PROJECT_ID || "default",
        ...ctx,
      };

      if (ctx.dryRun) {
        return {
          id: "dry-run-session-id",
          status: "pending",
          title: data.title,
          provider: providerSpec.name,
          data: {
            ...data,
            token: rawToken ? "[REDACTED]" : undefined,
          },
        };
      }

      if (providerSpec.type === "http") {
        const urlData = { ...data, token: rawToken };
        const url = interpolateString(providerSpec.url, urlData);
        const headers = {};
        for (const [k, v] of Object.entries(providerSpec.headers || {})) {
          const val = interpolateString(v, urlData);
          if (val.includes("\r") || val.includes("\n")) {
            throw new Error(`CRITICAL: Header injection attempt detected in header "${k}"`);
          }
          headers[k] = val;
        }

        let body;
        if (typeof providerSpec.bodyTemplate === "string") {
          try {
            const parsedObj = JSON.parse(providerSpec.bodyTemplate);
            const interpolatedObj = interpolateDeep(parsedObj, data);
            body = JSON.stringify(interpolatedObj);
          } catch (_) {
            body = interpolateString(providerSpec.bodyTemplate, data);
          }
        } else if (providerSpec.bodyTemplate) {
          const interpolatedObj = interpolateDeep(providerSpec.bodyTemplate, data);
          body = JSON.stringify(interpolatedObj);
        } else {
          body = JSON.stringify(data);
        }

        const res = await fetch(url, {
          method: providerSpec.method || "POST",
          headers,
          body,
        });

        if (!res.ok) {
          const text = await res.text();
          const cleanText = text.slice(0, 500);
          const sanitizedText = rawToken ? cleanText.split(rawToken).join("[REDACTED]") : cleanText;
          throw new Error(`Provider HTTP Error (${res.status}): ${sanitizedText}`);
        }

        const json = await res.json();
        return {
          id: json.id || json.name || "http-session",
          status: json.state || "active",
          raw: json,
        };
      }

      if (providerSpec.type === "exec") {
        const rawArgs = providerSpec.args || (providerSpec.command ? providerSpec.command.split(" ").slice(1) : []);
        const command = providerSpec.command ? providerSpec.command.split(" ")[0] : "claude";

        // CRITICAL H-a FIX: Filter out '{prompt}' argument if prompt is passed via stdin
        const filteredArgs = providerSpec.promptViaStdin
          ? rawArgs.filter((arg) => !arg.includes("{prompt}"))
          : rawArgs;

        const processedArgs = filteredArgs.map((arg) => interpolateString(arg, data));

        const res = spawnSync(command, processedArgs, {
          cwd: config._root || process.cwd(),
          encoding: "utf-8",
          shell: false, // CRITICAL: Ban shell execution to eliminate CWE-77
          input: providerSpec.promptViaStdin ? data.prompt : undefined,
          timeout: providerSpec.timeoutMs || 900000,
          maxBuffer: 32 * 1024 * 1024,
        });

        if (res.error) {
          throw new Error(`Provider Exec Failed: ${res.error.message}`);
        }
        if (res.status !== 0) {
          const stderr = (res.stderr || "").slice(0, 500);
          throw new Error(`Provider Exec Exit ${res.status}: ${stderr}`);
        }

        return {
          id: "exec-session-" + Date.now(),
          status: "completed",
          output: res.stdout || "",
        };
      }

      throw new Error(`Unsupported provider type: ${providerSpec.type}`);
    },

    validate() {
      if (providerSpec.type === "http" && !providerSpec.url) return false;
      if (providerSpec.type === "exec" && !providerSpec.command) return false;
      return true;
    },
  };
}
