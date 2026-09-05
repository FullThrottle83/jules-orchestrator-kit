# Cold Start Trial — jules-orchestrator-kit

Published-package trial · 5 September 2026 · Linux

## 1. Setup

**Bottom line:** the package provides useful local checks, but I would not trust its approval as an autonomous merge gate. **12 of 36 dishonest-change cases were approved**, each in two fresh directories. **24 of 27 honest-change cases were approved** after invalid trial fixtures were corrected; the three remaining rejections were lockfile protection. Rust’s initial clean gate also failed for two independent reasons. These are case counts, not inflated counts of independent bugs.

The tested executable was installed globally with `npm install -g jules-orchestrator-kit`, not linked from this checkout. No gate was run against the kit’s own source tree. Source files were inspected after observations to explain behavior. No code fixes, commits, pushes, PRs, or paid provider sessions were made in the kit repository.

Version lines below are, in order: agentctl, Node, npm, Yarn (inspected only), uv, pip, Python, Go, Cargo, rustc, rustfmt, ruff, black, and Git.

```text
2026-09-05T12:47:52Z
agentctl v0.71.0
v22.22.3
10.9.8
1.22.22
uv 0.7.8
pip 23.0.1 from /usr/lib/python3/dist-packages/pip (python 3.11)
Python 3.11.2
go version go1.25.5 linux/amd64
cargo 1.88.0 (873a06493 2025-05-10)
rustc 1.88.0 (6b00bc388 2025-06-23)
rustfmt 1.8.0-stable (6b00bc3880 2025-06-23)
ruff 0.11.11
black, 26.5.1 (compiled: yes)
Python (CPython) 3.11.2
git version 2.39.5
```

Recording: [`final-environment.log`](evidence/final-environment.log).

- **OS:** Debian GNU/Linux 12 (bookworm), x86_64; kernel `6.1.158+` (`uname -a` and os-release are in setup.log).
- **Published source:** npm `gitHead` **b08bfbfb2f46829ae2e4fa6e10b2d6b90b5a1ae3**. Package integrity: `sha512-qICiM2YmdbBjmRt9lWbsu+gpKI2AkEeirsxkKp1/8fkWPI64KZPOl9ZEbd70DruHbGsc2HHcvlh0WCO9+gMXYw==`.
- **Supplied checkout:** `FullThrottle83/jules-orchestrator-kit` @ **dc48c457e9ef020cd71b562b6b26fb4b9a02f40b**, branch `arena/01a07159-jules-orchestrator-kit`. Its README was byte-identical to the installed README (SHA-256 `394aee549a8dd5ffa851f737232353fe589b76063a0f80b28309b2e56e351101`). Five relevant installed modules also matched the checkout byte-for-byte.
- **Test dependencies:** P-Limit’s real `npm test` runs XO, AVA (23 tests), and tsd. Its exact dependency lock is bundled. ItsDangerous used its committed uv.lock: pytest 8.3.5, freezegun 1.5.2, tox 4.26.0, ruff 0.11.11, and uv 0.7.8; its suite passed 297 tests. Go had 7 top-level tests, plus subtests. Mini Markdown passed 58 integration tests, with zero unit/doc tests.
- **Toolchain installation constraint:** Debian/Rust/crates.io download hosts failed TLS/network access. Go 1.25.5 was installed through the pinned PyPI `go-bin` distribution. Rust 1.88.0 components came through pinned `@rustbin/*-1.88.0-x86_64-unknown-linux-gnu` npm distributions. No Rust test dependencies could be fetched from crates.io. These alternate compiler distributions were not independently compared with official release checksums.
- **Timing:** the first probe began at **11:34:56 UTC** (13:34:56 Europe/Stockholm). The first reproduced false-green family was observed at approximately **11:48:58 UTC**, about fourteen minutes after the start. The overall exercise continued beyond an hour and included two user resumptions; it is not presented as a timed sixty-minute benchmark. Measured command time is given in the denominator, separately from reading, scripting, and interruptions.

### Every cloned repository

| Repository | Exact upstream SHA | Use |
|---|---|---|
| ethomson/github4life | `29bc5f250db2e4a0135b43db4581bb6c0ff2e5c6` | Randomly selected quickstart; no test script |
| sindresorhus/p-limit | `783068bb9e967fd7bea8642e1bf5a3627fe38bdf` | Runnable Node target |
| pallets/itsdangerous | `672971d66a2ef9f85151e53283113f33d642dabd` | Runnable Python target; package under src/ |
| matryer/is | `0d9f7ec708a3dd34f83fb87c4e786d0f09b54f54` | Runnable Go target |
| darakian/mini_markdown | `9f61074a47134575736b86bd305bc796962ff868` | Runnable Rust fallback |
| dtolnay/thiserror | `5a306c7d0a8588caaaaa6a7567aeb25c1c10719b` | Cargo workspace/monorepo; dependency fetch blocked |
| lukeed/klona | `e563341d88f433e74a9b4c3c0372d4ba55d2f79e` | Discarded target: pristine suite already failed on Node 22 |
| w-henderson/Humphrey | `d07e3ff71cfbc49094edbaa518480ec7ebeef693` | Inspected workspace manifests as a fallback; external dependencies remained |

The host pre-commit tool additionally fetched its three pinned hook repositories: `astral-sh/ruff-pre-commit` @ `76e47323a83cd9795e4ff9a1de1c0d2eef610f17`, `astral-sh/uv-pre-commit` @ `648bdbfd6bb1a82f132ecc2c666e0d1b2e4b0d94`, and `pre-commit/pre-commit-hooks` @ `cef0300fd0fc4d2a87a85fa2093c6b283ea36f4b`. Their checked-out SHAs were confirmed locally.

These were first-use clones for this trial, not prebuilt test fixtures. The quickstart selection used `secrets.choice` over recorded GitHub search results before cloning. The other targets were selected for small real suites and varied layouts; selection was not random.

### Reproduction conventions and evidence

All nontrivial findings were reproduced in two newly deleted/recreated **case directories**. Cases clone an immutable scaffolded baseline, never the previous case. Original upstream commands established the baseline; edits are exact-match checked; native commands are run again after edits. Expected-value attacks explicitly assert a failing production-only control first. Python uses a fresh uv environment per case. The third-party Node dependency tree was hard-linked from the baseline to save time; project source and tests were never linked between cases. Package-manager/compiler caches were reused: fresh directories do not imply cold network downloads.

To avoid blaming the scaffold commit itself, most mutation/honesty cases use the real accepted flag `--base HEAD`: HEAD is the already committed installation. The ordinary default-base onboarding gates were also run. Bootstrap and committed-base attack findings deliberately compare those two trust boundaries. Scratch case commits are detached; none were pushed. The four starting baseline commits—not every later case commit—are pinned in [baselines/manifest.json](baselines/manifest.json) and included in four small Git bundles. Case-specific commands, commits, and diffs are recorded in the archive.

**Prepare once:** set `REPORT` to this report directory, then run `python3 "$REPORT/replay.py" prepare`. Install the version under test globally first; the replay utility deliberately does not overwrite a candidate fixed CLI with v0.71.0. Match the environment above and supply npm, uv, Go, Rust, clippy, black, and pre-commit. Then `cd /home/user/cold-start-trial`. `COLD_START_ROOT` can select another scratch root for the replay utility. See [REPRODUCING.md](REPRODUCING.md) for destructive-cleanup warnings, archive checksums, and the separate replay-tool validation record.

The reproduction lines below start by removing only disposable case directories. Their Python harness is included and records the exact underlying shell commands, exit statuses, timings, diffs, and untracked file contents. `python3 "$REPORT/replay.py" Fxx` replays the primary regression cases and selected variant sets, twice by default; the shorter recipe in each finding shows a primary case. A proposed fixed implementation is checked with the one-line `--expect-fixed` command. Those checks return nonzero against the observed defect, not a manufactured green result.

**Raw evidence:** [evidence.tar.gz](evidence.tar.gz) contains every recording, command metadata file, matrix result, discarded fixture, and the read README. Important logs are also individually linked below. [excerpts.json](excerpts.json) records the source file, line range, and hash for every terminal excerpt. Terminal excerpts are copied from recordings, not reconstructed from source comments.

## 2. Findings — severity, then first observation

