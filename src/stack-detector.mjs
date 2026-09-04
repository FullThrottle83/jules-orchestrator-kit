import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { whichBinary } from "./provider-readiness.mjs";

/**
 * The Python interpreter to invoke, by whatever name this machine has it under.
 *
 * `python3` does not exist on a default Windows install (the launcher is `py`,
 * the Store package is `python`), so a hardcoded `python3` made every Python
 * command in the kit unrunnable there.
 */
function pythonBin(env = process.env) {
  for (const name of ["python3", "python", "py"]) {
    if (whichBinary(name, env)) return name;
  }
  return "python3";
}

/**
 * The command that runs a pytest suite.
 *
 * Not `pytest`. Invoked as a bare console script, pytest does not put the
 * working directory on `sys.path`; invoked as `-m`, Python does. So the most
 * ordinary Python layout there is — a module at the root, its test under
 * `tests/` importing it — collapsed at collection with `ModuleNotFoundError:
 * No module named 'calc'`, and the gate reported exit 4 on a project whose
 * suite passes perfectly when the developer types `python3 -m pytest`. A
 * first-run rejection of correct code is the most expensive failure this tool
 * can produce: it teaches the user the gate is wrong.
 *
 * Falls back to the bare console script only when no interpreter can be found
 * to host the module.
 */
export function pytestCmd(env = process.env) {
  for (const name of ["python3", "python", "py"]) {
    if (whichBinary(name, env)) return `${name} -m pytest`;
  }
  return "pytest";
}

/**
 * Does this Makefile declare a `test` target?
 *
 * Read rather than assumed: the presence of the file says nothing about
 * whether `make test` will run.
 */
function makefileHasTestTarget(root) {
  try {
    const text = readFileSync(join(root, "Makefile"), "utf-8");
    return /^\.PHONY:.*\btest\b/m.test(text) || /^test\s*:/m.test(text);
  } catch (_) {
    return false;
  }
}

/**
 * A declared test script that runs no tests and exits 0.
 *
 * This is the single most dangerous input the gate can receive, because every
 * downstream check reads "a command ran and passed". `bootstrapZeroTestRepo`
 * called `"test": "echo 'no tests yet' && exit 0"` an
 * EXISTING_VERIFICATION_ORACLE — it asked whether the field was set, never
 * what was in it.
 *
 * npm's own default (`echo "Error: no test specified" && exit 1`) is not a
 * placeholder by this definition, and correctly so: it exits non-zero, which
 * fails loudly rather than certifying nothing.
 */
export function isPlaceholderTestScript(cmd) {
  if (typeof cmd !== "string") return false;
  const trimmed = cmd.trim();
  if (!trimmed) return true;
  // Drop the announcements; what matters is what the shell is left doing.
  const remainder = trimmed
    .split(/&&|;/)
    .map((part) => part.trim())
    .filter((part) => part && !/^(?:echo|printf|:)\b/.test(part));
  if (remainder.length === 0) return true;
  return remainder.every((part) => /^(?:exit\s+0|true|:)$/.test(part));
}

/**
 * Generate the fallback verification oracle for a JS/generic repo with no tests.
 *
 * What this used to write could not fail:
 *
 *   assert.ok(fs.existsSync(process.cwd()));
 *   assert.ok(fs.readdirSync(process.cwd()).length > 0);
 *
 * Both hold for every repository and every change, so the generated "oracle"
 * was green against arbitrary broken code — and worse, it *silenced* the
 * `missingOracle` guard in engine.mjs, which fires only when no command ran at
 * all. A repository that honestly had no oracle was converted into one that
 * claimed to have one. That is the tool writing its own blindness to disk.
 *
 * The other stacks already get a real static gate at this point — `tsc
 * --noEmit`, `cargo check`, `go vet`, `compileall` — each of which fails on a
 * real class of defect. This is the JavaScript equivalent: every source file
 * must parse. It proves the code compiles, not that it works, and the caller
 * says so; but a syntax error fails it, which is one more than before.
 */
export function generateSmokeTestScript(root = process.cwd()) {
  const agentDir = join(root, ".agent");
  try {
    mkdirSync(agentDir, { recursive: true });
  } catch (_) {}

  const smokePath = join(agentDir, "smoke.test.mjs");
  const content = `// Auto-generated zero-dependency parse gate (.agent/smoke.test.mjs)
//
// Written by \`agentctl bootstrap\` for a repository that had no test suite.
// It proves that every source file still parses. It does NOT prove the code
// is correct — replace it with real tests as soon as there are any.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { spawnSync } from "node:child_process";

const SKIP = new Set([".git", "node_modules", "vendor", "dist", "build", "coverage", ".venv", "venv", ".next", ".agent"]);
const SOURCE = new Set([".js", ".mjs", ".cjs"]);

function sources(dir, acc = [], depth = 0) {
  if (depth > 8) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".agent") continue;
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sources(full, acc, depth + 1);
    else if (SOURCE.has(extname(entry.name))) acc.push(full);
  }
  return acc;
}

test("every source file parses", () => {
  const files = sources(process.cwd());

  // A gate with nothing to check is not a passing gate. Reporting success
  // over an empty file list is exactly the vacuous oracle this replaced.
  assert.ok(files.length > 0, "No JavaScript sources found to verify — this is not an oracle. Set verify.test in .agent/config.yml.");

  const broken = [];
  for (const file of files) {
    const res = spawnSync(process.execPath, ["--check", file], { encoding: "utf-8" });
    if (res.status !== 0) broken.push(\`\${file}: \${(res.stderr || "").trim().split("\\n")[0]}\`);
  }
  assert.deepEqual(broken, [], \`\${broken.length} file(s) failed to parse\`);
});
`;
  writeFileSync(smokePath, content, "utf-8");
  return ".agent/smoke.test.mjs";
}

