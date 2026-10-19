# Production Examples & Deployment Patterns

This document details production deployment patterns for `jules-orchestrator-kit`. All patterns follow our strict **Zero External Runtime Dependencies** policy.

---

## Pattern 1: Scheduled Queue Dispatch & TODO Audit

Report `TODO`/`FIXME` annotations in workflow logs (`scan` prints findings to stdout and does not create task files) and dispatch pending Markdown task envelopes from `.agent/jules-queue/`:

### GitHub Actions Workflow (`.github/workflows/jules-nightly-remediation.yml`)

```yaml
name: Nightly Code Remediation

on:
  schedule:
    - cron: '0 2 * * *' # Run at 02:00 UTC daily
  workflow_dispatch:

jobs:
  remediator:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Report TODOs & Dispatch Queued Tasks
        env:
          JULES_API_KEY: ${{ secrets.JULES_API_KEY }}
          JULES_REPO: ${{ github.repository }}
          JULES_TIER: pro
        run: |
          # 1. Print TODO/FIXME annotations for triage (diagnostic output only)
          npx jules-orchestrator-kit scan

          # 2. Dispatch pending Markdown task envelopes in .agent/jules-queue/
          npx jules-orchestrator-kit queue
```

---

## Pattern 2: CI Security & Safety Gatekeeper

Block PRs containing secret leaks, scope violations, oversized diff payloads, or test regressions before merging to `main`:

### GitHub Actions Workflow (`.github/workflows/jules-pr-gate.yml`)

```yaml
name: Security & Verification Gatekeeper

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  gatekeeper:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # Fetch git history for merge-base check

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Run Safety & Verification Audit
        run: |
          npx jules-orchestrator-kit gate --base ${{ github.event.pull_request.base.ref || 'main' }}
```

---

## Pattern 3: Multi-Agent Parallel Swarm Execution

![Multi-Agent Parallel Swarm Topology](docs/assets/swarm-topology.svg?v=3)

Queue scoped Markdown task envelopes with `task create`, dispatch them concurrently across worker slots with `swarm`, and audit verified pull requests:

### CLI Swarm Command

```bash
# 1. Create Markdown task envelopes in .agent/jules-queue/
agentctl task create \
  --title "Refactor Auth Module" \
  --prompt "Convert auth callbacks to async/await in src/auth.mjs with unit tests" \
  --verify "npm test"

agentctl task create \
  --title "Add Rate Limiter" \
  --prompt "Implement token-bucket rate limiting in src/security.mjs with unit tests" \
  --verify "npm test"

# 2. Launch parallel swarm dispatch across worker slots (pass --dry-run to preview)
agentctl swarm --concurrency 2

# 3. Audit and harvest verified agent pull requests
agentctl pr harvest --dry-run
```

---

## Pattern 4: Non-Mutating Gate & Bounded Repair Loop

![Autonomous Verification Loop](docs/assets/ooda-loop-cycle.svg?v=3)

Verify candidate changes locally with the non-mutating `gate`:

```bash
# 1. Dispatch a scoped task to the configured provider
agentctl dispatch \
  --title "Fix Security Sanitizer" \
  --prompt "Sanitize user inputs in src/security.mjs and ensure all tests pass cleanly"

# 2. Run the independent, non-mutating verification gate (scope, secrets, diff budget, and tests)
agentctl gate
```

If `agentctl gate` rejects the change due to a test failure (rather than a scope, secret, or tamper violation) and you explicitly authorize bounded remediation, capture the failing test output, run `agentctl repair`, and re-run `agentctl gate` as the acceptance check:

```bash
fail_log="$(mktemp)"
trap 'rm -f "$fail_log"' EXIT
if ! npm test >"$fail_log" 2>&1; then
  cat "$fail_log" >&2
  agentctl repair --file "$fail_log" --cmd "npm test" || exit $?
fi
agentctl gate
```

During `agentctl repair`, the orchestrator feeds failure diagnostics back into bounded repair attempts (up to `limits.repairAttempts`) and halts early if the failure fingerprint repeats (`Exit Code 4`). Final acceptance still requires `agentctl gate` to pass.