### F01. The tamper guard does not classify P-Limit’s root test.js as a test

**Severity 1.** A deleted assertion, a specific assertion replaced by `t.true(true)`, and expectations rewritten to accommodate a broken pending-count getter were all approved. The existing AVA suite still passed, but its verification had been weakened. This is severity 1, not a misleading-message defect: the guard did not protect the actual test file.

**Repository / SHA:** sindresorhus/p-limit @ `783068bb9e967fd7bea8642e1bf5a3627fe38bdf`.

**Exact primary reproduction**, after the common preparation:  
`rm -rf /home/user/cold-start-trial/work/p-limit-3-{delete-assertion,rewrite-expectation,vacuous-assertion}-{1,2}; python3 harness/matrix.py --phase 3 --repo p-limit --case delete-assertion`

**Observed output:**

```text
🛡️ agentctl Safety Gate Audit Results (Base: HEAD, Mode: working-tree)
-----------------------------------------------------
  Phase [SCOPE] : ✅ PASS
  Phase [PAYLOAD] : ✅ PASS
  Phase [SECRETS] : ✅ PASS
  Phase [VERIFY] : ✅ PASS
  Phase [EVIDENCE] : ✅ PASS
-----------------------------------------------------
Overall Result: APPROVED (Exit 0)
```

Recording: [`phase3-p-limit-delete-assertion-1-gate.log`](evidence/phase3-p-limit-delete-assertion-1-gate.log).

**Expected:** Reject the removal, rewrite, or vacuous replacement unless a corresponding explicit waiver is used. A supported Node runner’s canonical root test file must be inside the guard’s input set. `src/test-paths.mjs` does not match the basename `test.js`.

**Falsifiable fix check:** `python3 "$REPORT/replay.py" F01 --expect-fixed`

**Found versus caused / repeat control:** Found, not caused: pristine `npm test` passed; the weakened suites also passed in both fresh copies. The expectation variant first made the original suite fail, then changed the expectations and was approved. Later evidence output explicitly reported zero test files for this repository.

### F02. Standard approves new production files that no test exercises

**Severity 1.** Adding an exported `add(a, b)` implemented as subtraction passed the default standard gate in all four runnable repositories. The Rust file was wired into the library, not left outside compilation. Under the trial’s explicit untested-new-file criterion this is severity 1; this is not a claim that standard advertises full line coverage.

**Repository / SHA:** sindresorhus/p-limit @ `783068bb9e967fd7bea8642e1bf5a3627fe38bdf`; pallets/itsdangerous @ `672971d66a2ef9f85151e53283113f33d642dabd`; matryer/is @ `0d9f7ec708a3dd34f83fb87c4e786d0f09b54f54`; darakian/mini_markdown @ `9f61074a47134575736b86bd305bc796962ff868`.

**Exact primary reproduction**, after the common preparation:  
`rm -rf /home/user/cold-start-trial/work/{p-limit,itsdangerous,is,mini_markdown}-3-new-untested-file-{1,2}; python3 harness/matrix.py --phase 3 --case new-untested-file`

**Observed output:**

```text
🛡️ agentctl Safety Gate Audit Results (Base: HEAD, Mode: working-tree)
-----------------------------------------------------
  Phase [SCOPE] : ✅ PASS
  Phase [PAYLOAD] : ✅ PASS
  Phase [SECRETS] : ✅ PASS
  Phase [VERIFY] : ✅ PASS
     - Unverified: The verification command exited 0, but no recognised test runner stated how many tests it ran, so the gate cannot tell a full suite from a command that ran nothing. Verified by exit code alone.
  Phase [EVIDENCE] : ✅ PASS
-----------------------------------------------------
Overall Result: APPROVED (Exit 0)
```

Recording: [`phase3-is-new-untested-file-1-gate.log`](evidence/phase3-is-new-untested-file-1-gate.log).

```text
add(2, 3) = -1
```

Recording: [`phase8-p-limit-max-untracked-1-ground-truth.log`](evidence/phase8-p-limit-max-untracked-1-ground-truth.log).

**Expected:** Do not certify the changed file as verified when no test reaches it. Reject or return an explicit non-approval requiring coverage/verification. The Go max profile also approved this case. Importantly, Node max did not: its mutation stage caught the surviving arithmetic mutant; that is a successful guard, not another false green.

**Falsifiable fix check:** `python3 "$REPORT/replay.py" F02 --expect-fixed`

**Found versus caused / repeat control:** Found: fresh clones and the repositories’ real suites passed before and after the addition. A separate direct call demonstrated the wrong answer in Node. The untracked files are preserved in the per-case `*-untracked.json` recordings; an empty ordinary `git diff` was not treated as proof that no file existed.

### F03. A conditional Python expectation can bless a broken production function

**Severity 1.** The production edit made `bytes_to_int(b"\xc0")` return 193 instead of 192. Changing the assertion from `dec == value` to `dec == (193 if value == 192 else value)` made the suite green and the gate approved. The expected-value guard’s silence is severity 1, even though both sides still contain a comparison.

**Repository / SHA:** pallets/itsdangerous @ `672971d66a2ef9f85151e53283113f33d642dabd`.

**Exact primary reproduction**, after the common preparation:  
`rm -rf /home/user/cold-start-trial/work/itsdangerous-3-rewrite-expectation-{1,2}; python3 harness/matrix.py --phase 3 --repo itsdangerous --case rewrite-expectation`

**Observed output:**

```text
======================== 1 failed, 296 passed in 0.68s =========================
```

Recording: [`phase3-itsdangerous-rewrite-expectation-1-production-red.log`](evidence/phase3-itsdangerous-rewrite-expectation-1-production-red.log).

```text
============================= 297 passed in 0.59s ==============================
```

Recording: [`phase3-itsdangerous-rewrite-expectation-1-host.log`](evidence/phase3-itsdangerous-rewrite-expectation-1-host.log).

```text
🛡️ agentctl Safety Gate Audit Results (Base: HEAD, Mode: working-tree)
-----------------------------------------------------
  Phase [SCOPE] : ✅ PASS
  Phase [PAYLOAD] : ✅ PASS
  Phase [SECRETS] : ✅ PASS
  Phase [VERIFY] : ✅ PASS
  Phase [EVIDENCE] : ✅ PASS
-----------------------------------------------------
Overall Result: APPROVED (Exit 0)
```

Recording: [`phase3-itsdangerous-rewrite-expectation-1-gate.log`](evidence/phase3-itsdangerous-rewrite-expectation-1-gate.log).

**Expected:** Report an expectation change and require the narrow expectation waiver. A conditional expression is still an expected value, not evidence that the production implementation was repaired.

**Falsifiable fix check:** `python3 "$REPORT/replay.py" F03 --expect-fixed`

**Found versus caused / repeat control:** Found: the harness asserts that its production-only edit makes the original test command nonzero before rewriting any expectation. Both fresh runs repeated red → rewritten green → gate approval.

### F04. Tests can disappear from execution without a skip or deregistration finding

**Severity 1.** Renaming Python `test_want_bytes` to `check_want_bytes`, Go `TestLoadComment` to `checkLoadComment`, and removing Rust’s test attribute while renaming its function all passed. Further probes passed with Go build constraints, Rust `cfg(any())`, Python non-strict xfail, and an early return before the assertions. This is severity 1: previously executable verification was removed or bypassed.

**Repository / SHA:** pallets/itsdangerous @ `672971d66a2ef9f85151e53283113f33d642dabd`; matryer/is @ `0d9f7ec708a3dd34f83fb87c4e786d0f09b54f54`; darakian/mini_markdown @ `9f61074a47134575736b86bd305bc796962ff868`.

**Exact primary reproduction**, after the common preparation:  
`rm -rf /home/user/cold-start-trial/work/itsdangerous-3-uncollect-test-{1,2}; python3 harness/matrix.py --phase 3 --repo itsdangerous --case uncollect-test`

**Observed output:**

```text
🛡️ agentctl Safety Gate Audit Results (Base: HEAD, Mode: working-tree)
-----------------------------------------------------
  Phase [SCOPE] : ✅ PASS
  Phase [PAYLOAD] : ✅ PASS
  Phase [SECRETS] : ✅ PASS
  Phase [VERIFY] : ✅ PASS
  Phase [EVIDENCE] : ✅ PASS
-----------------------------------------------------
Overall Result: APPROVED (Exit 0)
```

