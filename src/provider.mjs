import { spawnSync } from "node:child_process";
import { redactSecrets } from "./security.mjs";

export const JULES_PRESET = {
  name: "jules",
  type: "http",
  url: "https://jules.googleapis.com/v1alpha/sessions",
  headers: {
    "X-Goog-Api-Key": "{token}",
    "Content-Type": "application/json",
  },
  bodyTemplate: {
    title: "{title}",
    prompt: "{prompt}",
    sourceContext: {
      source: "{source}",
      githubRepoContext: {
        startingBranch: "{branch}",
      },
    },
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

// Google Gemini CLI (`npm i -g @google/gemini-cli`), headless mode. Reads the
// prompt from stdin (non-TTY input triggers headless mode without needing a
// dangling `-p` flag), auto-approves file/shell actions, and defaults to the
// Gemini 3.6 Flash model — a cheap, fast tier suited for trivial/mechanical
// tasks routed by src/router.mjs. Auth via GEMINI_API_KEY (env, not CLI arg).
export const GEMINI_PRESET = {
  name: "gemini-flash",
  type: "exec",
  command: "gemini",
  args: ["--model", "gemini-3.6-flash", "--approval-mode=yolo", "--output-format", "json"],
  promptViaStdin: true,
};

export class MissingApiKeyError extends Error {
  constructor(message = "JULES_API_KEY environment variable is required for Google Jules API dispatch.") {
    super(message);
    this.name = "MissingApiKeyError";
    this.status = 401;
  }
}

export class ProviderRateLimitError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = "ProviderRateLimitError";
    this.retryAfterMs = opts.retryAfterMs ?? 60000;
    this.status = opts.status || 429;
  }
}

export class ProviderUnavailableError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = "ProviderUnavailableError";
    this.status = opts.status || 503;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export class ProviderSchemaError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = "ProviderSchemaError";
    this.status = opts.status;
  }
}

export function parseRetryAfter(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1000));
  }
  const dateMs = Date.parse(header);
  if (!isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return null;
}

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
const NAMED_PRESETS = {
  jules: JULES_PRESET,
  "claude-code": CLAUDE_PRESET,
  codex: CODEX_PRESET,
  "gemini-flash": GEMINI_PRESET,
  "gemini-cli": GEMINI_PRESET,
};

