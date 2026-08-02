import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, ensureSdkCacheIsolation, log } from "./utils.mjs";

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

export async function fetchSessionPatch(sessionId, options = {}) {
  if (!sessionId || typeof sessionId !== "string") {
    throw new Error("Session ID is required.");
  }

  const apiKey = options.apiKey || process.env.JULES_API_KEY || process.env.GEMINI_API_KEY || "";
  const apiUrlBase = options.apiUrl || process.env.JULES_API_URL || "https://jules.googleapis.com/v1alpha/sessions";

  // Normalize session ID (handles full resource name "sessions/123" or short ID "123")
  const sessionPath = sessionId.startsWith("sessions/") ? sessionId : `sessions/${sessionId}`;

  if (apiKey) {
    const targetUrl = apiUrlBase.endsWith(`/${sessionPath}`)
      ? apiUrlBase
      : `${apiUrlBase.replace(/\/sessions\/?$/, "")}/${sessionPath}`;

    try {
      const res = await fetch(targetUrl, {
        method: "GET",
        headers: {
          "X-Goog-Api-Key": apiKey,
          "Content-Type": "application/json"
        },
        signal: AbortSignal.timeout(15000)
      });

      if (res.ok) {
        const data = await res.json();
        const outputs = data.outputs || [];
        const changeSetOutput = outputs.find((o) => o.type === "changeSet" || o.changeSet);
        const changeSet = changeSetOutput?.changeSet;
        const diff = changeSet?.gitPatch?.unidiffPatch || "";

        return {
          sessionId: data.sessionId || sessionId,
          state: data.state || "UNKNOWN",
          title: data.title || "",
          hasPatch: !!diff,
          diff
        };
      }
    } catch (err) {
      log.warn(`⚠️ REST API fetch failed (${err.message}), attempting SDK fallback...`);
    }
  }

  // Fallback to @google/jules-sdk if available
  try {
    const { jules } = await import("@google/jules-sdk");
    const rawId = sessionId.replace(/^sessions\//, "");
    const info = await jules.session(rawId).info();
    const outputs = info.outputs || [];
    const changeSet = outputs.find((o) => o.type === "changeSet" || o.changeSet)?.changeSet;
    const diff = changeSet?.gitPatch?.unidiffPatch || "";

    return {
      sessionId: info.id || rawId,
      state: info.state || "UNKNOWN",
      title: info.title || "",
      hasPatch: !!diff,
      diff
    };
  } catch (sdkErr) {
    if (sdkErr.code === "ERR_MODULE_NOT_FOUND" || sdkErr.message?.includes("Cannot find package")) {
      throw new Error("No API key configured and @google/jules-sdk is not installed. Set JULES_API_KEY or install @google/jules-sdk.");
    }
    throw new Error(`Failed to retrieve session patch: ${sdkErr.message}`);
  }
}

if (isMainModule) {
  loadEnv();
  ensureSdkCacheIsolation();

  const args = process.argv.slice(2);
  const isJson = args.includes("--json");
  const filteredArgs = args.filter((arg) => !arg.startsWith("--"));
  const sessionId = filteredArgs[0];

  if (!sessionId || args.includes("--help") || args.includes("-h")) {
    console.error("Usage: node scripts/jules-patch.mjs <session_id> [--json]");
    console.error("Extracts raw git unidiff patch from a Jules session for headless CI (git apply).");
    process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
  }

  fetchSessionPatch(sessionId)
    .then((result) => {
      if (isJson) {
        console.log(JSON.stringify(result, null, 2));
        process.exit(0);
      }

      if (!result.hasPatch || !result.diff) {
        console.error(`::warning::No git patch found in session outputs for session: ${sessionId}`);
        process.exit(2);
      }

      process.stdout.write(result.diff);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`::error::Failed to extract patch for session ${sessionId}: ${err.message}`);
      process.exit(1);
    });
}
