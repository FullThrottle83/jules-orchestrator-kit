import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";
import { redactSecrets } from "./security.mjs";

// Extensions node --check can parse as a script. .mjs/.cjs are unambiguous;
// plain .js is checked as a script too — a stray top-level ESM import would
// already have failed the Declarative/Mechanical-tier files this gate
// actually sees, and a false SyntaxError just forces an unnecessary (but
// harmless) escalation to the primary provider rather than a missed one.
const SYNTAX_CHECKABLE_EXTS = new Set([".js", ".mjs", ".cjs"]);

/**
 * Lists working-tree files (relative paths) touched since the last commit,
 * limited to JS extensions node --check can parse. Deleted files are
 * excluded — there is nothing left on disk to check. Zero-dependency: shells
 * out to `git status`, the same plumbing src/security.mjs and src/git.mjs
 * already rely on.
 */
function listChangedSourceFiles(root) {
  try {
    const res = spawnSync("git", ["status", "--porcelain=v1", "--no-renames"], {
      cwd: root,
      encoding: "utf-8",
    });
    if (res.status !== 0 || !res.stdout) return [];
    const files = [];
    for (const line of res.stdout.split("\n")) {
      if (!line.trim()) continue;
      const statusCode = line.slice(0, 2);
      if (statusCode.includes("D")) continue;
      const filePath = line.slice(3).trim().replace(/^"|"$/g, "");
      if (SYNTAX_CHECKABLE_EXTS.has(extname(filePath).toLowerCase())) files.push(filePath);
    }
    return files;
  } catch (_) {
    return [];
  }
}

/**
 * Runs the given files through V8's native `node --check` (parses the AST
 * without executing it) and returns the first syntax failure found, or null.
 */
