# Releasing

Releases are maintainer operations, separate from normal documentation PRs.

1. Add a `CHANGELOG.md` entry, then bump `package.json` and the lockfile consistently.
   Update version references in README, roadmap and security documentation.
2. Run tests, lint, doc-sync, rules-lint, guard-reach and package-integrity.
3. Integrate the reviewed release commit into `main` and wait for CI to verify that
   exact commit before tagging it.
4. Run `npm run release` from a clean `main` checkout. The script checks tests,
   guard reachability, package integrity, documentation and the CI matrix for
   that exact HEAD, then creates a signed tag and GitHub Release. Configure a
   signing key and trusted verification keys per `CONTRIBUTING.md` first.
   An existing tag must resolve to the verified HEAD and pass `git verify-tag`;
   the script never moves an existing tag. Tag creation and the push to `main`
   use the verified commit SHA explicitly. If HEAD changes during checks, rerun
   verification. GitHub Release creation errors stop the script with a nonzero
   exit code; inspect the remote state before retrying a partially completed run.

The release script supports `--skip-ci-check` when `gh` is unavailable; this is not
an alternative to verifying CI for the release commit. See `scripts/release.mjs`
for the executable release procedure.
