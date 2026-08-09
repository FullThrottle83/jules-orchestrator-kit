# Universal Polyglot Architecture & Verification Guide

## Executive Overview

`jules-orchestrator-kit` provides a zero-dependency orchestration kernel capable of executing self-healing agent swarms across 24+ software ecosystems—including PHP/Laravel/WordPress, .NET/C#/F#, Mobile (Flutter/Dart/Swift/React Native), Systems (C/C++/Rust/Go/Make), and Containerized/Devcontainer environments—strictly leveraging built-in Node.js modules (`node:fs`, `node:child_process`, `node:crypto`, `node:path`, `node:test`).

---

## 1. Universal Polyglot Stack Matrix

| Ecosystem | Detected Stack (`stack`) | Trigger Files | Default Test Command (`testCmd`) | Default Build Command (`buildCmd`) |
| :--- | :--- | :--- | :--- | :--- |
| **PHP / Laravel** | `laravel` | `artisan`, `composer.json` | `./vendor/bin/pest` / `./vendor/bin/phpunit` | `composer dump-autoload` |
| **PHP / WordPress** | `wordpress` | `wp-cli.yml` | `./vendor/bin/phpunit` | `wp dist-archive` |
| **PHP / Standard** | `php` | `composer.json`, `phpunit.xml` | `composer test` / `./vendor/bin/phpunit` | `composer dump-autoload` |
| **.NET / C# / F#** | `dotnet` | `*.sln`, `*.csproj`, `*.fsproj` | `dotnet test --no-restore --nologo` | `dotnet build --no-incremental --nologo` |
| **Mobile / Flutter** | `flutter` | `pubspec.yaml` | `flutter test` | `flutter build apk --debug` |
| **Mobile / Swift** | `swift` | `Package.swift` | `swift test` | `swift build` |
| **Systems / CMake** | `cmake` | `CMakeLists.txt` | `ctest --test-dir build --output-on-failure` | `cmake --build build` |
| **Systems / Rust** | `cargo` | `Cargo.toml` | `cargo test --workspace` | `cargo build` |
| **Systems / Go** | `go` | `go.mod` | `go test ./...` | `go build ./...` |
| **Python** | `python` | `pyproject.toml`, `requirements.txt` | `pytest` | `python3 -m compileall -q .` |

---

## 2. Containerized Execution Wrappers

When a container environment is detected (`.devcontainer/devcontainer.json` or `docker-compose.yml`), task verification commands are wrapped:

```bash
# Docker Compose wrapper
docker compose exec -T app <resolved_test_cmd>

# Devcontainer CLI wrapper
devcontainer exec --workspace-folder . <resolved_test_cmd>
```

---

## 3. Scoped Monorepo Boundary Resolver

`resolveWorkspaceBoundary(changedFiles, projectRoot)` maps modified files to subproject roots:

```js
import { resolveWorkspaceBoundary } from "./src/config.mjs";

const plan = resolveWorkspaceBoundary(["backend/api/main.py", "cli/src/main.rs"], process.cwd());
// Output testCmd: "(cd backend && pytest) && (cd cli && cargo test --workspace)"
```

---

## 4. Zero-Test Bootstrapping (`agentctl bootstrap`)

Injects non-destructive syntax check or smoke test gates for untested legacy repositories:

```bash
agentctl bootstrap [--force]
```
- **PHP:** `php -l $(find . -name "*.php" -not -path "./vendor/*")`
- **Python:** `python3 -m compileall -q .`
- **TypeScript:** `npx tsc --noEmit`
- **Generic JS:** Generates `.agent/smoke.test.mjs` via `node:test`.
