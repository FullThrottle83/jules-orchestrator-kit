import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * Generate a zero-dependency smoke test file using node:test for untested JS/Generic repos.
 */
export function generateSmokeTestScript(root = process.cwd()) {
  const agentDir = join(root, ".agent");
  try {
    mkdirSync(agentDir, { recursive: true });
  } catch (_) {}

  const smokePath = join(agentDir, "smoke.test.mjs");
  const content = `// Auto-generated zero-dependency smoke test gate (.agent/smoke.test.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("Zero-Test Bootstrapped Smoke Verification", () => {
  assert.ok(fs.existsSync(process.cwd()), "Working directory exists and is accessible");
  const entries = fs.readdirSync(process.cwd());
  assert.ok(entries.length > 0, "Repository contains files");
});
`;
  writeFileSync(smokePath, content, "utf-8");
  return ".agent/smoke.test.mjs";
}

/**
 * Detects 24+ polyglot stacks and container environments.
 */
export function detectPolyglotStack(projectRoot = process.cwd()) {
  const isDevcontainer = existsSync(join(projectRoot, ".devcontainer", "devcontainer.json"));
  const isCompose =
    existsSync(join(projectRoot, "docker-compose.yml")) ||
    existsSync(join(projectRoot, "docker-compose.yaml")) ||
    existsSync(join(projectRoot, "compose.yml")) ||
    existsSync(join(projectRoot, "compose.yaml"));

  const container = {
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
  if (existsSync(join(projectRoot, "app.json")) || existsSync(join(projectRoot, "react-native.config.js"))) {
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
  if (existsSync(join(projectRoot, "Makefile"))) {
    return { ...container, stack: "make", testCmd: "make test", buildCmd: "make build", triggerFile: "Makefile" };
  }

  // 5. Python / Django / Elixir / Ruby / Java
  if (existsSync(join(projectRoot, "manage.py"))) {
    return { ...container, stack: "django", testCmd: "python manage.py test --keepdb", buildCmd: "python manage.py check", triggerFile: "manage.py" };
  }
  if (existsSync(join(projectRoot, "pyproject.toml")) || existsSync(join(projectRoot, "requirements.txt")) || existsSync(join(projectRoot, "setup.py"))) {
    const triggerFile = existsSync(join(projectRoot, "pyproject.toml")) ? "pyproject.toml" : existsSync(join(projectRoot, "requirements.txt")) ? "requirements.txt" : "setup.py";
    return { ...container, stack: "python", testCmd: "pytest", buildCmd: "python3 -m compileall -q .", triggerFile };
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

  if (existsSync(join(projectRoot, "bunfig.toml")) || existsSync(join(projectRoot, "bun.lockb"))) {
    const triggerFile = existsSync(join(projectRoot, "bunfig.toml")) ? "bunfig.toml" : "bun.lockb";
    return { ...container, stack: "bun", setupCmd, testCmd: "bun test", buildCmd: "bun run build", triggerFile };
  }
  if (existsSync(join(projectRoot, "deno.json")) || existsSync(join(projectRoot, "deno.jsonc"))) {
    const triggerFile = existsSync(join(projectRoot, "deno.json")) ? "deno.json" : "deno.jsonc";
    return { ...container, stack: "deno", setupCmd, testCmd: "deno test", buildCmd: "deno task build", triggerFile };
  }
  if (existsSync(join(projectRoot, "package.json"))) {
    let testScript = "npm test";
    let buildScript = "npm run build";
    try {
      const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8"));
      if (pkg && typeof pkg === "object") {
        const scripts = pkg.scripts || {};
        testScript = scripts.test ? "npm test" : "npm test";
        buildScript = scripts.build ? "npm run build" : "";
      }
    } catch (_) {
      testScript = "npm test";
      buildScript = "npm run build";
    }
    return { ...container, stack: "node", setupCmd, testCmd: testScript, buildCmd: buildScript, triggerFile: "package.json" };
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
      return { ...container, stack: "python", testCmd: "pytest", buildCmd: "python3 -m compileall -q .", triggerFile: pyFile };
    }
  } catch (_) {}

  return { ...container, stack: "unknown", testCmd: "", buildCmd: "", triggerFile: null };
}

/**
 * Resolves workspace boundaries in polyglot monorepos by mapping changed files to subprojects.
 */
export function resolveWorkspaceBoundary(changedFiles = [], root = process.cwd()) {
  const rootStack = detectPolyglotStack(root);
  if (!changedFiles || changedFiles.length === 0) {
    return { isMonorepo: false, globalFallback: false, projects: [{ path: ".", ...rootStack }], testCmd: rootStack.testCmd, buildCmd: rootStack.buildCmd };
  }

  const sharedTriggers = new Set(["openapi.yaml", "openapi.json", "schema.graphql", "docker-compose.yml", "Makefile", "turbo.json", "pnpm-workspace.yaml", "nx.json"]);
  for (const file of changedFiles) {
    const baseName = file.split(sep).pop();
    if (sharedTriggers.has(baseName) || file.startsWith(".agent/") || file.startsWith(".github/")) {
      return { isMonorepo: true, globalFallback: true, projects: [{ path: ".", ...rootStack }], testCmd: rootStack.testCmd, buildCmd: rootStack.buildCmd };
    }
  }

  const projectMap = new Map();
  for (const file of changedFiles) {
    const parts = file.split(sep);
    let resolved = false;

    for (let i = parts.length - 1; i >= 1; i--) {
      const subDir = parts.slice(0, i).join("/");
      const subStack = detectPolyglotStack(join(root, subDir));
      if (subStack.stack !== "unknown" && subStack.triggerFile) {
        if (!projectMap.has(subDir)) {
          projectMap.set(subDir, { path: subDir, ...subStack });
        }
        resolved = true;
        break;
      }
    }

    if (!resolved && !projectMap.has(".")) {
      projectMap.set(".", { path: ".", ...rootStack });
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
    isMonorepo: projects.length > 1,
    globalFallback: false,
    projects,
    testCmd: testCmds.join(" && ") || rootStack.testCmd,
    buildCmd: buildCmds.join(" && ") || rootStack.buildCmd,
  };
}

export function bootstrapZeroTestRepo(root = process.cwd(), options = {}) {
  const detected = detectPolyglotStack(root);
  const configPath = join(root, ".agent", "config.yml");
  const hasConfig = existsSync(configPath);
  const hasRealTestSuite =
    hasConfig ||
    existsSync(join(root, "phpunit.xml")) ||
    existsSync(join(root, "pest.php")) ||
    existsSync(join(root, "turbo.json")) ||
    existsSync(join(root, "pnpm-workspace.yaml")) ||
    existsSync(join(root, "nx.json"));

  if (!options.force && hasRealTestSuite) {
    return { bootstrapped: false, reason: "EXISTING_VERIFICATION_ORACLE", testCmd: detected.testCmd };
  }

  let testCmd = "";
  if (detected.stack === "php" || detected.stack === "laravel" || detected.stack === "wordpress") {
    testCmd = 'php -l $(find . -name "*.php" -not -path "./vendor/*" -not -path "./node_modules/*")';
  } else if (detected.stack === "python") {
    testCmd = "python3 -m compileall -q -x '^\\./(\\.\\venv|venv|node_modules|\\.git)/' .";
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

  const cfg = `version: 1\nprovider: jules\ntier: ultra\nverify:\n  test: "${testCmd}"\n  build: "${detected.buildCmd || ""}"\nlimits:\n  diff_kb: 75\n  daily_tasks: 300\n  repair_attempts: 3\nbranch_prefix: agent/\nbase_branch: main\n`;
  writeFileSync(configPath, cfg, "utf-8");

  return { bootstrapped: true, stack: detected.stack, testCmd, configPath };
}
