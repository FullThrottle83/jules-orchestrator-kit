import { existsSync, statSync } from "node:fs";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveWindowsSpawn } from "./git.mjs";

/**
 * What each provider actually needs before a dispatch can succeed.
 *
 * The kit shipped four provider adapters (`src/provider.mjs`) but only ever
 * asked one question about readiness: "is JULES_API_KEY set?". That question is
 * meaningless for `claude-code` and `codex`, which authenticate through their
 * own CLI and need a binary on PATH instead of an environment variable — so a
 * repository driven by a local agent CLI was told, forever, that it was
 * misconfigured. Readiness is a property of the *selected* provider, and this
 * table is where that property lives.
 *
 * `envKeys` are alternatives, not requirements in sequence: any one satisfies
 * the provider. `bin` is the executable the exec adapter spawns.
 *
 * No documentation URLs live here on purpose: `test/egress-allowlist.test.mjs`
 * treats every host literal under src/ as a network destination to justify, and
 * a vendor doc link that nothing ever fetches would spend that budget without
 * buying anything. `install` and `remedy` carry the actionable part.
 */
export const PROVIDER_DESCRIPTORS = {
  jules: {
    name: "jules",
    kind: "http",
    label: "Google Jules — hosted asynchronous agent (REST)",
    envKeys: ["JULES_API_KEY", "GEMINI_API_KEY"],
    bin: null,
    install: null,
    remedy: "export JULES_API_KEY=...",
    // Only the hosted provider clones a GitHub repository server-side, so only
    // it needs to be told which one.
    needsRepoSource: true,
  },
  "claude-code": {
    name: "claude-code",
    kind: "exec",
    label: "Claude Code CLI — local agent",
    envKeys: [],
    bin: "claude",
    install: "npm i -g @anthropic-ai/claude-code",
    remedy: "Install the Claude Code CLI and run `claude` once to authenticate",
    needsRepoSource: false,
  },
  codex: {
    name: "codex",
    kind: "exec",
    label: "OpenAI Codex CLI — local agent",
    envKeys: [],
    bin: "codex",
    install: "npm i -g @openai/codex",
    remedy: "Install the Codex CLI and run `codex` once to authenticate",
    needsRepoSource: false,
  },
  "gemini-flash": {
    name: "gemini-flash",
    kind: "exec",
    label: "Gemini CLI — local agent (cheap/fast router tier)",
    envKeys: ["GEMINI_API_KEY"],
    bin: "gemini",
    install: "npm i -g @google/gemini-cli",
    remedy: "Install the Gemini CLI and export GEMINI_API_KEY",
    needsRepoSource: false,
  },
};

/** `gemini-cli` is an accepted spelling in NAMED_PRESETS; keep the two in step. */
PROVIDER_DESCRIPTORS["gemini-cli"] = { ...PROVIDER_DESCRIPTORS["gemini-flash"], name: "gemini-cli" };

/**
 * Preference order when nothing is configured and several providers are ready.
 *
 * Hosted first because it is the only one that can run a task while the
 * operator's machine is asleep; the local CLIs follow in descending
 * capability. This is a *tie-break*, never an override: an explicit
 * `provider:` in .agent/config.yml always wins.
 */
export const PROVIDER_PREFERENCE = ["jules", "claude-code", "codex", "gemini-flash"];

/**
 * Cross-platform `which`, without shelling out.
 *
 * Spawning `which`/`where` costs a process per probe and does not exist
 * identically on Windows; PATHEXT resolution is the part that actually differs,
 * and it is three lines. Returns the absolute path or null.
 *
 * @param {string} bin
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string|null}
 */
export function whichBinary(bin, env = process.env) {
  if (!bin || typeof bin !== "string") return null;
  const pathVar = env.PATH || env.Path || env.path || "";
  if (!pathVar) return null;

  const isWindows = process.platform === "win32";
  // On Windows a bare name has no extension; PATHEXT lists the ones the shell
  // would have tried. Elsewhere the name is the whole story.
  const extensions = isWindows
    ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim()).filter(Boolean)
    : [""];

  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = join(dir, bin + ext);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch (_) {
        // Unreadable PATH entry (a stale mount, a permission-denied directory).
        // A probe must never throw: an unreadable directory simply holds nothing.
      }
    }
  }
  return null;
}

/**
 * Report whether one named provider can be dispatched to right now.
 *
 * Never throws and never spawns the agent: this is called from `agentctl` with
 * no arguments and from `doctor`, both of which must stay instant and free.
 *
 * @param {string} name
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env=process.env]
 * @returns {{name: string, kind: string, label: string, ready: boolean, reason: string, remedy: string, keySource: string|null, binPath: string|null, known: boolean}}
 */
