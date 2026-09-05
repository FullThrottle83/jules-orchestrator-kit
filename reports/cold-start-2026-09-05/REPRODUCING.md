# Evidence and reproduction guide

Start with [REPORT.md](REPORT.md). The findings are grouped; they are not a count of every individual red/green command. [MATRIX.md](MATRIX.md) contains all corrected local matrix cells and the unsuccessful silence attacks. [README-INVENTORY.md](README-INVENTORY.md), [ESCAPE-HATCHES.md](ESCAPE-HATCHES.md), and [FILES-AND-UNDO.md](FILES-AND-UNDO.md) give the detailed inventories.

## Verify and inspect the delivery

From this directory:

```sh
sha256sum -c SHA256SUMS
PYTHONDONTWRITEBYTECODE=1 python3 harness/validate_delivery.py
```

- `evidence/` holds the terminal logs quoted by the main report, with available command metadata.
- `excerpts.json` gives each quote's source path, one-based inclusive line range, SHA-256 of the full recording, and SHA-256 of the extracted text. The latter omits only terminal newline characters, not ANSI escapes or other contents.
- `evidence.tar.gz` contains the complete recorded evidence corpus: logs, command/cwd/exit/TTY/timing metadata, fixture diffs, untracked-file contents, result rows, setup and help captures, controls, and discarded probes. It does not contain dependency trees or credentials.
- `evidence-index.json` inventories every regular file in that archive with its byte count and SHA-256. The archive has one top-level `evidence/` directory. Extract into an empty directory; do not unpack over active replay logs.
- `baselines/manifest.json` pins all four runnable upstream and scaffold commits. The Git bundles include those commits, their history, and original base refs. `p-limit-package-lock.json` pins the Node dependency installation used by the trial.

Hashes establish consistency of this delivery, not independent proof of the experiments' truth. The terminal recordings and replayable fixtures are supplied so the conclusions can be checked.

## Replay safely

**Use a disposable scratch root. The harness intentionally starts each case with `rm -rf` of its named case directory. Never select a scratch root containing work you need.** It neither deletes the kit checkout nor pushes branches or calls a paid provider. Experiments make detached fixture commits inside the scratch repositories.

Match the report's OS/toolchain and package-manager pins. Install the CLI globally, as in the trial:

```sh
npm install -g jules-orchestrator-kit@0.71.0
agentctl --version
```

The original trial's actual installation command was the requested unversioned `npm install -g jules-orchestrator-kit`; it resolved to 0.71.0. The explicit version above prevents a later replay from silently testing a different release.

For a candidate fixed release, install that release globally instead. **`replay.py` does not install or replace agentctl.** It uses whichever globally installed executable is on PATH.

```sh
export REPORT=/absolute/path/to/cold-start-2026-09-05
export COLD_START_ROOT=/absolute/path/to/disposable-cold-start-replay
export PYTHONDONTWRITEBYTECODE=1
python3 "$REPORT/replay.py" prepare
python3 "$REPORT/replay.py" F10
python3 "$REPORT/replay.py" F10 --expect-fixed
```

Preparation restores source and exact scaffold baselines from the bundles, preserves the original upstream base refs, installs pinned Node dependencies with `npm ci`, and runs `uv sync --locked`. It does not require GitHub to retrieve the four fixture repositories; package installation and the host's pre-commit hooks may still need registry/network access or warm caches. Go, Rust/clippy, uv, Python tooling, and native utilities must already be installed. The trial's alternate Go/Rust distributions are described in the setup records.

`F01` through `F22` select primary regression cases and selected variant sets. Two fresh case directories are the default; `--round 1` or `--round 2` selects one. The original exact phase commands are also available in the archive's `*.meta.json` files and the included `harness/` drivers. The report's literal `rm -rf` recipes use the original recorded root, `/home/user/cold-start-trial`; adjust those paths when using another root. Use a simple absolute path without spaces for the older whole-phase drivers. `help_inventory.py` retains its original fixed root.

Without `--expect-fixed`, the utility records the reproduction; a zero utility exit is **not** a passing product verdict. Read the native/gate exits in its records. With `--expect-fixed`, zero means the selected regression predicate passed in every requested run; current defects should return 1. These are targeted falsifiers, not a complete certification of a future fix. In particular, documentation/output predicates still need human review, and grouped findings have additional controls in the full archive.

The primary F22 recipe reruns the full init/check/removal experiment through `harness/phase7.py`; its fix predicate checks for removal documentation in the installed README. Provider-dependent controls remain unverified, even if an offline regression predicate passes.

## Replay-tool validation performed before delivery

The original case drivers executed the full reported matrices and controls twice. Separately, while packaging:

- F13, F14, F15, F17, F21, and F22 fix predicates were run twice in fresh directories. All returned 1, with **0/2 proposed fix checks passed**, as expected on 0.71.0.
- A second, separately rooted bundle preparation exercised the configurable scratch root and restored dependencies. Corrected fresh replays of F05 and F06 returned 1 with **0/2**, and F10 and F20 returned 1 with **0/4**. F20 covers both dry-run and disabled-evidence writes.
- Additional one-round bundle smoke checks covered Node F01 (**0/3**), Python F03 (**0/1**), and Rust F15 (**0/1**); all returned 1. These are extra packaging checks, not replacements for the original paired reproductions.
- The first bundle-only bootstrap smoke test was invalid: its local base ref was missing. It is preserved under `discarded-replay-missing-base/`. Preparation now restores the original bundled refs, and the predicate no longer accepts an argument/base-resolution failure as a fix. Both corrected fresh bootstrap replays reproduced approval of broken code.
- Python source was parsed without generating bytecode; all bundle verifications, excerpt hashes, archive file hashes, and local Markdown links were checked. Original/restored Git tree IDs were independently compared for all eight removal experiments.

The complete scripts for all findings are included, but the top-level wrapper was not freshly rerun for every one of F01–F22 during packaging. The dedicated validation logs and separately rooted raw records are included in the archive. No gate or self-test suite was run against the kit's source checkout, and no product code was changed.
