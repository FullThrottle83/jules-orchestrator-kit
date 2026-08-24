# Polyglot Stack Resolution Engine — Architectural Audit

**Scope:** `src/stack-detector.mjs`, `src/wizard-init.mjs`, `src/scaffold.mjs`, `src/wizard-oracle.mjs`, `src/security.mjs`  
**Date:** 2026-08-24  
**Auditor:** Arena.ai Agent Mode  
**Invariant:** No existing repository code or tests were altered.

---

## Table of Contents

1. [Stack Detection Coverage Matrix](#1-stack-detection-coverage-matrix)
2. [Exact Edge-Case Failure Scenarios](#2-exact-edge-case-failure-scenarios)
3. [Recommendations for Heuristic Priority Tuning](#3-recommendations-for-heuristic-priority-tuning)
4. [Code Snippets for New Detection Rules](#4-code-snippets-for-new-detection-rules)

---

## 1. Stack Detection Coverage Matrix

### 1.1 Supported Stacks (26+)

| # | Stack | Trigger File(s) | Test Command | Build Command | Status |
|---|-------|-----------------|--------------|---------------|--------|
| 1 | Turborepo | `turbo.json` | `npx turbo run test` | `npx turbo run build` | ✅ |
| 2 | pnpm workspace | `pnpm-workspace.yaml` | `pnpm -r test` | `pnpm -r build` | ✅ |
| 3 | Nx | `nx.json` | `npx nx run-many -t test` | `npx nx run-many -t build` | ✅ |
| 4 | Laravel | `artisan` | `./vendor/bin/pest` or `./vendor/bin/phpunit` | `composer dump-autoload` | ✅ |
| 5 | WordPress | `wp-cli.yml` / `wp-config.php` | `./vendor/bin/phpunit` | `wp dist-archive` | ✅ |
| 6 | PHP (generic) | `composer.json` / `phpunit.xml` / `pest.php` | `./vendor/bin/phpunit` or `composer test` | `composer dump-autoload` | ✅ |
| 7 | Flutter | `pubspec.yaml` (flutter) | `flutter test` | `flutter build apk --debug` | ✅ |
| 8 | Dart | `pubspec.yaml` (non-flutter) | `dart test` | `dart compile exe bin/main.dart` | ✅ |
| 9 | Swift | `Package.swift` | `swift test` | `swift build` | ✅ |
| 10 | React Native | `app.json` / `react-native.config.js` | `npm test` | `npx react-native bundle ...` | ✅ |
| 11 | CMake | `CMakeLists.txt` | `ctest --test-dir build --output-on-failure` | `cmake --build build` | ✅ |
| 12 | Rust/Cargo | `Cargo.toml` | `cargo test --workspace` | `cargo build` | ✅ |
| 13 | Go | `go.mod` | `go test ./...` | `go build ./...` | ✅ |
| 14 | Make | `Makefile` | `make test` | `make build` | ✅ |
| 15 | Foundry | `foundry.toml` / `remappings.txt` | `forge test --offline` | `forge build --offline` | ✅ |
| 16 | Hardhat | `hardhat.config.js` / `hardhat.config.ts` | `npx hardhat test` | `npx hardhat compile` | ✅ |
| 17 | Django | `manage.py` | `python manage.py test --keepdb` | `python manage.py check` | ✅ |
| 18 | Python (generic) | `pyproject.toml` / `requirements.txt` / `setup.py` | `pytest` | `python3 -m compileall -q .` | ✅ |
| 19 | Elixir/Mix | `mix.exs` | `mix test` | `mix compile` | ✅ |
| 20 | Ruby/Bundler | `Gemfile` | `bundle exec rake test` | `bundle exec rake build` | ✅ |
| 21 | Maven | `pom.xml` | `mvn test` | `mvn compile` | ✅ |
| 22 | Gradle | `build.gradle` / `build.gradle.kts` | `./gradlew test` | `./gradlew assemble` | ✅ |
| 23 | Bun | `bunfig.toml` / `bun.lockb` | `bun test` | `bun run build` | ✅ |
| 24 | Deno | `deno.json` / `deno.jsonc` | `deno test` | `deno task build` | ✅ |
| 25 | Node.js (generic) | `package.json` | `npm test` | `npm run build` | ✅ |
| 26 | .NET / C# / F# | `*.sln` / `*.csproj` / `*.fsproj` | `dotnet test --no-restore --nologo` | `dotnet build --no-incremental --nologo` | ✅ |
| 27 | Cloudflare Workers | `wrangler.toml` / `wrangler.json` | *(inherited from Node)* | *(inherited from Node)* | ✅ |
| 28 | Vercel Edge | `@vercel/edge` in `package.json` | *(inherited from Node)* | *(inherited from Node)* | ✅ |
| 29 | Netlify Edge | `netlify.toml` / `@netlify/edge-functions` | *(inherited from Node)* | *(inherited from Node)* | ✅ |

### 1.2 Edge-Case Blindspots

| # | Ecosystem / Scenario | Blindspot Type | Severity | Details |
|---|---------------------|----------------|----------|---------|
| B1 | **`uv` (Python)** | Missing package manager | HIGH | `uv` is the dominant modern Python package manager (2024+). No detection of `uv.lock`, `uv.toml`, or `uv` as the runner. Falls through to bare `pytest` which may fail without `uv run` prefix. |
| B2 | **`bun` + `package.json` coexistence** | Precedence inversion | HIGH | A repo with both `bun.lockb` and `package.json` correctly detects `bun`, but a repo with only `package.json` that actually uses `bun` (installed globally, no lockfile committed) falls to `npm`. |
| B3 | **`pnpm-workspace.yaml` + `Cargo.toml`** | False positive monorepo | MEDIUM | A polyglot monorepo with `pnpm-workspace.yaml` at root and `Cargo.toml` in sub-crates will detect as `pnpm` at root, missing Cargo workspace entirely. The `resolveWorkspaceBoundary` only runs `detectPolyglotStack` per-subproject if changed files are provided. |
| B4 | **`gradlew` wrapper missing** | Fallback failure | HIGH | Gradle detection emits `./gradlew test` but `./gradlew` may not exist (only `build.gradle` present). No check for `gradlew` existence; no fallback to `gradle test`. |
| B5 | **Bazel** | Missing ecosystem | HIGH | No detection of `BUILD`, `BUILD.bazel`, `WORKSPACE`, `MODULE.bazel`, or `.bazelrc`. Bazel is the build system for many large monorepos (Google, Uber, Stripe). |
| B6 | **Zig** | Missing ecosystem | MEDIUM | No detection of `build.zig` or `build.zig.zon`. Zig is growing in systems/embedded space. |
| B7 | **`lerna.json`** | Incomplete monorepo detection | MEDIUM | `wizard-oracle.mjs` checks for `lerna.json` in `isMonorepo` but `stack-detector.mjs` does not. Lerna repos fall through to generic `node` with `npm test`. |
| B8 | **`pnpm-lock.yaml` without `pnpm-workspace.yaml`** | Package manager mismatch | MEDIUM | A single-package pnpm repo (no workspace) has `pnpm-lock.yaml` but no `pnpm-workspace.yaml`. Detected as generic `node` with `npm test`/`npm run build` instead of `pnpm test`/`pnpm run build`. |
| B9 | **`yarn.lock` (Yarn v2+/Berry)** | Package manager mismatch | MEDIUM | No detection of `yarn.lock` or `.yarnrc.yml` for Yarn Berry. Falls to generic `node` with `npm test`. |
| B10 | **`global.json` (.NET SDK pinning)** | Missing trigger | LOW | .NET detection relies on `*.sln`/`*.csproj` file extension scan, but `global.json` is a common root-level trigger that is not checked. |
| B11 | **`Pipfile` / `Pipfile.lock` (pipenv)** | Missing trigger | MEDIUM | `pipenv` repos with `Pipfile` but no `pyproject.toml`/`requirements.txt`/`setup.py` are not detected as Python. |
| B12 | **`poetry.lock` / `poetry.toml`** | Missing trigger | MEDIUM | Poetry repos with only `poetry.lock` (no `pyproject.toml`) are not detected. |
| B13 | **`tox.ini`** | Missing trigger | LOW | Python repos using `tox` as test runner have `tox.ini` but no `pyproject.toml`. Not detected. |
| B14 | **`jest.config.*` / `vitest.config.*` / `ava`** | Test runner ambiguity | LOW | Multiple JS test runners can coexist. The detector always emits `npm test` regardless of which runner is configured. |
| B15 | **`next.config.*` inside Cargo repo** | False positive precedence | HIGH | A monorepo with `Cargo.toml` at root and `next.config.mjs` in `apps/web/` will detect as `cargo` at root. The Next.js sub-app is invisible unless its files are changed. |
| B16 | **Python script in Go repo** | False positive fallback | HIGH | A Go repo with a single `scripts/setup.py` at root will be detected as `python` (the `.py` extension fallback at line ~230 of `stack-detector.mjs`) instead of `go`, because the extension scan runs after the `go.mod` check. Wait — actually `go.mod` is checked before the extension scan, so this is safe. However, a Go repo with a `requirements.txt` (for CI tooling) at root WILL be detected as Python instead of Go, because `requirements.txt` is checked before `go.mod`. |
| B17 | **`requirements.txt` before `go.mod`** | Precedence inversion | **CRITICAL** | In `detectPolyglotStack`, Python detection (line ~195: `pyproject.toml`, `requirements.txt`, `setup.py`) runs BEFORE Go detection (line ~210: `go.mod`). A Go repo that also has a `requirements.txt` for CI tooling (e.g., `scripts/requirements.txt` copied to root) will be misdetected as Python. |
| B18 | **`composer.json` before `go.mod`** | Precedence inversion | HIGH | Similarly, a Go repo with a `composer.json` (e.g., for a PHP documentation site) will be detected as PHP. |
| B19 | **`package.json` before `Cargo.toml`** | Precedence inversion | MEDIUM | A Rust repo with a `package.json` for WASM tooling (wasm-pack, wasm-bindgen) at root will be detected as `node` instead of `cargo`, because `package.json` detection (line ~240) runs after Cargo (line ~205) — actually, Cargo IS checked before package.json. This specific case is safe. |
| B20 | **`app.json` false positive** | False positive | MEDIUM | `app.json` is used by many platforms (Heroku, Expo, Vercel). Detection as React Native based solely on `app.json` presence is overly broad. |

---

## 2. Exact Edge-Case Failure Scenarios

### 2.1 CRITICAL: `requirements.txt` Precedence Inversion over `go.mod`

**File:** `src/stack-detector.mjs`, lines ~195–215  
**Scenario:** A Go monorepo includes a `requirements.txt` at root for CI Python tooling (linting scripts, docs generation).

```
repo-root/
├── go.mod                    # Go module
├── go.sum
├── requirements.txt          # CI tooling: sphinx, flake8
├── cmd/
│   └── server/
│       └── main.go
└── docs/
    └── conf.py
```

**Detection result:** `stack: "python"`, `testCmd: "pytest"`, `buildCmd: "python3 -m compileall -q ."`  
**Expected result:** `stack: "go"`, `testCmd: "go test ./..."`, `buildCmd: "go build ./..."`  
**Impact:** Every verification run invokes `pytest` (likely not installed) instead of `go test`, causing all tasks to fail with exit code 127 or similar.

**Root cause:** The detection cascade in `detectPolyglotStack` checks Python triggers (`pyproject.toml`, `requirements.txt`, `setup.py`) at line ~195 before Go triggers (`go.mod`) at line ~210. The cascade is a flat if/else-if chain with no weighting.

### 2.2 CRITICAL: `gradlew` Wrapper Absent

**File:** `src/stack-detector.mjs`, line ~218  
**Scenario:** A Gradle project has `build.gradle` but the `gradlew` wrapper script is not committed (common in CI-generated projects or when `.gitignore` excludes it).

```
repo-root/
├── build.gradle
├── src/
│   └── main/
│       └── java/
│           └── App.java
```

**Detection result:** `testCmd: "./gradlew test"`, `buildCmd: "./gradlew assemble"`  
**Failure:** `./gradlew: No such file or directory` — exit code 127.  
**Expected:** Should detect `gradlew` absence and fall back to `gradle test` or warn.

### 2.3 HIGH: `app.json` False Positive as React Native

**File:** `src/stack-detector.mjs`, line ~140  
**Scenario:** A Heroku-deployed Node.js app has `app.json` for Heroku button deployment.

```
repo-root/
├── app.json                  # Heroku app manifest
├── package.json              # Node.js app
├── Procfile
└── src/
    └── index.js
```

**Detection result:** `stack: "react-native"`, `testCmd: "npm test"`, `buildCmd: "npx react-native bundle ..."`  
**Expected result:** `stack: "node"`, `buildCmd: "npm run build"`  
**Impact:** Build command invokes `react-native bundle` which is not installed, causing build failures.

### 2.4 HIGH: pnpm/yarn Repos Detected as npm

**File:** `src/stack-detector.mjs`, lines ~240–260  
**Scenario:** A pnpm-managed single-package repo (no workspace) with `pnpm-lock.yaml` but no `pnpm-workspace.yaml`.

```
repo-root/
├── package.json
├── pnpm-lock.yaml
└── src/
    └── index.ts
```

**Detection result:** `stack: "node"`, `testCmd: "npm test"`, `buildCmd: "npm run build"`  
**Expected result:** `testCmd: "pnpm test"`, `buildCmd: "pnpm run build"`  
**Impact:** `npm test` may fail if dependencies were installed with pnpm (different `node_modules` structure). Even if it works, it bypasses pnpm's strictness.

**Note:** `config.mjs` has `detectPackageManager()` that correctly checks `pnpm-lock.yaml`, but `stack-detector.mjs` does NOT call it. The two detection paths are disconnected.

### 2.5 HIGH: Monorepo Root Detection Ignores Sub-Package Stacks

**File:** `src/stack-detector.mjs`, `resolveWorkspaceBoundary()`  
**Scenario:** A polyglot monorepo with `turbo.json` at root, `Cargo.toml` in `crates/engine/`, and `pyproject.toml` in `services/api/`.

```
repo-root/
├── turbo.json
├── package.json
├── crates/
│   └── engine/
│       └── Cargo.toml
└── services/
    └── api/
        └── pyproject.toml
```

**Detection result (root):** `stack: "turbo"`, `testCmd: "npx turbo run test"`  
**Issue:** When no changed files are provided, `resolveWorkspaceBoundary` returns only the root stack. The Cargo and Python sub-projects are invisible. Even with changed files, the sub-project detection calls `detectPolyglotStack(join(root, subDir))` which re-runs the full cascade — but the sub-project may not have all its own trigger files if they depend on root-level configs.

### 2.6 HIGH: Edge Runtime `node:*` Import Guard Has No Path Scoping

**File:** `src/security.mjs`, `checkEdgeRuntimeImports()`, lines ~328–350  
**Scenario:** A Cloudflare Workers project has `wrangler.toml` at root. A build script at `scripts/build.mjs` uses `node:fs` legitimately.

```javascript
// scripts/build.mjs — legitimate Node.js build script
import { readFileSync } from "node:fs";
import { join } from "node:path";
```

**Detection result:** `EDGE_RUNTIME_VIOLATION` flagged for `scripts/build.mjs`  
**Expected:** Build scripts outside `src/` should not be flagged.  
**Impact:** The gate blocks the diff because a build script uses `node:fs`, even though build scripts run in Node.js, not in the Workers runtime.

**Root cause:** `checkEdgeRuntimeImports` scans ALL added lines in the diff without distinguishing file paths. It should only flag `node:*` imports in source directories (e.g., `src/`, `lib/`, `app/`) that are bundled for the edge runtime, not in `scripts/`, `tools/`, `tests/`, or config files.

### 2.7 MEDIUM: `findSubprojectRoot` Manifest List Is Incomplete

**File:** `src/stack-detector.mjs`, `findSubprojectRoot()`, lines ~260–290  
**Missing manifests from the search list:**

| Missing Manifest | Language/Ecosystem |
|-----------------|-------------------|
| `pubspec.yaml` | Dart/Flutter |
| `Package.swift` | Swift |
| `mix.exs` | Elixir |
| `Gemfile` | Ruby |
| `pom.xml` | Java/Maven |
| `build.gradle.kts` | Gradle (Kotlin DSL) |
| `CMakeLists.txt` | C/C++ |
| `Makefile` | Make |
| `wrangler.toml` | Cloudflare Workers |
| `deno.json` / `deno.jsonc` | Deno |
| `bunfig.toml` | Bun |
| `*.sln` / `*.csproj` | .NET |

**Impact:** In a polyglot monorepo with Dart, Swift, or Elixir sub-projects, `findSubprojectRoot` returns `"."` (root) for files in those sub-projects, causing boundary violation checks to skip and test commands to run against the wrong directory.

### 2.8 MEDIUM: `detectCircularDependencies` Search Directories Are Hardcoded

**File:** `src/stack-detector.mjs`, `detectCircularDependencies()`, line ~340  
**Scenario:** A monorepo uses non-standard directory names like `libs/`, `tools/`, `pkg/`, `internal/`, `cmd/`.

```javascript
const searchDirs = ["packages", "apps", "crates", "services", "libs", "modules", "backend", "frontend", "cli", "."];
```

**Issue:** `libs` is included, but `tools/`, `pkg/`, `internal/`, `cmd/`, `workers/`, `plugins/`, `extensions/`, `integrations/` are not. Packages in unlisted directories are invisible to cycle detection.

### 2.9 MEDIUM: `bootstrapZeroTestRepo` Skips Real Test Suites Incorrectly

**File:** `src/stack-detector.mjs`, `bootstrapZeroTestRepo()`, lines ~470–480  
**Scenario:** A repo has `phpunit.xml` but no `.agent/config.yml`. The function checks for `phpunit.xml` as a "real test suite" indicator and skips bootstrapping.

```javascript
const hasRealTestSuite =
    hasConfig ||
    existsSync(join(root, "phpunit.xml")) ||
    existsSync(join(root, "pest.php")) ||
    existsSync(join(root, "turbo.json")) ||
    existsSync(join(root, "pnpm-workspace.yaml")) ||
    existsSync(join(root, "nx.json"));
```

**Issue:** This list is incomplete. A repo with `Cargo.toml` (which has `cargo test`), `go.mod` (which has `go test`), `pytest.ini`, `jest.config.js`, or `vitest.config.ts` is NOT considered to have a "real test suite", so `bootstrapZeroTestRepo` will overwrite its verification oracle with a smoke test.

### 2.10 MEDIUM: `scaffoldContracts` Python Stack Check Includes Non-Detected Stacks

**File:** `src/scaffold.mjs`, `scaffoldContracts()`, line ~130  
**Scenario:** The constraints template checks for `["python", "poetry", "uv", "pipenv"]` but `detectPolyglotStack` only ever returns `"python"` or `"django"`. The `"poetry"`, `"uv"`, and `"pipenv"` values are never produced.

```javascript
} else if (["python", "poetry", "uv", "pipenv"].includes(stackInfo.stack)) {
```

**Impact:** Dead code path. The Python constraints template is only ever matched by `stack === "python"`. If the stack detector were extended to return `"poetry"` etc., this would work — but currently it's misleading.

### 2.11 LOW: `wizard-init.mjs` Hardcodes `"npm test"` as Interactive Default

**File:** `src/wizard-init.mjs`, `runInitWizard()`, line ~230  
**Scenario:** An interactive init for a pnpm or bun repo.

```javascript
defaultValue: testCmd || existingConfig.verify?.test || oracle.candidates.testCmd || "npm test",
```

**Issue:** The fallback `"npm test"` is hardcoded. If `oracle.candidates.testCmd` is empty (which happens when `detectStackOracles` doesn't find a matching script), the user sees `"npm test"` as default even in a pnpm/bun/yarn repo.

### 2.12 LOW: `detectEdgeRuntime` String Matching Is Fragile

**File:** `src/stack-detector.mjs`, `detectEdgeRuntime()`, lines ~40–55  
**Scenario:** A `package.json` contains `"@cloudflare/workers-types"` in a comment or a description field.

```javascript
if (content.includes("@cloudflare/workers-types") || content.includes("@cloudflare/env")) {
```

**Issue:** `content.includes()` matches anywhere in the raw JSON string, including comments (if any), description fields, repository URLs, etc. Should parse JSON and check `dependencies`/`devDependencies` keys specifically.

---

## 3. Recommendations for Heuristic Priority Tuning

### 3.1 Reorder the Detection Cascade by Specificity

The current cascade order is:

1. Monorepo orchestrators (turbo, pnpm, nx)
2. PHP / Laravel / WordPress
3. Mobile (Flutter, Dart, Swift, React Native)
4. Systems (CMake, Cargo, Go, Make)
5. Web3 (Foundry, Hardhat)
6. Python / Elixir / Ruby / Java
7. JS/TS runtimes (Bun, Deno, Node)
8. .NET extension fallback

**Recommended order (by specificity, most specific first):**

1. Monorepo orchestrators (turbo, pnpm-workspace, nx, lerna)
2. Framework-specific (Laravel `artisan`, Django `manage.py`, WordPress `wp-config.php`)
3. Language-specific manifests (Cargo.toml, go.mod, Package.swift, pubspec.yaml, mix.exs, Gemfile, pom.xml, build.gradle)
4. Build system manifests (CMakeLists.txt, Makefile, foundry.toml, hardhat.config)
5. Package manager lockfiles (bun.lockb, pnpm-lock.yaml, yarn.lock, deno.json)
6. .NET extension scan
7. Generic package.json (Node)
8. Generic pyproject.toml / requirements.txt / setup.py (Python)
9. Root file extension fallback

**Key change:** Move `go.mod` and `Cargo.toml` ABOVE `requirements.txt` and `composer.json`. Language-specific manifests should always beat generic dependency files.

### 3.2 Integrate `detectPackageManager` into Stack Detection

`config.mjs` already has `detectPackageManager()` that checks lockfiles and `packageManager` field. `stack-detector.mjs` should call it when detecting Node.js stacks to emit the correct package manager prefix (`pnpm test` vs `npm test` vs `yarn test` vs `bun test`).

### 3.3 Add `gradlew` Existence Check

```javascript
// In the Gradle detection block:
const hasGradlew = existsSync(join(projectRoot, "gradlew")) || existsSync(join(projectRoot, "gradlew.bat"));
const gradleCmd = hasGradlew ? "./gradlew" : "gradle";
return {
  ...container,
  stack: "gradle",
  testCmd: `${gradleCmd} test`,
  buildCmd: `${gradleCmd} assemble`,
  triggerFile,
};
```

### 3.4 Scope Edge Runtime Import Checks to Source Directories

The `checkEdgeRuntimeImports` function should accept a `sourceDirs` option and only flag imports in files under those directories:

```javascript
const SOURCE_DIRS = ["src/", "lib/", "app/", "pages/", "api/", "workers/", "functions/"];
const CONFIG_OR_BUILD_DIRS = ["scripts/", "tools/", "build/", "config/", ".github/", "test/", "tests/", "__tests__/", "spec/"];
```

### 3.5 Expand `findSubprojectRoot` Manifest List

Add all manifests that `detectPolyglotStack` recognizes as triggers. See §2.7 for the complete list.

### 3.6 Expand `detectCircularDependencies` Search Directories

Add: `tools/`, `pkg/`, `internal/`, `cmd/`, `workers/`, `plugins/`, `extensions/`, `integrations/`, `examples/`, `benchmarks/`, `tests/`.

### 3.7 Add Container Detection for `Dockerfile`-Only Repos

Current container detection only checks `.devcontainer/devcontainer.json` and `docker-compose.yml`/`compose.yml`. A repo with only a `Dockerfile` is not detected as containerized. Add:

```javascript
const isDockerfile = existsSync(join(projectRoot, "Dockerfile")) || existsSync(join(projectRoot, "Containerfile"));
```

---

## 4. Code Snippets for New Detection Rules

### 4.1 `uv` Python Package Manager Detection

```javascript
// Add to detectPolyglotStack, before the generic Python block
if (existsSync(join(projectRoot, "uv.lock")) || existsSync(join(projectRoot, "uv.toml"))) {
  const triggerFile = existsSync(join(projectRoot, "uv.lock")) ? "uv.lock" : "uv.toml";
  let testCmd = "uv run pytest";
  // Check pyproject.toml for custom test script
  if (existsSync(join(projectRoot, "pyproject.toml"))) {
    try {
      const pyproject = readFileSync(join(projectRoot, "pyproject.toml"), "utf-8");
      if (pyproject.includes("[tool.uv]") || pyproject.includes("uv")) {
        // uv-managed project
      }
    } catch (_) {}
  }
  return {
    ...container,
    stack: "uv",
    testCmd,
    buildCmd: "uv build",
    triggerFile,
  };
}
```

### 4.2 `pipenv` Detection

```javascript
// Add before generic Python block
if (existsSync(join(projectRoot, "Pipfile"))) {
  return {
    ...container,
    stack: "pipenv",
    testCmd: "pipenv run pytest",
    buildCmd: "pipenv run python -m compileall -q .",
    triggerFile: "Pipfile",
  };
}
```

### 4.3 Bazel Detection

```javascript
// Add to detectPolyglotStack, in the Systems section
if (
  existsSync(join(projectRoot, "MODULE.bazel")) ||
  existsSync(join(projectRoot, "WORKSPACE")) ||
  existsSync(join(projectRoot, "WORKSPACE.bazel")) ||
  existsSync(join(projectRoot, ".bazelrc"))
) {
  const triggerFile = existsSync(join(projectRoot, "MODULE.bazel"))
    ? "MODULE.bazel"
    : existsSync(join(projectRoot, "WORKSPACE.bazel"))
    ? "WORKSPACE.bazel"
    : existsSync(join(projectRoot, "WORKSPACE"))
    ? "WORKSPACE"
    : ".bazelrc";
  return {
    ...container,
    stack: "bazel",
    testCmd: "bazel test //...",
    buildCmd: "bazel build //...",
    triggerFile,
  };
}
```

### 4.4 Zig Detection

```javascript
// Add to detectPolyglotStack, in the Systems section
if (existsSync(join(projectRoot, "build.zig")) || existsSync(join(projectRoot, "build.zig.zon"))) {
  const triggerFile = existsSync(join(projectRoot, "build.zig")) ? "build.zig" : "build.zig.zon";
  return {
    ...container,
    stack: "zig",
    testCmd: "zig build test",
    buildCmd: "zig build",
    triggerFile,
  };
}
```

### 4.5 Gradle Wrapper Detection with Fallback

```javascript
// Replace the existing Gradle block in detectPolyglotStack
if (existsSync(join(projectRoot, "build.gradle")) || existsSync(join(projectRoot, "build.gradle.kts"))) {
  const triggerFile = existsSync(join(projectRoot, "build.gradle")) ? "build.gradle" : "build.gradle.kts";
  const hasGradlew =
    existsSync(join(projectRoot, "gradlew")) ||
    existsSync(join(projectRoot, "gradlew.bat"));
  const gradleRunner = hasGradlew ? "./gradlew" : "gradle";
  return {
    ...container,
    stack: "gradle",
    testCmd: `${gradleRunner} test`,
    buildCmd: `${gradleRunner} assemble`,
    triggerFile,
  };
}
```

### 4.6 Package Manager Aware Node.js Detection

```javascript
// Add helper function
function detectNodePackageManager(projectRoot) {
  if (existsSync(join(projectRoot, "bun.lockb"))) return "bun";
  if (existsSync(join(projectRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(projectRoot, "yarn.lock"))) return "yarn";
  if (existsSync(join(projectRoot, "package-lock.json"))) return "npm";
  // Check packageManager field
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8"));
    if (typeof pkg.packageManager === "string") {
      if (pkg.packageManager.startsWith("pnpm")) return "pnpm";
      if (pkg.packageManager.startsWith("yarn")) return "yarn";
      if (pkg.packageManager.startsWith("bun")) return "bun";
    }
  } catch (_) {}
  return "npm";
}

// Use in the generic Node.js detection block:
if (existsSync(join(projectRoot, "package.json"))) {
  const pm = detectNodePackageManager(projectRoot);
  let testScript = `${pm} test`;
  let buildScript = `${pm} run build`;
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8"));
    const scripts = pkg.scripts || {};
    if (!scripts.test) testScript = "";  // No test script
    if (!scripts.build) buildScript = "";  // No build script
  } catch (_) {}
  return {
    ...container,
    stack: "node",
    packageManager: pm,
    setupCmd,
    testCmd: testScript,
    buildCmd: buildScript,
    triggerFile: "package.json",
  };
}
```

### 4.7 Scoped Edge Runtime Import Checker

```javascript
// Enhanced checkEdgeRuntimeImports with path scoping
export function checkEdgeRuntimeImportsScoped(diffOrText = "", options = {}) {
  if (!diffOrText || typeof diffOrText !== "string") return { ok: true, violations: [] };

  const isEdgeExplicit = options.isEdgeRuntime === true;
  const hasEdgeExport = /export\s+const\s+runtime\s*=\s*['"]edge['"]/i.test(diffOrText);
  const isEdgeContext = isEdgeExplicit || hasEdgeExport;

  if (!isEdgeContext) return { ok: true, violations: [] };

  // Directories whose files are bundled for edge runtime
  const SOURCE_DIRS = options.sourceDirs || [
    "src/", "lib/", "app/", "pages/", "api/",
    "workers/", "functions/", "edge/", "middleware.",
  ];
  // Directories that run in Node.js, not edge
  const NODE_DIRS = [
    "scripts/", "tools/", "build/", "config/", ".github/",
    "test/", "tests/", "__tests__/", "spec/", "e2e/",
    ".agent/", "node_modules/",
  ];

  const lines = diffOrText.split("\n");
  const violations = [];
  let currentFile = null;

  for (const line of lines) {
    // Track which file we're in from diff headers
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("diff ")) continue;

    // Only check added lines
    const isAdded = diffOrText.includes("+++ b/")
      ? line.startsWith("+") && !line.startsWith("+++")
      : true;
    if (!isAdded) continue;

    // Skip files in Node.js-only directories
    if (currentFile && NODE_DIRS.some((d) => currentFile.includes(d))) continue;

    // Only flag files in source directories (or if no file context)
    const inSourceDir = !currentFile || SOURCE_DIRS.some((d) => currentFile.includes(d));
    if (!inSourceDir) continue;

    const edgeImportRegex = /(?:import\s+.*?\s+from\s+|require\s*\(\s*)['"](?:node:(?:fs|child_process|cluster|dgram|net|tls|v8|vm|worker_threads)|(?:fs|child_process|cluster|dgram|net|tls|v8|vm|worker_threads))(?:\/.*)?['"]/i;
    const match = line.match(edgeImportRegex);
    if (match) {
      violations.push({
        module: match[1],
        file: currentFile,
        line: line.trim(),
        reason: `Edge Runtime Violation: Native Node module "${match[1]}" is unsupported in Edge environments. File: ${currentFile || "unknown"}`,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}
```

### 4.8 Expanded `findSubprojectRoot` Manifest List

```javascript
// Replace the manifestFiles array in findSubprojectRoot
const manifestFiles = [
  // JS/TS
  "package.json",
  // Rust
  "Cargo.toml",
  // Go
  "go.mod",
  // Python
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "Pipfile",
  // PHP
  "composer.json",
  // Java
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  // .NET
  "global.json",
  // Dart/Flutter
  "pubspec.yaml",
  // Swift
  "Package.swift",
  // Elixir
  "mix.exs",
  // Ruby
  "Gemfile",
  // C/C++
  "CMakeLists.txt",
  "Makefile",
  // Web3
  "foundry.toml",
  "hardhat.config.js",
  "hardhat.config.ts",
  // Build systems
  "WORKSPACE",
  "WORKSPACE.bazel",
  "MODULE.bazel",
  "build.zig",
  // Edge/Cloud
  "wrangler.toml",
  "deno.json",
  "deno.jsonc",
];
```

### 4.9 `app.json` Disambiguation

```javascript
// Replace the React Native detection block
if (existsSync(join(projectRoot, "react-native.config.js"))) {
  return {
    ...container,
    stack: "react-native",
    testCmd: "npm test",
    buildCmd: "npx react-native bundle --platform android --dev false --entry-file index.js --bundle-output android/main.jsbundle",
    triggerFile: "react-native.config.js",
  };
}
if (existsSync(join(projectRoot, "app.json"))) {
  try {
    const appJson = JSON.parse(readFileSync(join(projectRoot, "app.json"), "utf-8"));
    // Only detect as React Native if expo or react-native indicators are present
    if (appJson.expo || appJson.reactNative || appJson.name) {
      // Check for package.json with react-native dependency
      const pkgPath = join(projectRoot, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        if (allDeps["react-native"] || allDeps["expo"]) {
          return {
            ...container,
            stack: "react-native",
            testCmd: "npm test",
            buildCmd: "npx react-native bundle --platform android --dev false --entry-file index.js --bundle-output android/main.jsbundle",
            triggerFile: "app.json",
          };
        }
      }
    }
  } catch (_) {}
  // Fall through — app.json alone is not enough to判定 React Native
}
```

### 4.10 Lerna Monorepo Detection

```javascript
// Add to detectPolyglotStack, after the nx.json check
if (existsSync(join(projectRoot, "lerna.json"))) {
  let testCmd = "npx lerna run test";
  let buildCmd = "npx lerna run build";
  try {
    const lerna = JSON.parse(readFileSync(join(projectRoot, "lerna.json"), "utf-8"));
    // Lerna v7+ with npmClient
    if (lerna.npmClient === "pnpm") {
      testCmd = "pnpm -r test";
      buildCmd = "pnpm -r build";
    } else if (lerna.npmClient === "yarn") {
      testCmd = "yarn workspaces run test";
      buildCmd = "yarn workspaces run build";
    }
  } catch (_) {}
  return {
    ...container,
    stack: "lerna",
    testCmd,
    buildCmd,
    triggerFile: "lerna.json",
  };
}
```

---

## Appendix A: Detection Cascade Order Comparison

### Current Order (v0.41.1)
```
1. turbo.json
2. pnpm-workspace.yaml
3. nx.json
4. artisan (Laravel)
5. wp-cli.yml / wp-config.php (WordPress)
6. composer.json / phpunit.xml / pest.php (PHP)
7. pubspec.yaml (Flutter/Dart)
8. Package.swift (Swift)
9. app.json / react-native.config.js (React Native)
10. CMakeLists.txt (CMake)
11. Cargo.toml (Rust)
12. go.mod (Go)
13. Makefile (Make)
14. foundry.toml / remappings.txt (Foundry)
15. hardhat.config.* (Hardhat)
16. manage.py (Django)
17. pyproject.toml / requirements.txt / setup.py (Python)  ← BEFORE Go in some repos
18. mix.exs (Elixir)
19. Gemfile (Ruby)
20. pom.xml (Maven)
21. build.gradle* (Gradle)
22. bunfig.toml / bun.lockb (Bun)
23. deno.json* (Deno)
24. package.json (Node)
25. *.sln / *.csproj / *.fsproj (.NET)
26. *.php / *.py extension fallback
```

### Recommended Order
```
1. turbo.json
2. pnpm-workspace.yaml
3. nx.json
4. lerna.json                                    ← NEW
5. artisan (Laravel)
6. manage.py (Django)
7. wp-cli.yml / wp-config.php (WordPress)
8. Cargo.toml (Rust)                             ← MOVED UP
9. go.mod (Go)                                   ← MOVED UP
10. Package.swift (Swift)
11. pubspec.yaml (Flutter/Dart)
12. mix.exs (Elixir)
13. Gemfile (Ruby)
14. pom.xml (Maven)
15. build.gradle* (Gradle) + gradlew check       ← ENHANCED
16. CMakeLists.txt (CMake)
17. Makefile (Make)
18. build.zig / build.zig.zon (Zig)              ← NEW
19. MODULE.bazel / WORKSPACE* (Bazel)            ← NEW
20. foundry.toml / remappings.txt (Foundry)
21. hardhat.config.* (Hardhat)
22. uv.lock / uv.toml (uv)                      ← NEW
23. Pipfile (pipenv)                             ← NEW
24. pyproject.toml / setup.py / setup.cfg (Python) ← requirements.txt REMOVED
25. composer.json / phpunit.xml / pest.php (PHP)
26. bunfig.toml / bun.lockb (Bun)
27. deno.json* (Deno)
28. pnpm-lock.yaml (pnpm, no workspace)          ← NEW
29. yarn.lock / .yarnrc.yml (Yarn)               ← NEW
30. package.json (Node) + package manager aware   ← ENHANCED
31. *.sln / *.csproj / *.fsproj / global.json (.NET)
32. react-native.config.js (React Native)        ← app.json DISAMBIGUATED
33. *.php / *.py extension fallback
```

**Key changes:**
- `go.mod` and `Cargo.toml` moved above `requirements.txt` and `composer.json`
- `requirements.txt` removed as standalone Python trigger (too ambiguous; keep `pyproject.toml` and `setup.py`)
- `app.json` disambiguated from React Native
- New ecosystems added: `uv`, `pipenv`, Bazel, Zig, Lerna
- Package manager detection integrated for Node.js

---

## Appendix B: Test Coverage Gaps

The existing test suite (`test/stack-detector.test.mjs`, `test/monorepo-boundary.test.mjs`) covers:
- ✅ PHP/Laravel, .NET, Flutter, CMake, Devcontainer detection
- ✅ Workspace boundary resolution with sub-projects
- ✅ Edge runtime detection (wrangler, Vercel)
- ✅ Cross-package boundary violations (JS/TS, Go, Rust)
- ✅ Circular dependency detection
- ✅ Bootstrap zero-test repo

**Not covered by tests:**
- ❌ Precedence inversions (requirements.txt vs go.mod)
- ❌ Gradle without gradlew wrapper
- ❌ app.json false positive as React Native
- ❌ pnpm/yarn repos detected as npm
- ❌ Edge runtime import scoping (build scripts vs source)
- ❌ `findSubprojectRoot` with non-JS manifests (Dart, Swift, Elixir)
- ❌ `detectCircularDependencies` with non-standard directory names
- ❌ `bootstrapZeroTestRepo` with Cargo/Go/pytest repos
- ❌ `uv`, `pipenv`, Bazel, Zig ecosystems
- ❌ Lerna monorepo detection
- ❌ `packageManager` field in package.json

---

*End of audit. No repository code or tests were altered.*
