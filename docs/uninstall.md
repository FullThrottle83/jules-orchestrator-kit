# Complete Uninstall / Removing the Kit (Undo Init)

To completely remove `jules-orchestrator-kit` from a repository after running `agentctl init`, follow the procedure below. Note that `agentctl clean` performs operational maintenance (clearing ephemeral locks, temporary worktrees, and evidence caches), not an uninstaller.

## 1. Generated Assets & Manifest

`agentctl init` / `scaffoldRepoAssets()` writes the following project files and directories:

- **Core configuration and rules:** `.agent/config.yml` (or `.agent/jules.yml`), `.agent/rules/`, `.agent/prompts/`, `.agent/workflows/`, and `AGENTS.md`.
- **System contracts:** `SPEC.md`, `CONSTRAINTS.md` (and optional `DESIGN.md`).
- **Queue runtime stub:** `.agent/jules-queue/README.md`.
- **Optional IDE & CI integrations:** `.github/workflows/agent-gate.yml`, `.gitlab-ci.agent-gate.yml`, and `.cursor/rules/jules.mdc`.

## 2. Runtime State & Working Trees

During execution, the kit produces untracked runtime artifacts in:

- `.agent/evidence/` — Cryptographic evidence manifests and stage run recordings.
- `.agent/state/` — Flaky test ledgers, budget trackers, and escalation queues.
- `.agent/worktrees/` — Isolated snapshot worktrees used by the verification sandbox.
- `.agent/history/` and `.agent/handovers/` — Local agent session memories.

## 3. Removal Procedure (Preserving Pre-Existing User Files)

Review Git history first to distinguish files created by the kit from pre-existing
files it appended to. Remove only kit additions from shared files. The commands
below apply only when every listed path belongs exclusively to the kit; they do
not detect ownership and will remove user content in those paths too.

```bash
# 1. After reviewing ownership, remove exclusively kit-owned tracked assets
git rm -rf --ignore-unmatch \
  .agent \
  AGENTS.md \
  SPEC.md \
  CONSTRAINTS.md \
  DESIGN.md \
  .github/workflows/agent-gate.yml \
  .gitlab-ci.agent-gate.yml \
  .cursor/rules/jules.mdc

# 2. Remove untracked runtime directories and temporary caches
rm -rf .agent .agentctl

# 3. Clean up .gitignore additions
# Revert the appended "# Jules Orchestrator runtime state & credentials" block from .gitignore
# Edit only that block; preserve other project ignore rules.

# 4. Optional: Uninstall global CLI package
npm uninstall -g jules-orchestrator-kit
```
