import { execSync } from "node:child_process";

export const JULES_PRESET = {
  name: "jules",
  type: "http",
  url: "https://jules.googleapis.com/v1/projects/{project}/sessions",
  headers: {
    "Authorization": "Bearer {token}",
    "Content-Type": "application/json",
  },
  bodyTemplate: JSON.stringify({
    prompt: "{prompt}",
    title: "{title}",
    branch: "{branch}",
  }),
};

export const CLAUDE_PRESET = {
  name: "claude-code",
  type: "exec",
  command: "claude --print -p \"{prompt}\"",
};

export const CODEX_PRESET = {
  name: "codex",
  type: "exec",
  command: "codex exec \"{prompt}\"",
};

function interpolate(template, data) {
  if (typeof template !== "string") return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => data[key] ?? "");
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
      const data = {
        prompt: task.prompt || "",
        title: task.title || "Agent Task",
        branch: task.branch || config.branchPrefix + "task",
        token: process.env.JULES_API_KEY || process.env.GEMINI_API_KEY || "",
        project: process.env.JULES_PROJECT_ID || "default",
        ...ctx,
      };

      if (ctx.dryRun) {
        return {
          id: "dry-run-session-id",
          status: "pending",
          title: data.title,
          provider: providerSpec.name,
          data,
        };
      }

      if (providerSpec.type === "http") {
        const url = interpolate(providerSpec.url, data);
        const headers = {};
        for (const [k, v] of Object.entries(providerSpec.headers || {})) {
          headers[k] = interpolate(v, data);
        }
        const body = interpolate(providerSpec.bodyTemplate, data);

        const res = await fetch(url, {
          method: providerSpec.method || "POST",
          headers,
          body: typeof body === "string" ? body : JSON.stringify(body),
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Provider HTTP Error (${res.status}): ${text}`);
        }

        const json = await res.json();
        return {
          id: json.id || json.name || "http-session",
          status: json.state || "active",
          raw: json,
        };
      }

      if (providerSpec.type === "exec") {
        const cmd = interpolate(providerSpec.command, data);
        try {
          const out = execSync(cmd, { cwd: config._root || process.cwd(), encoding: "utf-8" });
          return {
            id: "exec-session-" + Date.now(),
            status: "completed",
            output: out,
          };
        } catch (err) {
          throw new Error(`Provider Exec Failed: ${err.message}`);
        }
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
