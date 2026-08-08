# Code of Conduct & Autonomous Agent Governance Pledge

## 🛡️ Core Statement & Scope

As maintainers, human contributors, and users of the **Jules Orchestrator Kit**, we pledge to maintain an inclusive, respectful, and safe community for human collaborators while enforcing strict safety and security standards for autonomous AI agents operated within this framework.

This policy applies across all community channels, GitHub repositories, and automated agent execution sessions driven by `jules-orchestrator-kit`.

---

## 👥 Human Community Standards

We enforce standard professional community standards to ensure a welcoming environment for everyone regardless of background, identity, or experience level.

### Positive Community Behaviors
- **Respect & Constructive Feedback:** Offer clear, technical, and actionable feedback on code and architecture PRs.
- **Inclusivity:** Welcome developers of all skill levels, from junior engineers to principal architects.
- **Accountability:** Take responsibility for code issues or regressions, and work collaboratively to resolve them.

### Unacceptable Behaviors
- Personal attacks, trolling, or derogatory comments.
- Publishing private information (PII, credentials, IP addresses) without consent.
- Harassment in public or private forums.

---

## 🤖 Autonomous Agent Operating Standards

Because this framework delegates code execution to autonomous AI agents (such as Google Jules), all contributors—whether human developers or AI agent operators—must adhere to the following **Agent Governance Standards**:

### 1. Responsible Autonomous Operation
- **Scope Compliance:** Agents and prompt dispatches must operate strictly within declared `allow_paths`. Attempts to manipulate prompts to breach `forbidden_paths` or modify security rule files (`.agent/rules/`, `.github/`) are strictly forbidden.
- **CBEE Envelope Integrity:** Never attempt to bypass or disable Capability-Bounded Execution Envelopes (`execution_envelope.mjs`). All session dispatches must remain immutably bound to their base SHA and verified config.

### 2. Evidence-Based & Falsifiable Engineering
- **No Assertion Weakening:** Never attempt to make unit tests or CI pipelines pass by deleting test assertions, commenting out checks, or swallowing runtime errors.
- **Mandatory Verification Receipts:** All pull requests submitted by automated agents must include full, untruncated terminal verification output proving `npm test` exit code 0.

### 3. Supply-Chain & Architecture Integrity
- **Zero Runtime Dependencies:** Contributors must strictly maintain the zero-dependency invariant. Do not introduce third-party npm packages. Use native Node.js built-in ESM modules (`node:fs`, `node:path`, `node:crypto`, `node:child_process`).
- **Resource & Token Efficiency:** Respect API rate limits and daily task budgets. Use Tier Presets (`free`, `pro`, `ultra`) appropriately to prevent quota exhaustion and API thrashing.

---

## ⚖️ Enforcement & Reporting

Violations of human community standards or intentional security bypass attempts may be reported privately via **GitHub Security Advisories**. Community maintainers will review reports promptly and take appropriate corrective action, including PR rejection or repository access restriction.

---

## 🔗 Attribution

This Code of Conduct builds upon the principles of the [Contributor Covenant](https://www.contributor-covenant.org) (v2.1) and extends them with the **Google Jules Autonomous Worker Directives**.
