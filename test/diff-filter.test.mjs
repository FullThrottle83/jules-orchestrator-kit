import test from "node:test";
import assert from "node:assert/strict";
import { filterDiffByPaths, globToRegExp, DEFAULT_GENERATED_GLOBS } from "../src/git.mjs";

test("Diff Payload Filtering & Pruning", async (t) => {
  await t.test("DEFAULT_GENERATED_GLOBS contains standard build artifacts and lockfiles", () => {
    assert.ok(Array.isArray(DEFAULT_GENERATED_GLOBS));
    assert.ok(DEFAULT_GENERATED_GLOBS.includes("dist/**"));
    assert.ok(DEFAULT_GENERATED_GLOBS.includes("**/package-lock.json"));
    assert.ok(DEFAULT_GENERATED_GLOBS.includes("**/*.map"));
  });

  await t.test("globToRegExp matches wildcards correctly", () => {
    const distRe = globToRegExp("dist/**");
    assert.ok(distRe.test("dist/bundle.js"));
    assert.ok(distRe.test("dist/sub/dir/app.min.js"));
    assert.ok(!distRe.test("src/dist/file.js"));

    const anyDistRe = globToRegExp("**/dist/**");
    assert.ok(anyDistRe.test("packages/core/dist/index.js"));
    assert.ok(anyDistRe.test("dist/index.js"));

    const lockRe = globToRegExp("**/package-lock.json");
    assert.ok(lockRe.test("package-lock.json"));
    assert.ok(lockRe.test("apps/web/package-lock.json"));
    assert.ok(!lockRe.test("package.json"));

    const mapRe = globToRegExp("**/*.map");
    assert.ok(mapRe.test("index.js.map"));
    assert.ok(mapRe.test("dist/assets/index.css.map"));
    assert.ok(!mapRe.test("index.map.js"));
  });

  await t.test("filters generated bundles and lockfiles while preserving source diffs", () => {
    const rawDiff = `diff --git a/src/index.js b/src/index.js
index 1111111..2222222 100644
--- a/src/index.js
+++ b/src/index.js
@@ -1,3 +1,4 @@
 export function hello() {
+  console.log("hello");
   return true;
 }
diff --git a/package-lock.json b/package-lock.json
index 3333333..4444444 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -10,6 +10,12 @@
+    "dependency": "1.0.0"
diff --git a/dist/bundle.js.map b/dist/bundle.js.map
index 5555555..6666666 100644
--- a/dist/bundle.js.map
+++ b/dist/bundle.js.map
@@ -1 +1 @@
+{"version":3}
diff --git a/src/utils.js b/src/utils.js
index 7777777..8888888 100644
--- a/src/utils.js
+++ b/src/utils.js
@@ -5,2 +5,3 @@
+export const answer = 42;
`;

    const { diff, excludedPaths } = filterDiffByPaths(rawDiff);

    assert.deepEqual(excludedPaths, ["package-lock.json", "dist/bundle.js.map"]);
    assert.ok(diff.includes("src/index.js"));
    assert.ok(diff.includes("src/utils.js"));
    assert.ok(!diff.includes("package-lock.json"));
    assert.ok(!diff.includes("dist/bundle.js.map"));
  });

  await t.test("preserves original diff if all files match ignore globs", () => {
    const lockOnlyDiff = `diff --git a/package-lock.json b/package-lock.json
index 3333333..4444444 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,3 +1,3 @@
-"version": "1.0.0"
+"version": "1.0.1"
`;

    const { diff, excludedPaths } = filterDiffByPaths(lockOnlyDiff);
    assert.equal(diff, lockOnlyDiff);
    assert.deepEqual(excludedPaths, []);
  });

  await t.test("returns empty diff or handles falsy input safely", () => {
    assert.deepEqual(filterDiffByPaths(""), { diff: "", excludedPaths: [] });
    assert.deepEqual(filterDiffByPaths(null), { diff: "", excludedPaths: [] });
    assert.deepEqual(filterDiffByPaths("foo", []), { diff: "foo", excludedPaths: [] });
  });
});
