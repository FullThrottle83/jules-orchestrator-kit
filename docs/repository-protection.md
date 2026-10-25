# Repository protection

What GitHub should enforce for this repository, how that relates to the checks in
`.github/workflows/`, and how a release works under it. GitHub settings are not
stored in the repository, so this page is the written record to compare against.
Nothing here is applied by code in the repository.

## Observed state (2026-10-25)

Read-only API calls, as the repository owner:

| Setting | Observed | Command |
| :--- | :--- | :--- |
| Branch protection on `main` | none (404 "Branch not protected") | `gh api repos/FullThrottle83/jules-orchestrator-kit/branches/main/protection` |
| Rulesets | none (`[]`) | `gh api repos/FullThrottle83/jules-orchestrator-kit/rulesets` |
| Private vulnerability reporting | disabled | `gh api repos/FullThrottle83/jules-orchestrator-kit/private-vulnerability-reporting` |
| Secret scanning, push protection | enabled | `gh api repos/FullThrottle83/jules-orchestrator-kit --jq .security_and_analysis` |
| `NPM_TOKEN` | repository secret, no deployment environment | `gh secret list`, `gh api repos/FullThrottle83/jules-orchestrator-kit/environments` |

Until the settings below are applied, "`main` is protected" describes a convention
followed by the maintainer, not something GitHub enforces. `SECURITY.md` points
reporters at private security advisories, which only work once private
vulnerability reporting is enabled.

## Recommended minimum for the preview

Three settings, in this order. All are reversible by a repository admin.

1. **Enable private vulnerability reporting.** Settings > Code security >
   "Private vulnerability reporting", or `gh api -X PUT repos/FullThrottle83/jules-orchestrator-kit/private-vulnerability-reporting`.
2. **Ruleset for `main`.**
3. **Ruleset for `v*` tags.**

