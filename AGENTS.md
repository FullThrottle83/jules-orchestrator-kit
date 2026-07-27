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

Jules executes test verification commands:
- `package.json` -> `npm test`
- `.agent/jules.yml` -> Custom user commands

---

## 4. Operational & Code Quality Directives

- **Read Before Write**: Inspect target files and surrounding symbol signatures before applying changes.
- **Minimal Interference**: Preserve existing function signatures, comments, and zero-dependency architecture.
- **Falsifiable Claims**: Base all code changes on explicit error logs, file paths, line numbers, or test results.
- **No Token Bloat**: Exclude lockfiles, minified bundles, and binary assets from diff representations.