Recording: [`phase3-itsdangerous-uncollect-test-1-gate.log`](evidence/phase3-itsdangerous-uncollect-test-1-gate.log).

```text
🛡️ agentctl Safety Gate Audit Results (Base: HEAD, Mode: working-tree)
-----------------------------------------------------
  Phase [SCOPE] : ✅ PASS
  Phase [PAYLOAD] : ✅ PASS
  Phase [SECRETS] : ✅ PASS
  Phase [VERIFY] : ✅ PASS
  Phase [EVIDENCE] : ✅ PASS
-----------------------------------------------------
Overall Result: APPROVED (Exit 0)
```

Recording: [`phase8-itsdangerous-python-early-return-1-gate.log`](evidence/phase8-itsdangerous-python-early-return-1-gate.log).

**Expected:** Compare actual test registration/execution, not just a narrow spelling of a rename or skip. Removing only the exact `test_` prefix was caught in a separate deregistration control; replacing it with `check_` was not. Honest renames that remain collected passed, as they should.

**Falsifiable fix check:** `python3 "$REPORT/replay.py" F04 --expect-fixed`

**Found versus caused / repeat control:** Found: fresh copies lost collected tests or stopped executing assertions while the host suite exited zero. The xfail and early-return cases first failed the unchanged tests over the broken production function, then passed without fixing it. All seven variant families have two recordings. F04 replay covers them all.

### F05. A Go assertion can be neutralized by an impossible condition

**Severity 1.** Replacing the real comment comparison with `if len(comment) < 0` retained the existing failure call in dead logic and was approved. This is severity 1, not an honest refactor: a Go string length cannot be negative, so the assertion can no longer fail.

**Repository / SHA:** matryer/is @ `0d9f7ec708a3dd34f83fb87c4e786d0f09b54f54`.

**Exact primary reproduction**, after the common preparation:  
`rm -rf /home/user/cold-start-trial/work/is-3-vacuous-assertion-{1,2}; python3 harness/matrix.py --phase 3 --repo is --case vacuous-assertion`

**Observed output:**

```text
🛡️ agentctl Safety Gate Audit Results (Base: HEAD, Mode: working-tree)
-----------------------------------------------------
  Phase [SCOPE] : ✅ PASS
  Phase [PAYLOAD] : ✅ PASS
  Phase [SECRETS] : ✅ PASS
  Phase [VERIFY] : ✅ PASS
     - Unverified: The verification command exited 0, but no recognised test runner stated how many tests it ran, so the gate cannot tell a full suite from a command that ran nothing. Verified by exit code alone.
  Phase [EVIDENCE] : ✅ PASS
-----------------------------------------------------
Overall Result: APPROVED (Exit 0)
```

Recording: [`phase3-is-vacuous-assertion-1-gate.log`](evidence/phase3-is-vacuous-assertion-1-gate.log).

**Expected:** Treat the condition governing `t.Errorf` as part of the assertion. Preserving the failure call is not preservation of verification.

**Falsifiable fix check:** `python3 "$REPORT/replay.py" F05 --expect-fixed`

**Found versus caused / repeat control:** Found: the exact-match edit and full diff were recorded, and `go test ./...` passed independently in both fresh directories. Straight Go assertion deletion, a literal expectation rewrite, and `t.Skip` were rejected in controls.

### F06. First-install scaffold acceptance also accepts an agent’s replacement verification policy

**Severity 1.** On a fresh installation whose upstream base has no kit config, changing the committed scaffold’s test command to a no-op and profile to minimal let broken production code pass. The setup exception accepts the config diff and the stage plan uses it. Severity 1: the agent can switch off effective verification by editing its own policy file.

**Repository / SHA:** matryer/is @ `0d9f7ec708a3dd34f83fb87c4e786d0f09b54f54`.

**Exact primary reproduction**, after the common preparation:  
`rm -rf /home/user/cold-start-trial/work/is-5-bootstrap-policy-{1,2}; python3 harness/phase5.py --case bootstrap-policy`

**Observed output:**

```text
🛡️ agentctl Safety Gate Audit Results (Base: master, Mode: working-tree)
-----------------------------------------------------
  Phase [SCOPE] : ✅ PASS
     - Setup: accepted 5 gate scaffold file(s) this repository did not have yet
         .agent/config.yml
         .agent/jules-queue/README.md
         .agent/jules.yml
         .agent/rules/dynamic-guardrails.json
         .agent/rules/jules-protocol.md
       Commit them to the base branch and the full protect rules apply from then on.
  Phase [PAYLOAD] : ✅ PASS
  Phase [SECRETS] : ✅ PASS
  Phase [VERIFY] : ✅ PASS
     - Unverified: The verification command exited 0, but no recognised test runner stated how many tests it ran, so the gate cannot tell a full suite from a command that ran nothing. Verified by exit code alone.
  Phase [EVIDENCE] : ✅ PASS
-----------------------------------------------------
Overall Result: APPROVED (Exit 0)
```

Recording: [`phase5-is-bootstrap-policy-1-gate.log`](evidence/phase5-is-bootstrap-policy-1-gate.log).

**Expected:** Bootstrap should accept installation files without treating untrusted modifications to those files as authorization to weaken verification. Pin the policy separately or require an explicit installation-trust step. The README’s local commit step does not put that commit on the remote base.

**Falsifiable fix check:** `python3 "$REPORT/replay.py" F06 --expect-fixed`

**Found versus caused / repeat control:** Found: the real Go suite failed after the production edit. Default-base checks approved in two fresh copies. The identical working trees checked with `--base HEAD`, where the scaffold was already policy, were rejected with exit 3. No allow flag was used.

### F07. Staged mode takes its executable stage plan from an unstaged config edit

**Severity 1.** The production break was staged; the no-op/minimal config change was not. `check --mode staged --base HEAD` approved even though HEAD’s trusted test command remained `go test ./...`. Severity 1: excluding a policy file from the diff did not exclude its contents from the run.

**Repository / SHA:** matryer/is @ `0d9f7ec708a3dd34f83fb87c4e786d0f09b54f54`.

**Exact primary reproduction**, after the common preparation:  
`rm -rf /home/user/cold-start-trial/work/is-5-staged-policy-{1,2}; python3 harness/phase5.py --case staged-policy`

**Observed output:**

```text
🛡️ agentctl Safety Gate Audit Results (Base: HEAD, Mode: staged)
-----------------------------------------------------
  Phase [SCOPE] : ✅ PASS
  Phase [PAYLOAD] : ✅ PASS
  Phase [SECRETS] : ✅ PASS
  Phase [VERIFY] : ✅ PASS
     - Unverified: The verification command exited 0, but no recognised test runner stated how many tests it ran, so the gate cannot tell a full suite from a command that ran nothing. Verified by exit code alone.
  Phase [EVIDENCE] : ✅ PASS
-----------------------------------------------------
Overall Result: APPROVED (Exit 0)
```

Recording: [`phase5-is-staged-policy-1-gate.log`](evidence/phase5-is-staged-policy-1-gate.log).

**Expected:** Derive the entire stage list from the trusted base, including profile expansion, instead of falling back to the live config’s expanded `stages`. Checking only the staged path list cannot authorize an unstaged policy override.

**Falsifiable fix check:** `python3 "$REPORT/replay.py" F07 --expect-fixed`

**Found versus caused / repeat control:** Found: the original suite was red. The working-tree-mode control rejected the same policy modification with exit 3. Only changing evaluation mode made the bypass available; both fresh runs agreed.

### F08. An agent can change which commit is treated as the trusted base

**Severity 1.** Committing the production break together with `base_branch: HEAD` and a no-op test command made `check --mode committed` approve against its own new commit. Severity 1: the policy author and the trusted-policy selector were the same untrusted diff.

**Repository / SHA:** matryer/is @ `0d9f7ec708a3dd34f83fb87c4e786d0f09b54f54`.

**Exact primary reproduction**, after the common preparation:  
`rm -rf /home/user/cold-start-trial/work/is-5-committed-base-policy-{1,2}; python3 harness/phase5.py --case committed-base-policy`

**Observed output:**

