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
- `pyproject.toml` -> `testCmd: "pytest"`, `buildCmd: "python3 -m compileall -q ."`
- Workspace graphs (`turbo.json`, `pnpm-workspace.yaml`, `nx.json`) -> targeted affected package filters

### Canonical Operator Commands (authoritative)

Operations run **only** via `agentctl`. Standalone `scripts/*.mjs` shims were removed; if one is not in `package.json`, it is stale.

- Locks: `agentctl lock acquire <agent> <task_id> <file_path...>` (conflict exits `1` naming the holder) · `lock status` · `lock release <task_id>`.
- Learnings: `agentctl learning add "<trigger>" "<solution>"` — both args required; regenerates `.agent/SYSTEM_LEARNINGS.md`, never hand-edit it.
- Flaky tests: `agentctl flaky status|heal|reset` · Escalations: `agentctl escalate <session_id>|--status|--flush`.
- Prompt hydration: `agentctl hydrate [prompt]` · Self-audit: `npm run jules:audit` · Doc drift: `npm run jules:doc-sync`.
- Use `JULES_DRY_RUN=1` when exercising dispatch paths so no session is spent.

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
- **Exploration Budget Protocol**: For complex tasks, run 3 phases — (1) silent Discovery & Symbol Tracing (no code), (2) Oracle & Test Formulation, (3) Surgical Implementation & Verification. Raises Hit@5 from 33% to 57%.
- **Critic Agent Pre-Review**: Evaluate patches for edge-case failures, $O(n^2)$ regressions, unhandled parameters, and CLS before opening the PR. In test changes, prove deliberate mutations turn tests red.

---

## 5. System Prompting & Guardrail Best Practices

To maximize the ratio of mergeable PRs vs. failed or hallucinated sessions, adhere to the rules defined in `.agent/rules/jules-protocol.md`.

### Multi-Agent Coordination, Verification Gates & Web Envelopes

- **Task Envelope Premise Validator**: Validates paths, scope, and base freshness (`agentctl task create`).
- **Task Envelopes & Templates**: Pre-calibrated, stack-agnostic templates — run `agentctl task template --list` for the current set. Web: CWV/WCAG/SEO/Playwright/i18n/AI-access. Agent hardening: dead-code audit, QA mutation, CI falsification, service isolation, error paths, security audit. Universal (work in any language the detector recognises, since verify commands hydrate from config): `agent-dep-audit` (deps/supply chain), `agent-doc-drift` (docs vs shipped surface), `agent-config-audit` (typed config + secret hygiene), `agent-api-contract` (route/handler + error-shape parity). Deep Think: debug/feature/optimize/harden.
- **Specialist Roles**: Eight personas ship as stack-neutral prompts in `.agent/prompts/`, selected with `agentctl dispatch --role <name>` (case-insensitive): `overseer`, `bolt`, `sentinel`, `janitor`, `a11y`, `scribe`, `spectator`, `alchemist`. They hydrate `{{VERIFY_TEST}}`/`{{VERIFY_LINT}}`/`{{DIFF_KB}}`/`{{BASE_BRANCH}}` from the target repo so a non-Node project is never told to run `npm test`.
- **Stale-Base Gate Predicate**: Rejects PRs whose merge-base is > 25 commits behind `origin/main`.
- **Asset Integrity Gate**: Inspects assets (`.woff2`, `.png`, `.jpg`) to ensure error pages never land silently.
- **Edge-Runtime Import Guard**: Blocks unsupported native Node imports (`node:fs`, `node:child_process`) in Edge environments.

### Standard Jules Guardrails Footer

`agentctl task create` generates this from the repo's resolved scope (`buildGuardrailFooter`, `src/wizard-task.mjs`), so the protected-path line names this project's real manifests. Match its shape in hand-written dispatches:

```text
Read AGENTS.md and .agent/rules/jules-protocol.md BEFORE starting.
Follow all rules strictly.

TASK: <description>

HARD CONSTRAINTS:
- Do NOT modify these protected paths: <from `agentctl gate`; here: package.json, .github/**, .agent/rules/**>. Enforced in CI by Agent Scope Guard.
- Diff Payload Governor: Keep total diff payload under 75 KB (`git diff | wc -c`) to prevent API truncation (~80 KB limit).
- Falsifiable & Evidence-Based: Attach full terminal verification output to PR. Never weaken assertions or delete failing tests to force a pass.
- Declare Scope Deviations: If modifying files outside task bounds, explicitly state rationale in PR.
- Verify before finishing: Run full type-check, lint, and unit test suites.
- BEFORE opening the PR: Run `git fetch origin main && git rebase origin/main`, then re-verify. If the rebase leaves an empty diff, the work already landed — do NOT submit.
- Remove any scratch files you created for debugging before submitting. Do not delete files that are part of the project.
```

---

## 6. Exit Code Registry & Remediation Matrix

Standardized across all automation entry points (`agentctl`, `jules-dispatch`, `jules-self-audit`, `jules-queue-runner`).

| Code | Meaning | Immediate remediation |
| :--- | :--- | :--- |
| `0` | Success — verification passed, PR opened. | Merge, or proceed to the next queue task. |
| `1` | Pre-dispatch / arg failure; prompt > `limits.promptKb` (50 KB). | Shorten the prompt or check flags via `agentctl doctor`. |
| `2` | API / network — HTTP 429, `FAILED_PRECONDITION` concurrency quota, timeout. | Exponential backoff; stagger swarm dispatches (`staggerMs: 1500`). |
| `3` | Scope violation — restricted path (`.github/`, command files, `.agent/rules/`), or a `strictTestLock` tamper verdict. | Drop protected files from the diff, or pass `--allow-protected` / label `allow-protected-paths`. |
| `4` | Verification failed; with `--fix`, OODA repair also exhausted. | Fix the stage the gate names — it prints stage, exit code and output. |
| `5` | Diff payload exceeds `limits.diffKb` (default **75 KB**). | Split into smaller scoped envelopes (`npm run jules:validate-envelope`). |
| `6` | Secret leak prevented — high-confidence key; the finding names file and line. | Scrub the credential from source **and revoke the leaked key immediately**. |
| `7` | Quota exhausted — `dailyTasks` cap (default 300) reached. | Wait for the rolling 24h budget window to open, or raise `dailyTasks` in `.agent/config.yml`. |
| `8` | Flaky quarantine — oscillation >= 0.40 (Wilson CI interior). | Fix the non-deterministic test; OODA repair is suppressed by design, not broken. |

---

## 7. Release Protocol & Automated Versioning

Whenever bumping the version:
1. Add a `CHANGELOG.md` entry, then bump `package.json`.
2. Push `main` first — the pipeline refuses to release a commit CI has not verified.
3. Run `npm run release`. It blocks on tests, the doc-sync gate, and a green CI matrix for `HEAD` before tagging `v<version>`, pushing, and creating the GitHub Release via `gh release create`. `--skip-ci-check` only when `gh` is unavailable.

