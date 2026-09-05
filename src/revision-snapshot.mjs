/**
 * Run the verification against the revision being judged.
 *
 * Finding F10: in `--mode staged` and `--mode committed` the gate read the
 * diff from the index or from a commit, and then executed the verification
 * command in the repository root — against the working tree. Staging a broken
 * file and restoring the healthy one on disk produced an APPROVED verdict for
 * a snapshot whose suite fails. The gate attested a revision it never ran.
 *
 * That is the one failure this tool exists to refuse, so the fix is not a
 * warning: the snapshot is materialised into a temporary directory and the
 * stages run there. If it cannot be materialised, the gate refuses and says
 * why — an unattested revision is not an approved one.
 *
 * ## Why a real worktree and not just `git checkout-index`
 *
 * `git checkout-index -a --prefix=` writes the *index*, which is exactly the
 * staged snapshot, and it is what the trial used as its control. But it copies
 * only tracked files: no `.git`, and — this is what matters in practice — no
 * `node_modules`, no `.venv`, no `target/`. A suite that needs its
 * dependencies would fail in the snapshot for reasons that have nothing to do
 * with the diff, which is the "rejecting correct work" failure this change has
 * to avoid.
 *
 * So: materialise the tracked snapshot, then link the ignored build/dependency
 * directories back in from the real root. Those are untracked by definition —
 * they are in `.gitignore` — so they cannot be part of the diff under review
 * and linking them cannot let the working tree's *source* influence the run.
 * `node_modules` holds third-party code the diff did not write; `src/` does
 * not get linked, ever.
 *
 * ## working-tree mode is unchanged
 *
 * In `--mode working-tree` the working tree *is* the revision under review, so
 * there is nothing to materialise and the run still happens in the root. Only
 * the two modes that were attesting something other than what they ran change
 * behaviour.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, symlinkSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Directories that hold installed dependencies or build output.
 *
 * Linked into the snapshot so a suite can find its toolchain. Every one of
 * these is conventionally gitignored — none is part of a reviewable diff — and
 * each is linked only when git agrees it is untracked, so a repository that
 * commits its `vendor/` gets the committed copy from the snapshot instead.
 */
const DEPENDENCY_DIRS = [
  "node_modules",
  ".venv",
  "venv",
  "vendor",
  "target",
  ".bundle",
  ".gradle",
  ".tox",
  ".pnpm-store",
  ".yarn",
  ".cargo",
  "Pods",
];

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf-8",
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Is this path untracked by git — i.e. not part of any reviewable diff? */
function isUntracked(root, rel) {
  try {
    const out = git(root, ["ls-files", "--error-unmatch", "--", rel]);
    return !out.trim();
  } catch (_) {
    return true;
  }
}

/**
 * Materialise the revision under review into a temporary directory.
 *
 * @param {object} opts
 * @param {string} opts.root
 * @param {"working-tree"|"staged"|"committed"|string} opts.mode
 * @param {string} [opts.commit] - resolved commit sha, for committed mode
 * @param {boolean} [opts.linkDependencies=true]
 * @returns {{
 *   ok: boolean,
 *   dir: string|null,
 *   describe: string,
 *   linked: string[],
 *   error: string|null,
 *   cleanup: () => void
 * }}
 *   `dir` is null and `ok` true only for working-tree mode, where the root is
 *   already the revision under review.
 */
export function materialiseRevision(opts = {}) {
  const root = opts.root || process.cwd();
  const mode = opts.mode || "working-tree";
  const linkDependencies = opts.linkDependencies !== false;

  if (mode === "working-tree" || mode === "working") {
    return {
      ok: true,
      dir: null,
      describe: "the working tree, which is the revision under review",
      linked: [],
      error: null,
      cleanup: () => {},
    };
  }

  let dir = null;
  const cleanup = () => {
    if (!dir) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
    dir = null;
  };

  try {
    dir = mkdtempSync(join(tmpdir(), "agentctl-snapshot-"));
  } catch (err) {
    return {
      ok: false,
      dir: null,
      describe: "",
      linked: [],
      error: `could not create a temporary directory to materialise the snapshot: ${err.message}`,
      cleanup: () => {},
    };
  }

  try {
    if (mode === "staged" || mode === "index") {
      // The index, verbatim. The trailing separator is required: git treats
      // the prefix as a literal string prepended to each path.
      git(root, ["checkout-index", "-a", "-f", `--prefix=${dir}${dir.endsWith("/") ? "" : "/"}`]);
    } else {
      const commit = opts.commit;
      if (!commit) throw new Error("no commit was resolved for committed mode");
      // `git archive | tar -x` is the portable way to write a commit's tree
      // into a plain directory without touching the repository's own index or
      // worktree list.
      const archive = execFileSync("git", ["archive", "--format=tar", commit], {
        cwd: root,
        maxBuffer: 512 * 1024 * 1024,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      execFileSync("tar", ["-x", "-C", dir], { input: archive, shell: false, stdio: ["pipe", "ignore", "pipe"] });
    }
  } catch (err) {
    const message = String(err?.stderr || err?.message || err).trim();
    cleanup();
    return {
      ok: false,
      dir: null,
      describe: "",
      linked: [],
      error: `could not materialise the ${mode} snapshot: ${message}`,
      cleanup: () => {},
    };
  }

  // Link dependencies back in. Best effort by design: a link that cannot be
  // made leaves the suite to fail honestly on a missing toolchain, which is a
  // visible failure rather than a silent substitution of the wrong code.
  const linked = [];
  if (linkDependencies) {
    for (const name of DEPENDENCY_DIRS) {
      const source = join(root, name);
      if (!existsSync(source)) continue;
      if (!isUntracked(root, name)) continue;
      const target = join(dir, name);
      if (existsSync(target)) continue;
      try {
        symlinkSync(source, target, "junction");
        linked.push(name);
      } catch (_) {
        try {
          symlinkSync(source, target);
          linked.push(name);
        } catch (_) {}
      }
    }

    // Nested dependency directories, one level down: monorepos put
    // `packages/*/node_modules` and src-layout Python projects put their
    // virtualenv beside the package.
    for (const parent of ["packages", "apps", "libs", "crates", "services"]) {
      const parentDir = join(root, parent);
      if (!existsSync(parentDir)) continue;
      let children = [];
      try {
        children = readdirSync(parentDir, { withFileTypes: true }).filter((d) => d.isDirectory());
      } catch (_) {
        continue;
      }
      for (const child of children) {
        for (const name of DEPENDENCY_DIRS) {
          const rel = `${parent}/${child.name}/${name}`;
          const source = join(root, parent, child.name, name);
          if (!existsSync(source)) continue;
          if (!isUntracked(root, rel)) continue;
          const target = join(dir, parent, child.name, name);
          if (existsSync(target)) continue;
          try {
            mkdirSync(join(dir, parent, child.name), { recursive: true });
            symlinkSync(source, target, "junction");
            linked.push(rel);
          } catch (_) {}
        }
      }
    }
  }

  return {
    ok: true,
    dir,
    describe:
      mode === "staged" || mode === "index"
        ? "the staged snapshot (the index), materialised"
        : `commit ${String(opts.commit || "").slice(0, 12)}, materialised`,
    linked,
    error: null,
    cleanup,
  };
}
