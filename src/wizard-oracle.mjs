import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { detectStack, parseYaml } from "./config.mjs";
import { runCmd } from "./git.mjs";

/**
 * Check if a command-line binary is available on the system PATH.
 * @param {string} binName
 * @returns {boolean}
 */
export function hasBinary(binName) {
  if (!binName || typeof binName !== "string") return false;
  const bin = binName.trim().split(/\s+/)[0];
  if (!bin) return false;
  try {
    const isWin = process.platform === "win32";
    const checker = isWin ? "where" : "which";
    const res = spawnSync(checker, [bin], { stdio: "ignore" });
    return res.status === 0;
  } catch (_) {
    return false;
  }
}

/**
 * Inspect repository topology, workspace structure, and manifests to infer candidate verification oracles.
 * @param {string} [root=process.cwd()]
 * @returns {{
 *   stack: string,
 *   isMonorepo: boolean,
 *   packages: Array<{ path: string, name: string, stack: string }>,
 *   candidates: {
 *     testCmd: string,
 *     buildCmd: string,
 *     lintCmd: string,
 *     typecheckCmd: string
 *   }
 * }}
 */
export function detectStackOracles(root = process.cwd()) {
  const detected = detectStack(root);
  const stack = detected.stack || "node";

  const candidates = {
    testCmd: detected.testCmd || "",
    buildCmd: detected.buildCmd || "",
    lintCmd: "",
    typecheckCmd: "",
  };

  const isMonorepo =
    existsSync(join(root, "turbo.json")) ||
    existsSync(join(root, "pnpm-workspace.yaml")) ||
    existsSync(join(root, "lerna.json")) ||
    existsSync(join(root, "nx.json"));

  const packages = [];

  // Check Node.js package.json scripts
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const scripts = pkg.scripts || {};
      const hasPnpm = existsSync(join(root, "pnpm-lock.yaml")) || existsSync(join(root, "pnpm-workspace.yaml"));
      const hasYarn = existsSync(join(root, "yarn.lock"));
      const hasBun = existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bunfig.toml"));
      const pm = hasPnpm ? "pnpm" : hasYarn ? "yarn" : hasBun ? "bun" : "npm";

      if (scripts.test) candidates.testCmd = candidates.testCmd || (pm === "yarn" ? "yarn test" : `${pm} test`);
      if (scripts.build) candidates.buildCmd = candidates.buildCmd || (pm === "yarn" ? "yarn build" : `${pm} run build`);
      if (scripts.lint) candidates.lintCmd = pm === "yarn" ? "yarn lint" : `${pm} run lint`;
      if (scripts.typecheck || scripts["type-check"]) {
        candidates.typecheckCmd = scripts.typecheck
          ? (pm === "yarn" ? "yarn typecheck" : `${pm} run typecheck`)
          : (pm === "yarn" ? "yarn type-check" : `${pm} run type-check`);
      } else if (existsSync(join(root, "tsconfig.json"))) {
        candidates.typecheckCmd = "npx tsc --noEmit";
      }
    } catch (_) {}
  }

  // Check Cargo workspace
  if (stack.includes("cargo") || existsSync(join(root, "Cargo.toml"))) {
    const isCargoWs = existsSync(join(root, "Cargo.toml")) && readFileSync(join(root, "Cargo.toml"), "utf-8").includes("[workspace]");
    const flag = isCargoWs ? " --workspace" : "";
    candidates.testCmd = `cargo test${flag}`;
    candidates.buildCmd = `cargo build${flag}`;
    candidates.lintCmd = `cargo clippy${flag} -- -D warnings`;
    candidates.typecheckCmd = `cargo check${flag}`;
  }

  // Check Go module
  if (stack.includes("go") || existsSync(join(root, "go.mod"))) {
    candidates.testCmd = candidates.testCmd || "go test ./...";
    candidates.buildCmd = candidates.buildCmd || "go build ./...";
    if (hasBinary("golangci-lint")) {
      candidates.lintCmd = candidates.lintCmd || "golangci-lint run";
    }
    candidates.typecheckCmd = candidates.typecheckCmd || "go vet ./...";
  }

  // Check Python
  if (stack.includes("pytest") || existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "requirements.txt"))) {
    candidates.testCmd = candidates.testCmd || "pytest";
    candidates.buildCmd = candidates.buildCmd || "";
    if (hasBinary("flake8")) {
      candidates.lintCmd = candidates.lintCmd || "flake8 .";
    } else if (hasBinary("ruff")) {
      candidates.lintCmd = candidates.lintCmd || "ruff check .";
    }
    if (hasBinary("mypy")) {
      candidates.typecheckCmd = candidates.typecheckCmd || "mypy .";
    }
  }

  // Discover subpackages if monorepo
  if (isMonorepo) {
    if (existsSync(join(root, "pnpm-workspace.yaml"))) {
      try {
        const parsed = parseYaml(readFileSync(join(root, "pnpm-workspace.yaml"), "utf-8"));
        const globs = parsed?.packages || ["packages/*"];
        globs.forEach((pattern) => {
          const dirBase = pattern.replace(/\/\*$/, "");
          const fullDir = join(root, dirBase);
          if (existsSync(fullDir)) {
            const children = readdirSync(fullDir);
            children.forEach((child) => {
              const childPath = join(fullDir, child);
              if (existsSync(join(childPath, "package.json"))) {
                packages.push({
                  path: join(dirBase, child),
                  name: child,
                  stack: "node",
                });
              }
            });
          }
        });
      } catch (_) {}
    }
  }

  return {
    stack,
    isMonorepo,
    packages,
    candidates,
  };
}

/**
 * Execute a candidate verification command to prove oracle validity.
 * @param {string} cmd
 * @param {string} [cwd=process.cwd()]
 * @param {object} [options]
 * @returns {Promise<{ ok: boolean, code: number, stdout: string, stderr: string, durationMs: number }>}
 */
export async function runVerificationProbe(cmd, cwd = process.cwd(), options = {}) {
  const start = Date.now();
  const timeoutMs = options.timeoutMs || 30_000;

  if (!cmd || !cmd.trim()) {
    return { ok: true, code: 0, stdout: "", stderr: "Empty oracle command (skipped)", durationMs: 0 };
  }

  try {
    const res = runCmd(cmd, { cwd, timeout: timeoutMs });
    const durationMs = Date.now() - start;
    const ok = res.status === 0;
    return {
      ok,
      code: res.status ?? (ok ? 0 : 1),
      stdout: res.stdout || "",
      stderr: res.stderr || "",
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    return {
      ok: false,
      code: 1,
      stdout: "",
      stderr: err.message,
      durationMs,
    };
  }
}
