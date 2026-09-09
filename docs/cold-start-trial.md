# Cold-start onboarding trial report

Artifact under test: `jules-orchestrator-kit@0.72.3` packed from this repository and installed from
a local tarball (`npm pack --pack-destination /tmp/`). The runtime audit ran on four clean target
fixture repositories under `/tmp/trial-fixtures/`. This file is a checked-in copy of the trial
report; the trial itself changed no tracked code — the fixes listed in "Risks & recommendations"
were implemented and committed alongside it (see the PR that carries this document).

## Files changed
(None — the trial run itself is a runtime report; code fixes from its findings are in the
accompanying commits.)

## Execution evidence

Environment: Node `v22.22.3`, npm `10.9.8`. Toolchain availability was limited — only the npm
registry and PyPI were reachable. `pytest` was installed and runnable; **`cargo` and `go` binaries
were not installable** (rustup/go.dev/apt are network-blocked), so the Rust and Go fixtures
exercised file-based stack detection and the full CLI surface but their native verification commands
could not be *executed*. This is an environmental constraint, not a kit defect.

Each fixture is a real git repository with a committed baseline (the kit resolves the project root
and diff via `git rev-parse`). Protocol per fixture: `npm init -y` (when no `package.json` existed) →
`npm install -D <tarball>` → `npx --yes jules-orchestrator-kit init --yes` → the exact CLI sequence.

### Summary table

| Fixture | Step | Exit code | Status |
|---|---|---|---|
| Python (`pyproject.toml` + pytest) | npm init -y | 0 | OK |
| Python | npm install -D tarball | 0 | OK |
| Python | npx init --yes | 0 | OK — stack `python`, test `python3 -m pytest` (oracle probe passed) |
| Python | agentctl doctor | 0 | OK (7 passed / 3 warnings) |
| Python | agentctl providers | 1 | ENV — no provider ready (no API key/binary) |
| Python | agentctl task create -p … | 1 | FAIL — gate-preflight scope (see F1) |
| Python | agentctl gate | 3 | FAIL — scope (F1) |
| Python | agentctl check | 3 | FAIL — scope (F1) |
| Rust (`Cargo.toml` + `#[test]`) | npm init -y | 0 | OK |
| Rust | npm install -D tarball | 0 | OK |
| Rust | npx init --yes | 0 | OK — stack `cargo`, test `cargo test` (oracle probe failed: no cargo binary — ENV) |
| Rust | agentctl doctor | 0 | OK (detects `cargo`, test `cargo test`) |
| Rust | agentctl providers | 1 | ENV |
| Rust | agentctl task create -p … | 1 | FAIL — gate-preflight scope (F1) |
| Rust | agentctl gate | 3 | FAIL — scope (F1) |
| Rust | agentctl check | 3 | FAIL — scope (F1) |
| Go (`go.mod` + `TestSample`) | npm init -y | 0 | OK |
| Go | npm install -D tarball | 0 | OK |
| Go | npx init --yes | 0 | OK — stack `go`, test `go test ./...` (oracle probe failed: no go binary — ENV) |
| Go | agentctl doctor | 0 | OK |
| Go | agentctl providers | 1 | ENV |
| Go | agentctl task create -p … | 1 | FAIL — gate-preflight scope (F1) |
| Go | agentctl gate | 3 | FAIL — scope (F1) |
| Go | agentctl check | 3 | FAIL — scope (F1) |
| JS zero-test (`package.json`, no test script) | npm install -D tarball | 0 | OK (pkg pre-existed; init skipped) |
| JS zero-test | npx init --yes | 0 | OK — stack `node`, test **none detected**; profile `standard → anti-tamper` (no unit stage) |
| JS zero-test | agentctl doctor | 0 | OK (stack `node`, Test Command `(None)`) |
| JS zero-test | agentctl providers | 1 | ENV |
| JS zero-test | agentctl task create -p … | 1 | FAIL — Unfalsifiable task (F2) |
| JS zero-test | agentctl gate | 3 | FAIL — scope (F1) |
| JS zero-test | agentctl check | 3 | FAIL — scope (F1) |

