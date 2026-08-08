## 🤖 Jules Orchestrator PR Summary

### 🎯 Task Objective & Scope
<!-- Concise description of the problem solved or feature added -->

### 🔒 Capability-Bounded Execution Envelope (CBEE)
- **Envelope Integrity Hash:** `<!-- Paste envelope SHA-256 or 'N/A' -->`
- **Scope Verification:** [ ] Verified all modified files are within target `allow_paths` and zero `forbidden_paths` breached.

### 🛡️ Risk Tier Classification
- [ ] **R0 (Cosmetic):** Documentation, formatting, non-executing assets.
- [ ] **R1 (Routine):** Non-critical feature additions with 100% test coverage.
- [ ] **R2 (Consequential):** Core engine refactors, CLI behavior modifications (Requires 1 Reviewer).
- [ ] **R3 (Restricted):** Security modules, auth handlers, CI workflow modifications (Requires Security Review).

### 🧪 Automated Verification Receipts
```text
<!-- Paste output of 'npm test' or CI test run execution proof -->
```

### 📋 Invariants & Quality Checklist
- [ ] **Zero Runtime Dependencies:** Native Node.js ESM built-ins only (`node:fs`, `node:path`, `node:crypto`, `node:child_process`).
- [ ] **100% Verification Suite:** All unit tests pass cleanly (`npm test`).
- [ ] **Zero Lint Errors:** ESLint passes cleanly (`npm run lint`).
- [ ] **Cross-Platform Normalization:** All file paths use POSIX slashes (`/`).
