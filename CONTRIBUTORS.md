# Contributors

Provenance and governance record for **jules-orchestrator-kit**.

This repository is developed by a human maintainer together with supervised
autonomous coding agents. Git history is the authoritative attribution ledger:
every commit's `Author`, `Committer`, and `Co-authored-by:` metadata is
preserved as written, and history is never rewritten.

---

## 1. Human Maintainer

| Identity | Role | Git Author Identities in History |
| :--- | :--- | :--- |
| **Jonas Pudas** ([`@FullThrottle83`](https://github.com/FullThrottle83)) | Lead maintainer, project author, reviewer & publisher | `Jonas Pudas <110360247+FullThrottle83@users.noreply.github.com>`<br/>`FullThrottle83 <110360247+FullThrottle83@users.noreply.github.com>`<br/>`Jonas <jonas@joid.se>` |

The human maintainer defines the product architecture and roadmap, reviews and
merges changes, operates the release pipeline, and holds the copyright.

---

## 2. Autonomous Coding Agents & Automation Identities

Agent contributions operate under human supervision inside the repository's
task-envelope and verification gates (`AGENTS.md`, `.agent/protected-paths.json`,
and CI checks). Nothing in this repository hides or relabels agent-authored work.

Because GitHub's Contributors view links both commit `Author` emails and
`Co-authored-by:` trailer emails to registered GitHub accounts, the following
automated identities appear in `git log` or in the GitHub UI:

| Identity | Role in Git Metadata | GitHub Account Resolution |
| :--- | :--- | :--- |
| **Google Jules** (`jules-agent <jules@agent.ai>`) | Commit `Author`, `Committer`, and `Co-authored-by:` on autonomous task and repair branches | Unlinked email (`jules@agent.ai`); appears in `git shortlog -sne` and GitHub's anonymous contributors API, not as a linked GitHub user account |
| **Arena Coding Agent** (`arena-ai-coding-agent[bot] <298482267+arena-ai-coding-agent[bot]@users.noreply.github.com>` and `Arena Agent <arena@arena.ai>`) | Commit `Author` on Arena sandbox PRs | Resolves to the GitHub Bot account [`arena-ai-coding-agent[bot]`](https://github.com/apps/arena-ai-coding-agent) (`arena@arena.ai` is unlinked) |
| **arena-agent** (`arena-agent <297053741+arena-agent@users.noreply.github.com>`) | `Co-authored-by:` trailer on Arena-assisted commits | Resolves to the GitHub User account [`@arena-agent`](https://github.com/arena-agent) |
| **Claude** (`Claude Opus 5 <noreply@anthropic.com>`, `Claude Sonnet 5 <noreply@anthropic.com>`) | `Co-authored-by:` trailer on commits authored with Anthropic Claude assistance | Resolves to the GitHub User account [`@claude`](https://github.com/claude) because `noreply@anthropic.com` is associated with that GitHub profile |

To inspect live commit and co-author counts at any revision without relying on
static snapshot numbers:

```bash
# Primary commit authors
git shortlog -sne main

# Co-authored-by trailers
git log main --format="%B" | grep -i "^Co-authored-by:" | sort | uniq -c | sort -nr
```

---

## 3. Provenance & Authorship Governance

- **Author metadata** — commit `Author` name/email is the primary record and is
  never rewritten (no history rewrites, no author normalization).
- **Co-author trailers** — multi-agent or agent+maintainer commits carry
  `Co-authored-by:` lines in the commit body.
- **PR audit trail** — GitHub PRs reference task envelopes; CI runs and merge
  reviews are linked from each merge commit.
- **Verification before merge** — every contribution, whether authored by a
  human or an autonomous agent, must pass the repository verification checks
  defined in [`AGENTS.md`](AGENTS.md) (`npm test`, `npm run lint`,
  `npm run jules:doc-sync`, and `npm run jules:rules-lint`; plus
  `npm run package-integrity` and `npm run guard-reach` for packaging or guard
  changes) and human review per [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## 4. Commit Signing Policy

Historical commits that predate the signing policy are **unsigned** and are
preserved as-is (history is permanent). New commits must be signed (GPG/SSH) per
the commit-signing rules in [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## 5. License & Copyright

This project is licensed under the **MIT License** (see [`LICENSE`](LICENSE)).

Copyright (c) 2026 Jonas Pudas (FullThrottle83).

Autonomous coding agents are software tools operated on behalf of the human
maintainer; they are not legal persons, hold no copyright interest, and their
output is distributed under the repository's MIT License.
