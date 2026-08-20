import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The kit version, read once from package.json.
 *
 * Every module that needed to name the version used to hardcode it, and they
 * drifted: the CLI banner said 0.32.8 while the MCP server, the dashboard and
 * the config the wizard scaffolded all still claimed 0.29.x. Reading the
 * manifest is the only way the number cannot go stale.
 *
 * fileURLToPath keeps this correct on Windows, where a file:// URL pathname
 * starts with a drive-letter slash that fs cannot open.
 */
function readKitVersion() {
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
  } catch (_) {
    // A consumer may vendor src/ without the manifest; a placeholder is better
    // than an import-time crash in a library whose whole job is running gates.
    return "0.0.0";
  }
}

export const KIT_VERSION = readKitVersion();
