# Roadmap to v1.0

This roadmap visualizes the path from the **v0.20.0 Community Release Candidate** to v1.0.  
**Zero Runtime Dependencies** is a *product feature* of this project. Any external databases or complex frameworks are avoided for core components.

For a comparison with related projects in the ecosystem, see [PRIOR_ART.md](./PRIOR_ART.md).

---

## Current Milestone: v0.20.0 Community Release Candidate

The L9-hardened foundation is locked (VFS directory mutex, Content-Length MCP streaming, process group signal management, TOCTOU symlink defense, OODA thrash ring-buffer breakers). The focus is now on community field-testing across 300+ daily sessions.

- [x] **Zero-Dependency Stdio MCP Server**: Expose `jules-orchestrator-kit` as a standard MCP tool (`dispatch_jules_task`, `audit_jules_gate`, `check_risk_tier`, `get_jules_status`).
- [x] **L9 Infrastructure Hardening**: VFS directory mutex linearizability, process group signal termination, TOCTOU symlink protection, ReDoS-hardened secret scanning.
- [x] **A Linter in CI**: ESLint integrated in GitHub Actions (`jules-audit.yml`).
- [ ] **Community Field-Testing & Benchmarking**: Collect feedback on edge cases and high-concurrency swarm workloads.
- [ ] **Documented Patterns & Exit Code Manual**: Finalize troubleshooting guide for exit codes 0–7.

---

## Post-1.0 (Backlog)

- **Localhost Web Dashboard**: Zero-dependency local visualizer powered by `node:http`.
- **Human Escalation Bridge**: Slack/Discord bridge for asynchronous escalation from `AWAITING_USER_FEEDBACK`.
- **Local CI Container Isolation**: Script integration to run pre-flight verification in isolated containers.
