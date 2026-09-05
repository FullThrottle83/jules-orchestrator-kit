# Phase 7 — written paths, second runs, and removal

## Direct scaffold

On the four runnable repositories, init added 18 new tracked files and modified the existing `.gitignore` (19 changed files in the scaffold commit). The exact per-repository `git diff --name-status` and ignore diff are in `phase7-<repo>-<round>-scaffold-manifest.log` in the archive.

- `.agent/config.yml`
- `.agent/jules.yml`
- `.agent/jules-queue/README.md`
- `.agent/prompts/A11y.md`
- `.agent/prompts/Alchemist.md`
- `.agent/prompts/Bolt.md`
- `.agent/prompts/Janitor.md`
- `.agent/prompts/Overseer.md`
- `.agent/prompts/Scribe.md`
- `.agent/prompts/Sentinel.md`
- `.agent/prompts/Spectator.md`
- `.agent/prompts/Task_Template.md`
- `.agent/rules/dynamic-guardrails.json`
- `.agent/rules/jules-protocol.md`
- `.agent/workflows/jules-review.md`
- `AGENTS.md`
- `SPEC.md`
- `CONSTRAINTS.md`

Init added these 11 ignore/exception entries in all four repositories (plus a comment and blank line). Pending Markdown task envelopes are ignored too, with an exception for the queue README:

```gitignore
.env
.agent/history/
.agent/state/
.agent/evidence/
.agent/handovers/
.agent/jules-queue/.state/
.agent/jules-queue/failed/
.agent/jules-queue/.processing/
.agent/jules-queue/completed/
.agent/jules-queue/*.md
!.agent/jules-queue/README.md
```

These are ignore patterns, not a claim that init created every listed directory or an `.env` file.

No `.github/workflows/agent-gate.yml` was created by plain init in these runs. The separate CI command did create it.

## Runtime files observed

- `.agent/evidence/EVD-<timestamp>-<id>.json`
- `.agent/evidence/manifest.v1.json`
- `.agent/state/flaky.jsonl`
- `.agent/state/telemetry-2026-09-05.jsonl`
- `.agent/state/telemetry-2026-09-05.head`
- `.agent/state/ledger-2026-09-05.jsonl` during the provider-loop attempt
- `.agent/state/checkpoints/` and checkpoint JSON files during dispatch attempts
- `.agent/jules-queue/TASK-<id>.md` for authored tasks

The scaffold created `.agent/` and its `prompts/`, `rules/`, `workflows/`, and `jules-queue/` subdirectories. Runtime work added `evidence/`, `state/`, and `state/checkpoints/`. Final inspection of both unchanged provider-loop fixtures also found the empty `.agent/jules-queue/completed/` directory; this is recorded separately because a files-only inventory omits it.

Exact date/ID-expanded paths are in each phase-6/phase-7 file inventory. Running `check` twice created new evidence IDs and appended runtime records, while the displayed verdict remained identical. Those changes are expected audit bookkeeping, not idempotency failures. Running `check --dry-run` also wrote evidence; that is F20 because the help explicitly promises otherwise.

## Optional integrations actually generated

On fresh Go fixtures:

- `.github/workflows/agent-gate.yml` from `agentctl ci init`
- `.gitlab-ci.agent-gate.yml` from `agentctl ci init --target gitlab`
- `.cursor/mcp.json` from `agentctl mcp init --target cursor`

Their full generated contents are recorded. No running dashboard/server, VS Code integration, or Claude Desktop home-directory configuration was created. The latter targets were help-inventoried but not exercised.

## What second runs did

For each of four ecosystems, in **two fresh directories**:

1. Init ran twice before committing.
2. Hashes of every scaffold file and the three root contract files plus `.gitignore` were identical.
3. The scaffold was committed.
4. The gate ran twice with the committed installation as base.
5. Verdict output was identical. Node/Python/Go passed; Rust reproduced its default generated-lint false red.
6. New runtime audit files were listed.

This was not an init-after-hand-edit overwrite test; no `--force` was used. Preserving all arbitrary preexisting customization and forced-overwrite policy was not exhaustively tested.

## Removal actually tested

Each selected upstream had no preexisting `.agent`, AGENTS.md, SPEC.md, or CONSTRAINTS.md. Therefore this concrete removal was safe in the trial:

1. `git revert --no-edit <scaffold-commit>` restored the tracked tree.
2. The ignored `.agent` runtime files remained and became visible as untracked after the added ignore rules were reverted.
3. `rm -rf .agent` removed those trial-owned files. On Go integration fixtures, the three explicitly generated integration paths were also removed.
4. `git diff --exit-code <original-upstream-SHA> HEAD` returned 0 and `git ls-files --others --exclude-standard` printed nothing, in all eight cases. A final independent comparison also confirmed identical original/restored Git tree object IDs (`undo-tree-confirmation.json`).
5. File-only cleanup left an empty `.github/workflows/` on both Go fixtures, invisible to Git status. `rmdir .github/workflows` then removed it in both; the preexisting `.github/FUNDING.yml` and `.github/dependabot.yml` were preserved. These final directory-removal commands were separately recorded.

**Do not blindly apply that rm command to a repository with preexisting agent configuration.** Restore only files/ignore entries added by this installation, and preserve user-owned contents and unrelated IDE/workflow configuration. The exact commands for these disposable fixtures are in `harness/phase7.py` and their execution metadata.

`agentctl clean --dry-run` reported stale-worktree cleanup; it is not an uninstall operation. No complete removal instructions were found in the installed README or the checked docs. Global npm uninstall was not run, because the CLI was needed throughout the trial.

## Attribution limit

Host commands can create their ordinary `target/`, build products, compiler caches, Python caches, `.tox`, `.venv`, and dependency caches. Some already existed from the pristine baseline checks. This inventory does not falsely attribute those manual setup outputs to init, nor claim a syscall-level audit of every filesystem write. Global npm/toolchain installation paths are outside repository undo; no agent credentials were written by this trial.
