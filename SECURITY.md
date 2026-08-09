# Security Policy & Zero-Trust Threat Model

## 🛡️ Core Security Vision

**Jules Orchestrator Kit** acts as a control plane for autonomous AI agents executing code inside developer repositories. Because AI agents receive instructions via prompts and make programmatic edits, security must be **enforced cryptographically and structural**, never relying solely on LLM prompt compliance.

---

## 🔒 Security Guarantees & Threat Model

The orchestrator enforces 5 non-negotiable security invariants:

### 1. Capability-Bounded Execution Envelope (CBEE)
Before any agent session begins, `createExecutionEnvelope()` computes an immutable JSON execution manifest containing:
- `baseSha`: Cryptographically locked Git commit SHA.
- `configSha`: SHA-256 hash of `.agent/jules.yml`.
- `scope`: Normalized `allow_paths`, `deny_paths`, and `protect_paths`.
- `verifyCmds`: Verified `test_cmd` and `build_cmd`.

Once frozen, any runtime attempt by an agent or sub-process to modify config, access forbidden paths, or alter verification commands fails closed immediately (`Exit Code 3: Scope Violation`).

### 2. Zero-Trust Base Branch Resolution
Security rules (such as `forbidden_paths`, `BUILTIN_DENY`, and `.agent/rules/`) are fetched strictly from `origin/main` (or the configured `BASE_BRANCH`).
- **Threat Mitigated:** An untrusted PR branch modified by an agent cannot overwrite security rules to grant itself elevated permissions.

### 3. Shannon Entropy Secret & PII Redaction
All outbound prompt payloads and diffs pass through `scanDiff()` and `redactSecrets()`:
- **Entropy Threshold:** Strings with Shannon entropy > `3.6 bits/char` are flagged for high-confidence secrets (API keys, private RSA keys, AWS secrets, GitHub tokens).
- **PII Masking:** Emails, IPv4/IPv6 addresses, and phone numbers are automatically redacted before transmission to remote LLM APIs.

### 4. SHA-256 Hash-Chained Audit Ledger
Every state transition, session reservation, and audit result is appended to `.agent/state/ledger.jsonl` using cryptographic hash-chaining (`prevHash` + `hash`).
- **Threat Mitigated:** Any manual tampering, line deletion, or log reordering invalidates the chain during `verifyLedgerIntegrity()`.

### 5. OODA Thrash & State Fingerprinting
Failed agent executions generate a 16-character SHA-256 state fingerprint combining normalized stderr traces and git patch diffs.
- **Threat Mitigated:** If an agent enters an infinite repair loop producing identical failures, `repair()` halts execution early (`DETERMINISTIC_REGRESSION`, Exit Code 4) to prevent token burning.

---

## 📋 Supported Versions

| Version | Status | Security Maintenance |
| :--- | :--- | :--- |
| `v0.29.x` (Latest) | 🟢 Active | Full security updates & CBEE enforcement |
| `< v0.9.0` | 🔴 Deprecated | Upgrade to >= v0.9.4 recommended |

---

## 🚨 Reporting Vulnerabilities

If you discover a security vulnerability, scope bypass, or secret leak issue within this orchestrator:

1. **Do NOT open a public GitHub issue.**
2. Report the vulnerability privately via **[GitHub Security Advisories](https://github.com/FullThrottle83/jules-orchestrator-kit/security/advisories/new)**.
3. Include:
   - Orchestrator version (`agentctl --version`).
   - Reproduction steps or payload snippet.
   - Expected vs actual isolation behavior.

We acknowledge reports within **24 hours** and provide a resolution timeline within **72 hours**.
