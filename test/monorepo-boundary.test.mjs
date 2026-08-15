import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findSubprojectRoot,
  detectCrossPackageBoundaryViolations,
  detectCircularDependencies,
  resolveWorkspaceBoundary,
} from "../src/stack-detector.mjs";
import { checkCrossPackageImports, scanDiff } from "../src/security.mjs";

test("findSubprojectRoot - correctly identifies subproject roots across languages", () => {
  const tmp = mkdtempSync(join(tmpdir(), "subproject-root-test-"));
  try {
    // 1. JS / TS package
    mkdirSync(join(tmp, "packages", "auth", "src", "routes"), { recursive: true });
    writeFileSync(join(tmp, "packages", "auth", "package.json"), '{"name": "@app/auth"}');

    // 2. Cargo crate
    mkdirSync(join(tmp, "crates", "engine", "src"), { recursive: true });
    writeFileSync(join(tmp, "crates", "engine", "Cargo.toml"), '[package]\nname = "engine"');

    // 3. Go module
    mkdirSync(join(tmp, "services", "billing"), { recursive: true });
    writeFileSync(join(tmp, "services", "billing", "go.mod"), "module app/billing");

    assert.equal(findSubprojectRoot("packages/auth/src/routes/login.ts", tmp), "packages/auth");
    assert.equal(findSubprojectRoot("crates/engine/src/main.rs", tmp), "crates/engine");
    assert.equal(findSubprojectRoot("services/billing/handler.go", tmp), "services/billing");
    assert.equal(findSubprojectRoot("README.md", tmp), ".");
    assert.equal(findSubprojectRoot("nonexistent/path/file.txt", tmp), ".");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("detectCrossPackageBoundaryViolations - flags illegal relative escaping imports", () => {
  const tmp = mkdtempSync(join(tmpdir(), "boundary-violations-test-"));
  try {
    const pkgAuth = join(tmp, "packages", "auth");
    const pkgCore = join(tmp, "packages", "core");
    mkdirSync(join(pkgAuth, "src"), { recursive: true });
    mkdirSync(join(pkgCore, "src"), { recursive: true });

    writeFileSync(join(pkgAuth, "package.json"), '{"name": "@app/auth"}');
    writeFileSync(join(pkgCore, "package.json"), '{"name": "@app/core"}');

    // Valid internal relative import
    writeFileSync(
      join(pkgAuth, "src", "valid.ts"),
      'import { hash } from "./utils.js";\nexport { auth } from "./services/auth.js";'
    );

    // Illegal escaping relative import (piercing package encapsulation)
    writeFileSync(
      join(pkgAuth, "src", "invalid.ts"),
      'import { config } from "../../core/src/config.js";\nconst db = require("../../core/src/db.js");'
    );

    const validViolations = detectCrossPackageBoundaryViolations(["packages/auth/src/valid.ts"], tmp);
    assert.equal(validViolations.length, 0);

    const invalidViolations = detectCrossPackageBoundaryViolations(["packages/auth/src/invalid.ts"], tmp);
    assert.equal(invalidViolations.length, 2);
    assert.equal(invalidViolations[0].subproject, "packages/auth");
    assert.equal(invalidViolations[0].importTarget, "../../core/src/config.js");
    assert.equal(invalidViolations[0].language, "javascript/typescript");
    assert.ok(invalidViolations[0].reason.includes("escaping its package boundary"));

    // Polyglot: Rust and Go
    const crateA = join(tmp, "crates", "crate_a");
    mkdirSync(join(crateA, "src"), { recursive: true });
    writeFileSync(join(crateA, "Cargo.toml"), '[package]\nname = "crate_a"');
    writeFileSync(join(crateA, "src", "lib.rs"), '#[path = "../../crate_b/src/lib.rs"]\nmod crate_b;');

    const rustViolations = detectCrossPackageBoundaryViolations(["crates/crate_a/src/lib.rs"], tmp);
    assert.equal(rustViolations.length, 1);
    assert.equal(rustViolations[0].language, "rust");

    const goSvc = join(tmp, "services", "svc_a");
    mkdirSync(goSvc, { recursive: true });
    writeFileSync(join(goSvc, "go.mod"), "module app/svc_a");
    writeFileSync(join(goSvc, "main.go"), 'package main\nimport "../svc_b/util"\nfunc main() {}');

    const goViolations = detectCrossPackageBoundaryViolations(["services/svc_a/main.go"], tmp);
    assert.equal(goViolations.length, 1);
    assert.equal(goViolations[0].language, "go");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("detectCircularDependencies - accurately detects workspace cycles", () => {
  const tmp = mkdtempSync(join(tmpdir(), "cycles-test-"));
  try {
    const pkgA = join(tmp, "packages", "pkg-a");
    const pkgB = join(tmp, "packages", "pkg-b");
    const pkgC = join(tmp, "packages", "pkg-c");
    mkdirSync(pkgA, { recursive: true });
    mkdirSync(pkgB, { recursive: true });
    mkdirSync(pkgC, { recursive: true });

    // Acyclic setup
    writeFileSync(join(pkgA, "package.json"), '{"name": "pkg-a", "dependencies": {"pkg-b": "1.0.0"}}');
    writeFileSync(join(pkgB, "package.json"), '{"name": "pkg-b", "dependencies": {"pkg-c": "1.0.0"}}');
    writeFileSync(join(pkgC, "package.json"), '{"name": "pkg-c", "dependencies": {}}');

    let res = detectCircularDependencies(tmp);
    assert.equal(res.hasCycles, false);
    assert.equal(res.cycles.length, 0);
    assert.equal(res.packages.length, 3);

    // Introduce circular dependency: pkg-c depends on pkg-a
    writeFileSync(join(pkgC, "package.json"), '{"name": "pkg-c", "dependencies": {"pkg-a": "1.0.0"}}');

    res = detectCircularDependencies(tmp);
    assert.equal(res.hasCycles, true);
    assert.ok(res.cycles.length > 0);
    assert.ok(res.cycles.some((c) => c.includes("pkg-a") && c.includes("pkg-b") && c.includes("pkg-c")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveWorkspaceBoundary - reports boundary violations and circular dependencies", () => {
  const tmp = mkdtempSync(join(tmpdir(), "resolve-boundary-ext-test-"));
  try {
    const pkgA = join(tmp, "packages", "pkg-a");
    mkdirSync(join(pkgA, "src"), { recursive: true });
    writeFileSync(join(pkgA, "package.json"), '{"name": "pkg-a", "scripts": {"test": "npm test"}}');
    writeFileSync(
      join(pkgA, "src", "index.ts"),
      'import { helper } from "../../pkg-b/src/helper.ts";'
    );

    const boundary = resolveWorkspaceBoundary(["packages/pkg-a/src/index.ts"], tmp);
    assert.equal(boundary.isMonorepo, false);
    assert.equal(boundary.boundaryViolations.length, 1);
    assert.equal(boundary.boundaryViolations[0].importTarget, "../../pkg-b/src/helper.ts");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("checkCrossPackageImports & scanDiff - flags boundary violations in diffs", () => {
  const tmp = mkdtempSync(join(tmpdir(), "security-boundary-test-"));
  try {
    const pkgA = join(tmp, "packages", "pkg-a");
    mkdirSync(join(pkgA, "src"), { recursive: true });
    writeFileSync(join(pkgA, "package.json"), '{"name": "pkg-a"}');

    const diff = `
diff --git a/packages/pkg-a/src/index.ts b/packages/pkg-a/src/index.ts
--- a/packages/pkg-a/src/index.ts
+++ b/packages/pkg-a/src/index.ts
@@ -1,3 +1,4 @@
+import { leaked } from "../../pkg-b/secret.ts";
 export const ok = true;
 `;

    const checkRes = checkCrossPackageImports(diff, tmp);
    assert.equal(checkRes.ok, false);
    assert.equal(checkRes.violations.length, 1);
    assert.equal(checkRes.violations[0].importTarget, "../../pkg-b/secret.ts");

    const scanRes = scanDiff(diff, { root: tmp });
    assert.equal(scanRes.ok, false);
    assert.ok(scanRes.findings.some((f) => f.type === "CROSS_PACKAGE_BOUNDARY_VIOLATION"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
