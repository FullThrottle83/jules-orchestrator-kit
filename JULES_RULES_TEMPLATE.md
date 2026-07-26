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

## 2. MCP-First Pre-Execution Directive

Never rely on pre-trained memory for rapidly evolving framework APIs or library signatures.

Before writing or editing code:
1. Perform targeted lookups using available Model Context Protocol (MCP) servers or official documentation tools.
2. Verify parameter signatures, exported modules, and syntax changes.

Every prompt dispatched to Jules MUST start with an `MCP DIRECTIVE:` mandating documentation verification before code generation.

---

## 3. Strict Pre-PR Verification Mandate

Before submitting any Pull Request or marking a task complete:
1. Run the project's verification suite (e.g., `npm run check:all && npm run test && npm run build`).
2. Fix all type-check errors, lint failures, and broken unit tests.
3. Ensure no trailing debug logs, unused imports, or temporary files are committed.

---

## 4. Operational & Code Quality Directives

- **Read Before Write**: Always inspect target files and surrounding context before applying changes.
- **Minimal Interference**: Preserve existing function signatures, comments, and style conventions.
- **Falsifiable Claims**: Base all code changes on explicit error logs, file paths, line numbers, or test results.
- **No Filler Copy**: Keep documentation, commit messages, and PR descriptions direct, technical, and telegraphic.
