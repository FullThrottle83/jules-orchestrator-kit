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
 * Output shapes that mean "this command failed" even when the runner exited 0.
 *
 * Kept deliberately narrow: this list is only consulted for a `bashOutput`
 * whose `exitCode` is `0` or absent, where the alternative is reporting
 * nothing at all. A false positive here costs a few hundred characters of
 * retry prompt; a false negative costs the retry its only evidence.
 */
const BASH_FAILURE_HINTS = [
  /(^|\n)\s*not ok\b/i,
  /(^|\n)# fail [1-9]/i,
  /\b[1-9]\d* failed\b/i,
  /\b[1-9]\d* failing\b/i,
  /\bAssertionError\b/,
  /\bFAILED\b/,
  /\bTraceback \(most recent call last\)/,
  /\bpanic: /,
  /\berror:/i,
];

/**
 * Collects the diagnostics a session actually carries.
 *
 * The documented Activity type — the Jules API types reference, transcribed
 * in `docs/jules-quality-plan.md` — puts command output under
 * `artifacts[].bashOutput.{command,output,exitCode}` and the failure reason
 * under `sessionFailed.reason`. Neither `act.error` nor `act.executionOutput`
 * — the only two fields this file used to read — exists in that schema, so a
 * real failure came back as the generic fallback sentence and the retry session
 * was dispatched without the assertion it existed to fix.
 *
 * Blocks are returned highest-signal first, because `retrySession` truncates
 * the joined result to 4000 characters from the front: the ordering decides
 * which evidence survives the cut.
 *
 * The legacy spellings are still read. They cost nothing, and an unrecognised
 * provider shape that does carry an error is better served by it than by the
 * fallback sentence.
 *
 * @param {Array<object>} activities - Activities as returned by `listActivities`.
 * @returns {Array<{ source: string, text: string }>} Highest-signal first.
 */
export function extractFailureDiagnostics(activities) {
  const list = Array.isArray(activities) ? activities : [];
  const failingBash = [];
  const failureReasons = [];
  const suspiciousBash = [];
  const legacy = [];
  const agentNotes = [];
  const seen = new Set();

  const push = (bucket, source, text) => {
    const clean = String(text ?? "").trim();
    if (!clean) return;
    const key = `${source}\u0000${clean}`;
    if (seen.has(key)) return;
    seen.add(key);
    bucket.push({ source, text: clean });
  };

  for (const act of list) {
    if (!act || typeof act !== "object") continue;

    const artifacts = Array.isArray(act.artifacts) ? act.artifacts : [];
    for (const art of artifacts) {
      const bash = art && typeof art === "object" ? art.bashOutput : null;
      if (!bash || typeof bash !== "object") continue;
      const command = typeof bash.command === "string" ? bash.command : "";
      const output = typeof bash.output === "string" ? bash.output : "";
      if (!command && !output) continue;
      const rendered = `$ ${command || "(unknown command)"}\n${output || "(no output)"}`;
      const exitCode = bash.exitCode;
      if (typeof exitCode === "number" && exitCode !== 0) {
        push(failingBash, "bashOutput", `${rendered}\n(exit code ${exitCode})`);
      } else if (BASH_FAILURE_HINTS.some((re) => re.test(output))) {
        const codeNote = typeof exitCode === "number" ? String(exitCode) : "not reported";
        push(suspiciousBash, "bashOutput", `${rendered}\n(exit code ${codeNote})`);
      }
    }

    const failed = act.sessionFailed && typeof act.sessionFailed === "object" ? act.sessionFailed : null;
    if (failed && typeof failed.reason === "string") {
      push(failureReasons, "sessionFailed", failed.reason);
    }

    if (act.error) {
      push(legacy, "legacy.error", typeof act.error === "string" ? act.error : JSON.stringify(act.error));
    }
    if (act.executionOutput && (act.exitCode !== 0 || act.status === "FAILED")) {
      push(legacy, "legacy.executionOutput", act.executionOutput);
    }

    if (act.originator === "agent" && typeof act.description === "string") {
      push(agentNotes, "agentMessage", act.description);
    }
  }

  return [...failingBash, ...failureReasons, ...suspiciousBash, ...legacy, ...agentNotes];
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
    // Writing an agent's patch into the working tree is the other moment a
    // rollback target has to exist. The hosted provider works server-side, so
    // dispatch never touched this tree — this is the first time it changes.
    if (opts.checkpoint !== false) {
      try {
        const { createCheckpoint } = await import("./ops/checkpoint.mjs");
        createCheckpoint(`patch-${String(sessionId).replace(/[^A-Za-z0-9_.-]/g, "-")}`, { root });
      } catch (err) {
        console.warn(`⚠️  Could not snapshot before applying the patch (${err.message}); \`agentctl rollback\` will not cover it.`);
      }
    }

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
 * @returns {Promise<{ ok: boolean, originalSessionId: string, newSession: object, failureReason: string, diagnosticsFound: number, diagnosticSources: string[] }>}
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

  // Extract failure diagnostics. `extractFailureDiagnostics` reads the fields
  // the API actually documents (artifacts[].bashOutput, sessionFailed.reason)
  // and returns them highest-signal first, so the 4000-character cut below
  // drops the least useful evidence rather than the assertion that failed.
  const diagnostics = extractFailureDiagnostics(activities);

  const rawPrompt = session?.raw?.prompt || session?.prompt || "";
  const title = session?.raw?.title || `Retry of Session ${sessionId}`;
  const failureReason =
    diagnostics
      .map((d) => d.text)
      .join("\n")
      .slice(0, 4000) || "Previous session did not complete cleanly.";

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
    // Non-zero only when the session carried evidence the retry could act on.
    // A zero here with a non-empty `failureReason` means the fallback sentence
    // was sent — the distinction the CLI and any telemetry need, because the
    // two look identical in `failureReason` alone.
    diagnosticsFound: diagnostics.length,
    diagnosticSources: diagnostics.map((d) => d.source),
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