Controlled follow-up runs (committed onboarding baseline, scope noise removed):

| Fixture (scenario) | Step | Exit code | Status |
|---|---|---|---|
| JS committed + source change, **no tests** | agentctl gate | 4 | PASS as designed — VERIFY fail-closed, "No Verification Oracle" (F09 confirmed) |
| JS committed + tracked `package-lock.json` change | agentctl gate | 3 | FAIL — `package-lock.json` rule=protect |
| same + documented waiver | agentctl gate --allow-protected | 4 | OK — proceeds to VERIFY fail-closed (scope+verify correctly isolated) |
| Python committed + real `health.py` + passing `test_health.py` | agentctl gate | 0 | OK — APPROVED, ran `python3 -m pytest` (2 passed) |

### Verbatim stdout/stderr for failed or unexpected steps

Python — `agentctl task create` (F1):
```
[FATAL ERROR] Gate Preflight Rejected Task: Repository contains scope or secret violations (Exit 3).
```

Python — `agentctl gate --json` scope violations (F1 root cause — the non-`.agent` file is what the
task-create preflight keeps):
```
.agent/config.yml            protect
.agent/jules-queue/README.md deny
.agent/jules.yml             protect
.agent/rules/dynamic-guardrails.json  protect
.agent/rules/jules-protocol.md        protect
package.json                 protect
```

Python — `agentctl check` (scope; identical on Rust/Go):
```
  Phase [SCOPE] : ❌ FAIL
     - Violation: .agent/config.yml (Rule: protect)
     - Violation: .agent/jules-queue/README.md (Rule: deny)
     - Violation: .agent/jules.yml (Rule: protect)
     - Violation: .agent/rules/dynamic-guardrails.json (Rule: protect)
     - Violation: .agent/rules/jules-protocol.md (Rule: protect)
     - Violation: package.json (Rule: protect)
Overall Result: REJECTED (Exit 3)
```

JS zero-test — `agentctl task create` (F2):
```
[FATAL ERROR] Unfalsifiable Task Rejected: Task must include a non-trivial verification test/build
command. Configure verify.test in .agent/config.yml or pass --verify-cmd.
```

JS zero-test, committed baseline + untested source change — `agentctl gate` (F09, VERIFY phase):
```
  Phase [VERIFY] : ❌ FAIL
     - Unverified: The verification command exited 0, but no recognised test runner stated how many
       tests it ran, so the gate cannot tell a full suite from a command that ran nothing. Verified by
       exit code alone.
     - Stage: oracle (exit n/a)
Overall Result: REJECTED (Exit 4)
💡 Remediation Hint (Exit 4 No Verification Oracle):
   • Give it a command:   agentctl bootstrap        (generates one for this stack)
```

## Findings summary

**High — F1: Cold-start deadlock — `task create` is blocked by a scope preflight on the files the
install/`init` just created, and `init`'s own commit hint omits them.**
Expected: after `npm install -D <pkg>` + `agentctl init --yes`, the next documented action
(`agentctl task create`, `gate`, `check`) should run, or at least name everything to commit. Actual:
on a repo where `npm init -y` created a brand-new `package.json` (the Python/Rust/Go fixtures), the
fresh working tree contains `.agent/config.yml`, `.agent/jules.yml`, scaffolded rules, and an
untracked `package.json` flagged `rule=protect`. `gate`/`check` exit 3 on scope. The task-create
preflight (`src/wizard-task.mjs`) deliberately ignores `.agent/` violations but keeps `package.json`,
so it throws `Gate Preflight Rejected Task (Exit 3)` — task creation is impossible until the tree is
committed. `init`'s success message tells the user to run
`git add .agent AGENTS.md SPEC.md CONSTRAINTS.md .gitignore && git commit` — a command that does **not**
include `package.json` or `package-lock.json`. A user following that instruction still has a dirty
tree and the same failure recurs.