export function detectEdgeRuntime(projectRoot = process.cwd()) {
  const isCloudflare = existsSync(join(projectRoot, "wrangler.toml")) || existsSync(join(projectRoot, "wrangler.json"));
  const isDeno = existsSync(join(projectRoot, "deno.json")) || existsSync(join(projectRoot, "deno.jsonc"));
  const isNetlify = existsSync(join(projectRoot, "netlify.toml"));

  let isPkgEdge = false;
  let pkgEdgePlatform = null;

  const pkgPath = join(projectRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const content = readFileSync(pkgPath, "utf-8");
      if (content.includes("@cloudflare/workers-types") || content.includes("@cloudflare/env")) {
        isPkgEdge = true;
        pkgEdgePlatform = "cloudflare";
      } else if (content.includes("@vercel/edge") || content.includes("@vercel/functions")) {
        isPkgEdge = true;
        pkgEdgePlatform = "vercel";
      } else if (content.includes("@netlify/edge-functions")) {
        isPkgEdge = true;
        pkgEdgePlatform = "netlify";
      }
    } catch (_) {}
  }

  const isEdge = isCloudflare || isDeno || isNetlify || isPkgEdge;
  const platform = isCloudflare ? "cloudflare" : isDeno ? "deno" : isNetlify ? "netlify" : pkgEdgePlatform;

  return {
    isEdgeRuntime: isEdge,
    edgePlatform: platform,
  };
}

/**
 * Detects 24+ polyglot stacks and container environments.
 */
/**
 * Test commands worth trying, best first, when the detected one does not run.
 *
 * `init` probes the command it picked. On a repository whose Makefile
 * declares a `test` target that needs a build environment the machine does
 * not have, that probe failed, printed `Oracle verification probe failed`,
 * and the wizard wrote the broken command into the config anyway — in a
 * repository where `pytest` was on PATH and all 360 tests passed in 1.3s.
 * Measuring something and then ignoring the measurement is worse than not
 * measuring: it produces a hard red on day one, which is how a user learns
 * the gate is broken and turns it off.
 *
 * Kept deliberately generic — a per-ecosystem convention, never a per-project
 * or per-provider guess.
 *
 * @param {string} root
 * @param {string} [detected] - the command detection chose; always first.
 * @returns {string[]} ordered, de-duplicated candidates
 */
export function oracleCandidates(root = process.cwd(), detected = "") {
  const out = [];
  const push = (c) => {
    const v = (c || "").trim();
    if (v && !out.includes(v) && !isPlaceholderTestScript(v)) out.push(v);
  };
  const has = (f) => existsSync(join(root, f));

  push(detected);

  if (has("package.json")) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
      if (pkg.scripts?.test && !isPlaceholderTestScript(pkg.scripts.test)) push("npm test");
    } catch (_) {}
  }
  if (has("pytest.ini") || has("pyproject.toml") || has("setup.py") || has("tox.ini") || has("setup.cfg")) {
    push(pytestCmd());
  }
  if (has("Cargo.toml")) push("cargo test");
  if (has("go.mod")) push("go test ./...");
  if (has("Gemfile")) push("bundle exec rspec");
  if (has("composer.json")) push("./vendor/bin/phpunit");
  if (has("pom.xml")) push("mvn -q test");
  if (has("build.gradle") || has("build.gradle.kts")) push("./gradlew test");
  if (has("pubspec.yaml")) push("dart test");
  if (has("Package.swift")) push("swift test");

  return out;
}