export function createProvider(spec = "jules", config = {}) {
  if (spec && typeof spec === "object" && typeof spec.dispatch === "function") {
    return spec;
  }
  const providerSpec = typeof spec === "string" ? (NAMED_PRESETS[spec] || JULES_PRESET) : spec || JULES_PRESET;

  if (!providerSpec || typeof providerSpec !== "object") {
    throw new TypeError("Provider specification must be a string or object");
  }

  if (providerSpec.type === "http") {
    if (typeof providerSpec.url === "string" && providerSpec.url.includes("{token}")) {
      throw new Error("CRITICAL: Insecure token interpolation in provider URL template. API tokens must be passed via headers, not URL paths or query params.");
    }
    if (typeof providerSpec.sendMessageUrl === "string" && providerSpec.sendMessageUrl.includes("{token}")) {
      throw new Error("CRITICAL: Insecure token interpolation in provider sendMessageUrl template. API tokens must be passed via headers, not URL paths or query params.");
    }
  }

  return {
    name: providerSpec.name || "custom-provider",

    async dispatch(task = {}, ctx = {}) {
      if (!task || typeof task !== "object") {
        throw new TypeError("Provider task must be an object");
      }
      if (!ctx || typeof ctx !== "object") ctx = {};
      const rawToken = process.env.JULES_API_KEY || (ctx.allowLegacyKey ? process.env.GEMINI_API_KEY : "") || "";
      if (!rawToken && !ctx.dryRun && providerSpec.name === "jules") {
        throw new MissingApiKeyError();
      }

      const isRepoless = Boolean(task.repoless || ctx.repoless);
      const rawRepo = task.source || ctx.source || process.env.JULES_REPO || "";
      if (!rawRepo && !ctx.dryRun && providerSpec.name === "jules" && !isRepoless) {
        throw new Error("Missing connected Jules repository source. Set JULES_REPO or pass source/repoless option.");
      }

      const sourceName = rawRepo
        ? (rawRepo.startsWith("sources/") ? rawRepo : `sources/github/${rawRepo}`)
        : undefined;

      const startingBranch = task.branch || ctx.branch || config.baseBranch || process.env.BASE_BRANCH || "main";

      const data = {
        prompt: task.prompt || "",
        title: task.title || "Agent Task",
        branch: startingBranch,
        source: sourceName || "",
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
        const urlData = { ...data };
        const url = interpolateString(providerSpec.url, urlData);
        const headerData = { ...urlData, token: rawToken };
        const headers = {};
        for (const [k, v] of Object.entries(providerSpec.headers || {})) {
          const val = interpolateString(v, headerData);
          if (val.includes("\r") || val.includes("\n")) {
            throw new Error(`CRITICAL: Header injection attempt detected in header "${k}"`);
          }
          headers[k] = val;
        }

        let body;
        let bodyObj;
        if (typeof providerSpec.bodyTemplate === "string") {
          try {
            const parsedObj = JSON.parse(providerSpec.bodyTemplate);
            bodyObj = interpolateDeep(parsedObj, data);
          } catch (_) {
            body = interpolateString(providerSpec.bodyTemplate, data);
          }
        } else if (providerSpec.bodyTemplate) {
          bodyObj = interpolateDeep(providerSpec.bodyTemplate, data);
        } else {
          bodyObj = { ...data };
        }

        if (bodyObj && typeof bodyObj === "object") {
          if (isRepoless || !sourceName) {
            delete bodyObj.sourceContext;
          }
          if (task.autoPr || ctx.autoPr) {
            bodyObj.automationMode = "AUTO_CREATE_PR";
          }
          if (task.requirePlanApproval || ctx.requirePlanApproval) {
            bodyObj.requirePlanApproval = true;
          }
          body = JSON.stringify(bodyObj);
        }

        const requestedTimeout = Number(ctx.timeoutMs ?? config.timeoutMs ?? providerSpec.timeoutMs ?? 120_000);
        const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : 120_000;
        let res;
        try {
          res = await fetch(url, {
            method: providerSpec.method || "POST",
            headers,
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (err) {
          if (err.name === "TimeoutError" || err.name === "AbortError" || err.code === "ABORT_ERR") {
            throw new ProviderUnavailableError(`Provider HTTP Timeout (${timeoutMs}ms): ${err.message}`, {
              status: 504,
            });
          }
          throw err;
        }

        if (!res.ok) {
          const text = await res.text();
          const cleanText = text.slice(0, 500);
          const sanitizedText = redactSecrets(rawToken ? cleanText.split(rawToken).join("[REDACTED]") : cleanText);
          const retryAfterHeader = res.headers ? res.headers.get("retry-after") : null;
          const retryAfterMs = parseRetryAfter(retryAfterHeader);

          if (res.status === 429) {
            throw new ProviderRateLimitError(`Provider HTTP Error (429): ${sanitizedText}`, {
              retryAfterMs: retryAfterMs ?? 60000,
              status: 429,
            });
          }

          if (res.status >= 500 && res.status < 600) {
            throw new ProviderUnavailableError(`Provider HTTP Error (${res.status}): ${sanitizedText}`, {
              status: res.status,
              retryAfterMs: retryAfterMs ?? undefined,
            });
          }

          throw new Error(`Provider HTTP Error (${res.status}): ${sanitizedText}`);
        }

        let json;
        try {
          json = await res.json();
        } catch (err) {
          throw new ProviderSchemaError(`Provider Payload Error: Invalid JSON response: ${err.message}`, {
            status: res.status,
          });
        }

        if (!json || typeof json !== "object") {
          throw new ProviderSchemaError("Provider Payload Error: Expected JSON object response", {
            status: res.status,
          });
        }

        return {
          id: json.id || json.name || "http-session",
          status: json.state || "active",
          raw: json,
        };
      }

      if (providerSpec.type === "exec") {
        const rawArgs = providerSpec.args || (providerSpec.command ? providerSpec.command.split(" ").slice(1) : []);
        const command = providerSpec.command ? providerSpec.command.split(" ")[0] : "claude";

        const filteredArgs = providerSpec.promptViaStdin
          ? rawArgs.filter((arg) => !arg.includes("{prompt}"))
          : rawArgs;

        const processedArgs = filteredArgs.map((arg) => interpolateString(arg, data));

        const res = spawnSync(command, processedArgs, {
          cwd: config._root || process.cwd(),
          encoding: "utf-8",
          shell: false,
          input: providerSpec.promptViaStdin ? data.prompt : undefined,
          timeout: providerSpec.timeoutMs || 900000,
          maxBuffer: 32 * 1024 * 1024,
        });

        if (res.error) {
          throw new Error(`Provider Exec Failed: ${res.error.message}`);
        }
        if (res.status !== 0) {
          const stderr = redactSecrets((res.stderr || "").slice(0, 500));
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

    async resume(sessionId, prompt = "", ctx = {}, task = null) {
      if (!sessionId || typeof sessionId !== "string") {
        throw new TypeError("resume() requires a valid sessionId string");
      }
      if (!ctx || typeof ctx !== "object") ctx = {};

      const rawToken = process.env.JULES_API_KEY || (ctx.allowLegacyKey ? process.env.GEMINI_API_KEY : "") || "";
      if (!rawToken && !ctx.dryRun && providerSpec.name === "jules") {
        throw new MissingApiKeyError();
      }

      if (ctx.dryRun) {
        return {
          id: sessionId,
          status: "pending",
          resumed: true,
          provider: providerSpec.name,
          prompt: redactSecrets(prompt),
        };
      }

      if (providerSpec.type === "http") {
        const sendMessageUrlTemplate = providerSpec.sendMessageUrl || `${providerSpec.url}/${sessionId}:sendMessage`;
        const urlData = { sessionId, ...ctx };
        const url = interpolateString(sendMessageUrlTemplate, urlData);

        const headerData = { ...urlData, token: rawToken };
        const headers = {};
        for (const [k, v] of Object.entries(providerSpec.headers || {})) {
          const val = interpolateString(v, headerData);
          if (val.includes("\r") || val.includes("\n")) {
            throw new Error(`CRITICAL: Header injection attempt detected in header "${k}"`);
          }
          headers[k] = val;
        }

        const bodyObj = { prompt: prompt };
        const body = JSON.stringify(bodyObj);

        const requestedTimeout = Number(ctx.timeoutMs ?? config.timeoutMs ?? providerSpec.timeoutMs ?? 120_000);
        const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : 120_000;
        let res;
        try {
          res = await fetch(url, {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (err) {
          if (err.name === "TimeoutError" || err.name === "AbortError" || err.code === "ABORT_ERR") {
            throw new ProviderUnavailableError(`Provider HTTP Timeout (${timeoutMs}ms): ${err.message}`, {
              status: 504,
            });
          }
          throw err;
        }

        if (!res.ok) {
          const text = await res.text();
          const cleanText = text.slice(0, 500);
          const sanitizedText = redactSecrets(rawToken ? cleanText.split(rawToken).join("[REDACTED]") : cleanText);

          // Fail-soft fallback: if remote session is closed/expired (400 or 404) and task object is available, fall back to cold dispatch
          if ((res.status === 400 || res.status === 404) && task && typeof task === "object") {
            const fallbackRes = await this.dispatch(task, { ...ctx, warmResumptionFailed: true });
            return {
              ...fallbackRes,
              _warmFallback: true,
              _warmErrorStatus: res.status,
            };
          }

          const retryAfterHeader = res.headers ? res.headers.get("retry-after") : null;
          const retryAfterMs = parseRetryAfter(retryAfterHeader);

          if (res.status === 429) {
            throw new ProviderRateLimitError(`Provider HTTP Error (429): ${sanitizedText}`, {
              retryAfterMs: retryAfterMs ?? 60000,
              status: 429,
            });
          }

          if (res.status >= 500 && res.status < 600) {
            throw new ProviderUnavailableError(`Provider HTTP Error (${res.status}): ${sanitizedText}`, {
              status: res.status,
              retryAfterMs: retryAfterMs ?? undefined,
            });
          }

          const err = new Error(`Provider HTTP Error (${res.status}): ${sanitizedText}`);
          err.status = res.status;
          throw err;
        }

        let json;
        try {
          json = await res.json();
        } catch (err) {
          throw new ProviderSchemaError(`Provider Payload Error: Invalid JSON response: ${err.message}`, {
            status: res.status,
          });
        }

        return {
          id: json.id || json.name || sessionId,
          status: json.state || "active",
          resumed: true,
          raw: json,
        };
      }

      if (providerSpec.type === "exec") {
        return this.dispatch({ ...(task || {}), prompt }, ctx);
      }

      throw new Error(`Unsupported provider type: ${providerSpec.type}`);
    },
  };
}

/**
 * Creates a failover provider router that attempts dispatches sequentially across an ordered array of providers.
 * Intercepts rate limits (429) and 5xx unavailability, logging telemetry events before falling over.
 */
export function createFailoverProvider(providers = ["jules"], config = {}) {
  const providerList = (Array.isArray(providers) && providers.length > 0 ? providers : ["jules"]).map((spec) =>
    spec && typeof spec === "object" && typeof spec.dispatch === "function" ? spec : createProvider(spec, config)
  );

  return {
    name: `failover:${providerList.map((p) => p.name).join("->")}`,

    async dispatch(task, ctx = {}) {
      const errors = [];
      for (let i = 0; i < providerList.length; i++) {
        const provider = providerList[i];
        try {
          const res = await provider.dispatch(task, ctx);
          return { ...res, _routedProvider: provider.name, _failoverAttempts: i };
        } catch (err) {
          errors.push({ provider: provider.name, error: err });
          const isRecoverable =
            err instanceof ProviderRateLimitError ||
            err instanceof ProviderUnavailableError ||
            (err.status && err.status >= 500 && err.status < 600) ||
            err.status === 429;

          if (i === providerList.length - 1 || !isRecoverable) {
            if (err && typeof err === "object") {
              err._failoverErrors = errors;
            }
            throw err;
          }
        }
      }
    },

    async resume(sessionId, prompt, ctx = {}, task = null) {
      const errors = [];
      for (let i = 0; i < providerList.length; i++) {
        const provider = providerList[i];
        if (typeof provider.resume !== "function") continue;
        try {
          const res = await provider.resume(sessionId, prompt, ctx, task);
          return { ...res, _routedProvider: provider.name, _failoverAttempts: i };
        } catch (err) {
          errors.push({ provider: provider.name, error: err });
          const isRecoverable =
            err instanceof ProviderRateLimitError ||
            err instanceof ProviderUnavailableError ||
            (err.status && err.status >= 500 && err.status < 600) ||
            err.status === 429;

          if (i === providerList.length - 1 || !isRecoverable) {
            if (err && typeof err === "object") {
              err._failoverErrors = errors;
            }
            throw err;
          }
        }
      }
    },

    validate() {
      return providerList.every((p) => typeof p.validate !== "function" || p.validate());
    },
  };
}
