# Google-First Jules Operating Flow & Contract

This document details the repository-side contract and safe operating flow for Google Jules integrations within this repository.

## Overview

The workflow ensures tasks are structured, repairs are explicit, independent CI is authoritative, and PR merge/close operations remain strictly manual human actions.

```
+-------------------+      case-insensitive 'jules' label       +--------------------+
|   GitHub Issue    | ----------------------------------------> | Google Jules App   |
|  (Task Contract)  |                                           | (Starts Session)   |
+-------------------+                                           +--------------------+
                                                                          |
                                                                          v
+-------------------+            independent read-only          +--------------------+
| Repository CI     | <---------------------------------------- | Implementation PR  |
| Audit Gatekeepers |                                           +--------------------+
+-------------------+                                                     |
          |                                                               |
          +--- Green CI (Necessary but NOT sufficient for merge) ---------+
          |                                                               |
          +--- Failed Check / Violation ----------------------------------+
                               |                                          |
                               v                                          v
                    +-----------------------+                  +---------------------+
                    | Explicit @Jules       |                  | Human Maintainer    |
                    | Reactive Mode Comment |                  | Manual Review       |
                    | (Max 2 repair rounds) |                  +---------------------+
                    +-----------------------+                             |
                               |                                          v
                               +---> Exceeded Budget / Protected --------> [ Manual Merge ]
                                     Path / Security Concern
```

## Task Specification Contract

All Jules tasks must adhere to the contract template defined in `.agent/prompts/Task_Template.md`, containing:
1. **Objective** - Concise statement of task goal.
2. **Context** - Architectural goals, key files, and tech stack.
3. **Allowed Paths** - Whitelisted path patterns permitted for modifications.
4. **Forbidden Paths** - Restricted paths that must not be modified (`.github/**`, `.agent/jules.yml`, `.agent/protected-paths.json`, manifests/lockfiles).
5. **Functional Requirements** - Explicit functional constraints.
6. **Acceptance Criteria** - Measurable verification criteria.
7. **Verification Commands** - Commands used to verify correctness (`npm test`, `agentctl gate`).
8. **Evidence** - Required terminal output and changed-file list.
9. **Retry Budget** - Default 2 repair rounds per PR.
10. **Stop / Escalation Conditions** - Explicit conditions triggering immediate human escalation.

## Operational Directives

### 1. Trigger Distinction
- **Native Issue-Label Trigger**: Adding the case-insensitive `jules` label (e.g., `jules`, `Jules`) to a GitHub Issue triggers the native Google Jules GitHub App to begin task execution.
- **Reactive PR Feedback**: Adding an explicit `@Jules` comment on an open PR provides targeted repair instructions in Reactive Mode.
- These triggers are distinct: Issue labels initiate new tasks; `@Jules` comments steer existing PR repairs.

### 2. Independent Audit & Gatekeeping
- Repository CI runs independently and in a read-only capacity.
- `Jules PR Audit & Test Gatekeeper` and `Agent Scope Guard` execute as independent read-only checks.
- Passing CI and green audit gates are necessary conditions for merging, but NOT sufficient for merge.

### 3. Repair Steering & Budget Limits
- If CI checks or scope audits fail, targeted repair guidance is communicated via explicit `@Jules` PR comments in Reactive Mode.
- The repair budget is capped at a maximum of **2 repair rounds per PR**.

### 4. Stop & Escalation Policy
- Automated feedback stops and requests human review immediately if:
  - 2 repair rounds fail to resolve the issue.
  - Changes touch forbidden/protected paths or scope boundaries.
  - Security, secret leak, credential, or authentication concerns arise.
  - Task execution requires unauthorized production side effects or schema drops.

### 5. Strict Manual Control
- Auto-merge, auto-close, self-approval, and production side effects are strictly forbidden and remain disabled.
- Branch protection rules and Jules Reactive Mode administrative settings are managed through authenticated GitHub/Jules settings and are not modified by repository tasks.