export function detectPolyglotStack(projectRoot = process.cwd()) {
  const edgeInfo = detectEdgeRuntime(projectRoot);
  const isDevcontainer = existsSync(join(projectRoot, ".devcontainer", "devcontainer.json"));
  const isCompose =
    existsSync(join(projectRoot, "docker-compose.yml")) ||
    existsSync(join(projectRoot, "docker-compose.yaml")) ||
    existsSync(join(projectRoot, "compose.yml")) ||
    existsSync(join(projectRoot, "compose.yaml"));

  const container = {
    ...edgeInfo,
    containerized: isDevcontainer || isCompose,
    containerType: isDevcontainer ? "devcontainer" : isCompose ? "docker-compose" : null,
    containerCmd: isDevcontainer
      ? "devcontainer exec --workspace-folder ."
      : isCompose
      ? "docker compose exec -T app"
      : "",
  };

  // 1. Turborepo / pnpm / Nx Monorepo workspaces
  if (existsSync(join(projectRoot, "turbo.json"))) {
    return { ...container, stack: "turbo", testCmd: "npx turbo run test", buildCmd: "npx turbo run build", triggerFile: "turbo.json" };
  }
  if (existsSync(join(projectRoot, "pnpm-workspace.yaml"))) {
    return { ...container, stack: "pnpm", testCmd: "pnpm -r test", buildCmd: "pnpm -r build", triggerFile: "pnpm-workspace.yaml" };
  }
  if (existsSync(join(projectRoot, "nx.json"))) {
    return { ...container, stack: "nx", testCmd: "npx nx run-many -t test", buildCmd: "npx nx run-many -t build", triggerFile: "nx.json" };
  }

  // 2. PHP / Laravel / WordPress
  if (existsSync(join(projectRoot, "artisan"))) {
    const hasPest = existsSync(join(projectRoot, "pest.php")) || existsSync(join(projectRoot, "vendor", "bin", "pest"));
    const testCmd = hasPest ? "./vendor/bin/pest" : "./vendor/bin/phpunit";
    return { ...container, stack: "laravel", testCmd, buildCmd: "composer dump-autoload", triggerFile: "artisan" };
  }
  if (existsSync(join(projectRoot, "wp-cli.yml")) || existsSync(join(projectRoot, "wp-config.php"))) {
    return { ...container, stack: "wordpress", testCmd: "./vendor/bin/phpunit", buildCmd: "wp dist-archive", triggerFile: existsSync(join(projectRoot, "wp-cli.yml")) ? "wp-cli.yml" : "wp-config.php" };
  }
  if (existsSync(join(projectRoot, "composer.json")) || existsSync(join(projectRoot, "phpunit.xml")) || existsSync(join(projectRoot, "pest.php"))) {
    let testCmd = "./vendor/bin/phpunit";
    if (existsSync(join(projectRoot, "pest.php")) || existsSync(join(projectRoot, "vendor", "bin", "pest"))) {
      testCmd = "./vendor/bin/pest";
    } else if (existsSync(join(projectRoot, "composer.json"))) {
      try {
        const composer = JSON.parse(readFileSync(join(projectRoot, "composer.json"), "utf-8"));
        if (composer.scripts && composer.scripts.test) {
          testCmd = "composer test";
        }
      } catch (_) {}
    }
    const triggerFile = existsSync(join(projectRoot, "composer.json")) ? "composer.json" : existsSync(join(projectRoot, "pest.php")) ? "pest.php" : "phpunit.xml";
    return { ...container, stack: "php", testCmd, buildCmd: "composer dump-autoload", triggerFile };
  }

  // 3. Mobile & Cross-Platform (pubspec.yaml, Package.swift, app.json)
  if (existsSync(join(projectRoot, "pubspec.yaml"))) {
    let isFlutter = false;
    try {
      const content = readFileSync(join(projectRoot, "pubspec.yaml"), "utf-8");
      if (content.includes("flutter:") || content.includes("sdk: flutter")) {
        isFlutter = true;
      }
    } catch (_) {}
    if (isFlutter) {
      return { ...container, stack: "flutter", testCmd: "flutter test", buildCmd: "flutter build apk --debug", triggerFile: "pubspec.yaml" };
    }
    return { ...container, stack: "dart", testCmd: "dart test", buildCmd: "dart compile exe bin/main.dart", triggerFile: "pubspec.yaml" };
  }
  if (existsSync(join(projectRoot, "Package.swift"))) {
    return { ...container, stack: "swift", testCmd: "swift test", buildCmd: "swift build", triggerFile: "Package.swift" };
  }
  // `app.json` is not a manifest, it is an Expo/React Native *configuration*
  // file, and the name is generic enough that unrelated projects use it. Its
  // test command is `npm test`, so without a package.json beside it the
  // detector was claiming a Node stack for a repository that has no Node in
  // it: `Cargo.toml` + `app.json` was measured as `react-native` / `npm test`.
  if (
    (existsSync(join(projectRoot, "app.json")) && existsSync(join(projectRoot, "package.json"))) ||
    existsSync(join(projectRoot, "react-native.config.js"))
  ) {
    const triggerFile = existsSync(join(projectRoot, "app.json")) ? "app.json" : "react-native.config.js";
    return { ...container, stack: "react-native", testCmd: "npm test", buildCmd: "npx react-native bundle --platform android --dev false --entry-file index.js --bundle-output android/main.jsbundle", triggerFile };
  }

  // 4. Systems & C/C++ / Rust / Go / Make
  if (existsSync(join(projectRoot, "CMakeLists.txt"))) {
    return { ...container, stack: "cmake", testCmd: "ctest --test-dir build --output-on-failure", buildCmd: "cmake --build build", triggerFile: "CMakeLists.txt" };
  }
  if (existsSync(join(projectRoot, "Cargo.toml"))) {
    return { ...container, stack: "cargo", testCmd: "cargo test --workspace", buildCmd: "cargo build", triggerFile: "Cargo.toml" };
  }
  if (existsSync(join(projectRoot, "go.mod"))) {
    return { ...container, stack: "go", testCmd: "go test ./...", buildCmd: "go build ./...", triggerFile: "go.mod" };
  }
  // A Makefile is only an oracle if it declares the target we are about to
  // run. `make test` on a Makefile with only a `build:` target exits 2 with
  // "No rule to make target 'test'" — measured on a repository whose
  // package.json declared a perfectly good `vitest run`, because the Makefile
  // was checked first and the presence of the *file* was the whole test. A
  // hard red on day one is how a user learns the gate is broken and turns it
  // off, so the file must earn the claim.
  if (existsSync(join(projectRoot, "Makefile")) && makefileHasTestTarget(projectRoot)) {
    return { ...container, stack: "make", testCmd: "make test", buildCmd: "make build", triggerFile: "Makefile" };
  }

  // 4b. Web3 / Solidity / Foundry & Hardhat
  if (existsSync(join(projectRoot, "foundry.toml")) || existsSync(join(projectRoot, "remappings.txt"))) {
    const triggerFile = existsSync(join(projectRoot, "foundry.toml")) ? "foundry.toml" : "remappings.txt";
    return {
      ...container,
      stack: "foundry",
      testCmd: "forge test --offline",
      buildCmd: "forge build --offline",
      fmtCmd: "forge fmt --check",
      fuzzCmd: "forge test --offline --match-test testFuzz",
      invariantCmd: "forge test --offline --match-test invariant",
      triggerFile,
    };
  }
  if (existsSync(join(projectRoot, "hardhat.config.js")) || existsSync(join(projectRoot, "hardhat.config.ts"))) {
    const triggerFile = existsSync(join(projectRoot, "hardhat.config.ts")) ? "hardhat.config.ts" : "hardhat.config.js";
    return {
      ...container,
      stack: "hardhat",
      testCmd: "npx hardhat test",
      buildCmd: "npx hardhat compile",
      triggerFile,
    };
  }

  // 5. Python / Django / Elixir / Ruby / Java
  if (existsSync(join(projectRoot, "manage.py"))) {
    return { ...container, stack: "django", testCmd: "python manage.py test --keepdb", buildCmd: "python manage.py check", triggerFile: "manage.py" };
  }
  if (existsSync(join(projectRoot, "pyproject.toml")) || existsSync(join(projectRoot, "requirements.txt")) || existsSync(join(projectRoot, "setup.py"))) {
    const triggerFile = existsSync(join(projectRoot, "pyproject.toml")) ? "pyproject.toml" : existsSync(join(projectRoot, "requirements.txt")) ? "requirements.txt" : "setup.py";
    return { ...container, stack: "python", testCmd: pytestCmd(), buildCmd: `${pythonBin()} -m compileall -q .`, triggerFile };
  }
  if (existsSync(join(projectRoot, "mix.exs"))) {
    return { ...container, stack: "mix", testCmd: "mix test", buildCmd: "mix compile", triggerFile: "mix.exs" };
  }
  if (existsSync(join(projectRoot, "Gemfile"))) {
    return { ...container, stack: "bundler", testCmd: "bundle exec rake test", buildCmd: "bundle exec rake build", triggerFile: "Gemfile" };
  }
  if (existsSync(join(projectRoot, "pom.xml"))) {
    return { ...container, stack: "maven", testCmd: "mvn test", buildCmd: "mvn compile", triggerFile: "pom.xml" };
  }
  if (existsSync(join(projectRoot, "build.gradle")) || existsSync(join(projectRoot, "build.gradle.kts"))) {
    const triggerFile = existsSync(join(projectRoot, "build.gradle")) ? "build.gradle" : "build.gradle.kts";
    return { ...container, stack: "gradle", testCmd: "./gradlew test", buildCmd: "./gradlew assemble", triggerFile };
  }

  // 6. JS / TS Runtimes & ORMs (Prisma, Drizzle)
  let setupCmd = "";
  if (existsSync(join(projectRoot, "prisma", "schema.prisma"))) {
    setupCmd = "npx prisma db push --schema=prisma/schema.prisma";
  } else if (existsSync(join(projectRoot, "drizzle.config.ts")) || existsSync(join(projectRoot, "drizzle.config.js"))) {
    setupCmd = "npx drizzle-kit push";
  }

  if (existsSync(join(projectRoot, "bunfig.toml")) || existsSync(join(projectRoot, "bun.lockb")) || existsSync(join(projectRoot, "bun.lock"))) {
    const triggerFile = existsSync(join(projectRoot, "bunfig.toml"))
      ? "bunfig.toml"
      : existsSync(join(projectRoot, "bun.lockb"))
      ? "bun.lockb"
      : "bun.lock";
    return { ...container, stack: "bun", setupCmd, testCmd: "bun test", buildCmd: "bun run build", triggerFile };
  }
  if (existsSync(join(projectRoot, "deno.json")) || existsSync(join(projectRoot, "deno.jsonc"))) {
    const triggerFile = existsSync(join(projectRoot, "deno.json")) ? "deno.json" : "deno.jsonc";
    return { ...container, stack: "deno", setupCmd, testCmd: "deno test", buildCmd: "deno task build", triggerFile };
  }
  if (existsSync(join(projectRoot, "package.json"))) {
    const hasPnpm = existsSync(join(projectRoot, "pnpm-lock.yaml"));
    const hasYarn = existsSync(join(projectRoot, "yarn.lock"));
    const hasBun = existsSync(join(projectRoot, "bun.lock")) || existsSync(join(projectRoot, "bun.lockb"));
    const pm = hasPnpm ? "pnpm" : hasYarn ? "yarn" : hasBun ? "bun" : "npm";
    const triggerFile = hasPnpm
      ? "pnpm-lock.yaml"
      : hasYarn
      ? "yarn.lock"
      : hasBun
      ? (existsSync(join(projectRoot, "bun.lock")) ? "bun.lock" : "bun.lockb")
      : "package.json";

    let testScript = "";
    let buildScript = "";
    try {
      const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8"));
      if (pkg && typeof pkg === "object") {
        const scripts = pkg.scripts || {};
        if (scripts.test) {
          testScript = pm === "yarn" ? "yarn test" : `${pm} test`;
        } else if (pm === "bun") {
          testScript = "bun test";
        }
        if (scripts.build) {
          buildScript = pm === "yarn" ? "yarn build" : `${pm} run build`;
        }
      }
    } catch (_) {
      testScript = "";
      buildScript = "";
    }
    return { ...container, stack: pm === "npm" ? "node" : pm, setupCmd, testCmd: testScript, buildCmd: buildScript, triggerFile };
  }

  // 7. .NET / C# / F# / PHP / Python root file extension fallback
  try {
    const rootFiles = readdirSync(projectRoot);
    const slnFile = rootFiles.find((f) => f.endsWith(".sln") || f.endsWith(".csproj") || f.endsWith(".fsproj"));
    if (slnFile) {
      return { ...container, stack: "dotnet", testCmd: "dotnet test --no-restore --nologo", buildCmd: "dotnet build --no-incremental --nologo", triggerFile: slnFile };
    }
    const phpFile = rootFiles.find((f) => f.endsWith(".php"));
    if (phpFile) {
      return { ...container, stack: "php", testCmd: 'php -l $(find . -name "*.php" -not -path "./vendor/*" -not -path "./node_modules/*")', buildCmd: "composer dump-autoload", triggerFile: phpFile };
    }
    const pyFile = rootFiles.find((f) => f.endsWith(".py"));
    if (pyFile) {
      return { ...container, stack: "python", testCmd: pytestCmd(), buildCmd: `${pythonBin()} -m compileall -q .`, triggerFile: pyFile };
    }
  } catch (_) {}

  return { ...container, stack: "unknown", testCmd: "", buildCmd: "", triggerFile: null };
}