Apply the rulesets after the protected-path manifest update has merged and a
waiver has been exercised once (see [Waivers](#waivers)), so the first required
`scope-guard` run you depend on has already been seen to go green.

### `main`

```json
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false,
        "allowed_merge_methods": ["merge", "squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "scope-guard", "integration_id": 15368 },
          { "context": "audit-and-test (ubuntu-latest, 22.x)", "integration_id": 15368 },
          { "context": "audit-and-test (ubuntu-latest, 24.x)", "integration_id": 15368 },
          { "context": "audit-and-test (macos-latest, 22.x)", "integration_id": 15368 },
          { "context": "audit-and-test (macos-latest, 24.x)", "integration_id": 15368 },
          { "context": "audit-and-test (windows-latest, 22.x)", "integration_id": 15368 },
          { "context": "audit-and-test (windows-latest, 24.x)", "integration_id": 15368 },
          { "context": "doc-sync", "integration_id": 15368 },
          { "context": "GitHub Actions Security Audit (zizmor)", "integration_id": 15368 }
        ]
      }
    }
  ]
}
```

Apply with `gh api -X POST repos/FullThrottle83/jules-orchestrator-kit/rulesets --input main.json`.

- **Check names and source.** The names are the check-run names GitHub shows on a
  commit; `integration_id` 15368 is the GitHub Actions app, which produced every
  one of them on `4b5e643`. List them with
  `gh api repos/FullThrottle83/jules-orchestrator-kit/commits/<sha>/check-runs --jq '.check_runs[]|[.name,.app.id]|@tsv'`.
  `scope-guard` only exists on pull requests, so it never appears on a commit
  already on `main`; read its name from a PR with `gh pr checks <n>`.
  A matrix job renamed in `jules-audit.yml` (OS or Node version) makes the old
  name a required check that never reports, which blocks every merge: change the
  ruleset in the same step.
- **No approving review is required.** GitHub does not let an author approve their
  own pull request, so a required review on a one-maintainer project either blocks
  all merges or gets bypassed. The ruleset still forces every change through a pull
  request with green checks and keeps history intact (no force-push, no
  deletion). Raise `required_approving_review_count` to `1` when a second
  maintainer exists.
- **`strict_required_status_checks_policy` is `false`.** `true` forces every open
  PR to be re-based and re-run after each merge, which costs six matrix jobs per
  PR for a solo maintainer. The release script compensates: it refuses to
  release unless CI is green for the exact `main` commit being tagged.
- **No bypass actors.** See [Release](#release).
- **Merge methods.** The history uses merge commits. Rebase merging is left out
  because it changes the SHAs that CI results and waiver labels are bound to.
- **Optional: `{ "type": "required_signatures" }`.** `CONTRIBUTING.md` requires
  signed commits. Add the rule only after confirming every contributor's signing key is
  registered with GitHub; an agent commit that GitHub shows as "Unverified"
  would otherwise block its PR. Commits created by GitHub's web merge are signed by
  GitHub.

### `v*` tags

```json
{
  "name": "release-tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    { "type": "update" },
    { "type": "deletion" },
    { "type": "non_fast_forward" }
  ]
}
```

Creation is deliberately not restricted: `npm run release` has to create and push
the tag. A pushed release tag can then no longer be moved or deleted, which matches
the script's "never move a tag" rule. A mistaken tag is handled by publishing the next
patch version, not by reusing the number; an admin can still disable the ruleset
for a genuine emergency. Existing tags, including the unsigned historic `v0.76.1`,
become immutable too.

## What the checks do

- **Agent Scope Guard** (`agent-scope-guard.yml`, job `scope-guard`) runs on
  `pull_request` with types `opened`, `synchronize`, `reopened`, `labeled`,
  `unlabeled`. It checks out the base branch, reads `.agent/protected-paths.json`
  from the base commit and diffs `base..head` names only; the PR head is never
  executed. A pull request cannot change the list that judges it.
- **Self-audit** is the `audit-and-test (ubuntu-latest, 22.x)` job on
  `pull_request` events. It runs PR head code and applies the same SHA-bound
  waiver rule (`resolveProtectedWaiverFromLabels`). It is a required check
  independent of `scope-guard`, so a protected-path change needs the waiver to
  satisfy both.
- Both workflows re-run on `labeled`, which is what makes a waiver label take
  effect without a new push. A label is read from the event that triggered the
  run: re-running an old failed run from the Actions tab does not see a label
  added afterwards; use the run that the `labeled` event started.

## Waivers

A waiver is the label `allow-p:<40-hex head SHA>`. Only a label naming the exact
current head commit is honoured; the unbound `allow-p` and legacy
`allow-protected-paths` labels are ignored, and a new push makes the label stale.

What it does and does not establish:

| | Self-applied waiver | Independent review |
| :--- | :--- | :--- |
| Who | The maintainer who wrote or accepted the change | A second person, after reading the diff |
| Stops a later push riding on the approval | Yes (SHA-bound) | Yes (with "dismiss stale reviews on push") |
| Stops a compromised or careless author | No | Yes |
| Available to a solo project | Yes | No |

On a solo project the waiver is an explicit, auditable acknowledgement that a human
looked at the exact commit that touches the control plane. It is not a second pair
of eyes, and this page does not claim it is. Anyone with triage permission or above
can apply a label, so keep collaborator roles minimal; consider requiring an
independent review for changes under `.agent/protected-paths.json`, `.github/`
and `scripts/release*.mjs` once there is a second maintainer.

Procedure for the person applying one:

1. Read the diff for the exact head SHA (`gh pr view <n> --json headRefOid`).
2. Create the label if needed (`gh label create "allow-p:<sha>"`) and apply it.
3. Confirm both `scope-guard` and the ubuntu 22.x `audit-and-test` job re-ran and
   passed on that SHA.
4. Merge. Do not push to the branch first; if you must, repeat from step 1.

## Release

The release does not need an admin bypass.

`scripts/release.mjs` requires a clean local `main`, verifies tests, guards, package
integrity, documentation and CI for that exact HEAD, creates and verifies a signed
tag at that commit, and then runs `git push origin <HEAD sha>:refs/heads/main` followed
by `git push origin refs/tags/<tag>`.

- If the release commit already reached `main` through a merged pull request (the
  procedure in [releasing](releasing.md)), `<HEAD sha>` is the current tip of
  `origin/main`. A push that changes no ref sends nothing to the server: git prints
  "Everything up-to-date" and no ref update exists for a ruleset to evaluate. This
  was checked against a bare repository whose `pre-receive` hook rejects every
  update: the same-SHA push succeeded and a push of a new commit was rejected. It
  has not been run against GitHub's ruleset engine; the first release under the
  rulesets is that test, and a throwaway private repository with the same rulesets
  is a safe place to run `git push origin <tip sha>:refs/heads/main` beforehand.
- If HEAD is not already on `origin/main` (an unmerged local commit), the push is
  rejected by the pull-request rule. That is the intended outcome. The signed tag
  has already been created locally by then; nothing was published and a rerun
  after merging reuses it.
- The tag push creates a new ref, which the `v*` ruleset allows.
- `gh release create` is not a push to a protected ref.

The old practice of pushing the release commit straight to `main` is the one thing
that stops working. The release commit (version, changelog, documentation) goes
through a pull request like any other change. It edits `package.json` and
`package-lock.json`, so it needs a waiver as before.

Possible hardening, not required and not implemented (it would touch a protected
file and needs its own review): have `readReleaseHead` run
`git fetch origin main` and fail early when `HEAD` differs from `origin/main`, so a
release started from an unmerged commit stops before step 3 rather than at the push.

## What this does not cover

- **Publishing.** `publish.yml` runs on any published GitHub Release and publishes
  with the repository secret `NPM_TOKEN`. It checks that the tag matches the
  `package.json` version but not that the tag is signed or reachable from `main`. Anyone who can create a release can publish. Cheap
  options, in order of effort: a `release` deployment environment with the
  maintainer as required reviewer (a deliberate pause, not independent review), or
  npm trusted publishing, which removes the long-lived token.
- **Account compromise.** Rulesets protect against mistakes and unreviewed pushes.
  An attacker holding the owner's session can edit the rulesets. Protect the
  account with a hardware security key.
- **Dependabot alerts** are disabled; the package has no runtime dependencies and
  two development dependencies (ESLint and globals).
- Three workflow registrations without a file on `main` (`pr40-refactor-once`,
  `release-metadata-once`, `Publish v0.73.1 once`) are still listed by GitHub.
  They cannot run, but they appear in the Actions list.

## Rollback

`gh api -X DELETE repos/FullThrottle83/jules-orchestrator-kit/rulesets/<id>`
(ids from `gh api repos/FullThrottle83/jules-orchestrator-kit/rulesets`), or set the
ruleset to "Disabled" in Settings > Rules > Rulesets.
