# Production Examples & Deployment Patterns

This document details 6 production-grade deployment patterns for `jules-orchestrator-kit`. All patterns follow our strict **Zero External Runtime Dependencies** policy.

---

## Pattern 1: Automated Nightly TODO / FIXME Remediation

Scan your codebase for technical debt comments every night, generate structured tasks, and process them automatically using Jules:

### GitHub Actions Workflow (`.github/workflows/jules-nightly-remediation.yml`)

```yaml
name: Nightly TODO Remediation

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
          npx agentctl scan

          # 2. Process pending tasks from queue
          npx agentctl queue
```

---

## Pattern 2: Zero-Trust CI Security & Safety Gatekeeper

Block untrusted PRs containing secret leaks, scope violations, oversized diff payloads, or test regressions before they touch `main`:

### GitHub Actions Workflow (`.github/workflows/jules-pr-gate.yml`)

```yaml
name: Security & Safety Gatekeeper

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

      - name: Run 4-Phase Safety Audit
        run: |
          npx agentctl gate --base ${{ github.event.pull_request.base.ref || 'main' }}
```

---

## Pattern 3: Multi-Agent Parallel Swarm Refactoring

![Multi-Agent Parallel Swarm Topology](docs/assets/swarm-topology.svg?v=3)

Execute multi-task refactoring batches concurrently across isolated git worktrees with zero branch collision:

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
JULES_SWARM_CONCURRENCY=2 npx agentctl swarm

# 3. Perform 3-way structural merge on completed swarm PRs
npx agentctl merge-swarm
```

---

## Pattern 4: Self-Healing OODA Loop with Auto-Fix

![Self-Healing OODA Loop](docs/assets/ooda-loop-cycle.svg?v=3)

Execute autonomous repair loops with sliding-window thrash detection ($A \rightarrow B \rightarrow A \rightarrow B$) to preserve API token budgets:

```bash
# Dispatch task with automatic test verification and auto-repair
JULES_DRY_RUN=0 npx agentctl dispatch \
  --title "Fix Security Sanitizer" \
  --prompt "Sanitize user inputs in src/security.mjs and ensure all npm tests pass cleanly"
```

If tests fail, the orchestrator feeds `stderr` back into Jules up to 3 times (`limits.repairAttempts`), aborting early on deterministic regressions (`Exit Code 4`).

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

## Pattern 6: Specialist Agent Swarm Roster

Leverage pre-configured specialist prompts from `.agent/prompts/`:

```bash
# Dispatch performance profiling task using Bolt preset
npx agentctl dispatch \
  --prompt "$(cat .agent/prompts/Bolt.md) Optimize JSON parser throughput in src/mcp.mjs"

# Dispatch security vulnerability patch using Sentinel preset
npx agentctl dispatch \
  --prompt "$(cat .agent/prompts/Sentinel.md) Audit and fix prototype pollution risks in src/state.mjs"

# Dispatch tech debt cleanup using Janitor preset
npx agentctl dispatch \
  --prompt "$(cat .agent/prompts/Janitor.md) Remove dead code and unused imports in src/utils.mjs"
```
