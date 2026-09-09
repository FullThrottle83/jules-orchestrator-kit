import test from "node:test";
import assert from "node:assert/strict";
import { checkAssetIntegrity } from "../src/asset-integrity.mjs";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Asset Integrity Validator", async (t) => {
  const testDir = mkdtempSync(join(tmpdir(), "jules-asset-test-"));

  t.after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  await t.test("passes clean binary asset headers", () => {
    const fontPath = join(testDir, "clean.woff2");
    writeFileSync(fontPath, Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01])); // wOF2 magic bytes
    const res = checkAssetIntegrity(testDir);
    assert.equal(res.ok, true);
    assert.equal(res.corruptedFiles.length, 0);
  });

  await t.test("detects corrupted asset saved as HTML error page", () => {
    const fakeFontPath = join(testDir, "fake.woff2");
    writeFileSync(fakeFontPath, "<!DOCTYPE html><html><body>404 Not Found</body></html>");
    const res = checkAssetIntegrity(testDir);
    assert.equal(res.ok, false);
    assert.equal(res.corruptedFiles.length, 1);
    assert.equal(res.corruptedFiles[0].path, fakeFontPath);
  });

  await t.test("CLI reports status N/A when no asset directories exist (D13)", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "jules-asset-empty-"));
    try {
      const script = fileURLToPath(new URL("../scripts/asset-integrity-check.mjs", import.meta.url));
      const res = spawnSync("node", [script], { cwd: emptyDir, encoding: "utf-8" });
      const out = `${res.stdout || ""}${res.stderr || ""}`;
      assert.match(out, /N\/A/, `expected an N/A status when nothing was checked, got: ${out}`);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  await t.test("CLI fails red when a corrupt image header is present (D13)", () => {
    const badDir = mkdtempSync(join(tmpdir(), "jules-asset-bad-"));
    try {
      mkdirSync(join(badDir, "public"), { recursive: true });
      writeFileSync(join(badDir, "public", "hero.png"), "<!DOCTYPE html><html><body>404 Not Found</body></html>");
      const script = fileURLToPath(new URL("../scripts/asset-integrity-check.mjs", import.meta.url));
      const res = spawnSync("node", [script], { cwd: badDir, encoding: "utf-8" });
      const out = `${res.stdout || ""}${res.stderr || ""}`;
      assert.equal(res.status, 1, `expected exit 1 on corrupt assets, got status=${res.status} output=${out}`);
      assert.match(out, /INTEGRITY FAILURE|corrupt/i);
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
  });
});