/**
 * Normalizes file paths to POSIX slashes.
 */
function toPosixPath(p = "") {
  return p.replace(/\\/g, "/");
}

/**
 * Finds the nearest subproject root directory for a given relative file path.
 */
export function findSubprojectRoot(fileRelPath = "", root = process.cwd()) {
  const normalized = toPosixPath(fileRelPath);
  const parts = normalized.split("/");
  if (parts.length <= 1) return ".";

  const manifestFiles = [
    "package.json",
    "foundry.toml",
    "hardhat.config.js",
    "hardhat.config.ts",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "setup.py",
    "requirements.txt",
    "composer.json",
    "pom.xml",
    "build.gradle",
  ];

  // Walk up from parent directory of file to top-level folder
  for (let i = parts.length - 1; i >= 1; i--) {
    const candidateDir = parts.slice(0, i).join("/");
    const fullCandidate = join(root, candidateDir);
    if (existsSync(fullCandidate)) {
      try {
        const entries = readdirSync(fullCandidate);
        const hasManifest = entries.some(
          (e) => manifestFiles.includes(e) || e.endsWith(".csproj") || e.endsWith(".fsproj")
        );
        if (hasManifest) {
          return candidateDir;
        }
      } catch (_) {}
    }
  }

  return ".";
}

/**
 * Detects illegal cross-package imports escaping subproject boundaries in monorepos.
 */
