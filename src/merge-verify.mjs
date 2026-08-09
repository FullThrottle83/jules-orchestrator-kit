import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

/**
 * Syntax Verification Chain validating merged output via target runtime tools.
 * @param {string} mergedText
 * @param {string} fileName
 * @param {string} [root=process.cwd()]
 * @returns {{ ok: boolean, tool: string, error?: string }}
 */
export function mergeVerifyChain(mergedText, fileName, root = process.cwd()) {
  const ext = extname(fileName).toLowerCase();
  const base = basename(fileName) || `temp_file${ext}`;
  const tempDir = join(tmpdir(), `merge-verify-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  
  mkdirSync(tempDir, { recursive: true });
  const tempFilePath = join(tempDir, base);

  try {
    writeFileSync(tempFilePath, mergedText, "utf8");

    let cmd = "";
    let args = [];
    let tool = "";

    if (ext === ".py") {
      cmd = "python3";
      args = ["-m", "py_compile", tempFilePath];
      tool = "python3 -m py_compile";
    } else if (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts") {
      const hasTsConfig = existsSync(join(root, "tsconfig.json"));
      if (hasTsConfig) {
        cmd = "npx";
        args = ["tsc", "--noEmit", tempFilePath];
        tool = "tsc --noEmit";
      } else {
        cmd = "node";
        args = ["--check", tempFilePath];
        tool = "node --check";
      }
    } else {
      // JS, MJS, CJS or default
      cmd = "node";
      args = ["--check", tempFilePath];
      tool = "node --check";
    }

    const res = spawnSync(cmd, args, { encoding: "utf8" });
    const ok = res.status === 0;

    return {
      ok,
      tool,
      ...(ok ? {} : { error: res.stderr || res.stdout || `Process exited with code ${res.status}` }),
    };
  } finally {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
