import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { PROFILE_NAMES } from "./profiles.mjs";

/**
 * Set `verify.profile` in the repository's manifest, in place.
 *
 * A surgical text edit rather than a parse-and-reserialise: the kit's YAML
 * reader is a subset parser, so round-tripping the file through it would drop
 * every comment the wizard wrote and any key the subset does not model. The
 * manifest is a file a human maintains; a tool that rewrites it must leave the
 * rest of it alone.
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

  const candidates = [join(root, ".agent", "config.yml"), join(root, ".agent", "jules.yml")];
  const file = candidates.find((f) => existsSync(f));
  if (!file) {
    return { ok: false, error: "No .agent/config.yml found. Run `agentctl init` first." };
  }

  let text;
  try {
    text = readFileSync(file, "utf-8");
  } catch (err) {
    return { ok: false, error: `Could not read ${file}: ${err.message}` };
  }

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);

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

  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, lines.join(eol), "utf-8");
    renameSync(tmp, file);
  } catch (err) {
    return { ok: false, error: `Could not write ${file}: ${err.message}` };
  }

  return { ok: true, file };
}