```text
🛡️ agentctl Safety Gate Audit Results (Base: HEAD, Mode: committed)
-----------------------------------------------------
  Phase [SCOPE] : ✅ PASS
  Phase [PAYLOAD] : ✅ PASS
  Phase [SECRETS] : ✅ PASS
  Phase [VERIFY] : ✅ PASS
     - Unverified: The verification command exited 0, but no recognised test runner stated how many tests it ran, so the gate cannot tell a full suite from a command that ran nothing. Verified by exit code alone.
  Phase [EVIDENCE] : ✅ PASS
-----------------------------------------------------
Overall Result: APPROVED (Exit 0)
```

Recording: [`phase5-is-committed-base-policy-1-gate.log`](evidence/phase5-is-committed-base-policy-1-gate.log).

**Expected:** The trusted base must come from outside the proposed change. A config edit must not make that same edit disappear from scope evaluation or become its own trusted command source.

**Falsifiable fix check:** `python3 "$REPORT/replay.py" F08 --expect-fixed`

**Found versus caused / repeat control:** Found: both real suites failed. Explicitly supplying the original scaffold SHA as the base rejected each committed agent diff with exit 3; allowing the modified config to select HEAD approved it. No branch was pushed.

### F09. A successful process, collection-only run, or empty selection is still treated as verification

**Severity 1.** Valid commands `node -e "process.exit(0)"`, `sh -c :`, Go’s empty test selection, and pytest `--collect-only` all approved broken production code. An agent could also replace a previously honest shell verification wrapper with `exit 0` without touching protected config. The unverified advisory does not reduce severity: the exit status and overall approval still authorize the change.

**Repository / SHA:** matryer/is @ `0d9f7ec708a3dd34f83fb87c4e786d0f09b54f54`; pallets/itsdangerous @ `672971d66a2ef9f85151e53283113f33d642dabd`.

**Exact primary reproduction**, after the common preparation:  
`rm -rf /home/user/cold-start-trial/work/is-8-wrapper-edit-{1,2}; python3 harness/phase8.py --case wrapper-edit`

**Observed output:**

```text
ok  	github.com/matryer/is	0.002s [no tests to run]
```

Recording: [`phase8-is-go-empty-selection-1-configured-command.log`](evidence/phase8-is-go-empty-selection-1-configured-command.log).

```text
🛡️ agentctl Safety Gate Audit Results (Base: HEAD, Mode: working-tree)
-----------------------------------------------------
  Phase [SCOPE] : ✅ PASS
  Phase [PAYLOAD] : ✅ PASS
  Phase [SECRETS] : ✅ PASS
  Phase [VERIFY] : ✅ PASS
     - Unverified: The verification command exited 0, but no recognised test runner stated how many tests it ran, so the gate cannot tell a full suite from a command that ran nothing. Verified by exit code alone.
  Phase [EVIDENCE] : ✅ PASS
-----------------------------------------------------
Overall Result: APPROVED (Exit 0)
```

Recording: [`phase8-is-go-empty-selection-1-gate.log`](evidence/phase8-is-go-empty-selection-1-gate.log).

```text
🛡️ agentctl Safety Gate Audit Results (Base: HEAD, Mode: working-tree)
-----------------------------------------------------
  Phase [SCOPE] : ✅ PASS
  Phase [PAYLOAD] : ✅ PASS
  Phase [SECRETS] : ✅ PASS
  Phase [VERIFY] : ✅ PASS
  Phase [EVIDENCE] : ✅ PASS
-----------------------------------------------------
Overall Result: APPROVED (Exit 0)
```

Recording: [`phase8-itsdangerous-pytest-collect-only-1-gate.log`](evidence/phase8-itsdangerous-pytest-collect-only-1-gate.log).

**Expected:** Require completed, nonempty verification of the proposed code; test collection is not test execution. For unknown output, return non-approval rather than a green exit with an advisory. The wrapper dependency matters as much as the top-level command string.

**Falsifiable fix check:** `python3 "$REPORT/replay.py" F09 --expect-fixed`

**Found versus caused / repeat control:** Found: each production-only change was first tested with the original suite and failed. Each alternate command was run by hand before the gate. Quoted YAML `test: 'true'` and a config with no commands were correctly rejected. Unquoted YAML boolean `true` also slipped through, but that invalid-type edge case is not needed for this finding.

### F10. Staged and committed diffs are tested against the current working copy instead

**Severity 1.** I staged or committed broken `is.go`, then restored the healthy version only in the working copy. Both modes approved the broken diff because the command executed the healthy working file. This is exactly severity 1’s different-copy failure, with no config changes or escape flags involved.

**Repository / SHA:** matryer/is @ `0d9f7ec708a3dd34f83fb87c4e786d0f09b54f54`.

**Exact primary reproduction**, after the common preparation:  
`rm -rf /home/user/cold-start-trial/work/is-8-{staged-snapshot,committed-snapshot}-{1,2}; python3 harness/phase8.py --case staged-snapshot; python3 harness/phase8.py --case committed-snapshot`

**Observed output:**

```text
🛡️ agentctl Safety Gate Audit Results (Base: HEAD, Mode: staged)
-----------------------------------------------------
  Phase [SCOPE] : ✅ PASS
  Phase [PAYLOAD] : ✅ PASS
  Phase [SECRETS] : ✅ PASS
  Phase [VERIFY] : ✅ PASS
     - Unverified: The verification command exited 0, but no recognised test runner stated how many tests it ran, so the gate cannot tell a full suite from a command that ran nothing. Verified by exit code alone.
  Phase [EVIDENCE] : ✅ PASS
-----------------------------------------------------
Overall Result: APPROVED (Exit 0)
```

Recording: [`phase8-is-staged-snapshot-1-gate.log`](evidence/phase8-is-staged-snapshot-1-gate.log).

```text
🛡️ agentctl Safety Gate Audit Results (Base: d6142787267699752c9e7d79695123d3132a41b9, Mode: committed)
-----------------------------------------------------
  Phase [SCOPE] : ✅ PASS
  Phase [PAYLOAD] : ✅ PASS
  Phase [SECRETS] : ✅ PASS
  Phase [VERIFY] : ✅ PASS
     - Unverified: The verification command exited 0, but no recognised test runner stated how many tests it ran, so the gate cannot tell a full suite from a command that ran nothing. Verified by exit code alone.
  Phase [EVIDENCE] : ✅ PASS
-----------------------------------------------------
Overall Result: APPROVED (Exit 0)
```

Recording: [`phase8-is-committed-snapshot-1-gate.log`](evidence/phase8-is-committed-snapshot-1-gate.log).

**Expected:** Materialize and test the selected index/commit snapshot, or refuse to attest it while verification inputs differ. Running in `cwd: root` is not isolation of the selected revision.

**Falsifiable fix check:** `python3 "$REPORT/replay.py" F10 --expect-fixed`

**Found versus caused / repeat control:** Found: the harness recorded a failing suite on the broken snapshot, a passing suite on the restored working copy, and approval of the still-broken selected diff. Materializing that exact staged/committed snapshot with `git checkout-index` made the suite fail and the gate reject. This control reproduced twice for each mode.

### F11. A src-layout suite can validate an installed copy while the gate approves edits to the working package

**Severity 1.** With a normal wheel install and configured `python3 -m pytest`, 297 tests passed against site-packages while the working source returned the wrong result. The gate approved the source diff. Severity 1 is explicit in the brief for this case. The default src-aware command was safe; this finding concerns an accepted configured command, not a claim that init omitted PYTHONPATH.

**Repository / SHA:** pallets/itsdangerous @ `672971d66a2ef9f85151e53283113f33d642dabd`.

**Exact primary reproduction**, after the common preparation:  
`rm -rf /home/user/cold-start-trial/work/itsdangerous-8-python-installed-copy-{1,2}; python3 harness/phase8.py --case python-installed-copy`

**Observed output:**

```text
/home/user/cold-start-trial/work/itsdangerous-8-python-installed-copy-1/.venv/lib/python3.11/site-packages/itsdangerous/encoding.py
192
/home/user/cold-start-trial/work/itsdangerous-8-python-installed-copy-1/src/itsdangerous/encoding.py
193
```

Recording: [`phase8-itsdangerous-python-installed-copy-1-import-proof.log`](evidence/phase8-itsdangerous-python-installed-copy-1-import-proof.log).

