# Google Jules Orchestration Kit

A lightweight, framework-agnostic toolkit for turning **Google Jules** into a deterministic, autonomous background code builder for any repository (Next.js, Vite, Node, Python, Go, Rust, etc.).

---

## 💡 Why This Toolkit Exists

Most developers find AI coding agents like Jules slow or inaccurate because they treat them like interactive chat assistants. Jules is an **autonomous background developer**. 

This toolkit provides:
1. **Directives Template (`JULES_RULES_TEMPLATE.md`)**: A framework-agnostic rule set to ground Jules, force pre-execution documentation lookups, and enforce verification gates.
2. **CLI & REST Dispatcher (`scripts/jules-dispatch.mjs`)**: Auto-injects dynamic guardrails and dispatches prompts to Jules via CLI or REST API.
3. **PR Self-Auditor (`scripts/jules-self-audit.mjs`)**: Automatically audits Jules PRs against the merge-base, checks for restricted file mutations, and verifies build/test passes.
4. **Swarm Orchestrator (`scripts/jules-swarm.mjs`)**: Runs multi-task batches in parallel.
5. **Nightly Maintenance Suite (`scripts/jules-nightly.py`)**: Schedules automated background audits (security leak scans, WCAG accessibility checks, dead code pruning, unused env var cleanup).
6. **Task Queueing (`.agent/jules-queue/`)**: Drop markdown task specifications into `.agent/jules-queue/` to queue tasks for background execution.
7. **Review Workflow (`.agent/workflows/jules-review.md`)**: A step-by-step workflow for reviewing, rebasing, and merging Jules PRs.

---

## 🚀 Quick Setup for Any Project

### Step 1: Copy rules into your project
Copy `JULES_RULES_TEMPLATE.md` to `AGENTS.md` or `JULES.md` at the root of your target repository:

```bash
cp JULES_RULES_TEMPLATE.md /path/to/your-repo/AGENTS.md
```

### Step 2: Add scripts to your repo
Copy the `scripts/` directory into your project:

```bash
cp -r scripts/ /path/to/your-repo/scripts/
```

### Step 3: Dispatch a task to Jules

```bash
node scripts/jules-dispatch.mjs "Refactor rate limiter" "Implement sliding window rate limiting using Redis. Must pass tests."
```

Or pass a path to a queued markdown specification file:

```bash
node scripts/jules-dispatch.mjs "Implement User Authentication" .agent/jules-queue/TASK-001-auth-spec.md
```

### Step 4: Run Nightly Maintenance

```bash
python3 scripts/jules-nightly.py --dry-run
```

### Step 5: Audit Jules PRs before merging

```bash
node scripts/jules-self-audit.mjs
```

---

## 🎯 Core Operating Principles

1. **MCP-First Directive**: Force Jules to fetch current framework & library documentation *before* writing code (`MCP DIRECTIVE: ...`).
2. **Verification Mandate**: Every prompt mandates `npm run check:all && npm run test && npm run build` (or equivalent test command) before PR creation.
3. **Zero Unverified Claims**: Anchors every task to explicit line numbers, files, and test output.
4. **Restricted Boundaries**: Prevents Jules from modifying CI/CD workflows (`.github/`), security scripts, or dangerous database migrations without explicit approval.

---

## 📜 License

MIT License - feel free to use, modify, and share!
