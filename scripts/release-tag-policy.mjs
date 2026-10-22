/**
 * Ensure a release tag is signed, verifiable and points to the commit being released.
 * Published version tags are immutable: never retarget or force-update them.
 */
import { execFileSync } from "node:child_process";

function git(root, args, { interactive = false } = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
  })?.trim() ?? "";
}

export function ensureSignedReleaseTag(root, tagName, message) {
  const head = git(root, ["rev-parse", "HEAD"]);
  const tags = git(root, ["tag", "--list", tagName, "--format=%(refname:short)"]);
  const exists = tags.split("\n").includes(tagName);
  let created = false;

  if (exists) {
    const target = git(root, ["rev-parse", tagName + "^{commit}"]);
    if (target !== head) {
      throw new Error("Release tag " + tagName + " already points to " + target.slice(0, 12) + ", not HEAD " + head.slice(0, 12) + ". Refusing to rewrite it.");
    }
    if (git(root, ["cat-file", "-t", "refs/tags/" + tagName]) !== "tag") {
      throw new Error("Release tag " + tagName + " is lightweight, not a signed annotated tag.");
    }
  } else {
    try {
      git(root, ["tag", "-s", tagName, "-m", message], { interactive: true });
      created = true;
    } catch {
      throw new Error("Could not create signed release tag " + tagName + ". Configure Git GPG/SSH tag signing first; nothing was pushed or published.");
    }
  }

  try {
    git(root, ["verify-tag", tagName]);
  } catch {
    // Never rewrite an existing tag, even if its signature is invalid.
    // A newly created local tag may be removed safely before publishing.
    if (created) git(root, ["tag", "-d", tagName]);
    throw new Error("Release tag " + tagName + " has no verifiable Git signature. Refusing to push or publish.");
  }

  return { tagName, commit: head, created, verified: true };
}