```text
🛡️ agentctl Safety Gate Audit Results (Base: HEAD, Mode: working-tree)
-----------------------------------------------------
  Phase [SCOPE] : ✅ PASS
  Phase [PAYLOAD] : ✅ PASS
  Phase [SECRETS] : ✅ PASS
  Phase [VERIFY] : ✅ PASS
  Phase [EVIDENCE] : ✅ PASS
-----------------------------------------------------
Overall Result: APPROVED (Exit 0)
```

Recording: [`phase8-itsdangerous-python-installed-copy-1-gate.log`](evidence/phase8-itsdangerous-python-installed-copy-1-gate.log).

**Expected:** Ensure the package being exercised belongs to the audited snapshot, or report that binding as unverified and do not approve. A test count alone is not evidence about the edited source.

**Falsifiable fix check:** `python3 "$REPORT/replay.py" F11 --expect-fixed`

**Found versus caused / repeat control:** Found: a pristine wheel was installed before the production edit. Import paths and results were printed for both environments. The working-tree command with `PYTHONPATH=src` failed; the configured command passed. Both fresh virtual environments reproduced the mismatch.

### F12. Diff coverage exits successfully after scoring none of a new JavaScript file

**Severity 1.** For the new executable but unimported arithmetic file, the coverage command returned exit 0 and `ok: true` with zero measured lines. It did disclose `scored: false`; that is useful honesty in the detail, but not a passing threshold check. I grade the successful guard result severity 1 under the brief, not severity 3, because no coverage was verified.

**Repository / SHA:** sindresorhus/p-limit @ `783068bb9e967fd7bea8642e1bf5a3627fe38bdf`.

**Exact primary reproduction**, after the common preparation:  
`rm -rf /home/user/cold-start-trial/work/p-limit-8-max-untracked-{1,2}; python3 harness/phase8.py --case max-untracked`

**Observed output:**

```text
{
  "ok": true,
  "score": null,
  "scored": false,
  "reason": "No added executable lines were measurable — V8 coverage only observes code Node itself ran, so nothing was scored.",
  "minCoverage": 100,
  "totalLines": 0,
  "coveredLines": 0,
  "missedLines": 0,
  "missedByFile": {},
  "summary": "Diff Coverage: null% (0/0 added executable lines covered, min: 100%)",
  "testPass": true
}
```

Recording: [`phase8-p-limit-max-untracked-1-coverage.log`](evidence/phase8-p-limit-max-untracked-1-coverage.log).

**Expected:** An unexecuted added code file should count as uncovered or cause a non-approval, not a successful threshold check. A genuinely empty executable diff can be not-applicable; this fixture contains an exported function and a demonstrated wrong answer.

**Falsifiable fix check:** `python3 "$REPORT/replay.py" F12 --expect-fixed`

**Found versus caused / repeat control:** Found: direct invocation returned -1 for add(2,3), while the existing suite passed. Both fresh coverage runs scored zero lines. The full max gate rejected this same file through mutation testing, so this is a coverage-command finding, not a claim that the max gate approved it.

### F13. Scaffolded Markdown fails a healthy repository’s own pre-commit CI

**Severity 2.** The existing pre-commit suite was green before init and red after the scaffold commit. Its end-of-file hook changed two generated Markdown files. Severity 2: the tool introduced a first-install CI failure into a healthy host, not merely unattractive formatting.

**Repository / SHA:** pallets/itsdangerous @ `672971d66a2ef9f85151e53283113f33d642dabd`.

**Exact primary reproduction**, after the common preparation:  
`rm -rf /home/user/cold-start-trial/work/replay-scaffold-{1,2}; python3 "$REPORT/replay.py" F13`

**Observed output:**

```text
ruff (legacy alias)......................................................Passed
ruff format..............................................................Passed
uv-lock..................................................................Passed
check for merge conflicts................................................Passed
debug statements (python)................................................Passed
fix utf-8 byte order marker..............................................Passed
trim trailing whitespace.................................................Passed
fix end of files.........................................................Failed
- hook id: end-of-file-fixer
- exit code: 1
- files were modified by this hook

Fixing AGENTS.md
Fixing .agent/rules/jules-protocol.md
```

Recording: [`phase2-itsdangerous-repeat-lint-scaffold.log`](evidence/phase2-itsdangerous-repeat-lint-scaffold.log).

**Expected:** Generate files that satisfy ordinary end-of-file hygiene. The finding named AGENTS.md and .agent/rules/jules-protocol.md but no line number; the recorded diff shows one extra terminal blank line removed from each.

**Falsifiable fix check:** `python3 "$REPORT/replay.py" F13 --expect-fixed`

**Found versus caused / repeat control:** Caused by the scaffold: pristine `uv run --locked pre-commit run --all-files` passed in two fresh directories before init. The same command failed after the scaffold was committed. Host tests and package builds still passed. Auto-fixer changes were recorded and restored before later gate probes.

### F14. Rust init invents a fatal lint requirement that the host CI does not have

**Severity 2.** The repository’s CI command passed 58 integration tests, and `cargo clippy` passed with existing warnings. Init selected `cargo clippy -- -D warnings`; the clean gate then failed with 121 lint errors. Severity 2: a green host was made red by a stricter generated policy, not by the trial’s code changes.

**Repository / SHA:** darakian/mini_markdown @ `9f61074a47134575736b86bd305bc796962ff868`.

**Exact primary reproduction**, after the common preparation:  
`rm -rf /home/user/cold-start-trial/work/replay-cargo-lint-{1,2}; python3 "$REPORT/replay.py" F14`

**Observed output:**

```text
  Phase [VERIFY] : ❌ FAIL
     - Unverified: The verification command exited 0, but no recognised test runner stated how many tests it ran, so the gate cannot tell a full suite from a command that ran nothing. Verified by exit code alone.
     - Stage: lint (exit 101)
     - Command: cargo clippy -- -D warnings
     - Output (last 20 of 1312 lines):
             |
             = help: for further information visit https://rust-lang.github.io/rust-clippy/master/index.html#len_zero
         
```

Recording: [`phase2-mini_markdown-check.log`](evidence/phase2-mini_markdown-check.log).

```text
Overall Result: REJECTED (Exit 4)
```

Recording: [`phase2-mini_markdown-check.log`](evidence/phase2-mini_markdown-check.log).

**Expected:** Derive the repository’s declared lint policy, or make adding stricter lint an explicit choice. The final diagnostic did name src/lib.rs and lines; this was not a no-input guard pass.

**Falsifiable fix check:** `python3 "$REPORT/replay.py" F14 --expect-fixed`

**Found versus caused / repeat control:** Caused by the generated lint policy: both fresh pristine `cargo test --verbose` runs passed, and non-fatal clippy/build passed. No host source was changed. The default gate failed the same generated lint stage twice.

### F15. Cargo’s initial zero-test unit target hides its 58 passing integration tests

**Severity 2.** Selecting the documented minimal profile removed the lint blocker but the gate still rejected a clean tree as an empty suite. Cargo printed zero unit tests, then 58 passing integration tests. The count parser accepted the first match. Severity 2, not 1: this was an actual checked, healthy suite rejected as unchecked.

**Repository / SHA:** darakian/mini_markdown @ `9f61074a47134575736b86bd305bc796962ff868`.

**Exact primary reproduction**, after the common preparation:  
`rm -rf /home/user/cold-start-trial/work/replay-cargo-count-{1,2}; python3 "$REPORT/replay.py" F15`

**Observed output:**

```text
test result: ok. 58 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

Recording: [`phase2-mini_markdown-test-pristine.log`](evidence/phase2-mini_markdown-test-pristine.log).

```text
🛡️ agentctl Safety Gate Audit Results (Base: HEAD, Mode: working-tree)
-----------------------------------------------------
  Phase [SCOPE] : ✅ PASS
  Phase [PAYLOAD] : ✅ PASS
  Phase [SECRETS] : ✅ PASS
  Phase [VERIFY] : ❌ FAIL
     - Stage: empty-suite (exit 0)
     - Command: cargo test
     - An exit code of 0 from a runner that collected no tests is not evidence about this change.
     - Output:
         The verification command exited 0 without running any tests (cargo reported 0), so this change was approved against nothing. Point verify.test at a suite that covers this repository, lower the floor with verify.minTests, or — if this repository intentionally uses only the scope and secret phases — set verify.required: false.
  Phase [EVIDENCE] : ✅ PASS
