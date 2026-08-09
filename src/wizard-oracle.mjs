import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { detectStack, parseYaml } from "./config.mjs";
import { runCmd } from "./git.mjs";

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

  // Check Node.json package.json scripts
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const scripts = pkg.scripts || {};

      if (scripts.test) candidates.testCmd = candidates.testCmd || "npm test";
      if (scripts.build) candidates.buildCmd = candidates.buildCmd || "npm run build";
      if (scripts.lint) candidates.lintCmd = "npm run lint";
      if (scripts.typecheck || scripts["type-check"]) {
        candidates.typecheckCmd = scripts.typecheck ? "npm run typecheck" : "npm run type-check";
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
    candidates.lintCmd = candidates.lintCmd || "golangci-lint run";
    candidates.typecheckCmd = candidates.typecheckCmd || "go vet ./...";
  }

  // Check Python
  if (stack.includes("pytest") || existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "requirements.txt"))) {
    candidates.testCmd = candidates.testCmd || "pytest";
    candidates.buildCmd = candidates.buildCmd || "";
    candidates.lintCmd = candidates.lintCmd || "flake8 .";
    candidates.typecheckCmd = candidates.typecheckCmd || "mypy .";
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
