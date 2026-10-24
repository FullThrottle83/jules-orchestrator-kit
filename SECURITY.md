# Security policy and threat model

The kit checks candidate changes against repository policy and runs configured
verification commands. It is a control plane running with the operator's OS
permissions. Use a disposable runner without production credentials for untrusted
candidate code; the kit does not supply a process, filesystem or container sandbox.

## Supported versions

| Version | Status | Security maintenance |
| :--- | :--- | :--- |
| `v0.76.x` (Latest) | Active | Security fixes are delivered in this series |
| `< v0.76.0` | Superseded | Upgrade before evaluating the preview |

The package remains pre-1.0. Review release notes and pin a version in CI and MCP
client configuration. A passing local check does not certify a provider, project
or deployment environment.

## Trust boundaries

Repository policy is the authority for scope, verification commands and limits.
`resolveTrustedPolicy()` reads it from the selected trusted base commit rather
than accepting candidate working-tree changes as permission to widen policy.
`resolveBase()` prefers the configured remote-tracking base and can fall back to
a local base when that remote ref is unavailable. Keep refs current and verify
the selected base before accepting results. Initial setup has a constrained
bootstrap path; review and commit generated configuration before normal use.

Task envelopes may narrow policy and add verification. Provider output, prompts,
completion status and generated evidence do not authorize policy changes or
merges. Local CLI providers edit the checkout; hosted Jules works remotely.
Retrieve the actual candidate revision and run the independent gate before review.

## Checks and their limits

- **Scope and payload:** normalized allow, deny and protected paths, symlink and
  submodule restrictions, and configured diff-size limits. Protected-path waivers
  require the existing provenance checks; they are not provider-controlled.
- **Secrets and prompt content:** diff scanning uses known credential patterns,
  bounded decoding, normalization and entropy heuristics. Outbound redaction and
  PII masking reduce exposure. These detectors have false positives and coverage
  limits; they do not establish that arbitrary content contains no sensitive data.
- **Test integrity:** diff heuristics detect recognized assertion weakening and
  discovery changes. Pre/post hashes also detect test or source changes during
  verification. They do not prove that tests cover the intended behavior.
- **Verification:** project commands run in a materialized snapshot with an
  allowlisted environment. Ambient operator credentials are excluded from that
  environment. Explicit `verify.pass_env` entries are trusted configuration for
  non-secret toolchain paths, not a way to expose credentials.
- **Network guard:** the Node preload intercepts supported Node HTTP/fetch calls.
  It is not an OS network firewall; arbitrary candidate code and other executables
  must be isolated by the runner when stronger restrictions are needed.
- **Evidence and ledgers:** SHA-256 digests and hash chains detect inconsistencies
  against their recorded state. They are not authenticated signatures or remote
  attestations. A writer able to replace the records can recompute their hashes;
  retain trusted CI results and control write access to evidence.
- **Repair:** explicit repair has attempt limits and repeated-failure detection.
  These bound work, not correctness or total provider cost. Review its diff and
  rerun the gate before acceptance.

An execution envelope's hash detects changes relative to its recorded digest;
`Object.freeze()` protects the in-process object. Neither grants authenticity to
an envelope obtained from an untrusted source. Trusted base selection, enforced
scope and independent verification remain separate requirements.

## Prompt transformations

`sanitizePromptVocabulary()` in `src/prompt-guard.mjs` rewrites some operational
terms in prose to reduce provider refusals. Substitutions can change technical
meaning: `SIGKILL` becoming `SIGTERM` does not preserve signal semantics.

Fenced code blocks and inline backtick spans are preserved by vocabulary
rewriting. Put exact commands and identifiers there when spelling matters. They
still pass through other prompt guards and secret redaction. Review transformed
prompts; vocabulary rewriting is not a security boundary or a guarantee of
provider acceptance.

## Reporting vulnerabilities

Report suspected scope bypasses, credential exposure or other vulnerabilities
privately through [GitHub Security Advisories](https://github.com/FullThrottle83/jules-orchestrator-kit/security/advisories/new).
Include the package version, OS, Node version, affected command, configuration
with secrets removed, and a minimal reproduction with expected and actual results.

Keep credentials, private source and exploit details out of public issues. The
maintainer will triage the report and coordinate reproduction, fixes and disclosure
with the reporter. This preview does not offer a staffed response-time SLA.
