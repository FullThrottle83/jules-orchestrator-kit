import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createProvider } from "./provider.mjs";
import { loadConfig, resolveRoot } from "./config.mjs";
import { redactSecrets } from "./security.mjs";

/**
 * Parses human-readable duration strings (e.g. "7d", "24h", "30m", "60s") into milliseconds.
 *
 * @param {string|number} duration
 * @returns {number} Milliseconds
 */
export function parseAgeDuration(duration) {
  if (typeof duration === "number" && Number.isFinite(duration)) return duration;
  if (!duration || typeof duration !== "string") return 0;
  const match = duration.trim().match(/^(\d+(?:\.\d+)?)\s*([smhdw])$/i);
  if (!match) {
    const num = Number(duration);
    return Number.isFinite(num) ? num : 0;
  }
  const val = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  switch (unit) {
    case "s": return val * 1000;
    case "m": return val * 60 * 1000;
    case "h": return val * 60 * 60 * 1000;
    case "d": return val * 24 * 60 * 60 * 1000;
    case "w": return val * 7 * 24 * 60 * 60 * 1000;
    default: return 0;
  }
}

/**
 * Extracts git diff patch, PR details, and modified files from a Jules session.
 *
 * @param {string} sessionId
 * @param {object} opts
 * @returns {Promise<{ ok: boolean, id: string, patch: string, pr: object|null, files: string[], error?: string }>}
 */
export async function extractSessionPatch(sessionId, opts = {}) {
  if (!sessionId || typeof sessionId !== "string") {
    throw new TypeError("extractSessionPatch requires a valid sessionId string");
  }
  const root = opts.root || resolveRoot();
  const config = opts.config || loadConfig(root);
  const provider = opts.provider || createProvider(config.provider || "jules", config);

  const session = await provider.getSession(sessionId, opts);
  const activitiesRes = await provider.listActivities(sessionId, opts).catch(() => ({ activities: [] }));
  const activities = activitiesRes.activities || [];

  let patch = "";
  let pr = null;
  const files = new Set();

  // 1. Inspect session outputs
  const outputs = session?.raw?.outputs || session?.outputs || [];
  for (const out of outputs) {
    if (out.pullRequest) {
      pr = out.pullRequest;
    }
    if (out.gitPatch || out.patch || out.diff) {
      patch = out.gitPatch || out.patch || out.diff;
    }
  }

  // 2. Inspect activity artifacts and logs if patch wasn't in top-level output
  for (const act of activities) {
    if (act.pullRequest) pr = act.pullRequest;
    if (act.gitPatch || act.patch || act.diff || act.changeSet?.gitPatch?.unidiffPatch) {
      patch = patch || act.gitPatch || act.patch || act.diff || act.changeSet?.gitPatch?.unidiffPatch;
    }
    const artifactList = [
      ...(Array.isArray(act.artifacts) ? act.artifacts : []),
      ...(Array.isArray(act.artifactsCreated?.artifacts) ? act.artifactsCreated.artifacts : []),
    ];
    for (const art of artifactList) {
      const artPatch =
        art.patch ||
        art.diff ||
        art.changeSet?.gitPatch?.unidiffPatch ||
        art.gitPatch?.unidiffPatch ||
        (typeof art.content === "string" && art.content.startsWith("diff --git") ? art.content : "");
      if (artPatch) {
        patch = patch || artPatch;
      }
      if (art.path || art.filename) {
        files.add(art.path || art.filename);
      }
    }
    if (act.changedFiles && Array.isArray(act.changedFiles)) {
      act.changedFiles.forEach((f) => files.add(f));
    }
  }

  // Extract changed files from patch headers if files set is empty
  if (patch && files.size === 0) {
    const fileMatches = patch.matchAll(/^diff --git a\/(.+?) b\/(.+?)$/gm);
    for (const m of fileMatches) {
      files.add(m[2]);
    }
  }

  return {
    ok: Boolean(patch || pr),
    id: sessionId,
    patch: patch ? (patch.endsWith("\n") ? patch : patch + "\n") : "",
    pr,
    files: Array.from(files),
    rawSession: session.raw,
  };
}

/**
 * Applies a Jules session's patch to the local working tree with git apply safety checks.
 *
 * @param {string} sessionId
 * @param {object} opts
 * @returns {Promise<{ ok: boolean, patchApplied: boolean, checkPassed: boolean, patch: string, files: string[], error?: string }>}
 */
export async function applySessionPatch(sessionId, opts = {}) {
  const root = opts.root || resolveRoot();
  const res = await extractSessionPatch(sessionId, { ...opts, root });

  if (!res.patch) {
    return {
      ok: false,
      patchApplied: false,
      checkPassed: false,
      patch: "",
      files: res.files || [],
      error: "No git patch found in session output or activities.",
    };
  }

  if (opts.save) {
    const savePath = resolve(root, opts.save);
    writeFileSync(savePath, res.patch, "utf-8");
  }

  // 1. Dry run: git apply --check
  const checkRes = spawnSync("git", ["apply", "--check", "-"], {
    cwd: root,
    input: res.patch,
    encoding: "utf-8",
  });

  if (checkRes.status !== 0) {
    const stderr = (checkRes.stderr || "").trim();
    return {
      ok: false,
      patchApplied: false,
      checkPassed: false,
      patch: res.patch,
      files: res.files,
      error: `git apply --check failed: ${stderr || "Patch does not cleanly apply to working directory"}`,
    };
  }

  // 2. If apply requested, execute git apply
  if (opts.apply) {
    const applyRes = spawnSync("git", ["apply", "-"], {
      cwd: root,
      input: res.patch,
      encoding: "utf-8",
    });

    if (applyRes.status !== 0) {
      const stderr = (applyRes.stderr || "").trim();
      return {
        ok: false,
        patchApplied: false,
        checkPassed: true,
        patch: res.patch,
        files: res.files,
        error: `git apply failed: ${stderr}`,
      };
    }

    return {
      ok: true,
      patchApplied: true,
      checkPassed: true,
      patch: res.patch,
      files: res.files,
    };
  }

  return {
    ok: true,
    patchApplied: false,
    checkPassed: true,
    patch: res.patch,
    files: res.files,
  };
}

