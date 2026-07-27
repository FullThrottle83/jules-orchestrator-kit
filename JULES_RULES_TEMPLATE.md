# Google Jules Autonomous Worker Directives

These guidelines govern all automated coding tasks executed by Google Jules (`jules`).

---

## 1. Triage Directive (When to use Jules)

Dispatch tasks to Jules when ALL of the following apply:
1. Scoped code change with a clear objective.
2. Mechanically verifiable via automated test/build commands (`npm test`, `cargo test`, `pytest`, etc.).
3. Requires no interactive local debugging or visual UI tweaking.
4. Does NOT modify restricted files (`.github/`, deployment keys, or unreviewed database migrations).

---

## 2. MCP Machine Directive & Read-Before-Write Invariants

```xml
<MCP_DIRECTIVE>
  <system_state>HEADLESS_CI_MODE</system_state>
  <strict_invariants>
    <rule>1. NO CONVERSATION: Output ONLY machine-actionable tool calls or valid patches. No conversational filler or superlatives.</rule>
    <rule>2. READ-BEFORE-WRITE (ZERO HALLUCINATION): You are FORBIDDEN from guessing internal API signatures. Before editing, you MUST use code search or MCP doc tools to inspect exact function signatures.</rule>
    <rule>3. VERIFICATION LOOP: After patching code, you MUST execute the project's verification commands (tests/build) and ensure 0 errors.</rule>
    <rule>4. ABORT CONDITION: On repeated unresolvable test failures (4+ attempts), output <status>ABORT_UNRESOLVABLE</status> and terminate immediately.</rule>
  </strict_invariants>
</MCP_DIRECTIVE>
```

---

## 3. Dynamic Command Resolution

Jules automatically infers test and build verification commands based on project manifest files:
- `package.json` -> `npm test && npm run build`
- `Cargo.toml` -> `cargo test --workspace && cargo build`
- `go.mod` -> `go test ./... && go build ./...`
- `pyproject.toml` -> `pytest`
- `pom.xml` -> `mvn test`
- `build.gradle` -> `./gradlew test`
- `.agent/jules.yml` -> Custom user commands

---

## 4. Operational & Code Quality Directives

- **Read Before Write**: Always inspect target files and surrounding symbol signatures (via grep or view tools) before applying changes.
- **Rebase Before PR**: Fetch latest `main`, rebase onto `origin/main`, re-execute verification suite. If the resulting diff is empty, close/abort PR without pushing.
- **Minimal Interference**: Preserve existing function signatures, comments, and style conventions.
- **Falsifiable Claims**: Base all code changes on explicit error logs, file paths, line numbers, or test results.
- **No Token Bloat**: Exclude lockfiles, minified bundles, and binary assets from diff representations.
