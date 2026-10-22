# Releasing

Releases are maintainer operations, separate from normal documentation PRs.

1. Add a `CHANGELOG.md` entry, then bump `package.json` and the lockfile consistently.
   Update version references in README, roadmap and security documentation.
2. Run tests, lint, doc-sync, rules-lint, guard-reach and package-integrity.
3. Integrate the reviewed release commit into `main` and wait for CI to verify that
   exact commit before tagging it.
4. Configure GPG or SSH tag signing on the maintainer machine before release.
   Run `npm run release` only after the reviewed commit has passed CI. The
   script checks tests, guard reachability, package integrity, documentation and
   the CI matrix for HEAD; it then creates a **signed annotated tag**, verifies
   the signature with `git verify-tag`, and only then pushes and publishes the
   GitHub Release. Follow the signing policy in `CONTRIBUTING.md`.

### Tag-signing preflight

- GPG: configure a signing key with `git config user.signingkey <KEY-ID>` and
  ensure the matching public key is available for verification.
- SSH: use `git config gpg.format ssh`, configure `user.signingkey` to the
  local signing key, and configure `gpg.ssh.allowedSignersFile` with the
  trusted public-key principal needed by `git verify-tag`. Keep private
  signing keys out of repositories and agent execution environments.
- Verify an existing tag locally with `git verify-tag vX.Y.Z`. Unsigned,
  unverifiable, lightweight or moved version tags are rejected. The release
  command never force-updates an existing tag.

If signing or verification fails, the release aborts **before** pushing a tag
or creating a GitHub Release. Do not rewrite previously published tags to
retroactively satisfy the signing policy.

The release script supports `--skip-ci-check` when `gh` is unavailable; this is not
an alternative to verifying CI for the release commit. See `scripts/release.mjs`
for the executable release procedure.
