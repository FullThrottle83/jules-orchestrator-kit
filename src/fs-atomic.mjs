/**
 * Atomic filesystem writes for the kit's own state.
 *
 * Split out of src/security.mjs (P05): these are the write primitives every
 * durable artefact in the kit rests on — a state file, an evidence bundle, a
 * handover — and they have nothing to do with scanning a diff. They sit at the
 * bottom of the dependency graph on purpose: nothing under src/ needs to import
 * security scanning in order to write a file safely.
 *
 * Relocation only; the logic, the failure modes and the comment reasoning are
 * the originals.
 */

import { openSync, writeSync, fsyncSync, closeSync, renameSync, realpathSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { randomBytes } from "node:crypto";

export function safeRenameSync(src, dst) {
  try {
    renameSync(src, dst);
  } catch (err) {
    if (process.platform === "win32" && (err.code === "EEXIST" || err.code === "EPERM")) {
      try { unlinkSync(dst); } catch (_) {}
      renameSync(src, dst);
    } else {
      throw err;
    }
  }
}

/**
 * TOCTOU-safe atomic file write using O_CREAT|O_EXCL|O_WRONLY temp file in target dir.
 */
export function safeAtomicWrite(filePath, content, options = {}) {
  const mode = options.mode || 0o644;
  const encoding = options.encoding || "utf-8";
  const rejectSymlinks = options.rejectSymlinks !== false;

  if (existsSync(filePath)) {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      const realPath = realpathSync(filePath);
      if (rejectSymlinks) {
        throw new Error(`TOCTOU Guard: Refusing to write to symlink ${filePath} -> ${realPath}`);
      }
    }
  }

  const dir = dirname(filePath);
  const tempFile = join(dir, `.tmp-${basename(filePath)}-${randomBytes(6).toString("hex")}`);

  let fd;
  try {
    fd = openSync(tempFile, "wx", mode);
    writeSync(fd, content, null, encoding);
    if (options.sync !== false) {
      fsyncSync(fd);
    }
    closeSync(fd);
    fd = undefined;
    safeRenameSync(tempFile, filePath);
    return true;
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch (_) {}
    }
    try {
      if (existsSync(tempFile)) unlinkSync(tempFile);
    } catch (_) {}
    throw err;
  }
}
