# Releasing

Releases are maintainer operations, separate from normal documentation PRs. A
documentation change does not need a version bump.

The release has two halves. A pull request puts the version change on `main`.
`npm run release` then verifies that exact `main` commit, creates a signed tag and
a GitHub Release, and the GitHub Release triggers the npm publish. Branch and tag
rules that GitHub should enforce around this are in
[repository protection](repository-protection.md); the release works under them
without an administrator bypass.

## Before the first release from a machine

Tag creation uses `git tag -s`, and the script then runs `git verify-tag`. Both need
a signing key and a list of trusted keys:

```bash
git config gpg.format ssh
git config user.signingkey /path/to/signing_key.pub     # or a GPG key id
git config gpg.ssh.allowedSignersFile /path/to/allowed_signers   # ssh only
```

Check it before release day: `git log -1 --show-signature` on a signed commit must say
"Good" signature, and `git config --get gpg.ssh.allowedSignersFile` must print a path.
If the key cannot be loaded, `git tag -s` prints an error, still leaves an
**unsigned** annotated tag, and `git verify-tag` then fails with a bare "Command
failed". Nothing is pushed or published. Delete the local tag
(`git tag -d vX.Y.Z`; it was never pushed), fix the key and rerun. The script never
moves or reuses an existing tag.

## 1. Release pull request

1. Move the `[Unreleased]` entries in `CHANGELOG.md` under `## [X.Y.Z] - YYYY-MM-DD`
   and leave an empty `[Unreleased]`. The script publishes this section as the
   GitHub Release notes; if it is missing it falls back to the title only.
   If versions were skipped, say so there.
2. Bump `package.json` and `package-lock.json` consistently.
3. Update the version references `jules:doc-sync` checks: README (current release and
   the pinned `npx ...@X.Y.Z` examples), `EXAMPLES.md`, `ROADMAP_V1.md` (Current Stable
   and the shipped-milestones range) and the supported-version table in `SECURITY.md`.
   Regenerate `docs/COMMAND_REFERENCE.md` with
   `node scripts/generate-command-reference.mjs` if commands changed; never edit it
   by hand.
4. Run `npm test`, `npm run lint`, `npm run jules:doc-sync`, `npm run jules:rules-lint`,
   `npm run guard-reach`, `npm run package-integrity` and
   `node scripts/jules-self-audit.mjs --preflight`.
5. Open the pull request. `package.json` and `package-lock.json` are protected
   paths, so Agent Scope Guard and the self-audit fail until a maintainer reads the
   exact diff and applies `allow-p:<head SHA>` (see
   [waivers](repository-protection.md#waivers)). Any further push needs a new label.
6. Merge it, then wait for the push-triggered CI on the merge commit on `main`.

## 2. Tag and GitHub Release

From a clean checkout of exactly that commit:

```bash
git switch main && git pull --ff-only
git status --porcelain          # must print nothing
npm run release
```

The script stops at the first failing step, and each step is bound to the HEAD it
read at the start (it aborts with "HEAD changed" otherwise):

1. clean `main` and no untracked files;
2. `npm test`; `guard-reach`; `package-integrity`; documentation sync;
3. CI: every workflow run for this exact HEAD is completed and green
   (`gh run list`). `--skip-ci-check` exists for a machine without `gh`; it is not
   a substitute for checking the commit yourself;
4. release notes from the changelog;
5. a signed tag at HEAD: an existing tag must already point at HEAD and pass
   `git verify-tag`; otherwise it is created and verified. A tag on another commit
   is an error;
6. `git push origin <HEAD sha>:refs/heads/main`, then the tag. When `main` already
   contains HEAD the first push changes nothing;
7. `gh release create` with the notes. A failure here exits non-zero. Inspect the
   remote state (`git ls-remote --tags origin`, `gh release list`) before rerunning.

## 3. npm publish

Creating the GitHub Release triggers `.github/workflows/publish.yml` (event
`published` only; there is no manual dispatch). The job checks that `package.json`
matches the tag, reruns `npm test`, `guard-reach` and `package-integrity`, and runs
`npm publish --provenance --access public` with the repository secret `NPM_TOKEN`.
It does not check the tag signature. A failed run can be re-run from the Actions tab.

## 4. After publishing

```bash
npm view jules-orchestrator-kit version dist-tags gitHead     # version X.Y.Z, latest -> X.Y.Z, gitHead == tag commit
git verify-tag vX.Y.Z                                          # Good signature
git rev-parse vX.Y.Z^{commit}                                  # same commit as gitHead
gh release view vX.Y.Z --json isDraft,isPrerelease,tagName
npx --yes jules-orchestrator-kit@X.Y.Z --version               # from an empty directory
```

Also confirm the provenance attestation on the npm package page and that the
signed tag shows "Verified" on GitHub.

## When something fails

| Where | State | What to do |
| :--- | :--- | :--- |
| Release script before step 5 | Nothing created | Fix and rerun. |
| Tag creation or verification | Possibly an unsigned local tag, nothing pushed | `git tag -d vX.Y.Z`, fix the signing setup, rerun. |
| Push of the tag | Tag local only | Rerun; the existing verified tag is reused. |
| `gh release create` | Tag pushed, no release | Check `gh release list`; create the release for the existing tag. Do not re-tag. |
| `publish.yml` fails | Release and tag exist, nothing on npm | Fix the cause (for example an expired `NPM_TOKEN`) and re-run the workflow from the Actions tab. |
| Wrong version published | npm versions are immutable | Publish the next patch version and deprecate the bad one with `npm deprecate`. Do not move the tag. |

## Go / no-go

Go only when all of these hold; any other state is a no-go.

- `main` is at the commit that contains the version change, the working tree is
  clean, and `git rev-parse HEAD` equals `git rev-parse origin/main`.
- All CI check runs for that SHA are green: six `audit-and-test` jobs, `doc-sync`
  and zizmor.
- The release pull request's waiver was applied to its final head SHA by a human who
  read the diff.
- The signing key loads and `git verify-tag` works on a previous tag.
- `CHANGELOG.md` has the `[X.Y.Z]` section and states upgrade-relevant changes.
- Private vulnerability reporting is enabled, so the link in `SECURITY.md` works.
- Nothing else is open that you intend to ship in this version.

The release script supports `--skip-ci-check` when `gh` is unavailable; this is not
an alternative to verifying CI for the release commit. See `scripts/release.mjs`
for the executable release procedure.
