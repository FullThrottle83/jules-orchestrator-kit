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

### Canonical Operator Commands (authoritative)

Operations run **only** via `agentctl`. Standalone helper scripts were removed as shims. **This supersedes any older `scripts/*.mjs` path from a stored memory or another repo** — if one is not in `package.json`, it is stale; use the equivalent here instead of burning repair turns on `ENOENT`.

- Locks: `agentctl lock acquire <agent> <task_id> <file_path...>` (positional, no `--unattended`; conflict exits `1` naming the holder) · `lock status` · `lock release <task_id>`. *(was `scripts/lock-manager.mjs`)*
- Learnings: `agentctl learning add "<trigger>" "<solution>"` — both args required; regenerates `.agent/SYSTEM_LEARNINGS.md`, never hand-edit it. *(was `scripts/add-learning.mjs`)*
- Prompt hydration: `agentctl hydrate [prompt]` · Self-audit: `npm run jules:audit` · Doc drift: `npm run jules:doc-sync`
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
- **Google Labs Exploration Budget Protocol**: Execute complex tasks across 3 discrete phases: (1) Discovery & Symbol Tracing (silent inspection, write NO code), (2) Oracle & Test Formulation, and (3) Surgical Implementation & Verification. Proven to increase Hit@5 accuracy from 33% to 57%.
- **Critic Agent Steering (Adversarial Pre-Review)**: Jules' internal Critic Agent must evaluate proposed patches for edge-case failures, $O(n^2)$ complexity regressions, unhandled parameters, and layout shifts (CLS) prior to final PR submission.

---

## 5. System Prompting & Guardrail Best Practices

To maximize the ratio of mergeable PRs vs. failed or hallucinated sessions, adhere to the rules defined in `.agent/rules/jules-protocol.md`.

### Multi-Agent Coordination, Verification Gates & Web Envelopes

- **Task Envelope Premise Validator**: Validates referenced paths, allowed scope, and base freshness before dispatching tasks (`node scripts/validate-envelope.mjs <envelope.json>`). Prevents session burnout on missing files.
- **Web Development Task Envelopes**: Pre-calibrated task templates (`agentctl task template`) for frontend excellence:
  - `web-cwv`: Core Web Vitals & Lighthouse Budget Guard (LCP < 1.2s, CLS < 0.05, INP < 100ms).
  - `web-wcag`: WCAG 2.2 AA/AAA semantic accessibility, modal focus traps, color contrast (>= 4.5:1), and ARIA live-regions.
  - `web-seo`: Schema.org structured data (JSON-LD), OpenGraph/Twitter cards, canonical tags, and sitemap integrity.
  - `web-playwright`: E2E visual regression and multi-viewport responsive testing (375px, 768px, 1440px).
  - `web-flaky-heal`: Playwright timing & async flakiness auto-remediation (network mocking, state isolation).
- **Stale-Base Gate Predicate**: Rejects PRs/branches whose merge-base is > 25 commits behind `origin/main` (`node scripts/stale-base-check.mjs`).
- **Asset Integrity Gate**: Inspects binary and font assets (`.woff2`, `.png`, `.jpg`) to ensure saved HTML/text error pages never land silently (`node scripts/asset-integrity-check.mjs`).
- **Edge-Runtime Import Guard**: Automatically detects Edge environments (Cloudflare Workers, Vercel Edge, Netlify Edge) and blocks unsupported native Node.js module imports (`node:fs`, `node:child_process`, `node:net`, `node:tls`).

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

## 6. Exit Code Registry & Remediation Matrix

Standardized across all automation entry points (`agentctl`, `jules-dispatch`, `jules-self-audit`, `jules-queue-runner`).

| Code | Meaning | Immediate remediation |
| :--- | :--- | :--- |
| `0` | Success — verification passed, PR opened. | Merge, or proceed to the next queue task. |
| `1` | Pre-dispatch / arg failure; prompt > `limits.promptKb` (50 KB). | Shorten the prompt or check flags via `agentctl doctor`. |
| `2` | API / network — HTTP 429, `FAILED_PRECONDITION` concurrency quota, timeout. | Exponential backoff; stagger swarm dispatches (`staggerMs: 1500`). |
| `3` | Scope violation — restricted path (`.github/`, command files, `.agent/rules/`). | Drop protected files from the diff, or pass `allowProtected: true` / label `allow-protected-paths`. |
| `4` | OODA exhausted — 3 repair attempts without clean verification. | Inspect `.agent/state/` logs; fix the root cause or sharpen the repair prompt. |
| `5` | Diff payload exceeds `limits.diffKb` (default **75 KB**). | Split into smaller scoped envelopes (`npm run jules:validate-envelope`). |
| `6` | Secret leak prevented — high-confidence key in the patch diff. | Scrub the credential from source **and revoke the leaked key immediately**. |
| `7` | Quota exhausted — `dailyTasks` cap (default 300) reached. | Wait for the next UTC day, or raise `dailyTasks` in `.agent/config.yml`. |
| `8` | Flaky quarantine — oscillation >= 0.40 (Wilson CI interior). | Fix the non-deterministic test; OODA repair is suppressed by design, not broken. |

---

## 7. Release Protocol & Automated Versioning

Whenever bumping the package version in `package.json`:
1. Document changes under `CHANGELOG.md`.
2. Update version strings in `package.json` and `bin/agentctl.mjs`.
3. Execute `npm run release` (or `node scripts/release.mjs`) to automate running unit tests, tagging git (`v<version>`), pushing to `origin`, and creating the official GitHub Release via `gh release create`.

