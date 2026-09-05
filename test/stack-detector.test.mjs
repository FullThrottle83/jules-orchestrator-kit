import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectPolyglotStack, resolveWorkspaceBoundary, bootstrapZeroTestRepo, pytestCmd } from "../src/stack-detector.mjs";
import { parseYaml } from "../src/config.mjs";

test("detectPolyglotStack - detects PHP, .NET, Mobile, Systems, and Docker/Devcontainer stacks", () => {
  const tmp = mkdtempSync(join(tmpdir(), "stack-test-"));
  try {
    // 1. PHP / Laravel
    writeFileSync(join(tmp, "artisan"), "<?php");
    writeFileSync(join(tmp, "composer.json"), '{"name": "laravel/framework"}');
    let res = detectPolyglotStack(tmp);
    assert.equal(res.stack, "laravel");
    assert.ok(res.testCmd.includes("phpunit") || res.testCmd.includes("pest"));
    rmSync(join(tmp, "artisan"));
    rmSync(join(tmp, "composer.json"));

    // 2. .NET / C#
    writeFileSync(join(tmp, "App.csproj"), "<Project></Project>");
    res = detectPolyglotStack(tmp);
    assert.equal(res.stack, "dotnet");
    assert.equal(res.testCmd, "dotnet test --no-restore --nologo");
    rmSync(join(tmp, "App.csproj"));

    // 3. Flutter
    writeFileSync(join(tmp, "pubspec.yaml"), "name: app\nflutter:\n  uses-material-design: true\n");
    res = detectPolyglotStack(tmp);
    assert.equal(res.stack, "flutter");
    assert.equal(res.testCmd, "flutter test");
    rmSync(join(tmp, "pubspec.yaml"));

    // 4. CMake / C++
    writeFileSync(join(tmp, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.10)");
    res = detectPolyglotStack(tmp);
    assert.equal(res.stack, "cmake");
    assert.equal(res.testCmd, "ctest --test-dir build --output-on-failure");
    rmSync(join(tmp, "CMakeLists.txt"));

    // 5. Container & Devcontainer detection
    mkdirSync(join(tmp, ".devcontainer"), { recursive: true });
    writeFileSync(join(tmp, ".devcontainer", "devcontainer.json"), "{}");
    res = detectPolyglotStack(tmp);
    assert.equal(res.containerized, true);
    assert.equal(res.containerType, "devcontainer");
    assert.equal(res.containerCmd, "devcontainer exec --workspace-folder .");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveWorkspaceBoundary - maps changed files to subprojects and handles monorepo fallback", () => {
  const tmp = mkdtempSync(join(tmpdir(), "boundary-test-"));
  try {
    const backend = join(tmp, "backend");
    const frontend = join(tmp, "frontend");
    mkdirSync(backend, { recursive: true });
    mkdirSync(frontend, { recursive: true });

    writeFileSync(join(backend, "pyproject.toml"), "[tool.poetry]");
    writeFileSync(join(frontend, "package.json"), '{"name": "frontend", "scripts": {"test": "vitest"}}');

    // Single subproject changed
    let boundary = resolveWorkspaceBoundary(["backend/api/main.py"], tmp);
    assert.equal(boundary.isMonorepo, false);
    // Not the bare console script: run as a module, so the package under test
    // is importable from the working directory (see pytestCmd).
    assert.equal(boundary.testCmd, `(cd backend && ${pytestCmd()})`);

    // Multiple subprojects changed
    boundary = resolveWorkspaceBoundary(["backend/api/main.py", "frontend/src/App.tsx"], tmp);
    assert.equal(boundary.isMonorepo, true);
    assert.ok(boundary.testCmd.includes("pytest"));
    assert.ok(boundary.testCmd.includes("npm test"));

    // Shared contract file changed -> global fallback
    boundary = resolveWorkspaceBoundary(["openapi.yaml", "backend/api/main.py"], tmp);
    assert.equal(boundary.globalFallback, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("detectEdgeRuntime - detects wrangler configs and edge packages", () => {
  const tmp = mkdtempSync(join(tmpdir(), "edge-detect-test-"));
  try {
    writeFileSync(join(tmp, "wrangler.toml"), 'name = "worker"');
    let res = detectPolyglotStack(tmp);
    assert.equal(res.isEdgeRuntime, true);
    assert.equal(res.edgePlatform, "cloudflare");
    rmSync(join(tmp, "wrangler.toml"));

    writeFileSync(join(tmp, "package.json"), '{"devDependencies": {"@vercel/edge": "^1.0.0"}}');
    res = detectPolyglotStack(tmp);
    assert.equal(res.isEdgeRuntime, true);
    assert.equal(res.edgePlatform, "vercel");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bootstrapZeroTestRepo - generates verification oracle for zero-test repositories", () => {
  const tmp = mkdtempSync(join(tmpdir(), "bootstrap-test-"));
  try {
    writeFileSync(join(tmp, "index.php"), "<?php echo 'hello';");
    const res = bootstrapZeroTestRepo(tmp);

    assert.equal(res.bootstrapped, true);
    assert.equal(res.stack, "php");
    assert.ok(res.testCmd.includes("php -l"));
    assert.ok(existsSync(join(tmp, ".agent", "config.yml")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bootstrapZeroTestRepo - succeeds on existing config with empty verify.test and preserves tier", () => {
  const tmp = mkdtempSync(join(tmpdir(), "bootstrap-empty-oracle-"));
  try {
    mkdirSync(join(tmp, ".agent"), { recursive: true });
    const initialConfig = `version: 1\nprovider: jules\ntier: free\nlimits:\n  daily_tasks: 15\nverify:\n  test: ""\n  build: ""\n`;
    writeFileSync(join(tmp, ".agent", "config.yml"), initialConfig);
    // Something for the generated oracle to actually check. Without a source
    // file the smoke test asserts its own impossibility, which is now a
    // refusal rather than a config that deadlocks on its first run.
    writeFileSync(join(tmp, "index.mjs"), "export const add = (a, b) => a + b;\n");

    // First bootstrap without --force must succeed because verify.test is empty
    const res = bootstrapZeroTestRepo(tmp);
    assert.equal(res.bootstrapped, true);
    assert.ok(res.testCmd.includes(".agent/smoke.test.mjs"));

    // Verify config was updated in place and preserved tier: free
    const updated = readFileSync(join(tmp, ".agent", "config.yml"), "utf-8");
    assert.ok(updated.includes("tier: free"));
    assert.ok(updated.includes("daily_tasks: 15"));
    // Plain scalar: the emitter quotes only what YAML requires, so the file it
    // writes passes a repository's own YAML linter. Asserted through the parser
    // too, because the value surviving matters more than its spelling.
    assert.ok(updated.includes("test: node --test .agent/smoke.test.mjs"));
    assert.equal(parseYaml(updated).verify.test, "node --test .agent/smoke.test.mjs");

    // Second bootstrap without --force must be refused with EXISTING_VERIFICATION_ORACLE
    const res2 = bootstrapZeroTestRepo(tmp);
    assert.equal(res2.bootstrapped, false);
    assert.equal(res2.reason, "EXISTING_VERIFICATION_ORACLE");
    assert.equal(res2.testCmd, "node --test .agent/smoke.test.mjs");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("detectPolyglotStack - package manager lockfiles and missing scripts.test", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pm-test-"));
  try {
    // 1. package.json without scripts.test returns empty testCmd
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "no-tests", scripts: { build: "tsc" } }));
    let res = detectPolyglotStack(tmp);
    assert.equal(res.stack, "node");
    assert.equal(res.testCmd, "");
    assert.equal(res.buildCmd, "npm run build");

    // 2. pnpm-lock.yaml detection
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "pnpm-app", scripts: { test: "vitest", build: "vite build" } }));
    writeFileSync(join(tmp, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
    res = detectPolyglotStack(tmp);
    assert.equal(res.stack, "pnpm");
    assert.equal(res.testCmd, "pnpm test");
    assert.equal(res.buildCmd, "pnpm run build");
    rmSync(join(tmp, "pnpm-lock.yaml"));

    // 3. yarn.lock detection
    writeFileSync(join(tmp, "yarn.lock"), "# yarn lockfile v1");
    res = detectPolyglotStack(tmp);
    assert.equal(res.stack, "yarn");
    assert.equal(res.testCmd, "yarn test");
    assert.equal(res.buildCmd, "yarn build");
    rmSync(join(tmp, "yarn.lock"));

    // 4. bun.lock (modern text format)
    writeFileSync(join(tmp, "bun.lock"), "lockfileVersion: 1");
    res = detectPolyglotStack(tmp);
    assert.equal(res.stack, "bun");
    assert.equal(res.testCmd, "bun test");
    rmSync(join(tmp, "bun.lock"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});


test("bootstrapZeroTestRepo - declines when no oracle is possible", () => {
  // A CSS library, an icon set or a font package has a package.json and no
  // JavaScript at all. `bootstrap` wrote `node --test .agent/smoke.test.mjs`
  // into one anyway, and the next gate run died on the generated suite's own
  // assertion — the user followed the gate's repair advice into a dead end.
  const tmp = mkdtempSync(join(tmpdir(), "bootstrap-no-oracle-"));
  try {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "normalize.css", version: "8.0.1" }));
    writeFileSync(join(tmp, "normalize.css"), "html { line-height: 1.15; }\n");

    const res = bootstrapZeroTestRepo(tmp);
    assert.equal(res.bootstrapped, false);
    assert.equal(res.reason, "NO_ORACLE_POSSIBLE");
    assert.match(res.detail, /no JavaScript sources/);
    assert.equal(existsSync(join(tmp, ".agent", "smoke.test.mjs")), false, "and it wrote nothing that cannot pass");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