---

## Pattern 5: Stdio Model Context Protocol (MCP) Integration

Connect `jules-orchestrator-kit` directly as a stdio Model Context Protocol server to **Claude Desktop**, **Cursor**, or **Antigravity**:

### MCP Client Configuration (`mcpSettings.json`)

```json
{
  "mcpServers": {
    "jules-orchestrator": {
      "command": "npx",
      "args": ["-y", "jules-orchestrator-kit", "mcp"],
      "env": {
        "JULES_API_KEY": "YOUR_JULES_API_KEY",
        "JULES_REPO": "owner/repo",
        "JULES_TIER": "ultra"
      }
    }
  }
}
```

---

## Pattern 6: Specialist Agent Roles

Leverage pre-configured specialist role prompts from `.agent/prompts/`. Every
role is stack-neutral: the prompt hydrates `{{VERIFY_TEST}}`,
`{{VERIFY_LINT}}`, `{{DIFF_KB}}` and `{{BASE_BRANCH}}` from your repository's
config, so a Cargo or pyproject checkout gets `cargo test`/`pytest`, not
`npm test`.

```bash
# Dispatch performance optimization using performance role
agentctl dispatch --role performance \
  --prompt "Optimize JSON parser throughput in src/mcp.mjs"

# Dispatch security vulnerability patch using security role
agentctl dispatch --role security \
  --prompt "Audit and fix prototype pollution risks in src/state.mjs"

# Dispatch tech debt cleanup using hygiene role
agentctl dispatch --role hygiene \
  --prompt "Remove dead code and unused imports in src/utils.mjs"

# Audit accessibility (A11y), metadata (docs), E2E (e2e), or
# review a database migration (database) — role names are case-insensitive.
agentctl dispatch --role a11y --prompt "Audit focus management in the checkout modal"
agentctl dispatch --role docs --prompt "Audit canonical URLs and OpenGraph tags on /pricing"
agentctl dispatch --role e2e --prompt "Add headless multi-viewport regression tests for the nav"
agentctl dispatch --role database --prompt "Review the new migration for reversibility and data-loss risk"
```

---

## Pattern 7: Web Development Task Envelopes

Leverage specialized web envelopes (`web-cwv`, `web-wcag`, `web-seo`, `web-playwright`, `web-flaky-heal`):

```bash
# 1. List available web development templates
agentctl task template --list

# 2. Synthesize a Core Web Vitals & Lighthouse envelope
agentctl task template web-cwv

# 3. Create and queue a WCAG 2.2 accessibility audit task
agentctl task create --template web-wcag

# 4. Optimize a frontend prompt with structured verification probes
agentctl task optimize "Audit Core Web Vitals and optimize LCP in src/dashboard.mjs" --fix
```

---

## Pattern 8: Universal, Stack-Agnostic Task Envelopes

Four templates work in **any** language the stack detector recognises — Cargo,
Go, Python, PHP, .NET, Java, Ruby, Elixir and Node alike — because their
verification command is hydrated from your `.agent/config.yml` rather than
hardcoded. Each carries a locally-falsifiable oracle rather than a
"best-practice" claim no test can exercise.

```bash
# Dependency / supply-chain integrity: pinned, checksummed resolution,
# stale-lockfile gate, install-script scrutiny (offline — no advisory API calls).
agentctl task create --template agent-dep-audit

# Documentation / command-surface drift: reconcile documented CLI flags,
# environment variables and SDK exports against what actually ships.
agentctl task create --template agent-doc-drift

# Configuration & secret hygiene: typed config loading, fail-closed defaults,
# and verification that secrets are redacted from logs and error messages.
agentctl task create --template agent-config-audit

# API contract consistency: route/handler parity, boundary input validation,
# and one documented error shape across a REST or RPC surface.
agentctl task create --template agent-api-contract
```

The verify command for a non-Node project is picked up automatically — for
example, a Rust repository dispatches `cargo test --workspace` against the
same envelope without the template ever naming Cargo.

