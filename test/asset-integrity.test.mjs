import test from "node:test";
import assert from "node:assert/strict";
import { checkAssetIntegrity } from "../src/asset_integrity.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
});
