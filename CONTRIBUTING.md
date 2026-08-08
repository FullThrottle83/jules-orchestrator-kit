# Contributing to Jules Orchestrator Kit

Thank you for contributing to **Jules Orchestrator Kit**! This document provides guidelines and best practices for human developers and automated AI agents contributing code to this repository.

---

## 🏗️ Core Engineering Directives

All contributions must strictly follow these core invariants:

1. **Zero Runtime Dependencies:**
   - The orchestrator has **0 third-party npm runtime dependencies**.
   - Use ONLY native Node.js built-in ESM modules (`node:fs`, `node:path`, `node:crypto`, `node:child_process`, `node:util`).

2. **Read-Before-Write (Zero Hallucination):**
   - Inspect exact symbol definitions and method signatures before editing existing files.
   - Do not guess internal API structures.

3. **Cross-Platform Normalization:**
   - Always normalize Windows backslashes (`\`) to POSIX slashes (`/`) for paths and glob patterns using `normalizePath()`.

4. **100% Verification Suite:**
   - Every PR must pass 100% of unit tests (`npm test`) and 0 ESLint errors (`npm run lint`).
   - Never weaken assertions, swallow errors, or delete failing tests to force a pass.

---

## 🔄 Development & Testing Workflow

### 1. Setup Environment
```bash
# Clone repository
git clone https://github.com/FullThrottle83/jules-orchestrator-kit.git
cd jules-orchestrator-kit

# Install dev dependencies (ESLint)
npm install
```

### 2. Run Verification Suite
Before opening a PR, execute the complete verification suite:
```bash
# Run unit tests
npm test

# Run ESLint linter
npm run lint

# Run pre-flight self-audit
node scripts/jules-self-audit.mjs --preflight
```

### 3. Subscription Tier Testing (`JULES_TIER`)
When introducing features that affect rate limits, session budgets, or OODA repair loops, verify behavior across subscription tiers:
```bash
# Test Free Tier budget limits (15 tasks/day, 1 repair attempt)
JULES_TIER=free npm test

# Test Pro Tier budget limits (100 tasks/day)
JULES_TIER=pro npm test
```

---

## 🛡️ Risk Tiers & PR Guidelines

Every Pull Request is categorized into a **Risk Tier**:

| Tier | Category | Description | Review Requirements |
| :--- | :--- | :--- | :--- |
| **`R0`** | **Cosmetic** | Documentation, markdown formatting, SVG assets. | Auto-merge eligible |
| **`R1`** | **Routine** | Isolated package logic with unit tests. | 1 Standard Review |
| **`R2`** | **Consequential** | Core engine updates (`engine.mjs`), CLI changes. | 1 Maintainer Review |
| **`R3`** | **Restricted** | Security modules (`security.mjs`, `execution_envelope.mjs`), CI workflows. | Security Review Required |

### Pull Request Checklist
- [ ] Conventional Commit title (`feat:`, `fix:`, `docs:`, `test:`, `style:`).
- [ ] Attached full terminal output of `npm test` and `npm run lint`.
- [ ] Verified CBEE execution envelope compliance (no forbidden path modifications).
- [ ] Added or updated unit tests in `test/` for new functionality.

---

## 🐛 Reporting Bugs & Vulnerabilities

- **General Bugs & Feature Requests:** Open a [GitHub Issue](https://github.com/FullThrottle83/jules-orchestrator-kit/issues) with reproduction steps and environment metadata.
- **Security Vulnerabilities:** See [SECURITY.md](SECURITY.md) to submit a private disclosure via GitHub Security Advisories.
