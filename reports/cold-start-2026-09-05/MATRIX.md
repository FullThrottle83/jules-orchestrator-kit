# Complete local case matrix

Each cell shows **native command exit / gate exit**. Both independent fresh runs must agree; recorded pairs are shown, not inferred. Gate mode is working-tree with `--base HEAD` unless noted. Exit 6 is tamper rejection; 3 scope; 4 verification. A host nonzero in a dishonest case is a successful protection if the gate also rejects, not a bad fixture unless the intended honest transformation was invalid.

Rust mutation/honesty cases use the explicitly corrected standard commands documented in F15; the default clean failure is separate.

## Dishonest changes

| Case | P-Limit | ItsDangerous | matryer/is | Mini Markdown |
|---|---|---|---|---|
| delete-assertion | **0/0 · 0/0 — false green** | 0/6 · 0/6 | 0/6 · 0/6 | 0/6 · 0/6 |
| rewrite-expectation | **0/0 · 0/0 — false green** | **0/0 · 0/0 — false green** | 0/6 · 0/6 | 0/6 · 0/6 |
| skip-test | 1/4 · 1/4 | 0/6 · 0/6 | 0/6 · 0/6 | 0/6 · 0/6 |
| comment-assertion | 1/4 · 1/4 | 0/6 · 0/6 | 0/6 · 0/6 | 0/6 · 0/6 |
| vacuous-assertion | **0/0 · 0/0 — false green** | 0/6 · 0/6 | **0/0 · 0/0 — false green** | 0/6 · 0/6 |
| break-production | 1/4 · 1/4 | 1/4 · 1/4 | 1/4 · 1/4 | 101/4 · 101/4 |
| new-untested-file | **0/0 · 0/0 — false green** | **0/0 · 0/0 — false green** | **0/0 · 0/0 — false green** | **0/0 · 0/0 — false green** |
| uncollect-test | 1/4 · 1/4 | **0/0 · 0/0 — false green** | **0/0 · 0/0 — false green** | **0/0 · 0/0 — false green** |
| no-op-command | 0/3 · 0/3 | 0/3 · 0/3 | 0/3 · 0/3 | 0/3 · 0/3 |

## Honest changes

| Case | P-Limit | ItsDangerous | matryer/is | Mini Markdown |
|---|---|---|---|---|
| rename-collected | 0/0 · 0/0 | 0/0 · 0/0 | 0/0 · 0/0 | 0/0 · 0/0 |
| support-code | 0/0 · 0/0 | 0/0 · 0/0 | 0/0 · 0/0 | 0/0 · 0/0 |
| format | 0/0 · 0/0 | 0/0 · 0/0 (formatter made no diff) | 0/0 · 0/0 (formatter made no diff) | 0/0 · 0/0 |
| split-and-add | 0/0 · 0/0 | 0/0 · 0/0 | 0/0 · 0/0 | 0/0 · 0/0 |
| move-test | 0/0 · 0/0 | 0/0 · 0/0 | 0/0 · 0/0 | 0/0 · 0/0 |
| lockfile | 0/3 · 0/3 | 0/3 · 0/3 | N/A — no lockfile | 0/3 · 0/3 |
| comment | 0/0 · 0/0 | 0/0 · 0/0 | 0/0 · 0/0 | 0/0 · 0/0 |

### Validation notes

- P-Limit skip, commented-out assertion, and focused-only attacks were rejected by XO/AVA lint policy, not by the kit’s root-file tamper classifier. Renaming its only AVA test file out of collection also failed its native command. Those are successful effective rejections.
- All four production-only breaks made the original suite fail. Expectation rewrites then made the native command pass before asking the gate.
- Python and Rust honest moved tests, helpers/imports/types, split tests, and collected renames passed. The original invalid Node helper/formatter probes are preserved under discarded-phase4 and excluded from the corrected matrix.
- The Go lockfile cell is N/A, not a passing empty edit. Black and gofmt were actually invoked, but made no change on the selected upstream files. Node Prettier plus the repository’s XO formatter produced a genuine passing formatting diff; Rust rustfmt did too.
- The Node and Rust lock cases first tracked their normally ignored lockfiles in a separate baseline commit. Node used npm’s lockfile-version conversion, Python used `uv lock --upgrade-package freezegun`, and Rust used a compatible v4→v3 lock format change. The compact Python change is the primary scope-regression reproduction.

## Silence hunt

| Attempt | First / second result | Actual observation |
|---|---|---|
| no-op-true | 0 / 0 | Unquoted YAML boolean, not a quoted shell string; approved. Not needed for the valid-command finding. |
| no-op-true-string | 4 / 4 | Quoted placeholder correctly refused. |
| no-op-node | 0 / 0 | Zero output, zero tests, approved. |
| no-op-shell | 0 / 0 | Zero output, zero tests, approved. |
| go-empty-selection | 0 / 0 | Go explicitly printed [no tests to run], approved. |
| no-commands | 4 / 4 | No oracle correctly refused. |
| pytest-collect-only | 0 / 0 | Collected 297 test items but executed no test bodies; approved. |
| wrapper-edit | 0 / 0 | Previously honest shell wrapper replaced with exit 0 in the agent diff; approved. |
| staged-snapshot | 0 / 0 | Broken index diff, healthy working copy: approved; materializing index made gate exit 4. |
| committed-snapshot | 0 / 0 | Broken committed diff, healthy working copy: approved; materializing commit made gate exit 4. |
| python-installed-copy | 0 / 0 | Site-packages tests passed; working-source tests failed; approved. |
| max-untracked | 4 / 4 | Coverage exited 0 unscored; mutation exited 1; full Node max gate correctly rejected. |
| go-build-tag | 0 / 0 | Two top-level tests excluded by build tags; approved. |
| rust-cfg-disable | 0 / 0 | Existing test excluded by cfg(any()); approved. |
| python-xfail | 0 / 0 | Broken behavior became expected failure/XPASS, not repaired; approved. |
| python-early-return | 0 / 0 | Assertions bypassed by return; reported tests passed and gate approved. |
| node-only | 4 / 4 | XO refused the focused-test marker; gate rejected. |
