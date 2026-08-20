import {
  generateEvidenceManifest,
  writeEvidenceManifest,
  loadEvidenceManifest,
  verifyEvidenceManifest,
  generateEvidenceMarkdown,
} from "../evidence.mjs";
import { resolveRoot } from "../config.mjs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Generates an evidence manifest and optional markdown summary.
 * @param {string} root
 * @param {object} [options]
 * @returns {object}
 */
export function planEvidenceGenerate(root = resolveRoot(), options = {}) {
  const manifest = generateEvidenceManifest(root, options);
  const manifestPath = writeEvidenceManifest(root, manifest, options.output);
  const markdown = generateEvidenceMarkdown(manifest);

  if (options.markdownOutput) {
    const mdPath = options.markdownOutput.endsWith(".md")
      ? options.markdownOutput
      : join(root, ".agent", "evidence", "EVIDENCE.md");
    try {
      writeFileSync(mdPath, markdown, "utf-8");
    } catch (_) {}
  }

  return {
    ok: true,
    manifest,
    manifestPath,
    markdown,
  };
}

/**
 * Verifies an evidence manifest against the current working directory.
 * @param {string} root
 * @param {object} [options]
 * @returns {object}
 */
export function planEvidenceVerify(root = resolveRoot(), options = {}) {
  const manifestTarget = options.manifest || "manifest.v1.json";
  const result = verifyEvidenceManifest(root, manifestTarget);
  return result;
}

/**
 * Loads and displays the latest evidence manifest.
 * @param {string} root
 * @param {object} [options]
 * @returns {object}
 */
export function planEvidenceShow(root = resolveRoot(), options = {}) {
  const manifestTarget = options.manifest || "manifest.v1.json";
  try {
    const manifest = loadEvidenceManifest(root, manifestTarget);
    const markdown = generateEvidenceMarkdown(manifest);
    return {
      ok: true,
      manifest,
      markdown,
    };
  } catch (err) {
    return {
      ok: false,
      reason: err.message,
    };
  }
}