export function detectCrossPackageBoundaryViolations(changedFiles = [], root = process.cwd(), options = {}) {
  const violations = [];
  if (!changedFiles || changedFiles.length === 0) return violations;

  const fileContents = options.fileContents || {};

  // Regex patterns for relative imports across languages
  const jsImportRegex = /(?:import\s+(?:[\w*\s{},]*\s+from\s+)?|export\s+(?:[\w*\s{},]*\s+from\s+)?|require\s*\(\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g;
  const goImportRegex = /(?:^|\n)\s*(?:import\s+['"](\.[^'"]+)['"]|import\s*\([\s\S]*?['"](\.[^'"]+)['"][\s\S]*?\))/g;
  const rustPathRegex = /#\[path\s*=\s*['"](\.[^'"]+)['"]\]/g;
  const pyRelImportRegex = /(?:^|\n)\s*from\s+(\.{2,}\w*)\s+import/g;

  for (const file of changedFiles) {
    const posixFile = toPosixPath(file);
    let content = fileContents[file] || fileContents[posixFile];

    if (!content) {
      const fullPath = join(root, file);
      if (existsSync(fullPath)) {
        try {
          content = readFileSync(fullPath, "utf-8");
        } catch (_) {}
      }
    }

    if (!content || typeof content !== "string") continue;

    const subproject = findSubprojectRoot(posixFile, root);
    if (subproject === "." && !options.enforceRootBoundary) {
      continue;
    }

    const fileDir = posixFile.includes("/") ? posixFile.substring(0, posixFile.lastIndexOf("/")) : ".";
    const ext = posixFile.includes(".") ? posixFile.substring(posixFile.lastIndexOf(".")).toLowerCase() : "";
    const isJsTs = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".svelte", ".vue"].includes(ext) || !ext;
    const isGo = ext === ".go";
    const isRust = ext === ".rs";
    const isPython = ext === ".py";

    const lines = content.split("\n");

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];

      // 1. JS / TS imports
      if (isJsTs) {
        let match;
        jsImportRegex.lastIndex = 0;
        while ((match = jsImportRegex.exec(line)) !== null) {
          const relTarget = match[1];
          if (relTarget.startsWith("..")) {
            const resolved = toPosixPath(join(fileDir, relTarget));
            const relToSubproject = toPosixPath(relative(subproject, resolved));
            if (relToSubproject.startsWith("..") || resolved === "." || (subproject !== "." && !resolved.startsWith(subproject + "/"))) {
              violations.push({
                file: posixFile,
                subproject,
                importTarget: relTarget,
                resolvedTarget: resolved,
                line: lineIdx + 1,
                language: "javascript/typescript",
                reason: `Cross-Package Boundary Violation: File "${posixFile}" in package "${subproject}" illegally imports "${relTarget}" (resolves to "${resolved}"), escaping its package boundary. Declare a workspace dependency instead of a relative cross-package file import.`,
              });
            }
          }
        }
      }

      // 2. Go relative imports escaping module
      if (isGo) {
        let match;
        goImportRegex.lastIndex = 0;
        while ((match = goImportRegex.exec(line)) !== null) {
          const relTarget = match[1] || match[2];
          if (relTarget && relTarget.startsWith("..")) {
            const resolved = toPosixPath(join(fileDir, relTarget));
            const relToSubproject = toPosixPath(relative(subproject, resolved));
            if (relToSubproject.startsWith("..")) {
              violations.push({
                file: posixFile,
                subproject,
                importTarget: relTarget,
                resolvedTarget: resolved,
                line: lineIdx + 1,
                language: "go",
                reason: `Cross-Module Boundary Violation: Go file "${posixFile}" in module "${subproject}" illegally imports relative path "${relTarget}" escaping module root.`,
              });
            }
          }
        }
      }

      // 3. Rust path attributes escaping crate
      if (isRust) {
        let match;
        rustPathRegex.lastIndex = 0;
        while ((match = rustPathRegex.exec(line)) !== null) {
          const relTarget = match[1];
          if (relTarget && relTarget.startsWith("..")) {
            const resolved = toPosixPath(join(fileDir, relTarget));
            const relToSubproject = toPosixPath(relative(subproject, resolved));
            if (relToSubproject.startsWith("..")) {
              violations.push({
                file: posixFile,
                subproject,
                importTarget: relTarget,
                resolvedTarget: resolved,
                line: lineIdx + 1,
                language: "rust",
                reason: `Cross-Crate Boundary Violation: Rust file "${posixFile}" in crate "${subproject}" uses path attribute "${relTarget}" escaping crate root.`,
              });
            }
          }
        }
      }

      // 4. Python relative imports escaping package
      if (isPython) {
        let match;
        pyRelImportRegex.lastIndex = 0;
        while ((match = pyRelImportRegex.exec(line)) !== null) {
          const dots = match[1];
          const dotCount = (dots.match(/\./g) || []).length;
          // Count depth from subproject to fileDir
          const depth = fileDir === subproject ? 0 : fileDir.slice(subproject.length + 1).split("/").length;
          if (dotCount > depth + 1) {
            violations.push({
              file: posixFile,
              subproject,
              importTarget: dots,
              resolvedTarget: "<parent-package>",
              line: lineIdx + 1,
              language: "python",
              reason: `Cross-Package Boundary Violation: Python file "${posixFile}" in package "${subproject}" uses relative import with ${dotCount} dots, escaping package root.`,
            });
          }
        }
      }
    }
  }

  return violations;
}

