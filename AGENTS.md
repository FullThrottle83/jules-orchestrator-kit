# Google Jules Autonomous Worker Directives

These guidelines govern all automated coding tasks executed by Google Jules (`jules`) on `jules-orchestrator-kit`.

---

## 1. Triage Directive (When to use Jules)

Dispatch tasks to Jules when ALL of the following apply:
1. Scoped code change with a clear objective.
2. Mechanically verifiable via automated test/build commands (`npm test`).
3. Requires no interactive local debugging or visual UI tweaking.
4. Does NOT modify restricted files (`.github/`, deployment keys, or `.agent/jules.yml`).

---

## 2. MCP Machine Directive & Read-Before-Write Invariants

```xml
<MCP_DIRECTIVE>
  <system_state>HEADLESS_CI_MODE</system_state>
  <strict_invariants>
    <rule>1. ZERO RUNTIME DEPENDENCIES: You are STRICTLY FORBIDDEN from adding third-party npm dependencies. Use ONLY native Node.js built-in modules (node:fs, node:path, node:child_process, node:crypto, etc.).</rule>
    <rule>2. READ-BEFORE-WRITE (ZERO HALLUCINATION): You are FORBIDDEN from guessing internal API signatures. Before editing, inspect exact symbol definitions.</rule>
    <rule>3. CROSS-PLATFORM PATHS: Always normalize Windows backslashes (\) to POSIX slashes (/) when manipulating paths or glob matching.</rule>
    <rule>4. VERIFICATION LOOP: After patching code, execute `npm test` and ensure 100% of tests pass cleanly with 0 errors.</rule>
    <rule>5. ABORT CONDITION: On repeated unresolvable test failures (4+ attempts), output <status>ABORT_UNRESOLVABLE</status> and terminate immediately.</rule>
  </strict_invariants>
</MCP_DIRECTIVE>
```

---

## 3. Dynamic Command Resolution

Jules automatically infers test and build verification commands via `scripts/command-resolver.mjs`:
- `.agent/jules.yml` -> Custom user commands (`test_cmd`, `build_cmd`)
- `package.json` -> `testCmd: "npm test"` (or `"npm run lint && npm test"`), `buildCmd: "npm run build"`
- `Cargo.toml` -> `testCmd: "cargo test --workspace"`, `buildCmd: "cargo build"`
- `go.mod` -> `testCmd: "go test ./..."`, `buildCmd: "go build ./..."`
- `pyproject.toml` -> `testCmd: "pytest"`, `buildCmd: ""`
- Workspace graphs (`turbo.json`, `pnpm-workspace.yaml`, `nx.json`) -> targeted affected package filters

---

## 4. Operational & Code Quality Directives

- **Read Before Write**: Inspect target files and surrounding symbol signatures before applying changes.
- **Minimal Interference**: Preserve existing function signatures, comments, and zero-dependency architecture.
- **Falsifiable Criteria**: Never use unfalsifiable goals ("utterly perfect", "complete refactor"). Define tasks with binary scoreable criteria (e.g. passing test counts, 0 lint errors, explicit hard-fails).
- **Carry Evidence with Claims**: "It works" means pasting terminal verification output. Exit code 0 alone proves only process survival; inspect outputs/artifacts to prove function.
- **No Test Weakening Rule**: Never make a test pass by deleting assertions, commenting out checks, or weakening requirements. Leave unmet requirements RED with clear fix rationale.
- **Explicit File Ownership**: Sequence parallel swarm agents with explicit non-overlapping file ownership to prevent concurrent drift.
- **No Token Bloat**: Exclude lockfiles, minified bundles, and binary assets from diff representations.
- **Rebase Before PR**: Fetch latest `main`, rebase onto `origin/main`, re-execute verification suite. If the resulting diff is empty, close/abort PR without pushing.
- **Diff Payload Governor**: API forcefully truncates diff payloads > 80 KB. Keep total diff payload under 75 KB (`git diff | wc -c`).

---

## 5. System Prompting & Guardrail Best Practices

To maximize the ratio of mergeable PRs vs. failed or hallucinated sessions, adhere to the rules defined in `.agent/rules/jules-protocol.md`.

### Multi-Agent Coordination & Verification Gates

- **Task Envelope Premise Validator**: Validates referenced paths, allowed scope, and base freshness before dispatching tasks (`node scripts/validate-envelope.mjs <envelope.json>`). Prevents session burnout on missing files.
- **Stale-Base Gate Predicate**: Rejects PRs/branches whose merge-base is > 25 commits behind `origin/main` (`node scripts/stale-base-check.mjs`).
- **Asset Integrity Gate**: Inspects binary and font assets (`.woff2`, `.png`, `.jpg`) to ensure saved HTML/text error pages never land silently (`node scripts/asset-integrity-check.mjs`).

