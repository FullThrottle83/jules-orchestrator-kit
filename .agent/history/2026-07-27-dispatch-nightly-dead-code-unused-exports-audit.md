---
type: jules_dispatch
title: "Nightly Dead Code & Unused Exports Audit"
timestamp: "2026-07-27T03:42:12.539Z"
---
# Jules Task Dispatch: Nightly Dead Code & Unused Exports Audit

## Prompt
Audit the codebase for unused exports, dead files, and obsolete types. Prune unused local utility functions and unreferenced internal types. SAFETY INVARIANTS: 1. DO NOT remove package dependencies from package.json, Cargo.toml, or requirements.txt (hygiene sweeps may ADD dependencies, never REMOVE). 2. DO NOT delete or commit untracked WIP files created by developers. 3. Verify that test and build suites pass 100% cleanly before submitting PR.

## Session
- ID: `sessions/5929124864335143740`