/**
 * Discovers monorepo packages and detects circular dependencies.
 */
export function detectCircularDependencies(root = process.cwd()) {
  const packageMap = new Map(); // name -> { path, deps: [] }
  const searchDirs = ["packages", "apps", "crates", "services", "libs", "modules", "backend", "frontend", "cli", "."];

  for (const dir of searchDirs) {
    const fullDir = join(root, dir);
    if (!existsSync(fullDir)) continue;

    const subDirs = dir === "." ? ["."] : [];
    try {
      if (dir !== ".") {
        const entries = readdirSync(fullDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) subDirs.push(`${dir}/${e.name}`);
        }
      }
    } catch (_) {}

    for (const subDir of subDirs) {
      const fullSubDir = join(root, subDir);
      // 1. JS/TS package.json
      const pkgJsonPath = join(fullSubDir, "package.json");
      if (existsSync(pkgJsonPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
          if (pkg.name) {
            const allDeps = {
              ...(pkg.dependencies || {}),
              ...(pkg.devDependencies || {}),
              ...(pkg.peerDependencies || {}),
            };
            packageMap.set(pkg.name, {
              name: pkg.name,
              path: subDir,
              type: "npm",
              deps: Object.keys(allDeps),
            });
          }
        } catch (_) {}
      }

      // 2. Rust Cargo.toml
      const cargoPath = join(fullSubDir, "Cargo.toml");
      if (existsSync(cargoPath)) {
        try {
          const content = readFileSync(cargoPath, "utf-8");
          const nameMatch = content.match(/\[package\][\s\S]*?name\s*=\s*["']([^"']+)["']/);
          if (nameMatch) {
            const crateName = nameMatch[1];
            const deps = [];
            const depMatches = content.matchAll(/([a-zA-Z0-9_-]+)\s*=\s*\{[^}]*?path\s*=\s*["']([^"']+)["']/g);
            for (const dm of depMatches) {
              deps.push(dm[1]);
            }
            packageMap.set(crateName, {
              name: crateName,
              path: subDir,
              type: "cargo",
              deps,
            });
          }
        } catch (_) {}
      }
    }
  }

  // Filter dependencies to only workspace internal packages
  const knownNames = new Set(packageMap.keys());
  const graph = new Map();
  for (const [name, info] of packageMap.entries()) {
    graph.set(name, info.deps.filter((d) => knownNames.has(d)));
  }

  // Cycle detection via DFS
  const cycles = [];
  const visited = new Set();
  const recStack = new Set();
  const path = [];

  function dfs(node) {
    visited.add(node);
    recStack.add(node);
    path.push(node);

    const neighbors = graph.get(node) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        dfs(neighbor);
      } else if (recStack.has(neighbor)) {
        const cycleStartIndex = path.indexOf(neighbor);
        const cycle = path.slice(cycleStartIndex).concat(neighbor);
        cycles.push(cycle.join(" -> "));
      }
    }

    path.pop();
    recStack.delete(node);
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      dfs(node);
    }
  }

  return {
    hasCycles: cycles.length > 0,
    cycles,
    packages: Array.from(packageMap.values()),
  };
}

