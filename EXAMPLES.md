# Production Examples & Deployment Patterns

This document details production deployment patterns for `jules-orchestrator-kit`. All patterns follow our strict **Zero External Runtime Dependencies** policy.

---

## Pattern 1: Automated Nightly Task Remediation

Scan your codebase for technical debt markers, generate structured task envelopes, and process them automatically:

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
          node-version: '20'

      - name: Scan Codebase & Dispatch Tasks
        env:
          JULES_API_KEY: ${{ secrets.JULES_API_KEY }}
          JULES_REPO: ${{ github.repository }}
          JULES_TIER: pro
        run: |
          # 1. Scan codebase for TODO/FIXME markers
          npx jules-orchestrator-kit scan

          # 2. Process pending tasks from queue
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
          node-version: '20'

      - name: Run Safety & Verification Audit
        run: |
          npx jules-orchestrator-kit gate --base ${{ github.event.pull_request.base.ref || 'main' }}
```

---

## Pattern 3: Multi-Agent Parallel Swarm Execution

![Multi-Agent Parallel Swarm Topology](docs/assets/swarm-topology.svg?v=3)

Execute multi-task batches concurrently across isolated git worktrees:

### CLI Swarm Command

```bash
# 1. Create task batch envelope in .agent/jules-queue/
cat << 'EOF' > .agent/jules-queue/swarm-batch.json
[
  {
    "id": "TASK-101",
    "title": "Refactor Auth Module",
    "prompt": "Convert auth callbacks to async/await in src/auth.mjs with unit tests"
  },
  {
    "id": "TASK-102",
    "title": "Add Rate Limiter",
    "prompt": "Implement token-bucket rate limiting in src/security.mjs with unit tests"
  }
]
EOF

# 2. Launch parallel swarm execution
JULES_SWARM_CONCURRENCY=2 agentctl swarm

# 3. Perform structural merge on completed swarm PRs
agentctl merge-swarm
```

---

## Pattern 4: Automated Verification Loop with Auto-Fix

![Autonomous Verification Loop](docs/assets/ooda-loop-cycle.svg?v=3)

Execute repair loops with thrash detection to preserve API quotas:

```bash
# Dispatch task with automatic test verification and auto-repair
JULES_DRY_RUN=0 agentctl dispatch \
  --title "Fix Security Sanitizer" \
  --prompt "Sanitize user inputs in src/security.mjs and ensure all tests pass cleanly"
```

If tests fail, the orchestrator feeds `stderr` back into repair attempts (up to `limits.repairAttempts`), aborting early on persistent regressions (`Exit Code 4`).

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
# Dispatch performance optimization using Bolt role
agentctl dispatch --role bolt \
  --prompt "Optimize JSON parser throughput in src/mcp.mjs"

# Dispatch security vulnerability patch using Sentinel role
agentctl dispatch --role sentinel \
  --prompt "Audit and fix prototype pollution risks in src/state.mjs"

# Dispatch tech debt cleanup using Janitor role
agentctl dispatch --role janitor \
  --prompt "Remove dead code and unused imports in src/utils.mjs"

# Audit accessibility (A11y), metadata (Scribe), E2E (Spectator), or
# review a database migration (Alchemist) — role names are case-insensitive.
agentctl dispatch --role a11y --prompt "Audit focus management in the checkout modal"
agentctl dispatch --role scribe --prompt "Audit canonical URLs and OpenGraph tags on /pricing"
agentctl dispatch --role spectator --prompt "Add headless multi-viewport regression tests for the nav"
agentctl dispatch --role alchemist --prompt "Review the new migration for reversibility and data-loss risk"
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

