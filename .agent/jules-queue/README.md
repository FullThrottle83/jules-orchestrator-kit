# Jules Task Queue Directory

Drop markdown task specification files here (e.g. `TASK-001-feature-name.md`) to queue tasks for background execution by Google Jules.

### Task Specification Contract

Every task file dropped into this directory should adhere to the task contract defined in `.agent/prompts/Task_Template.md` and contain the following mandatory sections:
- **Objective**
- **Context**
- **Allowed Paths**
- **Forbidden Paths**
- **Functional Requirements**
- **Acceptance Criteria**
- **Verification Commands**
- **Evidence**
- **Retry Budget** (Default: 2 repair rounds per PR)
- **Stop / Escalation Conditions**

### File Format Example

```markdown
# TASK-001: Implement User Rate Limiting

## Objective
Implement sliding window rate limiting for public API routes.

## Context
- **Project Goals:** Add API rate limiting to prevent abuse on public endpoints.
- **Key Files & Folders:** `src/middleware/rate-limit.ts`, `test/rate-limit.test.ts`
- **Tech Stack:** Node.js, Express, TypeScript, Vitest

## Allowed Paths
- `src/middleware/**`
- `test/**`

## Forbidden Paths
- `.github/**`
- `.agent/jules.yml`
- `.agent/protected-paths.json`
- `package.json`, lockfiles

## Functional Requirements
- Use Redis / memory store for tracking hit counts.
- Must return HTTP 429 Too Many Requests when limit is exceeded.

## Acceptance Criteria
- Sliding window algorithm handles bursts correctly.
- All unit tests pass cleanly.

## Verification Commands
- `npm test`
- `agentctl gate`

## Evidence
- Terminal output logs showing exit code 0.

## Retry Budget
- Maximum repair rounds: 2

## Stop / Escalation Conditions
- Stop and request human review if 2 repair rounds fail or protected paths are touched.
```

### Google-First Operating Flow & Triggers

Tasks can be initiated and processed in two ways:

1. **Native Issue-Label Trigger (Google-First Operating Flow)**:
   - A GitHub issue carrying the full task specification contract receives the case-insensitive `jules` label (e.g. `jules` or `Jules`).
   - The native Google Jules GitHub App detects the label and begins execution automatically.
   - Jules opens an implementation PR.
   - Repository CI runs independent, read-only checks (`Jules PR Audit & Test Gatekeeper` and `Agent Scope Guard`).
   - If checks fail, feedback is provided via explicit `@Jules` PR comments in **Reactive Mode** (up to 2 repair rounds).
   - Merge and close are strictly manual human actions.

2. **Local Queue / CLI Batch Dispatch**:
   Process queued task files from this directory using `agentctl`:

   ```bash
   agentctl queue
   # or npm run jules:queue
   ```

   Or dispatch a single task file using `agentctl dispatch`:

   ```bash
   agentctl dispatch --title "TASK-001 Rate Limiting" --prompt "$(cat .agent/jules-queue/TASK-001-rate-limiting.md)"
   ```