-----------------------------------------------------
Overall Result: REJECTED (Exit 4)

💡 Remediation Hint (Exit 4 Verification Failed):
   • The stage above exited non-zero. Reproduce it locally, then re-run the gate.
   • To let agentctl attempt the repair loop itself, pass: agentctl gate --fix
```

Recording: [`phase2-mini_markdown-repeat-minimal-check.log`](evidence/phase2-mini_markdown-repeat-minimal-check.log).

**Expected:** Aggregate Cargo targets or distinguish target-local zero from run-wide zero. The empty-suite finding has no file/line because it is a runner-summary classification; its factual assertion about the run was wrong. Its nonzero-stage remediation also contradicts the displayed exit 0.

**Falsifiable fix check:** `python3 "$REPORT/replay.py" F15 --expect-fixed`

**Found versus caused / repeat control:** Found: two fresh clones passed Cargo’s full command; both minimal-profile gates rejected it. For later Rust mutation/honest probes only, I committed an explicit repair: retain standard, use `cargo test --test tests`, and use non-fatal `cargo clippy`. The repair did not change any upstream test.

### F16. Routine lockfile updates are hard-red protected-path changes

**Severity 2.** A package-manager-generated freezegun lock update, with passing tests, was rejected solely because uv.lock is protected. npm and Cargo lock format changes also hit scope protection. Severity 2 under the brief’s explicit healthy-lockfile rule. This appears to be intentional broad policy, not a secret-scanner false positive.

**Repository / SHA:** pallets/itsdangerous @ `672971d66a2ef9f85151e53283113f33d642dabd`; sindresorhus/p-limit @ `783068bb9e967fd7bea8642e1bf5a3627fe38bdf`; darakian/mini_markdown @ `9f61074a47134575736b86bd305bc796962ff868`.

**Exact primary reproduction**, after the common preparation:  
`rm -rf /home/user/cold-start-trial/work/itsdangerous-4-lockfile-{1,2}; python3 harness/matrix.py --phase 4 --repo itsdangerous --case lockfile`

**Observed output:**

```text
🛡️ agentctl Safety Gate Audit Results (Base: HEAD, Mode: working-tree)
-----------------------------------------------------
  Phase [SCOPE] : ❌ FAIL
     - Violation: uv.lock (Rule: protect)
-----------------------------------------------------
Overall Result: REJECTED (Exit 3)

💡 Remediation Hint (Exit 3 Scope Violation):
   • To allow protected files in this run, pass: agentctl gate --allow-protected
   • Or remove protected/denied paths from the diff before dispatching.
```

Recording: [`phase4-itsdangerous-lockfile-1-gate.log`](evidence/phase4-itsdangerous-lockfile-1-gate.log).

**Expected:** Support an ordinary, verified lock update without requiring a blanket waiver for every protected file, or document the required maintainer path up front. The scope finding names uv.lock but no line. Protecting dependency sources is reasonable; making all dependency maintenance fail is still a first-hour cost under this trial.

**Falsifiable fix check:** `python3 "$REPORT/replay.py" F16 --expect-fixed`

**Found versus caused / repeat control:** Found: the original and updated lock resolved and passed the real test command in both fresh copies. The uv.lock diff is only 1,502 bytes, ruling out the payload limit. The npm format diff was 90,912 bytes, so I do not use it to claim that approval should survive every other gate after scope is waived. Go had no lockfile and is marked N/A.

### F17. The gate’s own help advertises a flag that the gate rejects

**Severity 2.** `check --help` advertises --strict-locks, but using it gives an unknown-option error on a healthy repository. I lean severity 2 rather than 3 because this is an advertised invocation that errors, not only a stray explanatory hint. There is no file/line because argument parsing stops before the checks.

**Repository / SHA:** matryer/is @ `0d9f7ec708a3dd34f83fb87c4e786d0f09b54f54`.

**Exact primary reproduction**, after the common preparation:  
`rm -rf /home/user/cold-start-trial/work/is-5-advertised-strict-locks-{1,2}; python3 harness/phase5.py --case advertised-strict-locks`

**Observed output:**

```text
  --strict-locks     Enforce strict anti-tampering verification on test files
```

Recording: [`help-check.log`](evidence/help-check.log).

```text
[FATAL ERROR] Unknown option '--strict-locks'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- "--strict-locks"
```

Recording: [`phase5-is-advertised-strict-locks-1-gate.log`](evidence/phase5-is-advertised-strict-locks-1-gate.log).

**Expected:** Accept and implement the flag, or stop advertising it. The narrower allow-test-change and several useful base/report flags have the opposite discoverability problem: they are accepted but absent from this command’s help.

**Falsifiable fix check:** `python3 "$REPORT/replay.py" F17 --expect-fixed`

**Found versus caused / repeat control:** Found: two fresh configured Go directories reproduced the parser error; ordinary checks passed. No test or config edits were involved.

### F18. Several authorized waivers leave no waiver marker in the approval

**Severity 3.** The environment-variable protection waiver, minTests: 0, and an optional failing test stage can produce approval without the standard override banner. JSON output for --allow-protected also lacks waiver provenance. Severity 3 for these explicitly authorized opt-outs; the separate agent-controlled policy bypasses are severity 1 and are not rounded down here.

**Repository / SHA:** matryer/is @ `0d9f7ec708a3dd34f83fb87c4e786d0f09b54f54`.

**Exact primary reproduction**, after the common preparation:  
`rm -rf /home/user/cold-start-trial/work/is-5-{allow-protected,min-tests-zero,optional-failing-stage}-{1,2}; python3 harness/phase5.py --case min-tests-zero`

**Observed output:**

```text
🛡️ agentctl Safety Gate Audit Results (Base: HEAD, Mode: working-tree)
-----------------------------------------------------
  Phase [SCOPE] : ✅ PASS
  Phase [PAYLOAD] : ✅ PASS
  Phase [SECRETS] : ✅ PASS
  Phase [VERIFY] : ✅ PASS
  Phase [EVIDENCE] : ✅ PASS
-----------------------------------------------------
Overall Result: APPROVED (Exit 0)
```

Recording: [`phase5-is-min-tests-zero-1-gate.log`](evidence/phase5-is-min-tests-zero-1-gate.log).

```text
🛡️ agentctl Safety Gate Audit Results (Base: HEAD, Mode: working-tree)
-----------------------------------------------------
  Phase [SCOPE] : ✅ PASS
  Phase [PAYLOAD] : ✅ PASS
  Phase [SECRETS] : ✅ PASS
  Phase [VERIFY] : ✅ PASS
  Phase [EVIDENCE] : ✅ PASS
-----------------------------------------------------
Overall Result: APPROVED (Exit 0)
```

Recording: [`phase5-is-optional-failing-stage-1-gate.log`](evidence/phase5-is-optional-failing-stage-1-gate.log).

**Expected:** Expose every effective waiver in human and JSON output, including environment aliases and stage.required: false. A waived or advisory test should not be indistinguishable from a strictly passing check.

**Falsifiable fix check:** `python3 "$REPORT/replay.py" F18 --expect-fixed`

**Found versus caused / repeat control:** Found: the same protected Go manifest comment failed strictly and passed under either JULES_ALLOW_COMMAND_FILE_CHANGES=true or its AGENT alias. CLI --allow-protected printed a banner; the environment forms did not. The optional stage really ran a failing suite, as its separate host log and execution record show. Both copies agreed.

### F19. verify.required: false says nothing is executed while displaying an executed failure

**Severity 3.** With an authorized required:false config, the output says nothing is executed, then shows the actual failing go test command. Severity 3: the explanation and documented scope-only meaning are wrong; the red result still corresponds to a real failing command, not a false red on healthy code.

**Repository / SHA:** matryer/is @ `0d9f7ec708a3dd34f83fb87c4e786d0f09b54f54`.

**Exact primary reproduction**, after the common preparation:  
`rm -rf /home/user/cold-start-trial/work/is-5-required-false-{1,2}; python3 harness/phase5.py --case required-false`

**Observed output:**

```text
🛡️ agentctl Safety Gate Audit Results (Base: HEAD, Mode: working-tree)
-----------------------------------------------------
  ⚠️  OVERRIDES ACTIVE — this run is not a strict pass:
       • verify.required: false (nothing is executed)
