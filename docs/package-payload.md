# npm payload audit

Audited for the public-readiness documentation change against base commit
`c1fe3cdc9faf11c22b6f8f45066e6c3733ddd1df` (v0.73.0).

## Reachability and decisions

| Payload | Consumer | Decision |
| --- | --- | --- |
| `bin/`, `index.mjs`, `src/` | CLI binaries, SDK exports and their imports | Keep |
| `scripts/` | Manifest commands, legacy entry points, and `bin/init.js` importing `command-resolver.mjs` | Keep; removing the directory breaks supported paths |
| `JULES_RULES_TEMPLATE.md` | Legacy full scaffold copies it to the host's `AGENTS.md` | Keep during 0.x compatibility; default minimal init does not copy it |
| `.agent/rules/`, `.agent/prompts/`, `.agent/workflows/` | Legacy full scaffold copies these directories; role resolution still consumes prompts when present | Keep during 0.x compatibility; not default init-owned assets |
| `README.md`, `LICENSE`, `CHANGELOG.md` | Package usage, license and release history | Keep |
| `AGENTS.md` | Instructions for contributing to this repository | Exclude; scaffold reads the template, not this file |
| `ROADMAP_V1.md` | Repository documentation and repository-only doc-sync/release checks | Exclude; no CLI or SDK runtime reads it |
| Historical audit reports | Contributor reference only; source comments now point to the archive | Move to `docs/archive/`; already excluded from npm |

The doc-sync and release scripts remain for compatibility with the manifest.
Doc-sync already refuses to run without the repository's `test/` directory; the
installed package did not support repository release checks before this change.
No executable module, CLI alias, SDK export or runtime dependency was removed.

## Verification

- `npm pack --dry-run --json`: only `AGENTS.md` and `ROADMAP_V1.md` disappear from
  the file list (126 → 124 files). All executable files remain.
- Package integrity: 308 relative imports resolve across 103 shipped modules;
  all six advertised bin/main entries exist (including aliases).
- Extracted tarball: imported all 250 SDK exports, ran CLI and legacy init help,
  and ran guard-reach successfully.
- Extracted scaffold: two runs preserve existing project instructions without
  appending a duplicate briefing; the legacy role alias resolves to `security`.
- The shared `SYNC-CORE` block matches in the repository rules and installed template.

Compressed payload: 523,745 → 505,376 bytes. Unpacked payload:
1,756,571 → 1,711,851 bytes. These figures include shorter shipped documentation,
not just the two excluded files, and refer to this audit snapshot.