**Medium — F2: Zero-test JS repos cannot create *any* task without first creating a test oracle.**
Expected: onboarding should surface the "no verification" state early but leave a path forward.
Actual: `agentctl task create` hard-fails with `Unfalsifiable Task Rejected` until `verify.test` is
set or `agentctl bootstrap` generates an oracle. This is fail-closed by design (consistent with F09)
and the message is clear, but it is a second, distinct blocker on the exact cold-start path for the
most common stack (JS), and `doctor` reported `exit 0` — so the operator's first "is this healthy?"
check is green while the very next create/gate step is red.

**Medium — F3: `cargo` test command is inconsistent between detection paths.**
`detectStack`/`stack-detector.mjs` returns `cargo test --workspace`; the wizard and `doctor` (which
read the written manifest) report `cargo test`. For a single-crate repo the two are equivalent, so
impact is low at runtime, but a drift between the detector and the value persisted to
`.agent/config.yml` is the same class of bug the code comments elsewhere explicitly guard against.

**Low — F4: `agentctl providers` exits 1 in a clean sandbox.**
Expected behavior on a machine with no API key and no provider CLI installed is arguably informative,
not a hard failure; the tool exits 1 with a useful "every gate works with no provider" note. Acceptable
but worth an explicit non-zero-means-"nothing ready" contract so CI scripts don't misread it as a kit
error. (Runs here were ENV: no `JULES_API_KEY`/`GEMINI_API_KEY`, no `claude`/`codex`/`gemini` binaries.)

**Low — F5: Rust/Go oracle probe fails at `init` and prints a warning but still exits 0 when the
toolchain is absent.**
Detection is correct (stack + test command), and `init` degrades gracefully — but only after a
two-line `[Failed] Oracle verification probe failed` + `[Failed] npm test also failed` wall of text
(the npm fallback runs the `npm init -y` placeholder script). Consider skipping the npm-test fallback
when the stack is definitively cargo/go, and exiting non-zero (or printing a clearer single hint) when
the declared verify command's binary is missing.

## Risks & recommendations

1. **Patch `init`'s commit hint (F1, High).** In `bin/agentctl.mjs` (the `agentctl init` tail) and
   `bin/init.js`, include install-produced manifest/lockfiles in the suggested
   `git add … && git commit` line — collect `package.json`, `package-lock.json`, `yarn.lock`,
   `pnpm-lock.yaml`, `Cargo.lock`, `go.sum` when present. Better, detect when the tree is otherwise
   clean after that commit and print "you're ready for `agentctl task create`".
2. **Reconsider task-create preflight (F1).** In `src/wizard-task.mjs`, treat a *fresh, uncommitted*
   `package.json`/lockfile created since the repo's baseline as a setup artifact rather than a protect
   violation (the code already filters `.agent/`; extend the filter to install artifacts produced by
   onboarding). Keep lockfile protect for real, post-onboarding dependency churn.
3. **Gate detection guidance for zero-test stacks (F2).** Surface the missing oracle as a red doctor
   check (or at least make `doctor` exit non-zero) so the healthy-looking `exit 0` does not precede an
   unexpected `task create`/`gate` rejection, and print the one-command bootstrap remedy on `init`
   for JS/generic repos with no tests.
4. **Single-source the verification command projection (F3).** Make the cargo/go (and other) test
   command written to `.agent/config.yml` come from the same `detectPolyglotStack`/`resolveVerify`
   value that `doctor`/`gate` recompute, so `cargo test --workspace` is either always or never the
   emitted value.
5. **Package `bin` surface (validation).** All five declared bins resolved after install
   (`agentctl`, `jules-orchestrator-kit`, `jules-init`, `jules-mcp`, `agentctl-mcp`) and
   `npm pack` shipped including `.agent/rules/` + prompts + workflows referenced in the manifest
   `files` allowlist — no missing-bin or missing-asset regression observed on cold install.
