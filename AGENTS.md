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
    <rule>1. ZERO EXTERNAL DEPENDENCIES: You are STRICTLY FORBIDDEN from adding third-party npm dependencies. Use ONLY native Node.js built-in modules (node:fs, node:path, node:child_process, node:crypto, etc.).</rule>
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
- **Falsifiable Claims**: Base all code changes on explicit error logs, file paths, line numbers, or test results.
- **No Token Bloat**: Exclude lockfiles, minified bundles, and binary assets from diff representations.
- **Rebase Before PR**: Fetch latest `main`, rebase onto `origin/main`, re-execute verification suite. If the resulting diff is empty, close/abort PR without pushing.
- **Diff Payload Governor**: API forcefully truncates diff payloads > 80 KB. Keep total diff payload under 75 KB (`git diff | wc -c`).

---

## 5. System Prompting & Guardrail Best Practices

To maximize the ratio of mergeable PRs vs. failed or hallucinated sessions, adhere to the rules defined in `.agent/rules/jules-protocol.md`.

### Multi-Agent Coordination & Handover Architecture

- **Multi-Agent Mutex Lock Protocol**: Prevent concurrent file modification collisions. Check and acquire locks before modifying paths:
  ```bash
  node scripts/lock-manager.mjs acquire <agent_name> <task_id> <file_paths...> --unattended
  ```
- **The Baton Pass Protocol**: Write handover documents when a session pauses or hands off work (e.g. `.agent/history/YYYY-MM-DD-handover-[task_id].md`).

### Standard Jules Guardrails Footer

Append this footer to all Jules dispatches:

```text
Read AGENTS.md and .agent/rules/jules-protocol.md BEFORE starting.
Follow all rules strictly.

TASK: <description>

HARD CONSTRAINTS:
- Do NOT modify package.json, pnpm-lock.yaml, tsconfig.json, astro.config.mjs, wrangler.jsonc, or .github/ files. Enforced in CI by Agent Scope Guard.
- Diff Payload Governor: Keep total diff payload under 75 KB (`git diff | wc -c`) to prevent API truncation (~80 KB limit).
- Verify before finishing: Run full type-check, lint, and unit test suites.
- BEFORE opening the PR: Run `git fetch origin main && git rebase origin/main`, then re-verify. If the rebase leaves an empty diff, the work already landed — do NOT submit.
- Delete ALL temporary files (.py, .sh, .patch, debug logs) before submitting.
```
