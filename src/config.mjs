import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname, sep } from "node:path";
import { execSync } from "node:child_process";

const DEFAULTS = {
  version: 1,
  provider: "jules",
  verify: {},
  scope: { deny: [], allow: [], protect: [] },
  limits: {
    diffKb: 75,
    promptKb: 50,
    dailyTasks: 300,
    repairAttempts: 3,
    concurrency: 1,
    staggerMs: 1500,
  },
  isolation: "none",
  runner: "local",
  branchPrefix: "agent/",
  baseBranch: "main",
};

const BUILTIN_DENY = [
  ".git/**",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  ".agent/config.yml",
  ".github/**",
];

const BUILTIN_PROTECT = [
  ".agent/rules/**",
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "Makefile",
];

export function normalizePath(p) {
  if (!p || typeof p !== "string") return "";
  return p.split(sep).join("/").replace(/\\/g, "/");
}

export function resolveRoot(cwd = process.cwd()) {
  try {
    return execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (_) {
    return resolve(cwd);
  }
}

/**
 * Lightweight, zero-dependency YAML parser for key-value structures, arrays, and 2-level nested maps.
 */
export function parseYaml(src) {
  if (!src || typeof src !== "string") return {};
  const result = {};
  const lines = src.split("\n");
  let currentKey = null;

  for (let rawLine of lines) {
    const indent = rawLine.length - rawLine.trimStart().length;
    const commentIdx = rawLine.indexOf("#");
    let line = commentIdx !== -1 ? rawLine.slice(0, commentIdx) : rawLine;
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("- ") && currentKey) {
      if (!Array.isArray(result[currentKey])) {
        result[currentKey] = [];
      }
      const val = trimmed.slice(2).trim().replace(/^["']|["']$/g, "");
      if (val) result[currentKey].push(val);
      continue;
    }

    const eqIdx = trimmed.indexOf(":");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();

      if (indent === 0) {
        currentKey = key;
        if (!val) {
          // Could be array or nested map, initialized on next line
        } else if (val.startsWith("[") && val.endsWith("]")) {
          // Flow-style array: ["a", "b"]
          const items = val
            .slice(1, -1)
            .split(",")
            .map((s) => s.trim().replace(/^["']|["']$/g, ""))
            .filter(Boolean);
          result[key] = items;
        } else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          result[key] = val.slice(1, -1);
        } else if (val === "true") {
          result[key] = true;
        } else if (val === "false") {
          result[key] = false;
        } else if (!isNaN(Number(val))) {
          result[key] = Number(val);
        } else {
          result[key] = val;
        }
      } else if (indent > 0 && currentKey) {
        if (typeof result[currentKey] !== "object" || result[currentKey] === null || Array.isArray(result[currentKey])) {
          result[currentKey] = {};
        }
        let parsedVal = val;
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          parsedVal = val.slice(1, -1);
        } else if (val === "true") {
          parsedVal = true;
        } else if (val === "false") {
          parsedVal = false;
        } else if (val && !isNaN(Number(val))) {
          parsedVal = Number(val);
        }
        result[currentKey][key] = parsedVal;
      }
    }
  }

  return result;
}

export function detectPackageManager(root = process.cwd(), pkg = {}) {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "bun.lockb"))) return "bun";
  if (existsSync(join(root, "package-lock.json"))) return "npm";

  const pm = pkg.packageManager;
  if (typeof pm === "string") {
    if (pm.startsWith("pnpm")) return "pnpm";
    if (pm.startsWith("yarn")) return "yarn";
    if (pm.startsWith("bun")) return "bun";
    if (pm.startsWith("npm")) return "npm";
  }

  return "npm";
}

/**
 * Autodetects verification test/build commands across 16 common tech stacks.
 */