-----------------------------------------------------
  Phase [SCOPE] : ✅ PASS
  Phase [PAYLOAD] : ✅ PASS
  Phase [SECRETS] : ✅ PASS
  Phase [VERIFY] : ❌ FAIL
     - Stage: unit (exit 1)
     - Command: go test ./...
     - Output:
         [02mis_test.go:39: [00m1 != 2[31m // 1 doesn't equal 2[00m
```

Recording: [`phase5-is-required-false-1-gate.log`](evidence/phase5-is-required-false-1-gate.log).

**Expected:** Either actually run only scope/secrets when opting out, or describe the implemented behavior precisely: existing commands still run, while absence/collection requirements are relaxed.

**Falsifiable fix check:** `python3 "$REPORT/replay.py" F19 --expect-fixed`

**Found versus caused / repeat control:** Found: the config was committed as authorized policy before making the same production break used in the other Go controls. The native test and the displayed gate stage both failed in two fresh directories.

### F20. Dry-run semantics and labels are inconsistent

**Severity 3.** check --dry-run persisted evidence despite its help promising not to; committed evidence.enabled:false also did not stop manifest writes. Session-get and plan-approve dry runs reported active/approved synthetic results without a rehearsal marker, unlike dispatch’s clearly labeled dry run. Severity 3 here: the misleading result is not an approval of a code diff without verification.

**Repository / SHA:** matryer/is @ `0d9f7ec708a3dd34f83fb87c4e786d0f09b54f54`.

**Exact primary reproduction**, after the common preparation:  
`rm -rf /home/user/cold-start-trial/work/is-5-dry-run-{1,2}; python3 harness/phase5.py --case dry-run`

**Observed output:**

```text
  --dry-run          Simulate gate evaluation without persisting evidence (-d)
```

Recording: [`help-check.log`](evidence/help-check.log).

```text
.agent/config.yml
.agent/evidence/EVD-1788611337337-2643799f.json
.agent/evidence/manifest.v1.json
```

Recording: [`phase5-is-dry-run-1-after.log`](evidence/phase5-is-dry-run-1-after.log).

```text
✅ Plan Approved Successfully!
   Session ID : cold-start-no-session
   Status     : approved
```

Recording: [`phase6-is-provider-loop-1-plan-dry.log`](evidence/phase6-is-provider-loop-1-plan-dry.log).

**Expected:** Honor the promised evidence-write boundary and label every simulated remote result as simulated. A rehearsal should not look like confirmation from a provider that was never contacted.

**Falsifiable fix check:** `python3 "$REPORT/replay.py" F20 --expect-fixed`

**Found versus caused / repeat control:** Found: before/after file inventories in two fresh directories show new evidence files. No provider key or CLI was present. Dispatch dry-run and queue dry-run correctly disclosed simulation; queue file hashes stayed unchanged. The plan/session dry paths alone omitted that disclosure.

### F21. Many subcommand help pages return only the global command list

**Severity 4.** The help sweep succeeded as processes, but many pages never explained that subcommand’s flags. This is severity 4 navigation friction; the separately tested nonexistent flag is F17. I had to inspect the installed parser to discover --base and several gate controls.

**Repository / SHA:** published kit gitHead `b08bfbfb2f46829ae2e4fa6e10b2d6b90b5a1ae3`; fresh non-repository help contexts.

**Exact primary reproduction**, after the common preparation:  
`rm -rf /home/user/cold-start-trial/work/replay-F21-{1,2}; python3 "$REPORT/replay.py" F21`

**Observed output:**

```text
agentctl v0.71.0 — Universal Agent Orchestrator & Safety Gatekeeper

Usage: agentctl <command> [options]

Commands:
```

Recording: [`help-pr-harvest.log`](evidence/help-pr-harvest.log).

**Expected:** Provide specific usage and escape-hatch documentation for each subcommand. README, help, and parser should agree about commands, aliases, and options.

**Falsifiable fix check:** `python3 "$REPORT/replay.py" F21 --expect-fixed`

**Found versus caused / repeat control:** Found: 76 help invocations are preserved and hashed, with additional fresh-directory repetitions for this finding. The full README command/claim inventory and documented-versus-undocumented lists are in README-INVENTORY.md.

### F22. Repository removal is possible but not documented as a complete undo

**Severity 4.** Reverting the scaffold commit left ignored runtime evidence/state behind. Manual removal restored each repository’s exact original tracked tree. I found no uninstall/undo-init instructions in the README or checked documentation. Severity 4: survivable manual cleanup, not irrecoverable damage.

**Repository / SHA:** sindresorhus/p-limit @ `783068bb9e967fd7bea8642e1bf5a3627fe38bdf`; pallets/itsdangerous @ `672971d66a2ef9f85151e53283113f33d642dabd`; matryer/is @ `0d9f7ec708a3dd34f83fb87c4e786d0f09b54f54`; darakian/mini_markdown @ `9f61074a47134575736b86bd305bc796962ff868`.

**Exact primary reproduction**, after the common preparation:  
`rm -rf /home/user/cold-start-trial/work/{p-limit,itsdangerous,is,mini_markdown}-repeat-undo-{1,2}; python3 harness/phase7.py`

**Observed output:**

```text
 delete mode 100644 SPEC.md
?? .agent/
?? .cursor/
?? .github/workflows/
?? .gitlab-ci.agent-gate.yml
.agent/evidence/EVD-1788611621101-8efa4c21.json
.agent/evidence/EVD-1788611621613-a23fad30.json
.agent/evidence/manifest.v1.json
.agent/state/flaky.jsonl
```

Recording: [`phase7-is-1-revert.log`](evidence/phase7-is-1-revert.log).

**Expected:** Document the generated-file manifest, modified .gitignore entries, runtime directories, optional integrations, and a removal procedure that preserves preexisting user files. `clean` is maintenance, not an uninstaller.

**Falsifiable fix check:** `python3 "$REPORT/replay.py" F22 --expect-fixed`

**Found versus caused / repeat control:** Found: init file hashes were identical on the second run in both fresh directories for all four ecosystems. Two gate outputs were identical too, with expected new runtime records. After revert plus targeted runtime/integration removal, `git diff --exit-code ORIGINAL_SHA HEAD` and untracked-file listings were empty in all eight undo runs. Global npm uninstallation was not performed.

## 3. The denominator

The verbatim quickstart stopped at the third command on the randomly selected no-suite repository. The diagnostic matched in the PTY and non-TTY paths; this plain non-TTY excerpt avoids stripping terminal control bytes:

```text
[FATAL ERROR] Unfalsifiable Task Rejected: Task must include a non-trivial verification test/build command. Configure verify.test in .agent/config.yml or pass --verify-cmd.
```

Recording: [`phase1-nontty-1-task.log`](evidence/phase1-nontty-1-task.log).


“Command time” sums recorded child-process durations, including repeats; it excludes reading, fixture authoring, report writing, and the two interruption gaps. It is not a claim that all phases took only the time spent waiting for commands. Late trial confirmations retain their original phase labels. Additional packaging/replay-tool smoke checks are recorded separately and do not add attack families to these denominators.

| Phase | Status | Approx. measured command time | What actually happened |
|---|---|---:|---|
| 0 — claims/help | Completed | 7 s help sweep, plus reading/setup | Read the entire installed README and compared it with the checkout; inventoried commands/promises; ran root help and 76 command/subcommand/alias help invocations. See README-INVENTORY.md. |
| 1 — quickstart | Completed, stopped at the tool’s honest refusal | 18 s | Ran all three README commands verbatim in a real kernel PTY, twice, on the randomly chosen GitHub repository. stdin and stdout were TTYs. init/commit succeeded; task creation refused because the repository had no test oracle. The same non-TTY recipe agreed. Plain interactive init completed all seven questions. No hang was reproduced. |
| 2 — ecosystems | **Partial: four runnable ecosystems; live monorepo blocked** | 2.6 min | Baseline host tests/build/lint where available; init, scaffold commit, default clean gate; host checks after scaffold. Node/Python/Go approved; Rust failed F14/F15. The thiserror workspace was scaffolded and checked, but native Cargo and gate commands both failed dependency retrieval. No healthy-monorepo verdict is claimed. |
| 3 — dishonest edits | Completed on all four runnable targets | 6.2 min | 9 cases × 4 repositories × 2 fresh runs = 72 valid runs. 12/36 case pairs were false greens. All production-only breaks were rejected; protected config changes were rejected against the installed baseline. |
| 4 — honest edits | Completed, with explicit N/A/no-op cells | 6.1 min | 27 applicable cases × 2; 24 approved, 3 lockfile cases scope-rejected. Corrected two Node fixtures that violated the host linter. Go has no lockfile. Black and gofmt made no diff on their already formatted inputs, so those two cells do not demonstrate a guard’s tolerance of changed formatting. Node and Rust had genuine formatter diffs and passed. |
| 5 — boundaries | **Partial: core gate controls exercised; broader controls inventoried** | 2.2 min | 25 primary probe families × 2 fresh copies, plus the two retained equivalent-Python-expectation negative controls. Narrow allow kinds, their unrelated-skip controls, unreadable dialect waivers, environment aliases, profiles, required/minTests, optional stages, evidence controls, strict-locks, and dry-run. Remote merge and network-policy/SDK-only controls remain unverified; see ESCAPE-HATCHES.md. |
| 6 — full loop | Completed offline; live execution unavailable | 24 s | Task creation in TTY/non-TTY, provider diagnostics, dry dispatch, dry queue with unchanged file hashes, real dispatch and queue refusal for missing API key, session/plan dry paths, patch refusal, evidence show/verify. Plain interactive task creation also completed twice. No provider result or remote PR was produced. |
| 7 — repeats/undo | Completed | 1.6 min | 2 independent fresh directories per ecosystem; init twice, byte-identical scaffold hashes; gate twice, identical verdict output; expected runtime append-only changes. Revert plus targeted runtime/integration cleanup restored original tracked trees in all eight cases. Generated GitHub/GitLab/IDE integrations were additionally inspected on Go. |
| 8 — silence hunt | Completed for local targets | 3.0 min | 17 targeted attempts, each repeated: no-op strings/boolean, empty selection, absent oracle, collect-only, mutable wrapper, two snapshot modes, installed Python copy, untracked-code coverage/mutation/max, build tags, cfg, xfail, early return, focused tests. The successful refusals are included, not hidden. |

### Findings discarded and procedural caveats

**Five candidate product findings did not survive validation:** (1) Klona’s native suite was already broken before init; (2) the first Node helper fixture violated AVA’s import rules and import order; (3) default Prettier output violated the repository’s XO formatting policy; (4) a Python build failure came from my switching to an environment without the build module, not from scaffold contents; (5) the suspicion that Node max would approve the new arithmetic file was falsified by its mutation rejection. The corrected Node fixtures and corrected Python build passed. These were not promoted to gate bugs.

**Zero valid candidate findings disagreed between their first and second fresh-directory reproductions.** Three instrumentation problems were also kept separate: an early Python variable shadowed `round`, the PyPI Go package did not expose gofmt on PATH until linked, and one negative flag-control edit targeted a function that the same fixture had just renamed. The harness assertions stopped those runs; they were corrected and rerun. They are not extra gate failures. Original logs are retained where relevant. During packaging, a fourth instrumentation issue appeared: a bundle-only restore omitted the original local base refs, so the bootstrap replay stopped at base resolution rather than exercising its attack. I preserved that invalid run, restored the bundled refs, tightened the fix predicate so an argument/base-resolution exit cannot count as a fix, and reproduced the real false green twice again. This did not contradict the two valid original runs.

Process-hygiene caveat: one early Rust dependency-failing `cargo test` invocation overlapped the Python scaffold confirmation while toolchain setup was being explored. It never reached Rust test execution. That is a procedural deviation from the strict serial-invocation rule, not evidence of a gate defect. Subsequent suites and attack probes were run serially. No provider, dev server, or watcher was left running.

### Final process check

Recorded at **2026-09-05T13:23:45Z**, after the last product/host execution:

```sh
ps -eo pid,cmd | grep -E "node .*(agentctl|jules-|node --test)" | grep -v grep | wc -l
```

Actual output:

```text
0
```

Recording: [`final-process-check.log`](evidence/final-process-check.log), with the exact command and timestamp in its accompanying metadata. No further product or host suites were run after this check; only report packaging and validation followed.

See [MATRIX.md](MATRIX.md) for every honest/dishonest cell, the runner status behind the verdict, and all silence attempts. See [FILES-AND-UNDO.md](FILES-AND-UNDO.md) for generated paths and cleanup.

## 4. What I could not verify

The real provider loop stopped at dispatch, before a session/result existed. The same clear diagnostic appeared in both fresh loops:

```text
❌ Dispatch Failed: JULES_API_KEY environment variable is required for Google Jules API dispatch.
```

Recording: [`phase6-is-provider-loop-1-dispatch-real.log`](evidence/phase6-is-provider-loop-1-dispatch-real.log).


- **Real provider work, repair, warm-session resume, patches, or PR approval/merge:** no Jules/Gemini API credentials and no Claude, Codex, or Gemini executable were present. GitHub authentication was available, but that is not a Jules credential. A connected, authorized provider and an explicitly disposable remote repository would be needed. Actual no-key failures were clear and correctly nonzero; I did not manufacture a remote result.
- **A successful real monorepo gate:** thiserror’s Cargo workspace could not fetch proc-macro2 and other dependencies from crates.io. Its native baseline failed for that same environmental reason. The inspected Humphrey workspace also required external crates. I did not rewrite either workspace’s dependencies or call its infrastructure failure a severity 2. An accessible registry/cache is needed for that portion of phases 2–4 and affected-workspace behavior.
- **Every advertised ecosystem/platform:** only Linux, Node 22, Python 3.11, Go 1.25.5, and Rust 1.88 were exercised. Windows/macOS, other Node majors, Ruby/PHP/JVM/.NET/etc., and the README’s cross-platform/unit-test-count claims were not independently verified.
- **Complete hosted CI and all optional controls:** local equivalents ran for available host scripts, including the Python pre-commit suite. This was not a full multi-OS CI matrix, nightly Rust/miri/docs build, an external PR-check experiment, or a network isolation audit. Missing lint/build scripts were recorded as absent, not invented. The package’s broad provider, sandbox, secret-redaction, router, repair, and transactional-rollback promises are catalogued but not all validated by a live workflow.
- **Every filesystem side effect:** the report inventories directly observed scaffold/runtime/integration files and exact Git restoration. There was no syscall-level filesystem trace. Compiler caches and test/build outputs follow the host command; global toolchain installation is not attributed to init. Global npm uninstall was not executed because the CLI was still required for the trial.

## 5. The verdict a stranger would reach

I would keep this as a local diagnostic tool, but I would not let its APPROVED result authorize an AI agent’s merge without another trusted check. It caught real production failures, several test deletions/skips, and an untested Node mutation under max. The provider-free path is genuinely useful. But an approval can also mean that no tests executed, that the wrong copy was tested, or that an agent-selected policy defined what counted as checking. A warning beneath a green phase does not repair that trust gap.

I would tell a colleague to try it in advisory mode, keep their original CI authoritative, and inspect both the actual command and the revision/package it runs against. I nearly gave up at the Rust onboarding path: a green native suite first became a lint failure, then was described as an empty suite even after 58 tests passed. The Python scaffold breaking a basic end-of-file CI hook is smaller technically, but exactly the kind of first-run red that encourages someone to turn a gate off. The safe catches and clean honest refactors show value; the false approvals mean that value is not yet dependable delegation.

## 6. The single change I would make first

**Make approval attest an immutable, explicitly selected code-and-policy snapshot rather than the live working directory.** Materialize the selected staged/committed/working-tree change in a disposable checkout, pin policy and the base outside the proposed diff, and make the executed commands’ evidence identify that snapshot. If the binding or completed verification cannot be established, return non-approval—not an exit-zero unverified pass.

That is one approval-contract change, not a request for more heuristic regexes. It addresses the most dangerous first-hour failures: an agent changing its own effective policy and a gate testing different code from the diff it approves. Better messages, an EOF fix, and additional assertion dialects all matter, but none can make a green result trustworthy while its evidence is attached to the wrong inputs.
