# Roadmap to v1.0

This roadmap is intended to visualize the path to v1.0. 
**Zero Dependencies** is a *product feature* of this project, not a habit. Any external databases (beyond future built-in modules) and complex frameworks are avoided for the core components. 

For a comparison with related projects in the ecosystem (which inspired us), see [PRIOR_ART.md](./PRIOR_ART.md).

## Criteria for v1.0 Release

Before we stamp v1.0, the system must prove its stability, rather than just adding features. 
Once 1.0 is released, we promise that the structure of `.agent/jules.yml` and the exit codes (0–7) will remain **locked and stable** throughout the major version.

- [x] **A Linter in CI:** ESLint configured with `no-undef` and `no-unused-vars` and integrated into GitHub Actions (jules-audit.yml).
- [ ] **Integration Tests:** An end-to-end test case that actually runs `runSelfAudit` against a temporary git repo to test OODA bugs and exit paths in practice.
- [ ] **Production Runs (Proof of Concept):** Documented proof that the entire orchestration chain has run successfully against real Jules instances.
- [ ] **Documented Patterns:** Clear documentation of the built-in guardrail lists and specific troubleshooting guides for each exit code (so a user encountering exit 3 knows exactly why).
- [ ] **Formulated Stability Promise:** The `.agent/jules.yml` schema and exit codes are formalized in the documentation.

## The Only Feature before v1.0: MCP Server Integration

This is the single most valuable update for distribution.

- [ ] Expose `jules-orchestrator-kit` as a standard MCP tool (`dispatch_jules_task`).
- [ ] This makes the orchestrator usable right from within tools like Claude, Cursor, and Antigravity without any overhead.

---

## Post-1.0 (The Backlog)

Features related to large scale and complex visualizations belong here, with the strict requirement that they must be buildable using either *built-in modules* (e.g., `node:http`) or be completely excluded from the kit's core.

- **Database-driven Queue System (SQLite):** Pending until `node:sqlite` becomes a stable default in a newer Node.js LTS, or until Node 22.5+ is required specifically for the database part. Until then, the flat-file queue is perfectly adequate for the daily budget of 300 sessions.
- **Dashboard GUI (Localhost Web UI):** To visualize Jules tasks. If built, it will remain strictly dependency-free (server-rendered HTML via `node:http`) to respect our Zero Dependency rule.
- **Human Escalation Bridge & Slack/Discord Bridges:** Allows asynchronous escalation from `AWAITING_USER_FEEDBACK`. This requires the Jules API to expose the feedback state publicly first.
- **Local CI Verification Container Runner:** Integrate scripts to isolate the build (e.g., Nektos Act) prior to verification.
