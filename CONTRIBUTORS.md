# Contributors

Provenance and governance record for **jules-orchestrator-kit**.

This repository is developed by a human maintainer together with supervised
autonomous coding agents. Git history is the authoritative attribution
ledger: every commit's `Author` metadata is preserved exactly as written, and
history is never rewritten. This document is a human-readable summary of that
ledger plus the governance rules that keep it trustworthy.

> Snapshot: 2026-09-09 · v0.72.3 · 448 commits · 110 release tags
> (`git log`, all branches of the `FullThrottle83/jules-orchestrator-kit`
> repository, first commit 2026-07-26 → snapshot date).

---

## 1. Maintainers (human)

| Identity | Role | Contact |
| :--- | :--- | :--- |
| **Jonas Pudas** | Lead maintainer & project author | `jonas@joid.se` |
| **FullThrottle83** | Maintainer, repository owner & publisher (npm `author`, GitHub account) | GitHub: [FullThrottle83](https://github.com/FullThrottle83) |

The human maintainers own the project direction, review and merge all
changes, operate the release pipeline, and hold the copyright.

In `git log` the human maintainer leadership appears under three author-name
spellings that resolve to the two identities above:

| Git author | Email | Commits | Notes |
| :--- | :--- | ---: | :--- |
| `Jonas` | `jonas@joid.se` | 64 | Includes the initial commit `dfb3054` (2026-07-26) |
| `FullThrottle83` | `110360247+FullThrottle83@users.noreply.github.com` | 11 | GitHub account identity |
| `Jonas Pudas` | `110360247+FullThrottle83@users.noreply.github.com` | 7 | Real name on the same GitHub account |

## 2. Autonomous coding agents (AI contributors)

| Identity | Operator | Commits | Notes |
| :--- | :--- | ---: | :--- |
| **jules-agent** | Google Jules (`jules@agent.ai`) | 358 | Majority author; first agent commit 2026-07-31 |
| **Arena Agent** | Arena.ai (`arena@arena.ai`) | 8 | Authored as `Arena Agent <arena@arena.ai>` (1) and as the `arena-ai-coding-agent[bot]` GitHub automation account (7); `arena-agent` additionally appears as `Co-authored-by` (see below) |

Agent contributions are **autonomous but supervised**: agents work inside the
task-envelope and verification framework defined in `AGENTS.md` and
`.agent/rules/`, their work is gated by CI (test suite, lint, doc-sync,
guard-reach) before merge, and merging happens under maintainer oversight per
the review tiers in `CONTRIBUTING.md`. Agent authorship is disclosed in the
commit metadata itself; nothing in this project hides or relabels it.

Across the history, `Co-authored-by:` trailers document mixed authorship on
commits whose author line is a different identity:

| Co-author | Total | Break-down by author line |
| ---: | :--- | :--- |
| `arena-agent` | 27 | 18 on `arena-ai-coding-agent[bot]` commits, 8 on `FullThrottle83` commits, 1 on `Arena Agent` |
| `jules-agent` | 10 | 6 on `arena-ai-coding-agent[bot]` commits, 4 on `Jonas Pudas` commits |
| `FullThrottle83` (maintainer) | 7 | 7 on `arena-ai-coding-agent[bot]` commits (maintainer oversight of agent work) |

## 3. Attribution statistics (`git log`, 448 commits)

| Identity | Commits | % | Insertions | Deletions |
| :--- | ---: | ---: | ---: | ---: |
| `jules-agent <jules@agent.ai>` | 358 | 79.9% | 82,354 | 61,632 |
| Human maintainers (all spellings above) | 82 | 18.3% | 43,898 | 2,244 |
| `arena-ai-coding-agent[bot]` / `Arena Agent <arena@arena.ai>` | 8 | 1.8% | 13,422 | 7,536 |
| **Total** | **448** | 100% | 139,674 | 71,412 |

Insertions/deletions are approximate (`git log --numstat`, ± diffs excluded).

## 4. How attribution is recorded

- **Author metadata** — commit `Author` name/email is the primary record and
  is never rewritten (no history rewrites, no author normalization).
- **Co-author trailers** — multi-agent or agent+maintainer commits carry
  `Co-authored-by:` lines in the commit body (e.g. `arena-agent` on P05/P06
  merge commits).
- **PR audit trail** — GitHub PRs reference task envelopes; CI runs and
  merge reviews are linked from each merge commit.
- **Code of conduct & contribution rules** — see `CODE_OF_CONDUCT.md`,
  `CONTRIBUTING.md` and `AGENTS.md`.

## 5. Commit signing policy

All 448 historical commits predate the signing policy and are **unsigned**;
they are preserved as-is (history is permanent). New commits must be signed
(GPG/SSH) per the commit-signing rules in `CONTRIBUTING.md`.

## 6. License & copyright

The project is licensed under the **MIT License** (see `LICENSE`).

Copyright (c) 2026 Jonas Pudas (FullThrottle83).

Autonomous coding agents are tooling operated by and on behalf of the human
maintainers; they hold no copyright interest, and agent-generated
contributions fall under the project's MIT license like all other content.