### Standard Jules Guardrails Footer

Append this footer to all Jules dispatches:

```text
Read AGENTS.md and .agent/rules/jules-protocol.md BEFORE starting.
Follow all rules strictly.

TASK: <description>

HARD CONSTRAINTS:
- Do NOT modify package.json, pnpm-lock.yaml, tsconfig.json, or .github/ files. Enforced in CI by Agent Scope Guard.
- Diff Payload Governor: Keep total diff payload under 75 KB (`git diff | wc -c`) to prevent API truncation (~80 KB limit).
- Falsifiable & Evidence-Based: Attach full terminal verification output to PR. Never weaken assertions or delete failing tests to force a pass.
- Declare Scope Deviations: If modifying files outside task bounds, explicitly state rationale in PR.
- Verify before finishing: Run full type-check, lint, and unit test suites.
- BEFORE opening the PR: Run `git fetch origin main && git rebase origin/main`, then re-verify. If the rebase leaves an empty diff, the work already landed — do NOT submit.
- Delete ALL temporary files (.py, .sh, .patch, debug logs) before submitting.
```

---

## 6. Exit Code Registry for CI/CD Integration

The orchestrator enforces standardized exit codes across all automation scripts (`jules-dispatch`, `jules-self-audit`, `jules-queue-runner`):

| Exit Code | Classification | Description |
| :--- | :--- | :--- |
| `0` | **Success** | Task completed cleanly; PR opened or verification passed. |
| `1` | **Pre-Dispatch / Arg Failure** | Invalid arguments, prompt > 50 KB, or pre-dispatch validation error. |
| `2` | **API / Network Failure** | Jules API rate-limit (HTTP 429), `FAILED_PRECONDITION` concurrency quota, or connection timeout. |
| `3` | **Scope Violation** | Attempted modification of restricted files (`.github/`, command files, agent rules). |
| `4` | **OODA Exhausted** | Auto-repair loop reached maximum retries (3) without achieving clean verification. |
| `5` | **Diff Payload Limit** | Post-change git diff exceeds payload budget (`JULES_MAX_DIFF_KB`, default 50 KB). |
| `6` | **Secret Leak Prevented** | High-confidence secret or private key detected in patch diff. |
| `7` | **Quota / Budget Exhausted** | Daily task session quota limit reached (`dailyTasks: 300`). |
| `8` | **Flaky Quarantine** | Statistical flaky test detected and quarantined (oscillation >= 0.4, Wilson CI); OODA repair suppressed. |

---

## 7. Exit Code Troubleshooting & Remediation Matrix

| Exit Code | Cause | Immediate Remediation Action |
| :--- | :--- | :--- |
| `0` | Clean run. | Proceed to merge PR or next queue task. |
| `1` | Invalid prompt, missing arguments, or prompt > 50 KB. | Reduce prompt length below 50 KB or verify command line flags (`agentctl doctor`). |
| `2` | Network failure, API rate limit (429), or worker concurrency limit. | Retry with exponential backoff or stagger swarm dispatches (`staggerMs: 1500`). |
| `3` | Modified protected file (`.github/`, `package.json`, `.agent/rules/`). | Remove protected files from diff or run with `allowProtected: true` / label `allow-protected-paths`. |
| `4` | Verification suite (`npm test`, build) failed after 3 OODA repair attempts. | Inspect error logs in `.agent/state/`, fix root cause manually or provide clearer repair prompt. |
| `5` | Diff payload exceeded threshold (> 75 KB). | Split task into smaller scoped sub-tasks using task envelopes (`validate-envelope.mjs`). |
| `6` | High-confidence secret detected in patch diff (e.g. AWS/Stripe key). | Scrub leaked credentials from source code, revoke leaked key immediately. |
| `7` | Daily quota cap reached (`dailyTasks: 300`). | Wait until next day UTC cycle or adjust `dailyTasks` limit in `.agent/config.yml`. |
| `8` | Test quarantined due to statistical flakiness (oscillation >= 0.4, Wilson CI interior). | Inspect test stability; fix non-deterministic test code rather than sending OODA repair loops. |

---

## 8. Release Protocol & Automated Versioning

Whenever bumping the package version in `package.json`:
1. Document changes under `CHANGELOG.md`.
2. Update version strings in `package.json` and `bin/agentctl.mjs`.
3. Execute `npm run release` (or `node scripts/release.mjs`) to automate running unit tests, tagging git (`v<version>`), pushing to `origin`, and creating the official GitHub Release via `gh release create`.

