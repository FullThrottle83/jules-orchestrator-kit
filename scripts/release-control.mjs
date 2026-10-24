import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const output = (run, root, args) => String(run("git", args, {
  cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
})).trim();

/** Resolve the clean main commit that all release checks must verify. */
export function readReleaseHead(root, run = execFileSync) {
  if (output(run, root, ["branch", "--show-current"]) !== "main") {
    throw new Error("Release requires the main branch.");
  }
  if (output(run, root, ["status", "--porcelain"])) {
    throw new Error("Release requires a clean working tree, including untracked files.");
  }
  return output(run, root, ["rev-parse", "HEAD"]);
}

/** Create a signed tag or validate an existing one. Never move a release tag. */
export function ensureReleaseTag(root, { tagName, headSha, packageName }, run = execFileSync) {
  if (readReleaseHead(root, run) !== headSha) {
    throw new Error("HEAD changed after release verification; rerun all checks.");
  }
  let exists = true;
  try {
    output(run, root, ["show-ref", "--verify", "--quiet", `refs/tags/${tagName}`]);
  } catch (err) {
    if (err.status !== 1) throw err;
    exists = false;
  }
  if (!exists) {
    run("git", ["tag", "-s", tagName, "-m", `${packageName} ${tagName}`, headSha], { cwd: root, stdio: "inherit" });
  }
  const taggedSha = output(run, root, ["rev-parse", "--verify", `refs/tags/${tagName}^{commit}`]);
  if (taggedSha !== headSha) {
    throw new Error(`Tag ${tagName} does not point to the verified HEAD; refusing to move it.`);
  }
  output(run, root, ["verify-tag", tagName]);
}

/** Push the verified commit rather than resolving a moving local main again. */
export function pushReleaseRefs(root, { headSha, tagName }, run = execFileSync) {
  if (readReleaseHead(root, run) !== headSha) {
    throw new Error("HEAD changed after release verification; rerun all checks.");
  }
  run("git", ["push", "origin", `${headSha}:refs/heads/main`], { cwd: root, stdio: "inherit" });
  run("git", ["push", "origin", `refs/tags/${tagName}`], { cwd: root, stdio: "inherit" });
}

/** Propagate publication failures and always remove temporary release notes. */
export function createGithubRelease(root, { tagName, notes }, run = execFileSync) {
  const dir = mkdtempSync(join(tmpdir(), "jok-release-notes-"));
  try {
    const notesFile = join(dir, "notes.md");
    writeFileSync(notesFile, notes, "utf-8");
    run("gh", ["release", "create", tagName, "--title", tagName, "--notes-file", notesFile], {
      cwd: root, stdio: "inherit",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