/**
 * Gathers failure context and error output from a failed session and synthesizes a new OODA retry session.
 *
 * @param {string} sessionId
 * @param {object} opts
 * @returns {Promise<{ ok: boolean, originalSessionId: string, newSession: object, failureReason: string }>}
 */
export async function retrySession(sessionId, opts = {}) {
  if (!sessionId || typeof sessionId !== "string") {
    throw new TypeError("retrySession requires a valid sessionId string");
  }
  const root = opts.root || resolveRoot();
  const config = opts.config || loadConfig(root);
  const provider = opts.provider || createProvider(config.provider || "jules", config);

  const session = await provider.getSession(sessionId, opts);
  const activitiesRes = await provider.listActivities(sessionId, opts).catch(() => ({ activities: [] }));
  const activities = activitiesRes.activities || [];

  // Extract failure diagnostics
  const errors = [];
  for (const act of activities) {
    if (act.error) errors.push(typeof act.error === "string" ? act.error : JSON.stringify(act.error));
    if (act.executionOutput && (act.exitCode !== 0 || act.status === "FAILED")) {
      errors.push(act.executionOutput);
    }
  }

  const rawPrompt = session?.raw?.prompt || session?.prompt || "";
  const title = session?.raw?.title || `Retry of Session ${sessionId}`;
  const failureReason = errors.join("\n").slice(0, 4000) || "Previous session did not complete cleanly.";

  let synthesizedPrompt = rawPrompt;
  if (opts.withFailure !== false && failureReason) {
    synthesizedPrompt = `${rawPrompt}\n\n[PREVIOUS_ATTEMPT_FAILURE_DIAGNOSTIC]\nThe previous automated session failed with the following error output:\n\`\`\`\n${redactSecrets(failureReason)}\n\`\`\`\nPlease analyze this failure, fix the root cause, and ensure all tests pass.\n`;
  }

  const source = session?.raw?.sourceContext?.source || opts.source;
  const branch = session?.raw?.sourceContext?.githubRepoContext?.startingBranch || opts.branch || "main";

  const dispatchRes = await provider.dispatch(
    {
      title: opts.title || title,
      prompt: synthesizedPrompt,
      role: opts.role,
      source,
      branch,
    },
    opts
  );

  return {
    ok: true,
    originalSessionId: sessionId,
    newSession: dispatchRes,
    failureReason,
  };
}

/**
 * Queries and batch-archives old or completed Jules sessions based on age and state filters.
 *
 * @param {object} opts
 * @returns {Promise<{ ok: boolean, matchedCount: number, archivedCount: number, sessions: Array<{ id: string, state: string, createTime: string, action: string }> }>}
 */
export async function pruneSessions(opts = {}) {
  const root = opts.root || resolveRoot();
  const config = opts.config || loadConfig(root);
  const provider = opts.provider || createProvider(config.provider || "jules", config);

  const listRes = await provider.listSessions({ ...opts, pageSize: opts.pageSize || 100 });
  const allSessions = listRes.sessions || [];

  const maxAgeMs = opts.age ? parseAgeDuration(opts.age) : 0;
  const now = Date.now();
  const targetState = opts.state ? String(opts.state).toUpperCase() : null;

  const matched = [];
  for (const s of allSessions) {
    const state = (s.state || s.status || "UNKNOWN").toUpperCase();
    if (targetState && state !== targetState) continue;

    if (maxAgeMs > 0) {
      const timeStr = s.createTime || s.updateTime;
      const sessionTime = timeStr ? new Date(timeStr).getTime() : 0;
      if (sessionTime > 0 && now - sessionTime < maxAgeMs) {
        continue; // Session is newer than the cutoff age
      }
    }

    matched.push(s);
  }

  const results = [];
  for (const s of matched) {
    const id = s.id || (s.name ? s.name.split("/").pop() : "");
    if (!id) continue;

    if (opts.dryRun) {
      results.push({ id, state: s.state || s.status, createTime: s.createTime, action: "DRY_RUN_SKIP" });
    } else {
      try {
        if (opts.delete) {
          await provider.deleteSession(id, opts);
          results.push({ id, state: s.state || s.status, createTime: s.createTime, action: "DELETED" });
        } else {
          await provider.archiveSession(id, opts);
          results.push({ id, state: s.state || s.status, createTime: s.createTime, action: "ARCHIVED" });
        }
      } catch (err) {
        results.push({ id, state: s.state || s.status, createTime: s.createTime, action: `ERROR: ${err.message}` });
      }
    }
  }

  return {
    ok: true,
    matchedCount: matched.length,
    archivedCount: results.filter((r) => r.action === "ARCHIVED" || r.action === "DELETED").length,
    sessions: results,
  };
}