export function detectStack(projectRoot = process.cwd()) {
  const detectors = [
    {
      files: ["turbo.json"],
      resolve: () => ({ testCmd: "npx turbo run test", buildCmd: "npx turbo run build", stack: "turbo" }),
    },
    {
      files: ["pnpm-workspace.yaml"],
      resolve: () => ({ testCmd: "pnpm -r test", buildCmd: "pnpm -r build", stack: "pnpm" }),
    },
    {
      files: ["nx.json"],
      resolve: () => ({ testCmd: "npx nx run-many -t test", buildCmd: "npx nx run-many -t build", stack: "nx" }),
    },
    {
      files: ["bunfig.toml", "bun.lockb"],
      resolve: () => ({ testCmd: "bun test", buildCmd: "bun run build", stack: "bun" }),
    },
    {
      files: ["deno.json", "deno.jsonc"],
      resolve: () => ({ testCmd: "deno test", buildCmd: "deno task build", stack: "deno" }),
    },
    {
      files: ["package.json"],
      resolve: (root) => {
        try {
          const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
          const pm = detectPackageManager(root, pkg);
          const scripts = pkg.scripts || {};
          let testScript = scripts.test ? `${pm} test` : "";
          const buildScript = scripts.build ? `${pm} run build` : "";
          return { testCmd: testScript || `${pm} test`, buildCmd: buildScript, stack: "node" };
        } catch (_) {
          return { testCmd: "npm test", buildCmd: "npm run build", stack: "node" };
        }
      },
    },
    {
      files: ["Cargo.toml"],
      resolve: () => ({ testCmd: "cargo test --workspace", buildCmd: "cargo build", stack: "cargo" }),
    },
    {
      files: ["go.mod"],
      resolve: () => ({ testCmd: "go test ./...", buildCmd: "go build ./...", stack: "go" }),
    },
    {
      files: ["pyproject.toml", "requirements.txt", "setup.py"],
      resolve: () => ({ testCmd: "pytest", buildCmd: "", stack: "python" }),
    },
    {
      files: ["mix.exs"],
      resolve: () => ({ testCmd: "mix test", buildCmd: "mix compile", stack: "mix" }),
    },
    {
      files: ["Gemfile"],
      resolve: () => ({ testCmd: "bundle exec rake test", buildCmd: "", stack: "bundler" }),
    },
    {
      files: ["Package.swift"],
      resolve: () => ({ testCmd: "swift test", buildCmd: "swift build", stack: "swift" }),
    },
    {
      files: ["pom.xml"],
      resolve: () => ({ testCmd: "mvn test", buildCmd: "mvn compile", stack: "maven" }),
    },
    {
      files: ["build.gradle", "build.gradle.kts"],
      resolve: () => ({ testCmd: "./gradlew test", buildCmd: "./gradlew assemble", stack: "gradle" }),
    },
    {
      files: ["Makefile"],
      resolve: () => ({ testCmd: "make test", buildCmd: "make build", stack: "make" }),
    },
  ];

  for (const detector of detectors) {
    if (detector.files.some((f) => existsSync(join(projectRoot, f)))) {
      const res = detector.resolve(projectRoot);
      if (res) return res;
    }
  }

  return { testCmd: "", buildCmd: "", stack: "unknown" };
}

export function resolveVerify(root = process.cwd()) {
  const s = detectStack(root);
  return { test: s.testCmd || "", build: s.buildCmd || "" };
}

function dedupe(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

/**
 * Loads and validates configuration from .agent/config.yml or .agent/jules.yml.
 */
export function loadConfig(root = resolveRoot(), explicitPath = null) {
  const candidates = explicitPath
    ? [explicitPath]
    : [join(root, ".agent/config.yml"), join(root, ".agent/jules.yml")];

  const configFile = candidates.find(existsSync);
  let parsed = {};
  if (configFile) {
    try {
      const raw = readFileSync(configFile, "utf-8");
      parsed = parseYaml(raw);
    } catch (_) {}
  }

  const testCmd = parsed.test_cmd || parsed.verify?.test || "";
  const buildCmd = parsed.build_cmd || parsed.verify?.build || "";
  const forbiddenPaths = Array.isArray(parsed.forbidden_paths)
    ? parsed.forbidden_paths
    : Array.isArray(parsed.scope?.deny)
    ? parsed.scope.deny
    : [];
  const allowPaths = Array.isArray(parsed.allow_paths)
    ? parsed.allow_paths
    : Array.isArray(parsed.scope?.allow)
    ? parsed.scope.allow
    : [];

  const autoVerify = resolveVerify(root);

  const config = {
    version: parsed.version || DEFAULTS.version,
    provider: parsed.provider || DEFAULTS.provider,
    verify: {
      test: testCmd || autoVerify.test,
      build: buildCmd || autoVerify.build,
    },
    scope: {
      deny: dedupe([...BUILTIN_DENY, ...forbiddenPaths]),
      allow: dedupe(allowPaths),
      protect: dedupe(BUILTIN_PROTECT),
    },
    limits: {
      ...DEFAULTS.limits,
      ...(parsed.limits || {}),
    },
    isolation: parsed.isolation || DEFAULTS.isolation,
    runner: parsed.runner || DEFAULTS.runner,
    branchPrefix: parsed.branch_prefix || parsed.branchPrefix || DEFAULTS.branchPrefix,
    baseBranch: parsed.base_branch || parsed.baseBranch || DEFAULTS.baseBranch,
    _root: root,
    _file: configFile || null,
  };

  return config;
}