/**
 * Resolves workspace boundaries in polyglot monorepos by mapping changed files to subprojects.
 */
export function resolveWorkspaceBoundary(changedFiles = [], root = process.cwd(), options = {}) {
  const rootStack = detectPolyglotStack(root);
  const boundaryViolations = detectCrossPackageBoundaryViolations(changedFiles, root, options);
  const circular = detectCircularDependencies(root);

  if (!changedFiles || changedFiles.length === 0) {
    return {
      isMonorepo: circular.packages.length > 1,
      globalFallback: false,
      projects: [{ path: ".", ...rootStack }],
      testCmd: rootStack.testCmd,
      buildCmd: rootStack.buildCmd,
      boundaryViolations,
      circularDependencies: circular.cycles,
    };
  }

  const sharedTriggers = new Set(["openapi.yaml", "openapi.json", "schema.graphql", "docker-compose.yml", "Makefile", "turbo.json", "pnpm-workspace.yaml", "nx.json"]);
  for (const file of changedFiles) {
    const baseName = toPosixPath(file).split("/").pop();
    if (sharedTriggers.has(baseName) || file.startsWith(".agent/") || file.startsWith(".github/")) {
      return {
        isMonorepo: true,
        globalFallback: true,
        projects: [{ path: ".", ...rootStack }],
        testCmd: rootStack.testCmd,
        buildCmd: rootStack.buildCmd,
        boundaryViolations,
        circularDependencies: circular.cycles,
      };
    }
  }

  const projectMap = new Map();
  for (const file of changedFiles) {
    const subDir = findSubprojectRoot(file, root);
    if (subDir !== ".") {
      const subStack = detectPolyglotStack(join(root, subDir));
      if (!projectMap.has(subDir)) {
        projectMap.set(subDir, { path: subDir, ...subStack });
      }
    } else {
      if (!projectMap.has(".")) {
        projectMap.set(".", { path: ".", ...rootStack });
      }
    }
  }

  const projects = Array.from(projectMap.values());
  const testCmds = projects
    .filter((p) => p.testCmd)
    .map((p) => (p.path === "." ? p.testCmd : `(cd ${p.path} && ${p.testCmd})`));
  const buildCmds = projects
    .filter((p) => p.buildCmd)
    .map((p) => (p.path === "." ? p.buildCmd : `(cd ${p.path} && ${p.buildCmd})`));

  return {
    isMonorepo: projects.length > 1 || circular.packages.length > 1,
    globalFallback: false,
    projects,
    testCmd: testCmds.join(" && ") || rootStack.testCmd,
    buildCmd: buildCmds.join(" && ") || rootStack.buildCmd,
    boundaryViolations,
    circularDependencies: circular.cycles,
  };
}

