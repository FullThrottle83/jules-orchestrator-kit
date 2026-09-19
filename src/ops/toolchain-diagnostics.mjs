/**
 * First-run toolchain diagnostics: name the binary a verify command needs,
 * spot missing install trees, and turn Exit-4 failure text into a targeted hint.
 *
 * Zero third-party deps. PATH lookup reuses whichBinary from provider-readiness.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { whichBinary } from "../provider-readiness.mjs";

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL_SKIP = new Set(["cd", "env", "command", "exec", "nice", "time", "nohup"]);

/**
 * Peel the primary executable out of an effective verify.test command string.
 *
 * Handles `PYTHONPATH=src python3 -m pytest`, `npm test`, `cargo test`, and
 * simple `cmd && …` chains (first segment only). Returns null when nothing
 * resolvable remains.
 *
 * @param {string} cmd
 * @returns {string|null}
 */
export function extractPrimaryExecutable(cmd) {
  if (!cmd || typeof cmd !== "string") return null;
  const tokens = cmd.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length) {
    if (ENV_ASSIGNMENT.test(tokens[i])) {
      i += 1;
      continue;
    }
    if (tokens[i] === "cd" && tokens[i + 1] && !tokens[i + 1].startsWith("-")) {
      i += 2;
      if (tokens[i] === "&&" || tokens[i] === ";" || tokens[i] === "||") i += 1;
      continue;
    }
    if (tokens[i] === "&&" || tokens[i] === ";" || tokens[i] === "||" || tokens[i] === "|") {
      i += 1;
      continue;
    }
    if (SHELL_SKIP.has(tokens[i])) {
      i += 1;
      continue;
    }
    break;
  }
  let bin = tokens[i] || "";
  bin = bin.replace(/^['"]|['"]$/g, "");
  if (!bin || bin.startsWith("-")) return null;
  // Basename for PATH lookup when the command used an absolute/relative path.
  if (bin.includes("/") || bin.includes("\\")) {
    const parts = bin.split(/[/\\]/);
    const base = parts[parts.length - 1];
    return base || bin;
  }
  return bin;
}

/**
 * True when a Python virtualenv looks usable under root (or VIRTUAL_ENV).
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function hasUsableVenv(root, env = process.env) {
  if (env.VIRTUAL_ENV && existsSync(env.VIRTUAL_ENV)) {
    const marker = join(env.VIRTUAL_ENV, process.platform === "win32" ? "Scripts" : "bin");
    if (existsSync(marker)) return true;
  }
  const candidates = [".venv", "venv", ".direnv"];
  for (const name of candidates) {
    const base = join(root, name);
    const binDir = join(base, process.platform === "win32" ? "Scripts" : "bin");
    const py = join(binDir, process.platform === "win32" ? "python.exe" : "python");
    const py3 = join(binDir, process.platform === "win32" ? "python.exe" : "python3");
    if (existsSync(py) || existsSync(py3)) return true;
  }
  return false;
}

/**
 * True when root has a package.json but no node_modules directory.
 * @param {string} root
 * @returns {boolean}
 */
export function missingNodeModules(root) {
  return existsSync(join(root, "package.json")) && !existsSync(join(root, "node_modules"));
}

/**
 * True when a Python dep manifest is present without a usable venv.
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function missingPythonEnv(root, env = process.env) {
  const hasManifest =
    existsSync(join(root, "pyproject.toml")) ||
    existsSync(join(root, "requirements.txt")) ||
    existsSync(join(root, "Pipfile")) ||
    existsSync(join(root, "setup.py"));
  if (!hasManifest) return false;
  return !hasUsableVenv(root, env);
}

/**
 * Lightweight, read-only probe that the verify binary answers at all.
 * Prefers `--version` / `-V`; for `python* -m MOD` also tries a cheap import.
 *
 * @param {string} root
 * @param {string} effectiveTest
 * @param {string} primaryBin
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ ok: boolean, detail: string }}
 */
export function probeOracleLightly(root, effectiveTest, primaryBin, env = process.env) {
  if (!primaryBin) return { ok: false, detail: "No primary executable to probe" };
  const resolved = whichBinary(primaryBin, env);
  if (!resolved) return { ok: false, detail: `\`${primaryBin}\` is not on PATH` };

  const trySpawn = (args) => {
    try {
      const ret = spawnSync(resolved, args, {
        cwd: root,
        encoding: "utf-8",
        timeout: 8000,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      return ret.status === 0;
    } catch (_) {
      return false;
    }
  };

  if (trySpawn(["--version"]) || trySpawn(["-V"]) || trySpawn(["version"])) {
    return { ok: true, detail: `\`${primaryBin}\` answered a version probe` };
  }

  const modMatch = String(effectiveTest || "").match(/(?:^|\s)-m\s+(\S+)/);
  if (modMatch && /^python/.test(primaryBin)) {
    const mod = modMatch[1].replace(/[^A-Za-z0-9_.]/g, "");
    if (mod && trySpawn(["-c", `import ${mod}`])) {
      return { ok: true, detail: `\`${primaryBin} -c "import ${mod}"\` succeeded` };
    }
    return {
      ok: false,
      detail: `\`${primaryBin}\` is on PATH but could not import \`${mod || "module"}\` — install project deps / activate a venv`,
    };
  }

  // Binary exists on PATH; version flags are optional for some tools.
  try {
    if (existsSync(resolved) && statSync(resolved).isFile()) {
      return { ok: true, detail: `\`${primaryBin}\` is on PATH at ${resolved}` };
    }
  } catch (_) {}
  return { ok: false, detail: `\`${primaryBin}\` did not respond to a lightweight probe` };
}

/**
 * Name the missing binary from a failed verify stage when possible.
 * @param {{ command?: string|null, stderr?: string, stdout?: string, error?: string, code?: string|number }} failure
 * @returns {string|null}
 */
export function inferMissingBinary(failure = {}) {
  const text = [failure.stderr, failure.stdout, failure.error, failure.message]
    .filter(Boolean)
    .map(String)
    .join("\n");
  // Node spawn: `spawnSync foo ENOENT` / `spawn foo ENOENT`
  const spawn = text.match(/spawn(?:Sync)?(?:\s+\S+\/)*\s*([^\s/\\]+)(?:\.exe|\.cmd|\.bat)?\s+ENOENT/i);
  if (spawn) return spawn[1];
  const notFound = text.match(/(?:command not found|not found):\s*([^\s]+)/i);
  if (notFound) return notFound[1].replace(/^['"`]|['"`]$/g, "");
  if (failure.command) return extractPrimaryExecutable(String(failure.command));
  return null;
}

/**
 * Classify an Exit-4 verification failure for the CLI remediation hint.
 *
 * @param {{ exitCode?: number|null, stderr?: string, stdout?: string, error?: string|object, code?: string|number, command?: string|null, message?: string }} failure
 * @returns {{ kind: "missing-binary"|"missing-deps"|"general", binary?: string|null, lines: string[] }}
 */
export function diagnoseVerifyFailure(failure = {}) {
  const exitCode = failure.exitCode;
  const errCode =
    typeof failure.code === "string"
      ? failure.code
      : failure.error && typeof failure.error === "object" && failure.error.code
        ? String(failure.error.code)
        : "";
  const text = [
    failure.stderr || "",
    failure.stdout || "",
    typeof failure.error === "string" ? failure.error : failure.error?.message || "",
    failure.message || "",
    errCode,
  ].join("\n");

  const missingBinary =
    exitCode === 127 ||
    errCode === "ENOENT" ||
    /\bENOENT\b/i.test(text) ||
    /command not found/i.test(text) ||
    /is not recognized as an internal or external command/i.test(text);

  if (missingBinary) {
    const binary = inferMissingBinary(failure);
    const named = binary ? `\`${binary}\`` : "the required binary";
    return {
      kind: "missing-binary",
      binary,
      lines: [
        `Verification could not start because ${named} is missing from PATH (exit ${exitCode ?? "n/a"}).`,
        binary
          ? `Install \`${binary}\`, or set verify.test in .agent/config.yml to a command this machine has.`
          : "Install the missing tool, or set verify.test in .agent/config.yml to a command this machine has.",
      ],
    };
  }

  const missingDeps =
    /Cannot find module\b/i.test(text) ||
    /ModuleNotFoundError\b/i.test(text) ||
    /No module named\b/i.test(text) ||
    /Could not find a version that satisfies/i.test(text);

  if (missingDeps) {
    const isPy = /ModuleNotFoundError\b|No module named\b/i.test(text);
    return {
      kind: "missing-deps",
      lines: [
        "Verification failed because a required dependency is not installed.",
        isPy
          ? "Create/activate a venv and install deps (e.g. `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`), then re-run the gate."
          : "Install project dependencies (e.g. `npm install` / `pnpm install`), then re-run the gate.",
      ],
    };
  }

  return {
    kind: "general",
    lines: [
      "The stage above exited non-zero. Reproduce it locally, then re-run the gate.",
      "To start an explicit repair workflow, pipe the failing command's output to: agentctl repair",
    ],
  };
}
