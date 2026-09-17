# Complete Uninstall / Removing the Kit (Undo Init)

`agentctl clean` performs operational maintenance; it is not an uninstaller.

## Default minimal init

Current `agentctl init` owns only:

- `.agent/config.yml` — canonical project configuration.
- The missing entries it appends under the `# Jules Orchestrator runtime state & credentials` block in `.gitignore`.

To undo a default init, remove `.agent/config.yml` if it belongs to the kit and
remove only that appended `.gitignore` block. Preserve unrelated user content.

Runtime execution may later create untracked state below `.agent/state/`,
`.agent/evidence/`, `.agent/history/`, `.agent/handovers/`,
`.agent/knowledge/` and `.agent/jules-queue/`; these can be removed after
reviewing whether any queued work or evidence needs to be kept.

## Legacy full scaffold

The shipped `jules-init` compatibility entry point and repositories initialized
by older 0.x releases may additionally own:

- `.agent/jules.yml`
- `.agent/rules/`, `.agent/prompts/`, `.agent/workflows/`
- `.agent/jules-queue/README.md`
- `AGENTS.md`
- `SPEC.md`, `CONSTRAINTS.md` and optional `DESIGN.md`
- optional CI/IDE integrations such as `.github/workflows/agent-gate.yml`,
  `.gitlab-ci.agent-gate.yml` and `.cursor/rules/jules.mdc`

Do not delete these mechanically: older setup could append to a pre-existing
`AGENTS.md`, and any of these paths may now contain project-owned content.

For a repository where Git history confirms every listed legacy path belongs
exclusively to the kit:

```bash
git rm -rf --ignore-unmatch \
  .agent \
  AGENTS.md \
  SPEC.md \
  CONSTRAINTS.md \
  DESIGN.md \
  .github/workflows/agent-gate.yml \
  .gitlab-ci.agent-gate.yml \
  .cursor/rules/jules.mdc

rm -rf .agent .agentctl
npm uninstall -g jules-orchestrator-kit
```

Then remove only the kit-owned runtime block from `.gitignore`.
