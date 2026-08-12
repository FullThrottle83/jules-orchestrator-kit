import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectPolyglotStack, resolveWorkspaceBoundary, bootstrapZeroTestRepo } from "../src/stack-detector.mjs";

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
    assert.equal(boundary.testCmd, "(cd backend && pytest)");

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