function findSyntaxError(root, files) {
  for (const file of files) {
    const absPath = join(root, file);
    if (!existsSync(absPath)) continue;
    const res = spawnSync(process.execPath, ["--check", absPath], { encoding: "utf-8" });
    if (res.status !== 0) {
      const stderr = redactSecrets((res.stderr || "").slice(0, 300)).trim();
      return { file, error: stderr || `node --check exited ${res.status}` };
    }
  }
  return null;
}

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
// Gemini 3.7 Flash model (with fallback support) — a cheap, fast tier suited
// for trivial/mechanical tasks routed by src/router.mjs. Auth via GEMINI_API_KEY.
export const GEMINI_PRESET = {
  name: "gemini-flash",
  type: "exec",
  command: "gemini",
  args: ["--model", process.env.GEMINI_FLASH_MODEL || "gemini-3.7-flash", "--approval-mode=yolo", "--output-format", "json"],
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

/**
 * Multi-token manager with round-robin rotation, 429 quarantine/cooldown, and failover.
 */
export class TokenPool {
  constructor(tokens = []) {
    this.tokens = Array.from(new Set(tokens.filter(Boolean)));
    this.currentIndex = 0;
    this.cooldowns = new Map(); // token -> cooldownExpiryTimestamp
    this.usage24h = new Map(); // token -> count
  }

  static fromEnv(config = {}) {
    const rawList = (process.env.JULES_API_KEYS || process.env.JULES_API_KEY_SECONDARY || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const primary = (process.env.JULES_API_KEY || "").trim();
    const configKeys = Array.isArray(config.julesApiKeys) ? config.julesApiKeys : [];
    const combined = Array.from(new Set([primary, ...rawList, ...configKeys].filter(Boolean)));
    return new TokenPool(combined);
  }

  get size() {
    return this.tokens.length;
  }

  getNextToken() {
    if (this.tokens.length === 0) return "";
    const now = Date.now();

    // Find first non-cooldown token starting from currentIndex
    for (let i = 0; i < this.tokens.length; i++) {
      const idx = (this.currentIndex + i) % this.tokens.length;
      const token = this.tokens[idx];
      const cooldownUntil = this.cooldowns.get(token) || 0;
      if (now >= cooldownUntil) {
        this.currentIndex = (idx + 1) % this.tokens.length;
        return token;
      }
    }

    // If all are in cooldown, pick the one that expires earliest
    let earliestToken = this.tokens[0];
    let earliestExpiry = this.cooldowns.get(earliestToken) || Infinity;
    for (const token of this.tokens) {
      const expiry = this.cooldowns.get(token) || 0;
      if (expiry < earliestExpiry) {
        earliestExpiry = expiry;
        earliestToken = token;
      }
    }
    return earliestToken;
  }

  markRateLimited(token, retryAfterMs = 60000) {
    if (!token) return;
    const cooldownMs = Math.max(1000, Number(retryAfterMs) || 60000);
    this.cooldowns.set(token, Date.now() + cooldownMs);
  }

  recordUsage(token) {
    if (!token) return;
    const count = (this.usage24h.get(token) || 0) + 1;
    this.usage24h.set(token, count);
  }

  getInventory() {
    const now = Date.now();
    return this.tokens.map((token, index) => {
      const cooldownUntil = this.cooldowns.get(token) || 0;
      const inCooldown = now < cooldownUntil;
      const maskedToken = token.length <= 8 ? "****" : `${token.slice(0, 4)}...${token.slice(-4)}`;
      return {
        id: `key-${index + 1}`,
        index,
        isPrimary: index === 0,
        maskedToken,
        inCooldown,
        cooldownRemainingMs: inCooldown ? cooldownUntil - now : 0,
        usage: this.usage24h.get(token) || 0,
      };
    });
  }
}

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

      const pool = ctx.tokenPool || config.tokenPool || TokenPool.fromEnv(config);
      const hasAnyKey = pool.size > 0 || Boolean(process.env.JULES_API_KEY) || Boolean(ctx.allowLegacyKey && process.env.GEMINI_API_KEY);
      if (!hasAnyKey && !ctx.dryRun && providerSpec.name === "jules") {
        throw new MissingApiKeyError();
      }

      const isRepoless = Boolean(task.repoless || ctx.repoless);
      const rawRepo = task.source || ctx.source || config.source || process.env.JULES_REPO || "";
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
        const rawToken = pool.getNextToken() || process.env.JULES_API_KEY || (ctx.allowLegacyKey ? process.env.GEMINI_API_KEY : "") || "";
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
        const maxAttempts = Math.max(1, pool.size);
        let lastError = null;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const rawToken = pool.getNextToken() || process.env.JULES_API_KEY || (ctx.allowLegacyKey ? process.env.GEMINI_API_KEY : "") || "";
          if (!rawToken && !ctx.dryRun && providerSpec.name === "jules") {
            throw new MissingApiKeyError();
          }

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
            const text = await res.text().catch(() => "");
            const cleanText = text.slice(0, 500);
            let sanitizedText = redactSecrets(rawToken ? cleanText.split(rawToken).join("[REDACTED]") : cleanText);
            let retryAfterHeader = res.headers ? res.headers.get("retry-after") : null;
            let retryAfterMs = parseRetryAfter(retryAfterHeader);

            if (res.status === 400 && bodyObj && typeof bodyObj === "object") {
              const lowerText = sanitizedText.toLowerCase();
              if (
                lowerText.includes("deprecated") ||
                lowerText.includes("unrecognized") ||
                lowerText.includes("unknown field") ||
                lowerText.includes("temperature") ||
                lowerText.includes("thinking_budget") ||
                lowerText.includes("top_p")
              ) {
                // Optimistic Schema Degradation: Strip deprecated fields and transparently retry
                delete bodyObj.temperature;
                delete bodyObj.top_p;
                delete bodyObj.top_k;
                if (bodyObj.thinking_budget !== undefined) {
                  delete bodyObj.thinking_budget;
                  bodyObj.thinking_level = "high";
                }
                body = JSON.stringify(bodyObj);
                try {
                  res = await fetch(url, {
                    method: providerSpec.method || "POST",
                    headers,
                    body,
                    signal: AbortSignal.timeout(timeoutMs),
                  });
                  if (!res.ok) {
                    // The retry failed too — re-derive the error context from
                    // its response instead of reporting the pre-retry 400,
                    // which by definition no longer describes the failure.
                    const retryText = await res.text().catch(() => "");
                    const cleanRetryText = retryText.slice(0, 500);
                    sanitizedText = redactSecrets(rawToken ? cleanRetryText.split(rawToken).join("[REDACTED]") : cleanRetryText);
                    retryAfterHeader = res.headers ? res.headers.get("retry-after") : null;
                    retryAfterMs = parseRetryAfter(retryAfterHeader);
                  }
                } catch (_) {}
              }
            }

            if (!res.ok) {
              if (res.status === 429) {
                pool.markRateLimited(rawToken, retryAfterMs ?? 60000);
                lastError = new ProviderRateLimitError(`Provider HTTP Error (429): ${sanitizedText}`, {
                  retryAfterMs: retryAfterMs ?? 60000,
                  status: 429,
                });
                if (pool.size > 1 && attempt < maxAttempts - 1) {
                  continue;
                }
                throw lastError;
              }

              if (res.status >= 500 && res.status < 600) {
                throw new ProviderUnavailableError(`Provider HTTP Error (${res.status}): ${sanitizedText}`, {
                  status: res.status,
                  retryAfterMs: retryAfterMs ?? undefined,
                });
              }

              throw new Error(`Provider HTTP Error (${res.status}): ${sanitizedText}`);
            }
          }

          pool.recordUsage(rawToken);

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

    async getSession(sessionId, ctx = {}) {
      if (!sessionId || typeof sessionId !== "string") {
        throw new TypeError("getSession() requires a valid sessionId string");
      }
      if (!ctx || typeof ctx !== "object") ctx = {};

      const pool = ctx.tokenPool || config.tokenPool || TokenPool.fromEnv(config);
      const rawToken = pool.getNextToken() || process.env.JULES_API_KEY || (ctx.allowLegacyKey ? process.env.GEMINI_API_KEY : "") || "";
      if (!rawToken && !ctx.dryRun && providerSpec.name === "jules") {
        throw new MissingApiKeyError();
      }

      if (ctx.dryRun) {
        return {
          id: sessionId,
          status: "active",
          provider: providerSpec.name,
        };
      }

      if (providerSpec.type === "http") {
        const getSessionUrlTemplate = providerSpec.getSessionUrl || `${providerSpec.url}/${sessionId}`;
        const urlData = { sessionId, ...ctx };
        const url = interpolateString(getSessionUrlTemplate, urlData);

        const headerData = { ...urlData, token: rawToken };
        const headers = {};
        for (const [k, v] of Object.entries(providerSpec.headers || {})) {
          const val = interpolateString(v, headerData);
          if (val.includes("\r") || val.includes("\n")) {
            throw new Error(`CRITICAL: Header injection attempt detected in header "${k}"`);
          }
          headers[k] = val;
        }

        const requestedTimeout = Number(ctx.timeoutMs ?? config.timeoutMs ?? providerSpec.timeoutMs ?? 30_000);
        const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : 30_000;
        const maxRetries = Number.isInteger(ctx.maxRetries) ? ctx.maxRetries : 3;
        const initialDelayMs = Number.isInteger(ctx.initialDelayMs) ? ctx.initialDelayMs : 500;

        let lastErr = null;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          if (attempt > 0) {
            const delay = initialDelayMs * Math.pow(2, attempt - 1);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }

          let res;
          try {
            res = await fetch(url, {
              method: "GET",
              headers,
              signal: AbortSignal.timeout(timeoutMs),
            });
          } catch (err) {
            if (err.name === "TimeoutError" || err.name === "AbortError" || err.code === "ABORT_ERR") {
              lastErr = new ProviderUnavailableError(`Provider HTTP Timeout (${timeoutMs}ms): ${err.message}`, { status: 504 });
              if (attempt < maxRetries) continue;
              throw lastErr;
            }
            throw err;
          }

          if (!res.ok) {
            const text = await res.text();
            const cleanText = text.slice(0, 500);
            const sanitizedText = redactSecrets(rawToken ? cleanText.split(rawToken).join("[REDACTED]") : cleanText);

            if (res.status === 404) {
              lastErr = new Error(`Provider HTTP Error (404 Not Found): ${sanitizedText}`);
              lastErr.status = 404;
              if (attempt < maxRetries) continue;
              throw lastErr;
            }

            if (res.status === 429) {
              const retryAfterHeader = res.headers ? res.headers.get("retry-after") : null;
              const retryAfterMs = parseRetryAfter(retryAfterHeader);
              pool.markRateLimited(rawToken, retryAfterMs ?? 60000);
              lastErr = new ProviderRateLimitError(`Provider HTTP Error (429): ${sanitizedText}`, {
                retryAfterMs: retryAfterMs ?? 60000,
                status: 429,
              });
              if (attempt < maxRetries) continue;
              throw lastErr;
            }

            if (res.status >= 500 && res.status < 600) {
              lastErr = new ProviderUnavailableError(`Provider HTTP Error (${res.status}): ${sanitizedText}`, {
                status: res.status,
              });
              if (attempt < maxRetries) continue;
              throw lastErr;
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
            status: json.state || json.status || "active",
            raw: json,
          };
        }
      }

      if (providerSpec.type === "exec") {
        return { id: sessionId, status: "completed" };
      }

      throw new Error(`Unsupported provider type: ${providerSpec.type}`);
    },

    async approvePlan(sessionId, ctx = {}) {
      if (!sessionId || typeof sessionId !== "string") {
        throw new TypeError("approvePlan() requires a valid sessionId string");
      }
      if (!ctx || typeof ctx !== "object") ctx = {};

      const pool = ctx.tokenPool || config.tokenPool || TokenPool.fromEnv(config);
      const rawToken = pool.getNextToken() || process.env.JULES_API_KEY || (ctx.allowLegacyKey ? process.env.GEMINI_API_KEY : "") || "";
      if (!rawToken && !ctx.dryRun && providerSpec.name === "jules") {
        throw new MissingApiKeyError();
      }

      if (ctx.dryRun) {
        return {
          id: sessionId,
          status: "approved",
          approved: true,
          provider: providerSpec.name,
        };
      }

      if (providerSpec.type === "http") {
        const approvePlanUrlTemplate = providerSpec.approvePlanUrl || `${providerSpec.url}/${sessionId}:approvePlan`;
        const urlData = { sessionId, ...ctx };
        const url = interpolateString(approvePlanUrlTemplate, urlData);

        const headerData = { ...urlData, token: rawToken };
        const headers = {};
        for (const [k, v] of Object.entries(providerSpec.headers || {})) {
          const val = interpolateString(v, headerData);
          if (val.includes("\r") || val.includes("\n")) {
            throw new Error(`CRITICAL: Header injection attempt detected in header "${k}"`);
          }
          headers[k] = val;
        }

        const requestedTimeout = Number(ctx.timeoutMs ?? config.timeoutMs ?? providerSpec.timeoutMs ?? 30_000);
        const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : 30_000;
        const maxRetries = Number.isInteger(ctx.maxRetries) ? ctx.maxRetries : 3;
        const initialDelayMs = Number.isInteger(ctx.initialDelayMs) ? ctx.initialDelayMs : 500;

        let lastErr = null;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          if (attempt > 0) {
            const delay = initialDelayMs * Math.pow(2, attempt - 1);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }

          let res;
          try {
            res = await fetch(url, {
              method: "POST",
              headers,
              body: JSON.stringify(ctx.body || {}),
              signal: AbortSignal.timeout(timeoutMs),
            });
          } catch (err) {
            if (err.name === "TimeoutError" || err.name === "AbortError" || err.code === "ABORT_ERR") {
              lastErr = new ProviderUnavailableError(`Provider HTTP Timeout (${timeoutMs}ms): ${err.message}`, { status: 504 });
              if (attempt < maxRetries) continue;
              throw lastErr;
            }
            throw err;
          }

          if (!res.ok) {
            const text = await res.text();
            const cleanText = text.slice(0, 500);
            const sanitizedText = redactSecrets(rawToken ? cleanText.split(rawToken).join("[REDACTED]") : cleanText);

            if (res.status === 404) {
              lastErr = new Error(`Provider HTTP Error (404 Not Found): ${sanitizedText}`);
              lastErr.status = 404;
              if (attempt < maxRetries) continue;
              throw lastErr;
            }

            if (res.status === 429) {
              const retryAfterHeader = res.headers ? res.headers.get("retry-after") : null;
              const retryAfterMs = parseRetryAfter(retryAfterHeader);
              pool.markRateLimited(rawToken, retryAfterMs ?? 60000);
              lastErr = new ProviderRateLimitError(`Provider HTTP Error (429): ${sanitizedText}`, {
                retryAfterMs: retryAfterMs ?? 60000,
                status: 429,
              });
              if (attempt < maxRetries) continue;
              throw lastErr;
            }

            if (res.status >= 500 && res.status < 600) {
              lastErr = new ProviderUnavailableError(`Provider HTTP Error (${res.status}): ${sanitizedText}`, {
                status: res.status,
              });
              if (attempt < maxRetries) continue;
              throw lastErr;
            }

            const err = new Error(`Provider HTTP Error (${res.status}): ${sanitizedText}`);
            err.status = res.status;
            throw err;
          }

          let json;
          try {
            json = await res.json();
          } catch (_) {
            json = {};
          }

          return {
            id: json.id || json.name || sessionId,
            status: json.state || "approved",
            approved: true,
            raw: json,
          };
        }
      }

      if (providerSpec.type === "exec") {
        return { id: sessionId, status: "approved", approved: true };
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

    async getSession(sessionId, ctx = {}) {
      const errors = [];
      for (let i = 0; i < providerList.length; i++) {
        const provider = providerList[i];
        if (typeof provider.getSession !== "function") continue;
        try {
          const res = await provider.getSession(sessionId, ctx);
          return { ...res, _routedProvider: provider.name, _failoverAttempts: i };
        } catch (err) {
          errors.push({ provider: provider.name, error: err });
          const isRecoverable =
            err instanceof ProviderRateLimitError ||
            err instanceof ProviderUnavailableError ||
            (err.status && err.status >= 500 && err.status < 600) ||
            err.status === 429 ||
            err.status === 404;

          if (i === providerList.length - 1 || !isRecoverable) {
            if (err && typeof err === "object") {
              err._failoverErrors = errors;
            }
            throw err;
          }
        }
      }
    },

    async approvePlan(sessionId, ctx = {}) {
      const errors = [];
      for (let i = 0; i < providerList.length; i++) {
        const provider = providerList[i];
        if (typeof provider.approvePlan !== "function") continue;
        try {
          const res = await provider.approvePlan(sessionId, ctx);
          return { ...res, _routedProvider: provider.name, _failoverAttempts: i };
        } catch (err) {
          errors.push({ provider: provider.name, error: err });
          const isRecoverable =
            err instanceof ProviderRateLimitError ||
            err instanceof ProviderUnavailableError ||
            (err.status && err.status >= 500 && err.status < 600) ||
            err.status === 429 ||
            err.status === 404;

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

/**
 * Wraps a FAST-tier provider so its output is verified before being trusted.
 * Aggressive cost-router heuristics only stay safe if the cheap model cannot
 * silently commit broken syntax: a session that returns 200 OK from
 * `gemini-flash` after truncating a file mid-brace is otherwise
 * indistinguishable from a genuine success until CI runs.
 *
 * After the fast provider's dispatch resolves, this checks the working tree
 * for `.js`/`.mjs`/`.cjs` files changed since the last commit and parses each
 * through V8's native `node --check` (syntax only, never executed). A
 * SyntaxError silently re-dispatches the same task through `complexProvider`
 * instead of surfacing the broken result — the same "the cheap tier failed,
 * fall through" contract `createFailoverProvider` already uses for
 * rate-limits, just triggered by a verified bad output rather than a thrown
 * error. Sessions with no local working-tree diff (e.g. a remote HTTP
 * provider used as the fast tier) are a no-op: there is nothing on disk to
 * check, so the original result passes through unchanged.
 * @param {object} fastProvider - Provider object (from createProvider) whose output gets verified.
 * @param {object} complexProvider - Provider object to escalate to on a verified syntax failure.
 * @param {object} config - Loaded orchestrator config (used to resolve the repo root).
 * @returns {object} Provider object with the same interface as fastProvider.
 */
export function createSyntaxVerifiedProvider(fastProvider, complexProvider, config = {}) {
  return {
    name: fastProvider.name,

    async dispatch(task = {}, ctx = {}) {
      const result = await fastProvider.dispatch(task, ctx);
      if (ctx.dryRun) return result;

      const root = ctx.root || config._root || process.cwd();
      const changedFiles = listChangedSourceFiles(root);
      if (changedFiles.length === 0) return result;

      const bad = findSyntaxError(root, changedFiles);
      if (!bad) return result;

      console.warn(
        `[ROUTER ESCALATION] FAST tier ('${fastProvider.name}') emitted invalid syntax in ${bad.file} (${bad.error}). Escalating to '${complexProvider.name}'.`
      );
      const escalated = await complexProvider.dispatch(task, ctx);
      return {
        ...escalated,
        _syntaxEscalated: true,
        _syntaxEscalationFile: bad.file,
        _syntaxEscalationReason: bad.error,
      };
    },

    validate() {
      return typeof fastProvider.validate !== "function" || fastProvider.validate();
    },

    resume(...args) {
      return fastProvider.resume(...args);
    },

    getSession(...args) {
      return fastProvider.getSession(...args);
    },

    approvePlan(...args) {
      return fastProvider.approvePlan(...args);
    },
  };
}
