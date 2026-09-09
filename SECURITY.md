# Security Policy & Zero-Trust Threat Model

## Prompt Sanitization & Content Filters

`sanitizePromptVocabulary()` in `src/prompt-guard.mjs` transforms high-trigger
operational terms in prompt prose to reduce false-positive provider content
filter refusals. For example, prose containing `kill -9` becomes
`terminate with SIGTERM`, and `SIGKILL` becomes `SIGTERM`. These substitutions
can change technical meaning: SIGTERM is not equivalent to SIGKILL.

Fenced code blocks (triple backticks) and inline backtick code spans are
preserved verbatim by this vocabulary transformation (commit `ad2011a`). Put
exact commands and identifiers in code spans or blocks when their spelling
matters. This preservation does not exempt content from other prompt guards
or secret redaction.

Vocabulary rewriting is not a security boundary, a guarantee of provider
acceptance, or a replacement for provider content filters. Review transformed
prompt text when exact operational semantics matter; scope checks, execution
envelopes, and verification remain separate controls.

## 🛡️ Core Security Vision

**Jules Orchestrator Kit** acts as a control plane for autonomous AI agents executing code inside developer repositories. Because AI agents receive instructions via prompts and make programmatic edits, security must be **enforced cryptographically and structural**, never relying solely on LLM prompt compliance.

---

## 🔒 Security Guarantees & Threat Model

The orchestrator enforces 5 non-negotiable security invariants:

### 1. Capability-Bounded Execution Envelope (CBEE)
`createExecutionEnvelope()` (`src/execution-envelope.mjs`) builds an immutable JSON execution manifest containing:
- `baseSha`: the resolved Git commit SHA of the base branch.
- `configSha`: SHA-256 hash of the JSON-serialized scope triple `{ denyPaths, allowPaths, protectPaths }` (`hashConfigScope`, `src/execution-envelope.mjs:44`) — the normalized scope only, not the literal `.agent/jules.yml` file or the entire configuration.
- `scope`: Normalized `allow_paths`, `deny_paths`, and `protect_paths`.
- `verify`: the resolved `test_cmd` and `build_cmd`.

The envelope is deep-frozen (`Object.freeze`) and carries a self-verifying `hash`; `verifyExecutionEnvelope()` recomputes and compares it, so any in-memory mutation is detectable. The gate enforces the scope contract on every changed path through `checkScope()` (`src/scope-guard.mjs`): touching a denied path, a protected path (`.agent/config.yml`, `package.json`, CI definitions, `.agent/rules/**`), or a path that escapes the repository root fails closed with `Exit Code 3: Scope Violation`.

### 2. Zero-Trust Base Branch Resolution
The authoritative security policy — `.agent/config.yml` / `.agent/jules.yml` (scope deny/protect/allow and verification commands) — is read from the trusted base commit via `resolveTrustedPolicy()` → `showFromOrigin()` (`git show <base>:<file>`, `src/git.mjs:761`), never from the working tree under review. `resolveBase()` (`src/git.mjs:352`) prefers `origin/<base>`, then `refs/remotes/origin/<base>`, and only falls back to a bare local ref when the remote ref is unavailable.
- **Bootstrap exception:** when the base commit carries no config yet, a proposed scaffold is accepted only if it passes `checkBootstrapPolicyIntegrity()` (no placeholder/empty verification, no `minimal` profile downgrade, no `verify.required: false`, and `base_branch` cannot be `HEAD`).
- **Threat Mitigated:** An untrusted PR branch modified by an agent cannot overwrite security rules to grant itself elevated permissions.

### 3. Secret Scanning & PII Redaction
Added diff lines pass through `scanDiff()`; outbound prompt payloads pass through `redactSecrets()` and `anonymizePii()` (all in `src/secret-scanner.mjs`):
- **Structured high-confidence secrets** (`hasHighConfidenceSecret`, line 71): regex patterns for AWS keys, private-key PEM blocks, GitHub/Slack/Stripe/OpenAI tokens, JWTs, etc. `hasEncodedSecret()` (line 399) decodes base64 blobs and applies the same patterns.
- **Entropy-based token detection** (`hasHighEntropyToken`, line 475): added-line tokens of ≥ 24 characters with Shannon entropy > `4.5 bits/char` are flagged as potential unstructured secrets.
- **Environment-variable redaction** (`redactSecrets`, line 91): an environment value is scrubbed from outbound text when it is ≥ 20 characters or exceeds `3.6 bits/char` entropy, and its key name matches a credential heuristic (`KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH|…`).
- **PII Masking** (`anonymizePii`): emails, IPv4/IPv6 addresses, and phone numbers are automatically redacted before transmission to remote LLM APIs.

### 4. SHA-256 Hash-Chained Audit Ledger
State transitions, budget reservations, and session/task events are appended to a date-scoped ledger `.agent/state/ledger-<YYYY-MM-DD>.jsonl` (`getDailyLedgerPath`, `src/state.mjs:55`) using cryptographic hash-chaining (`prevHash` + `hash`). `appendLedger()` refuses to follow a symlinked ledger path.
- **Threat Mitigated:** Any manual tampering, line deletion, or log reordering invalidates the chain — `verifyLedgerIntegrity()` (`src/state.mjs:308`) reports `BROKEN_PREV_HASH` or `CORRUPTED_ENTRY_HASH`.

### 5. OODA Thrash & State Fingerprinting
Failed agent executions generate a 16-character SHA-256 state fingerprint (`fingerprintFailureState`, `src/engine.mjs:138`) from a normalized stderr trace plus the diff's added/removed line counts.
- **Threat Mitigated:** If an agent enters a repair loop producing identical failures, the sliding-window `OODACircuitBreaker` (threshold 2) trips and `repair()` halts early (`DETERMINISTIC_REGRESSION`, `src/engine.mjs:942`); the gate surfaces this as `Exit Code 4` (`src/engine.mjs:731`) to prevent token burning.

---

## 📋 Supported Versions

| Version | Status | Security Maintenance |
| :--- | :--- | :--- |
| `v0.73.x` (Latest) | 🟢 Active | Full security updates & CBEE enforcement |
| `< v0.73.0` | 🔴 Deprecated | Upgrade to >= v0.73.0 recommended |

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