export function probeProvider(name, opts = {}) {
  const env = opts.env || process.env;
  const key = String(name || "").trim().toLowerCase();
  const descriptor = PROVIDER_DESCRIPTORS[key];

  if (!descriptor) {
    return {
      name: key || "(unset)",
      kind: "unknown",
      label: key ? `Custom provider '${key}'` : "No provider selected",
      ready: false,
      known: false,
      reason: key
        ? `'${key}' is not a built-in provider preset, so its readiness cannot be checked here.`
        : "No provider is configured.",
      remedy: `Set provider: to one of ${PROVIDER_PREFERENCE.join(", ")} in .agent/config.yml`,
      keySource: null,
      binPath: null,
    };
  }

  const keySource = descriptor.envKeys.find((k) => (env[k] || "").trim()) || null;
  const binPath = descriptor.bin ? whichBinary(descriptor.bin, env) : null;

  // An http provider is gated purely on credentials; an exec provider is gated
  // on the binary, and treats its env key as optional because the CLIs carry
  // their own stored login.
  const ready = descriptor.kind === "http" ? Boolean(keySource) : Boolean(binPath);

  let reason;
  if (ready) {
    reason =
      descriptor.kind === "http"
        ? `Credential supplied via ${keySource} (read from the environment only).`
        : `\`${descriptor.bin}\` found on PATH${keySource ? ` (plus ${keySource})` : ""}.`;
  } else {
    reason =
      descriptor.kind === "http"
        ? `None of ${descriptor.envKeys.join(", ")} is set in the environment.`
        : `\`${descriptor.bin}\` is not on PATH.`;
  }

  return {
    name: descriptor.name,
    kind: descriptor.kind,
    bin: descriptor.bin,
    label: descriptor.label,
    ready,
    known: true,
    reason,
    remedy: descriptor.install && !binPath ? descriptor.install : descriptor.remedy,
    keySource,
    binPath,
  };
}

/**
 * Actually run the provider's CLI, rather than only finding it on PATH.
 *
 * `probeProvider` deliberately spawns nothing — it is called from a bare
 * `agentctl` invocation and from `doctor`, both of which must stay instant. But
 * a binary on PATH is a weak claim: a `gemini` that is installed and whose
 * account has no access still reports ready, `doctor` still says 11 passed, and
 * the first thing that disagrees is a dispatch that dies. This is the check
 * that can disagree earlier, so it is opt-in (`agentctl doctor --probe`).
 *
 * It proves the binary starts and answers, not that the account is entitled —
 * no CLI exposes "am I authorised" without doing work — but the common failures
 * (broken install, wrong architecture, a CLI that refuses to start unauthenticated)
 * surface here instead of mid-repair.
 *
 * @param {string} name
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env=process.env]
 * @param {number} [opts.timeoutMs=8000]
 * @returns {{ name: string, attempted: boolean, ok: boolean, detail: string }}
 */
export function probeProviderLiveness(name, opts = {}) {
  const env = opts.env || process.env;
  const base = probeProvider(name, { env });
  if (base.kind !== "exec" || !base.binPath) {
    return {
      name: base.name,
      attempted: false,
      ok: base.ready,
      detail: base.kind === "http" ? "Hosted provider — a credential cannot be validated without spending a request." : base.reason,
    };
  }

  try {
    // A global npm install puts a `.cmd` shim on PATH, and since the fix for
    // CVE-2024-27980 Node refuses to spawn one directly — it comes back EINVAL,
    // which would report every Windows CLI as broken. `resolveWindowsSpawn` is
    // the same routing `runCmd` already uses: native .exe direct, everything
    // else through cmd.exe with the argv quoted the way cmd.exe parses it back.
    const win = resolveWindowsSpawn(base.binPath, ["--version"], env);
    const res = win
      ? spawnSync(win.file, win.args, {
          encoding: "utf-8",
          timeout: Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 8000,
          env,
          windowsVerbatimArguments: win.verbatim,
        })
      : spawnSync(base.binPath, ["--version"], {
          encoding: "utf-8",
          timeout: Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 8000,
          env,
        });
    if (res.error) {
      return { name: base.name, attempted: true, ok: false, detail: `\`${base.bin || base.name} --version\` could not run: ${res.error.message}` };
    }
    if (res.status !== 0) {
      const why = ((res.stderr || res.stdout || "").trim().split("\n")[0] || `exit ${res.status}`).slice(0, 200);
      return { name: base.name, attempted: true, ok: false, detail: `\`--version\` exited ${res.status}: ${why}` };
    }
    const version = (res.stdout || "").trim().split("\n")[0].slice(0, 80);
    return { name: base.name, attempted: true, ok: true, detail: version ? `CLI responds: ${version}` : "CLI responds." };
  } catch (err) {
    return { name: base.name, attempted: true, ok: false, detail: `Probe failed: ${err.message}` };
  }
}

/**
 * Probe every built-in provider, ready ones first, in preference order.
 *
 * Used by `agentctl init` to propose a provider the machine can actually reach
 * instead of scaffolding `provider: jules` into a repository whose operator has
 * no Jules key and never wanted one.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env=process.env]
 * @returns {Array<ReturnType<typeof probeProvider>>}
 */
export function detectAvailableProviders(opts = {}) {
  const probes = PROVIDER_PREFERENCE.map((name) => probeProvider(name, opts));
  return probes.sort((a, b) => {
    if (a.ready !== b.ready) return a.ready ? -1 : 1;
    return PROVIDER_PREFERENCE.indexOf(a.name) - PROVIDER_PREFERENCE.indexOf(b.name);
  });
}

/**
 * The provider a fresh `init` should scaffold: the first one that is actually
 * usable on this machine, falling back to the hosted default so a repository
 * initialised offline still names something coherent.
 *
 * @param {object} [opts]
 * @returns {string}
 */
export function suggestProvider(opts = {}) {
  const ready = detectAvailableProviders(opts).find((p) => p.ready);
  return ready ? ready.name : "jules";
}
