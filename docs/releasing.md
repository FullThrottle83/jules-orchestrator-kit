# Releasing

Releases are maintainer operations, separate from normal documentation PRs.

1. Add a `CHANGELOG.md` entry, then bump `package.json` and the lockfile consistently.
   Update version references in README, roadmap and security documentation.
2. Run tests, lint, doc-sync, rules-lint, guard-reach and package-integrity.
3. Integrate the reviewed release commit into `main` and wait for CI to verify that
   exact commit before tagging it.
4. Run `npm run release`. The script checks tests, guard reachability, package
   integrity, documentation and the CI matrix for HEAD, then creates the version
   tag and GitHub Release. Follow the signing policy in `CONTRIBUTING.md`.

The release script supports `--skip-ci-check` when `gh` is unavailable; this is not
an alternative to verifying CI for the release commit. See `scripts/release.mjs`
for the executable release procedure.
