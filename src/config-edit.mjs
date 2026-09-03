import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { PROFILE_NAMES } from "./profiles.mjs";
import { PROVIDER_DESCRIPTORS } from "./provider-readiness.mjs";

/**
 * In-place edits to the repository's agent manifest.
 *
 * Surgical text edits rather than parse-and-reserialise: the kit's YAML reader
 * is a subset parser, so round-tripping the file through it would drop every
 * comment the wizard wrote and any key the subset does not model. The manifest
 * is a file a human maintains; a tool that rewrites it must leave the rest of
 * it alone.
 */

/**
 * The manifest this repository uses, or null when it has none.
 * @param {string} root
 * @returns {string|null}
 */
function findManifest(root) {
  return [join(root, ".agent", "config.yml"), join(root, ".agent", "jules.yml")].find((f) => existsSync(f)) || null;
}

/**
 * Rewrite the manifest from a line transform, atomically.
 * @param {string} file
 * @param {(lines: string[]) => string[]} transform
 * @returns {{ ok: boolean, file?: string, error?: string }}
 */
function editManifest(file, transform) {
  let text;
  try {
    text = readFileSync(file, "utf-8");
  } catch (err) {
    return { ok: false, error: `Could not read ${file}: ${err.message}` };
  }

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = transform(text.split(/\r?\n/));

  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, lines.join(eol), "utf-8");
    renameSync(tmp, file);
  } catch (err) {
    return { ok: false, error: `Could not write ${file}: ${err.message}` };
  }
  return { ok: true, file };
}

/**
 * Set the top-level `provider:` key.
 *
 * `agentctl providers` used to point at `agentctl init --provider <name>` to
 * change providers, which restarts the whole onboarding wizard — plan question
 * and all — to edit one line. This is that one line.
 *
 * @param {string} root
 * @param {string} provider
 * @returns {{ ok: boolean, file?: string, error?: string }}
 */
export function setConfigProvider(root, provider) {
  const name = String(provider || "").trim();
  if (!name) {
    return { ok: false, error: `Provider name required. Known presets: ${Object.keys(PROVIDER_DESCRIPTORS).join(", ")}` };
  }
  if (!/^[\w.-]+$/.test(name)) {
    return { ok: false, error: `Invalid provider name '${provider}'.` };
  }

  const file = findManifest(root);
  if (!file) return { ok: false, error: "No .agent/config.yml found. Run `agentctl init` first." };

  return editManifest(file, (lines) => {
    const idx = lines.findIndex((l) => /^provider:\s*/.test(l));
    if (idx >= 0) {
      lines[idx] = `provider: ${name}`;
      return lines;
    }
    // Keep it near the top where the wizard writes it, after `version:` if
    // present, so a hand-read manifest still leads with what it is.
    const versionIdx = lines.findIndex((l) => /^version:\s*/.test(l));
    lines.splice(versionIdx >= 0 ? versionIdx + 1 : 0, 0, `provider: ${name}`);
    return lines;
  });
}

/**
 * Set `verify.profile` in the repository's manifest, in place.
 *
 * @param {string} root
 * @param {string} profile - one of {@link PROFILE_NAMES}
 * @returns {{ ok: boolean, file?: string, error?: string }}
 */
export function setVerificationProfile(root, profile) {
  const name = String(profile || "").toLowerCase();
  if (!PROFILE_NAMES.includes(name)) {
    return { ok: false, error: `Unknown profile '${profile}'. Choose one of: ${PROFILE_NAMES.join(", ")}` };
  }

  const file = findManifest(root);
  if (!file) {
    return { ok: false, error: "No .agent/config.yml found. Run `agentctl init` first." };
  }

  return editManifest(file, (lines) => {

    // Find the `verify:` mapping and the `profile:` key nested directly under it.
    let verifyIdx = -1;
    let profileIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^verify:\s*$/.test(lines[i])) {
        verifyIdx = i;
        for (let j = i + 1; j < lines.length; j++) {
          // A non-indented, non-blank line ends the block.
          if (lines[j].trim() !== "" && !/^\s/.test(lines[j])) break;
          if (/^\s+profile:\s*/.test(lines[j])) {
            profileIdx = j;
            break;
          }
        }
        break;
      }
    }

    if (profileIdx >= 0) {
      const indent = lines[profileIdx].match(/^(\s*)/)[1];
      lines[profileIdx] = `${indent}profile: ${name}`;
    } else if (verifyIdx >= 0) {
      lines.splice(verifyIdx + 1, 0, `  profile: ${name}`);
    } else {
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
      lines.push("verify:", `  profile: ${name}`, "");
    }
    return lines;
  });
}