export function bootstrapZeroTestRepo(root = process.cwd(), options = {}) {
  const detected = detectPolyglotStack(root);
  const configPath = join(root, ".agent", "config.yml");
  const hasConfig = existsSync(configPath);
  let existingTestCmd = "";
  if (hasConfig) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const match = raw.match(/^\s*test:\s*["']?(.*?)["']?\s*$/m) || raw.match(/^\s*test_cmd:\s*["']?(.*?)["']?\s*$/m);
      if (match) {
        existingTestCmd = match[1].trim();
      }
    } catch (_) {}
  }

  let hasPkgTest = false;
  if (existsSync(join(root, "package.json"))) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
      hasPkgTest = Boolean(pkg?.scripts?.test) && !isPlaceholderTestScript(pkg.scripts.test);
    } catch (_) {}
  }

  const hasRealTestSuite =
    (hasConfig && Boolean(existingTestCmd)) ||
    hasPkgTest ||
    existsSync(join(root, "phpunit.xml")) ||
    existsSync(join(root, "pest.php")) ||
    existsSync(join(root, "turbo.json")) ||
    existsSync(join(root, "pnpm-workspace.yaml")) ||
    existsSync(join(root, "nx.json"));

  if (!options.force && hasRealTestSuite) {
    return { bootstrapped: false, reason: "EXISTING_VERIFICATION_ORACLE", testCmd: existingTestCmd || (hasPkgTest ? detected.testCmd : "") };
  }

  let testCmd = "";
  if (detected.stack === "php" || detected.stack === "laravel" || detected.stack === "wordpress") {
    testCmd = 'php -l $(find . -name "*.php" -not -path "./vendor/*" -not -path "./node_modules/*")';
  } else if (detected.stack === "python") {
    testCmd = `${pythonBin()} -m compileall -q -x '^\\./(\\.\\venv|venv|node_modules|\\.git)/' .`;
  } else if (detected.stack === "dotnet") {
    testCmd = "dotnet build --no-incremental --nologo";
  } else if (detected.stack === "cargo") {
    testCmd = "cargo check --workspace --all-targets";
  } else if (detected.stack === "go") {
    testCmd = "go vet ./...";
  } else if (existsSync(join(root, "tsconfig.json"))) {
    testCmd = "npx tsc --noEmit";
  } else {
    const smokePath = generateSmokeTestScript(root);
    testCmd = `node --test ${smokePath}`;
  }

  try {
    mkdirSync(join(root, ".agent"), { recursive: true });
  } catch (_) {}

  if (hasConfig) {
    try {
      let rawConfig = readFileSync(configPath, "utf-8");
      if (/^\s*test:\s*.*$/m.test(rawConfig)) {
        rawConfig = rawConfig.replace(/^\s*test:\s*.*$/m, `  test: "${testCmd}"`);
      } else if (/^\s*verify:\s*$/m.test(rawConfig)) {
        rawConfig = rawConfig.replace(/^\s*verify:\s*$/m, `verify:\n  test: "${testCmd}"`);
      } else {
        rawConfig += `\nverify:\n  test: "${testCmd}"\n`;
      }
      if (detected.buildCmd && /^\s*build:\s*["']?["']?\s*$/m.test(rawConfig)) {
        rawConfig = rawConfig.replace(/^\s*build:\s*.*$/m, `  build: "${detected.buildCmd}"`);
      }
      writeFileSync(configPath, rawConfig, "utf-8");
    } catch (_) {}
  } else {
    const cfg = `version: 1\nprovider: jules\ntier: free\nverify:\n  test: "${testCmd}"\n  build: "${detected.buildCmd || ""}"\nlimits:\n  diff_kb: 75\n  daily_tasks: 15\n  repair_attempts: 3\nbranch_prefix: agent/\nbase_branch: main\n`;
    writeFileSync(configPath, cfg, "utf-8");
  }

  const julesPath = join(root, ".agent", "jules.yml");
  if (existsSync(julesPath)) {
    try {
      let rawJules = readFileSync(julesPath, "utf-8");
      if (/^\s*test_cmd:\s*.*$/m.test(rawJules)) {
        rawJules = rawJules.replace(/^\s*test_cmd:\s*.*$/m, `test_cmd: "${testCmd}"`);
      } else {
        rawJules += `\ntest_cmd: "${testCmd}"\n`;
      }
      if (detected.buildCmd && /^\s*build_cmd:\s*["']?["']?\s*$/m.test(rawJules)) {
        rawJules = rawJules.replace(/^\s*build_cmd:\s*.*$/m, `build_cmd: "${detected.buildCmd}"`);
      }
      writeFileSync(julesPath, rawJules, "utf-8");
    } catch (_) {}
  }

  return { bootstrapped: true, stack: detected.stack, testCmd, configPath };
}
